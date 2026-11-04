/**
 * `createBrowserBridge` and `injectedScript` — the `@qntx/wallet-engine/connect` host↔page
 * transport. The bridge takes the page's origin only from `topUrl` (`nativeEvent.url`), drops
 * malformed/oversized messages, rate-limits to 120/min/origin, filters events to the current
 * origin, and voids the old origin's pending work on navigation.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import {
  createBrowserBridge,
  injectedScript,
  PROVIDER_SCRIPT_SHA256,
  ProviderError,
} from "../src/connect/index.ts";
import type {
  BrowserBridgeOptions,
  Eip1193Event,
  Eip1193Request,
  Nip07Request,
  WeblnRequest,
  SolanaRequest,
  ProviderInfo,
} from "../src/connect/index.ts";
import { PROVIDER_SCRIPT } from "../src/connect/inject.generated.ts";

const SITE = "https://app.example.com";
const PAGE = `${SITE}/dapp`;
const OTHER = "https://other.example.com";

const INFO: ProviderInfo = {
  uuid: "550e8400-e29b-41d4-a716-446655440000",
  name: "Qntx Wallet",
  icon: `data:image/png;base64,${"A".repeat(16)}`,
  rdns: "xyz.meowl",
};

type Handle = (origin: string, request: Eip1193Request) => Promise<unknown>;

const tick = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve);
  });

const request = (
  id: number,
  method = "eth_chainId",
  provider = "eip1193",
  extra: object = {},
): string => JSON.stringify({ qntx: 1, id, method, provider, ...extra });

function rig(handle: Handle = async () => Promise.resolve("result")) {
  const injections: string[] = [];
  const listeners: Array<(event: Eip1193Event) => void> = [];
  const invalidated: string[] = [];
  const handled: Array<{ origin: string; request: Eip1193Request }> = [];
  const handledNostr: Array<{ origin: string; request: Nip07Request }> = [];
  const handledWebln: Array<{ origin: string; request: WeblnRequest }> = [];
  const handledSolana: Array<{ origin: string; request: SolanaRequest }> = [];
  const phishing = new Set<string>();
  let now = 0;
  const options: BrowserBridgeOptions = {
    inject: (script) => {
      injections.push(script);
    },
    now: () => now,
    eip1193: {
      handle: async (origin, req) => {
        handled.push({ origin, request: req });
        return handle(origin, req);
      },
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
    },
    nip07: {
      handle: async (origin, req) => {
        handledNostr.push({ origin, request: req });
        return Promise.resolve("nostr-result");
      },
    },
    webln: {
      handle: async (origin, req) => {
        handledWebln.push({ origin, request: req });
        return Promise.resolve("webln-result");
      },
    },
    solana: {
      handle: async (origin, req) => {
        handledSolana.push({ origin, request: req });
        return Promise.resolve("solana-result");
      },
      subscribe: () => () => undefined,
    },
    connections: {
      checkOrigin: (origin) => {
        if (!origin.startsWith("https://")) {
          throw new ProviderError(4100, "origin not allowed");
        }
        if (phishing.has(origin)) {
          throw new ProviderError(4100, "origin is on the phishing list");
        }
        return { kind: "browser", origin };
      },
      invalidateOrigin: (origin) => {
        invalidated.push(origin);
      },
    },
  };
  const bridge = createBrowserBridge(options);
  const emit = (event: Eip1193Event): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  const advance = (ms: number): void => {
    now += ms;
  };
  return {
    bridge,
    injections,
    invalidated,
    handled,
    handledNostr,
    handledWebln,
    handledSolana,
    phishing,
    emit,
    advance,
  };
}

/** Decodes one `globalThis.__qntxReceive("<json>")` injection (the argument is a JSON string). */
const payloadOf = (script: string | undefined): unknown => {
  const match = /__qntxReceive\((.*)\)$/.exec(script ?? "");
  const literal: unknown = JSON.parse(match?.[1] ?? "null");
  return typeof literal === "string" ? JSON.parse(literal) : undefined;
};

