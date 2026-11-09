/**
 * Shared types and helpers for the chains module's per-family sign executors — kept in a leaf file
 * so `index.ts` can import the family executors without an import cycle.
 */
import { ChainError } from "@qntx/wallet-chains";
import type { ChainSignResult, ParamsOf } from "@qntx/wallet/protocol";

import { KernelError } from "../../errors.ts";
import type { PromptIntent } from "./prompt.ts";

export type ExecuteResult = ChainSignResult | { readonly prompt: PromptIntent };
export type SignRequest = ParamsOf<"chain.sign">["request"];
export type EvmKeySource =
  | { readonly kind: "hd"; readonly account: HdAccount; readonly seed: Uint8Array }
  | { readonly kind: "imported"; readonly secret: Uint8Array };

export type SolanaKeySource = EvmKeySource;

export type HdAccount = Extract<
  Exclude<SignRequest, { kind: "bitcoin.psbt" }>["account"],
  { kind: "hd" }
>;
/** A bitcoin.psbt account: the wallet group only — each sign entry names its own template. */
export type BitcoinGroup = Extract<SignRequest, { kind: "bitcoin.psbt" }>["account"];
export type EvmRequest = Extract<
  SignRequest,
  { kind: "evm.transaction" | "evm.personal-message" | "evm.typed-data" }
>;
export type BitcoinRequest = Extract<SignRequest, { kind: "bitcoin.psbt" | "bitcoin.message" }>;
export type SolanaRequest = Extract<SignRequest, { kind: "solana.transaction" | "solana.message" }>;

export const BTC_PURPOSE: Readonly<Record<string, number>> = {
  "btc.bip44": 44,
  "btc.bip49": 49,
  "btc.bip84": 84,
  "btc.bip86": 86,
};

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
