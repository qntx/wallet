import { Address, OutScript } from "@scure/btc-signer/payment.js";

import { ChainError } from "../index.ts";
import type { AccountRef, SignRequest } from "../index.ts";
import { bitcoinNetwork } from "./networks.ts";
import { normalizeBitcoinPsbt } from "./psbt.ts";

export { BITCOIN_NETWORKS, bitcoinNetwork } from "./networks.ts";
export type { BitcoinAccountTemplate } from "./account.ts";
export { bitcoinAddressFromXpub } from "./account.ts";
export { decodeBitcoinPsbt, verifiabilityBitcoin } from "./decode.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAccountRef = (value: unknown): value is AccountRef => {
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    return false;
  }
  if (value["kind"] === "hd") {
    return (
      typeof value["walletId"] === "string" &&
      typeof value["groupIndex"] === "number" &&
      typeof value["template"] === "string"
    );
  }
  return (
    value["kind"] === "imported" &&
    typeof value["keyId"] === "string" &&
    typeof value["family"] === "string"
  );
};

const common = (request: Record<string, unknown>): { network: string; account: AccountRef } => {
  const { network } = request;
  const { account } = request;
  if (typeof network !== "string") {
    throw new ChainError("invalid-request", "request.network must be a string");
  }
  if (!isAccountRef(account)) {
    throw new ChainError("invalid-request", "request.account must be an AccountRef");
  }
  bitcoinNetwork(network);
  return { network, account };
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
  const { network, account } = common(request);
  if (request["kind"] === "bitcoin.psbt") {
    const { psbt } = request;
    if (!(psbt instanceof Uint8Array)) {
      throw new ChainError("invalid-request", "psbt must be bytes");
    }
    const normalized = normalizeBitcoinPsbt(psbt, request["sign"], network);
    return { kind: "bitcoin.psbt", network, account, psbt: normalized.psbt, sign: normalized.sign };
  }
  if (request["kind"] === "bitcoin.message") {
    const { format } = request;
    const target = messageTarget(request["address"], network, format);
    void target;
    const { message } = request;
    if (typeof message !== "string") {
      throw new ChainError("invalid-request", "message must be a string");
    }
    return {
      kind: "bitcoin.message",
      network,
      account,
      address: target.address,
      message,
      format: target.format,
    };
  }
  throw new ChainError("unsupported", `unsupported sign request kind: ${request["kind"]}`);
};

/** Decodes the message `address` into the scriptPubKey the signer needs. */
export const decodeMessageTarget = (
  request: Extract<SignRequest, { kind: "bitcoin.message" }>,
): MessageTarget => messageTarget(request.address, request.network, request.format);
