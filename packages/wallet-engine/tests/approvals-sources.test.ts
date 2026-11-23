/**
 * Candidate sources: the session's tracked sends yield keys from their decoded intents (batch calls
 * included), the persisted record round-trips and rejects malformed shapes, and gathered claims
 * dedupe into one key per row — gateway claims ordering newest first.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  encodeCandidates,
  gatherCandidates,
  localCandidates,
  parseStoredCandidates,
} from "../src/approvals/sources.ts";
import type { Candidate } from "../src/approvals/sources.ts";
import type { AccountRef, DisplayIntent, TrackedTransaction } from "../src/transactions/route.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TOKEN = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x3333333333333333333333333333333333333333";
const OPERATOR = "0x4444444444444444444444444444444444444444";
const STAKE = "Stake1111111111111111111111111111111111111111";
const NETWORK = "eip155:1";

const ACCOUNT: AccountRef = { kind: "imported", family: "evm", keyId: "k" };

/** The gathered claim for TOKEN's erc20 candidate. */
const isLocalToken = (g: { readonly candidate: Candidate }) =>
  g.candidate.kind === "erc20" && g.candidate.token === TOKEN;

const sources = (g: { readonly sources: ReadonlySet<string> } | undefined): ReadonlyArray<string> =>
  [...(g?.sources ?? new Set<string>())].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const intent = (over: Partial<DisplayIntent>): DisplayIntent => ({
  family: "evm",
  network: NETWORK,
  summary: "approve",
  outflows: [],
  approvals: [],
  fee: undefined,
  warnings: [],
  verifiability: "full",
  ...over,
});

const TX: TrackedTransaction = {
  id: "tx-1",
  family: "evm",
  network: NETWORK,
  account: "k",
  hash: "0x1",
  state: "confirmed",
  nonce: 0,
  evm: { from: OWNER, account: ACCOUNT },
  submittedAt: 0,
  intent: intent({}),
  error: undefined,
};

const tx = (over: Partial<TrackedTransaction>): TrackedTransaction => ({ ...TX, ...over });

describe("local candidates", () => {
  it("an allowance intent yields an erc20 candidate; via permit2 yields permit2", () => {
    const candidates = localCandidates(
      {
        a: tx({
          intent: intent({
            approvals: [
              {
                kind: "allowance",
                spender: SPENDER,
                amount: { asset: TOKEN, amount: "1" },
                change: "set",
                unlimited: false,
                verified: false,
              },
            ],
          }),
        }),
        b: tx({
          id: "tx-2",
          intent: intent({
            approvals: [
              {
                kind: "allowance",
                spender: SPENDER,
                amount: { asset: TOKEN, amount: "2" },
                change: "set",
                unlimited: true,
                verified: false,
                via: "permit2",
              },
            ],
          }),
        }),
      },
      "evm",
      NETWORK,
      OWNER,
    );
    expect(candidates).toContainEqual({ kind: "erc20", token: TOKEN, spender: SPENDER });
    expect(candidates).toContainEqual({ kind: "permit2", token: TOKEN, spender: SPENDER });
  });

  it("operator, stake-authority and nested batch-call approvals all yield candidates", () => {
    const candidates = localCandidates(
      {
        a: tx({
          intent: intent({
            approvals: [
              {
                kind: "operator",
                asset: TOKEN,
                spender: OPERATOR,
                approved: true,
                verified: false,
              },
            ],
            calls: [
              intent({
                approvals: [
                  {
                    kind: "allowance",
                    spender: SPENDER,
                    amount: { asset: TOKEN, amount: "1" },
                    change: "set",
                    unlimited: false,
                    verified: false,
                  },
                ],
              }),
            ],
          }),
        }),
      },
      "evm",
      NETWORK,
      OWNER,
    );
    expect(candidates).toContainEqual({ kind: "operator", token: TOKEN, operator: OPERATOR });
    expect(candidates).toContainEqual({ kind: "erc20", token: TOKEN, spender: SPENDER });
  });

  it("staking create and stake-authority yield stake candidates; foreign sends are skipped", () => {
    const candidates = localCandidates(
      {
        a: tx({
          intent: intent({
            approvals: [
              {
                kind: "stake-authority",
                account: STAKE,
                role: "staker",
                authority: OPERATOR,
                verified: false,
              },
            ],
            staking: [{ kind: "create", account: STAKE, lamports: "1000" }],
          }),
        }),
        foreign: tx({
          id: "tx-3",
          hash: "0x2",
          evm: { from: "0x9999999999999999999999999999999999999999", account: ACCOUNT },
          intent: intent({
            approvals: [
              {
                kind: "allowance",
                spender: SPENDER,
                amount: { asset: TOKEN, amount: "1" },
                change: "set",
                unlimited: false,
                verified: false,
              },
            ],
          }),
        }),
      },
      "evm",
      NETWORK,
      OWNER,
    );
    expect(candidates).toContainEqual({ kind: "stake", account: STAKE });
    expect(candidates).toHaveLength(2);
  });
});

describe("gathered candidates", () => {
  it("dedupes across sources and orders gateway claims newest block first", () => {
    const gathered = gatherCandidates([
      {
        candidate: { kind: "erc20", token: TOKEN, spender: SPENDER },
        seen: 50n,
        source: "gateway",
      },
      { candidate: { kind: "erc20", token: TOKEN, spender: SPENDER }, source: "local" },
      {
        candidate: {
          kind: "erc20",
          token: "0x2222222222222222222222222222222222222222",
          spender: SPENDER,
        },
        seen: 90n,
        source: "gateway",
      },
    ]);
    expect(gathered).toHaveLength(2);
    const first = gathered[0]?.candidate;
    expect(first).toMatchObject({
      kind: "erc20",
      token: "0x2222222222222222222222222222222222222222",
    });
    const merged = gathered.find(isLocalToken);
    expect(sources(merged)).toStrictEqual(["gateway", "local"]);
  });
});

describe("the persisted record", () => {
  const all: Candidate[] = [
    { kind: "erc20", token: TOKEN, spender: SPENDER },
    { kind: "erc721", token: TOKEN, spender: SPENDER, tokenId: "7" },
    { kind: "operator", token: TOKEN, operator: OPERATOR },
    { kind: "permit2", token: TOKEN, spender: SPENDER },
    { kind: "trc20", token: "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT", spender: "SSSS" },
    { kind: "stake", account: STAKE },
  ];

  it("round-trips every candidate kind", () => {
    expect(parseStoredCandidates(encodeCandidates(all))).toStrictEqual(all);
  });

  it("rejects malformed records — junk json, wrong shape, wrong kind, extra keys", () => {
    const bad = [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ candidates: [{ kind: "nope", token: TOKEN, spender: SPENDER }] }),
      JSON.stringify({ candidates: [{ kind: "erc20", token: TOKEN, spender: SPENDER, extra: 1 }] }),
      JSON.stringify({
        candidates: [{ kind: "erc20", token: "not-an-address", spender: SPENDER }],
      }),
    ];
    for (const record of bad) {
      expect(parseStoredCandidates(new TextEncoder().encode(record))).toBeUndefined();
    }
  });
});
