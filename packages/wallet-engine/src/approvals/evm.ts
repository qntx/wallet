/**
 * EVM chain reads. Every row is read at one height H — the minimum of the primary and the
 * corroborating head — so both sides answer for the same state. Candidates cap at {@link PROBE_MAX}
 * per refresh (newest first, the overflow counts `unread`) and probe {@link PROBE_CONCURRENCY} at a
 * time. The 7702 delegation row needs no candidate: `eth_getCode` on the owner enumerates it (the
 * view's `exhaustive` kind).
 */
import { erc20Abi, erc721Abi, getAddress } from "viem";
import type { PublicClient } from "viem";

import {
  EVM_DELEGATION_PREFIX,
  EVM_DELEGATOR,
  MAX_UINT256,
  PERMIT2_ADDRESS,
  checksumEvmAddress,
} from "@qntx/wallet-chains/evm";

import type { NetworkController } from "../networks/controller.ts";
import { mapPool } from "../pool.ts";
import { corroborate } from "./corroborate.ts";
import type { Corroborated, ReadResult } from "./corroborate.ts";
import { assessRow } from "./risk.ts";
import type { Candidate, GatheredCandidate } from "./sources.ts";
import { candidateKey } from "./sources.ts";
import type { ApprovalKind, ApprovalRisk, ApprovalRow, TokenRef } from "./types.ts";

/** Candidates probed per refresh; the rest count as `unread`. */
export const EVM_PROBE_MAX = 300;
const PROBE_CONCURRENCY = 6;
/** Permit2 amounts are uint160 — `unlimited` mirrors the kernel's definition. */
const UINT160_MAX = 2n ** 160n - 1n;
const ZERO = "0x0000000000000000000000000000000000000000";

/** Permit2 `allowance(owner, token, spender)` → (amount, expiration, nonce). */
const PERMIT2_ALLOWANCE_ABI = [
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

export type EvmReadDeps = {
  readonly networks: Pick<NetworkController, "client" | "independentClient">;
  /** Token display metadata — built-in table, then the host's read; `{}` on failure. */
  readonly token: (address: string) => Promise<Pick<TokenRef, "symbol" | "decimals">>;
  /** The engine's known EVM addresses — address book + paid recipients. */
  readonly known: () => ReadonlyArray<string>;
};

export type ChainResult = {
  readonly rows: ReadonlyArray<ApprovalRow>;
  readonly at: { readonly height: string; readonly time?: number };
  readonly exhaustive: ReadonlyArray<ApprovalKind>;
  readonly dropped: number;
  readonly disputed: number;
  readonly unread: number;
  readonly unverified: number;
  /** Candidate keys that were active or unresolved — the set the controller persists. */
  readonly keep: ReadonlyArray<string>;
};

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

const readAllowance = async (
  client: PublicClient,
  token: string,
  owner: string,
  spender: string,
  height: bigint,
): Promise<bigint> =>
  client.readContract({
    address: getAddress(token),
    abi: erc20Abi,
    functionName: "allowance",
    args: [getAddress(owner), getAddress(spender)],
    blockNumber: height,
  });

const readBalance = async (
  client: PublicClient,
  token: string,
  owner: string,
  height: bigint,
): Promise<bigint> =>
  client.readContract({
    address: getAddress(token),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(owner)],
    blockNumber: height,
  });

type Erc20Read = { readonly allowance: bigint; readonly balance: bigint };

const readErc20 = async (
  client: PublicClient,
  token: string,
  spender: string,
  owner: string,
  height: bigint,
): Promise<ReadResult<Erc20Read>> => {
  const [allowance, balance] = await Promise.all([
    readAllowance(client, token, owner, spender, height),
    readBalance(client, token, owner, height),
  ]);
  return allowance === 0n
    ? { kind: "inactive" }
    : { kind: "active", value: { allowance, balance } };
};

