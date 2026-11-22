/**
 * Raydium AMM v4/CLMM/CPMM and Orca Whirlpool swap decoders: every documented shape describes the
 * signer's worst case, and every near miss — wrong data length, account count, signer slot, token
 * program, an explicit price limit on an exact-out, truncated remaining accounts — falls back to
 * the program-authority outcome the instruction had before.
 */
import { address, getAddressDecoder } from "@solana/addresses";
import { AccountRole } from "@solana/kit";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  METEORA_DLMM_PROGRAM,
  RAYDIUM_AMM_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  WHIRLPOOL_PROGRAM,
} from "../src/solana/amm.ts";
import { associatedTokenAddress } from "../src/solana/ata.ts";
import { decodeSolana } from "../src/solana/index.ts";
import { parseCompiledMessage } from "../src/solana/message.ts";

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SIGNER = "9nXDunV8eNvYSVys7JSBkm2hz9Q79Q3EYeko19srVeMC";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const WSOL = "So11111111111111111111111111111111111111112";
const BLOCKHASH = "11111111111111111111111111111111";

const decoder = getAddressDecoder();
const rand = (seed: number): string => {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed * (i + 1) * 31 + i) % 256;
  }
  return decoder.decode(bytes);
};
const ACC = (i: number): string => rand(i + 3);

type Meta = readonly [address: string, role: AccountRole];
const ro = (a: string): Meta => [a, AccountRole.READONLY];
const w = (a: string): Meta => [a, AccountRole.WRITABLE];
const rs = (a: string): Meta => [a, AccountRole.READONLY_SIGNER];

const ix = (program: string, accounts: ReadonlyArray<Meta>, data: Uint8Array) => ({
  programAddress: address(program),
  accounts: accounts.map(([a, role]) => ({ address: address(a), role })),
  data,
});

const compile = (instructions: ReadonlyArray<unknown>, version: 0 | 1 = 0): Uint8Array => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: address(BLOCKHASH), lastValidBlockHeight: 1000n } as never,
    setTransactionMessageFeePayer(address(SIGNER), createTransactionMessage({ version })),
  );
  for (const i of instructions) {
    message = appendTransactionMessageInstruction(i as never, message as never);
  }
  return new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message as never)),
  );
};

const u64le = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const cat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
};

const intentOf = (instructions: ReadonlyArray<unknown>, version: 0 | 1 = 0) =>
  decodeSolana(
    {
      kind: "solana.transaction",
      network: MAINNET,
      account: ACCOUNT,
      message: compile(instructions, version),
    },
    SIGNER,
  );

const anchor = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

/* Pool-side accounts — any addresses; their content never enters the intent. */

/** AMM v4 metas: token program, pool accounts, then source, destination, owner last. */
const ammV4Metas = (
  n: number,
  source = ACC(30),
  destination = ACC(31),
  owner: string = SIGNER,
): Meta[] => {
  const metas: Meta[] = [ro(TOKEN)];
  for (let i = 1; i < n - 3; i++) {
    metas.push(w(ACC(i)));
  }
  metas.push(w(source), w(destination), rs(owner));
  return metas;
};

const ammV4Data = (tag: number, a: bigint, b: bigint): Uint8Array =>
  cat(Uint8Array.of(tag), u64le(a), u64le(b));

/* CPMM metas: payer, authority, config, pool, in, out, vaults, programs, mints, observation. */
const cpmmMetas = (source = ACC(30), destination = ACC(31), payer: string = SIGNER): Meta[] => [
  rs(payer),
  ro(ACC(1)),
  ro(ACC(2)),
  w(ACC(3)),
  w(source),
  w(destination),
  w(ACC(6)),
  w(ACC(7)),
  ro(TOKEN),
  ro(TOKEN22),
  ro(OTHER_MINT),
  ro(USDC),
  w(ACC(12)),
];

