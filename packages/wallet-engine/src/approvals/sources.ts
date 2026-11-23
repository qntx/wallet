import { base64 } from "@scure/base";
/**
 * Candidate sources: every way the inventory learns that an approval MIGHT exist. Each yields keys
 * only — `sources` never returns rows, amounts or live flags; the chain reads decide.
 *
 * - Gateway EVM: the `POST /v1/approvals/:caip2` scan of the owner's Approval-shaped events.
 * - Gateway TRON: the TronGrid `/v1/accounts/transactions/trc20` indexer feed, `Approval` rows.
 * - Local: this session's tracked sends whose decoded intent grants an approval, plus the candidates
 *   persisted from earlier refreshes.
 */
import * as z from "zod/mini";

import { decodeSolanaTransaction } from "@qntx/wallet-chains/solana";

import {
  TRON_INDEXER_LIMIT_MAX,
  approvalsPath,
  approvalsResponse,
  gatewayError,
  parseWith,
  tronIndexerPageResponse,
  tronIndexerTrc20,
} from "../gateway/contract/index.ts";
import type { NetworkController } from "../networks/controller.ts";
import { readJson } from "../store/json.ts";
import { timeoutSignal } from "../timer.ts";
import type { SetTimer } from "../timer.ts";
import type { DisplayIntent, TrackedTransaction } from "../transactions/route.ts";
import type { ApprovalSourceState } from "./types.ts";

/** Candidates persisted per view. */
export const CANDIDATES_MAX = 1000;

const evmAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));
const base58ish = z.string().check(z.minLength(1));
const decimal = z.string().check(z.regex(/^(0|[1-9][0-9]*)$/));

/**
 * One approval-shaped key a source claims. `erc721` carries the token id the event named; the row's
 * spender always comes from the chain read, never the candidate.
 */
export type Candidate =
  | { readonly kind: "erc20"; readonly token: string; readonly spender: string }
  | {
      readonly kind: "erc721";
      readonly token: string;
      readonly spender: string;
      readonly tokenId: string;
    }
  | { readonly kind: "operator"; readonly token: string; readonly operator: string }
  | { readonly kind: "permit2"; readonly token: string; readonly spender: string }
  | { readonly kind: "trc20"; readonly token: string; readonly spender: string }
  | { readonly kind: "stake"; readonly account: string };

const storedCandidate = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("erc20"), token: evmAddress, spender: evmAddress }),
  z.strictObject({
    kind: z.literal("erc721"),
    token: evmAddress,
    spender: evmAddress,
    tokenId: decimal,
  }),
  z.strictObject({ kind: z.literal("operator"), token: evmAddress, operator: evmAddress }),
  z.strictObject({ kind: z.literal("permit2"), token: evmAddress, spender: evmAddress }),
  z.strictObject({ kind: z.literal("trc20"), token: base58ish, spender: base58ish }),
  z.strictObject({ kind: z.literal("stake"), account: base58ish }),
]);

const storedCandidates = z.strictObject({
  candidates: z.array(storedCandidate).check(z.maxLength(CANDIDATES_MAX)),
});

/** A stored record's candidates, or `undefined` when the record is malformed — never migrated. */
export const parseStoredCandidates = (bytes: Uint8Array): ReadonlyArray<Candidate> | undefined =>
  parseWith(storedCandidates, readJson(bytes))?.candidates;

/** The record `persist` writes for one view. */
export const encodeCandidates = (candidates: ReadonlyArray<Candidate>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ candidates: candidates.slice(0, CANDIDATES_MAX) }));

/** The dedupe key of a candidate — one row per key. */
export const candidateKey = (candidate: Candidate): string => {
  if (candidate.kind === "erc721") {
    return `nft:${candidate.token.toLowerCase()}:${candidate.tokenId}`;
  }
  if (candidate.kind === "operator") {
    return `operator:${candidate.token.toLowerCase()}:${candidate.operator.toLowerCase()}`;
  }
  if (candidate.kind === "stake") {
    return `stake:${candidate.account}`;
  }
  return `${candidate.kind}:${candidate.token.toLowerCase()}:${candidate.spender.toLowerCase()}`;
};

