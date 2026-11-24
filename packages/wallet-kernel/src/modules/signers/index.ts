/**
 * The signers module: `hardware-wallet` records, the hardware.* commands and the bridge to chain
 * signing for externally held keys. The kernel never holds a secret for these wallets — the record
 * seals only public material pairing pinned (I1), every device answer is checked against the pin
 * before it can shape a request (I3), and the host only transports the frames the kernel produces
 * (I4). One operation runs at a time; its state lives in kernel memory and dies with cancel, lock,
 * timeout or a new begin (I6).
 *
 * The live `pins` map is rebuilt from the records at every unlock/reconcile — like the session-key
 * records it is claimed only to authenticate, except the pin stays live because accounts and
 * signing need it per request without re-opening the record.
 */
import { equalBytes } from "@noble/ciphers/utils.js";

import type { KeyPath } from "@qntx/wallet-chains";
import { bitcoinAddressFromXpub, bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type {
  ChainAccount,
  DeviceDisplay,
  HardwareDevice,
  HardwareOperation,
  HardwareResult,
  MethodName,
  ResultOf,
  HARDWARE_METHODS,
} from "@qntx/wallet/protocol";
import { HARDWARE_DEVICES } from "@qntx/wallet/types";

import type { Handler, KernelContext, VaultHooks } from "../../commands/context.ts";
import type { PublicMaterial } from "../../derive/material.ts";
import { pinnedMaterial, samePath } from "../../derive/pinned.ts";
import type { PinnedKeys } from "../../derive/pinned.ts";
import { KernelError } from "../../errors.ts";
import type { KeystorePrompt, KernelPlatform } from "../../platform.ts";
import { promptLocale } from "../../prompts.ts";
import { wipe } from "../../secret/secret.ts";
import type { StoredRecord } from "../../vault/store.ts";
import type { OpenedRecord } from "../../vault/vault.ts";
import { sealRecord, verifyFactor } from "../../vault/vault.ts";
import { assertFiat24Deadline } from "../chains/evm.ts";
import { accountFor, checkNetwork, leafPath, prepareApproval } from "../chains/index.ts";
import { chainPrompt } from "../chains/prompt.ts";
import { signStages } from "../chains/run.ts";
import { BTC_PURPOSE } from "../chains/shared.ts";
import type { DeviceLink, Driver, HardwarePin } from "./driver.ts";
import type { OperationExecutor } from "./operation.ts";
import { createOperationExecutor } from "./operation.ts";
import { devicePromptLine } from "./prompt.ts";
import {
  deviceSupported,
  encodeHardwareBody,
  encodeHardwareHeader,
  HARDWARE_WALLET_KIND,
  hardwarePin,
  hardwareWallet,
  hardwareWalletId,
  hardwareWalletInfo,
  parseHardwareBody,
  parseHardwareHeader,
} from "./record.ts";
import type { HardwareHeader } from "./record.ts";

const HARDENED = 0x80000000;
const DEVICE_TEXT = /^[\u0020-\u007E]{1,64}$/;

export type SignersModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof HARDWARE_METHODS & MethodName]: Handler<M> };
  /** `pinnedMaterial` bound to the live pin map — the kernel's external-material seam. */
  readonly material: (record: StoredRecord) => PublicMaterial;
};

const integrity = (message: string): KernelError => new KernelError("integrity", message);

/**
 * Checks that pairing output parses under the record-body rules — the same strictness a stored
 * record gets, so a device can never pin what a later claim would call corrupt.
 */
const authenticatedBody = (keys: PinnedKeys): Uint8Array => {
  const body = encodeHardwareBody(keys);
  parseHardwareBody(body);
  return body;
};

/**
 * The live pin for a record: the authenticated body's keys under the claimed header fingerprint. An
 * existing record with no claimed body means the vault lied about its records — `integrity`.
 */