const BASE_IN = anchor("8fbe5adac41e33de");
const BASE_OUT = anchor("37d96256a34ab4ad");
const SWAP_V2 = anchor("2b04ed0b1ac91e62");

/* CLMM metas: payer, config, pool, in, out, vaults, observation, token, token2022, memo, mints. */
const clmmMetas = (n: number, source = ACC(30), destination = ACC(31)): Meta[] => {
  const metas: Meta[] = [
    rs(SIGNER),
    ro(ACC(1)),
    w(ACC(2)),
    w(source),
    w(destination),
    w(ACC(5)),
    w(ACC(6)),
    w(ACC(7)),
    ro(TOKEN),
    ro(TOKEN22),
    ro(MEMO),
    ro(WSOL),
    ro(OTHER_MINT),
  ];
  for (let i = metas.length; i < n; i++) {
    metas.push(w(ACC(i + 40)));
  }
  return metas;
};

const clmmData = (
  amount: bigint,
  threshold: bigint,
  limit: bigint,
  baseInput: number,
): Uint8Array =>
  cat(SWAP_V2, u64le(amount), u64le(threshold), u64le(limit), u64le(0n), Uint8Array.of(baseInput));

/* Whirlpool metas: programs, memo, authority, pool, mints, owners, vaults, ticks, oracle. */
const whirlpoolMetas = (n: number, ownerA = ACC(30), ownerB = ACC(31)): Meta[] => {
  const metas: Meta[] = [
    ro(TOKEN),
    ro(TOKEN22),
    ro(MEMO),
    rs(SIGNER),
    w(ACC(4)),
    ro(WSOL),
    ro(USDC),
    w(ownerA),
    w(ACC(8)),
    w(ownerB),
    w(ACC(10)),
    w(ACC(11)),
    w(ACC(12)),
    w(ACC(13)),
    ro(ACC(14)),
  ];
  for (let i = metas.length; i < n; i++) {
    metas.push(ro(ACC(i + 40)));
  }
  return metas;
};

const whirlpoolData = (
  amount: bigint,
  threshold: bigint,
  limit: bigint,
  isInput: number,
  aToB: number,
  remaining: Uint8Array,
): Uint8Array =>
  cat(
    SWAP_V2,
    u64le(amount),
    u64le(threshold),
    u64le(limit),
    u64le(0n),
    Uint8Array.of(isInput, aToB),
    remaining,
  );

const NONE = Uint8Array.of(0);
const SOME = cat(Uint8Array.of(1), u64le(1n).subarray(0, 4), Uint8Array.of(6, 2));

const hasAuthority = (intent: ReturnType<typeof intentOf>, program: string): boolean =>
  intent.programAuthority?.some((e) => e.program === program) === true;

