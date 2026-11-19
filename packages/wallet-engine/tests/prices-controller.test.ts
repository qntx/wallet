/**
 * PricesController against a contract-checked fake gateway: every request it sends is validated
 * (POST /v1/prices, a `prices.request` body, the session's service client id), and every violation
 * fails the test. Timers are hand-driven — no wall clock anywhere.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { gatewaySession } from "../src/gateway/client.ts";
import { CLIENT_ID_HEADER, parseWith, prices } from "../src/gateway/contract/index.ts";
import type { PriceQuote, PricesRequest } from "../src/gateway/contract/index.ts";
import { PRICES_POLL_MS, PricesController } from "../src/prices/controller.ts";
import type { PricesState } from "../src/prices/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import { manualTimers } from "./support/timers.ts";

const GATEWAY = "https://gw.test";
const NOW = 1_700_000_000_000;
const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

const ETH = "eip155:1/slip44:60";
const USDC = "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const BTC = "bip122:000000000019d6689c085ae165831e93/slip44:0";

const empty = (): PricesState => ({
  currency: "usd",
  quotes: {},
  errors: {},
  failure: null,
  fetchedAt: null,
});

const quote = (asset: string, price: string): PriceQuote => ({
  asset,
  price,
  change24h: null,
  updatedAt: NOW - 1000,
});

type Responder = (request: PricesRequest) => Response | Promise<Response>;

/** A schema-valid success: every named asset priced at `priced`, the rest `missing`. */
const answer =
  (priced: Readonly<Record<string, string>>): Responder =>
  (request) =>
    Response.json({
      currency: request.currency,
      prices: request.assets.flatMap((asset) => {
        const price = priced[asset];
        return price === undefined ? [] : [quote(asset, price)];
      }),
      missing: request.assets.filter((asset) => priced[asset] === undefined),
    });

/** A schema-valid success pricing every asked asset at "1". */
const allPriced: Responder = (request) =>
  Response.json({
    currency: request.currency,
    prices: request.assets.map((asset) => quote(asset, "1")),
    missing: [],
  });

/** A schema-valid success pricing `asset` at its price for the request's currency. */
const pricedByCurrency =
  (asset: string, byCurrency: Readonly<Record<string, string>>): Responder =>
  (request) => {
    const price = byCurrency[request.currency];
    return Response.json({
      currency: request.currency,
      prices: price === undefined ? [] : [quote(asset, price)],
      missing: request.assets.filter((a) => a !== asset || price === undefined),
    });
  };

/** The first request's answer waits on `gate`; every later request answers at once. */
const gatedFirst = (gate: Promise<unknown>): Responder => {
  let gated = true;
  return async (request) => {
    if (gated) {
      gated = false;
      await gate;
    }
    return allPriced(request);
  };
};

