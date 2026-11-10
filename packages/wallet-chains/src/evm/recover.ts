/**
 * Signer recovery for `chain.sign` results: the host re-derives the signer address of the requested
 * transaction, message or typed data and compares it with the account's `wallet.accounts` address —
 * a kernel returning someone else's signature, or a signature over other content, fails closed.
 */
import * as Authorization from "ox/Authorization";
import * as Hex from "ox/Hex";
import * as PersonalMessage from "ox/PersonalMessage";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";
import * as TxEnvelopeEip1559 from "ox/TxEnvelopeEip1559";
import * as TxEnvelopeEip2930 from "ox/TxEnvelopeEip2930";
import * as TxEnvelopeEip7702 from "ox/TxEnvelopeEip7702";
import * as TxEnvelopeLegacy from "ox/TxEnvelopeLegacy";
import * as TypedData from "ox/TypedData";

import { ChainError } from "../index.ts";
import type { SignRequest } from "../index.ts";
import { evmAuthorization, evmEnvelope } from "./envelope.ts";
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
function assertEip7702Hex(hex: `0x${string}`): asserts hex is `0x04${string}` {
  if (!hex.startsWith("0x04")) {
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

/**
 * The transaction signature and, for EIP-7702, the authorization signature a signed envelope
 * carries.
 */
const signaturesOf = (
  hex: `0x${string}`,
): { readonly signature: Signature.Signature; readonly authorization?: Signature.Signature } => {
  if (hex.startsWith("0x04")) {
    assertEip7702Hex(hex);
    const env = TxEnvelopeEip7702.deserialize(hex);
    const auths = env.authorizationList ?? [];
    const [auth] = auths;
    if (auths.length !== 1 || auth === undefined) {
      throw new ChainError("invalid-request", "authorization does not match the request");
    }
    return { signature: signatureOf(env), authorization: Signature.from(auth) };
  }
  if (hex.startsWith("0x02")) {
    assertEip1559Hex(hex);
    return { signature: signatureOf(TxEnvelopeEip1559.deserialize(hex)) };
  }
  if (hex.startsWith("0x01")) {
    assertEip2930Hex(hex);
    return { signature: signatureOf(TxEnvelopeEip2930.deserialize(hex)) };
  }
  try {
    return { signature: signatureOf(TxEnvelopeLegacy.deserialize(hex)) };
  } catch {
    throw new ChainError("invalid-request", "unrecognized signed transaction envelope");
  }
};

/**
 * The signer of `signedTransaction`, which must be exactly `request.tx` under its signature: the
 * envelope is rebuilt from the request, re-serialized with the returned signatures and compared
 * byte for byte, so a valid signature by the account over any other transaction is refused.
 */
const signerFromEnvelope = (
  signedTransaction: Uint8Array,
  request: Extract<SignRequest, { kind: "evm.transaction" }>,
): string => {
  const hex = Hex.fromBytes(signedTransaction);
  const { signature, authorization } = signaturesOf(hex);
  const expected = evmEnvelope(request.tx, authorization);
  // `serialize` keeps the request's hex casing (checksummed addresses); `hex` is lowercase.
  if (expected.serialize(signature).toLowerCase() !== hex) {
    throw new ChainError("invalid-request", "the signed transaction does not match the request");
  }
  const signer = Secp256k1.recoverAddress({ payload: expected.payload, signature });
  if (request.tx.type === "eip7702" && authorization !== undefined) {
    const authSigner = Secp256k1.recoverAddress({
      payload: Authorization.getSignPayload(evmAuthorization(request.tx)),
      signature: authorization,
    });
    if (authSigner.toLowerCase() !== signer.toLowerCase()) {
      throw new ChainError("invalid-request", "authorization signer is not the account");
    }
  }
  return signer;
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
    return signerFromEnvelope(result.signedTransaction, request);
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
    const { json } = parseTypedData(request.typedData);
    const payload = TypedData.getSignPayload(json);
    return Secp256k1.recoverAddress({ payload, signature });
  }
  throw new ChainError("unsupported", `cannot recover a signer for ${request.kind}`);
};
