import * as z from "zod/mini";

import {
  APPROVAL_CANDIDATES_MAX,
  accepts,
  approvalsResponse,
} from "@qntx/wallet-engine/gateway/contract";
import type { ApprovalCandidate, ApprovalsResponse } from "@qntx/wallet-engine/gateway/contract";

import { rpcCost } from "../budget/costs.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import type { ResolvedNetwork } from "../middleware/network.ts";
import type { ResolvedProvider } from "../types.ts";
import type { Forwarded, Forwarder, Meter, Send } from "./forward.ts";
import { ProviderFailure, REFUSED_STATUSES, REQUEST_ERROR_STATUSES } from "./forward.ts";

/**
 * Approval-discovery over `eth_getLogs` on the same Alchemy endpoint and auth the network's RPC
 * already uses — no new secret. The route reports CANDIDATES (which token, whose approval, at which
 * block) so the engine can confirm each one on chain; a stale or superseded event costs a
 * confirmation read, never a wrong answer.
 */

/**
 * Keccak256 of the event signatures the scan filters on (the tests recompute them with viem):
 *
 * - `Approval(address indexed owner, address indexed spender, uint256)` — ERC-20 amount and ERC-721
 *   `approve(spender, tokenId)` share the selector; the topic count tells them apart.
 * - `ApprovalForAll(address indexed owner, address indexed operator, bool)` — ERC-721/1155.
 * - Permit2 `Approval(address indexed owner, address indexed token, address indexed spender, uint160
 *   amount, uint48 expiration)` — IAllowanceTransfer.
 * - Permit2 `Permit(address indexed owner, address indexed token, address indexed spender, uint160
 *   amount, uint48 expiration, uint48 nonce)`.
 */
const TOPIC_APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const TOPIC_APPROVAL_FOR_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const TOPIC_PERMIT2_APPROVAL = "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b";
const TOPIC_PERMIT2_PERMIT = "0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec";

/** The canonical Permit2 AllowanceTransfer deploy — the same address on every EVM chain. */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * Chains where Alchemy's `eth_getLogs` accepts an unbounded block range on Pay-As-You-Go
 * (https://www.alchemy.com/docs/reference/eth-getlogs, 2026-11-23: Ethereum, Base, Optimism,
 * Arbitrum, Polygon, Worldchain, BNB, Robinhood, HyperEVM, Monad, Tempo, Sei; 10,000 blocks
 * elsewhere) intersected with the gateway's configured networks — Tempo is not served, and a
 * range-bounded chain would silently truncate the scan. A served EVM network absent here answers
 * 404 `unsupported` without an upstream call.
 */
const LOGS_UNBOUNDED_CHAINS: ReadonlySet<number> = new Set([
  1, 8453, 10, 42161, 137, 480, 56, 4663, 999, 143, 1329,
]);

/**
 * One page of `eth_getLogs` can run large on a busy address; 8 MiB leaves headroom. A larger answer
 * is the address's own (its events produced it), so it is the request's 400, never an outage —
 * `readCapped` enforces it inside the forwarder.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const HEX = /^0x[0-9a-fA-F]+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOPIC32 = /^0x[0-9a-fA-F]{64}$/;
/** A 32-byte topic holding an address: 12 zero bytes then 20 hex bytes. */
const ADDRESS_TOPIC = /^0x0{24}[0-9a-fA-F]{40}$/;

/** The network's Alchemy providers re-labelled so approvals failures never open the RPC breaker. */
export const approvalsProviders = (network: ResolvedNetwork): ReadonlyArray<ResolvedProvider> => {
  const out: ResolvedProvider[] = [];
  const chainId = Number(network.id.split(":")[1]);
  if (!LOGS_UNBOUNDED_CHAINS.has(chainId)) {
    return out;
  }
  for (const provider of network.providers) {
    if (provider.id === "alchemy") {
      out.push({ ...provider, id: "alchemy-approvals" });
    }
  }
  return out;
};

const upstreamResponse = z.looseObject({
  result: z.optional(z.unknown()),
  error: z.optional(z.unknown()),
});

