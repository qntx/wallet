/**
 * The OneKey driver: Protocol-V1 message transport through `link.exchange({ kind: "message" })`,
 * pairing by Initialize + pinned account-node publication, host-initiated address display, and
 * staged plan signing through the family calls in ./protocol. Every wire detail — frames, schemas,
 * firmware gates — lives in the protocol client; this file adapts it to the Driver contract: the
 * `Exchange` shape, the OneKeyError → KernelError table, the pinned-material identity checks
 * (`wrong-device`), and the record-identity → DeviceInfo synthesis `display` runs against.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";

import type { KeyPath } from "@qntx/wallet-chains";
import { bitcoinAddressFromXpub, bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import {
  evmAddressFromPublicKey,
  fiat24SessionMessage,
  networkChainId,
} from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type { ChainSignRequest, DeviceDisplay } from "@qntx/wallet/protocol";

import { KernelError } from "../../../errors.ts";
import type { KernelErrorCode } from "../../../errors.ts";
import type { ChainPlan } from "../../chains/run.ts";
import type {
  DeviceIdentity,
  DeviceLink,
  Driver,
  HardwarePin,
  PairingResult,
  PinnedNode,
  SignContext,
} from "../driver.ts";
import {
  address,
  bitcoinDisplay,
  bitcoinPrepare,
  evmDisplay,
  initialize,
  OneKeyError,
  publicNode,
  signBitcoinMessage,
  signBitcoinTransaction,
  signEvmPersonalMessage,
  signEvmTransaction,
  signSolanaRawMessage,
  signSolanaTransaction,
  signTronMessage,
  signTronTransaction,
  signTypedData,
  solanaDisplay,
  solanaPublicKey,
  tronDisplay,
} from "./protocol/index.ts";
import type {
  AddressFamily,
  BitcoinSignEntry,
  DeviceInfo,
  Exchange,
  OneKeyErrorCode,
  OneKeyModel,
} from "./protocol/index.ts";

const HARDENED = 0x80_00_00_00;

/**
 * InputScriptType (messages-bitcoin.proto) per account template: the device derives each
 * input/change/address script from this hint plus the path. `btc.bip49` is SPENDP2SHWITNESS (4) —
 * the enum order is not the BIP order.
 */
const SPENDADDRESS = 0;
const SPENDP2SHWITNESS = 4;
const SPENDWITNESS = 3;
const SPENDTAPROOT = 5;

const SCRIPT_TYPE: Readonly<Record<string, number>> = {
  "btc.bip44": SPENDADDRESS,
  "btc.bip49": SPENDP2SHWITNESS,
  "btc.bip84": SPENDWITNESS,
  "btc.bip86": SPENDTAPROOT,
};

const MODEL: Readonly<Record<string, OneKeyModel>> = {
  classic: "classic",
  classic1s: "classic1s",
  pure: "pure",
  mini: "mini",
  touch: "touch",
  pro: "pro",
};

// Capability_EthereumTypedData (1000) — see protocol/device.ts.
const CAPABILITY_ETHEREUM_TYPED_DATA = 1000;

const KERNEL_CODE: Readonly<Record<OneKeyErrorCode, KernelErrorCode>> = {
  frame: "integrity",
  "device-fault": "integrity",
  "device-error": "integrity",
  "user-rejected": "device-rejected",
  "pin-invalid": "device-locked",
  "device-locked": "device-locked",
  "not-initialized": "unsupported",
  unsupported: "unsupported",
  "invalid-input": "invalid-input",
};

// Function declarations, not const arrows: this project's TypeScript narrows never-returning
// calls only when they resolve to a declaration.
function integrity(message: string): never {
  throw new KernelError("integrity", message);
}

function wrongDevice(): never {
  throw new KernelError("wrong-device", "the device answered with different keys");
}

/** OneKeyError → KernelError. OneKeyError messages are static by contract — reuse them as-is. */
function kernelError(error: unknown): Error {
  if (error instanceof OneKeyError) {
    return new KernelError(KERNEL_CODE[error.code], error.message);
  }
  return error instanceof Error ? error : integrity("the device exchange failed");
}