/** A deduplicated candidate with the sources that claimed it. */
export type GatheredCandidate = {
  readonly candidate: Candidate;
  /** Ordering hint — the block (EVM) or second (TRON indexer) the source saw the event at. */
  readonly seen?: bigint;
  readonly sources: ReadonlySet<"gateway" | "local">;
};

/**
 * Merges source outputs into deduplicated candidates, newest first: gateway claims by descending
 * `seen`, then local/persisted claims (whose age is unknown) in input order.
 */
export const gatherCandidates = (
  claims: ReadonlyArray<{
    readonly candidate: Candidate;
    readonly seen?: bigint | undefined;
    readonly source: "gateway" | "local";
  }>,
): ReadonlyArray<GatheredCandidate> => {
  const byKey = new Map<string, GatheredCandidate & { sources: Set<"gateway" | "local"> }>();
  for (const claim of claims) {
    const key = candidateKey(claim.candidate);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.sources.add(claim.source);
      if (existing.seen === undefined || (claim.seen ?? 0n) > existing.seen) {
        byKey.set(key, {
          candidate: existing.candidate,
          ...(claim.seen === undefined ? {} : { seen: claim.seen }),
          sources: existing.sources,
        });
      }
      continue;
    }
    byKey.set(key, {
      candidate: claim.candidate,
      ...(claim.seen === undefined ? {} : { seen: claim.seen }),
      sources: new Set([claim.source]),
    });
  }
  const gateway = [...byKey.values()].filter((c) => c.sources.has("gateway"));
  const local = [...byKey.values()].filter((c) => !c.sources.has("gateway"));
  gateway.sort((a, b) => {
    const diff = (b.seen ?? 0n) - (a.seen ?? 0n);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });
  return [...gateway, ...local];
};

const GATEWAY_TIMEOUT_MS = 30_000;

export type GatewayFetchDeps = {
  readonly gateway: { readonly url: string; readonly fetch: typeof globalThis.fetch };
  readonly setTimer: SetTimer;
  readonly now: () => number;
  /** Lock aborts the request early. */
  readonly aborts: Set<() => void>;
};

export type SourceResult = {
  readonly status: ApprovalSourceState["status"];
  readonly at?: number;
  readonly toBlock?: string;
  readonly candidates: ReadonlyArray<{ readonly candidate: Candidate; readonly seen?: bigint }>;
};

const unsupported = (body: unknown): boolean =>
  parseWith(gatewayError, body)?.error === "unsupported";