describe("Raydium AMM v4", () => {
  it("tag 9 with 17 and 18 accounts describes the swap in token-account units", () => {
    for (const n of [17, 18]) {
      const intent = intentOf([ix(RAYDIUM_AMM_PROGRAM, ammV4Metas(n), ammV4Data(9, 5000n, 100n))]);
      expect(intent.summary).toBe("swap");
      expect(intent.outflows[0]).toMatchObject({
        to: RAYDIUM_AMM_PROGRAM,
        amount: { asset: ACC(30), amount: "5000" },
        tokenAccount: ACC(30),
        verified: false,
      });
      expect(intent.minimumReceived?.[0]).toStrictEqual({
        to: ACC(31),
        amount: { asset: ACC(31), amount: "100" },
        tokenAccount: ACC(31),
      });
    }
  });

  it("tag 11 falls back (no mainnet fixture); tags 16/17 take the 8-account form", () => {
    const tag11 = intentOf([ix(RAYDIUM_AMM_PROGRAM, ammV4Metas(18), ammV4Data(11, 5000n, 100n))]);
    expect(hasAuthority(tag11, RAYDIUM_AMM_PROGRAM)).toBe(true);

    for (const tag of [16, 17]) {
      const metas: Meta[] = [
        ro(TOKEN),
        w(ACC(1)),
        ro(ACC(2)),
        w(ACC(3)),
        w(ACC(4)),
        w(ACC(30)),
        w(ACC(31)),
        rs(SIGNER),
      ];
      const again = intentOf([ix(RAYDIUM_AMM_PROGRAM, metas, ammV4Data(tag, 5000n, 100n))]);
      expect(again.summary).toBe("swap");
      expect(again.outflows[0]?.amount).toMatchObject({ amount: "5000" });
      expect(again.minimumReceived?.[0]?.amount).toMatchObject({ amount: "100" });
    }
  });

  it("shows the mint when source/destination are the signer's ATAs of a table token", () => {
    const usdcAta = associatedTokenAddress(SIGNER, USDC, TOKEN);
    const intent = intentOf([
      ix(RAYDIUM_AMM_PROGRAM, ammV4Metas(17, usdcAta, ACC(31)), ammV4Data(9, 5000n, 100n)),
    ]);
    expect(intent.outflows[0]?.amount).toMatchObject({
      asset: USDC,
      symbol: "USDC",
      amount: "5000",
    });
    expect(intent.outflows[0]?.verified).toBe(true);

    /* The destination being the signer's own USDC ATA lands the minimum at the signer. */
    const back = intentOf([
      ix(RAYDIUM_AMM_PROGRAM, ammV4Metas(17, ACC(30), usdcAta), ammV4Data(9, 5000n, 100n)),
    ]);
    expect(back.minimumReceived?.[0]).toMatchObject({
      to: SIGNER,
      amount: { asset: USDC, symbol: "USDC", amount: "100" },
    });
  });

  const shortMetas: Meta[] = [
    ro(TOKEN),
    ...Array.from({ length: 12 }, (_, i) => w(ACC(i + 1))),
    w(ACC(30)),
    w(ACC(31)),
    rs(SIGNER),
  ];

  it.each([
    ["truncated data", ammV4Data(9, 5n, 1n).subarray(0, 16), ammV4Metas(17)],
    ["a trailing byte", cat(ammV4Data(9, 5n, 1n), Uint8Array.of(0)), ammV4Metas(17)],
    ["a 16-account tag 9", ammV4Data(9, 5n, 1n), shortMetas],
    ["a 9-account tag 16", ammV4Data(16, 5n, 1n), [...ammV4Metas(18).slice(0, 8), rs(SIGNER)]],
  ])("falls back for %s", (_name, data, metas) => {
    const intent = intentOf([ix(RAYDIUM_AMM_PROGRAM, metas, data)]);
    expect(hasAuthority(intent, RAYDIUM_AMM_PROGRAM)).toBe(true);
  });

  it("falls back when the signer is not in the owner slot or the token program is wrong", () => {
    const metas: Meta[][] = [
      /* The signer is still in the ix but a different account sits in the owner slot. */
      ammV4Metas(17, SIGNER, ACC(31), ACC(40)),
      [w(TOKEN22), ...ammV4Metas(17).slice(1)],
    ];
    for (const m of metas) {
      const intent = intentOf([ix(RAYDIUM_AMM_PROGRAM, m, ammV4Data(9, 5n, 1n))]);
      expect(hasAuthority(intent, RAYDIUM_AMM_PROGRAM)).toBe(true);
    }
  });
});

