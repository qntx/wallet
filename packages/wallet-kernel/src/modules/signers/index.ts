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
import { pinnedMaterial, samePath, servingPath } from "../../derive/pinned.ts";
import type { Pin, PinnedKeys } from "../../derive/pinned.ts";
import { KernelError } from "../../errors.ts";
import type { KeystorePrompt, KernelPlatform } from "../../platform.ts";
import { PROMPT_BOUNDS, codePoints, hardwarePrompt, promptLocale } from "../../prompts.ts";
import type { PromptBound } from "../../prompts.ts";
import { wipe } from "../../secret/secret.ts";
import type { StoredRecord } from "../../vault/store.ts";
import type { OpenedRecord } from "../../vault/vault.ts";
import { sealRecord, verifyFactor } from "../../vault/vault.ts";
import { assertFiat24Deadline } from "../chains/evm.ts";
import {
  accountFor,
  assertSignable,
  checkNetwork,
  leafPath,
  prepareApproval,
} from "../chains/index.ts";
import { changeMark, commitChangeMarks } from "../chains/marks.ts";
import { boundChainPrompt, chainPrompt } from "../chains/prompt.ts";
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
import type { HardwareBody, HardwareHeader } from "./record.ts";

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
const authenticatedBody = (body: HardwareBody): Uint8Array => {
  const encoded = encodeHardwareBody(body);
  parseHardwareBody(encoded);
  return encoded;
};

/** The record's public material — the pin's keys plus its confirmed-entry list. */
const materialOf = (pin: HardwarePin, confirmed: Pin["confirmed"]): PublicMaterial =>
  pinnedMaterial({ fingerprint: pin.fingerprint, keys: pin, confirmed });

/**
 * The live pin for a record: the authenticated body's keys under the claimed header fingerprint. An
 * existing record with no claimed body means the vault lied about its records — `integrity`.
 */
const pinAt = (pins: ReadonlyMap<string, HardwareBody>, record: StoredRecord): HardwarePin => {
  const header = parseHardwareHeader(record.header);
  if (hardwareWalletId(header.device, header.fingerprint) !== record.id) {
    throw integrity("hardware wallet record does not match its id");
  }
  // A device kind this build does not know is inert: authenticated, listed, never driven.
  if (!deviceSupported(header.device)) {
    throw new KernelError("unsupported", `unknown hardware device ${header.device}`);
  }
  const body = pins.get(record.id);
  if (body === undefined) {
    throw integrity("hardware wallet record has no authenticated material");
  }
  return hardwarePin(header, body.keys);
};

