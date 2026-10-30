/**
 * /evm/sign — deterministic (RFC 6979) ECDSA signing over the chain's canonical payloads. Inputs
 * must already be normalized: the kernel calls `normalizeEvm` first and rejects on a ChainError. No
 * key caching; the caller wipes key bytes.
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
import type { EvmAccessListEntry, EvmTransaction } from "../index.ts";
import { parseTypedData } from "./typed-data.ts";

/** Validates a string is `0x`-hex and narrows it for ox's branded type. */
function assertHex(value: string, field: string): asserts value is `0x${string}` {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new ChainError("invalid-quantity", `${field} must be 0x-prefixed bytes`);
  }
}

const hex = (value: string, field: string): `0x${string}` => {
  assertHex(value, field);
  return value;
};

const key = (privateKey: Uint8Array): `0x${string}` => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be 32 bytes");
  }
  return Hex.fromBytes(privateKey);
};

const accessEntry = (entry: EvmAccessListEntry) => ({
  address: hex(entry.address, "accessList.address"),
  storageKeys: entry.storageKeys.map((k) => hex(k, "accessList.storageKeys")),
});

const sign = (payload: `0x${string}`, privateKey: `0x${string}`) =>
  Secp256k1.sign({ payload, privateKey, as: "Object" as const });

/** Signs a normalized transaction; returns the serialized signed envelope. */
export const signEvmTransaction = (tx: EvmTransaction, privateKey: Uint8Array): Uint8Array => {
  const privateKeyHex = key(privateKey);
  const base = {
    chainId: tx.chainId,
    to: tx.to === undefined ? undefined : hex(tx.to, "to"),
    data: hex(tx.data, "data"),
    value: BigInt(tx.value),
    nonce: BigInt(tx.nonce),
    gas: BigInt(tx.gas),
  };
  if (tx.type === "legacy") {
    const envelope = { ...base, type: "legacy" as const, gasPrice: BigInt(tx.gasPrice) };
    const signature = sign(TxEnvelopeLegacy.getSignPayload(envelope), privateKeyHex);
    return Hex.toBytes(TxEnvelopeLegacy.serialize(envelope, { signature }));
  }
  if (tx.type === "eip2930") {
    const envelope = {
      ...base,
      type: "eip2930" as const,
      gasPrice: BigInt(tx.gasPrice),
      accessList: tx.accessList.map(accessEntry),
    };
    const signature = sign(TxEnvelopeEip2930.getSignPayload(envelope), privateKeyHex);
    return Hex.toBytes(TxEnvelopeEip2930.serialize(envelope, { signature }));
  }
  const envelope = {
    ...base,
    type: "eip1559" as const,
    accessList: tx.accessList.map(accessEntry),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
  };
  const signature = sign(TxEnvelopeEip1559.getSignPayload(envelope), privateKeyHex);
  return Hex.toBytes(TxEnvelopeEip1559.serialize(envelope, { signature }));
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
  const { json } = parseTypedData(typedData, "eip155:1");
  const payload = TypedData.getSignPayload(json);
  return rs_v(Signature.from(sign(payload, key(privateKey))));
};
