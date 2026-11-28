/**
 * Offline checks for the e2e testnet guard: every refused URL must record a violation and never
 * reach the inner fetch/socket — the funded e2e address holds real money on mainnet, so nothing may
 * ever leave for api.hyperliquid.xyz or any non-testnet host.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import { createHyperliquidProvider } from "../src/apps/hyperliquid/provider.ts";
import type { AppSocket } from "../src/apps/socket.ts";
import { createTestnetGuard } from "./support/hyperliquid-testnet.ts";

const inner = () => ({
  fetch: vi.fn(async (): Promise<Response> => {
    await Promise.resolve();
    return Response.json({ ok: true });
  }),
  socket: vi.fn((): AppSocket => {
    throw new Error("unreachable");
  }),
});

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("hyperliquid testnet guard", () => {
  it("refuses mainnet info and exchange without calling inner", () => {
    const spies = inner();
    const guard = createTestnetGuard(spies);
    expect(() => {
      void guard.fetch("https://api.hyperliquid.xyz/info", post({ type: "allMids" }));
    }).toThrow("testnet guard refused");
    expect(() => {
      void guard.fetch(
        "https://api.hyperliquid.xyz/exchange",
        post({ action: { type: "order" }, nonce: 1 }),
      );
    }).toThrow("testnet guard refused");
    expect(spies.fetch).not.toHaveBeenCalled();
    expect(guard.violations).toHaveLength(2);
  });

  it.each([
    "https://api.hyperliquid-testnet.xyz.evil.com/info",
    "http://api.hyperliquid-testnet.xyz/info",
    "https://api.hyperliquid-testnet.xyz@api.hyperliquid.xyz/info",
    "https://api.hyperliquid-testnet.xyz:8443/info",
  ])("refuses the lookalike url %s", (url) => {
    const spies = inner();
    const guard = createTestnetGuard(spies);
    expect(() => {
      void guard.fetch(url, post({ type: "allMids" }));
    }).toThrow("testnet guard refused");
    expect(spies.fetch).not.toHaveBeenCalled();
    expect(guard.violations).toHaveLength(1);
  });

  it("passes testnet /info through to inner", async () => {
    const spies = inner();
    const guard = createTestnetGuard(spies);
    const response = await guard.fetch(
      "https://api.hyperliquid-testnet.xyz/info",
      post({ type: "allMids" }),
    );
    await expect(response.json()).resolves.toStrictEqual({ ok: true });
    expect(spies.fetch).toHaveBeenCalledTimes(1);
    expect(guard.violations).toHaveLength(0);
  });

  it("answers eligibility locally without calling inner", async () => {
    const spies = inner();
    const guard = createTestnetGuard(spies);
    const response = await guard.fetch("https://gateway.test/v1/eligibility");
    await expect(response.json()).resolves.toStrictEqual({
      country: null,
      region: null,
      apps: { hyperliquid: "available" },
    });
    expect(spies.fetch).not.toHaveBeenCalled();
    expect(guard.violations).toHaveLength(0);
  });

  it.each(["withdraw3", "usdSend", "spotSend", "sendAsset"])(
    "refuses exchange action %s without calling inner",
    (type) => {
      const spies = inner();
      const guard = createTestnetGuard(spies);
      expect(() => {
        void guard.fetch(
          "https://api.hyperliquid-testnet.xyz/exchange",
          post({ action: { type }, nonce: 1, signature: {} }),
        );
      }).toThrow("testnet guard refused");
      expect(spies.fetch).not.toHaveBeenCalled();
      expect(guard.violations).toHaveLength(1);
      expect(guard.exchangePosts).toHaveLength(0);
    },
  );

  it("records allowed exchange posts and applies the one-shot hook", async () => {
    const spies = inner();
    const guard = createTestnetGuard(spies);
    const order = { action: { type: "order", orders: [] }, nonce: 7, signature: {} };
    guard.nextExchange((body) => ({ ...body, nonce: 8 }));
    await guard.fetch("https://api.hyperliquid-testnet.xyz/exchange", post(order));
    expect(spies.fetch).toHaveBeenCalledWith(
      "https://api.hyperliquid-testnet.xyz/exchange",
      expect.objectContaining({ body: JSON.stringify({ ...order, nonce: 8 }) }),
    );
    expect(guard.exchangePosts).toStrictEqual([
      { type: "order", nonce: 8, action: order.action, response: { ok: true } },
    ]);
    // The hook is one-shot — the next post goes through unmodified.
    await guard.fetch("https://api.hyperliquid-testnet.xyz/exchange", post(order));
    expect(guard.exchangePosts).toHaveLength(2);
    expect(guard.exchangePosts[1]?.nonce).toBe(7);
    // A "drop" hook fails the request without sending.
    guard.nextExchange(() => "drop");
    await expect(
      guard.fetch("https://api.hyperliquid-testnet.xyz/exchange", post(order)),
    ).rejects.toThrow(TypeError);
    expect(guard.violations).toHaveLength(0);
  });

  it("refuses a mainnet websocket", () => {
    const spies = inner();
    const guard = createTestnetGuard(spies);
    expect(() => guard.socket("wss://api.hyperliquid.xyz/ws")).toThrow("testnet guard refused");
    expect(spies.socket).not.toHaveBeenCalled();
    expect(guard.violations).toHaveLength(1);
  });

  it("a mainnet provider cannot reach the network through the guard", async () => {
    const spies = inner();
    const guard = createTestnetGuard(spies);
    const provider = createHyperliquidProvider({
      network: "Mainnet",
      fetch: guard.fetch,
      now: () => 1_800_000_000_000,
      setTimer: () => () => undefined,
      wallet: Object.create(null) as Wallet,
      random: () => new Uint8Array(0),
      logger: { warn: () => undefined },
    });
    /* The transport wraps the synchronous refusal in its network error — what matters is the
       inner fetch was never called and the violation was recorded. */
    await expect(provider.markets.mids()).rejects.toThrow("POST /info failed");
    expect(spies.fetch).not.toHaveBeenCalled();
    expect(guard.violations).toHaveLength(1);
  });
});
