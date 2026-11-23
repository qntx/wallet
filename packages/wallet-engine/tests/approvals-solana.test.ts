/**
 * Solana chain reads → rows. The scripted `call` answers `getTokenAccountsByOwner` (both token
 * programs), `getMultipleAccounts` (mints and stake candidates) and `getEpochInfo` (the seed scan);
 * the independent endpoint answers the same snapshots — possibly different — and the test asserts
 * the `minContextSlot` it was asked at equals the primary's `context.slot`.
 */
import { describe, expect, it } from "vite-plus/test";

import { solanaApprovals } from "../src/approvals/solana.ts";
import type { SolanaReadDeps } from "../src/approvals/solana.ts";
import { gatherCandidates } from "../src/approvals/sources.ts";
import type { ApprovalRow } from "../src/approvals/types.ts";

const OWNER = "Owner1111111111111111111111111111111111111";
const TA = "TokenAccount11111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";
const DELEGATE = "Delegate1111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111111";
const CLOSE = "Close111111111111111111111111111111111111111";
const FREEZE = "Freeze11111111111111111111111111111111111111";
const PERM = "Perm11111111111111111111111111111111111111111";
const STAKE = "Stake1111111111111111111111111111111111111111";
const STAKER = "Staker111111111111111111111111111111111111111";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";

const tokenAccount = (over: Record<string, unknown>) => ({
  pubkey: TA,
  account: {
    owner: TOKEN_PROGRAM,
    data: {
      parsed: {
        type: "account",
        info: {
          mint: MINT,
          owner: OWNER,
          state: "initialized",
          tokenAmount: { amount: "1000", decimals: 6, uiAmountString: "0.001" },
          ...over,
        },
      },
      program: "spl-token",
      space: 165,
    },
  },
});

const token2022Account = (over: Record<string, unknown>) => ({
  pubkey: `${TA}22`,
  account: {
    owner: TOKEN_2022,
    data: {
      parsed: {
        type: "account",
        info: {
          mint: MINT,
          owner: OWNER,
          state: "initialized",
          tokenAmount: { amount: "500", decimals: 6, uiAmountString: "0.0005" },
          ...over,
        },
      },
      program: "spl-token-2022",
      space: 200,
    },
  },
});

const mintAccount = (over: Record<string, unknown>) => ({
  owner: TOKEN_PROGRAM,
  data: {
    parsed: {
      type: "mint",
      info: { decimals: 6, supply: "1000000", isInitialized: true, ...over },
    },
    program: "spl-token",
    space: 82,
  },
});

const stakeAccount = (staker: string, withdrawer: string) => ({
  owner: STAKE_PROGRAM,
  data: {
    parsed: {
      type: "delegated",
      info: {
        meta: { authorized: { staker, withdrawer }, lockup: {} },
        stake: {
          delegation: {
            voter: "Vote1111111111111111111111111111111111111",
            activationEpoch: "0",
            deactivationEpoch: "18446744073709551615",
          },
        },
      },
    },
    program: "stake",
    space: 200,
  },
});

