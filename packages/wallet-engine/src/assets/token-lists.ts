/**
 * The engine's copy of the gateway's token lists: one document per network, fetched at most once
 * per six hours with `if-none-match` revalidation (304 when unchanged), persisted in the
 * `token-lists` collection so a wallet opens with last session's lists. A 404 `unsupported` or
 * `unknown-network` means the network has no list here at all and is stored as empty (an
 * `unsupported` answer is permanent — the stored list ages out before it is asked again); any other
 * fetch failure blocks retries for ten minutes, a document older than the stored one is a rollback
 * and is ignored, and without a configured gateway there are no lists at all.
 */
import * as z from "zod/mini";

import type { EngineLogger } from "../events.ts";
import { gatewayFetch } from "../gateway/client.ts";
import type { GatewayConfig } from "../gateway/client.ts";
import {
  gatewayError,
  parseWith,
  tokenListEntry,
  tokenListPath,
  tokenListResponse,
} from "../gateway/contract/index.ts";
import type { TokenListEntry } from "../gateway/contract/index.ts";
import { readJson } from "../store/json.ts";
import type { EngineCollection, EngineStore } from "../store/port.ts";
import { timeoutSignal } from "../timer.ts";

const COLLECTION = "token-lists";
const STALE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 30_000;

const encoder = new TextEncoder();

type StoredList = {
  readonly etag?: string | undefined;
  readonly version: number;
  readonly fetchedAt: number;
  readonly tokens: ReadonlyArray<TokenListEntry>;
};

/** The persisted record; anything else is ignored with a warning, never resurrected. */
const storedList = z.object({
  etag: z.optional(z.string()),
  version: z.int().check(z.nonnegative()),
  fetchedAt: z.number(),
  tokens: z.array(tokenListEntry),
});

/** Entries keyed by canonical address — the contract already pins lowercase EVM. */
const byAddress = (tokens: ReadonlyArray<TokenListEntry>): ReadonlyMap<string, TokenListEntry> =>
  new Map(tokens.map((token) => [token.address, token]));

type Options = {
  readonly gateway: GatewayConfig | undefined;
  readonly fetch: typeof globalThis.fetch;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  readonly now: () => number;
  readonly logger: EngineLogger;
};

export class TokenLists {
  private readonly options: Options;
  private store: EngineCollection | undefined;
  private epoch = 0;
  private readonly lists = new Map<string, StoredList>();
  private readonly retryAt = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(options: Options) {
    this.options = options;
  }

  /** Reads every stored list; a malformed record is ignored with a warning. */
  async load(store: EngineStore): Promise<void> {
    this.store = store.collection(COLLECTION);
    const networks = await this.store.list();
    const collection = this.store;
    const raws = await Promise.all(
      networks.map(async (network): Promise<Uint8Array | undefined> => collection.get(network)),
    );
    for (const [i, network] of networks.entries()) {
      const raw = raws[i];
      const parsed = raw === undefined ? undefined : parseWith(storedList, readJson(raw));
      if (parsed === undefined) {
        this.options.logger.warn(`ignoring malformed token list for ${network}`, undefined);
        continue;
      }
      this.lists.set(network, parsed);
    }
  }

  /**
   * Lock: memory and the store handle go — nothing of the session survives, not even a refresh that
   * was still in flight: the epoch bump makes its writes dead on arrival.
   */
  clear(): void {
    this.epoch += 1;
    this.store = undefined;
    this.lists.clear();
    this.retryAt.clear();
    this.inflight.clear();
  }

  /**
   * The network's list entries keyed by canonical address. Refreshes a stale copy inline —
   * single-flight, and a failed try backs off for {@link RETRY_MS}. No gateway → empty.
   */
  async entries(network: string): Promise<ReadonlyMap<string, TokenListEntry>> {
    if (this.options.gateway === undefined) {
      return new Map();
    }
    const stored = this.lists.get(network);
    const now = this.options.now();
    if (
      (stored === undefined || now - stored.fetchedAt >= STALE_MS) &&
      (this.retryAt.get(network) ?? 0) <= now
    ) {
      const running = this.inflight.get(network) ?? this.refresh(network);
      this.inflight.set(network, running);
      await running;
      this.inflight.delete(network);
    }
    return byAddress(this.lists.get(network)?.tokens ?? []);
  }

  private async refresh(network: string): Promise<void> {
    const { epoch } = this;
    const { now } = this.options;
    const fetch = gatewayFetch(this.options.fetch, this.options.gateway);
    const { gateway } = this.options;
    if (gateway === undefined) {
      return;
    }
    const stored = this.lists.get(network);
    const url = `${gateway.url.replace(/\/+$/, "")}${tokenListPath(network)}`;
    const { signal, cancel } = timeoutSignal(TIMEOUT_MS, this.options.setTimer);
    try {
      const response = await fetch(url, {
        signal,
        ...(stored?.etag === undefined ? {} : { headers: { "if-none-match": stored.etag } }),
      });
      if (response.status === 304) {
        if (stored !== undefined) {
          await this.persist(network, { ...stored, fetchedAt: now() }, epoch);
        }
        return;
      }
      if (response.status === 404) {
        // Only a recognised gateway code means "no list here": `unsupported` (no source covers
        // the network — permanent) and `unknown-network`. A bare 404 is a fetch failure — back off.
        const error = parseWith(gatewayError, await response.json());
        if (error?.error === "unsupported" || error?.error === "unknown-network") {
          await this.persist(network, { version: 0, fetchedAt: now(), tokens: [] }, epoch);
          return;
        }
        throw new Error(`token list status ${String(response.status)}`);
      }
      if (response.status !== 200) {
        throw new Error(`token list status ${String(response.status)}`);
      }
      const doc = parseWith(tokenListResponse, await response.json());
      if (doc === undefined || doc.network !== network) {
        throw new Error(`token list for ${network} failed the contract`);
      }
      if (stored !== undefined && doc.version < stored.version) {
        this.options.logger.warn(`ignoring token list rollback for ${network}`, undefined);
        if (epoch === this.epoch) {
          this.retryAt.set(network, now() + RETRY_MS);
        }
        return;
      }
      const etag = response.headers.get("etag");
      await this.persist(
        network,
        {
          ...(etag === null ? {} : { etag }),
          version: doc.version,
          fetchedAt: now(),
          tokens: doc.tokens,
        },
        epoch,
      );
    } catch (error) {
      this.options.logger.warn(`token list fetch for ${network} failed`, error);
      if (epoch === this.epoch) {
        this.retryAt.set(network, now() + RETRY_MS);
      }
    } finally {
      cancel();
    }
  }

  private async persist(network: string, list: StoredList, epoch: number): Promise<void> {
    if (epoch !== this.epoch) {
      return;
    }
    this.lists.set(network, list);
    await this.store?.put(network, encoder.encode(JSON.stringify(list)));
  }
}
