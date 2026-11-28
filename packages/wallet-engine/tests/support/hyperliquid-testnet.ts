/**
 * The testnet-only network boundary for the gated Hyperliquid e2e. Every byte the suite or the
 * product path sends goes through this guard: it refuses synchronously — before any I/O — anything
 * that is not the Hyperliquid **testnet** `/info` or `/exchange` endpoint, the local eligibility
 * answer, or the testnet WebSocket. Refusals are recorded in `violations` so a product path that
 * swallows the thrown error still fails the run.
 */
import type { AppSocket } from "../../src/apps/socket.ts";

const TESTNET_HOST = "api.hyperliquid-testnet.xyz";
const ELIGIBILITY_URL = "https://gateway.test/v1/eligibility";
const INFO_PATHS = new Set(["/info", "/exchange"]);

/** `/exchange` `action.type`s the suite may ever send — no value-out action is on this list. */
const EXCHANGE_ACTIONS = new Set([
  "order",
  "cancel",
  "cancelByCloid",
  "modify",
  "batchModify",
  "updateLeverage",
  "updateIsolatedMargin",
  "approveAgent",
  "usdClassTransfer",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const inputText = (input: string | Request | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

export type TestnetGuard = {
  readonly fetch: typeof globalThis.fetch;
  readonly socket: (url: string) => AppSocket;
  /** Every refusal — asserted empty by the suite's final afterAll. */
  readonly violations: string[];
  /** Every allowed `/exchange` post (action + nonce only — never the signature). */
  readonly exchangePosts: Array<{
    readonly type: string;
    readonly nonce: number;
    readonly action: unknown;
    response?: unknown;
  }>;
  /**
   * One-shot hook on the next `/exchange` body: return the (possibly tampered) body to send, or
   * `"drop"` to simulate a lost request (a `TypeError("fetch failed")`, never sent).
   */
  readonly nextExchange: (
    fn: (body: Record<string, unknown>) => Record<string, unknown> | "drop",
  ) => void;
};

export function createTestnetGuard(inner: {
  readonly fetch: typeof globalThis.fetch;
  readonly socket: (url: string) => AppSocket;
}): TestnetGuard {
  const violations: string[] = [];
  const exchangePosts: TestnetGuard["exchangePosts"] = [];
  let pending: ((body: Record<string, unknown>) => Record<string, unknown> | "drop") | undefined;

  const refuse = (description: string): never => {
    violations.push(description);
    throw new Error(`testnet guard refused ${description}`);
  };

  const urlOf = (input: string | Request | URL): URL => {
    try {
      return new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    } catch {
      return refuse(`unparsable url ${inputText(input)}`);
    }
  };

  const exchangeBody = (
    input: string | Request | URL,
    init?: RequestInit,
  ): Record<string, unknown> => {
    if (typeof init?.body === "string") {
      const parsed: unknown = JSON.parse(init.body);
      return isRecord(parsed) ? parsed : refuse("exchange post body is not an object");
    }
    return refuse(
      `exchange post without a readable body (${input instanceof Request ? "Request" : "no init.body"})`,
    );
  };

  const post = async (
    input: string | Request | URL,
    init: RequestInit | undefined,
    url: URL,
    body: Record<string, unknown>,
  ): Promise<Response> => {
    const hook = pending;
    pending = undefined;
    const sent = hook === undefined ? body : hook(body);
    if (sent === "drop") {
      throw new TypeError("fetch failed");
    }
    const { action } = sent;
    const entry: { type: string; nonce: number; action: unknown; response?: unknown } = {
      type: isRecord(action) ? String(action["type"]) : "",
      nonce: typeof sent["nonce"] === "number" ? sent["nonce"] : Number.NaN,
      action,
    };
    exchangePosts.push(entry);
    const target = input instanceof Request ? input : url.href;
    const response = await inner.fetch(target, { ...init, body: JSON.stringify(sent) });
    entry.response = await response
      .clone()
      .json()
      .catch(() => undefined);
    return response;
  };

  // oxlint-disable-next-line typescript/promise-function-async -- invalid targets must throw synchronously, before any I/O
  const guardedFetch: typeof globalThis.fetch = (input, init) => {
    const url = urlOf(input);
    if (url.href === ELIGIBILITY_URL) {
      return Promise.resolve(
        Response.json({ country: null, region: null, apps: { hyperliquid: "available" } }),
      );
    }
    if (
      url.protocol === "https:" &&
      url.hostname === TESTNET_HOST &&
      url.port === "" &&
      INFO_PATHS.has(url.pathname)
    ) {
      if (url.pathname === "/exchange") {
        const body = exchangeBody(input, init);
        const action = isRecord(body["action"]) ? body["action"] : {};
        const type = typeof action["type"] === "string" ? action["type"] : "";
        if (!EXCHANGE_ACTIONS.has(type)) {
          return refuse(`exchange action ${JSON.stringify(type)}`);
        }
        return post(input, init, url, body);
      }
      return inner.fetch(input, init);
    }
    return refuse(`url ${url.href}`);
  };

  return {
    fetch: guardedFetch,
    socket: (url) => {
      if (url !== `wss://${TESTNET_HOST}/ws`) {
        return refuse(`socket ${url}`);
      }
      return inner.socket(url);
    },
    violations,
    exchangePosts,
    nextExchange: (fn) => {
      pending = fn;
    },
  };
}
