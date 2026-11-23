/**
 * TRON signing over the OneKey V1 schema. The device does not sign the host's raw_data: it rebuilds
 * it from the TronSignTx fields, substituting its own derived owner address (firmware-pro
 * core/src/apps/tron/serialize.py serialize/pack_contract, firmware-classic1s
 * legacy/firmware/tron.c serialize/pack_contract), and echoes the rebuild in
 * `TronSignedTx.serialized_tx`. So the client maps only the shapes the firmware can reproduce
 * byte-for-byte and then requires the echo to equal the request — a mismatch means the signed
 * digest covers a transaction other than the one asked for.
 */
import { ChainError } from "@qntx/wallet-chains";
import {
  decodeTronContract,
  decodeTronRawData,
  tronAddressFromPublicKey,
} from "@qntx/wallet-chains/tron";
import type { TronContract as ChainsContract, TronRawData } from "@qntx/wallet-chains/tron";

import { supports } from "./device.ts";
import type { DeviceInfo } from "./device.ts";
import { OneKeyError } from "./errors.ts";
import { TronMessageSignature, TronSignedTx, TronSignMessage, TronSignTx } from "./messages.ts";
import type { TronContractFields, TronSignTxFields } from "./messages.ts";
import type { Decoded } from "./proto.ts";
import { call } from "./session.ts";
import type { Exchange } from "./session.ts";

const fault = (message: string): OneKeyError => new OneKeyError("device-fault", message);
const invalid = (message: string): OneKeyError => new OneKeyError("invalid-input", message);
const unsupported = (message: string): OneKeyError => new OneKeyError("unsupported", message);

const UINT32_MAX = 0xff_ff_ff_ff;

function checkPath(path: ReadonlyArray<number>): void {
  if (path.length === 0) {
    throw invalid("derivation path is empty");
  }
}

type WireContract = Decoded<TronContractFields>;
type WireTx = Decoded<TronSignTxFields>;

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/*
 * The rebuild rules, field by field (serialize.py pack_contract / tron.c pack_contract — identical
 * on both firmwares): the contract value is rewritten with the device's owner at field 1; varint
 * fields the firmware writes unconditionally (transfer amount, vote count, freeze/unfreeze v2
 * balances, delegate/undelegate balance) must be non-zero in the input or the input's canonical
 * encoding — which omits zero — cannot equal the rebuild; fields the firmware gates on presence
 * or truthiness (support, call_value, resource, lock, lock_period, call_token_value+asset_id) are
 * sent only when non-default. TriggerSmartContract additionally needs `data` on both firmwares
 * (Classic refuses has_data=false or size<4 with "Invalid TRON contract call data"; Pro writes
 * field 4 unconditionally).
 */
function mapContract(contract: ChainsContract): WireContract {
  switch (contract.type) {
    case "TransferContract":
      if (contract.amount === 0n) {
        throw unsupported("zero-amount transfer cannot be rebuilt by the device");
      }
      return { transferContract: { toAddress: contract.to, amount: contract.amount } };
    case "VoteWitnessContract":
      for (const vote of contract.votes) {
        if (vote.count === 0n || vote.count > BigInt(UINT32_MAX)) {
          throw unsupported("vote count the device cannot rebuild");
        }
      }
      return {
        voteWitnessContract: {
          votes: contract.votes.map((v) => ({
            voteAddress: v.witness,
            voteCount: Number(v.count),
          })),
          ...(contract.support ? { support: true } : {}),
        },
      };
    case "WithdrawBalanceContract":
      return { withdrawBalanceContract: {} };
    case "TriggerSmartContract":
      if (contract.data.length < 4) {
        throw unsupported("contract call data under 4 bytes");
      }
      if (contract.callTokenValue === 0n && contract.tokenId !== 0n) {
        throw unsupported("token id without a call token value cannot be rebuilt by the device");
      }
      return {
        triggerSmartContract: {
          contractAddress: contract.contract,
          ...(contract.callValue === 0n ? {} : { callValue: contract.callValue }),
          data: contract.data,
          ...(contract.callTokenValue === 0n
            ? {}
            : { callTokenValue: contract.callTokenValue, assetId: contract.tokenId }),
        },
      };
    case "FreezeBalanceV2Contract":
      if (contract.amount === 0n) {
        throw unsupported("zero freeze balance cannot be rebuilt by the device");
      }
      return {
        freezeBalanceV2Contract: {
          frozenBalance: contract.amount,
          ...(contract.resource === 0 ? {} : { resource: contract.resource }),
        },
      };
    case "UnfreezeBalanceV2Contract":
      if (contract.amount === 0n) {
        throw unsupported("zero unfreeze balance cannot be rebuilt by the device");
      }
      return {
        unfreezeBalanceV2Contract: {
          unfreezeBalance: contract.amount,
          ...(contract.resource === 0 ? {} : { resource: contract.resource }),
        },
      };
    case "WithdrawExpireUnfreezeContract":
      return { withdrawExpireUnfreezeContract: {} };
    case "DelegateResourceContract":
      if (contract.balance === 0n) {
        throw unsupported("zero delegate balance cannot be rebuilt by the device");
      }
      return {
        delegateResourceContract: {
          ...(contract.resource === 0 ? {} : { resource: contract.resource }),
          balance: contract.balance,
          receiverAddress: contract.receiver,
          ...(contract.lock ? { lock: true } : {}),
          ...(contract.lockPeriod === 0n ? {} : { lockPeriod: contract.lockPeriod }),
        },
      };
    case "UnDelegateResourceContract":
      if (contract.balance === 0n) {
        throw unsupported("zero undelegate balance cannot be rebuilt by the device");
      }
      return {
        undelegateResourceContract: {
          ...(contract.resource === 0 ? {} : { resource: contract.resource }),
          balance: contract.balance,
          receiverAddress: contract.receiver,
        },
      };
    case "CancelAllUnfreezeV2Contract":
      return { cancelAllUnfreezeV2Contract: {} };
    default:
      throw unsupported(`contract type ${contract.type} is not in the firmware contract set`);
  }
}