describe("Raydium CPMM", () => {
  it("swap_base_input describes the bounds", () => {
    const intent = intentOf([
      ix(RAYDIUM_CPMM_PROGRAM, cpmmMetas(), cat(BASE_IN, u64le(5000n), u64le(100n))),
    ]);
    expect(intent.summary).toBe("swap");
    expect(intent.outflows[0]?.amount).toMatchObject({ asset: OTHER_MINT, amount: "5000" });
    expect(intent.minimumReceived?.[0]?.amount).toMatchObject({ asset: USDC, amount: "100" });
  });

  it("swap_base_output falls back (no mainnet fixture)", () => {
    const out = intentOf([
      ix(RAYDIUM_CPMM_PROGRAM, cpmmMetas(), cat(BASE_OUT, u64le(5000n), u64le(100n))),
    ]);
    expect(hasAuthority(out, RAYDIUM_CPMM_PROGRAM)).toBe(true);
  });

  it("falls back on a wrong account count or trailing bytes", () => {
    const metas12 = cpmmMetas().slice(0, 12);
    const cases: Array<[ReadonlyArray<Meta>, Uint8Array]> = [
      [metas12, cat(BASE_IN, u64le(5n), u64le(1n))],
      [cpmmMetas(), cat(BASE_IN, u64le(5n), u64le(1n), Uint8Array.of(0))],
    ];
    for (const [metas, data] of cases) {
      const intent = intentOf([ix(RAYDIUM_CPMM_PROGRAM, metas, data)]);
      expect(hasAuthority(intent, RAYDIUM_CPMM_PROGRAM)).toBe(true);
    }
  });
});

describe("Raydium CLMM swap_v2", () => {
  it("base-in bounds in and out; base-out falls back even with a zero price limit", () => {
    const intent = intentOf([
      ix(RAYDIUM_CLMM_PROGRAM, clmmMetas(19), clmmData(5000n, 100n, 3n, 1)),
    ]);
    expect(intent.summary).toBe("swap");
    expect(intent.outflows[0]?.amount).toMatchObject({ asset: "lamports", amount: "5000" });
    expect(intent.minimumReceived?.[0]?.amount).toMatchObject({ asset: OTHER_MINT, amount: "100" });

    const out = intentOf([ix(RAYDIUM_CLMM_PROGRAM, clmmMetas(13), clmmData(100n, 5000n, 0n, 0))]);
    expect(hasAuthority(out, RAYDIUM_CLMM_PROGRAM)).toBe(true);
  });

  it("falls back for a base-out swap with a price limit, and on short account lists", () => {
    const limited = intentOf([
      ix(RAYDIUM_CLMM_PROGRAM, clmmMetas(19), clmmData(100n, 5000n, 7n, 0)),
    ]);
    expect(hasAuthority(limited, RAYDIUM_CLMM_PROGRAM)).toBe(true);
    const short = intentOf([
      ix(RAYDIUM_CLMM_PROGRAM, clmmMetas(13).slice(0, 12), clmmData(5000n, 100n, 0n, 1)),
    ]);
    expect(hasAuthority(short, RAYDIUM_CLMM_PROGRAM)).toBe(true);
    /* A non-boolean is_base_input byte is not a swap_v2 shape at all. */
    const bad = intentOf([ix(RAYDIUM_CLMM_PROGRAM, clmmMetas(19), clmmData(5000n, 100n, 0n, 2))]);
    expect(hasAuthority(bad, RAYDIUM_CLMM_PROGRAM)).toBe(true);
  });
});

