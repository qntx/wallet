/**
 * The fake device the signer tests run against. A Driver whose "hardware" is the test seed: pair
 * publishes its public nodes over a QR exchange, accounts answers the module's exact gap list, sign
 * runs the same task signers the software wallet's seed backend uses (its artefacts are
 * byte-identical), and verifyAddress relays the compare answer the test's step supplies. Knobs let
 * a test arm a hostile device — a wrong fingerprint, a wrong signing seed, corrupted signatures —
 * without touching the module.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { hash160 } from "@scure/btc-signer/utils.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

import type { KeyPath } from "@qntx/wallet-chains";
import type { DeviceDisplay, DeviceRequest, DeviceResponse } from "@qntx/wallet/protocol";

import type { PinnedEd25519, PinnedNode } from "../src/derive/pinned.ts";
import { pathToString } from "../src/derive/pinned.ts";
import type { KernelError } from "../src/errors.ts";
import { seedKeys } from "../src/modules/chains/keys.ts";
import { taskSignerFor } from "../src/modules/chains/run.ts";
import type { ChainPlan } from "../src/modules/chains/run.ts";
import type { DeviceLink, Driver } from "../src/modules/signers/driver.ts";

const HARDENED = 0x80000000;

const deriveHd = (seed: Uint8Array, path: KeyPath): HDKey => {
  const root = HDKey.fromMasterSeed(seed);
  return path.length === 0 ? root : root.derive(pathToString(path));
};

const fpBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};

/** The pinned BIP-32 node a real device publishes for `path`. */
export const nodeAt = (seed: Uint8Array, path: KeyPath): PinnedNode => {
  const node = deriveHd(seed, path);
  const { publicKey, chainCode } = node;
  if (publicKey === null || chainCode === null) {
    throw new Error("hd derive produced no public node");
  }
  return { path, publicKey, chainCode, parent: fpBytes(node.parentFingerprint) };
};

/** The pinned SLIP-10 ed25519 key at `path`. */
export const edAt = (seed: Uint8Array, path: KeyPath): PinnedEd25519 => ({
  path,
  publicKey: ed25519.getPublicKey(
    Slip10.fromMasterSeed(seed).derive(pathToString(path)).privateKey,
  ),
});

/** The master fingerprint a device claims: hash160(master pubkey)[0..4]. */
export const masterFingerprint = (seed: Uint8Array): Uint8Array => {
  const master = HDKey.fromMasterSeed(seed).publicKey;
  if (master === null) {
    throw new Error("no master key");
  }
  return hash160(master).slice(0, 4);
};

/** The account paths the fake pairs by default: evm, tron, the four bitcoin purposes. */
export const ACCOUNT_NODES: KeyPath[] = [
  [44 + HARDENED, 60 + HARDENED, HARDENED],
  [44 + HARDENED, 195 + HARDENED, HARDENED],
  [44 + HARDENED, HARDENED, HARDENED],
  [49 + HARDENED, HARDENED, HARDENED],
  [84 + HARDENED, HARDENED, HARDENED],
  [86 + HARDENED, HARDENED, HARDENED],
];

/** The solana account-0 leaf — an all-hardened SLIP-10 path. */
export const SOLANA_LEAF: KeyPath = [44 + HARDENED, 501 + HARDENED, HARDENED, HARDENED];

export type FakeDeviceOptions = {
  /** Node paths pair pins (default: {@link ACCOUNT_NODES}). */
  readonly nodes?: ReadonlyArray<KeyPath>;
  /** Ed25519 paths pair pins (default: {@link SOLANA_LEAF}). */
  readonly ed25519?: ReadonlyArray<KeyPath>;
  /** The fingerprint pair and accounts claim (default: the seed's real mfp). */
  readonly fingerprint?: Uint8Array;
  readonly model?: string;
  readonly firmware?: string;
  /** What display reports for a sign request (default `"clear"`). */
  readonly display?: DeviceDisplay | "unsupported";
  /** The seed the device signs with — a different seed is a hostile device. */
  readonly signSeed?: Uint8Array;
  /** Post-processes the signatures sign returns — drop, truncate or flip bytes. */
  readonly corrupt?: (signatures: Uint8Array[]) => Uint8Array[];
  /** A gate accounts waits on after its exchange — lets a step land while the body works. */
  readonly gate?: Promise<void>;
  /** Thrown by pair before it exchanges — a device that refuses pairing outright. */
  readonly pairError?: KernelError;
  /** Thrown by accounts after its exchange — a device that fails mid-operation. */
  readonly accountsError?: KernelError;
  /** The fingerprint accounts answers with — a different device answering is wrong-device. */
  readonly accountsFingerprint?: Uint8Array;
};