/** Let pending microtask chains (a fetch's response handling) settle. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve));
};

const violations: string[] = [];

afterEach(() => {
  const found = violations.splice(0);
  if (found.length > 0) {
    throw new Error(`gateway contract violations:\n${found.join("\n")}`);
  }
});

type Backing = { readonly collections: Map<string, Map<string, Uint8Array>> };

function rig(
  options: {
    readonly gateway?: boolean;
    readonly held?: ReadonlyArray<string>;
    readonly answer?: Responder;
    readonly backing?: Backing;
    readonly store?: EngineStore;
    readonly now?: number;
  } = {},
) {
  const session = options.gateway === false ? undefined : gatewaySession(GATEWAY, random);
  const calls: PricesRequest[] = [];
  const timers = manualTimers();
  const listeners = new Set<() => void>();
  const warnings: string[] = [];
  let held = [...(options.held ?? [])];
  let heldError: Error | undefined;
  const responder = { answer: options.answer ?? allPriced };

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== GATEWAY || url.pathname !== prices.path || init?.method !== prices.method) {
      violations.push(`${init?.method ?? "GET"} ${url.href}: not a POST ${prices.path}`);
    }
    if (new Headers(init?.headers).get(CLIENT_ID_HEADER) !== session?.clientIds.service) {
      violations.push(`${url.pathname}: wrong or missing ${CLIENT_ID_HEADER}`);
    }
    let request: PricesRequest | undefined;
    try {
      request = parseWith(prices.request, JSON.parse(String(init?.body)));
    } catch {
      request = undefined;
    }
    if (request === undefined) {
      violations.push(`${url.pathname}: body violates prices.request: ${String(init?.body)}`);
      return new Response("{}", { status: 400 });
    }
    calls.push(request);
    return responder.answer(request);
  };

  const controller = new PricesController({
    gateway: session,
    fetch: fetchImpl,
    openStore: async () =>
      Promise.resolve(options.store ?? createMemoryEngineStore(options.backing)),
    setTimer: timers.setTimer,
    now: () => options.now ?? NOW,
    logger: { warn: (message) => warnings.push(message) },
    held: () => {
      if (heldError !== undefined) {
        throw heldError;
      }
      return held;
    },
    onHeldChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    controller,
    calls,
    timers,
    warnings,
    session,
    listeners,
    notify: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    setHeld: (assets: ReadonlyArray<string>) => {
      held = [...assets];
    },
    setAnswer: (responder2: Responder) => {
      responder.answer = responder2;
    },
    throwHeld: (error: Error | undefined) => {
      heldError = error;
    },
  };
}

describe("prices over the gateway", () => {
  it("reports no-gateway when no gateway is configured, and never fetches", async () => {
    const r = rig({ gateway: false, held: [ETH] });
    await r.controller.init();
    r.notify();
    await flush();
    expect(r.controller.getState().failure).toBe("no-gateway");
    expect(r.calls).toHaveLength(0);
  });

  it("fetches once for a newly held asset and ignores an unchanged notification", async () => {
    const r = rig();
    await r.controller.init();

    r.setHeld([ETH]);
    r.notify();
    await flush();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.assets).toStrictEqual([ETH]);
    const state = r.controller.getState();
    expect(state.quotes[ETH]).toStrictEqual({
      price: "1",
      change24h: null,
      updatedAt: NOW - 1000,
    });
    expect(state.fetchedAt).toBe(NOW);
    expect(state.failure).toBeNull();

    r.notify();
    await flush();
    expect(r.calls).toHaveLength(1);

    r.setHeld([ETH, USDC]);
    r.notify();
    await flush();
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]?.assets).toStrictEqual([USDC, ETH]);
  });

  it("fetches the assets already held at init once, without a notification", async () => {
    const r = rig({ held: [ETH, USDC] });
    await r.controller.init();
    await flush();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.assets).toStrictEqual([USDC, ETH]);
    expect(Object.keys(r.controller.getState().quotes)).toStrictEqual([USDC, ETH]);

    r.notify(); // the same set was already asked — nothing new to fetch
    await flush();
    expect(r.calls).toHaveLength(1);
  });

  it("marks a missing asset unpriced and keeps the quote it had", async () => {
    const r = rig({ held: [ETH, USDC], answer: answer({ [ETH]: "1", [USDC]: "1" }) });
    await r.controller.init();
    await flush(); // init fetches the held set once
    expect(r.controller.getState().quotes[USDC]?.price).toBe("1");

    r.setAnswer((request) =>
      Response.json({
        currency: request.currency,
        prices: [quote(ETH, "2")],
        missing: [USDC],
      }),
    );
    await r.controller.refresh();
    const state = r.controller.getState();
    expect(state.errors).toStrictEqual({ [USDC]: "unpriced" });
    expect(state.quotes[USDC]?.price).toBe("1");
    expect(state.quotes[ETH]?.price).toBe("2");
    expect(state.failure).toBeNull();
  });

  it("keeps a previous quote that is newer than the fresh answer", async () => {
    const r = rig({ held: [ETH], answer: answer({ [ETH]: "1" }) });
    await r.controller.init();
    await flush();
    expect(r.controller.getState().quotes[ETH]?.updatedAt).toBe(NOW - 1000);

    r.setAnswer((request) =>
      Response.json({
        currency: request.currency,
        prices: [{ asset: ETH, price: "9", change24h: null, updatedAt: NOW - 5000 }],
        missing: [],
      }),
    );
    await r.controller.refresh();
    expect(r.controller.getState().quotes[ETH]).toStrictEqual({
      price: "1",
      change24h: null,
      updatedAt: NOW - 1000,
    });
  });

  it("replaces a future-dated stored quote with the fresh answer", async () => {
    const r = rig({
      held: [ETH],
      answer: (request) =>
        Response.json({
          currency: request.currency,
          prices: [{ asset: ETH, price: "1", change24h: null, updatedAt: NOW + 60_000 }],
          missing: [],
        }),
    });
    await r.controller.init();
    await flush();
    expect(r.controller.getState().quotes[ETH]?.updatedAt).toBe(NOW + 60_000);

    r.setAnswer(answer({ [ETH]: "2" }));
    await r.controller.refresh();
    expect(r.controller.getState().quotes[ETH]).toStrictEqual({
      price: "2",
      change24h: null,
      updatedAt: NOW - 1000,
    });
  });

  it.each<[string, Responder, PricesState["failure"]]>([
    ["a 503", () => new Response("", { status: 503 }), "unavailable"],
    ["a 429", () => new Response("", { status: 429 }), "rate-limited"],
    ["a fetch rejection", async () => Promise.reject(new TypeError("offline")), "unavailable"],
    ["a non-JSON body", () => new Response("<html>"), "invalid-response"],
    [
      "a schema-invalid price",
      (request) =>
        Response.json({
          currency: request.currency,
          prices: [{ asset: ETH, price: "1e3", change24h: null, updatedAt: 1 }],
          missing: [USDC],
        }),
      "invalid-response",
    ],
    [
      "a currency mismatch",
      () =>
        Response.json({
          currency: "eur",
          prices: [quote(ETH, "1"), quote(USDC, "1")],
          missing: [],
        }),
      "invalid-response",
    ],
    [
      "an asset that was not asked for",
      (request) =>
        Response.json({
          currency: request.currency,
          prices: [quote(ETH, "1"), quote(BTC, "1")],
          missing: [],
        }),
      "invalid-response",
    ],
    [
      "an omitted asset",
      (request) =>
        Response.json({
          currency: request.currency,
          prices: [quote(ETH, "1")],
          missing: [],
        }),
      "invalid-response",
    ],
  ])("reports %s as %s and keeps the previous quotes", async (_name, bad, failure) => {
    const r = rig({ held: [ETH, USDC] });
    await r.controller.init();
    await flush(); // init fetches the held set once
    const before = r.controller.getState().quotes;
    expect(Object.keys(before)).toHaveLength(2);

    r.setAnswer(bad);
    await r.controller.refresh();
    expect(r.controller.getState().failure).toBe(failure);
    expect(r.controller.getState().quotes).toStrictEqual(before);
  });

  it("is single-flight: two refreshes over one pending request fetch twice, not thrice", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({ answer: gatedFirst(gate) });
    await r.controller.init();
    r.setHeld([ETH]);

    const first = r.controller.refresh();
    const second = r.controller.refresh();
    release?.();
    await Promise.all([first, second]);
    expect(r.calls).toHaveLength(2);
  });

  it("chunks a large portfolio into requests of at most MAX_PRICE_ASSETS", async () => {
    const assets = Array.from(
      { length: 150 },
      (_, i) => `eip155:1/erc20:0x${(i + 1).toString(16).padStart(40, "0")}`,
    );
    const r = rig({ held: assets });
    await r.controller.init();
    await flush(); // init fetches the held set once
    expect(r.calls.map((c) => c.assets.length)).toStrictEqual([100, 50]);
    expect(r.controller.getState().failure).toBeNull();
  });

  it("refreshes on becoming visible, polls while visible and stops when hidden", async () => {
    const r = rig();
    await r.controller.init();
    expect(r.timers.armed(PRICES_POLL_MS)).toBe(0);

    r.setHeld([ETH]);
    r.controller.setVisible(true);
    await flush();
    expect(r.calls).toHaveLength(1);
    expect(r.timers.armed(PRICES_POLL_MS)).toBe(1);

    await r.timers.fire(PRICES_POLL_MS);
    expect(r.calls).toHaveLength(2);
    expect(r.timers.armed(PRICES_POLL_MS)).toBe(1);

    r.controller.setVisible(false);
    expect(r.timers.armed(PRICES_POLL_MS)).toBe(0);
  });

  it("restores the persisted snapshot in a fresh controller", async () => {
    const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
    const first = rig({ backing, held: [ETH] });
    await first.controller.init();
    await flush(); // init fetches the held set once
    const saved = first.controller.getState();
    expect(Object.keys(saved.quotes)).toHaveLength(1);

    const second = rig({ backing });
    await second.controller.init();
    expect(second.controller.getState().quotes).toStrictEqual(saved.quotes);
    expect(second.controller.getState().currency).toBe(saved.currency);
  });

  it("warns and starts empty over a malformed stored snapshot", async () => {
    const backing = {
      collections: new Map<string, Map<string, Uint8Array>>([
        ["prices", new Map([["snapshot", new TextEncoder().encode("{torn")]])],
      ]),
    };
    const r = rig({ backing });
    await r.controller.init();
    expect(r.warnings).toStrictEqual(["ignoring a malformed stored price snapshot"]);
    expect(r.controller.getState()).toStrictEqual(empty());
  });

  it("switches currency: clears the quotes, refetches in it and persists the choice", async () => {
    const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
    const r = rig({
      backing,
      held: [ETH],
      answer: pricedByCurrency(ETH, { usd: "1000", eur: "900" }),
    });
    await r.controller.init();
    await flush(); // init fetches the held set once
    expect(r.calls).toHaveLength(1);
    expect(r.controller.getState().quotes[ETH]?.price).toBe("1000");

    const pending = r.controller.setCurrency("eur");
    expect(r.controller.getState().quotes).toStrictEqual({});
    await pending;
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]?.currency).toBe("eur");
    expect(r.controller.getState().quotes[ETH]?.price).toBe("900");
    expect(r.controller.getState().currency).toBe("eur");

    const fresh = rig({ backing });
    await fresh.controller.init();
    expect(fresh.controller.getState().currency).toBe("eur");
  });

  it("discards a late answer on lock, cancels the poll and unsubscribes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({ held: [ETH], answer: gatedFirst(gate) });
    await r.controller.init();
    r.controller.setVisible(true); // immediate fetch (still pending) + poll armed

    r.controller.lock();
    expect(r.controller.getState()).toStrictEqual(empty());
    expect(r.timers.armed(PRICES_POLL_MS)).toBe(0);

    release?.();
    await flush();
    expect(r.controller.getState()).toStrictEqual(empty());
    expect(r.timers.armed()).toBe(0);

    r.notify(); // the listener was unsubscribed — nothing happens
    await r.controller.refresh(); // locked: a no-op
    await flush();
    expect(r.calls).toHaveLength(1);
  });

  it("prunes an asset no longer held from the quotes on the next success", async () => {
    const r = rig({ held: [ETH, USDC] });
    await r.controller.init();
    await flush(); // init fetches the held set once
    expect(Object.keys(r.controller.getState().quotes)).toStrictEqual([USDC, ETH]);

    r.setHeld([ETH]);
    await r.controller.refresh();
    expect(Object.keys(r.controller.getState().quotes)).toStrictEqual([ETH]);
    expect(r.controller.getState().errors).toStrictEqual({});
  });

  it("starts polling and fetches right away when it went visible before init", async () => {
    const r = rig({ held: [ETH] });
    r.controller.setVisible(true);
    await r.controller.init();
    await flush();
    expect(r.calls).toHaveLength(1);
    expect(r.timers.armed(PRICES_POLL_MS)).toBe(1);
  });

  it("clears everything on destroy", async () => {
    const r = rig({ held: [ETH] });
    await r.controller.init();
    await flush(); // init fetches the held set once
    expect(Object.keys(r.controller.getState().quotes)).toHaveLength(1);
    await r.controller.destroy();
    expect(r.controller.getState()).toStrictEqual(empty());
  });

  it("does nothing on refresh while nothing is held", async () => {
    const r = rig({ held: [] });
    await r.controller.init();
    await r.controller.refresh();
    expect(r.calls).toHaveLength(0);
    expect(r.controller.getState()).toStrictEqual(empty());
  });

  it("ignores setCurrency while locked or when the currency is unchanged", async () => {
    const r = rig({ held: [ETH] });
    await r.controller.setCurrency("eur"); // before init — a no-op
    expect(r.controller.getState()).toStrictEqual(empty());

    await r.controller.init();
    await flush(); // init fetches the held set once
    await r.controller.setCurrency("usd"); // already usd — a no-op
    expect(r.calls).toHaveLength(1);
    expect(r.controller.getState().currency).toBe("usd");
  });

  it("logs a failed poll, keeps polling, and rethrows a direct refresh", async () => {
    const r = rig();
    await r.controller.init();
    r.controller.setVisible(true);
    await flush();
    expect(r.calls).toHaveLength(0); // nothing held yet — visible alone fetches nothing

    r.setHeld([ETH]);
    await r.timers.fire(PRICES_POLL_MS);
    expect(r.calls).toHaveLength(1);

    r.throwHeld(new Error("state gone"));
    await r.timers.fire(PRICES_POLL_MS);
    expect(r.warnings).toStrictEqual(["price refresh failed"]);
    await expect(r.controller.refresh()).rejects.toThrow("state gone");

    r.throwHeld(undefined);
    await r.timers.fire(PRICES_POLL_MS);
    expect(r.calls).toHaveLength(2);
  });

  it("warns when the snapshot cannot be saved but still applies the quotes", async () => {
    const mem = createMemoryEngineStore();
    const store: EngineStore = {
      collection: (name) => {
        const inner = mem.collection(name);
        return {
          get: async (key) => inner.get(key),
          put: async () => {
            await Promise.resolve();
            throw new Error("disk full");
          },
          delete: async (key) => inner.delete(key),
          list: async () => inner.list(),
        };
      },
      close: async () => mem.close(),
    };
    const r = rig({ store, held: [ETH] });
    await r.controller.init();
    await flush(); // init fetches the held set once
    expect(r.controller.getState().quotes[ETH]?.price).toBe("1");
    expect(r.warnings).toStrictEqual(["price snapshot could not be saved"]);
  });
});