/** The timestamp of `height` — the raw call keeps the answer shape minimal (number+timestamp). */
const blockTimestamp = async (client: PublicClient, height: bigint): Promise<number> => {
  const raw: unknown = await client.transport.request({
    method: "eth_getBlockByNumber",
    params: [`0x${height.toString(16)}`, false],
  });
  const timestamp = isObj(raw) ? raw["timestamp"] : undefined;
  if (typeof timestamp !== "string") {
    throw new TypeError("eth_getBlockByNumber answered without a timestamp");
  }
  return Number(BigInt(timestamp));
};

type Permit2Read = {
  readonly amount: bigint;
  readonly expiration: number;
  readonly tokenAllowance: bigint;
  readonly balance: bigint;
};

const readPermit2 = async (
  client: PublicClient,
  token: string,
  spender: string,
  owner: string,
  height: bigint,
): Promise<ReadResult<Permit2Read>> => {
  const [row, timestamp, tokenAllowance, balance] = await Promise.all([
    client.readContract({
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [getAddress(owner), getAddress(token), getAddress(spender)],
      blockNumber: height,
    }),
    blockTimestamp(client, height),
    readAllowance(client, token, owner, PERMIT2_ADDRESS, height),
    readBalance(client, token, owner, height),
  ]);
  const [amount, expiration] = row;
  return amount === 0n || expiration < timestamp
    ? { kind: "inactive" }
    : {
        kind: "active",
        value: { amount, expiration, tokenAllowance, balance },
      };
};

type SpenderRead = { readonly spender: string };

/** ERC-721: the approval is live only while the chain names a spender and owner still holds. */
const readNft = async (
  client: PublicClient,
  contract: string,
  tokenId: string,
  owner: string,
  height: bigint,
): Promise<ReadResult<SpenderRead>> => {
  const [approved, holder] = await Promise.all([
    client.readContract({
      address: getAddress(contract),
      abi: erc721Abi,
      functionName: "getApproved",
      args: [BigInt(tokenId)],
      blockNumber: height,
    }),
    client.readContract({
      address: getAddress(contract),
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
      blockNumber: height,
    }),
  ]);
  return sameAddress(approved, ZERO) || !sameAddress(holder, owner)
    ? { kind: "inactive" }
    : { kind: "active", value: { spender: checksumEvmAddress(approved) } };
};

const readOperator = async (
  client: PublicClient,
  contract: string,
  operator: string,
  owner: string,
  height: bigint,
): Promise<ReadResult<true>> => {
  const approved = await client.readContract({
    address: getAddress(contract),
    abi: erc721Abi,
    functionName: "isApprovedForAll",
    args: [getAddress(owner), getAddress(operator)],
    blockNumber: height,
  });
  return approved ? { kind: "active", value: true } : { kind: "inactive" };
};

type DelegationRead = { readonly address: string };

/** The owner's 7702 delegation: the designator's target, `inactive` for any other code. */
const readDelegation = async (
  client: PublicClient,
  owner: string,
  height: bigint,
): Promise<ReadResult<DelegationRead>> => {
  const code = await client.getCode({ address: getAddress(owner), blockNumber: height });
  const designator =
    code !== undefined &&
    code !== "0x" &&
    code.toLowerCase().startsWith(EVM_DELEGATION_PREFIX) &&
    code.length === 48;
  if (!designator) {
    return { kind: "inactive" };
  }
  return { kind: "active", value: { address: checksumEvmAddress(`0x${code.slice(8)}`) } };
};

/** What the spender's own address is: contract, EOA, or nothing — primary read, best-effort. */
const spenderProbe = async (
  client: PublicClient,
  spender: string,
  height: bigint,
): Promise<"eoa" | "no-code" | "contract" | "unknown"> => {
  try {
    const code = await client.getCode({ address: getAddress(spender), blockNumber: height });
    if (code !== undefined && code !== "0x") {
      /* A 7702 designator means the spender is an EOA that delegated — still a key, not a
         contract's own logic. */
      return code.toLowerCase().startsWith(EVM_DELEGATION_PREFIX) && code.length === 48
        ? "eoa"
        : "contract";
    }
    const nonce = await client.getTransactionCount({
      address: getAddress(spender),
      blockNumber: height,
    });
    return nonce > 0 ? "eoa" : "no-code";
  } catch {
    return "unknown";
  }
};