/** The live body (keys plus confirmations) behind a hardware record's pin. */
const pinBody = (pins: ReadonlyMap<string, HardwareBody>, record: StoredRecord): HardwareBody => {
  const body = pins.get(record.id);
  if (body === undefined) {
    throw integrity("hardware wallet record has no authenticated material");
  }
  return body;
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
  const material = materialOf(pin, []);
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

/** The bound for a prompt that gains one prepended line: the line's cost comes off the top. */
const shrinkBound = (bound: PromptBound, line: string): PromptBound => ({
  title: bound.title,
  lines: bound.lines - 1,
  characters: bound.characters - codePoints(line) - 1,
});

/**
 * The verification prompt's device line, ahead of every chain-prompt row — it is the most important
 * instruction (blind is itself a warning; clear says where the real check happens).
 */
const devicePrompt = (
  base: KeystorePrompt,
  locale: "zh-Hans" | "en",
  display: DeviceDisplay,
  device: HardwareDevice,
): KeystorePrompt => ({
  title: base.title,
  description: `${devicePromptLine(locale, display, device)}\n${base.description}`,
});

export function createSignersModule(
  drivers: Readonly<Record<HardwareDevice, Driver>>,
): SignersModule {
  const pins = new Map<string, HardwareBody>();
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
      if (
        ctx.image.records.some((record) => record.kind === HARDWARE_WALLET_KIND && record.id === id)
      ) {
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
      /* Pairing's fetch is a device claim too — entries start unconfirmed and earn the flag
         only when an on-device verify-address matches. */
      const body = authenticatedBody({
        keys: { nodes: result.nodes, ed25519: result.ed25519 },
        confirmed: [],
      });
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
      let body = pinBody(pins, record);
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
        /* A mismatched claimed fingerprint is a wrong-device, never a merge. The match itself is
           no identity proof — the fingerprint is public and replayable, so this only stops an
           accidental second honest device; merged entries stay unconfirmed until an on-device
           verify-address matches. */
        if (!equalBytes(fetched.fingerprint, pin.fingerprint)) {
          throw new KernelError("wrong-device", "the answering device is not the paired one");
        }
        pin = mergePin(pin, fetched);
        /* Merged entries arrive unconfirmed; the confirmations the record already sealed ride
           along untouched — they name pinned paths the merge never replaces. */
        const sealed = authenticatedBody({ keys: pin, confirmed: body.confirmed });
        await ctx.commit([
          {
            op: "put-record",
            record: sealRecord(
              ctx.platform,
              ctx.session.current().dek,
              HARDWARE_WALLET_KIND,
              record.id,
              record.header,
              sealed,
            ),
          },
        ]);
        wipe(sealed);
        body = { keys: pin, confirmed: body.confirmed };
      }
      const material = materialOf(pin, body.confirmed);
      const accounts: ChainAccount[] = [];
      for (const template of op.templates) {
        const purpose = BTC_PURPOSE[template];
        const mark =
          purpose === undefined
            ? 0
            : changeMark(ctx.image, op.walletId, op.groupIndex, purpose, op.network);
        // oxlint-disable-next-line eslint/no-await-in-loop -- account derivation is sequential by design
        accounts.push(await accountFor(material, template, op.network, op.groupIndex, mark));
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
      const body = pinBody(pins, record);
      const material = materialOf(pin, body.confirmed);
      let address: string;
      let path: KeyPath;
      let curve: "secp256k1" | "ed25519" = "secp256k1";
      if (op.template === "evm.bip44") {
        path = leafPath("evm", op.groupIndex);
        address = evmAddressFromPublicKey(await material.secp256k1(path));
      } else if (op.template === "tron.bip44") {
        path = leafPath("tron", op.groupIndex);
        address = tronAddressFromPublicKey(await material.secp256k1(path));
      } else if (op.template === "solana.bip44-change") {
        path = leafPath("solana", op.groupIndex);
        curve = "ed25519";
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
      /* The user approved the device showing this address — the pinned entry that serves it is
         confirmed on the device. Seal the flag on the serving entry: every path it serves, in
         every group, is the same proven material. A miss is impossible — the address derivation
         above already resolved the path through the pin — but keep it defensive anyway. */
      const serving = servingPath({ keys: pin, confirmed: body.confirmed }, curve, path);
      if (serving !== undefined && !body.confirmed.some((p) => samePath(p, serving))) {
        const sealed = authenticatedBody({
          keys: body.keys,
          confirmed: [...body.confirmed, serving],
        });
        await ctx.commit([
          {
            op: "put-record",
            record: sealRecord(
              ctx.platform,
              ctx.session.current().dek,
              HARDWARE_WALLET_KIND,
              record.id,
              record.header,
              sealed,
            ),
          },
        ]);
        wipe(sealed);
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
      materialOf(pin, pinBody(pins, record).confirmed),
      dek,
    );
    const display = driver.display(request, prepared.plan, header);
    if (display === "unsupported") {
      throw new KernelError("unsupported", "the device cannot sign this request");
    }
    const locale = promptLocale(ctx.platform.keystore?.locale ?? "en");
    /* The phone dialog gets the same bound as chain.sign, shrunk by the device line
       devicePrompt appends, so the whole text still fits. */
    const shown =
      ctx.platform.keystore === undefined
        ? undefined
        : boundChainPrompt(
            locale,
            prepared.prompt,
            shrinkBound(
              PROMPT_BOUNDS[ctx.platform.keystore.platform],
              devicePromptLine(locale, display, device),
            ),
          );
    assertSignable(ctx, dek, prepared.prompt, shown?.oversize ?? false);
    await verifyFactor(ctx, params.verify, dek, () =>
      devicePrompt(shown?.prompt ?? chainPrompt(locale, prepared.prompt), locale, display, device),
    );
    ctx.session.require(session);
    if (request.kind === "evm.fiat24-session") {
      assertFiat24Deadline(request, ctx.platform.now());
    }
    // Same commit point as chain.sign — the marks rise before the device signs anything.
    if (request.kind === "bitcoin.psbt" && prepared.changeMarks !== undefined) {
      await commitChangeMarks(
        ctx,
        dek,
        request.account.walletId,
        request.account.groupIndex,
        request.network,
        prepared.changeMarks,
      );
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
    "hardware.begin": async (ctx, params, session) => {
      const { dek } = ctx.session.require(session);
      const { op, verify } = params;
      if (op.kind === "sign") {
        if (verify === undefined) {
          throw new KernelError("invalid-input", "a sign operation needs a verification factor");
        }
        return beginSign(ctx, params, session);
      }
      /* Pairing pins a claimed device's keys and an accounts fetch merges keys for paths the pin
         cannot serve — both change what the vault trusts, so both are verification-gated. The
         fetch's gate is sharper: a fetch whose material is already pinned adds nothing and stays
         free, a missing path needs a verify (its absence is approval-required, not invalid-input),
         and a presented verify is always consumed — the user approved this fetch, not the pin's
         current contents. Only verify-address takes no factor: it adds nothing. */
      const exec = executorOf(ctx.platform);
      const locale = promptLocale(ctx.platform.keystore?.locale ?? "en");
      if (op.kind === "pair") {
        if (verify === undefined) {
          throw new KernelError("invalid-input", "a pair operation needs a verification factor");
        }
        await verifyFactor(ctx, verify, dek, () =>
          hardwarePrompt(locale, "hardware-pair", op.device),
        );
        ctx.session.require(session);
        return exec.begin(op.device, undefined, pairBody(ctx, op.device));
      }
      if (op.kind === "accounts") {
        const record = hardwareRecord(ctx, op.walletId);
        const { device } = driverFor(record);
        for (const template of op.templates) {
          checkNetwork(template, op.network);
        }
        const pin = pinAt(pins, record);
        let missing = false;
        for (const template of op.templates) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- each template's probe is independent
          const need = await neededPaths(pin, template, op.network, op.groupIndex);
          if (need.secp256k1.length > 0 || need.ed25519.length > 0) {
            missing = true;
          }
        }
        if (missing && verify === undefined) {
          throw new KernelError(
            "approval-required",
            "fetching keys the device has not pinned needs a verification",
          );
        }
        if (verify !== undefined) {
          await verifyFactor(ctx, verify, dek, () =>
            hardwarePrompt(locale, "hardware-accounts", device, op.groupIndex),
          );
          ctx.session.require(session);
        }
        return exec.begin(device, undefined, accountsBody(ctx, op));
      }
      if (verify !== undefined) {
        throw new KernelError(
          "invalid-input",
          "a verify-address operation takes no verification factor",
        );
      }
      return exec.begin(
        driverFor(hardwareRecord(ctx, op.walletId)).device,
        undefined,
        verifyAddressBody(ctx, op),
      );
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
      return materialOf(pin, pinBody(pins, record).confirmed);
    },
  };
}