describe("Orca Whirlpool swap_v2", () => {
  it("exact-in a_to_b=0 debits owner B and credits owner A", () => {
    const intent = intentOf([
      ix(WHIRLPOOL_PROGRAM, whirlpoolMetas(17), whirlpoolData(5000n, 100n, 9n, 1, 0, SOME)),
    ]);
    expect(intent.summary).toBe("swap");
    /* a_to_b=0 → source is token_owner_account_b (index 9), destination owner A (index 7). */
    expect(intent.outflows[0]?.amount).toMatchObject({ asset: USDC, amount: "5000" });
    expect(intent.minimumReceived?.[0]?.amount).toMatchObject({ asset: "lamports", amount: "100" });
  });

  it("exact-out falls back with or without an explicit price limit", () => {
    for (const limit of [0n, 5n]) {
      const intent = intentOf([
        ix(WHIRLPOOL_PROGRAM, whirlpoolMetas(15), whirlpoolData(100n, 5000n, limit, 0, 1, NONE)),
      ]);
      expect(hasAuthority(intent, WHIRLPOOL_PROGRAM)).toBe(true);
    }
  });

  it("falls back on a truncated or trailing remaining-accounts option", () => {
    const metas = whirlpoolMetas(15);
    const cases: Uint8Array[] = [
      /* Option::Some with a declared slice that is not fully present. */
      whirlpoolData(
        5n,
        1n,
        9n,
        1,
        1,
        cat(Uint8Array.of(1), u64le(1n).subarray(0, 4), Uint8Array.of(6)),
      ),
      /* A valid Some plus a trailing byte. */
      whirlpoolData(5n, 1n, 9n, 1, 1, cat(SOME, Uint8Array.of(0))),
      /* An unknown option tag. */
      whirlpoolData(5n, 1n, 9n, 1, 1, Uint8Array.of(2)),
      /* Non-boolean amount_specified_is_input / a_to_b bytes. */
      whirlpoolData(5n, 1n, 9n, 2, 1, NONE),
      whirlpoolData(5n, 1n, 9n, 1, 2, NONE),
    ];
    for (const data of cases) {
      const intent = intentOf([ix(WHIRLPOOL_PROGRAM, metas, data)]);
      expect(hasAuthority(intent, WHIRLPOOL_PROGRAM)).toBe(true);
    }
  });
});