const pinAt = (pins: ReadonlyMap<string, PinnedKeys>, record: StoredRecord): HardwarePin => {
  const header = parseHardwareHeader(record.header);
  if (hardwareWalletId(header.device, header.fingerprint) !== record.id) {
    throw integrity("hardware wallet record does not match its id");
  }
  // A device kind this build does not know is inert: authenticated, listed, never driven.
  if (!deviceSupported(header.device)) {
    throw new KernelError("unsupported", `unknown hardware device ${header.device}`);
  }
  const keys = pins.get(record.id);
  if (keys === undefined) {
    throw integrity("hardware wallet record has no authenticated material");
  }
  return hardwarePin(header, keys);
};

/** Whether the pinned material fails to serve `path` — only `device-required` counts as a gap. */
const deviceNeeded = async (serve: () => Promise<unknown>): Promise<boolean> => {
  try {
    await serve();
    return false;
  } catch (error) {
    if (error instanceof KernelError && error.code === "device-required") {
      return true;
    }
    throw error;
  }
};

/**
 * The record lookup every wallet-scoped operation shares: the record must be a hardware-wallet row
 * — any other id is `not-found`, never a custody surprise.
 */
const hardwareRecord = (ctx: KernelContext, walletId: string): StoredRecord => {
  const record = hardwareWallet(ctx.image, walletId);
  if (record === undefined) {
    throw new KernelError("not-found", "no such wallet");
  }
  return record;
};

/**
 * The paths a template needs from the device: the account node a leaf derives under for
 * evm/tron/btc, the all-hardened leaf for solana. A path the pin already serves is not asked for.
 */
const neededPaths = async (
  pin: HardwarePin,
  template: string,
  network: string,
  groupIndex: number,
): Promise<{ secp256k1: KeyPath[]; ed25519: KeyPath[] }> => {
  const material = pinnedMaterial({ fingerprint: pin.fingerprint, keys: pin });
  const need: { secp256k1: KeyPath[]; ed25519: KeyPath[] } = { secp256k1: [], ed25519: [] };
  const purpose = BTC_PURPOSE[template];
  if (template === "evm.bip44") {
    const path = [44 + HARDENED, 60 + HARDENED, HARDENED];
    if (await deviceNeeded(async () => material.secp256k1(path))) {
      need.secp256k1.push(path);
    }
  } else if (template === "tron.bip44") {
    const path = [44 + HARDENED, 195 + HARDENED, HARDENED];
    if (await deviceNeeded(async () => material.secp256k1(path))) {
      need.secp256k1.push(path);
    }
  } else if (template === "solana.bip44-change") {
    const path = leafPath("solana", groupIndex);
    if (await deviceNeeded(async () => material.ed25519(path))) {
      need.ed25519.push(path);
    }
  } else if (purpose === undefined) {
    throw new KernelError("invalid-input", `unknown template ${template}`);
  } else {
    const net = bitcoinNetwork(network);
    const path = [purpose + HARDENED, net.coinType + HARDENED, groupIndex + HARDENED];
    if (await deviceNeeded(async () => material.secp256k1(path))) {
      need.secp256k1.push(path);
    }
  }
  return need;
};

/** Merges freshly fetched pinned keys into the pin, deduplicating by path. */
const mergePin = (pin: HardwarePin, fetched: PinnedKeys): HardwarePin => ({
  fingerprint: pin.fingerprint,
  nodes: [
    ...pin.nodes,
    ...fetched.nodes.filter((n) => !pin.nodes.some((have) => samePath(have.path, n.path))),
  ],
  ed25519: [
    ...pin.ed25519,
    ...fetched.ed25519.filter((k) => !pin.ed25519.some((have) => samePath(have.path, k.path))),
  ],
});

/** The verification prompt's device line, appended to the chain prompt's description (I2). */
const devicePrompt = (
  base: KeystorePrompt,
  locale: "zh-Hans" | "en",
  display: DeviceDisplay,
  device: HardwareDevice,
): KeystorePrompt => ({
  title: base.title,
  description: `${base.description}\n${devicePromptLine(locale, display, device)}`,
});

