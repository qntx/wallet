import { Address, OutScript } from "@scure/btc-signer/payment.js";

import { isRecord, requestBase } from "../account-ref.ts";
import { ChainError } from "../index.ts";
import type { AccountRef, SignRequest } from "../index.ts";
import { bitcoinNetwork } from "./networks.ts";
import { normalizeBitcoinPsbt } from "./psbt.ts";

export { BITCOIN_NETWORKS, bitcoinNetwork } from "./networks.ts";
export type { BitcoinAccountTemplate } from "./account.ts";
export { bitcoinAddressFromXpub, bitcoinPubkeyFromXpub } from "./account.ts";
export { decodeBitcoinPsbt, verifiabilityBitcoin } from "./decode.ts";
export { verifyBitcoinMessage, verifyBitcoinPsbtSignatures } from "./verify.ts";

const common = (request: Record<string, unknown>): { network: string; account: AccountRef } => {
  const base = requestBase(request);
  bitcoinNetwork(base.network);
  return base;
};

/** The decoded `address` fields needed by message signers. */
export type MessageTarget = {
  readonly type: string;
  readonly address: string;
  readonly format: "bip322-simple" | "legacy";
  readonly scriptPubKey: Uint8Array;
};

const messageTarget = (address: unknown, network: string, format: unknown): MessageTarget => {
  if (typeof address !== "string") {
    throw new ChainError("invalid-request", "address must be a string");
  }
  const net = bitcoinNetwork(network);
  let decoded: ReturnType<ReturnType<typeof Address>["decode"]>;
  try {
    decoded = Address(net.params).decode(address);
  } catch {
    throw new ChainError("invalid-address", "address does not belong to this network");
  }
  if (format === "bip322-simple") {
    if (decoded.type !== "wpkh" && decoded.type !== "tr") {
      throw new ChainError("unsupported", "bip322-simple is only for P2WPKH/P2TR addresses");
    }
  } else if (format === "legacy") {
    if (decoded.type !== "pkh") {
      throw new ChainError("unsupported", "legacy signing is only for P2PKH addresses");
    }
  } else {
    throw new ChainError("unsupported", `unsupported message format: ${String(format)}`);
  }
  const scriptPubKey = OutScript.encode(decoded);
  return { type: decoded.type, address, format, scriptPubKey };
};

/**
 * Normalizes a bitcoin sign request. Idempotent: the returned PSBT is the canonical
 * re-serialization.
 */
export const normalizeBitcoin = (request: unknown): SignRequest => {
  if (!isRecord(request) || typeof request["kind"] !== "string") {
    throw new ChainError("invalid-request", "request must be an object with a kind");
  }
  if (request["kind"] === "bitcoin.psbt") {
    const { network, account, psbt } = request;
    if (typeof network !== "string") {
      throw new ChainError("invalid-request", "request.network must be a string");
    }
    bitcoinNetwork(network);
    if (!isRecord(account) || account["kind"] !== "hd") {
      throw new ChainError("invalid-request", "request.account must be a wallet group");
    }
    const { walletId, groupIndex } = account;
    if (
      typeof walletId !== "string" ||
      typeof groupIndex !== "number" ||
      !Number.isSafeInteger(groupIndex) ||
      groupIndex < 0
    ) {
      throw new ChainError("invalid-request", "request.account must be a wallet group");
    }
    if (!(psbt instanceof Uint8Array)) {
      throw new ChainError("invalid-request", "psbt must be bytes");
    }
    const normalized = normalizeBitcoinPsbt(psbt, request["sign"], network);
    return {
      kind: "bitcoin.psbt",
      network,
      account: { kind: "hd", walletId, groupIndex },
      psbt: normalized.psbt,
      sign: normalized.sign,
    };
  }
  const { network, account } = common(request);
  if (request["kind"] === "bitcoin.message") {
    const { format } = request;
    const target = messageTarget(request["address"], network, format);
    void target;
    const { message, change, index } = request;
    if (typeof message !== "string") {
      throw new ChainError("invalid-request", "message must be a string");
    }
    if (change !== 0 && change !== 1) {
      throw new ChainError("invalid-request", "change must be 0 or 1");
    }
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= 0x80000000
    ) {
      throw new ChainError("invalid-request", "index must be a non-hardened path index");
    }
    return {
      kind: "bitcoin.message",
      network,
      account,
      address: target.address,
      message,
      format: target.format,
      change,
      index,
    };
  }
  throw new ChainError("unsupported", `unsupported sign request kind: ${request["kind"]}`);
};

/** Decodes the message `address` into the scriptPubKey the signer needs. */
export const decodeMessageTarget = (
  request: Extract<SignRequest, { kind: "bitcoin.message" }>,
): MessageTarget => messageTarget(request.address, request.network, request.format);