const samePath = (a: KeyPath, b: KeyPath): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const atLeast = (
  firmware: readonly [number, number, number],
  version: readonly [number, number, number],
): boolean =>
  firmware[0] === version[0]
    ? firmware[1] === version[1]
      ? firmware[2] >= version[2]
      : firmware[1] > version[1]
    : firmware[0] > version[0];

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** The Protocol-V1 exchange over the generic message transport: `message` answers only. */
const exchangeOf = (link: DeviceLink): Exchange => {
  return async (data: Uint8Array): Promise<Uint8Array> => {
    const response = await link.exchange({ kind: "message", data });
    if (response.kind !== "message") {
      throw new KernelError("integrity", "the device answer is not a message");
    }
    return response.data;
  };
};

/**
 * The DeviceInfo a paired record can promise: model and firmware come from the claim stored at
 * pairing; capabilities are never stored, so the classic family's typed-data stream flag is derived
 * from firmware alone — SDK `api/evm/EVMSignTypedData.ts` supportEip712OnClassic advertises
 * Capability_EthereumTypedData only on Classic 1S/Pure from 3.14.0 (classic/mini never do;
 * touch/pro stream unconditionally). A record whose model or firmware is absent or unreadable is
 * `undefined` — the caller returns `unsupported` rather than guess.
 */
const infoOf = (identity: DeviceIdentity): DeviceInfo | undefined => {
  const model = MODEL[identity.model ?? ""];
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(identity.firmware ?? "");
  if (model === undefined || match === null) {
    return undefined;
  }
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const capabilities =
    (model === "classic1s" || model === "pure") && atLeast(version, [3, 14, 0])
      ? [CAPABILITY_ETHEREUM_TYPED_DATA]
      : [];
  return {
    model,
    firmware: version,
    deviceId: "",
    capabilities,
    bitcoinOnly: false,
    pinProtection: false,
    passphraseProtection: false,
    unlocked: true,
    sessionId: undefined,
  };
};

/** The deepest pinned node that prefixes `path` — the account node the leaf derives under. */
const ancestorOf = (pin: HardwarePin, path: KeyPath): PinnedNode | undefined =>
  pin.nodes
    .filter((node) => node.path.length < path.length && node.path.every((v, i) => path[i] === v))
    .sort((a, b) => b.path.length - a.path.length)[0];

/**
 * Proof the answering device holds the pinned material: the account node above `path` must come
 * back byte-identical (`wrong-device` otherwise). A path no pinned node prefixes is a kernel
 * inconsistency — `prepare` could not have derived from the pin.
 */
const checkSecp256k1 = async (
  exchange: Exchange,
  pin: HardwarePin,
  path: KeyPath,
): Promise<void> => {
  const ancestor = ancestorOf(pin, path);
  if (ancestor === undefined) {
    integrity("no pinned account node covers the signing path");
  }
  const node = await publicNode(exchange, ancestor.path);
  if (
    !equalBytes(node.publicKey, ancestor.publicKey) ||
    !equalBytes(node.chainCode, ancestor.chainCode)
  ) {
    wrongDevice();
  }
};

const checkEd25519 = async (exchange: Exchange, pin: HardwarePin, path: KeyPath): Promise<void> => {
  const key = pin.ed25519.find((k) => samePath(k.path, path));
  if (key === undefined) {
    integrity("no pinned ed25519 key covers the signing path");
  }
  if (!equalBytes(await solanaPublicKey(exchange, path, false), key.publicKey)) {
    wrongDevice();
  }
};

/** `mainnet` | `testnet` — the only coin names the wire messages know. */
const btcCoinName = (network: string): "mainnet" | "testnet" =>
  bitcoinNetwork(network).coinType === 0 ? "mainnet" : "testnet";

/**
 * The wire sign list of a bitcoin.psbt stage: `inputs`/`tasks` are aligned by the planner, so entry
 * i takes the PSBT index of input i, the path of task i and the template of the request's `sign`
 * row for that index. A plan whose rows do not line up is `integrity` — the signer must never sign
 * under a different key than the plan claimed.
 */
const psbtEntries = (
  request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }>,
  stage: Extract<ChainPlan, { kind: "bitcoin.psbt" }>,
): ReadonlyArray<BitcoinSignEntry> => {
  const scriptType = new Map<number, number>();
  for (const entry of request.sign) {
    const type = SCRIPT_TYPE[entry.template];
    if (type === undefined) {
      integrity(`unknown bitcoin template ${entry.template}`);
    }
    scriptType.set(entry.index, type);
  }
  return stage.inputs.map((input, i) => {
    const type = scriptType.get(input.index);
    const task = stage.tasks[i];
    if (type === undefined || task === undefined) {
      integrity("the plan's inputs and tasks disagree");
    }
    return { index: input.index, path: task.path, scriptType: type };
  });
};

