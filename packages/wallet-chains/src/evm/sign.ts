/**
 * /evm/sign — deterministic (RFC 6979) ECDSA signing over the chain's canonical payloads. Inputs
 * must already be normalized: the kernel calls `normalizeEvm` first and rejects on a ChainError. No
 * key caching; the caller wipes key bytes.
 */
import * as Authorization from "ox/Authorization";
import * as Hex from "ox/Hex";
import * as PersonalMessage from "ox/PersonalMessage";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";
import * as TypedData from "ox/TypedData";

import { ChainError } from "../index.ts";
import type { EvmTransaction } from "../index.ts";
import { evmAuthorization, evmEnvelope } from "./envelope.ts";
import { parseTypedData } from "./typed-data.ts";

const key = (privateKey: Uint8Array): `0x${string}` => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be 32 bytes");
  }
  return Hex.fromBytes(privateKey);
};

const sign = (payload: `0x${string}`, privateKey: `0x${string}`) =>
  Secp256k1.sign({ payload, privateKey, as: "Object" as const });

/** Signs a normalized transaction; returns the serialized signed envelope. */
export const signEvmTransaction = (tx: EvmTransaction, privateKey: Uint8Array): Uint8Array => {
  const privateKeyHex = key(privateKey);
  const envelope = evmEnvelope(
    tx,
    tx.type === "eip7702"
      ? sign(Authorization.getSignPayload(evmAuthorization(tx)), privateKeyHex)
      : undefined,
  );
  return Hex.toBytes(envelope.serialize(sign(envelope.payload, privateKeyHex)));
};

/** 65-byte r‖s‖v; `Signature.toBytes` emits v = 27 + yParity already. */
const rs_v = (signature: Signature.Signature): Uint8Array => Signature.toBytes(signature);

/** EIP-191 personal_sign; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signEvmPersonalMessage = (message: Uint8Array, privateKey: Uint8Array): Uint8Array => {
  const payload = PersonalMessage.getSignPayload(Hex.fromBytes(message));
  return rs_v(Signature.from(sign(payload, key(privateKey))));
};

/** EIP-712 typed data; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signEvmTypedData = (typedData: string, privateKey: Uint8Array): Uint8Array => {
  const { json } = parseTypedData(typedData);
  let payload: Hex.Hex;
  try {
    payload = TypedData.getSignPayload(json);
  } catch {
    throw new ChainError("invalid-typed-data", "typedData failed to encode");
  }
  return rs_v(Signature.from(sign(payload, key(privateKey))));
};