/** The EVM approvals scan on the gateway — keys only, never trusted. */
export const evmGatewayCandidates = async (
  deps: GatewayFetchDeps,
  network: string,
  owner: string,
): Promise<SourceResult> => {
  const bound = timeoutSignal(GATEWAY_TIMEOUT_MS, deps.setTimer);
  deps.aborts.add(bound.abort);
  try {
    const res = await deps.gateway.fetch(
      `${deps.gateway.url.replace(/\/+$/, "")}${approvalsPath(network)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: owner }),
        signal: bound.signal,
      },
    );
    if (!res.ok) {
      if (res.status === 404 && unsupported(await res.json().catch(() => undefined))) {
        return { status: "unsupported", candidates: [] };
      }
      return { status: "failed", candidates: [] };
    }
    const body = parseWith(approvalsResponse, await res.json().catch(() => undefined));
    if (body === undefined) {
      return { status: "failed", candidates: [] };
    }
    return {
      status: body.truncated ? "truncated" : "ok",
      at: deps.now(),
      toBlock: body.toBlock,
      candidates: body.candidates.map((c) => ({
        candidate:
          c.kind === "erc721"
            ? { kind: "erc721", token: c.token, spender: c.spender, tokenId: c.tokenId }
            : c.kind === "operator"
              ? { kind: "operator", token: c.token, operator: c.operator }
              : { kind: c.kind, token: c.token, spender: c.spender },
        seen: BigInt(c.block),
      })),
    };
  } catch {
    return { status: "failed", candidates: [] };
  } finally {
    bound.cancel();
    deps.aborts.delete(bound.abort);
  }
};

const TRON_INDEXER_PAGES_MAX = 5;

/**
 * The TronGrid trc20 indexer feed filtered to Approval rows the owner sent — the gateway serves
 * indexer paths only, so a host-first network reports `unavailable`. Paged by `meta.fingerprint`,
 * at most {@link TRON_INDEXER_PAGES_MAX} pages.
 */
export const tronGatewayCandidates = async (
  deps: {
    readonly networks: Pick<NetworkController, "tronApi" | "gatewayFirst">;
    readonly now: () => number;
  },
  network: string,
  owner: string,
): Promise<SourceResult> => {
  if (!deps.networks.gatewayFirst(network)) {
    return { status: "unavailable", candidates: [] };
  }
  const api = deps.networks.tronApi(network);
  const candidates: Array<{ readonly candidate: Candidate; readonly seen?: bigint }> = [];
  let fingerprint: string | undefined;
  try {
    for (let page = 0; page < TRON_INDEXER_PAGES_MAX; page += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each page's fingerprint fetches the next
      const raw = await api.post("/v1/accounts/transactions/trc20", {
        address: owner,
        ...(fingerprint === undefined ? {} : { fingerprint }),
        limit: TRON_INDEXER_LIMIT_MAX,
      });
      const body = parseWith(tronIndexerPageResponse, raw);
      if (body === undefined) {
        return { status: "failed", candidates: [] };
      }
      ({ fingerprint } = body.meta);
      for (const raw of body.data) {
        const row = parseWith(tronIndexerTrc20, raw);
        if (row === undefined || row.type !== "Approval" || row.from !== owner) {
          continue;
        }
        const token = row.token_info.address;
        if (token === undefined) {
          continue;
        }
        candidates.push({
          candidate: { kind: "trc20", token, spender: row.to },
          seen: BigInt(row.block_timestamp) / 1000n,
        });
      }
      if (fingerprint === undefined) {
        return { status: "ok", at: deps.now(), candidates };
      }
    }
    // Pages remain beyond the cap — the list may be missing older approvals.
    return { status: "truncated", at: deps.now(), candidates };
  } catch {
    return { status: "failed", candidates: [] };
  }
};

const LOCAL_STATES: ReadonlySet<TrackedTransaction["state"]> = new Set([
  "submitted",
  "pending",
  "confirmed",
]);

/** The candidates one intent's approvals and staking actions imply, per family. */
const intentCandidates = (
  intent: DisplayIntent,
  family: "evm" | "solana" | "tron",
  out: Candidate[],
): void => {
  for (const approval of intent.approvals) {
    if (approval.kind === "allowance") {
      if (family === "evm") {
        out.push(
          approval.via === "permit2"
            ? { kind: "permit2", token: approval.amount.asset, spender: approval.spender }
            : { kind: "erc20", token: approval.amount.asset, spender: approval.spender },
        );
      } else if (family === "tron") {
        out.push({ kind: "trc20", token: approval.amount.asset, spender: approval.spender });
      }
      continue;
    }
    if (approval.kind === "operator" && family === "evm") {
      out.push({ kind: "operator", token: approval.asset, operator: approval.spender });
      continue;
    }
    if (approval.kind === "stake-authority") {
      out.push({ kind: "stake", account: approval.account });
    }
  }
  for (const action of intent.staking ?? []) {
    if (action.kind === "create") {
      out.push({ kind: "stake", account: action.account });
    }
  }
  for (const call of intent.calls ?? []) {
    intentCandidates(call, family, out);
  }
};

/**
 * Candidates from this session's tracked sends on `network` that `owner` signed — the wallet's own
 * record of what it approved. A revoked approval still yields a candidate; the chain read decides
 * whether anything stands.
 */
export const localCandidates = (
  txs: Readonly<Record<string, TrackedTransaction>>,
  family: "evm" | "solana" | "tron",
  network: string,
  owner: string,
): ReadonlyArray<Candidate> => {
  const out: Candidate[] = [];
  for (const tx of Object.values(txs)) {
    if (tx.network !== network || tx.family !== family || !LOCAL_STATES.has(tx.state)) {
      continue;
    }
    if (family === "evm" && tx.evm?.from.toLowerCase() !== owner.toLowerCase()) {
      continue;
    }
    if (family === "tron" && tx.tron?.from !== owner) {
      continue;
    }
    if (family === "solana") {
      if (tx.raw === undefined) {
        continue;
      }
      try {
        decodeSolanaTransaction(base64.decode(tx.raw), owner);
      } catch {
        continue;
      }
    }
    if (tx.intent !== undefined) {
      intentCandidates(tx.intent, family, out);
    }
  }
  return out;
};
