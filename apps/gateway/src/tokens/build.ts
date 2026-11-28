import {
  TOKEN_LIST_MAX_ENTRIES,
  accepts,
  parseWith,
  tokenListEntry,
  tokenListResponse,
} from "@qntx/wallet-engine/gateway/contract";
import type { TokenListEntry, TokenListResponse } from "@qntx/wallet-engine/gateway/contract";

import { readCapped } from "../providers/body.ts";
import type { ProviderBudget, TokenListStore } from "../types.ts";
import type { RawToken, TokenListUpstream } from "./sources.ts";

export type TokenListBuildOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly store: TokenListStore;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly sources: ReadonlyArray<TokenListUpstream>;
  /** The shared provider budget: a source naming an account pays its cost before fetching. */
  readonly budget: ProviderBudget;
};

const FETCH_TIMEOUT_MS = 30_000;
/** Jupiter's verified list is ~5 MB; 16 MiB leaves years of headroom. */
const SOURCE_MAX_BYTES = 16 * 1024 * 1024;
const SHRINK_FLOOR = 0.5;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CAPS: Readonly<Record<string, number>> = {
  eip155: TOKEN_LIST_MAX_ENTRIES.evm,
  solana: TOKEN_LIST_MAX_ENTRIES.solana,
};

const storeKey = (network: string): string => `tokens:${network}`;

/** One raw entry as a contract entry, or `undefined` when any field fails its schema. */
const normalizeEntry = (evm: boolean, raw: RawToken): TokenListEntry | undefined => {
  const address = evm
    ? EVM_ADDRESS.test(raw.address)
      ? raw.address.toLowerCase()
      : undefined
    : SOLANA_ADDRESS.test(raw.address)
      ? raw.address
      : undefined;
  const symbol = typeof raw.symbol === "string" ? raw.symbol.trim() : undefined;
  const name = typeof raw.name === "string" ? raw.name.trim() : undefined;
  const parsed = parseWith(tokenListEntry, {
    address: address ?? "",
    symbol,
    name,
    decimals: raw.decimals,
  });
  return address === undefined || parsed === undefined ? undefined : parsed;
};

/**
 * The publishable entries of one network: schema-clean, deduplicated by address (a decimals
 * conflict drops the address entirely) and sorted — the canonical order the contract demands.
 */
const normalizeNetwork = (
  network: string,
  raw: ReadonlyArray<RawToken>,
): { readonly tokens: ReadonlyArray<TokenListEntry>; readonly dropped: number } => {
  const evm = network.split(":")[0] === "eip155";
  const byAddress = new Map<string, TokenListEntry>();
  const conflicts = new Set<string>();
  for (const r of raw) {
    const entry = normalizeEntry(evm, r);
    if (entry === undefined) {
      continue;
    }
    const seen = byAddress.get(entry.address);
    if (seen === undefined) {
      byAddress.set(entry.address, entry);
    } else if (seen.decimals !== entry.decimals) {
      byAddress.delete(entry.address);
      conflicts.add(entry.address);
    }
  }
  const tokens = [...byAddress.values()]
    .filter((entry) => !conflicts.has(entry.address))
    .toSorted((a, b) => (a.address < b.address ? -1 : 1));
  return { tokens, dropped: raw.length - tokens.length };
};

const readPrevious = async (
  store: TokenListStore,
  network: string,
): Promise<TokenListResponse | undefined> => {
  const raw = await store.get(storeKey(network));
  if (raw === undefined) {
    return undefined;
  }
  try {
    return parseWith(tokenListResponse, JSON.parse(raw));
  } catch {
    return undefined;
  }
};

const publish = async (
  options: TokenListBuildOptions,
  source: TokenListUpstream,
  network: string,
  raw: ReadonlyArray<RawToken>,
): Promise<void> => {
  const { store, now, log } = options;
  const skip = (reason: string): void => {
    log(JSON.stringify({ event: "token-list-build-skipped", reason, source: source.id, network }));
  };

  const { tokens, dropped } = normalizeNetwork(network, raw);
  const max = CAPS[network.split(":")[0] ?? ""] ?? 0;
  if (tokens.length > max) {
    skip("too-large");
    return;
  }
  const previous = await readPrevious(store, network);
  if (previous !== undefined && tokens.length < previous.tokens.length * SHRINK_FLOOR) {
    skip("shrank");
    return;
  }
  if (previous !== undefined && JSON.stringify(tokens) === JSON.stringify(previous.tokens)) {
    return;
  }
  const version = previous === undefined ? now() : Math.max(now(), previous.version + 1);
  const doc = { network, version, sources: [source.id], tokens };
  if (!accepts(tokenListResponse, doc)) {
    skip("invalid");
    return;
  }
  await store.put(storeKey(network), JSON.stringify(doc));
  log(
    JSON.stringify({
      event: "token-list-build",
      network,
      version,
      tokens: tokens.length,
      dropped,
    }),
  );
};

/**
 * Fetches every configured source and republishes its networks' lists. Sources run in parallel and
 * each is isolated: one that fails leaves its networks' stored lists untouched. A network is
 * skipped (never rewritten) when its cleaned list exceeds the cap or halved versus the stored one,
 * and a source whose account budget refuses the fetch is skipped before any upstream call.
 */
export async function buildTokenLists(options: TokenListBuildOptions): Promise<void> {
  const { fetch, log } = options;
  await Promise.all(
    options.sources.map(async (source) => {
      try {
        if (source.charge !== undefined) {
          const decision = await options.budget.take(source.charge.account, source.charge.units);
          if (!decision.ok) {
            log(
              JSON.stringify({
                event: "token-list-build-skipped",
                reason: "budget",
                source: source.id,
              }),
            );
            return;
          }
        }
        const response = await fetch(source.url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          ...(source.headers === undefined ? {} : { headers: source.headers }),
        });
        if (!response.ok) {
          throw new Error(`upstream status ${String(response.status)}`);
        }
        const parsed = source.parse(JSON.parse(await readCapped(response, SOURCE_MAX_BYTES)));
        await Promise.all(
          source.networks.map(async (network) =>
            publish(options, source, network, parsed.get(network) ?? []),
          ),
        );
      } catch (error) {
        log(
          JSON.stringify({
            event: "token-list-build-skipped",
            reason: "source-failed",
            source: source.id,
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }),
  );
}