export function createSignersModule(
  drivers: Readonly<Record<HardwareDevice, Driver>>,
): SignersModule {
  const pins = new Map<string, PinnedKeys>();
  let executor: OperationExecutor | undefined;
  const executorOf = (platform: KernelPlatform): OperationExecutor => {
    executor ??= createOperationExecutor(platform);
    return executor;
  };

  /* The device gate every driven op shares: the header parses, the id matches the record, and
     the kind is one this build ships a driver for — anything else is `unsupported`, never a
     destructure crash. */
  const driverFor = (
    record: StoredRecord,
  ): { driver: Driver; header: HardwareHeader; device: HardwareDevice } => {
    const header = parseHardwareHeader(record.header);
    const device = HARDWARE_DEVICES.find((d) => d === header.device);
    if (device === undefined) {
      throw new KernelError("unsupported", `unknown hardware device ${header.device}`);
    }
    return { driver: drivers[device], device, header };
  };

  const pairBody = (
    ctx: KernelContext,
    device: HardwareDevice,
  ): ((link: DeviceLink) => Promise<HardwareResult>) => {
    return async (link) => {
      const result = await drivers[device].pair(link);
      if (result.fingerprint.length !== 4) {
        throw integrity("the device returned a malformed fingerprint");
      }
      if (
        (result.model !== undefined && !DEVICE_TEXT.test(result.model)) ||
        (result.firmware !== undefined && !DEVICE_TEXT.test(result.firmware))
      ) {
        throw integrity("the device returned a malformed model or firmware string");
      }
      const id = hardwareWalletId(device, result.fingerprint);
      if (ctx.image.records.some((record) => record.id === id)) {
        throw new KernelError("already-exists", "this device is already paired");
      }
      const header: { -readonly [K in keyof HardwareHeader]: HardwareHeader[K] } = {
        device,
        fingerprint: result.fingerprint,
        createdAt: ctx.platform.now(),
      };
      if (result.model !== undefined) {
        header.model = result.model;
      }
      if (result.firmware !== undefined) {
        header.firmware = result.firmware;
      }
      const body = authenticatedBody({ nodes: result.nodes, ed25519: result.ed25519 });
      // The DEK is read live at commit time: it may have rotated since `begin` captured the op.
      const record = sealRecord(
        ctx.platform,
        ctx.session.current().dek,
        HARDWARE_WALLET_KIND,
        id,
        encodeHardwareHeader(header),
        body,
      );
      wipe(body);
      // The pin goes live through the reconcile that follows the commit — never patched by hand.
      await ctx.commit([{ op: "put-record", record }]);
      return { kind: "pair", wallet: hardwareWalletInfo(header) };
    };
  };

  const accountsBody = (
    ctx: KernelContext,
    op: Extract<HardwareOperation, { kind: "accounts" }>,
  ): ((link: DeviceLink) => Promise<HardwareResult>) => {
    const record = hardwareRecord(ctx, op.walletId);
    const { driver } = driverFor(record);
    for (const template of op.templates) {
      checkNetwork(template, op.network);
    }
    return async (link) => {
      let pin = pinAt(pins, record);
      const secp256k1: KeyPath[] = [];
      const ed25519: KeyPath[] = [];
      for (const template of op.templates) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each template's probe is independent
        const need = await neededPaths(pin, template, op.network, op.groupIndex);
        for (const path of need.secp256k1) {
          if (!secp256k1.some((have) => samePath(have, path))) {
            secp256k1.push(path);
          }
        }
        for (const path of need.ed25519) {
          if (!ed25519.some((have) => samePath(have, path))) {
            ed25519.push(path);
          }
        }
      }
      if (secp256k1.length > 0 || ed25519.length > 0) {
        const fetched = await driver.accounts(link, { secp256k1, ed25519 }, pin);
        // A different device answering this wallet's request is a wrong-device, never a merge.
        if (!equalBytes(fetched.fingerprint, pin.fingerprint)) {
          throw new KernelError("wrong-device", "the answering device is not the paired one");
        }
        pin = mergePin(pin, fetched);
        const body = authenticatedBody(pin);
        await ctx.commit([
          {
            op: "put-record",
            record: sealRecord(
              ctx.platform,
              ctx.session.current().dek,
              HARDWARE_WALLET_KIND,
              record.id,
              record.header,
              body,
            ),
          },
        ]);
        wipe(body);
      }
      const material = pinnedMaterial({ fingerprint: pin.fingerprint, keys: pin });
      const accounts: ChainAccount[] = [];
      for (const template of op.templates) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- account derivation is sequential by design
        accounts.push(await accountFor(material, template, op.network, op.groupIndex));
      }
      return { kind: "accounts", accounts };
    };
  };

  const verifyAddressBody = (
    ctx: KernelContext,
    op: Extract<HardwareOperation, { kind: "verify-address" }>,
  ): ((link: DeviceLink) => Promise<HardwareResult>) => {
    const record = hardwareRecord(ctx, op.walletId);
    const { driver } = driverFor(record);
    checkNetwork(op.template, op.network);
    // All input checks run before the executor starts — a bad op never earns an opId.
    if (BTC_PURPOSE[op.template] === undefined && op.index !== undefined) {
      throw new KernelError("invalid-input", "an index applies only to bitcoin templates");
    }
    if (BTC_PURPOSE[op.template] !== undefined && op.index === undefined) {
      throw new KernelError("invalid-input", "a bitcoin address check needs an index");
    }
    return async (link) => {
      const pin = pinAt(pins, record);
      const material = pinnedMaterial({ fingerprint: pin.fingerprint, keys: pin });
      let address: string;
      let path: KeyPath;
      if (op.template === "evm.bip44") {
        path = leafPath("evm", op.groupIndex);
        address = evmAddressFromPublicKey(await material.secp256k1(path));
      } else if (op.template === "tron.bip44") {
        path = leafPath("tron", op.groupIndex);
        address = tronAddressFromPublicKey(await material.secp256k1(path));
      } else if (op.template === "solana.bip44-change") {
        path = leafPath("solana", op.groupIndex);
        address = solanaAddressFromPublicKey(await material.ed25519(path));
      } else {
        const purpose = BTC_PURPOSE[op.template];
        if (purpose === undefined || op.index === undefined) {
          throw integrity("unreachable: non-bitcoin template or missing index");
        }
        const net = bitcoinNetwork(op.network);
        const account = [purpose + HARDENED, net.coinType + HARDENED, op.groupIndex + HARDENED];
        const xpub = await material.extendedPublicKey(account, net.bip32);
        address = bitcoinAddressFromXpub(xpub, op.template, op.network, 0, op.index);
        path = [...account, 0, op.index];
      }
      const verdict = await driver.verifyAddress(
        link,
        { path, address, template: op.template, network: op.network },
        pin,
      );
      // The user saying the device shows a different address is a wrong-device, by module rule.
      if (!verdict.matched) {
        throw new KernelError("wrong-device", "the device did not show this address");
      }
      return { kind: "verify-address", address, method: verdict.method };
    };
  };

  const beginSign = async (
    ctx: KernelContext,
    params: Parameters<Handler<"hardware.begin">>[1],
    session: string | undefined,
  ): Promise<ResultOf<"hardware.begin">> => {
    const { dek } = ctx.session.require(session);
    const { op } = params;
    if (op.kind !== "sign" || params.verify === undefined) {
      throw new KernelError("integrity", "unreachable: sign begin without the sign op or verify");
    }
    const { request } = op;
    if (request.account.kind === "imported") {
      throw new KernelError("invalid-input", "an imported key is not a hardware wallet");
    }
    const record = hardwareRecord(ctx, request.account.walletId);
    const { driver, device, header } = driverFor(record);
    const pin = pinAt(pins, record);
    // The same approval pipeline chain.sign runs (I2): template checks, prepare on public
    // material, agent binding, the blind-signing policy — then the device's display gate and the
    // system verification prompt carry the device line.
    const prepared = await prepareApproval(
      ctx,
      request,
      pinnedMaterial({ fingerprint: pin.fingerprint, keys: pin }),
      dek,
    );
    const display = driver.display(request, prepared.plan, header);
    if (display === "unsupported") {
      throw new KernelError("unsupported", "the device cannot sign this request");
    }
    const locale = promptLocale(ctx.platform.keystore?.locale ?? "en");
    await verifyFactor(ctx.platform, ctx.image, params.verify, dek, ctx.commit, () =>
      devicePrompt(chainPrompt(locale, prepared.prompt), locale, display, device),
    );
    ctx.session.require(session);
    if (request.kind === "evm.fiat24-session") {
      assertFiat24Deadline(request, ctx.platform.now());
    }
    return executorOf(ctx.platform).begin(device, display, async (link) => ({
      kind: "sign",
      result: await signStages(prepared.plan, async (stage) =>
        driver.sign(link, { request, stage, pin, display, random: ctx.platform.random }),
      ),
    }));
  };

  const vault: VaultHooks = {
    ownsRecord: (kind) => kind === HARDWARE_WALLET_KIND,

    /* The sealed body is authenticated by parsing it under the strict record rules and kept live
       — accounts and signing serve the pin without re-opening the record. A body that fails the
       parse proves tampering: latch corrupted like sessions does, and wipe either way. */
    claimUnlocked: (records) => {
      const unclaimed: OpenedRecord[] = [];
      for (const record of records) {
        if (record.kind !== HARDWARE_WALLET_KIND) {
          unclaimed.push(record);
          continue;
        }
        try {
          /* A device kind this build does not know stays inert — the record authenticated, so it
             lists with supported: false; its body is never parsed and never driven. */
          const header = parseHardwareHeader(record.header);
          if (deviceSupported(header.device)) {
            pins.set(record.id, parseHardwareBody(record.plaintext));
          }
        } catch {
          throw new KernelError(
            "integrity",
            "hardware wallet record failed authentication",
            undefined,
            true,
          );
        } finally {
          wipe(record.plaintext);
        }
      }
      return unclaimed;
    },

    forget: (_kind, id) => {
      pins.delete(id);
    },
    lock: () => {
      executor?.abort();
      pins.clear();
    },
    walletDeleteOps: () => [],
    parseHeader: (record) => {
      const header = parseHardwareHeader(record.header);
      if (hardwareWalletId(header.device, header.fingerprint) !== record.id) {
        throw integrity("hardware wallet record does not match its id");
      }
    },
  };

  const handlers: { [M in keyof typeof HARDWARE_METHODS & MethodName]: Handler<M> } = {
    // oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
    "hardware.begin": async (ctx, params, session) => {
      ctx.session.require(session);
      const { op, verify } = params;
      if (op.kind === "sign") {
        if (verify === undefined) {
          throw new KernelError("invalid-input", "a sign operation needs a verification factor");
        }
        return beginSign(ctx, params, session);
      }
      if (verify !== undefined) {
        throw new KernelError("invalid-input", "only a sign operation takes a verification factor");
      }
      const exec = executorOf(ctx.platform);
      switch (op.kind) {
        case "pair":
          return exec.begin(op.device, undefined, pairBody(ctx, op.device));
        case "accounts":
          return exec.begin(
            driverFor(hardwareRecord(ctx, op.walletId)).device,
            undefined,
            accountsBody(ctx, op),
          );
        case "verify-address":
          return exec.begin(
            driverFor(hardwareRecord(ctx, op.walletId)).device,
            undefined,
            verifyAddressBody(ctx, op),
          );
      }
    },
    "hardware.step": async (ctx, params, session) => {
      ctx.session.require(session);
      if (executor === undefined) {
        throw new KernelError("not-found", "no such operation");
      }
      return executor.step(params.opId, params.response);
    },
    "hardware.cancel": (ctx, params, session) => {
      ctx.session.require(session);
      if (executor === undefined) {
        throw new KernelError("not-found", "no such operation");
      }
      executor.cancel(params.opId);
      return null;
    },
  };

  return {
    vault,
    handlers,
    material: (record: StoredRecord) => {
      const pin = pinAt(pins, record);
      return pinnedMaterial({ fingerprint: pin.fingerprint, keys: pin });
    },
  };
}
