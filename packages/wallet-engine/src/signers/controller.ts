import { bytesToHex } from "@noble/hashes/utils.js";

import { HARDWARE_DEVICES, WalletError } from "@qntx/wallet";
import type { HardwareDevice, SignerTask, VerifyFactor, Wallet, WalletInfo } from "@qntx/wallet";
import { card } from "@qntx/wallet/card";
import type { CardStep } from "@qntx/wallet/card";
import { chains } from "@qntx/wallet/chains";
import { hardware } from "@qntx/wallet/hardware";
import type { DeviceIo, HardwareStep } from "@qntx/wallet/hardware";
import type { ChainAccount, ChainSignResult, ChainTemplate } from "@qntx/wallet/protocol";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { ChainApis } from "../transactions/route.ts";

/**
 * What the host shows while a device operation runs: which wallet, which custody, which operation,
 * and the facade's latest step — card steps pass through wholesale, hardware publishes the device
 * exchanges (`done` never needs a widget: the result resolves instead).
 */
export type SignerActivity = {
  readonly id: string;
  readonly walletId: string;
  readonly custody: "card" | "hardware";
  readonly operation: "sign" | "accounts" | "verify-address";
  readonly step:
    | { readonly kind: "starting" }
    | { readonly kind: "card"; readonly step: CardStep }
    | { readonly kind: "device"; readonly step: Extract<HardwareStep, { kind: "exchange" }> };
};

export type SignersState = {
  // oxlint-disable-next-line typescript/no-restricted-types -- spec shape: no activity → null
  readonly active: SignerActivity | null;
};

export type SignerFamily = "evm" | "solana" | "bitcoin" | "tron";

const FAMILY_TEMPLATES: Readonly<Record<SignerFamily, ReadonlyArray<ChainTemplate>>> = {
  evm: ["evm.bip44"],
  solana: ["solana.bip44-change"],
  bitcoin: ["btc.bip44", "btc.bip49", "btc.bip84", "btc.bip86"],
  tron: ["tron.bip44"],
};

export type SignersControllerOptions = {
  readonly wallet: Wallet;
  /**
   * The host's transport for a paired device (Ledger APDUs, a Keystone QR channel, …). Absent →
   * hardware wallets cannot sign, verify or fetch accounts here.
   */
  readonly deviceIo?: ((device: HardwareDevice) => DeviceIo) | undefined;
  /** Re-runs one family's discovery check for a group after fetched material lands. */
  readonly recheck: (walletId: string, groupIndex: number, family: SignerFamily) => Promise<void>;
  /** Enabled networks per family — fetchAccounts needs one derivation network per coin type. */
  readonly networks?: {
    readonly enabled: (family: SignerFamily) => ReadonlyArray<string>;
  };
  readonly random: (length: number) => Uint8Array;
  readonly logger: EngineLogger;
};

/**
 * The engine's external-signer orchestration: at most one device operation at a time, its progress
 * in `active`, and the single signing path (`apis`) every engine component signs through — the
 * custody of the request's wallet decides whether the vault signs directly or a card/hardware op
 * runs first.
 */
export class SignersController extends Controller<SignersState> {
  private readonly options: SignersControllerOptions;
  private activeTask: { readonly cancel: () => Promise<void> } | undefined;

  constructor(options: SignersControllerOptions) {
    super({ name: "signers", defaultState: () => ({ active: null }) });
    this.options = options;
  }

  /** The one signing path: vault material signs directly; card and hardware wallets run an op. */
  readonly apis: ChainApis = {
    account: async (params) => chains(this.options.wallet).account(params),
    exportAccount: async (params) => chains(this.options.wallet).exportAccount(params),
    sign: async (params) => {
      const { account } = params.request;
      const info =
        account.kind === "hd"
          ? this.options.wallet.getSnapshot().wallets.find((w) => w.walletId === account.walletId)
          : undefined;
      if (info?.custody === "card") {
        return this.cardSign(params.request, params.verify);
      }
      if (info?.custody === "hardware") {
        return this.deviceSign(info, params.request, params.verify);
      }
      return chains(this.options.wallet).sign(params);
    },
  };

