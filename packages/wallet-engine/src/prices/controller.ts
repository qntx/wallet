/**
 * Spot prices of the assets the engine holds, from the gateway's `POST /v1/prices`. Display-only:
 * nothing that builds, approves or signs a transaction may read this state (lint-enforced — only
 * the composition root imports `prices/`).
 *
 * Fetches are single-flight: a refresh asked for while one runs runs once more after it. A newly
 * held asset triggers a refresh; the full set is re-read every {@link PRICES_POLL_MS} while the
 * host is visible. Every answer is schema-checked as a whole — a malformed one is a failure, never
 * partial data. On failure the previous quotes stay (their `updatedAt` makes them stale); an asset
 * the gateway reports `missing` is marked `unpriced` and keeps its previous quote too. Quotes and
 * the chosen currency persist in the EngineStore (the asset set is private: never the public
 * store); lock clears them from memory.
 */
import * as z from "zod/mini";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import { gatewayFetch } from "../gateway/client.ts";
import type { GatewayConfig } from "../gateway/client.ts";
import {
  MAX_PRICE_ASSETS,
  fiatCurrency,
  fiatPrice,
  parseWith,
  percentChange,
  priceAssetId,
  prices,
} from "../gateway/contract/index.ts";
import type { FiatCurrency, PricesResponse } from "../gateway/contract/index.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import { repeat, timeoutSignal } from "../timer.ts";
import type { SetTimer } from "../timer.ts";

export const PRICES_POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const COLLECTION = "prices";
const SNAPSHOT_KEY = "snapshot";

export type PriceQuoteState = {
  readonly price: string;
  // oxlint-disable-next-line typescript/no-restricted-types -- wire shape: null when the provider has no 24 h change
  readonly change24h: string | null;
  readonly updatedAt: number;
};

/** Why the last fetch failed: no gateway configured, it failed or refused, or it answered junk. */
export type PricesFailure = "no-gateway" | "unavailable" | "rate-limited" | "invalid-response";

export type PricesState = {
  readonly currency: FiatCurrency;
  /** Asset id → its latest quote; only assets still held are kept. */
  readonly quotes: Readonly<Record<string, PriceQuoteState>>;
  /** Per-asset errors: `unpriced` when the last answer naming the asset had no price for it. */
  readonly errors: Readonly<Record<string, "unpriced">>;
  // oxlint-disable-next-line typescript/no-restricted-types -- state shape: null after a success
  readonly failure: PricesFailure | null;
  /** The last successful fetch, Unix ms. */
  // oxlint-disable-next-line typescript/no-restricted-types -- state shape: null until a fetch succeeds
  readonly fetchedAt: number | null;
};

export type PricesControllerOptions = {
  readonly gateway: GatewayConfig | undefined;
  readonly fetch: typeof globalThis.fetch;
  readonly openStore: () => Promise<EngineStore>;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  readonly logger: EngineLogger;
  /** Every priceable asset id the engine holds a balance of now. */
  readonly held: () => ReadonlyArray<string>;
  /** Calls `listener` whenever `held` may have changed; returns the unsubscribe. */
  readonly onHeldChange: (listener: () => void) => () => void;
};

const storedSnapshot = z.object({
  currency: fiatCurrency,
  quotes: z.record(
    priceAssetId,
    z.object({
      price: fiatPrice,
      change24h: z.union([percentChange, z.null()]),
      updatedAt: z.number().check(z.int(), z.positive()),
    }),
  ),
});

const emptyState = (currency: FiatCurrency): PricesState => ({
  currency,
  quotes: {},
  errors: {},
  failure: null,
  fetchedAt: null,
});

const chunks = <T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_v, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/** The answer when it is a valid response to exactly this request, else the failure it is. */
const checkAnswer = (
  body: unknown,
  currency: FiatCurrency,
  asked: ReadonlyArray<string>,
): PricesResponse | PricesFailure => {
  const answer = parseWith(prices.response, body);
  if (answer === undefined || answer.currency !== currency) {
    return "invalid-response";
  }
  const named = [...answer.prices.map((q) => q.asset), ...answer.missing];
  const wanted = new Set(asked);
  return named.length === wanted.size &&
    new Set(named).size === wanted.size &&
    named.every((a) => wanted.has(a))
    ? answer
    : "invalid-response";
};

export class PricesController extends Controller<PricesState> {
  private readonly options: PricesControllerOptions;
  private readonly fetchGateway: typeof globalThis.fetch;
  private engineStore: EngineStore | undefined;
  private active = false;
  private visible = false;
  private epoch = 0;
  private cancelPoll: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private inflight: Promise<void> | undefined;
  private rerun = false;
  /** Assets some request of this unlock already named — a newly held asset is one not in here. */
  private readonly asked = new Set<string>();
  private readonly aborts = new Set<() => void>();

  constructor(options: PricesControllerOptions) {
    super({ name: "prices", defaultState: () => emptyState("usd") });
    this.options = options;
    this.fetchGateway = gatewayFetch(options.fetch, options.gateway);
  }

