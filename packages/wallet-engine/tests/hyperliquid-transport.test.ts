import { describe, expect, it } from "vite-plus/test";

import { createHyperliquidClock, MAX_SKEW_MS } from "../src/apps/hyperliquid/clock.ts";
import { HyperliquidError } from "../src/apps/hyperliquid/errors.ts";
import {
  createHyperliquidTransport,
  REQUEST_TIMEOUT_MS,
} from "../src/apps/hyperliquid/transport.ts";

/** The HyperliquidError category `fn` throws — "foreign" for other throws, `undefined` otherwise. */
const skewError = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof HyperliquidError ? error.category : "foreign";
  }
  return undefined;
};

const category = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HyperliquidError) {
      return error.category;
    }
    throw error;
  }
  throw new Error("expected rejection");
};

type Timers = { queue: Array<{ ms: number; fn: () => unknown; cancelled: boolean }> };
const manualTimer = (): {
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly timers: Timers["queue"];
} => {
  const timers: Timers["queue"] = [];
  return {
    timers,
    setTimer: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
};

const transport = (
  fetch: typeof globalThis.fetch,
  extra?: { now?: () => number; setTimer?: ReturnType<typeof manualTimer>["setTimer"] },
) => {
  const { setTimer } = manualTimer();
  return createHyperliquidTransport({
    network: "Mainnet",
    fetch,
    setTimer: extra?.setTimer ?? setTimer,
    now: extra?.now ?? (() => 1_800_000_000_000),
    clock: createHyperliquidClock(extra?.now ?? (() => 1_800_000_000_000)),
  });
};

describe("hyperliquid transport", () => {
  it("posts JSON to the network's /info and /exchange endpoints", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const t = transport(async (input, init) => {
      await Promise.resolve();
      urls.push(String(input));
      bodies.push(String(init?.body));
      return new Response("{}", { headers: { date: new Date(1_800_000_000_000).toUTCString() } });
    });
    expect(t.isTestnet).toBe(false);
    await expect(t.request("info", { type: "allMids" })).resolves.toStrictEqual({});
    await expect(t.request("exchange", { action: {} })).resolves.toStrictEqual({});
    expect(urls).toStrictEqual([
      "https://api.hyperliquid.xyz/info",
      "https://api.hyperliquid.xyz/exchange",
    ]);
    expect(bodies).toStrictEqual(['{"type":"allMids"}', '{"action":{}}']);
  });

  it("uses the testnet base URL", async () => {
    let url = "";
    const t = createHyperliquidTransport({
      network: "Testnet",
      fetch: async (input) => {
        await Promise.resolve();
        url = String(input);
        return new Response("[]");
      },
      setTimer: () => () => undefined,
      now: () => 0,
      clock: createHyperliquidClock(() => 0),
    });
    expect(t.isTestnet).toBe(true);
    await t.request("info", {});
    expect(url).toBe("https://api.hyperliquid-testnet.xyz/info");
  });

  it("maps a non-2xx status to unavailable", async () => {
    const t = transport(async () => Promise.resolve(new Response("rate limited", { status: 429 })));
    await expect(category(t.request("info", {}))).resolves.toBe("unavailable");
  });

  it("maps a non-JSON body to network", async () => {
    const t = transport(async () => Promise.resolve(new Response("not json")));
    await expect(category(t.request("info", {}))).resolves.toBe("network");
  });

  it("maps a fetch rejection to network", async () => {
    const t = transport(async () => Promise.reject(new TypeError("socket closed")));
    await expect(category(t.request("info", {}))).resolves.toBe("network");
  });

  it("maps a timer-fired abort to timeout, never network", async () => {
    const { setTimer, timers } = manualTimer();
    const t = transport(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      { setTimer },
    );
    const call = t.request("exchange", { action: {} });
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(REQUEST_TIMEOUT_MS);
    timers[0]?.fn();
    await expect(category(call)).resolves.toBe("timeout");
  });

  it("a caller-supplied abort is not a timeout", async () => {
    const { setTimer } = manualTimer();
    const controller = new AbortController();
    const t = transport(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      { setTimer },
    );
    const call = t.request("info", {}, controller.signal);
    controller.abort();
    await expect(category(call)).resolves.toBe("network");
  });

  it("feeds every response's Date header into the clock", async () => {
    const now = () => 1_800_000_000_000;
    const clock = createHyperliquidClock(now);
    const t = createHyperliquidTransport({
      network: "Mainnet",
      fetch: async () =>
        Promise.resolve(
          new Response("{}", {
            headers: { date: new Date(1_800_000_002_000).toUTCString() },
          }),
        ),
      setTimer: () => () => undefined,
      now,
      clock,
    });
    await t.request("info", {});
    // server ms + 500 − midpoint of [requestStart, responseEnd] ≈ 2 s + 0.5 s.
    expect(clock.skew()).toBe(2500);
  });
});

describe("hyperliquid clock", () => {
  it("reports the latest estimate and gates on the bound", () => {
    const clock = createHyperliquidClock(() => 0);
    clock.record(1000, 0, 1000);
    expect(clock.skew()).toBe(1000);
    clock.record(1000 + MAX_SKEW_MS + 1, 0, 1000);
    expect(skewError(() => clock.assertSkew())).toBe("clock-skew");
    clock.record(1000, 0, 1000);
    expect(() => clock.assertSkew()).not.toThrow();
  });

  it("nonces are device time, strictly increasing per signer, independent across signers", () => {
    let now = 100;
    const clock = createHyperliquidClock(() => now);
    const a = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(clock.nextNonce(a)).toBe(100);
    expect(clock.nextNonce(a)).toBe(101);
    now = 50;
    expect(clock.nextNonce(a)).toBe(102);
    expect(clock.nextNonce(b)).toBe(50);
    expect(clock.nextNonce(b)).toBe(51);
  });
});