describe("createBrowserBridge", () => {
  it("takes the origin from topUrl only — a page-reported origin field is ignored", async () => {
    const { bridge, handled } = rig();
    bridge.navigated(PAGE);
    bridge.message(PAGE, request(1, "eth_chainId", "eip1193", { origin: "https://evil.example" }));
    await tick();
    expect(handled).toStrictEqual([{ origin: SITE, request: { method: "eth_chainId" } }]);
  });

  it("routes provider: nostr to the nip07 handler", async () => {
    const { bridge, handled, handledNostr, injections } = rig();
    bridge.navigated(PAGE);
    bridge.message(PAGE, request(2, "getPublicKey", "nostr", { params: [] }));
    await tick();
    expect(handled).toHaveLength(0);
    expect(handledNostr).toStrictEqual([
      { origin: SITE, request: { method: "getPublicKey", params: [] } },
    ]);
    expect(payloadOf(injections.at(-1))).toStrictEqual({ id: 2, result: "nostr-result" });
  });

  it("drops the messages of an origin on the phishing list, whichever provider they address", async () => {
    const { bridge, handled, handledNostr, handledWebln, handledSolana, injections, phishing } =
      rig();
    phishing.add(SITE);
    bridge.navigated(PAGE);
    for (const provider of ["eip1193", "nostr", "webln", "solana"]) {
      bridge.message(PAGE, request(1, "eth_chainId", provider));
    }
    await tick();
    expect([handled, handledNostr, handledWebln, handledSolana].map((h) => h.length)).toStrictEqual(
      [0, 0, 0, 0],
    );
    expect(injections).toHaveLength(0);
  });

  it("drops a message whose topUrl is not the current top origin", async () => {
    const { bridge, handled, injections } = rig();
    bridge.navigated(PAGE);
    bridge.message(`${OTHER}/frame`, request(1));
    await tick();
    expect(handled).toHaveLength(0);
    expect(injections).toHaveLength(0);
  });

  it.each([
    ["not JSON", "this is not json"],
    ["missing qntx", JSON.stringify({ id: 1, method: "eth_chainId" })],
    ["missing id", JSON.stringify({ qntx: 1, method: "eth_chainId" })],
    ["missing method", JSON.stringify({ qntx: 1, id: 1 })],
    ["id not a number", JSON.stringify({ qntx: 1, id: "1", method: "eth_chainId" })],
    ["negative id", request(-1)],
    ["fractional id", request(1.5)],
    ["missing provider", JSON.stringify({ qntx: 1, id: 1, method: "x" })],
    ["unknown provider", request(1, "x", "bogus")],
    ["over 128 KiB", "x".repeat(128 * 1024 + 1)],
  ])("drops a malformed message (%s) without replying", async (_label, data) => {
    const { bridge, injections, handled } = rig();
    bridge.navigated(PAGE);
    bridge.message(PAGE, data);
    await tick();
    expect(handled).toHaveLength(0);
    expect(injections).toHaveLength(0);
  });

  it("replies to a valid request", async () => {
    const { bridge, injections } = rig(async () => Promise.resolve("0x1"));
    bridge.navigated(PAGE);
    bridge.message(PAGE, request(7));
    await tick();
    expect(payloadOf(injections.at(-1))).toStrictEqual({ id: 7, result: "0x1" });
  });

  it("keeps a provider error's code and message", async () => {
    const { bridge, injections } = rig(async () =>
      Promise.reject(new ProviderError(4001, "user rejected")),
    );
    bridge.navigated(PAGE);
    bridge.message(PAGE, request(3));
    await tick();
    expect(payloadOf(injections.at(-1))).toStrictEqual({
      id: 3,
      error: { code: 4001, message: "user rejected" },
    });
  });

  it("hides any other error behind -32603", async () => {
    const { bridge, injections } = rig(async () =>
      Promise.reject(new Error("gateway https://internal.example failed")),
    );
    bridge.navigated(PAGE);
    bridge.message(PAGE, request(4));
    await tick();
    expect(payloadOf(injections.at(-1))).toStrictEqual({
      id: 4,
      error: { code: -32603, message: "internal error" },
    });
  });

  it("rate-limits to 120 requests a minute per origin with 4900", async () => {
    const { bridge, injections } = rig();
    bridge.navigated(PAGE);
    for (let id = 0; id < 121; id += 1) {
      bridge.message(PAGE, request(id));
    }
    await tick();
    expect(injections.map(payloadOf)).toContainEqual({
      id: 120,
      error: { code: 4900, message: "disconnected" },
    });
  });

  it("admits requests again once the minute has passed", async () => {
    const { bridge, injections, advance } = rig();
    bridge.navigated(PAGE);
    for (let id = 0; id < 120; id += 1) {
      bridge.message(PAGE, request(id));
    }
    advance(60_001);
    bridge.message(PAGE, request(500));
    await tick();
    expect(injections.map(payloadOf)).toContainEqual({ id: 500, result: "result" });
  });

  it("navigation voids the old origin's pending work and drops its late replies", async () => {
    const pendingReplies: Array<(value: unknown) => void> = [];
    const { bridge, injections, invalidated } = rig(
      async () =>
        new Promise((resolve) => {
          pendingReplies.push(resolve);
        }),
    );
    bridge.navigated(PAGE);
    bridge.message(PAGE, request(1, "eth_requestAccounts"));
    await tick();
    bridge.navigated(`${OTHER}/dapp`);
    expect(invalidated).toStrictEqual([SITE]);
    for (const resolve of pendingReplies) {
      resolve("0xabc");
    }
    await tick();
    expect(injections).toHaveLength(0);
  });

  it("navigating to an unacceptable origin still voids the old origin", () => {
    const { bridge, invalidated } = rig();
    bridge.navigated(PAGE);
    bridge.navigated("http://plain.example");
    expect(invalidated).toStrictEqual([SITE]);
  });

  it("forwards only the current origin's events, with EIP-1193 payloads", () => {
    const { bridge, injections, emit } = rig();
    bridge.navigated(PAGE);
    emit({ name: "accountsChanged", origin: OTHER, accounts: ["0x1"] });
    expect(injections).toHaveLength(0);
    emit({ name: "accountsChanged", origin: SITE, accounts: ["0x2"] });
    emit({ name: "chainChanged", origin: SITE, chainId: "0x1" });
    emit({ name: "connect", origin: SITE, chainId: "0x1" });
    emit({ name: "disconnect", origin: SITE });
    expect(injections.map(payloadOf)).toStrictEqual([
      { event: "accountsChanged", data: ["0x2"] },
      { event: "chainChanged", data: "0x1" },
      { event: "connect", data: { chainId: "0x1" } },
      { event: "disconnect", data: { code: 4900, message: "disconnected" } },
    ]);
  });

  it("dispose unsubscribes and voids the current origin", () => {
    const { bridge, injections, invalidated, emit } = rig();
    bridge.navigated(PAGE);
    bridge.dispose();
    emit({ name: "accountsChanged", origin: SITE, accounts: [] });
    expect(injections).toHaveLength(0);
    expect(invalidated).toStrictEqual([SITE]);
  });
});