  async init(): Promise<void> {
    this.engineStore = await this.options.openStore();
    const raw = await this.engineStore.collection(COLLECTION).get(SNAPSHOT_KEY);
    const stored = raw === undefined ? undefined : parseWith(storedSnapshot, readJson(raw));
    if (raw !== undefined && stored === undefined) {
      this.options.logger.warn("ignoring a malformed stored price snapshot");
    }
    if (stored !== undefined) {
      this.update(() => ({ ...emptyState(stored.currency), quotes: stored.quotes }));
    }
    this.active = true;
    this.unsubscribe = this.options.onHeldChange(() => {
      this.refreshIfNewlyHeld();
    });
    if (this.visible) {
      this.armPoll();
      void this.refresh();
    } else {
      // Balances read before the subscription existed (earlier in the unlock) count as new too.
      this.refreshIfNewlyHeld();
    }
  }

  lock(): void {
    this.active = false;
    this.epoch += 1;
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const abort of this.aborts) {
      abort();
    }
    this.aborts.clear();
    this.asked.clear();
    this.engineStore = undefined;
    this.update(() => emptyState("usd"));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  /** Visible: refresh now, then every {@link PRICES_POLL_MS}. Hidden: stop polling. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.cancelPoll?.();
      this.cancelPoll = undefined;
      return;
    }
    if (this.active && this.cancelPoll === undefined) {
      this.armPoll();
      void this.refresh();
    }
  }

  /** Switches the quote currency: drops every quote, persists the choice, refetches. */
  async setCurrency(currency: FiatCurrency): Promise<void> {
    if (!this.active || currency === this.getState().currency) {
      return;
    }
    this.epoch += 1;
    this.asked.clear();
    this.update(() => emptyState(currency));
    await this.persist();
    await this.refresh();
  }

  /** Fetches quotes for every held asset; resolves once the state reflects the answer. */
  async refresh(): Promise<void> {
    if (!this.active) {
      return undefined;
    }
    if (this.inflight !== undefined) {
      this.rerun = true;
      return this.inflight;
    }
    const run = async (): Promise<void> => {
      try {
        do {
          this.rerun = false;
          // oxlint-disable-next-line eslint/no-await-in-loop -- a rerun must follow the run it waited on
          await this.fetchOnce();
        } while (this.rerun && this.active);
      } finally {
        this.inflight = undefined;
      }
    };
    this.inflight = run();
    return this.inflight;
  }

  private refreshIfNewlyHeld(): void {
    if (this.options.held().some((asset) => !this.asked.has(asset))) {
      void this.refresh();
    }
  }

  private armPoll(): void {
    this.cancelPoll = repeat(
      this.options.setTimer,
      PRICES_POLL_MS,
      async () => this.refresh(),
      (error) => {
        this.options.logger.warn("price refresh failed", error);
      },
    );
  }

  private async fetchOnce(): Promise<void> {
    const { gateway } = this.options;
    if (gateway === undefined) {
      this.update((s) => ({ ...s, failure: "no-gateway" }));
      return;
    }
    const assets = [...new Set(this.options.held())].sort();
    if (assets.length === 0) {
      return;
    }
    const { epoch } = this;
    const { currency } = this.getState();
    for (const asset of assets) {
      this.asked.add(asset);
    }
    const answers = await Promise.all(
      chunks(assets, MAX_PRICE_ASSETS).map(async (batch) => this.request(gateway, currency, batch)),
    );
    if (epoch !== this.epoch) {
      return;
    }
    const failure = answers.find((a): a is PricesFailure => typeof a === "string");
    if (failure !== undefined) {
      this.update((s) => ({ ...s, failure }));
      return;
    }
    const answered = answers.filter((a): a is PricesResponse => typeof a !== "string");
    const fresh = new Map(answered.flatMap((a) => a.prices).map((q) => [q.asset, q]));
    const missing = answered.flatMap((a) => a.missing);
    const fetchedAt = this.options.now();
    this.update((s) => ({
      ...s,
      quotes: Object.fromEntries(
        assets.flatMap((asset) => {
          const quote = fresh.get(asset) ?? s.quotes[asset];
          return quote === undefined
            ? []
            : [
                [
                  asset,
                  { price: quote.price, change24h: quote.change24h, updatedAt: quote.updatedAt },
                ],
              ];
        }),
      ),
      errors: Object.fromEntries(missing.map((asset) => [asset, "unpriced" as const])),
      failure: null,
      fetchedAt,
    }));
    await this.persist();
  }

  private async request(
    gateway: GatewayConfig,
    currency: FiatCurrency,
    assets: ReadonlyArray<string>,
  ): Promise<PricesResponse | PricesFailure> {
    const bound = timeoutSignal(FETCH_TIMEOUT_MS, this.options.setTimer);
    this.aborts.add(bound.abort);
    try {
      const response = await this.fetchGateway(`${gateway.url.replace(/\/+$/, "")}${prices.path}`, {
        method: prices.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currency, assets }),
        signal: bound.signal,
      });
      if (response.status === 429) {
        return "rate-limited";
      }
      if (!response.ok) {
        return "unavailable";
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return "invalid-response";
      }
      return checkAnswer(body, currency, assets);
    } catch (error) {
      this.options.logger.warn("price request failed", error);
      return "unavailable";
    } finally {
      bound.cancel();
      this.aborts.delete(bound.abort);
    }
  }

  private async persist(): Promise<void> {
    const store = this.engineStore;
    if (store === undefined) {
      return;
    }
    const { currency, quotes } = this.getState();
    try {
      await store
        .collection(COLLECTION)
        .put(SNAPSHOT_KEY, new TextEncoder().encode(JSON.stringify({ currency, quotes })));
    } catch (error) {
      this.options.logger.warn("price snapshot could not be saved", error);
    }
  }
}
