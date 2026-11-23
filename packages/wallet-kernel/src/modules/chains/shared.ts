/**
 * Shared types and helpers for the chains module's per-family prepare functions — kept in a leaf
 * file so `index.ts` can import the family prepares without an import cycle.
 */
import { ChainError } from "@qntx/wallet-chains";
import type { KeyPath } from "@qntx/wallet-chains";
import { BITCOIN_NETWORKS } from "@qntx/wallet-chains/bitcoin";
import { SOLANA_NETWORKS } from "@qntx/wallet-chains/solana";
import { TRON_NETWORKS } from "@qntx/wallet-chains/tron";
import type { ParamsOf } from "@qntx/wallet/protocol";

import { KernelError } from "../../errors.ts";
import type { StoredRecord, VaultImage } from "../../vault/store.ts";
import type { PublicMaterial } from "./keys.ts";
import type { PromptIntent } from "./prompt.ts";
import type { ChainPlan } from "./run.ts";

/**
 * What a prepare function produces: the prompt, the signing address (the approve-agent binding
 * checks it), and the serialisable plan the sign pass executes after verification.
 */
export type Prepared = {
  readonly prompt: PromptIntent;
  readonly signer?: string;
  readonly plan: ChainPlan;
};
export type SignRequest = ParamsOf<"chain.sign">["request"];

export type HdAccount = Extract<
  Exclude<SignRequest, { kind: "bitcoin.psbt" }>["account"],
  { kind: "hd" }
>;
/** A bitcoin.psbt account: the wallet group only — each sign entry names its own template. */
export type BitcoinGroup = Extract<SignRequest, { kind: "bitcoin.psbt" }>["account"];
export type EvmRequest = Extract<
  SignRequest,
  { kind: "evm.transaction" | "evm.personal-message" | "evm.fiat24-session" | "evm.typed-data" }
>;
export type BitcoinRequest = Extract<SignRequest, { kind: "bitcoin.psbt" | "bitcoin.message" }>;
export type SolanaRequest = Extract<SignRequest, { kind: "solana.transaction" | "solana.message" }>;
export type TronRequest = Extract<
  SignRequest,
  { kind: "tron.transaction" | "tron.message" | "tron.typed-data" }
>;

export const BTC_PURPOSE: Readonly<Record<string, number>> = {
  "btc.bip44": 44,
  "btc.bip49": 49,
  "btc.bip84": 84,
  "btc.bip86": 86,
};

export const HARDENED = 0x80000000;

/** The leaf path of group `g` — `m/44'/{coin}'/0'/0/{g}` or SLIP-10 `m/44'/501'/{g}'/0'`. */
export const leafPath = (family: "evm" | "tron" | "solana", groupIndex: number): KeyPath => {
  if (family === "solana") {
    return [44 + HARDENED, 501 + HARDENED, groupIndex + HARDENED, HARDENED];
  }
  const coin = family === "tron" ? 195 : 60;
  return [44 + HARDENED, coin + HARDENED, HARDENED, 0, groupIndex];
};

export const checkNetwork = (template: string, network: string): void => {
  if (template.startsWith("evm.") && !network.startsWith("eip155:")) {
    throw new KernelError("invalid-input", "evm.bip44 requires an eip155 network");
  }
  if (template.startsWith("solana.") && !SOLANA_NETWORKS.includes(network)) {
    throw new KernelError("invalid-input", `unknown solana network ${network}`);
  }
  if (template.startsWith("btc.") && !(network in BITCOIN_NETWORKS)) {
    throw new KernelError("invalid-input", `unknown bitcoin network ${network}`);
  }
  if (template.startsWith("tron.") && !TRON_NETWORKS.includes(network)) {
    throw new KernelError("invalid-input", `unknown tron network ${network}`);
  }
};

/**
 * The signers module's `pinnedMaterial`, injected so chains never imports its owner: returns the
 * public material pinned to an external-signer record or throws `device-required`.
 */
export type ExternalMaterial = (image: VaultImage, record: StoredRecord) => PublicMaterial;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

/** Order-insensitive deep equality over wire values (Uint8Array, arrays, plain objects, scalars). */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((byte, i) => byte === b[i])
    );
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (!isObj(a) || !isObj(b)) {
    return false;
  }
  const ka = Object.keys(a);
  const kb = new Set(Object.keys(b));
  return ka.length === kb.size && ka.every((k) => kb.has(k) && deepEqual(a[k], b[k]));
};

export function mapChainError(error: unknown): never {
  if (error instanceof ChainError) {
    throw new KernelError("invalid-input", "invalid sign request");
  }
  throw error;
}