describe("amm decoders never throw on random input", () => {
  it("random data and account counts", () => {
    const programs = [
      RAYDIUM_AMM_PROGRAM,
      RAYDIUM_CLMM_PROGRAM,
      RAYDIUM_CPMM_PROGRAM,
      WHIRLPOOL_PROGRAM,
    ];
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 80 }),
        fc.uint8Array({ maxLength: 6 }),
        (data, metas) => {
          for (const program of programs) {
            const accounts: Meta[] = [rs(SIGNER)];
            for (let i = 1; i < metas.length; i++) {
              accounts.push(w(ACC(i)));
            }
            expect(() => intentOf([ix(program, accounts, data)])).not.toThrow();
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

const DLMM_SWAP = anchor("f8c69e91e17587c8");
const DLMM_SWAP2 = anchor("414b3f4ceb5b5b88");

/* lb_clmm swap metas: pool, bitmap, reserves, token accounts, mints, oracle, host fee, user
   (authority at 10), token programs, then (swap2) memo at 13, event authority, program. */
const dlmmMetas = (
  source = ACC(30),
  destination = ACC(31),
  user: string = SIGNER,
  swap2 = false,
): Meta[] => {
  const metas: Meta[] = [
    w(ACC(1)),
    ro(ACC(2)),
    w(ACC(3)),
    w(ACC(4)),
    w(source),
    w(destination),
    ro(WSOL),
    ro(USDC),
    w(ACC(9)),
    w(ACC(10)),
    rs(user),
    ro(TOKEN),
    ro(TOKEN),
  ];
  if (swap2) {
    metas.push(ro(MEMO));
  }
  metas.push(ro(ACC(13)), ro(ACC(14)));
  return metas;
};

const dlmmData = (disc: Uint8Array, a: bigint, b: bigint): Uint8Array =>
  cat(disc, u64le(a), u64le(b));

describe("Meteora DLMM", () => {
  it('the instruction discriminators are sha256("global:<name>")[0..8]', async () => {
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const enc = new TextEncoder();
    expect(sha256(enc.encode("global:swap")).subarray(0, 8)).toStrictEqual(DLMM_SWAP);
    expect(sha256(enc.encode("global:swap2")).subarray(0, 8)).toStrictEqual(DLMM_SWAP2);
  });

  it("swap describes the bounds and resolves both mints through the signer's ATAs", () => {
    const srcAta = associatedTokenAddress(SIGNER, WSOL, TOKEN);
    const dstAta = associatedTokenAddress(SIGNER, USDC, TOKEN);
    const intent = intentOf([
      ix(METEORA_DLMM_PROGRAM, dlmmMetas(srcAta, dstAta), dlmmData(DLMM_SWAP, 5000n, 100n)),
    ]);
    expect(intent.summary).toBe("swap");
    /* X is wSOL: the outflow shows the native asset. */
    expect(intent.outflows[0]).toMatchObject({
      to: METEORA_DLMM_PROGRAM,
      amount: { asset: "lamports", amount: "5000", symbol: "SOL", decimals: 9 },
      verified: true,
    });
    expect(intent.minimumReceived?.[0]).toStrictEqual({
      to: SIGNER,
      amount: { asset: USDC, amount: "100", symbol: "USDC", decimals: 6 },
    });
  });

  it("swap in the other direction (Y to X) resolves the same way", () => {
    const srcAta = associatedTokenAddress(SIGNER, USDC, TOKEN);
    const dstAta = associatedTokenAddress(SIGNER, WSOL, TOKEN);
    const intent = intentOf([
      ix(METEORA_DLMM_PROGRAM, dlmmMetas(srcAta, dstAta), dlmmData(DLMM_SWAP, 7000n, 9n)),
    ]);
    expect(intent.outflows[0]?.amount).toMatchObject({ asset: USDC, amount: "7000" });
    expect(intent.minimumReceived?.[0]?.amount).toMatchObject({ asset: "lamports", amount: "9" });
  });

  it("swap2 parses RemainingAccountsInfo, including a tag-3 slice, to the last byte", () => {
    /* slices = [{TransferHookX, len 2}, {TransferHookMultiReward, extra 9, len 1}] */
    const rai = cat(
      new Uint8Array([2, 0, 0, 0]),
      new Uint8Array([0, 2]),
      new Uint8Array([3, 9, 1]),
    );
    const srcAta = associatedTokenAddress(SIGNER, WSOL, TOKEN);
    const dstAta = associatedTokenAddress(SIGNER, USDC, TOKEN);
    const intent = intentOf([
      ix(
        METEORA_DLMM_PROGRAM,
        dlmmMetas(srcAta, dstAta, SIGNER, true),
        cat(dlmmData(DLMM_SWAP2, 4000n, 50n), rai),
      ),
    ]);
    expect(intent.summary).toBe("swap");
    expect(intent.outflows[0]?.amount).toMatchObject({ amount: "4000" });
    expect(intent.minimumReceived?.[0]?.amount).toMatchObject({ amount: "50" });
  });

  it.each([
    ["swap with a trailing byte", cat(dlmmData(DLMM_SWAP, 5n, 1n), Uint8Array.of(0)), dlmmMetas()],
    ["swap with 14 accounts", dlmmData(DLMM_SWAP, 5n, 1n), dlmmMetas().slice(0, 14)],
    [
      "swap2 whose slices over-read",
      cat(dlmmData(DLMM_SWAP2, 5n, 1n), new Uint8Array([9, 0, 0, 0, 0, 1])),
      dlmmMetas(undefined, undefined, SIGNER, true),
    ],
    [
      "swap2 with a trailing byte",
      cat(dlmmData(DLMM_SWAP2, 5n, 1n), new Uint8Array([0, 0, 0, 0]), Uint8Array.of(0)),
      dlmmMetas(undefined, undefined, SIGNER, true),
    ],
    [
      "swap2 with an unknown AccountsType tag",
      cat(dlmmData(DLMM_SWAP2, 5n, 1n), new Uint8Array([1, 0, 0, 0, 7, 1])),
      dlmmMetas(undefined, undefined, SIGNER, true),
    ],
    [
      "swap2 with AccountsType tag 5 — one past the known set",
      cat(dlmmData(DLMM_SWAP2, 5n, 1n), new Uint8Array([1, 0, 0, 0, 5, 1])),
      dlmmMetas(undefined, undefined, SIGNER, true),
    ],
    ["truncated swap data", dlmmData(DLMM_SWAP, 5n, 1n).subarray(0, 22), dlmmMetas()],
  ])("falls back for %s", (_name, data, metas) => {
    const intent = intentOf([ix(METEORA_DLMM_PROGRAM, metas, data)]);
    expect(hasAuthority(intent, METEORA_DLMM_PROGRAM)).toBe(true);
  });

  it("falls back when the user slot is not the signer", () => {
    const intent = intentOf([
      /* The signer is still in the ix — at the source slot — while another account is user. */
      ix(METEORA_DLMM_PROGRAM, dlmmMetas(SIGNER, ACC(31), ACC(40)), dlmmData(DLMM_SWAP, 5n, 1n)),
    ]);
    expect(hasAuthority(intent, METEORA_DLMM_PROGRAM)).toBe(true);
  });

  it("falls back when source and destination resolve to the same mint", () => {
    const ata = associatedTokenAddress(SIGNER, WSOL, TOKEN);
    const intent = intentOf([
      ix(METEORA_DLMM_PROGRAM, dlmmMetas(ata, ata), dlmmData(DLMM_SWAP, 5n, 1n)),
    ]);
    expect(hasAuthority(intent, METEORA_DLMM_PROGRAM)).toBe(true);
  });

  it("a non-ATA source account leaves the leg in token-account units", () => {
    const intent = intentOf([
      ix(METEORA_DLMM_PROGRAM, dlmmMetas(), dlmmData(DLMM_SWAP, 6000n, 100n)),
    ]);
    expect(intent.summary).toBe("swap");
    expect(intent.outflows[0]).toMatchObject({
      to: METEORA_DLMM_PROGRAM,
      amount: { asset: ACC(30), amount: "6000" },
      tokenAccount: ACC(30),
      verified: false,
    });
  });
});

/* A v1 message (SIMD-0385) carries the same compiled instructions, so every DLMM shape — the
   described swaps and each near miss — must classify exactly as its v0 form; only the fee rule
   differs (v1: 5000 lamports per signature plus the config priority fee). */
describe("Meteora DLMM as a v1 message", () => {
  const srcAta = associatedTokenAddress(SIGNER, WSOL, TOKEN);
  const dstAta = associatedTokenAddress(SIGNER, USDC, TOKEN);
  const swap2Rai = cat(new Uint8Array([1, 0, 0, 0]), new Uint8Array([3, 9, 1]));

  it.each([
    ["swap", dlmmMetas(srcAta, dstAta), dlmmData(DLMM_SWAP, 5000n, 100n)],
    [
      "swap2",
      dlmmMetas(srcAta, dstAta, SIGNER, true),
      cat(dlmmData(DLMM_SWAP2, 4000n, 50n), swap2Rai),
    ],
    ["swap from a non-ATA account", dlmmMetas(), dlmmData(DLMM_SWAP, 6000n, 100n)],
    ["swap with a trailing byte", dlmmMetas(), cat(dlmmData(DLMM_SWAP, 5n, 1n), Uint8Array.of(0))],
    ["swap with 14 accounts", dlmmMetas().slice(0, 14), dlmmData(DLMM_SWAP, 5n, 1n)],
    [
      "swap whose user is not the signer",
      dlmmMetas(SIGNER, ACC(31), ACC(40)),
      dlmmData(DLMM_SWAP, 5n, 1n),
    ],
    ["swap with one mint on both legs", dlmmMetas(srcAta, srcAta), dlmmData(DLMM_SWAP, 5n, 1n)],
  ])("%s", (_name, metas, data) => {
    const instructions = [ix(METEORA_DLMM_PROGRAM, metas, data)];
    const v0 = intentOf(instructions);
    const v1 = intentOf(instructions, 1);
    expect({ ...v1, fee: undefined }).toStrictEqual({ ...v0, fee: undefined });
    const signers = parseCompiledMessage(compile(instructions, 1)).numRequiredSignatures;
    expect(v1.fee?.max.amount).toBe(String(5000 * signers));
  });
});