describe("injectedScript", () => {
  it("appends one qntxProvider.install(<JSON>) call to the fixed script", () => {
    const script = injectedScript(INFO);
    expect(script).toBe(`${PROVIDER_SCRIPT}\nqntxProvider.install(${JSON.stringify(INFO)});`);
  });

  it.each([
    ["bad uuid", { ...INFO, uuid: "not-a-uuid" }],
    ["empty name", { ...INFO, name: "" }],
    ["name over 64", { ...INFO, name: "x".repeat(65) }],
    ["icon not a data URL", { ...INFO, icon: "https://x/icon.png" }],
    ["icon over 64 KiB", { ...INFO, icon: `data:image/png;base64,${"A".repeat(64 * 1024 + 1)}` }],
    ["icon not base64", { ...INFO, icon: "data:image/png;base64,!!!" }],
    ["rdns not lowercase labels", { ...INFO, rdns: "Meowl.XYZ" }],
    ["rdns single label", { ...INFO, rdns: "meowl" }],
  ])("rejects %s", (_label, info) => {
    expect(() => injectedScript(info)).toThrow(/ProviderInfo/);
  });

  it("PROVIDER_SCRIPT_SHA256 is the sha256 of the generated script", () => {
    expect(PROVIDER_SCRIPT_SHA256).toBe(bytesToHex(sha256(utf8ToBytes(PROVIDER_SCRIPT))));
  });
});

it("routes provider: webln to the webln handler", async () => {
  const { bridge, handled, handledNostr, handledWebln, injections } = rig();
  bridge.navigated(PAGE);
  bridge.message(PAGE, request(3, "enable", "webln", { params: [] }));
  await tick();
  expect(handled).toHaveLength(0);
  expect(handledNostr).toHaveLength(0);
  expect(handledWebln).toStrictEqual([{ origin: SITE, request: { method: "enable", params: [] } }]);
  expect(payloadOf(injections.at(-1))).toStrictEqual({ id: 3, result: "webln-result" });
});

it("routes provider: solana to the solana handler", async () => {
  const { bridge, handled, handledNostr, handledWebln, handledSolana, injections } = rig();
  bridge.navigated(PAGE);
  bridge.message(PAGE, request(4, "solana:signMessage", "solana", { params: [] }));
  await tick();
  expect(handled).toHaveLength(0);
  expect(handledNostr).toHaveLength(0);
  expect(handledWebln).toHaveLength(0);
  expect(handledSolana).toStrictEqual([
    { origin: SITE, request: { method: "solana:signMessage", params: [] } },
  ]);
  expect(payloadOf(injections.at(-1))).toStrictEqual({ id: 4, result: "solana-result" });
});
