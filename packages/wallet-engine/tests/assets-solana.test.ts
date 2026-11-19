/**
 * Solana SPL balance reads: the holdings read queries each token program once per refresh and sums
 * every token account per mint — attacker-created empty accounts, account order and foreign
 * accounts cannot change the total. Frozen accounts are reported apart from the balance.
 *
 * The fixture is a recorded mainnet `getTokenAccountsByOwner` answer for a real owner. The fake
 * still answers a `{ mint }` filter with that mint's fixture accounts in order so the pre-fix
 * first-account read fails on values rather than on an unmocked call.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import { AssetsController } from "../src/assets/controller.ts";
import type { AccountBalances } from "../src/assets/controller.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const logger = { warn: () => {} };
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/solana-token-accounts.json"), "utf8"),
) as {
  readonly owner: string;
  readonly tokenProgram: { readonly context: unknown; readonly value: unknown[] };
  readonly token2022Program: { readonly context: unknown; readonly value: unknown[] };
};

const OWNER = fixture.owner;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const T22_MINT = "zZs2Buajob4MLf1UYzVRhNFuimSmiXVY1VRSPc9bysi";
const FROZEN_A = "CdDgU2F7DNnGrjbqcFUhbEd2VbK6W4unszLD34aDbtnP";
const FROZEN_B = "vrF9iUxduAGbdA1fHBST3jhJgRQ89PLkgQbfPMLcV8z";

/** A parsed mint account as `getMultipleAccounts` jsonParsed returns it. */
const mintAccount = (opts: {
  readonly decimals: number;
  readonly supply?: string;
  readonly program?: string;
}): unknown => ({
  lamports: 1_500_000,
  owner: opts.program ?? PROGRAM_IDS.token,
  executable: false,
  rentEpoch: 0,
  space: 82,
  data: {
    parsed: {
      type: "mint",
      info: {
        decimals: opts.decimals,
        supply: opts.supply ?? "1000000000",
        isInitialized: true,
        mintAuthority: null,
        freezeAuthority: null,
      },
    },
    program: "spl-token",
  },
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);

const entryMint = (entry: unknown): string | undefined => {
  const account = obj(obj(entry)?.["account"]);
  const info = obj(obj(obj(account?.["data"])?.["parsed"])?.["info"]);
  const mint = info?.["mint"];
  return typeof mint === "string" ? mint : undefined;
};

type Accounts = {
  readonly token: ReadonlyArray<unknown>;
  readonly token2022: ReadonlyArray<unknown>;
};

const fixtureAccounts = (): Accounts => ({
  token: fixture.tokenProgram.value,
  token2022: fixture.token2022Program.value,
});

type Call = { readonly method: string; readonly params: unknown[] };

/** A token-account entry as the RPC returns it — `program` is the account's program owner. */
const tokenAccount = (opts: {
  readonly program: string;
  readonly mint: string;
  readonly owner: string;
  readonly amount: string;
  readonly decimals?: number;
  readonly state?: string;
  /** `null` produces an entry with no `pubkey` key at all. */
  readonly pubkey?: string | null;
}): unknown => ({
  ...(opts.pubkey === null
    ? {}
    : { pubkey: opts.pubkey ?? "InjectedTokenAcct1111111111111111111111111111" }),
  account: {
    owner: opts.program,
    data: {
      parsed: {
        info: {
          mint: opts.mint,
          owner: opts.owner,
          state: opts.state ?? "initialized",
          tokenAmount: { amount: opts.amount, decimals: opts.decimals ?? 6 },
        },
        type: "account",
      },
      program: "spl-token",
    },
  },
});

const solRpc = (
  accounts: Accounts,
  calls: Call[],
  mintAccounts?: Record<string, unknown>,
): SolanaRpc => ({
  call: async (method, params) => {
    calls.push({ method, params });
    if (method === "getBalance") {
      return Promise.resolve({ value: 0 });
    }
    if (method === "getMultipleAccounts") {
      const [keys] = params;
      return Promise.resolve({
        value: (keys as string[]).map((k) => mintAccounts?.[k] ?? null),
      });
    }
    if (method === "getTokenAccountsByOwner") {
      const filter = obj(params[1]) ?? {};
      if (filter["programId"] === PROGRAM_IDS.token) {
        return Promise.resolve({ context: { slot: 0 }, value: accounts.token });
      }
      if (filter["programId"] === PROGRAM_IDS.token2022) {
        return Promise.resolve({ context: { slot: 0 }, value: accounts.token2022 });
      }
      if (typeof filter["mint"] === "string") {
        // The pre-fix read path: keep answering so its first-account bug fails on values.
        return Promise.resolve({
          context: { slot: 0 },
          value: [...accounts.token, ...accounts.token2022].filter(
            (e) => entryMint(e) === filter["mint"],
          ),
        });
      }
      return Promise.reject(new Error("unexpected getTokenAccountsByOwner filter"));
    }
    return Promise.reject(new Error(`unmocked ${method}`));
  },
});

const filterKey = (call: Call): unknown => obj(call.params[1])?.["programId"];
const mintKey = (call: Call): unknown => obj(call.params[1])?.["mint"];

const make = (
  accounts: Accounts,
  calls: Call[],
  mintAccounts?: Record<string, unknown>,
): AssetsController => {
  const store = createMemoryEngineStore();
  return new AssetsController({
    ownBitcoinTxids: () => new Set(),
    networks: {
      info: (n: string) => (n === SOL_NET ? { family: "solana" } : { family: "evm", chainId: 1 }),
      solanaRpc: () => solRpc(accounts, calls, mintAccounts),
    } as never,
    chains: { account: async () => Promise.reject(new Error("unmocked chains.account")) },
    openStore: async () => Promise.resolve(store),
    setTimer: () => () => {},
    logger,
    gateway: undefined,
    fetch: globalThis.fetch,
    now: () => Date.now(),
  });
};

const tokenBalance = (balances: AccountBalances, mint: string) => {
  const token = balances.tokens.find((t) => t.address === mint);
  if (token === undefined) {
    throw new Error(`no token entry for ${mint}`);
  }
  return token;
};

const tokenAccountCalls = (calls: Call[]): Call[] =>
  calls.filter((c) => c.method === "getTokenAccountsByOwner");

describe("AssetsController solana token holdings", () => {
  it("sums every token account per mint over both programs, two account calls per refresh", async () => {
    const calls: Call[] = [];
    const assets = make(fixtureAccounts(), calls, {
      [T22_MINT]: mintAccount({ decimals: 9, program: PROGRAM_IDS.token2022 }),
    });
    await assets.init();
    await assets.addToken(SOL_NET, USDC);
    await assets.addToken(SOL_NET, USDT);
    await assets.addToken(SOL_NET, T22_MINT);
    calls.length = 0;
    const balances = await assets.refresh(OWNER, SOL_NET);
    expect(tokenBalance(balances, USDC).balance).toBe("1110038251");
    expect(tokenBalance(balances, USDT).balance).toBe("0");
    expect(tokenBalance(balances, T22_MINT).balance).toBe("0");
    expect(tokenBalance(balances, T22_MINT).decimals).toBe(9);
    expect(tokenBalance(balances, USDC).frozen).toBeUndefined();
    const accounts = tokenAccountCalls(calls);
    expect(accounts.map(filterKey)).toStrictEqual([PROGRAM_IDS.token, PROGRAM_IDS.token2022]);
    expect(accounts.every((c) => mintKey(c) === undefined)).toBe(true);
  });

  it("is independent of the account order in the RPC answer", async () => {
    const calls: Call[] = [];
    const assets = make(
      {
        token: fixture.tokenProgram.value.toReversed(),
        token2022: fixture.token2022Program.value.toReversed(),
      },
      calls,
    );
    await assets.init();
    await assets.addToken(SOL_NET, USDC);
    const balances = await assets.refresh(OWNER, SOL_NET);
    expect(tokenBalance(balances, USDC).balance).toBe("1110038251");
  });

  it("counts a token account pubkey once and skips entries without one", async () => {
    const calls: Call[] = [];
    const assets = make(
      {
        token: [
          tokenAccount({
            program: PROGRAM_IDS.token,
            mint: USDC,
            owner: OWNER,
            amount: "500000",
            pubkey: "Dup1111111111111111111111111111111111111111",
          }),
          // The same account listed again must not double its balance.
          tokenAccount({
            program: PROGRAM_IDS.token,
            mint: USDC,
            owner: OWNER,
            amount: "500000",
            pubkey: "Dup1111111111111111111111111111111111111111",
          }),
          tokenAccount({
            program: PROGRAM_IDS.token,
            mint: USDC,
            owner: OWNER,
            amount: "700000",
            pubkey: null,
          }),
          tokenAccount({
            program: PROGRAM_IDS.token,
            mint: USDC,
            owner: OWNER,
            amount: "900000",
          }),
        ],
        token2022: [],
      },
      calls,
    );
    await assets.init();
    await assets.addToken(SOL_NET, USDC);
    const balances = await assets.refresh(OWNER, SOL_NET);
    expect(tokenBalance(balances, USDC).balance).toBe("1400000");
  });

  it("an attacker-created empty account listed first does not hide the balance", async () => {
    const calls: Call[] = [];
    const assets = make(
      {
        token: [
          tokenAccount({ program: PROGRAM_IDS.token, mint: USDC, owner: OWNER, amount: "0" }),
          ...fixture.tokenProgram.value,
        ],
        token2022: fixture.token2022Program.value,
      },
      calls,
    );
    await assets.init();
    await assets.addToken(SOL_NET, USDC);
    const balances = await assets.refresh(OWNER, SOL_NET);
    expect(tokenBalance(balances, USDC).balance).toBe("1110038251");
  });

  it("ignores entries whose account owner is not the queried program or the wallet, and non-counted states", async () => {
    const calls: Call[] = [];
    const assets = make(
      {
        token: [
          tokenAccount({
            program: PROGRAM_IDS.token2022,
            mint: USDC,
            owner: OWNER,
            amount: "777000",
          }),
          tokenAccount({
            program: PROGRAM_IDS.token,
            mint: USDC,
            owner: "NotTheWallet111111111111111111111111111111",
            amount: "777000",
          }),
          tokenAccount({
            program: PROGRAM_IDS.token,
            mint: USDC,
            owner: OWNER,
            amount: "777000",
            state: "uninitialized",
          }),
          ...fixture.tokenProgram.value,
        ],
        token2022: fixture.token2022Program.value,
      },
      calls,
    );
    await assets.init();
    await assets.addToken(SOL_NET, USDC);
    const balances = await assets.refresh(OWNER, SOL_NET);
    expect(tokenBalance(balances, USDC).balance).toBe("1110038251");
  });

  it("reports frozen token accounts apart from the balance", async () => {
    const calls: Call[] = [];
    const assets = make(fixtureAccounts(), calls, {
      [FROZEN_A]: mintAccount({ decimals: 6, program: PROGRAM_IDS.token2022 }),
      [FROZEN_B]: mintAccount({ decimals: 6, program: PROGRAM_IDS.token2022 }),
    });
    await assets.init();
    await assets.addToken(SOL_NET, FROZEN_A);
    await assets.addToken(SOL_NET, FROZEN_B);
    const balances = await assets.refresh(OWNER, SOL_NET);
    const a = tokenBalance(balances, FROZEN_A);
    const b = tokenBalance(balances, FROZEN_B);
    expect(a.balance).toBe("0");
    expect(a.frozen).toBe("150500000");
    expect(b.balance).toBe("0");
    expect(b.frozen).toBe("225750000");
  });

  it("a held custom mint takes its decimals from the inspected mint, not the token accounts", async () => {
    const calls: Call[] = [];
    const weird = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
    const assets = make(
      {
        token: [
          tokenAccount({
            program: PROGRAM_IDS.token,
            mint: weird,
            owner: OWNER,
            amount: "700",
            decimals: 6,
          }),
        ],
        token2022: [],
      },
      calls,
      { [weird]: mintAccount({ decimals: 2 }) },
    );
    await assets.init();
    await assets.addToken(SOL_NET, weird);
    const balances = await assets.refresh(OWNER, SOL_NET);
    const token = tokenBalance(balances, weird);
    expect(token.balance).toBe("700");
    expect(token.decimals).toBe(2);
  });

  it("a custom mint whose mint account cannot be read is omitted, not shown at 9", async () => {
    const calls: Call[] = [];
    const weird = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
    const mintAccounts: Record<string, unknown> = {
      [weird]: mintAccount({ decimals: 4 }),
    };
    const assets = make({ token: [], token2022: [] }, calls, mintAccounts);
    await assets.init();
    await assets.addToken(SOL_NET, weird);
    // A new unlock re-reads persisted custom mints; the mint read is now dark.
    assets.lock();
    await assets.init();
    mintAccounts[weird] = null;
    const balances = await assets.refresh(OWNER, SOL_NET);
    expect(balances.tokens.find((t) => t.address === weird)).toBeUndefined();
    expect(balances.tokens.every((t) => t.decimals !== 9)).toBe(true);
  });
});