/** One upstream JSON-RPC call; `result` itself is the caller's to interpret. */
const call = async (
  send: Send,
  provider: ResolvedProvider,
  method: string,
  params: ReadonlyArray<unknown>,
): Promise<unknown> => {
  const response = await send({
    url: provider.url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cost: rpcCost(provider.costs, { method, params }),
  });
  if (!response.ok) {
    if (REQUEST_ERROR_STATUSES.has(response.status)) {
      throw new GatewayHttpError(400, "invalid-request");
    }
    throw new ProviderFailure(`status-${response.status}`, REFUSED_STATUSES.has(response.status));
  }
  const text = await response.text(MAX_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderFailure("malformed", false);
  }
  const body = z.safeParse(upstreamResponse, parsed);
  if (!body.success) {
    throw new ProviderFailure("malformed", false);
  }
  if (body.data.error !== undefined) {
    throw new ProviderFailure("rpc-error", false);
  }
  if (body.data.result === undefined) {
    throw new ProviderFailure("malformed", false);
  }
  return body.data.result;
};

/** A log the scan can interpret — the fields it needs, each strictly checked. */
type RawLog = {
  /** The emitting contract, lowercased. */
  readonly address: string;
  readonly topics: ReadonlyArray<string>;
  readonly block: bigint;
};

/**
 * Reads `value` as a raw log: the emitting contract, strictly 32-byte topics, the block, and not
 * `removed` (a reorged-out event). Anything malformed is dropped — never thrown, never trusted.
 */
const rawLog = (value: unknown): RawLog | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["removed"] !== false && value["removed"] !== undefined) {
    return undefined;
  }
  const { address, topics, blockNumber } = value;
  if (
    typeof address !== "string" ||
    !EVM_ADDRESS.test(address) ||
    typeof blockNumber !== "string" ||
    !HEX.test(blockNumber) ||
    !Array.isArray(topics) ||
    topics.length === 0 ||
    !topics.every((topic): topic is string => typeof topic === "string" && TOPIC32.test(topic))
  ) {
    return undefined;
  }
  return { address: address.toLowerCase(), topics, block: BigInt(blockNumber) };
};

/** The address an indexed topic holds, lowercased — `undefined` when the padding is not zero. */
const topicAddress = (topic: string | undefined): string | undefined =>
  topic !== undefined && ADDRESS_TOPIC.test(topic)
    ? `0x${topic.slice(26).toLowerCase()}`
    : undefined;

