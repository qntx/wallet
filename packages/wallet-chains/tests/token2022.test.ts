import { describe, expect, it } from "vite-plus/test";

import { EXT, netAfterTransferFee, parseMintExtensions } from "../src/solana/token2022.ts";

// The TLV body only — a mint's extensions follow the 82-byte base + the account-type byte.
const tlv = (type: number, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + body.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, type, true);
  v.setUint16(2, body.length, true);
  out.set(body, 4);
  return out;
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("solana token-2022 mint extensions", () => {
  it("parses TransferFeeConfig into the current-epoch fee", () => {
    // COption<Pubkey> ×2 (36 B each) + u64 withheld + older fee (18) + newer fee (18).
    const body = new Uint8Array(116);
    const v = new DataView(body.buffer);
    v.setBigUint64(72, 0n, true); // withheld
    // older: epoch 10, bps 100, max 500
    v.setBigUint64(80, 10n, true);
    v.setUint16(88, 100, true);
    v.setBigUint64(90, 500n, true);
    // newer: epoch 20, bps 250, max 1_000
    v.setBigUint64(98, 20n, true);
    v.setUint16(106, 250, true);
    v.setBigUint64(108, 1000n, true);
    const ext = parseMintExtensions(tlv(EXT.transferFeeConfig, body), 15n);
    expect(ext.transferFee?.basisPoints).toBe(100);
    expect(ext.transferFee?.maximumFee).toBe(500n);
    const at20 = parseMintExtensions(tlv(EXT.transferFeeConfig, body), 20n);
    expect(at20.transferFee?.basisPoints).toBe(250);
    expect(at20.transferFee?.maximumFee).toBe(1000n);
  });

  it("flags NonTransferable and marks unknown types", () => {
    const data = concat(tlv(EXT.nonTransferable, new Uint8Array(0)), tlv(99, new Uint8Array([1])));
    const ext = parseMintExtensions(data, 0n);
    expect(ext.nonTransferable).toBe(true);
    expect(ext.unknown).toStrictEqual([99]);
  });

  it("reads PermanentDelegate and TransferHook program ids", () => {
    const delegate = new Uint8Array(36);
    new DataView(delegate.buffer).setUint32(0, 1, true); // Some
    delegate.fill(0xaa, 4, 36);
    const hook = new Uint8Array(68);
    new DataView(hook.buffer).setUint32(0, 1, true);
    hook.fill(0xbb, 36, 68);
    const ext = parseMintExtensions(
      concat(tlv(EXT.permanentDelegate, delegate), tlv(EXT.transferHook, hook)),
      0n,
    );
    expect(ext.permanentDelegate?.delegate[0]).toBe(0xaa);
    expect(ext.transferHook?.programId[0]).toBe(0xbb);
  });

  it("rejects a truncated extension body", () => {
    expect(() => parseMintExtensions(new Uint8Array([1, 0, 10, 0, 0]), 0n)).toThrow(/truncated/);
  });

  it("computes the post-fee net amount", () => {
    expect(netAfterTransferFee(1000n, 100, 500n)).toBe(990n);
    expect(netAfterTransferFee(1_000_000n, 500, 100n)).toBe(999_900n);
    expect(netAfterTransferFee(10n, 0, 0n)).toBe(10n);
  });
});
