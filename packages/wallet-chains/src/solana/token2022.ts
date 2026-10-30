import { ChainError } from "../index.ts";

/** SPL Token-2022 mint-account TLV extension type numbers (spl-token-2022 `ExtensionType`). */
export const EXT = {
  transferFeeConfig: 1,
  confidentialTransferMint: 4,
  defaultAccountState: 6,
  nonTransferable: 9,
  cpiGuard: 11,
  permanentDelegate: 12,
  transferHook: 14,
  confidentialTransferFee: 16,
  confidentialTransferFeeAmount: 17,
} as const;

export type MintExtensionSummary = {
  /** The current-epoch fee from TransferFeeConfig (basis points and the maximum fee), if set. */
  readonly transferFee?: { readonly basisPoints: number; readonly maximumFee: bigint };
  readonly transferHook?: { readonly programId: Uint8Array };
  readonly permanentDelegate?: { readonly delegate: Uint8Array };
  readonly nonTransferable?: boolean;
  /** True when a ConfidentialTransfer extension is present — confidential amounts are not supported. */
  readonly confidential?: boolean;
  /** Extension type numbers we do not parse (informational). */
  readonly unknown?: ReadonlyArray<number>;
};

const u64 = (v: Uint8Array): bigint =>
  new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true);
const u16 = (v: Uint8Array): number => new DataView(v.buffer, v.byteOffset, 2).getUint16(0, true);

/**
 * Parse the TLV extension region of a Token-2022 mint account (after the 82-byte mint base and its
 * optional account-type byte). Each entry is `u16 type, u16 len, len bytes` — the same layout
 * spl-token-2022 uses. Returns a typed summary; extensions this layer does not read are reported by
 * type number in `unknown` rather than parsed.
 */
export const parseMintExtensions = (data: Uint8Array, epoch: bigint): MintExtensionSummary => {
  if (data.length < 2) {
    return {};
  }
  const out: {
    transferFee?: { basisPoints: number; maximumFee: bigint };
    transferHook?: { programId: Uint8Array };
    permanentDelegate?: { delegate: Uint8Array };
    nonTransferable?: boolean;
    confidential?: boolean;
    unknown: number[];
  } = { unknown: [] };
  let offset = 0;
  while (offset + 2 <= data.length) {
    const type = u16(data.subarray(offset, offset + 2));
    // Uninitialized entries are a u16 marker only — the program stops scanning there and
    // treats the rest as unused space.
    if (type === 0) {
      break;
    }
    if (offset + 4 > data.length) {
      throw new ChainError("invalid-request", `mint extension ${type} truncated`);
    }
    const len = u16(data.subarray(offset + 2, offset + 4));
    offset += 4;
    if (offset + len > data.length) {
      throw new ChainError("invalid-request", `mint extension ${type} truncated`);
    }
    const body = data.subarray(offset, offset + len);
    offset += len;
    if (type === EXT.transferFeeConfig && len >= 108) {
      // OptionalNonZeroPubkey×2 (32 B each, zero = none) + u64 withheld + TransferFee×2
      // (18 B each: u64 epoch + u64 maximumFee + u16 basisPoints). The current-epoch fee is
      // the "newer" record once its activation epoch is reached, else the "older" one.
      const olderMax = u64(body.subarray(80));
      const olderBps = u16(body.subarray(88));
      const newerEpoch = u64(body.subarray(90));
      const newerMax = u64(body.subarray(98));
      const newerBps = u16(body.subarray(106));
      const active =
        newerEpoch <= epoch ? { bps: newerBps, max: newerMax } : { bps: olderBps, max: olderMax };
      if (active.bps !== 0 || active.max !== 0n) {
        out.transferFee = { basisPoints: active.bps, maximumFee: active.max };
      }
    } else if (type === EXT.transferHook && len >= 64) {
      // OptionalNonZeroPubkey authority (32) + program id (32).
      const programId = body.subarray(32, 64);
      out.transferHook = { programId };
    } else if (type === EXT.permanentDelegate && len >= 32) {
      // OptionalNonZeroPubkey delegate (32) — all-zero means none.
      const delegate = body.subarray(0, 32);
      if (delegate.some((b) => b !== 0)) {
        out.permanentDelegate = { delegate };
      }
    } else if (type === EXT.nonTransferable) {
      out.nonTransferable = true;
    } else if (
      type === EXT.confidentialTransferMint ||
      type === EXT.confidentialTransferFee ||
      type === EXT.confidentialTransferFeeAmount
    ) {
      out.confidential = true;
    } else {
      out.unknown.push(type);
    }
  }
  return out.unknown.length === 0 ? out : { ...out, unknown: out.unknown };
};

/**
 * Net amount a recipient gets after the current-epoch transfer fee, `amt − min(amt*bps/10000,
 * max)`.
 */
export const netAfterTransferFee = (amount: bigint, bps: number, max: bigint): bigint => {
  const fee = (amount * BigInt(bps)) / 10_000n;
  return amount - (fee > max ? max : fee);
};
