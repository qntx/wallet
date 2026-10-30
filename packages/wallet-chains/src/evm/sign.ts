/**
 * /evm/sign — deterministic (RFC 6979) ECDSA signing over the chain's canonical payloads. Inputs
 * must already be normalized: the kernel calls `normalizeEvm` first and rejects on a ChainError. No
 * key caching; the caller wipes key bytes.
 */
import * as Hex from "ox/Hex";
import * as PersonalMessage from "ox/PersonalMessage";
import * as Secp256k1 from "ox/Secp256k1";
import * as TxEnvelopeEip1559 from "ox/TxEnvelopeEip1559";
import * as TxEnvelopeEip2930 from "ox/TxEnvelopeEip2930";
import * as TxEnvelopeLegacy from "ox/TxEnvelopeLegacy";
import * as TypedData from "ox/TypedData";

import { ChainError } from "../index.ts";
import type { EvmTransaction } from "../index.ts";
import { isRecord, normalizeEvmTransaction } from "./transaction.ts";

/** Validates a string is `0x`-hex and narrows it for ox's branded type. */
function assertHex(value: string, field: string): asserts value is `0x${string}` {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new ChainError("invalid-quantity", `${field} must be 0x-prefixed bytes`);
  }
}

const key = (privateKey: Uint8Array): `0x${string}` => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be 32 bytes");
  }
  return Hex.fromBytes(privateKey);
};

const hex = (value: string | undefined, field: string): `0x${string}` | undefined => {
  if (value === undefined) {
    return undefined;
  }
  assertHex(value, field);
  return value;
};

const toBigInt = (value: string | undefined): bigint | undefined =>
  value === undefined ? undefined : BigInt(value);

const toNonNegative = (value: number | undefined): bigint | undefined =>
  value === undefined ? undefined : BigInt(value);

const storageKey = (value: string): `0x${string}` => {
  assertHex(value, "accessList.storageKeys");
  return value;
};

const sign = (payload: `0x${string}`, privateKey: `0x${string}`) =>
  Secp256k1.sign({ payload, privateKey, as: "Object" });

/** Signs a normalized transaction; returns the serialized signed envelope. */
export const signEvmTransaction = (tx: EvmTransaction, privateKey: Uint8Array): Uint8Array => {
  const normalized = normalizeEvmTransaction(tx);
  const privateKeyHex = key(privateKey);
  const to =
    normalized.to === undefined
      ? undefined
      : (() => {
          assertHex(normalized.to, "to");
          return normalized.to;
        })();
  const data = hex(normalized.data, "data");
  const value = toBigInt(normalized.value);
  const nonce = toNonNegative(normalized.nonce);
  const gas = toBigInt(normalized.gas);
  const access = normalized.accessList?.map((entry) => ({
    address: (() => {
      assertHex(entry.address, "accessList.address");
      return entry.address;
    })(),
    storageKeys: entry.storageKeys.map(storageKey),
  }));
  if (normalized.type === "legacy") {
    const envelope = {
      chainId: normalized.chainId,
      ...(to === undefined ? {} : { to }),
      ...(data === undefined ? {} : { data }),
      ...(value === undefined ? {} : { value }),
      ...(nonce === undefined ? {} : { nonce }),
      ...(gas === undefined ? {} : { gas }),
      gasPrice: toBigInt(normalized.gasPrice),
    };
    const payload = TxEnvelopeLegacy.getSignPayload({ ...envelope, type: "legacy" });
    const signature = sign(payload, privateKeyHex);
    return Hex.toBytes(TxEnvelopeLegacy.serialize({ ...envelope, type: "legacy" }, { signature }));
  }
  if (normalized.type === "eip2930") {
    const envelope = {
      chainId: normalized.chainId,
      ...(to === undefined ? {} : { to }),
      ...(data === undefined ? {} : { data }),
      ...(value === undefined ? {} : { value }),
      ...(nonce === undefined ? {} : { nonce }),
      ...(gas === undefined ? {} : { gas }),
      gasPrice: toBigInt(normalized.gasPrice),
      ...(access === undefined ? {} : { accessList: access }),
    };
    const payload = TxEnvelopeEip2930.getSignPayload({ ...envelope, type: "eip2930" });
    const signature = sign(payload, privateKeyHex);
    return Hex.toBytes(
      TxEnvelopeEip2930.serialize({ ...envelope, type: "eip2930" }, { signature }),
    );
  }
  const envelope = {
    chainId: normalized.chainId,
    ...(to === undefined ? {} : { to }),
    ...(data === undefined ? {} : { data }),
    ...(value === undefined ? {} : { value }),
    ...(nonce === undefined ? {} : { nonce }),
    ...(gas === undefined ? {} : { gas }),
    ...(access === undefined ? {} : { accessList: access }),
    maxFeePerGas: toBigInt(normalized.maxFeePerGas),
    maxPriorityFeePerGas: toBigInt(normalized.maxPriorityFeePerGas),
  };
  const payload = TxEnvelopeEip1559.getSignPayload({ ...envelope, type: "eip1559" });
  const signature = sign(payload, privateKeyHex);
  return Hex.toBytes(TxEnvelopeEip1559.serialize({ ...envelope, type: "eip1559" }, { signature }));
};

const u256 = (value: bigint, out: Uint8Array, offset: number): void => {
  let n = value;
  for (let i = 31; i >= 0; i--) {
    out[offset + i] = Number(n % 256n);
    n /= 256n;
  }
};

const rs_v = (signature: { r: `0x${string}`; s: `0x${string}`; yParity: number }): Uint8Array => {
  const out = new Uint8Array(65);
  u256(BigInt(signature.r), out, 0);
  u256(BigInt(signature.s), out, 32);
  out[64] = 27 + signature.yParity;
  return out;
};

/** EIP-191 personal_sign; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signEvmPersonalMessage = (message: Uint8Array, privateKey: Uint8Array): Uint8Array => {
  const payload = PersonalMessage.getSignPayload(Hex.fromBytes(message));
  return rs_v(sign(payload, key(privateKey)));
};

/** EIP-712 typed data; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signEvmTypedData = (typedData: string, privateKey: Uint8Array): Uint8Array => {
  const parsed: unknown = JSON.parse(typedData);
  if (!isRecord(parsed)) {
    throw new ChainError("invalid-typed-data", "typedData must be a JSON object");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a plain object above; ox validates the rest
  const validated = parsed as Parameters<typeof TypedData.validate>[0];
  TypedData.validate(validated);
  const payload = TypedData.getSignPayload(validated);
  return rs_v(sign(payload, key(privateKey)));
};