type Scripted = {
  readonly slot?: number;
  readonly tokenAccounts?: ReadonlyArray<unknown>;
  readonly token2022Accounts?: ReadonlyArray<unknown>;
  /** GetMultipleAccounts answers keyed by account address; absent → null. */
  readonly multi?: ReadonlyMap<string, unknown>;
  readonly calls?: Array<{ method: string; params: unknown[] }>;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const answer = (script: Scripted, method: string, params: ReadonlyArray<unknown>): unknown => {
  script.calls?.push({ method, params: [...params] });
  if (method === "getTokenAccountsByOwner") {
    const program =
      isObj(params[1]) && typeof params[1]["programId"] === "string" ? params[1]["programId"] : "";
    const value =
      program === TOKEN_PROGRAM
        ? (script.tokenAccounts ?? [])
        : program === TOKEN_2022
          ? (script.token2022Accounts ?? [])
          : [];
    return { context: { slot: script.slot ?? 50 }, value };
  }
  if (method === "getMultipleAccounts") {
    const keys = Array.isArray(params[0]) ? params[0] : [];
    return {
      context: { slot: script.slot ?? 50 },
      value: keys.map((k) => (typeof k === "string" ? (script.multi?.get(k) ?? null) : null)),
    };
  }
  if (method === "getEpochInfo") {
    return { epoch: 300 };
  }
  throw new Error(`unmocked ${method}`);
};

const rpc = (script: Scripted) => ({
  call: async (method: string, params: ReadonlyArray<unknown>) =>
    Promise.resolve(answer(script, method, params)),
});

const deps = (
  primary: ReturnType<typeof rpc>,
  independent:
    | { kind: "available"; source: "host"; client: ReturnType<typeof rpc> }
    | { kind: "unavailable" },
): SolanaReadDeps => ({
  networks: {
    solanaRpc: () => primary,
    independentSolanaRpc: () => independent,
  },
  known: () => [],
});

const row = (rows: ReadonlyArray<ApprovalRow>, kind: ApprovalRow["kind"]) =>
  rows.find((r) => r.kind === kind);

type ScriptCall = { method: string; params: unknown[] };

const isTokenCall = (c: ScriptCall) =>
  c.method === "getTokenAccountsByOwner" || c.method === "getMultipleAccounts";

const minSlotOf = (c: ScriptCall): number | undefined => {
  const raw = c.method === "getTokenAccountsByOwner" ? c.params[2] : c.params[1];
  const config = isObj(raw) ? raw["minContextSlot"] : undefined;
  return typeof config === "number" ? config : undefined;
};

/** Narrows a row to the variants carrying `field` — union narrowing in tests. */
const has = <F extends string>(
  r: ApprovalRow | undefined,
  f: F,
): (ApprovalRow & Record<F, unknown>) | undefined => (r !== undefined && f in r ? r : undefined);

describe("solana approvals reads", () => {
  it("delegate, close-authority, freeze and permanent-delegate rows enumerate", async () => {
    const script: Scripted = {
      tokenAccounts: [
        tokenAccount({ delegate: DELEGATE, delegatedAmount: { amount: "300", decimals: 6 } }),
      ],
      token2022Accounts: [token2022Account({ closeAuthority: CLOSE })],
      multi: new Map([
        [
          MINT,
          mintAccount({
            freezeAuthority: FREEZE,
            extensions: [{ extension: "permanentDelegate", state: { delegate: PERM } }],
          }),
        ],
      ]),
    };
    const result = await solanaApprovals(
      deps(rpc(script), { kind: "unavailable" }),
      NETWORK,
      OWNER,
      [],
    );

    const delegate = row(result.rows, "spl-delegate");
    expect(has(delegate, "delegate")?.delegate).toBe(DELEGATE);
    expect(has(delegate, "amount")?.amount).toBe("300");
    expect(has(delegate, "exposure")?.exposure).toBe("300");
    expect(has(delegate, "program")?.program).toBe("token");

    const close = row(result.rows, "spl-close-authority");
    expect(has(close, "authority")?.authority).toBe(CLOSE);

    const authorities = result.rows.filter((r) => r.kind === "spl-mint-authority");
    expect(new Set(authorities.map((r) => has(r, "role")?.role))).toStrictEqual(
      new Set(["freeze", "permanent-delegate"]),
    );
    expect(result.exhaustive).toStrictEqual([
      "spl-delegate",
      "spl-close-authority",
      "spl-mint-authority",
    ]);
    expect(result.rows.every((r) => !r.verified)).toBe(true);
  });

  it("an independent endpoint naming a different delegate disputes the row", async () => {
    const primary: Scripted = {
      tokenAccounts: [
        tokenAccount({ delegate: DELEGATE, delegatedAmount: { amount: "300", decimals: 6 } }),
      ],
      multi: new Map([[MINT, mintAccount({})]]),
    };
    const secondary: Scripted = {
      tokenAccounts: [
        tokenAccount({ delegate: OTHER, delegatedAmount: { amount: "300", decimals: 6 } }),
      ],
      multi: new Map([[MINT, mintAccount({})]]),
    };
    const result = await solanaApprovals(
      deps(rpc(primary), { kind: "available", source: "host", client: rpc(secondary) }),
      NETWORK,
      OWNER,
      [],
    );
    expect(row(result.rows, "spl-delegate")).toBeUndefined();
    expect(result.disputed).toBe(1);
  });

  it("agreeing endpoints verify the row; the second read asks minContextSlot", async () => {
    const script: Scripted = {
      tokenAccounts: [
        tokenAccount({ delegate: DELEGATE, delegatedAmount: { amount: "300", decimals: 6 } }),
      ],
      multi: new Map([[MINT, mintAccount({})]]),
    };
    const secondaryCalls: ScriptCall[] = [];
    const result = await solanaApprovals(
      deps(rpc(script), {
        kind: "available",
        source: "host",
        client: rpc({ ...script, calls: secondaryCalls }),
      }),
      NETWORK,
      OWNER,
      [],
    );
    const shown = row(result.rows, "spl-delegate");
    expect(shown?.verified).toBe(true);

    const tokenCalls = secondaryCalls.filter(isTokenCall);
    const slots = tokenCalls.map(minSlotOf);
    expect(tokenCalls.length).toBeGreaterThan(0);
    expect(slots.every((s) => s === 50)).toBe(true);
  });

  it("a stake account with a foreign staker shows a stake-authority row", async () => {
    const script: Scripted = {
      tokenAccounts: [],
      multi: new Map([[STAKE, stakeAccount(STAKER, OWNER)]]),
    };
    const result = await solanaApprovals(
      deps(rpc(script), { kind: "unavailable" }),
      NETWORK,
      OWNER,
      gatherCandidates([{ candidate: { kind: "stake", account: STAKE }, source: "local" }]),
    );
    const stake = row(result.rows, "stake-authority");
    expect(has(stake, "authority")?.authority).toBe(STAKER);
    expect(has(stake, "role")?.role).toBe("staker");
    expect(result.exhaustive).not.toContain("stake-authority");
  });
});