const sorted = (rows: ReadonlyArray<ApprovalRow>): ApprovalRow[] =>
  [...rows].sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1));

type KindOf<K extends Candidate["kind"]> = Extract<Candidate, { readonly kind: K }>;

/** A probed candidate with the verdict typed by `kind` — `value` needs no assertion. */
type Probed =
  | {
      readonly kind: "erc20";
      readonly gathered: GatheredCandidate;
      readonly candidate: KindOf<"erc20">;
      readonly verdict: Corroborated<Erc20Read>;
    }
  | {
      readonly kind: "permit2";
      readonly gathered: GatheredCandidate;
      readonly candidate: KindOf<"permit2">;
      readonly verdict: Corroborated<Permit2Read>;
    }
  | {
      readonly kind: "operator";
      readonly gathered: GatheredCandidate;
      readonly candidate: KindOf<"operator">;
      readonly verdict: Corroborated<true>;
    }
  | {
      readonly kind: "erc721";
      readonly gathered: GatheredCandidate;
      readonly candidate: KindOf<"erc721">;
      readonly verdict: Corroborated<SpenderRead>;
    }
  | {
      readonly kind: "other";
      readonly gathered: GatheredCandidate;
      readonly candidate: KindOf<"trc20"> | KindOf<"stake">;
      readonly verdict: { readonly kind: "dropped" };
    };

/**
 * The view's chain half: head first, then the always-read delegation, then every candidate through
 * the corroborate rule. A thrown head read fails the refresh — no chain read is possible at all.
 */