/**
 * What the device shows for one request/plan pair against a DeviceInfo — shared by `display` (the
 * record's promised identity) and `sign` (the live Features). Family display functions take the
 * signing key from the plan's first task.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
const displayFor = (
  request: ChainSignRequest,
  stage: ChainPlan,
  info: DeviceInfo,
): DeviceDisplay | "unsupported" => {
  const [task] = stage.tasks;
  switch (stage.kind) {
    case "evm.transaction":
      if (request.kind !== "evm.transaction") {
        integrity("the request is not an evm transaction");
      }
      return evmDisplay(info, { kind: "evm.transaction", tx: request.tx });
    case "evm.personal-message":
    case "evm.fiat24-session":
      if (request.kind !== stage.kind) {
        integrity("the request and stage kinds disagree");
      }
      return "clear";
    case "evm.typed-data":
      if (request.kind !== "evm.typed-data") {
        integrity("the request is not evm typed data");
      }
      return evmDisplay(info, { kind: "evm.typed-data", typedData: request.typedData });
    case "solana.transaction":
      if (request.kind !== "solana.transaction" || task === undefined) {
        integrity("the request is not a solana transaction");
      }
      return solanaDisplay(
        { kind: "solana.transaction", message: request.message },
        task.publicKey,
      );
    case "solana.message":
      if (request.kind !== "solana.message" || task === undefined) {
        integrity("the request is not a solana message");
      }
      return solanaDisplay({ kind: "solana.message", message: request.message }, task.publicKey);
    case "tron.transaction":
      if (request.kind !== "tron.transaction" || task === undefined) {
        integrity("the request is not a tron transaction");
      }
      return tronDisplay({ kind: "tron.transaction", rawData: request.rawData }, task.publicKey);
    case "tron.message":
      if (request.kind !== "tron.message" || task === undefined) {
        integrity("the request is not a tron message");
      }
      return tronDisplay({ kind: "tron.message" }, task.publicKey);
    case "tron.typed-data":
      // The wire has no TRON typed-data message — the family display refuses it outright.
      return "unsupported";
    case "bitcoin.psbt":
      if (request.kind !== "bitcoin.psbt") {
        integrity("the request is not a bitcoin psbt");
      }
      return bitcoinDisplay(info, {
        kind: "bitcoin.psbt",
        psbt: request.psbt,
        network: btcCoinName(request.network),
        sign: psbtEntries(request, stage),
        change: [],
      });
    case "bitcoin.message":
      if (request.kind !== "bitcoin.message") {
        integrity("the request is not a bitcoin message");
      }
      return bitcoinDisplay(info, { kind: "bitcoin.message", format: request.format });
  }
};

/**
 * The account paths pairing pins: the four bitcoin purposes at mainnet coin 0', the EVM and TRON
 * account nodes (all through GetPublicKey — it accepts any path), and the SLIP-10 Solana leaf.
 * Every GetPublicKey answer carries root_fingerprint; they must all agree on one device identity.
 */
const BIP84_ACCOUNT: KeyPath = [84 + HARDENED, HARDENED, HARDENED];
const EVM_ACCOUNT: KeyPath = [44 + HARDENED, 60 + HARDENED, HARDENED];
const TRON_ACCOUNT: KeyPath = [44 + HARDENED, 195 + HARDENED, HARDENED];
const PAIR_SECP256K1: ReadonlyArray<{ readonly path: KeyPath; readonly scriptType?: number }> = [
  { path: [44 + HARDENED, HARDENED, HARDENED], scriptType: SPENDADDRESS },
  { path: [49 + HARDENED, HARDENED, HARDENED], scriptType: SPENDP2SHWITNESS },
  { path: BIP84_ACCOUNT, scriptType: SPENDWITNESS },
  { path: [86 + HARDENED, HARDENED, HARDENED], scriptType: SPENDTAPROOT },
  { path: EVM_ACCOUNT },
  { path: TRON_ACCOUNT },
];
const PAIR_SOLANA: KeyPath = [44 + HARDENED, 501 + HARDENED, HARDENED, HARDENED];
const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";

/** `m/44'/{coin}'/0'/0/0` — the leaf pairing cross-checks on. */
const leafPath0 = (family: "evm" | "tron"): KeyPath => [
  44 + HARDENED,
  (family === "tron" ? 195 : 60) + HARDENED,
  HARDENED,
  0,
  0,
];

