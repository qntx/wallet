/**
 * The `hl-agent` record: one sealed secp256k1 private key per record, keyed by the agent's
 * lowercase EVM address. The header is the authenticated public side — the wallet and account it
 * belongs to, the Hyperliquid network, the name the user gave it, and the signing deadline. A
 * distinct kind, not a `key` record with a scope flag: every path that enumerates `key` records
 * (chain.sign imported pass, keys.list/export/remove, backups) structurally cannot see it.
 */
import { checksumEvmAddress } from "@qntx/wallet-chains/evm";
import type { HyperliquidAgentInfo, HyperliquidNetwork } from "@qntx/wallet/protocol";

import {
  asCreatedAt,
  asGroupIndex,
  asWalletId,
  expectKeys,
  headerFailure,
  headerObject,
} from "../../vault/header-codec.ts";
import type { StoredRecord, VaultImage } from "../../vault/store.ts";

/** The record kind this module owns. */
export const HL_AGENT_KIND = "hl-agent";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NAME = /^[A-Za-z0-9._-]{1,16}$/;

export type AgentHeader = {
  readonly walletId: string;
  readonly groupIndex: number;
  /** EIP-55 owner address, derived by the kernel — never host input. */
  readonly owner: string;
  readonly network: HyperliquidNetwork;
  readonly name: string;
  readonly validUntil: number;
  readonly createdAt: number;
};

const HEADER_KEYS = [
  "walletId",
  "groupIndex",
  "owner",
  "network",
  "name",
  "validUntil",
  "createdAt",
] as const;

const asAddress = (value: unknown): string => {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw headerFailure();
  }
  return value;
};

const asNetwork = (value: unknown): HyperliquidNetwork => {
  if (value !== "Mainnet" && value !== "Testnet") {
    throw headerFailure();
  }
  return value;
};

const asName = (value: unknown): string => {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw headerFailure();
  }
  return value;
};

/** Stored JSON, key order fixed so the text is a stable authenticated byte string. */
export function encodeAgentHeader(header: AgentHeader): string {
  return JSON.stringify({
    walletId: header.walletId,
    groupIndex: header.groupIndex,
    owner: header.owner,
    network: header.network,
    name: header.name,
    validUntil: header.validUntil,
    createdAt: header.createdAt,
  });
}

export function parseAgentHeader(text: string): AgentHeader {
  const object = headerObject(text);
  expectKeys(object, HEADER_KEYS);
  return {
    walletId: asWalletId(object["walletId"]),
    groupIndex: asGroupIndex(object["groupIndex"]),
    owner: asAddress(object["owner"]),
    network: asNetwork(object["network"]),
    name: asName(object["name"]),
    validUntil: asCreatedAt(object["validUntil"]),
    createdAt: asCreatedAt(object["createdAt"]),
  };
}

/** The public snapshot of one stored agent — the record id is the lowercase address. */
export function agentInfo(record: StoredRecord): HyperliquidAgentInfo {
  return { address: checksumEvmAddress(record.id), ...parseAgentHeader(record.header) };
}

/** The stored agent record for an address (any case), or undefined — never throws. */
export function findAgent(image: VaultImage, address: string): StoredRecord | undefined {
  const id = address.toLowerCase();
  return image.records.find((record) => record.kind === HL_AGENT_KIND && record.id === id);
}
