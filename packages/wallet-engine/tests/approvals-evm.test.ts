/**
 * EVM chain reads → rows. Every call is answered by a scripted transport keyed on method, `to` and
 * decoded calldata; viem's own ABI codecs build the answers, so the test is the independent oracle
 * for the trust rule: invented candidates drop, a contradicting second endpoint disputes, agreement
 * shows the weaker (smaller) values — and every read names the same block height.
 */
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  erc721Abi,
  isHex,
} from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { EVM_DELEGATOR, MAX_UINT256, PERMIT2_ADDRESS } from "@qntx/wallet-chains/evm";

import { EVM_PROBE_MAX, evmApprovals } from "../src/approvals/evm.ts";
import type { EvmReadDeps } from "../src/approvals/evm.ts";
import { candidateKey, gatherCandidates } from "../src/approvals/sources.ts";
import type { Candidate } from "../src/approvals/sources.ts";
import type { ApprovalRow } from "../src/approvals/types.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TOKEN = "0x1111111111111111111111111111111111111111";
const NFT = "0x2222222222222222222222222222222222222222";
const SPENDER = "0x3333333333333333333333333333333333333333";
const OPERATOR = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const NETWORK = "eip155:1";

const PERMIT2_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

const ABIS = [...erc20Abi, ...erc721Abi, ...PERMIT2_ABI];

export type Call = {
  readonly to: string;
  readonly functionName: string;
  readonly args: ReadonlyArray<unknown>;
};

type Answers = {
  readonly head?: bigint;
  readonly timestamp?: bigint;
  /** Eth_call answer for a decoded call — missing means revert (throw). */
  readonly call?: (call: Call) => string | undefined;
  readonly code?: (address: string, height: string) => string;
  readonly nonce?: (address: string) => bigint;
  /** Every method throws — the endpoint is down. */
  readonly down?: boolean;
};

/** Every eth_call/getCode/getTransactionCount the client issued, for the height assertion. */
export type Seen = { method: string; to?: string; height?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const answer = (answers: Answers, seen: Seen[], method: string, params: unknown): unknown => {
  const list = Array.isArray(params) ? params : [];
  if (answers.down === true) {
    throw new Error("endpoint down");
  }
  if (method === "eth_blockNumber") {
    return `0x${(answers.head ?? 100n).toString(16)}`;
  }
  if (method === "eth_getBlockByNumber") {
    seen.push({ method, height: str(list[0]) });
    return {
      number: list[0],
      timestamp: `0x${(answers.timestamp ?? 1_800_000_000n).toString(16)}`,
    };
  }
  if (method === "eth_call") {
    const [callTx] = list;
    const to = isObj(callTx) ? str(callTx["to"]) : "";
    const data = isObj(callTx) && isHex(callTx["data"]) ? callTx["data"] : "0x";
    seen.push({ method, to, height: str(list[1]) });
    const decoded = decodeFunctionData({ abi: ABIS, data });
    const out = answers.call?.({
      to,
      functionName: decoded.functionName,
      args: decoded.args,
    });
    if (out === undefined) {
      throw new Error(`unmocked call ${decoded.functionName} on ${to}`);
    }
    return out;
  }
  if (method === "eth_getCode") {
    seen.push({ method, to: str(list[0]), height: str(list[1]) });
    return answers.code?.(str(list[0]), str(list[1])) ?? "0x";
  }
  if (method === "eth_getTransactionCount") {
    seen.push({ method, to: str(list[0]), height: str(list[1]) });
    return `0x${(answers.nonce?.(str(list[0])) ?? 0n).toString(16)}`;
  }
  throw new Error(`unmocked ${method}`);
};

const client = (answers: Answers, seen: Seen[] = []): PublicClient =>
  createPublicClient({
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) =>
        Promise.resolve(answer(answers, seen, method, params)),
    }),
  });

const uint = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
const addr = (value: string): string => `0x${value.slice(2).padStart(64, "0")}`;

/** NFT reads: getApproved + ownerOf for the scripted owner. */
const nftCall = (approved: string, owner: string) => (call: Call) => {
  if (call.functionName === "getApproved") {
    return addr(approved);
  }
  if (call.functionName === "ownerOf") {
    return addr(owner);
  }
  return undefined;
};

const approvedForAll = (value: boolean) => (call: Call) =>
  call.functionName === "isApprovedForAll" ? uint(BigInt(value)) : undefined;

/** Permit2 allowance plus the token's allowance to Permit2 and balance. */
const permit2Call =
  (amount: bigint, expiration: number, tokenAllowance: bigint, balance: bigint) => (call: Call) => {
    if (
      call.to.toLowerCase() === PERMIT2_ADDRESS.toLowerCase() &&
      call.functionName === "allowance"
    ) {
      return encodeFunctionResult({
        abi: PERMIT2_ABI,
        functionName: "allowance",
        result: [amount, expiration, 0],
      });
    }
    return erc20Call(tokenAllowance, balance)(call);
  };

const nonceFor = (address: string, value: bigint) => (a: string) =>
  a.toLowerCase() === address.toLowerCase() ? value : 0n;

