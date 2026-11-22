import { getTransactionDecoder } from "@solana/transactions";

import { ChainError } from "../index.ts";
import {
  LEGACY_TRANSACTION_MAX_BYTES,
  V1_TRANSACTION_MAX_BYTES,
  parseCompiledMessage,
} from "./message.ts";
import type { ParsedSolanaMessage } from "./message.ts";
import { verifySolanaSignature } from "./verify.ts";

/** A serialized transaction read for one of its required signers. */
export type SolanaTransactionForSigner = {
  /** The compiled message the signer signs. */
  readonly message: Uint8Array;
  /** Required signers other than `signer` whose signature slot is still all zeros, in slot order. */
  readonly unsigned: ReadonlyArray<string>;
};

type ReadTransaction = {
  readonly message: Uint8Array;
  readonly parsed: ParsedSolanaMessage;
  readonly slots: ReadonlyArray<readonly [string, Readonly<Uint8Array> | undefined]>;
};

const transactionDecoder = getTransactionDecoder();

/**
 * The structural half of `decodeSolanaTransaction`: the wire decodes, the message is a supported
 * compiled message, the whole transaction fits the version's size limit (a v1 wire puts the message
 * first and is 4096; legacy/v0 put a signature-count shortvec first and are 1232) and the signature
 * count agrees with the message header. Yields the message, its parse, and the signature slots in
 * wire order — the slot byte offset follows from them.
 */
const readTransaction = (wire: Uint8Array): ReadTransaction => {
  const limit = wire[0] === 0x81 ? V1_TRANSACTION_MAX_BYTES : LEGACY_TRANSACTION_MAX_BYTES;
  if (wire.length > limit) {
    throw new ChainError("invalid-request", `transaction exceeds the ${limit}-byte limit`);
  }
  let tx: ReturnType<typeof transactionDecoder.decode>;
  try {
    tx = transactionDecoder.decode(wire);
  } catch {
    throw new ChainError("invalid-request", "transaction failed to decode");
  }
  const message = new Uint8Array(tx.messageBytes);
  const parsed = parseCompiledMessage(message);
  const slots = Object.entries(tx.signatures).map(
    ([account, signature]) => [account, signature ?? undefined] as const,
  );
  if (slots.length !== parsed.numRequiredSignatures) {
    throw new ChainError(
      "invalid-request",
      `transaction carries ${slots.length} signatures for ${parsed.numRequiredSignatures} required signers`,
    );
  }
  return { message, parsed, slots };
};

/**
 * Reads the serialized transaction `wire` as the Wallet Standard passes it for `signer`: the
 * compiled message the signer signs, and which other required signers have not signed yet. Every
 * non-empty signature slot must verify over the message — one that cannot land is refused.
 */
export const decodeSolanaTransaction = (
  wire: Uint8Array,
  signer: string,
): SolanaTransactionForSigner => {
  const { message, slots } = readTransaction(wire);
  if (!slots.some(([account]) => account === signer)) {
    throw new ChainError("invalid-request", "signer is not a required signer of the transaction");
  }
  const unsigned: string[] = [];
  for (const [account, signature] of slots) {
    if (signature === undefined) {
      if (account !== signer) {
        unsigned.push(account);
      }
      continue;
    }
    if (!verifySolanaSignature(message, signature, account)) {
      throw new ChainError("invalid-request", `the signature of ${account} does not verify`);
    }
  }
  return { message, unsigned };
};

/**
 * `wire` with `signer`'s slot set to `signature`; every other byte unchanged — the other signatures
 * and their order are preserved byte for byte (a v1 wire keeps the message first).
 */
export const addSolanaSignature = (
  wire: Uint8Array,
  signer: string,
  signature: Uint8Array,
): Uint8Array => {
  if (signature.length !== 64) {
    throw new ChainError("invalid-request", "signature must be 64 bytes");
  }
  const { message, parsed, slots } = readTransaction(wire);
  const index = slots.findIndex(([account]) => account === signer);
  if (index === -1) {
    throw new ChainError("invalid-request", "signer is not a required signer of the transaction");
  }
  /* A v1 wire is the message followed by the signature slots; legacy/v0 put the message last, so
     slot `index` ends 64·(n−index) bytes before it. */
  const offset =
    parsed.version === 1
      ? message.length + 64 * index
      : wire.length - message.length - 64 * (slots.length - index);
  const out = new Uint8Array(wire);
  out.set(signature, offset);
  return out;
};