export const evmApprovals = async (
  deps: EvmReadDeps,
  network: string,
  owner: string,
  candidates: ReadonlyArray<GatheredCandidate>,
  minHeight?: bigint,
): Promise<ChainResult> => {
  const primary = deps.networks.client(network);
  const independent = deps.networks.independentClient(network);
  const primaryHead = await primary.getBlockNumber();
  let head = primaryHead;
  let independentFailed = false;
  if (independent.kind === "available") {
    try {
      const secondaryHead = await independent.client.getBlockNumber();
      head = primaryHead < secondaryHead ? primaryHead : secondaryHead;
    } catch {
      // The corroborator cannot answer at any height — every row it could have proven stays unverified.
      independentFailed = true;
    }
  }
  /* A refresh triggered by a just-confirmed send must see that send's block even when a polled
   * head still lags it — reads at a height both sides can serve stay corroboratable. */
  if (minHeight !== undefined && head < minHeight) {
    head = minHeight;
  }
  const at = {
    height: head.toString(10),
    time: (await blockTimestamp(primary, head)) * 1000,
  };
  const height = head;

  const run = async <V>(
    read: (client: PublicClient) => Promise<ReadResult<V>>,
    merge: (a: V, b: V) => V | undefined,
  ) =>
    corroborate(
      independentFailed ? { kind: "unavailable" } : independent,
      async () => read(primary),
      async (client) => read(client),
      merge,
    );

  const rows: ApprovalRow[] = [];
  const keep: string[] = [];
  let dropped = 0;
  let disputed = 0;
  let unread = 0;
  let unverified = 0;
  const spenders = new Map<string, string>();

  /* 7702 delegation is chain-enumerated: it always exists as a probe, candidate or not. */
  const delegationVerdict = await run(
    async (client) => readDelegation(client, owner, height),
    (a, b) => (sameAddress(a.address, b.address) ? a : undefined),
  );
  if (delegationVerdict.kind === "shown") {
    if (!delegationVerdict.verified) {
      unverified += 1;
    }
    const ours = sameAddress(delegationVerdict.value.address, EVM_DELEGATOR.address);
    const risk = assessRow({
      family: "evm",
      grantee: delegationVerdict.value.address,
      foreignDelegation: !ours,
      known: deps.known(),
    });
    rows.push({
      id: "delegation",
      network,
      risk,
      verified: delegationVerdict.verified,
      sources: ["chain"],
      revoke: "single",
      kind: "delegation",
      address: delegationVerdict.value.address,
      ours,
    });
  } else if (delegationVerdict.kind === "disputed") {
    disputed += 1;
  }

  const probed = candidates.slice(0, EVM_PROBE_MAX);
  unread += candidates.length - probed.length;
  for (const { candidate } of candidates.slice(probed.length)) {
    keep.push(candidateKey(candidate));
  }

  const results = await mapPool(probed, PROBE_CONCURRENCY, async (gathered): Promise<Probed> => {
    const { candidate } = gathered;
    if (candidate.kind === "erc20") {
      const verdict = await run(
        async (client) => readErc20(client, candidate.token, candidate.spender, owner, height),
        (a, b) => ({
          allowance: minBig(a.allowance, b.allowance),
          balance: minBig(a.balance, b.balance),
        }),
      );
      return { kind: "erc20", gathered, candidate, verdict };
    }
    if (candidate.kind === "permit2") {
      const verdict = await run(
        async (client) => readPermit2(client, candidate.token, candidate.spender, owner, height),
        (a, b) => ({
          amount: minBig(a.amount, b.amount),
          expiration: Math.min(a.expiration, b.expiration),
          tokenAllowance: minBig(a.tokenAllowance, b.tokenAllowance),
          balance: minBig(a.balance, b.balance),
        }),
      );
      return { kind: "permit2", gathered, candidate, verdict };
    }
    if (candidate.kind === "operator") {
      const verdict = await run(
        async (client) => readOperator(client, candidate.token, candidate.operator, owner, height),
        (a) => a,
      );
      return { kind: "operator", gathered, candidate, verdict };
    }
    if (candidate.kind === "erc721") {
      const verdict = await run(
        async (client) => readNft(client, candidate.token, candidate.tokenId, owner, height),
        (a, b) => (sameAddress(a.spender, b.spender) ? a : undefined),
      );
      return { kind: "erc721", gathered, candidate, verdict };
    }
    // trc20 and stake candidates are not probed on EVM.
    return { kind: "other", gathered, candidate, verdict: { kind: "dropped" } };
  });

  /* First pass: classify every verdict and collect the grantees and tokens to resolve. */
  const tokens = new Set<string>();
  for (const result of results) {
    const { candidate } = result;
    if (result.verdict.kind === "dropped") {
      dropped += 1;
      continue;
    }
    keep.push(candidateKey(candidate));
    if (result.verdict.kind === "disputed") {
      disputed += 1;
      continue;
    }
    if (result.verdict.kind === "unread") {
      unread += 1;
      continue;
    }
    if (!result.verdict.verified) {
      unverified += 1;
    }
    if (result.kind === "erc20" || result.kind === "permit2") {
      tokens.add(result.candidate.token);
      spenders.set(result.candidate.spender.toLowerCase(), result.candidate.spender);
    } else if (result.kind === "operator") {
      spenders.set(result.candidate.operator.toLowerCase(), result.candidate.operator);
    } else if (result.kind === "erc721") {
      spenders.set(result.verdict.value.spender.toLowerCase(), result.verdict.value.spender);
    }
  }

  /* Spender probes run once per distinct grantee, on the primary only — they annotate rows. */
  const [probes, metadata] = await Promise.all([
    mapPool([...spenders.values()], PROBE_CONCURRENCY, async (spender) => ({
      spender: spender.toLowerCase(),
      probe: await spenderProbe(primary, spender, height),
    })),
    mapPool([...tokens], PROBE_CONCURRENCY, async (address) => ({
      address,
      meta: await deps.token(address),
    })),
  ]);
  const probeBy = new Map(probes.map((p) => [p.spender, p.probe]));
  const metaBy = new Map(metadata.map((m) => [m.address, m.meta]));
  const probeRisk = (grantee: string): ReadonlyArray<ApprovalRisk> => {
    const probe = probeBy.get(grantee.toLowerCase());
    return probe === undefined
      ? []
      : assessRow({ family: "evm", spenderProbe: probe, known: deps.known() });
  };
  const tokenOf = (address: string): TokenRef => ({
    address,
    ...metaBy.get(address),
  });

  /* Second pass: build the rows with every risk flag known. */
  for (const result of results) {
    if (result.verdict.kind !== "shown") {
      continue;
    }
    const { gathered } = result;
    const sources = [...gathered.sources].sort();
    if (result.kind === "erc20") {
      const { candidate, verdict } = result;
      const { value } = verdict;
      const unlimited = value.allowance === MAX_UINT256;
      rows.push({
        id: `erc20:${candidate.token.toLowerCase()}:${candidate.spender.toLowerCase()}`,
        network,
        risk: [
          ...assessRow({
            family: "evm",
            grantee: candidate.spender,
            unlimited,
            known: deps.known(),
          }),
          ...probeRisk(candidate.spender),
        ],
        verified: verdict.verified,
        sources,
        revoke: "batchable",
        kind: "erc20",
        token: tokenOf(candidate.token),
        spender: candidate.spender,
        amount: value.allowance.toString(10),
        unlimited,
        exposure: minBig(value.allowance, value.balance).toString(10),
      });
    } else if (result.kind === "permit2") {
      const { candidate, verdict } = result;
      const { value } = verdict;
      const unlimited = value.amount === UINT160_MAX;
      rows.push({
        id: `permit2:${candidate.token.toLowerCase()}:${candidate.spender.toLowerCase()}`,
        network,
        risk: [
          ...assessRow({
            family: "evm",
            grantee: candidate.spender,
            unlimited,
            known: deps.known(),
          }),
          ...probeRisk(candidate.spender),
        ],
        verified: verdict.verified,
        sources,
        revoke: "batchable",
        kind: "permit2",
        token: tokenOf(candidate.token),
        spender: candidate.spender,
        amount: value.amount.toString(10),
        expiration: value.expiration,
        unlimited,
        exposure: minBig(minBig(value.amount, value.tokenAllowance), value.balance).toString(10),
      });
    } else if (result.kind === "operator") {
      const { candidate, verdict } = result;
      rows.push({
        id: `operator:${candidate.token.toLowerCase()}:${candidate.operator.toLowerCase()}`,
        network,
        risk: [
          ...assessRow({ family: "evm", grantee: candidate.operator, known: deps.known() }),
          ...probeRisk(candidate.operator),
        ],
        verified: verdict.verified,
        sources,
        revoke: "batchable",
        kind: "operator",
        contract: candidate.token,
        operator: candidate.operator,
      });
    } else if (result.kind === "erc721") {
      const { candidate, verdict } = result;
      const { value } = verdict;
      rows.push({
        id: `nft:${candidate.token.toLowerCase()}:${candidate.tokenId}`,
        network,
        risk: [
          ...assessRow({ family: "evm", grantee: value.spender, known: deps.known() }),
          ...probeRisk(value.spender),
        ],
        verified: verdict.verified,
        sources,
        revoke: "batchable",
        kind: "nft",
        contract: candidate.token,
        tokenId: candidate.tokenId,
        spender: value.spender,
      });
    }
  }

  return {
    rows: sorted(rows),
    at,
    exhaustive: ["delegation"],
    dropped,
    disputed,
    unread,
    unverified,
    keep,
  };
};
