/**
 * The unsigned EIP-2718 envelope of a normalized transaction — one construction shared by the
 * kernel's signer and by the host's round-trip check, which re-serializes it with the returned
 * signature to prove the kernel signed exactly the requested transaction.
 */
import type * as Authorization from "ox/Authorization";
import type * as Hex from "ox/Hex";
import type * as Signature from "ox/Signature";
import * as TxEnvelopeEip1559 from "ox/TxEnvelopeEip1559";
import * as TxEnvelopeEip2930 from "ox/TxEnvelopeEip2930";
import * as TxEnvelopeEip7702 from "ox/TxEnvelopeEip7702";
import * as TxEnvelopeLegacy from "ox/TxEnvelopeLegacy";

import { ChainError } from "../index.ts";
import type { EvmAccessListEntry, EvmTransaction } from "../index.ts";

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

const accessEntry = (entry: EvmAccessListEntry) => ({
  address: hex(entry.address, "accessList.address"),
  storageKeys: entry.storageKeys.map((k) => hex(k, "accessList.storageKeys")),
});

/** The EIP-7702 authorization an `eip7702` transaction carries: the account's next-but-one nonce. */
export const evmAuthorization = (
  tx: Extract<EvmTransaction, { type: "eip7702" }>,
): Authorization.Authorization => ({
  chainId: tx.chainId,
  address: hex(tx.authorization.address, "authorization.address"),
  nonce: BigInt(tx.nonce + 1),
});

/** An unsigned envelope: the digest to sign and its serialization under a signature. */
export type EvmEnvelope = {
  readonly payload: Hex.Hex;
  readonly serialize: (signature: Signature.Signature) => Hex.Hex;
};

/**
 * The envelope of `tx`. An `eip7702` transaction embeds its signed authorization, so the caller
 * passes the signature over `evmAuthorization(tx)`.
 */
export const evmEnvelope = (
  tx: EvmTransaction,
  authorization?: Signature.Signature,
): EvmEnvelope => {
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
    return {
      payload: TxEnvelopeLegacy.getSignPayload(envelope),
      serialize: (signature) => TxEnvelopeLegacy.serialize(envelope, { signature }),
    };
  }
  if (tx.type === "eip2930") {
    const envelope = {
      ...base,
      type: "eip2930" as const,
      gasPrice: BigInt(tx.gasPrice),
      accessList: tx.accessList.map(accessEntry),
    };
    return {
      payload: TxEnvelopeEip2930.getSignPayload(envelope),
      serialize: (signature) => TxEnvelopeEip2930.serialize(envelope, { signature }),
    };
  }
  if (tx.type === "eip7702") {
    if (authorization === undefined) {
      throw new ChainError("invalid-request", "an eip7702 envelope needs its signed authorization");
    }
    const envelope = {
      ...base,
      type: "eip7702" as const,
      to: hex(tx.to, "to"),
      accessList: tx.accessList.map(accessEntry),
      maxFeePerGas: BigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
      authorizationList: [
        {
          ...evmAuthorization(tx),
          r: authorization.r,
          s: authorization.s,
          yParity: authorization.yParity,
        },
      ],
    };
    return {
      payload: TxEnvelopeEip7702.getSignPayload(envelope),
      serialize: (signature) => TxEnvelopeEip7702.serialize(envelope, { signature }),
    };
  }
  const envelope = {
    ...base,
    type: "eip1559" as const,
    accessList: tx.accessList.map(accessEntry),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
  };
  return {
    payload: TxEnvelopeEip1559.getSignPayload(envelope),
    serialize: (signature) => TxEnvelopeEip1559.serialize(envelope, { signature }),
  };
};