function mapTx(raw: TronRawData, publicKey: Uint8Array): WireTx {
  // serialize() drops every raw_data field it does not model (ref_block_num, auths, scripts,
  // unknown fields) and re-emits contract extras only for provider/contract_name/permission_id —
  // anything else makes the rebuild differ from the request, so refuse before the exchange.
  if (raw.extra.length > 0) {
    throw unsupported("raw_data carries fields the device cannot rebuild");
  }
  if (raw.timestamp === undefined || raw.timestamp === 0n) {
    throw unsupported("raw_data without a timestamp cannot be rebuilt by the device");
  }
  let provider: Uint8Array | undefined;
  let contractName: Uint8Array | undefined;
  for (const extra of raw.contract.extra) {
    if (
      extra.wire === 2 &&
      extra.data !== undefined &&
      extra.field === 3 &&
      provider === undefined
    ) {
      provider = extra.data;
    } else if (
      extra.wire === 2 &&
      extra.data !== undefined &&
      extra.field === 4 &&
      contractName === undefined
    ) {
      contractName = extra.data;
    } else {
      throw unsupported("contract carries fields the device cannot rebuild");
    }
  }
  const decoded = decodeTronContract(raw.contract.typeId, raw.contract.value);
  if (decoded === undefined) {
    throw unsupported(`contract type id ${raw.contract.typeId} cannot be mapped for the device`);
  }
  if (decoded.extra.length > 0) {
    throw unsupported("contract value carries fields the device cannot rebuild");
  }
  // The firmware substitutes the owner derived from its own key (sign_tx.py /
  // tron.c fill owner_address from the signing node), so a foreign-owner request would be
  // confirmed by the user and then never verify — refuse before the exchange, after the
  // contract-type check so an unmodeled type still reports `unsupported`.
  const contract = mapContract(decoded.contract);
  if (decoded.contract.owner !== tronAddressFromPublicKey(publicKey)) {
    throw invalid("contract owner does not match the signing key");
  }
  return {
    refBlockBytes: raw.refBlockBytes,
    refBlockHash: raw.refBlockHash,
    expiration: raw.expiration,
    ...(raw.memo === undefined ? {} : { data: raw.memo }),
    contract: {
      ...contract,
      ...(provider === undefined ? {} : { provider }),
      ...(contractName === undefined ? {} : { contractName }),
      ...(raw.contract.permissionId === 0 ? {} : { permissionId: raw.contract.permissionId }),
    },
    timestamp: raw.timestamp,
    ...(raw.feeLimit === undefined || raw.feeLimit === 0n ? {} : { feeLimit: raw.feeLimit }),
  };
}