/** The candidates one log contributes for the scanned topic0, empty when it cannot be read. */
const mapLog = (log: RawLog): ReadonlyArray<ApprovalCandidate> => {
  // topic1 is the owner the filter asked for — only the later indexed arguments carry keys.
  const [selector, , indexed2, indexed3] = log.topics;
  const topic0 = selector?.toLowerCase();
  const block = log.block.toString(10);
  if (topic0 === TOPIC_APPROVAL) {
    const spender = topicAddress(indexed2);
    if (spender === undefined) {
      return [];
    }
    // ERC-20's Approval indexes two arguments; ERC-721's indexes three (the third is the tokenId).
    if (log.topics.length === 3) {
      return [{ kind: "erc20", token: log.address, spender, block }];
    }
    if (log.topics.length === 4 && indexed3 !== undefined) {
      return [
        {
          kind: "erc721",
          token: log.address,
          spender,
          tokenId: BigInt(indexed3).toString(10),
          block,
        },
      ];
    }
    return [];
  }
  if (topic0 === TOPIC_APPROVAL_FOR_ALL) {
    const operator = topicAddress(indexed2);
    return log.topics.length === 3 && operator !== undefined
      ? [{ kind: "operator", token: log.address, operator, block }]
      : [];
  }
  if (topic0 === TOPIC_PERMIT2_APPROVAL || topic0 === TOPIC_PERMIT2_PERMIT) {
    const token = topicAddress(indexed2);
    const spender = topicAddress(indexed3);
    return log.topics.length === 4 && token !== undefined && spender !== undefined
      ? [{ kind: "permit2", token, spender, block }]
      : [];
  }
  return [];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The dedupe key a candidate shares with every later event about the same approval. */
const keyOf = (candidate: ApprovalCandidate): string => {
  switch (candidate.kind) {
    case "erc721":
      // One token id carries one approved spender at a time — the latest event wins.
      return `erc721:${candidate.token}:${candidate.tokenId}`;
    case "operator":
      return `operator:${candidate.token}:${candidate.operator}`;
    default:
      return `${candidate.kind}:${candidate.token}:${candidate.spender}`;
  }
};

const blockOf = (candidate: ApprovalCandidate): bigint => BigInt(candidate.block);

/**
 * Dedupes to one row per key (the highest block wins), newest block first, then the cap:
 * `truncated` reports a scan that found more keys than one response carries.
 */
const collect = (
  candidates: ReadonlyArray<ApprovalCandidate>,
): { readonly candidates: ApprovalCandidate[]; readonly truncated: boolean } => {
  const byKey = new Map<string, ApprovalCandidate>();
  for (const candidate of candidates) {
    const key = keyOf(candidate);
    const kept = byKey.get(key);
    if (kept === undefined || blockOf(candidate) > blockOf(kept)) {
      byKey.set(key, candidate);
    }
  }
  const ordered = [...byKey.values()].toSorted((a, b) =>
    a.block === b.block ? keyOf(a).localeCompare(keyOf(b)) : Number(blockOf(b) - blockOf(a)),
  );
  return {
    candidates: ordered.slice(0, APPROVAL_CANDIDATES_MAX),
    truncated: ordered.length > APPROVAL_CANDIDATES_MAX,
  };
};

/** An address as its eth_getLogs topic1 form: 12 zero bytes then the 20 address bytes. */
const ownerTopic = (address: string): string =>
  `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

/**
 * One discovery scan: `eth_blockNumber` fixes the head the answer names, then four parallel
 * `eth_getLogs` from genesis collect every approval-shaped event the owner emitted. The engine
 * confirms each candidate on chain — this route never reports an amount or a live flag.
 */
export const alchemyApprovalCandidates = async (
  forwarder: Forwarder,
  providers: ReadonlyArray<ResolvedProvider>,
  params: { readonly address: string },
  /** Pays each call's compute-unit price against the client's share of the Alchemy account. */
  meter: Meter,
  log: (line: string) => void,
): Promise<Forwarded<ApprovalsResponse>> =>
  forwarder.run(
    providers,
    async (send, provider) => {
      const head = await call(send, provider, "eth_blockNumber", []);
      if (typeof head !== "string" || !HEX.test(head)) {
        throw new ProviderFailure("malformed", false);
      }
      const owner = ownerTopic(params.address);
      const filters: ReadonlyArray<Record<string, unknown>> = [
        { fromBlock: "0x0", toBlock: head, topics: [TOPIC_APPROVAL, owner] },
        { fromBlock: "0x0", toBlock: head, topics: [TOPIC_APPROVAL_FOR_ALL, owner] },
        {
          address: PERMIT2,
          fromBlock: "0x0",
          toBlock: head,
          topics: [TOPIC_PERMIT2_APPROVAL, owner],
        },
        {
          address: PERMIT2,
          fromBlock: "0x0",
          toBlock: head,
          topics: [TOPIC_PERMIT2_PERMIT, owner],
        },
      ];
      const pages = await Promise.all(
        filters.map(async (filter) => call(send, provider, "eth_getLogs", [filter])),
      );
      const candidates: ApprovalCandidate[] = [];
      for (const page of pages) {
        if (!Array.isArray(page)) {
          throw new ProviderFailure("malformed", false);
        }
        for (const entry of page) {
          const log = rawLog(entry);
          if (log !== undefined) {
            candidates.push(...mapLog(log));
          }
        }
      }
      const { candidates: kept, truncated } = collect(candidates);
      if (truncated) {
        log(JSON.stringify({ event: "approvals-truncated" }));
      }
      const value: ApprovalsResponse = {
        toBlock: BigInt(head).toString(10),
        candidates: kept,
        truncated,
      };
      if (!accepts(approvalsResponse, value)) {
        throw new ProviderFailure("malformed", false);
      }
      return value;
    },
    { meter },
  );