/** Public-derive `tail` under `node` — the local half of the pairing cross-checks. */
const deriveLeaf = (node: PinnedNode, tail: ReadonlyArray<number>): Uint8Array => {
  const root = new HDKey({ publicKey: node.publicKey, chainCode: node.chainCode });
  const child = tail.length === 0 ? root : root.derive(`m/${tail.join("/")}`);
  if (child.publicKey === null) {
    integrity("public derivation under the account node failed");
  }
  return child.publicKey;
};

const fingerprintNumber = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);

/** The account node's serialized xpub — the same fields the pinned material serializes. */
const xpubOf = (node: PinnedNode, versions: { public: number; private: number }): string => {
  if (node.parent === undefined) {
    integrity("the pinned node carries no parent fingerprint");
  }
  return new HDKey({
    versions,
    depth: node.path.length,
    index: node.path.at(-1) ?? 0,
    parentFingerprint: fingerprintNumber(node.parent),
    chainCode: node.chainCode,
    publicKey: node.publicKey,
  }).publicExtendedKey;
};

const pair = async (link: DeviceLink): Promise<PairingResult> => {
  const exchange = exchangeOf(link);
  try {
    const info = await initialize(exchange);
    const nodes: PinnedNode[] = [];
    let fingerprint: Uint8Array | undefined;
    for (const { path, scriptType } of PAIR_SECP256K1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
      const node = await publicNode(exchange, path, scriptType === undefined ? {} : { scriptType });
      if (node.rootFingerprint === undefined) {
        integrity("the device reports no master fingerprint");
      }
      if (fingerprint === undefined) {
        fingerprint = node.rootFingerprint;
      } else if (!equalBytes(fingerprint, node.rootFingerprint)) {
        integrity("the device reports inconsistent master fingerprints");
      }
      nodes.push({
        path: node.path,
        publicKey: node.publicKey,
        chainCode: node.chainCode,
        parent: node.parent,
      });
    }
    const solana = await solanaPublicKey(exchange, PAIR_SOLANA, false);
    // Cross-checks with showDisplay false: the addresses the device derives must equal what the
    // pinned nodes derive locally — a device that lies about its nodes is caught here.
    const evmLeaf = await address(exchange, "evm", leafPath0("evm"), { showDisplay: false });
    const tronLeaf = await address(exchange, "tron", leafPath0("tron"), { showDisplay: false });
    const btcLeaf = await address(exchange, "bitcoin", [84 + HARDENED, HARDENED, HARDENED, 0, 0], {
      showDisplay: false,
      scriptType: SPENDWITNESS,
    });
    if (fingerprint === undefined) {
      integrity("pairing collected no account nodes");
    }
    const nodeFor = (path: KeyPath): PinnedNode =>
      nodes.find((n) => samePath(n.path, path)) ??
      integrity("pairing collected too few account nodes");
    if (evmLeaf !== evmAddressFromPublicKey(deriveLeaf(nodeFor(EVM_ACCOUNT), [0, 0]))) {
      integrity("the device derives a different evm address than its node");
    }
    if (tronLeaf !== tronAddressFromPublicKey(deriveLeaf(nodeFor(TRON_ACCOUNT), [0, 0]))) {
      integrity("the device derives a different tron address than its node");
    }
    const net = bitcoinNetwork(BTC_MAINNET);
    if (
      btcLeaf !==
      bitcoinAddressFromXpub(
        xpubOf(nodeFor(BIP84_ACCOUNT), net.bip32),
        "btc.bip84",
        BTC_MAINNET,
        0,
        0,
      )
    ) {
      integrity("the device derives a different bitcoin address than its node");
    }
    return {
      fingerprint,
      model: info.model,
      firmware: info.firmware.join("."),
      nodes,
      ed25519: [{ path: PAIR_SOLANA, publicKey: solana }],
    };
  } catch (error) {
    throw kernelError(error);
  }
};