/**
 * Sign a TRON transaction from its `Transaction.raw` bytes. The bytes must decode canonically
 * (`decodeTronRawData`) and be one the firmware can rebuild exactly; the device's `serialized_tx`
 * echo must then equal the request byte-for-byte.
 */
// The full pre-exchange decision shared with tronDisplay: decode, rebuild-restrictions and the
// owner check. Throws `unsupported` for shapes the device cannot rebuild and `invalid-input` for
// malformed bytes or a foreign owner.
function tronPrepare(
  rawData: Uint8Array,
  publicKey: Uint8Array,
): { value: WireTx; typeId: number } {
  let raw: TronRawData;
  try {
    raw = decodeTronRawData(rawData);
  } catch (error) {
    if (error instanceof ChainError) {
      throw invalid(`malformed tron raw_data: ${error.message}`);
    }
    throw error;
  }
  let value: WireTx;
  try {
    value = mapTx(raw, publicKey);
  } catch (error) {
    if (error instanceof ChainError) {
      throw invalid(`malformed tron contract: ${error.message}`);
    }
    throw error;
  }
  return { value, typeId: raw.contract.typeId };
}

export async function signTronTransaction(
  exchange: Exchange,
  path: ReadonlyArray<number>,
  rawData: Uint8Array,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  checkPath(path);
  const { value } = tronPrepare(rawData, publicKey);
  const request: Decoded<TronSignTxFields> = { addressN: [...path], ...value };
  const response = await call(exchange, { def: TronSignTx, value: request }, TronSignedTx);
  if (response.signature.length !== 65) {
    throw fault("tron signature is not 65 bytes");
  }
  if (response.serializedTx === undefined || !equalBytes(response.serializedTx, rawData)) {
    throw fault("device signed a different transaction than requested");
  }
  return response.signature.slice(0, 64);
}

/**
 * Sign a TRON message (TronMessageType V2 — the raw-message digest keccak("\x19TRON Signed
 * Message:\n" + len + message), identical on both firmwares: sign_message.py make_message_digest,
 * tron.c tron_message_hash). Gated by firmware support.
 */
export async function signTronMessage(
  exchange: Exchange,
  info: DeviceInfo,
  path: ReadonlyArray<number>,
  message: Uint8Array,
): Promise<Uint8Array> {
  checkPath(path);
  if (!supports(info, "tron-message-v2")) {
    throw unsupported("firmware does not sign TRON V2 messages");
  }
  const response = await call(
    exchange,
    { def: TronSignMessage, value: { addressN: [...path], message, messageType: 2 } },
    TronMessageSignature,
  );
  if (response.signature.length !== 65) {
    throw fault("tron message signature is not 65 bytes");
  }
  return response.signature.slice(0, 64);
}

export type TronDisplayRequest =
  | { readonly kind: "tron.transaction"; readonly rawData: Uint8Array }
  | { readonly kind: "tron.message" }
  | { readonly kind: "tron.typed-data" };

// Contract type ids whose fields both firmwares render in full (sign_tx.py
// _require_confirm_by_type, tron.c tron_sign_tx layouts): transfer, vote, withdraw, freeze/
// unfreeze v1 and v2, delegate/undelegate, withdraw-expire, cancel-all. TriggerSmartContract (31)
// stays blind: Pro blind-signs everything except a recognised-token TRC-20 transfer
// (confirm_blind_sign_common), and the Classic 1S recognises TRC-20 transfer only, falling back
// to layoutBlindSign for approvals and unknown tokens.
const CLEAR_CONTRACTS: ReadonlySet<number> = new Set([1, 4, 11, 12, 13, 54, 55, 56, 57, 58, 59]);

/**
 * "clear" when the device renders the request's semantics. A transaction is clear only for the
 * contract types both firmwares lay out field-by-field; a message is clear (both show it, as text
 * or a hex dump); typed data has no OneKey message.
 */
export function tronDisplay(
  request: TronDisplayRequest,
  publicKey: Uint8Array,
): "clear" | "blind" | "unsupported" {
  if (request.kind === "tron.typed-data") {
    throw unsupported("firmware has no TRON typed-data message");
  }
  if (request.kind === "tron.message") {
    return "clear";
  }
  let typeId: number;
  try {
    ({ typeId } = tronPrepare(request.rawData, publicKey));
  } catch (error) {
    if (error instanceof OneKeyError) {
      return error.code === "unsupported" ? "unsupported" : "blind";
    }
    throw error;
  }
  return CLEAR_CONTRACTS.has(typeId) ? "clear" : "blind";
}
