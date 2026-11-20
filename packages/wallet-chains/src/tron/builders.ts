import { hexToBytes } from "@noble/hashes/utils.js";
/**
 * Pure TRON transaction builders — no clock, no I/O; the caller supplies the block reference and
 * times. `ref_block_bytes` is the block number's low two bytes big-endian and `ref_block_hash`
 * bytes 8..16 of the block id (tronweb AbstractTrx.ts:1108-1121) — together they pin the
 * transaction to a recent block on exactly one network.
 */
import * as AbiFunction from "ox/AbiFunction";

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
