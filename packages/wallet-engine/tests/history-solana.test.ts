/**
 * Solana history: parsed-transaction entries against the recorded getSignatures/getTransaction
 * fixture, plus synthetic cases for zero-value token touches, token-account sub-streams and failed
 * transactions.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { solanaEntry, solanaHistoryStream } from "../src/history/solana.ts";
import type { SolanaParsedTx, SolanaSignatureInfo } from "../src/history/solana.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/history/solana-rpc.json"), "utf8"),
) as {
  readonly owner: string;
  readonly signatures: SolanaSignatureInfo[];
  readonly transactions: Record<string, SolanaParsedTx>;
};
const OWNER = fixture.owner;

const entryFor = (prefix: string) => {
  const sig = fixture.signatures.find((s) => s.signature.startsWith(prefix));
  const tx = sig === undefined ? undefined : fixture.transactions[sig.signature];
  if (sig === undefined || tx === undefined) {
    throw new Error(`fixture missing ${prefix}`);
  }
  return solanaEntry(SOL_NET, OWNER, sig, tx, true);
};

describe("solanaEntry (fixture)", () => {
  // The fixture owner's balances (~9.3e15 lamports) exceed 2^53, so every lamport change below is
  // instruction-derived and every entry stays unverified.
  it("native receive: lamports in, sender counterparty, no fee", () => {
    const e = entryFor("5bvPk");
    expect(e.direction).toBe("in");
    expect(e.verified).toBe(false);
    expect(e.counterparties).toStrictEqual(["3gd3LbQDfgD3joJFiujfMVSECUYsSraemjQubqJ91W2u"]);
    expect(e.fee).toBeUndefined();
    expect(e.changes).toStrictEqual([
      {
        direction: "in",
        asset: "lamports",
        amount: "1000",
        decimals: 9,
        symbol: "SOL",
        listed: true,
      },
    ]);
    expect(e.status).toBe("confirmed");
  });

  it("USDC receive: listed token in, owner counterparty from token metadata", () => {
    const e = entryFor("3qwwy");
    expect(e.direction).toBe("in");
    expect(e.verified).toBe(false);
    expect(e.counterparties).toStrictEqual(["3gd3LbQDfgD3joJFiujfMVSECUYsSraemjQubqJ91W2u"]);
    expect(e.changes).toStrictEqual([
      {
        direction: "in",
        asset: USDC,
        amount: "100",
        decimals: 6,
        symbol: "USDC",
        listed: true,
      },
    ]);
  });

  it("token send: unlisted mint out, no lamport change — the 5333 delta is the fee alone", () => {
    const e = entryFor("265J5");
    expect(e.direction).toBe("out");
    expect(e.verified).toBe(false);
    expect(e.fee).toBe("5333");
    expect(e.counterparties).toStrictEqual(["3gd3dqgtJ4jWfBfLYTX67DALFetjc5iS72sCgRhCkW2u"]);
    expect(e.changes).toStrictEqual([
      {
        direction: "out",
        asset: "7dUKUopcNWW6CcU4eRxCHh1uiMh32zDrmGf6ufqhxann",
        amount: "400000000000000",
        decimals: 1,
        listed: false,
      },
    ]);
  });

  it("spam-memo receive: lamports in from the system-transfer source", () => {
    const e = entryFor("2GRFV");
    expect(e.direction).toBe("in");
    expect(e.verified).toBe(false);
    expect(e.counterparties).toStrictEqual(["3fuMzf46n9bb5cbeccUSz6SE1eYEQbLK6JkibALyazeR"]);
    expect(e.changes[0]?.amount).toBe("10000");
  });

  it("send to a new ATA: token out plus the rent lamports, resolved ATA-owner counterparty", () => {
    const e = entryFor("3epP");
    expect(e.direction).toBe("out");
    expect(e.verified).toBe(false);
    expect(e.fee).toBe("19918");
    expect(e.counterparties).toStrictEqual(["3gd3dqgtJ4jWfBfLYTX67DALFetjc5iS72sCgRhCkW2u"]);
    expect(e.changes).toStrictEqual([
      {
        direction: "out",
        asset: "lamports",
        amount: "1488440",
        decimals: 9,
        symbol: "SOL",
        listed: true,
      },
      {
        direction: "out",
        asset: "7i5KKsX2weiTkry7jA4ZwSuXGhs5eJBEjY8vVxR4pfRx",
        amount: "7000000000000000",
        decimals: 9,
        listed: false,
      },
    ]);
  });
});

const sig = (signature: string, blockTime: number, slot = 1): SolanaSignatureInfo => ({
  signature,
  slot,
  blockTime,
});

const key = (pubkey: string): { readonly pubkey: string } => ({ pubkey });

/** A minimal parsed-tx the zod shape accepts. */
const parsed = (over: {
  keys: string[];
  meta?: Record<string, unknown> | null;
  instructions?: unknown[];
  blockTime?: number | null;
  slot?: number;
}): SolanaParsedTx =>
  ({
    slot: over.slot ?? 1,
    blockTime: over.blockTime ?? 1700000000,
    meta:
      over.meta === undefined
        ? {
            err: null,
            fee: 5000,
            preBalances: over.keys.map(() => 0),
            postBalances: over.keys.map(() => 0),
            preTokenBalances: [],
            postTokenBalances: [],
            innerInstructions: [],
          }
        : over.meta,
    transaction: {
      message: {
        accountKeys: over.keys.map(key),
        instructions: over.instructions ?? [],
      },
    },
  }) as SolanaParsedTx;

