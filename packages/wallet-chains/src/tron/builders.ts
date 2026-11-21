import { hexToBytes } from "@noble/hashes/utils.js";
/**
 * Pure TRON transaction builders — no clock, no I/O; the caller supplies the block reference and
 * times. `ref_block_bytes` is the block number's low two bytes big-endian and `ref_block_hash`
 * bytes 8..16 of the block id (tronweb AbstractTrx.ts:1108-1121) — together they pin the
 * transaction to a recent block on exactly one network.
 */
import * as AbiFunction from "ox/AbiFunction";

import { hasHiddenCharacters } from "../display.ts";
import { ChainError } from "../index.ts";
import { tronAddressToEvm } from "./address.ts";
import { TRON_CONTRACT_TYPES, tronTypeUrl } from "./contract-types.ts";
import { encodeTronContract } from "./contracts.ts";
import type { TronContract } from "./contracts.ts";
import { encodeTronRawData } from "./raw.ts";

export type TronBlockRef = {
  readonly number: number;
  /** The block id, 64 lowercase hex. */
  readonly id: string;
};

export type TronTransactionHeader = {
  readonly refBlock: TronBlockRef;
  /** Milliseconds. */
  readonly expiration: number;
  readonly timestamp: number;
  readonly feeLimit?: bigint;
  readonly memo?: Uint8Array;
  readonly permissionId?: number;
};

/** A TRON memo (`raw_data.data`) is 1–256 UTF-8 bytes. */
export const TRON_MEMO_MAX_BYTES = 256;

const utf8Encode = new TextEncoder();

/**
 * A memo's wire bytes: non-empty, at most `TRON_MEMO_MAX_BYTES` UTF-8 bytes, no line breaks and no
 * hidden characters — the prompt shows it verbatim, so anything that could hide a second line or an
 * invisible payload is refused as `invalid-request`.
 */
export const tronMemoBytes = (memo: string): Uint8Array => {
  const bytes = utf8Encode.encode(memo);
  if (bytes.length === 0 || bytes.length > TRON_MEMO_MAX_BYTES) {
    throw new ChainError("invalid-request", `a memo is 1 to ${TRON_MEMO_MAX_BYTES} UTF-8 bytes`);
  }
  if (memo.includes("\n") || memo.includes("\r") || hasHiddenCharacters(memo)) {
    throw new ChainError(
      "invalid-request",
      "a memo must not contain newlines or hidden characters",
    );
  }
  return bytes;
};

const TRON_TYPE_BY_NAME: Readonly<Record<string, number>> = Object.fromEntries(
  TRON_CONTRACT_TYPES.map((t) => [t.name, t.id]),
);

export const buildTronRawData = (
  header: TronTransactionHeader,
  contract: TronContract,
): Uint8Array => {
  if (!/^[0-9a-fA-F]{64}$/.test(header.refBlock.id)) {
    throw new ChainError("invalid-request", "refBlock.id is not a 64-hex block id");
  }
  const id = hexToBytes(header.refBlock.id);
  const typeId = TRON_TYPE_BY_NAME[contract.type];
  if (typeId === undefined) {
    throw new ChainError("invalid-request", `${contract.type} has no contract type id`);
  }
  return encodeTronRawData({
    refBlockBytes: Uint8Array.of(
      Math.floor(header.refBlock.number / 256) % 256,
      header.refBlock.number % 256,
    ),
    refBlockHash: id.subarray(8, 16),
    expiration: BigInt(header.expiration),
    timestamp: BigInt(header.timestamp),
    ...(header.feeLimit === undefined ? {} : { feeLimit: header.feeLimit }),
    ...(header.memo === undefined ? {} : { memo: header.memo }),
    contract: {
      typeId,
      typeUrl: tronTypeUrl(contract.type),
      value: encodeTronContract(contract),
      permissionId: header.permissionId ?? 0,
      extra: [],
    },
    extra: [],
  });
};

const TRC20_TRANSFER = AbiFunction.from("function transfer(address to, uint256 amount)");
const TRC20_APPROVE = AbiFunction.from("function approve(address spender, uint256 amount)");

const triggerContract = (owner: string, token: string, data: Uint8Array): TronContract => ({
  type: "TriggerSmartContract",
  owner,
  contract: token,
  callValue: 0n,
  data,
  callTokenValue: 0n,
  tokenId: 0n,
});

/**
 * `transfer(address,uint256)` calldata on `token` — ABI addresses are the EVM form of the
 * T-address.
 */
export const trc20TransferContract = (
  owner: string,
  token: string,
  to: string,
  amount: bigint,
): TronContract =>
  triggerContract(
    owner,
    token,
    hexToBytes(AbiFunction.encodeData(TRC20_TRANSFER, [tronAddressToEvm(to), amount]).slice(2)),
  );

export const trc20ApproveContract = (
  owner: string,
  token: string,
  spender: string,
  amount: bigint,
): TronContract =>
  triggerContract(
    owner,
    token,
    hexToBytes(AbiFunction.encodeData(TRC20_APPROVE, [tronAddressToEvm(spender), amount]).slice(2)),
  );
