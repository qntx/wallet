import { getExtensionsDecoder, getExtensionsEncoder } from "@solana-program/token-2022";
import type { ExtensionArgs } from "@solana-program/token-2022";
import { address, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { EXT, netAfterTransferFee, parseMintExtensions } from "../src/solana/token2022.ts";
import type { MintExtensionSummary } from "../src/solana/token2022.ts";

const AUTH = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const DELEGATE = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const HOOK_PROGRAM = address("Stake11111111111111111111111111111111111111");

const TYPE_OFFSET = 165;
const tlv = (exts: ExtensionArgs[]): Uint8Array =>
  getExtensionsEncoder().encode(exts) as Uint8Array;

/** Frame a TLV region into a full mint account: 82-byte base + padding + type byte + TLV. */
const fullMint = (tlvBytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(TYPE_OFFSET + 1 + tlvBytes.length);
  out[TYPE_OFFSET] = 1;
  out.set(tlvBytes, TYPE_OFFSET + 1);
  return out;
};
const oracle = (data: Uint8Array) => getExtensionsDecoder().decode(data.subarray(TYPE_OFFSET + 1));
const addrBytes = (a: string): Uint8Array => getAddressEncoder().encode(address(a)) as Uint8Array;

const extensionOf = (data: Uint8Array, kind: string, idx = 0) => {
  const ext = oracle(data)[idx];
  if (ext === undefined || ext.__kind !== kind) {
    throw new Error(`oracle did not decode ${kind}`);
  }
  return ext;
};

const feeConfig = (data: Uint8Array) => {
  const ext = extensionOf(data, "TransferFeeConfig");
  if (ext.__kind !== "TransferFeeConfig") {
    throw new Error("unreachable");
  }
  return ext;
};

const hookExt = (data: Uint8Array) => {
  const ext = extensionOf(data, "TransferHook");
  if (ext.__kind !== "TransferHook") {
    throw new Error("unreachable");
  }
  return ext;
};

const delegateExt = (data: Uint8Array) => {
  const ext = extensionOf(data, "PermanentDelegate", 1);
  if (ext.__kind !== "PermanentDelegate") {
    throw new Error("unreachable");
  }
  return ext;
};

const SUMMARY_KEYS: ReadonlyArray<keyof MintExtensionSummary> = [
  "transferFee",
  "transferHook",
  "permanentDelegate",
  "nonTransferable",
  "confidential",
  "unknown",
];

const fieldOf = (s: MintExtensionSummary, k: keyof MintExtensionSummary): unknown => s[k];

describe("solana token-2022 mint extensions", () => {
  it("parses TransferFeeConfig and picks the current-epoch fee — oracle-checked", () => {
    const data = fullMint(
      tlv([
        {
          __kind: "TransferFeeConfig",
          transferFeeConfigAuthority: AUTH,
          withdrawWithheldAuthority: AUTH,
          withheldAmount: 7n,
          olderTransferFee: { epoch: 10n, maximumFee: 500n, transferFeeBasisPoints: 100 },
          newerTransferFee: { epoch: 20n, maximumFee: 1000n, transferFeeBasisPoints: 250 },
        },
      ]),
    );
    const ext = feeConfig(data);
    // Before the newer epoch activates, the older fee applies.
    const before = parseMintExtensions(data, 15n);
    expect(before.transferFee?.basisPoints).toBe(ext.olderTransferFee.transferFeeBasisPoints);
    expect(before.transferFee?.maximumFee).toBe(ext.olderTransferFee.maximumFee);
    // At/after activation, the newer fee applies.
    const after = parseMintExtensions(data, 20n);
    expect(after.transferFee?.basisPoints).toBe(ext.newerTransferFee.transferFeeBasisPoints);
    expect(after.transferFee?.maximumFee).toBe(ext.newerTransferFee.maximumFee);
  });

  it("flags NonTransferable — oracle-checked", () => {
    const data = fullMint(tlv([{ __kind: "NonTransferable" }]));
    expect(oracle(data)[0]?.__kind).toBe("NonTransferable");
    expect(parseMintExtensions(data, 0n).nonTransferable).toBe(true);
  });

  it("reads TransferHook and PermanentDelegate — oracle-checked", () => {
    const data = fullMint(
      tlv([
        { __kind: "TransferHook", authority: AUTH, programId: HOOK_PROGRAM },
        { __kind: "PermanentDelegate", delegate: DELEGATE },
      ]),
    );
    const hook = hookExt(data);
    const delegate = delegateExt(data);
    const ext = parseMintExtensions(data, 0n);
    expect(ext.transferHook?.programId).toStrictEqual(addrBytes(hook.programId));
    expect(ext.permanentDelegate?.delegate).toStrictEqual(addrBytes(delegate.delegate));
  });

  it("reports unhandled types by number — oracle-checked", () => {
    // InterestBearingConfig (type 10) is a mint extension this layer does not read.
    const data = fullMint(
      tlv([
        {
          __kind: "InterestBearingConfig",
          rateAuthority: AUTH,
          initializationTimestamp: 0,
          preUpdateAverageRate: 0,
          lastUpdateTimestamp: 0,
          currentRate: 0,
        },
        { __kind: "NonTransferable" },
      ]),
    );
    expect(oracle(data)[0]?.__kind).toBe("InterestBearingConfig");
    const ext = parseMintExtensions(data, 0n);
    expect(ext.unknown).toStrictEqual([10]);
    expect(ext.nonTransferable).toBe(true);
  });

  it("returns only defined summary fields for a bare mint region", () => {
    const ext = parseMintExtensions(new Uint8Array(0), 0n);
    for (const k of SUMMARY_KEYS) {
      expect(fieldOf(ext, k)).toBeUndefined();
    }
  });

  it("stops at the Uninitialized marker and ignores trailing space", () => {
    const tlv16 = new Uint8Array(16);
    const v = new DataView(tlv16.buffer);
    v.setUint16(0, EXT.nonTransferable, true);
    v.setUint16(2, 0, true);
    const data = fullMint(tlv16);
    // bytes 4-5: Uninitialized (type 0) — the rest is unused space.
    expect(parseMintExtensions(data, 0n).nonTransferable).toBe(true);
  });

  it("rejects a truncated extension body", () => {
    const truncated = fullMint(new Uint8Array([1, 0, 10, 0, 0]));
    expect(() => parseMintExtensions(truncated, 0n)).toThrow(/truncated/);
  });

  it("computes the post-fee net amount", () => {
    expect(netAfterTransferFee(1000n, 100, 500n)).toBe(990n);
    expect(netAfterTransferFee(1_000_000n, 500, 100n)).toBe(999_900n);
    expect(netAfterTransferFee(10n, 0, 0n)).toBe(10n);
  });
});