const erc20Call = (allowance: bigint, balance: bigint) => (call: Call) =>
  call.functionName === "allowance"
    ? uint(allowance)
    : call.functionName === "balanceOf"
      ? uint(balance)
      : undefined;

const deps = (
  primary: PublicClient,
  independent:
    | { kind: "available"; client: PublicClient }
    | { kind: "unavailable" }
    | { kind: "not-needed" },
): EvmReadDeps =>
  ({
    networks: {
      client: () => primary,
      independentClient: () => independent,
    },
    token: async () => Promise.resolve({ symbol: "TKN", decimals: 18 }),
    known: () => [],
  }) as EvmReadDeps;

const available = (c: PublicClient) => ({
  kind: "available" as const,
  source: "host" as const,
  client: c,
});
const unavailable = { kind: "unavailable" as const };

const claimed = (...candidates: Candidate[]) =>
  gatherCandidates(candidates.map((candidate) => ({ candidate, source: "gateway" as const })));

const row = (rows: ReadonlyArray<ApprovalRow>, kind: ApprovalRow["kind"]) =>
  rows.find((r) => r.kind === kind);

/** Narrows a row to the variants carrying `field` — union narrowing in tests. */
const has = <F extends string>(
  r: ApprovalRow | undefined,
  f: F,
): (ApprovalRow & Record<F, unknown>) | undefined => (r !== undefined && f in r ? r : undefined);

