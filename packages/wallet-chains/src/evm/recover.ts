/**
 * Signer recovery for `chain.sign` results: the host re-derives the signer address from a signed
 * envelope or a 65-byte signature and compares it with the account's `wallet.accounts` address — a
 * kernel returning someone else's signature fails closed.
 */
import * as Hex from "ox/Hex";
import * as PersonalMessage from "ox/PersonalMessage";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";
import * as TxEnvelopeEip1559 from "ox/TxEnvelopeEip1559";
import * as TxEnvelopeEip2930 from "ox/TxEnvelopeEip2930";
import * as TxEnvelopeLegacy from "ox/TxEnvelopeLegacy";
import * as TypedData from "ox/TypedData";

import { ChainError } from "../index.ts";
import type { SignRequest } from "../index.ts";
import { parseTypedData } from "./typed-data.ts";

function assertEip1559Hex(hex: `0x${string}`): asserts hex is `0x02${string}` {
  if (!hex.startsWith("0x02")) {
    throw new ChainError("invalid-request", "unrecognized signed transaction envelope");
  }
}
function assertEip2930Hex(hex: `0x${string}`): asserts hex is `0x01${string}` {
  if (!hex.startsWith("0x01")) {
    throw new ChainError("invalid-request", "unrecognized signed transaction envelope");
  }
}

type EnvelopeFields = {
  readonly r?: `0x${string}` | undefined;
  readonly s?: `0x${string}` | undefined;
  readonly yParity?: number | undefined;
};

const signatureOf = (env: EnvelopeFields) => {
  const { r, s, yParity } = env;
  if (r === undefined || s === undefined || yParity === undefined) {
    throw new ChainError("invalid-request", "envelope carries no signature");
  }
  return Signature.from({ r, s, yParity });
};

/** Recover the signer's EIP-55 address from a serialized signed transaction envelope. */
const signerFromEnvelope = (signedTransaction: Uint8Array): string => {
  const hex = Hex.fromBytes(signedTransaction);
  const [tag] = signedTransaction;
  if (tag === 0x02) {
    assertEip1559Hex(hex);
    const env = TxEnvelopeEip1559.deserialize(hex);
    const payload = TxEnvelopeEip1559.getSignPayload(env);
    return Secp256k1.recoverAddress({ payload, signature: signatureOf(env) });
  }
  if (tag === 0x01) {
    assertEip2930Hex(hex);
    const env = TxEnvelopeEip2930.deserialize(hex);
    const payload = TxEnvelopeEip2930.getSignPayload(env);
    return Secp256k1.recoverAddress({ payload, signature: signatureOf(env) });
  }
  try {
    const env = TxEnvelopeLegacy.deserialize(hex);
    const payload = TxEnvelopeLegacy.getSignPayload(env);
    return Secp256k1.recoverAddress({ payload, signature: signatureOf(env) });
  } catch {
    throw new ChainError("invalid-request", "unrecognized signed transaction envelope");
  }
};

/**
 * The EIP-55 address that produced `result` for `request` — a `chain.sign` round-trip check
 * (`{kind:"evm.transaction",signedTransaction}` | `{kind,signature}`).
 */
export const recoverEvmSigner = (
  request: Extract<SignRequest, { network: string }>,
  result: { readonly signedTransaction?: Uint8Array; readonly signature?: Uint8Array },
): string => {
  if (request.kind === "evm.transaction") {
    if (result.signedTransaction === undefined) {
      throw new ChainError("invalid-request", "expected a signed transaction");
    }
    return signerFromEnvelope(result.signedTransaction);
  }
  if (result.signature === undefined || result.signature.length !== 65) {
    throw new ChainError("invalid-request", "expected a 65-byte signature");
  }
  const signature = Signature.from(result.signature);
  if (request.kind === "evm.personal-message") {
    const payload = PersonalMessage.getSignPayload(Hex.fromBytes(request.message));
    return Secp256k1.recoverAddress({ payload, signature });
  }
  if (request.kind === "evm.typed-data") {
    const { json } = parseTypedData(request.typedData, request.network);
    const payload = TypedData.getSignPayload(json);
    return Secp256k1.recoverAddress({ payload, signature });
  }
  throw new ChainError("unsupported", `cannot recover a signer for ${request.kind}`);
};