  async init(): Promise<void> {
    await Promise.resolve();
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  /** Lock hook — the engine calls this as the vault locks; the task's result still rejects. */
  lock(): void {
    const task = this.activeTask;
    void (async () => {
      try {
        await task?.cancel();
      } catch (error) {
        this.options.logger.warn("signer cancel failed", error);
      }
    })();
  }

  /** Cancel the running device operation; a no-op when nothing is active. */
  async cancel(): Promise<void> {
    await this.activeTask?.cancel();
  }

  /** Verify one derived address on the device's screen — hardware only; a card has no screen. */
  async verifyAddress(params: {
    readonly walletId: string;
    readonly groupIndex: number;
    readonly template: ChainTemplate;
    readonly network: string;
    readonly index?: number;
  }): Promise<{ readonly address: string; readonly method: string }> {
    const info = this.mustWallet(params.walletId);
    if (info.custody !== "hardware") {
      throw new WalletError("unsupported", "only a paired device can verify an address on screen");
    }
    // Resolved before begin: an unsupported device refuses without publishing an activity.
    const io = this.deviceIo(info);
    const result = await this.trackDevice(info, "verify-address", () =>
      hardware(this.options.wallet).start(
        {
          kind: "verify-address",
          walletId: params.walletId,
          groupIndex: params.groupIndex,
          template: params.template,
          network: params.network,
          ...(params.index === undefined ? {} : { index: params.index }),
        },
        { io },
      ),
    );
    if (result.kind !== "verify-address") {
      throw new WalletError("integrity", "device answered a different operation");
    }
    return { address: result.address, method: result.method };
  }

  /**
   * Fetch one family's pinned accounts from the signer, then re-run that family's discovery check
   * for the group. Bitcoin derives per network (coin types differ); the other families derive once
   * on their first enabled network.
   */
  async fetchAccounts(params: {
    readonly walletId: string;
    readonly groupIndex: number;
    readonly family: SignerFamily;
  }): Promise<ReadonlyArray<ChainAccount>> {
    const info = this.mustWallet(params.walletId);
    const templates = FAMILY_TEMPLATES[params.family];
    const enabled = this.options.networks?.enabled(params.family) ?? [];
    const targets = params.family === "bitcoin" ? enabled : enabled.slice(0, 1);
    const [first] = targets;
    if (first === undefined) {
      throw new WalletError("unavailable", `no enabled ${params.family} network to derive on`);
    }
    // Resolved before begin: an unsupported device refuses without publishing an activity.
    const io = info.custody === "card" ? undefined : this.deviceIo(info);
    const id = this.begin(info, "accounts");
    const accounts: ChainAccount[] = [];
    try {
      for (const network of targets) {
        const request = {
          kind: "accounts" as const,
          walletId: params.walletId,
          groupIndex: params.groupIndex,
          templates,
          network,
        };
        const run = async () =>
          io === undefined
            ? this.runCard(id, card(this.options.wallet).start(request, {}))
            : this.runDevice(id, hardware(this.options.wallet).start(request, { io }));
        // oxlint-disable-next-line eslint/no-await-in-loop -- device ops are strictly sequential
        const result = await run();
        if (result.kind !== "accounts") {
          throw new WalletError("integrity", "device answered a different operation");
        }
        accounts.push(...result.accounts);
      }
    } finally {
      this.end(id);
    }
    await this.options.recheck(params.walletId, params.groupIndex, params.family);
    return accounts;
  }

  private async cardSign(
    request: Parameters<ChainApis["sign"]>[0]["request"],
    verify: VerifyFactor,
  ): Promise<ChainSignResult> {
    const info = this.options.wallet
      .getSnapshot()
      .wallets.find(
        (w) => w.walletId === (request.account.kind === "hd" ? request.account.walletId : ""),
      );
    if (info === undefined) {
      throw new WalletError("not-found", "wallet does not exist");
    }
    const result = await this.trackCard(info, "sign", () =>
      card(this.options.wallet).start({ kind: "sign", request }, { verify }),
    );
    if (result.kind !== "sign") {
      throw new WalletError("integrity", "card answered a different operation");
    }
    return result.result;
  }

  private async deviceSign(
    info: WalletInfo,
    request: Parameters<ChainApis["sign"]>[0]["request"],
    verify: VerifyFactor,
  ): Promise<ChainSignResult> {
    // Resolved before begin: an unsupported device refuses without publishing an activity.
    const io = this.deviceIo(info);
    const result = await this.trackDevice(info, "sign", () =>
      hardware(this.options.wallet).start({ kind: "sign", request }, { io, verify }),
    );
    if (result.kind !== "sign") {
      throw new WalletError("integrity", "device answered a different operation");
    }
    return result.result;
  }

  private mustWallet(walletId: string): WalletInfo {
    const info = this.options.wallet.getSnapshot().wallets.find((w) => w.walletId === walletId);
    if (info === undefined) {
      throw new WalletError("not-found", "wallet does not exist");
    }
    if (info.custody === "vault") {
      throw new WalletError("unsupported", "a vault wallet has no external signer");
    }
    return info;
  }

  private deviceIo(info: WalletInfo): DeviceIo {
    if (info.custody !== "hardware" || !info.supported) {
      throw new WalletError("unsupported", "this build has no driver for the paired device");
    }
    if (this.options.deviceIo === undefined) {
      throw new WalletError("unsupported", "no transport for this device");
    }
    const device = HARDWARE_DEVICES.find((known) => known === info.device);
    if (device === undefined) {
      throw new WalletError("unsupported", "this build has no driver for the paired device");
    }
    return this.options.deviceIo(device);
  }

  private begin(info: WalletInfo, operation: SignerActivity["operation"]): string {
    if (info.custody === "vault") {
      throw new WalletError("unsupported", "a vault wallet has no external signer");
    }
    if (this.getState().active !== null) {
      throw new WalletError("conflict", "a device operation is already running");
    }
    const id = bytesToHex(this.options.random(8));
    this.update((s) => ({
      ...s,
      active: {
        id,
        walletId: info.walletId,
        custody: info.custody,
        operation,
        step: { kind: "starting" },
      },
    }));
    return id;
  }

  private setStep(id: string, step: SignerActivity["step"]): void {
    this.update((s) => (s.active?.id === id ? { ...s, active: { ...s.active, step } } : s));
  }

  private end(id: string): void {
    this.update((s) => (s.active?.id === id ? { ...s, active: null } : s));
    this.activeTask = undefined;
  }

  /* The task starts inside the thunk so `begin`'s conflict check lands BEFORE any facade start —
     a second start would otherwise cancel the task already running under the user's finger. */
  private async trackCard<R>(
    info: WalletInfo,
    operation: SignerActivity["operation"],
    start: () => SignerTask<CardStep, R>,
  ): Promise<R> {
    const id = this.begin(info, operation);
    try {
      return await this.runCard(id, start());
    } finally {
      this.end(id);
    }
  }

  private async trackDevice<R>(
    info: WalletInfo,
    operation: SignerActivity["operation"],
    start: () => SignerTask<HardwareStep, R>,
  ): Promise<R> {
    const id = this.begin(info, operation);
    try {
      return await this.runDevice(id, start());
    } finally {
      this.end(id);
    }
  }

  private async runCard<R>(id: string, task: SignerTask<CardStep, R>): Promise<R> {
    this.activeTask = task;
    task.observe((step) => {
      this.setStep(id, { kind: "card", step });
    });
    return task.result;
  }

  private async runDevice<R>(id: string, task: SignerTask<HardwareStep, R>): Promise<R> {
    this.activeTask = task;
    task.observe((step) => {
      if (step.kind === "exchange") {
        this.setStep(id, { kind: "device", step });
      }
    });
    return task.result;
  }
}
