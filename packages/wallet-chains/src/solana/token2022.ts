import { ChainError } from "../index.ts";

/** SPL Token-2022 mint-account TLV extension type numbers (spl-token-2022 `ExtensionType`). */
export const EXT = {
  confidentialTransferMint: 2,
  confidentialTransferFeeConfig: 3,
  transferFeeConfig: 1,
  transferHook: 5,
  permanentDelegate: 7,
  nonTransferable: 9,
  defaultAccountState: 10,
  cpiGuard: 11,
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
const u32 = (v: Uint8Array): number => new DataView(v.buffer, v.byteOffset, 4).getUint32(0, true);
const u16 = (v: Uint8Array): number => new DataView(v.buffer, v.byteOffset, 2).getUint16(0, true);

/**
 * Parse the TLV extension region of a Token-2022 mint account (after the 82-byte mint base and its
 * optional account-type byte). Each entry is `u16 type, u16 len, len bytes` — the same layout
 * spl-token-2022 uses. Returns a typed summary; extensions this layer does not read are reported by
 * type number in `unknown` rather than parsed.
 */
export const parseMintExtensions = (data: Uint8Array, epoch: bigint): MintExtensionSummary => {
  if (data.length < 4) {
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
  while (offset + 4 <= data.length) {
    const type = u16(data.subarray(offset, offset + 2));
    const len = u16(data.subarray(offset + 2, offset + 4));
    offset += 4;
    if (offset + len > data.length) {
      throw new ChainError("invalid-request", `mint extension ${type} truncated`);
    }
    const body = data.subarray(offset, offset + len);
    offset += len;
    if (type === EXT.transferFeeConfig && len >= 116) {
      // Layout: COption<Pubkey>×2 (36 B each) + u64 withheld + TransferFee×2 (18 B each:
      // u64 epoch + u16 bps + u64 max). The current-epoch fee is the "newer" record once its
      // activation epoch is reached, else the "older" one.
      const olderBps = u16(body.subarray(80 + 8));
      const olderMax = u64(body.subarray(80 + 10));
      const newerEpoch = u64(body.subarray(98));
      const newerBps = u16(body.subarray(98 + 8));
      const newerMax = u64(body.subarray(98 + 10));
      const active =
        newerEpoch <= epoch ? { bps: newerBps, max: newerMax } : { bps: olderBps, max: olderMax };
      if (active.bps !== 0 || active.max !== 0n) {
        out.transferFee = { basisPoints: active.bps, maximumFee: active.max };
      }
    } else if (type === EXT.transferHook && len >= 68) {
      // COption<Pubkey> authority (36) + program id (32).
      const programId = body.subarray(36, 68);
      if (programId.length === 32) {
        out.transferHook = { programId };
      }
    } else if (type === EXT.permanentDelegate && len >= 36) {
      if (u32(body.subarray(0, 4)) !== 0) {
        out.permanentDelegate = { delegate: body.subarray(4, 36) };
      }
    } else if (type === EXT.nonTransferable) {
      out.nonTransferable = true;
    } else if (
      type === EXT.confidentialTransferMint ||
      type === EXT.confidentialTransferFeeConfig
    ) {
      out.confidential = true;
    } else if (type !== 0) {
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