const accounts: Driver["accounts"] = async (link, need, pin) => {
  const exchange = exchangeOf(link);
  try {
    await initialize(exchange);
    const nodes: PinnedNode[] = [];
    for (const path of need.secp256k1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
      const node = await publicNode(exchange, path);
      if (
        node.rootFingerprint === undefined ||
        !equalBytes(node.rootFingerprint, pin.fingerprint)
      ) {
        wrongDevice();
      }
      nodes.push({
        path: node.path,
        publicKey: node.publicKey,
        chainCode: node.chainCode,
        parent: node.parent,
      });
    }
    const ed25519: Array<PairingResult["ed25519"][number]> = [];
    for (const path of need.ed25519) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
      ed25519.push({ path: [...path], publicKey: await solanaPublicKey(exchange, path, false) });
    }
    // An ed25519-only fetch carries no fingerprint: probe a pinned secp node so a foreign device
    // cannot slip its keys into the pin.
    if (need.secp256k1.length === 0 && need.ed25519.length > 0) {
      const [first] = pin.nodes;
      if (first === undefined) {
        integrity("the pin carries no node to verify the device against");
      }
      const node = await publicNode(exchange, first.path);
      if (
        !equalBytes(node.publicKey, first.publicKey) ||
        !equalBytes(node.chainCode, first.chainCode)
      ) {
        wrongDevice();
      }
    }
    return { fingerprint: pin.fingerprint, nodes, ed25519 };
  } catch (error) {
    throw kernelError(error);
  }
};

const verifyAddress: Driver["verifyAddress"] = async (link, target, pin) => {
  const exchange = exchangeOf(link);
  try {
    await initialize(exchange);
    const family: AddressFamily =
      target.template === "evm.bip44"
        ? "evm"
        : target.template === "tron.bip44"
          ? "tron"
          : target.template === "solana.bip44-change"
            ? "solana"
            : "bitcoin";
    if (family === "solana") {
      // The pinned key sits at the leaf itself; SolanaGetAddress shows the address and returns
      // the key, so one exchange both proves the device and displays the check.
      const key = pin.ed25519.find((k) => samePath(k.path, target.path));
      if (key === undefined) {
        integrity("no pinned ed25519 key covers the verify path");
      }
      const shown = await solanaPublicKey(exchange, target.path, true);
      if (!equalBytes(shown, key.publicKey)) {
        wrongDevice();
      }
      return { method: "device", matched: solanaAddressFromPublicKey(shown) === target.address };
    }
    const scriptType = SCRIPT_TYPE[target.template];
    if (family === "bitcoin" && scriptType === undefined) {
      integrity(`unknown bitcoin template ${target.template}`);
    }
    const ancestor = ancestorOf(pin, target.path);
    if (ancestor === undefined) {
      integrity("no pinned account node covers the verify path");
    }
    const node = await publicNode(exchange, ancestor.path);
    if (
      !equalBytes(node.publicKey, ancestor.publicKey) ||
      !equalBytes(node.chainCode, ancestor.chainCode)
    ) {
      wrongDevice();
    }
    const shown = await address(exchange, family, target.path, {
      showDisplay: true,
      ...(scriptType === undefined ? {} : { scriptType }),
      ...(family === "bitcoin" ? { network: btcCoinName(target.network) } : {}),
      ...(family === "evm" ? { chainId: BigInt(networkChainId(target.network)) } : {}),
    });
    return { method: "device", matched: shown === target.address };
  } catch (error) {
    throw kernelError(error);
  }
};

const display: Driver["display"] = (request, plan, identity) => {
  const info = infoOf(identity);
  if (info === undefined) {
    return "unsupported";
  }
  return displayFor(request, plan, info);
};

/** The plan's stored stage-1 authorization: 65-byte r‖s‖v with v = 27 + yParity. */
const yParityOf = (authorization: Uint8Array): 0 | 1 => {
  const v = authorization.at(-1);
  if (authorization.length !== 65 || (v !== 27 && v !== 28)) {
    integrity("the planned authorization signature is not 65-byte r‖s‖v");
  }
  return v === 27 ? 0 : 1;
};