export type FakeDevice = {
  readonly driver: Driver;
  /** Every request the driver put on the link, in order. */
  readonly requests: DeviceRequest[];
  /** Every exchange promise the link handed back — a discarded op rejects them. */
  readonly exchanges: Array<Promise<DeviceResponse>>;
  /** Every gap list the module asked accounts to fill. */
  readonly gaps: Array<{ secp256k1: KeyPath[]; ed25519: KeyPath[] }>;
  /** Every `{ address, path }` verifyAddress was asked to show. */
  readonly targets: Array<{ address: string; path: string }>;
  /** Every stage plan sign was handed — the kernel's classification the device driver sees. */
  readonly stages: ChainPlan[];
};

export const fakeDevice = (seed: Uint8Array, opts?: FakeDeviceOptions): FakeDevice => {
  const fingerprint = opts?.fingerprint ?? masterFingerprint(seed);
  const requests: DeviceRequest[] = [];
  const exchanges: Array<Promise<DeviceResponse>> = [];
  const gaps: Array<{ secp256k1: KeyPath[]; ed25519: KeyPath[] }> = [];
  const targets: Array<{ address: string; path: string }> = [];
  const stages: ChainPlan[] = [];

  const exchange = async (link: DeviceLink, request: DeviceRequest): Promise<DeviceResponse> => {
    requests.push(request);
    const pending = link.exchange(request);
    exchanges.push(pending);
    return pending;
  };

  const driver: Driver = {
    pair: async (link) => {
      if (opts?.pairError !== undefined) {
        throw opts.pairError;
      }
      await exchange(link, { kind: "qr", scan: ["fake-accounts"] });
      const result: {
        fingerprint: Uint8Array;
        model?: string;
        firmware?: string;
        nodes: PinnedNode[];
        ed25519: PinnedEd25519[];
      } = {
        fingerprint,
        nodes: (opts?.nodes ?? ACCOUNT_NODES).map((path) => nodeAt(seed, path)),
        ed25519: (opts?.ed25519 ?? [SOLANA_LEAF]).map((path) => edAt(seed, path)),
      };
      if (opts?.model !== undefined) {
        result.model = opts.model;
      }
      if (opts?.firmware !== undefined) {
        result.firmware = opts.firmware;
      }
      return result;
    },
    display: () => opts?.display ?? "clear",
    sign: async (link, context) => {
      stages.push(context.stage);
      await exchange(link, { kind: "message", data: utf8ToBytes(context.request.kind) });
      const source = seedKeys(opts?.signSeed ?? seed, (n) => new Uint8Array(n));
      const backend = source.backend(taskSignerFor(context.stage));
      const signatures: Uint8Array[] = [];
      for (const task of context.stage.tasks) {
        // oxlint-disable-next-line no-await-in-loop -- the device serves one task at a time
        signatures.push(await backend.sign(task));
      }
      return opts?.corrupt?.(signatures) ?? signatures;
    },
    accounts: async (link, need) => {
      gaps.push({ secp256k1: [...need.secp256k1], ed25519: [...need.ed25519] });
      await exchange(link, { kind: "message", data: utf8ToBytes("accounts") });
      await opts?.gate;
      if (opts?.accountsError !== undefined) {
        throw opts.accountsError;
      }
      return {
        fingerprint: opts?.accountsFingerprint ?? fingerprint,
        nodes: need.secp256k1.map((path) => nodeAt(seed, path)),
        ed25519: need.ed25519.map((path) => edAt(seed, path)),
      };
    },
    verifyAddress: async (link, target) => {
      const path = pathToString(target.path);
      targets.push({ address: target.address, path });
      const response = await exchange(link, {
        kind: "compare",
        address: target.address,
        path,
      });
      return { method: "compare", matched: response.kind === "compare" && response.matched };
    },
  };
  return { driver, requests, exchanges, gaps, targets, stages };
};