describe("evm approvals reads", () => {
  it("a candidate the chain shows inactive is dropped, never shown", async () => {
    const seen: Seen[] = [];
    const primary = client({ call: erc20Call(0n, 500n) }, seen);
    const result = await evmApprovals(
      deps(primary, unavailable),
      NETWORK,
      OWNER,
      claimed({ kind: "erc20", token: TOKEN, spender: SPENDER }),
    );
    expect(result.rows).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });

  it("candidates beyond the probe cap count unread and keep their claim", async () => {
    const spenders = Array.from(
      { length: EVM_PROBE_MAX + 1 },
      (_, i) => `0x${String(i + 1).padStart(40, "0")}`,
    );
    const overflow = spenders[EVM_PROBE_MAX]!;
    const result = await evmApprovals(
      deps(client({ call: erc20Call(0n, 500n) }), unavailable),
      NETWORK,
      OWNER,
      claimed(...spenders.map((spender) => ({ kind: "erc20" as const, token: TOKEN, spender }))),
    );
    expect(result.unread).toBe(1);
    expect(result.keep).toContain(candidateKey({ kind: "erc20", token: TOKEN, spender: overflow }));
    expect(result.dropped).toBe(EVM_PROBE_MAX);
  });

  it("the primary lying about an allowance while the host says zero is disputed", async () => {
    const primary = client({ call: erc20Call(100n, 500n) });
    const independent = client({ call: erc20Call(0n, 500n) });
    const result = await evmApprovals(
      deps(primary, available(independent)),
      NETWORK,
      OWNER,
      claimed({ kind: "erc20", token: TOKEN, spender: SPENDER }),
    );
    expect(result.rows).toHaveLength(0);
    expect(result.disputed).toBe(1);
  });

  it("agreeing reads show the weaker values, verified", async () => {
    const primary = client({ call: erc20Call(100n, 500n) });
    const independent = client({ call: erc20Call(60n, 400n) });
    const result = await evmApprovals(
      deps(primary, available(independent)),
      NETWORK,
      OWNER,
      claimed({ kind: "erc20", token: TOKEN, spender: SPENDER }),
    );
    const shown = row(result.rows, "erc20");
    expect(shown?.verified).toBe(true);
    expect(has(shown, "amount")?.amount).toBe("60");
    expect(has(shown, "exposure")?.exposure).toBe("60");
    expect(result.unverified).toBe(0);
  });

  it("an unlimited allowance carries the flag and balance-bounded exposure", async () => {
    const primary = client({ call: erc20Call(MAX_UINT256, 500n) });
    const result = await evmApprovals(
      deps(primary, unavailable),
      NETWORK,
      OWNER,
      claimed({ kind: "erc20", token: TOKEN, spender: SPENDER }),
    );
    const shown = row(result.rows, "erc20");
    expect(has(shown, "unlimited")?.unlimited).toBe(true);
    expect(shown?.risk).toContain("unlimited");
    expect(has(shown, "exposure")?.exposure).toBe("500");
  });

  it("an nft row's spender comes from the chain read, not the candidate", async () => {
    const primary = client({
      call: nftCall(OTHER, OWNER),
    });
    const result = await evmApprovals(
      deps(primary, unavailable),
      NETWORK,
      OWNER,
      claimed({ kind: "erc721", token: NFT, spender: SPENDER, tokenId: "7" }),
    );
    const shown = row(result.rows, "nft");
    expect(has(shown, "spender")?.spender).toBe(OTHER);
  });

  it("an nft transferred away drops", async () => {
    const primary = client({
      call: nftCall(SPENDER, OTHER),
    });
    const result = await evmApprovals(
      deps(primary, unavailable),
      NETWORK,
      OWNER,
      claimed({ kind: "erc721", token: NFT, spender: SPENDER, tokenId: "7" }),
    );
    expect(result.rows).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });

  it("an operator read is corroborated — a disagreeing second endpoint disputes it", async () => {
    const result = await evmApprovals(
      deps(
        client({ call: approvedForAll(true) }),
        available(client({ call: approvedForAll(false) })),
      ),
      NETWORK,
      OWNER,
      claimed({ kind: "operator", token: NFT, operator: OPERATOR }),
    );
    expect(result.rows).toHaveLength(0);
    expect(result.disputed).toBe(1);
  });

  it("an expired Permit2 allowance drops", async () => {
    const primary = client({
      timestamp: 1_800_000_000n,
      call: permit2Call(100n, 1_700_000_000, 100n, 500n),
    });
    const result = await evmApprovals(
      deps(primary, unavailable),
      NETWORK,
      OWNER,
      claimed({ kind: "permit2", token: TOKEN, spender: SPENDER }),
    );
    expect(result.rows).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });

  it("Permit2 exposure is capped by the token's allowance to Permit2", async () => {
    const primary = client({
      timestamp: 1_800_000_000n,
      call: permit2Call(1000n, 1_900_000_000, 50n, 500n),
    });
    const result = await evmApprovals(
      deps(primary, unavailable),
      NETWORK,
      OWNER,
      claimed({ kind: "permit2", token: TOKEN, spender: SPENDER }),
    );
    const shown = row(result.rows, "permit2");
    expect(has(shown, "amount")?.amount).toBe("1000");
    expect(has(shown, "exposure")?.exposure).toBe("50");
  });

  it("our 7702 delegation is ours; a foreign one flags foreign-delegation", async () => {
    const designator = (target: string) => `0xef0100${target.slice(2).toLowerCase()}`;
    const oursResult = await evmApprovals(
      deps(client({ code: () => designator(EVM_DELEGATOR.address) }), unavailable),
      NETWORK,
      OWNER,
      [],
    );
    const ours = row(oursResult.rows, "delegation");
    expect(has(ours, "ours")?.ours).toBe(true);

    const foreignResult = await evmApprovals(
      deps(client({ code: () => designator(OTHER) }), unavailable),
      NETWORK,
      OWNER,
      [],
    );
    const foreign = row(foreignResult.rows, "delegation");
    expect(has(foreign, "ours")?.ours).toBe(false);
    expect(foreign?.risk).toContain("foreign-delegation");
  });

  it("a spender with no code and a nonce is eoa-spender; without one, spender-no-code", async () => {
    const eoa = await evmApprovals(
      deps(
        client({
          call: erc20Call(1n, 5n),
          nonce: nonceFor(SPENDER, 2n),
        }),
        unavailable,
      ),
      NETWORK,
      OWNER,
      claimed({ kind: "erc20", token: TOKEN, spender: SPENDER }),
    );
    expect(row(eoa.rows, "erc20")?.risk).toContain("eoa-spender");

    const dead = await evmApprovals(
      deps(client({ call: erc20Call(1n, 5n) }), unavailable),
      NETWORK,
      OWNER,
      claimed({ kind: "erc20", token: TOKEN, spender: SPENDER }),
    );
    expect(row(dead.rows, "erc20")?.risk).toContain("spender-no-code");

    const contract = await evmApprovals(
      deps(client({ call: erc20Call(1n, 5n), code: () => "0x6001" }), unavailable),
      NETWORK,
      OWNER,
      claimed({ kind: "erc20", token: TOKEN, spender: SPENDER }),
    );
    const shown = row(contract.rows, "erc20");
    expect(shown?.risk).not.toContain("eoa-spender");
    expect(shown?.risk).not.toContain("spender-no-code");
  });

  it("every read names the same block height — the minimum of both heads", async () => {
    const seen: Seen[] = [];
    const primary = client({ head: 100n, call: erc20Call(100n, 500n) }, seen);
    const independentSeen: Seen[] = [];
    const independent = client({ head: 90n, call: erc20Call(60n, 400n) }, independentSeen);
    await evmApprovals(
      deps(primary, available(independent)),
      NETWORK,
      OWNER,
      claimed({ kind: "erc20", token: TOKEN, spender: SPENDER }),
    );
    const heights = [...seen, ...independentSeen]
      .map((entry) => entry.height)
      .filter((h): h is string => h !== undefined);
    expect(heights.length).toBeGreaterThan(0);
    expect(new Set(heights)).toStrictEqual(new Set(["0x5a"])); // min(100, 90) = 90 = 0x5a
  });

  it("an independent endpoint that cannot answer a head leaves every row unverified", async () => {
    const primary = client({ call: erc20Call(100n, 500n) });
    const dead = client({ down: true });
    const result = await evmApprovals(
      deps(primary, available(dead)),
      NETWORK,
      OWNER,
      claimed({ kind: "erc20", token: TOKEN, spender: SPENDER }),
    );
    const shown = row(result.rows, "erc20");
    expect(shown?.verified).toBe(false);
    expect(result.unverified).toBe(1);
  });
});