/**
 * Dispatch one stage to its family signer. `sign` returns one 64-byte r‖s per task, in order — the
 * assembler re-derives recovery bits. Stage/request kind agreement is asserted per case: a mismatch
 * is a kernel inconsistency, never a device question.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
const dispatch = async (
  exchange: Exchange,
  info: DeviceInfo,
  context: SignContext,
): Promise<ReadonlyArray<Uint8Array>> => {
  const { request, stage } = context;
  const [task] = stage.tasks;
  switch (stage.kind) {
    case "evm.transaction": {
      if (request.kind !== "evm.transaction" || task === undefined) {
        integrity("the request is not an evm transaction");
      }
      if (request.tx.type === "eip7702" && stage.authorization === undefined) {
        // Stage 1: the device signs authorization and transaction; only the authorization
        // signature answers the stage task.
        const { authorization } = await signEvmTransaction(exchange, info, task.path, request.tx);
        if (authorization === undefined) {
          integrity("the device signed no authorization");
        }
        return [concatBytes(authorization.r, authorization.s)];
      }
      const options =
        stage.authorization === undefined
          ? undefined
          : {
              authorization: {
                yParity: yParityOf(stage.authorization),
                r: stage.authorization.subarray(0, 32),
                s: stage.authorization.subarray(32, 64),
              },
            };
      const { signature } = await signEvmTransaction(
        exchange,
        info,
        task.path,
        request.tx,
        options,
      );
      return [signature];
    }
    case "evm.personal-message":
    case "evm.fiat24-session": {
      if (request.kind !== stage.kind || task === undefined) {
        integrity("the request and stage kinds disagree");
      }
      const message =
        request.kind === "evm.fiat24-session"
          ? utf8ToBytes(
              fiat24SessionMessage(
                networkChainId(request.network),
                request.tokenId,
                request.deadline,
              ),
            )
          : request.message;
      return [
        await signEvmPersonalMessage(
          exchange,
          task.path,
          message,
          BigInt(networkChainId(request.network)),
        ),
      ];
    }
    case "evm.typed-data":
      if (request.kind !== "evm.typed-data" || task === undefined) {
        integrity("the request is not evm typed data");
      }
      return [
        await signTypedData(
          exchange,
          info,
          task.path,
          request.typedData,
          BigInt(networkChainId(request.network)),
        ),
      ];

    case "solana.transaction":
      if (request.kind !== "solana.transaction" || task === undefined) {
        integrity("the request is not a solana transaction");
      }
      return [await signSolanaTransaction(exchange, task.path, request.message, task.publicKey)];

    case "solana.message":
      if (request.kind !== "solana.message" || task === undefined) {
        integrity("the request is not a solana message");
      }
      return [await signSolanaRawMessage(exchange, task.path, request.message)];

    case "tron.transaction":
      if (request.kind !== "tron.transaction" || task === undefined) {
        integrity("the request is not a tron transaction");
      }
      return [await signTronTransaction(exchange, task.path, request.rawData, task.publicKey)];

    case "tron.message":
      if (request.kind !== "tron.message" || task === undefined) {
        integrity("the request is not a tron message");
      }
      return [await signTronMessage(exchange, info, task.path, request.message)];

    case "bitcoin.psbt": {
      if (request.kind !== "bitcoin.psbt") {
        integrity("the request is not a bitcoin psbt");
      }
      const prepared = bitcoinPrepare(
        request.psbt,
        psbtEntries(request, stage),
        btcCoinName(request.network),
        // Phase 2 declares no change: the device shows every output.
        [],
      );
      return signBitcoinTransaction(exchange, info, prepared);
    }
    case "bitcoin.message": {
      if (
        request.kind !== "bitcoin.message" ||
        request.format !== stage.format ||
        task === undefined
      ) {
        integrity("the request is not a matching bitcoin message");
      }
      const scriptType =
        request.account.kind === "hd" ? SCRIPT_TYPE[request.account.template] : undefined;
      if (scriptType === undefined) {
        integrity("a hardware bitcoin message signs under an hd account template");
      }
      return [
        await signBitcoinMessage(exchange, info, task.path, utf8ToBytes(request.message), {
          format: request.format,
          scriptType,
          network: btcCoinName(request.network),
        }),
      ];
    }
    default:
      // tron.typed-data and any future kind display refused — reaching one is a kernel bug.
      integrity("the stage kind cannot be signed");
  }
};

const sign: Driver["sign"] = async (link, context) => {
  const exchange = exchangeOf(link);
  try {
    const info = await initialize(exchange);
    // Identity: the account material above the first task's path must re-derive identically.
    const [task] = context.stage.tasks;
    if (task === undefined) {
      integrity("the stage carries no signing task");
    }
    const check = task.scheme === "ed25519" ? checkEd25519 : checkSecp256k1;
    await check(exchange, context.pin, task.path);
    // The live Features must still show what the prompt promised — firmware that can no longer
    // display the confirmed request is refused before any signing exchange.
    const live = displayFor(context.request, context.stage, info);
    if (live !== context.display) {
      throw new KernelError("unsupported", "the device can no longer show the confirmed request");
    }
    return await dispatch(exchange, info, context);
  } catch (error) {
    throw kernelError(error);
  }
};

export const ONEKEY_DRIVER: Driver = { pair, accounts, verifyAddress, display, sign };