describe("solanaEntry (synthetic)", () => {
  it("marks a failed transaction failed", () => {
    const tx = parsed({
      keys: [OWNER],
      meta: {
        err: { InstructionError: [0, "Boom"] },
        fee: 5000,
        preBalances: [1],
        postBalances: [1],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
    });
    expect(solanaEntry(SOL_NET, OWNER, sig("failedsig", 1700000000), tx, true).status).toBe(
      "failed",
    );
  });

  it("flags a zero-amount transferChecked touch", () => {
    const tokenAccount = "TokenAcct111111111111111111111111111111111";
    const tx = parsed({
      keys: [OWNER, tokenAccount, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      instructions: [
        {
          program: "spl-token",
          parsed: {
            type: "transferChecked",
            info: {
              authority: OWNER,
              source: tokenAccount,
              destination: "DestAcct2222222222222222222222222222222",
              mint: "SomeMint333333333333333333333333333333333",
              tokenAmount: { amount: "0", decimals: 6 },
            },
          },
        },
      ],
    });
    const e = solanaEntry(SOL_NET, OWNER, sig("zerosig", 1700000000), tx, true);
    expect(e.flags).toContain("zero-value-transfer");
    expect(e.changes.some((c) => c.amount === "0")).toBe(true);
  });

  it("uses the balance delta when balances are safe integers, even where no instruction covers it", () => {
    const payer = "PayerAcct11111111111111111111111111111111";
    const closed = "ClosedAcct1111111111111111111111111111111";
    const tx = parsed({
      keys: [payer, OWNER, closed],
      meta: {
        err: null,
        fee: 5000,
        // The owner's +2039280 is a closeAccount rent refund — no transfer moves it.
        preBalances: [1_000_000, 1_000_000, 2_039_280],
        postBalances: [995_000, 3_039_280, 0],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
      instructions: [
        {
          program: "system",
          parsed: {
            type: "closeAccount",
            info: { account: closed, destination: OWNER, owner: OWNER },
          },
        },
      ],
    });
    const e = solanaEntry(SOL_NET, OWNER, sig("safesig", 1700000000), tx, true);
    expect(e.verified).toBe(true);
    expect(e.changes).toStrictEqual([
      {
        direction: "in",
        asset: "lamports",
        amount: "2039280",
        decimals: 9,
        symbol: "SOL",
        listed: true,
      },
    ]);
  });

  it("leaves a precise entry unverified when the read did not go to a host endpoint", () => {
    const payer = "PayerAcct11111111111111111111111111111111";
    const tx = parsed({
      keys: [payer, OWNER],
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1_000_000, 0],
        postBalances: [995_000, 100],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
    });
    const e = solanaEntry(SOL_NET, OWNER, sig("untrustedsig", 1700000000), tx, false);
    expect(e.changes[0]?.amount).toBe("100");
    expect(e.verified).toBe(false);
  });

  it("derives lamports from the system instructions when balances exceed 2^53", () => {
    const source = "SrcAcct1111111111111111111111111111111111";
    const tx = parsed({
      keys: [OWNER, source],
      meta: {
        err: null,
        fee: 5000,
        // Past 2^53 the parsed balances are rounded doubles — the delta cannot be trusted.
        preBalances: [9.3e15, 0],
        postBalances: [9.3e15, 0],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
      instructions: [
        {
          program: "system",
          parsed: {
            type: "transfer",
            info: { source, destination: OWNER, lamports: 7777 },
          },
        },
      ],
    });
    const e = solanaEntry(SOL_NET, OWNER, sig("unsafesig", 1700000000), tx, true);
    expect(e.verified).toBe(false);
    expect(e.fee).toBe("5000");
    expect(e.changes).toStrictEqual([
      {
        direction: "in",
        asset: "lamports",
        amount: "7777",
        decimals: 9,
        symbol: "SOL",
        listed: true,
      },
    ]);
  });
});

/** RPC answering the token-account discovery, its signature page, and one transaction. */
const tokenStreamRpc = (
  tokenAccount: string,
  mint: string,
  incoming: SolanaParsedTx,
  failTokenSigs = false,
): SolanaRpc => ({
  call: async (method, params) => {
    if (method === "getTokenAccountsByOwner") {
      const programId =
        typeof params[1] === "object" && params[1] !== null
          ? (params[1] as { programId?: string }).programId
          : undefined;
      return Promise.resolve({
        value: [
          {
            pubkey: tokenAccount,
            account: {
              owner: programId,
              data: {
                parsed: {
                  info: {
                    mint,
                    owner: OWNER,
                    tokenAmount: { amount: "60", decimals: 6 },
                  },
                },
              },
            },
          },
        ],
      });
    }
    if (method === "getSignaturesForAddress") {
      const account = params[0] as string;
      if (account === tokenAccount && failTokenSigs) {
        return Promise.reject(new Error("token stream down"));
      }
      return Promise.resolve(account === tokenAccount ? [sig("toksig", 1700000000)] : []);
    }
    if (method === "getTransaction") {
      return Promise.resolve(incoming);
    }
    return Promise.reject(new Error(`unmocked ${method}`));
  },
});

describe("solanaHistoryStream", () => {
  it("finds an incoming SPL transfer whose owner never appears in accountKeys", async () => {
    const tokenAccount = "TokenAcct444444444444444444444444444444444";
    const mint = "SomeMint555555555555555555555555555555555555";
    const incoming = parsed({
      keys: [tokenAccount, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      meta: {
        err: null,
        fee: 5000,
        preBalances: [0, 1],
        postBalances: [0, 1],
        preTokenBalances: [
          {
            accountIndex: 0,
            mint,
            owner: OWNER,
            uiTokenAmount: { amount: "10", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 0,
            mint,
            owner: OWNER,
            uiTokenAmount: { amount: "60", decimals: 6 },
          },
        ],
        innerInstructions: [],
      },
    });
    const rpc = tokenStreamRpc(tokenAccount, mint, incoming);
    const stream = solanaHistoryStream(
      { rpc, network: SOL_NET, owner: OWNER, trusted: true },
      () => {},
    );
    const page = await stream.next();
    expect(page.done).toBe(true);
    const e = page.items.find((x) => x.hash === "toksig");
    expect(e?.direction).toBe("in");
    expect(e?.changes).toStrictEqual([
      {
        direction: "in",
        asset: mint,
        amount: "50",
        decimals: 6,
        listed: false,
      },
    ]);
  });

  it("requests version-1 transactions and parses a jsonParsed v1 response", async () => {
    const tokenAccount = "TokenAcct444444444444444444444444444444444";
    const mint = "SomeMint555555555555555555555555555555555555";
    const incoming = parsed({
      keys: [tokenAccount, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1, 0],
        postBalances: [1, 0],
        preTokenBalances: [
          {
            accountIndex: 0,
            mint,
            owner: OWNER,
            uiTokenAmount: { amount: "10", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 0,
            mint,
            owner: OWNER,
            uiTokenAmount: { amount: "60", decimals: 6 },
          },
        ],
        innerInstructions: [],
      },
    });
    // A jsonParsed v1 message: transactionConfig instead of addressTableLookups.
    (incoming.transaction.message as Record<string, unknown>)["transactionConfig"] = {
      priorityFee: 12345,
      computeUnitLimit: 200000,
      loadedAccountsDataSizeLimit: 65536,
      heapSize: 65536,
    };
    const calls: Array<readonly [string, unknown[]]> = [];
    const base = tokenStreamRpc(tokenAccount, mint, incoming);
    const rpc: SolanaRpc = {
      call: async (method, params) => {
        calls.push([method, params]);
        return base.call(method, params);
      },
    };
    const stream = solanaHistoryStream(
      { rpc, network: SOL_NET, owner: OWNER, trusted: true },
      () => {},
    );
    const page = await stream.next();
    expect(page.done).toBe(true);
    const txCall = calls.find(([method]) => method === "getTransaction");
    expect(txCall?.[1]).toMatchObject([
      expect.any(String),
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
    ]);
    const e = page.items.find((x) => x.hash === "toksig");
    expect(e?.direction).toBe("in");
    expect(e?.changes).toStrictEqual([
      {
        direction: "in",
        asset: mint,
        amount: "50",
        decimals: 6,
        listed: false,
      },
    ]);
  });

  it("reports a failing token-account sub-stream under the network id", async () => {
    const tokenAccount = "TokenAcct666666666666666666666666666666666";
    const errors: Array<readonly [string, unknown]> = [];
    const stream = solanaHistoryStream(
      {
        rpc: tokenStreamRpc(
          tokenAccount,
          "SomeMint777777777777777777777777777777777777",
          parsed({ keys: [tokenAccount] }),
          true,
        ),
        network: SOL_NET,
        owner: OWNER,
        trusted: true,
      },
      (id, error) => {
        errors.push([id, error]);
      },
    );
    const page = await stream.next();
    expect(page.done).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(([id]) => id === SOL_NET)).toBe(true);
  });
});
