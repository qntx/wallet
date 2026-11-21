/// <reference types="node" />
/**
 * Records live Hyperliquid WebSocket frames into
 * packages/wallet-engine/tests/fixtures/hyperliquid/<network>/ws-<channel>.json — the sent
 * subscription payload, the record date, the first `subscriptionResponse` echo and a few data
 * frames — so socket/live tests replay real wire shapes instead of hand-made frames.
 *
 * Market channels (l2Book/trades/candle) subscribe for BTC; user channels reuse the account the
 * HTTP recordings picked (`_account.json` beside the fixtures). Needs Node ≥ 22 (global
 * WebSocket) or bun.
 *
 * Run from the repo root: bun scripts/vectors/hyperliquid-ws-recordings.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = resolve(ROOT, "../packages/wallet-engine/tests/fixtures/hyperliquid");
/* Fast channels (l2Book, trades) reach the cap quickly; quiet channels (candle ticks once a
   minute, openOrders only pushes on change, idle accounts stay silent) keep whatever the
   window produced — the echo alone still documents the wire shape. */
const FRAMES_PER_CHANNEL = 3;
const WINDOW_MS = 60_000;

const NETWORKS = {
  mainnet: "wss://api.hyperliquid.xyz/ws",
  testnet: "wss://api.hyperliquid-testnet.xyz/ws",
} as const;

type Recorded = {
  readonly subscription: unknown;
  readonly recordedAt: number;
  readonly echo: unknown;
  readonly frames: ReadonlyArray<unknown>;
};

const accountOf = (network: string): string => {
  const path = resolve(OUT, network, "_account.json");
  if (existsSync(path)) {
    const user = (JSON.parse(readFileSync(path, "utf8")) as { user?: string }).user;
    if (typeof user === "string") {
      return user;
    }
  }
  throw new Error(`no recorded account for ${network} — run hyperliquid-recordings.ts first`);
};

const subscriptionsFor = (user: string): ReadonlyArray<readonly [string, unknown]> => [
  ["l2Book", { type: "l2Book", coin: "BTC" }],
  ["trades", { type: "trades", coin: "BTC" }],
  ["candle", { type: "candle", coin: "BTC", interval: "1m" }],
  ["clearinghouseState", { type: "clearinghouseState", user }],
  ["openOrders", { type: "openOrders", user }],
  ["userFills", { type: "userFills", user }],
];

const record = async (url: string, user: string): Promise<Map<string, Recorded>> => {
  const out = new Map<string, Recorded>();
  const ws = new WebSocket(url);
  const echoes = new Map<string, unknown>();
  const frames = new Map<string, unknown[]>();
  const pending = subscriptionsFor(user).map(([name, payload]) => ({ name, payload }));
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const deadline = setTimeout(() => {
      ws.close();
      resolvePromise(); // the window closed — record whatever arrived
    }, WINDOW_MS);
    ws.onopen = () => {
      for (const { payload } of pending) {
        ws.send(JSON.stringify({ method: "subscribe", subscription: payload }));
      }
    };
    ws.onerror = () => rejectPromise(new Error("websocket error"));
    ws.onclose = () => {
      resolvePromise(); // an early close records whatever arrived
    };
    ws.onmessage = (event) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof frame !== "object" || frame === null || !("channel" in frame)) {
        return;
      }
      const channel = (frame as { channel: string }).channel;
      const data = (frame as { data?: unknown }).data;
      if (channel === "subscriptionResponse") {
        /* Match the echo back to its pending payload by subset containment, like the
           transport does — the echo's `subscription` field carries the wire shape. */
        const echoSub =
          typeof data === "object" && data !== null
            ? (data as { subscription?: unknown }).subscription
            : undefined;
        const hit = pending.find(
          ({ payload }) =>
            typeof payload === "object" &&
            payload !== null &&
            (payload as { type?: string }).type ===
              (typeof echoSub === "object" && echoSub !== null
                ? (echoSub as { type?: string }).type
                : undefined),
        );
        if (hit !== undefined) {
          echoes.set(hit.name, data);
        }
        return;
      }
      if (channel === "pong" || channel === "error") {
        return;
      }
      const list = frames.get(channel) ?? [];
      frames.set(channel, [...list, frame]);
      const hit = pending.find(({ name }) => name === channel);
      if (
        hit !== undefined &&
        !out.has(channel) &&
        (frames.get(channel)?.length ?? 0) >= FRAMES_PER_CHANNEL
      ) {
        out.set(channel, {
          subscription: hit.payload,
          recordedAt: Date.now(),
          echo: echoes.get(channel),
          frames: frames.get(channel) ?? [],
        });
      }
    };
  });
  /* Every channel that echoed a subscriptionResponse is written, even with no data frames. */
  for (const { name, payload } of pending) {
    if (echoes.has(name) && !out.has(name)) {
      out.set(name, {
        subscription: payload,
        recordedAt: Date.now(),
        echo: echoes.get(name),
        frames: frames.get(name) ?? [],
      });
    }
  }
  return out;
};

for (const [network, url] of Object.entries(NETWORKS)) {
  const user = accountOf(network);
  const recorded = await record(url, user);
  for (const [name, fixture] of recorded) {
    const path = resolve(OUT, network, `ws-${name}.json`);
    writeFileSync(path, `${JSON.stringify(fixture)}\n`);
    console.log(`${network}/ws-${name}.json ${JSON.stringify(fixture).length} B`);
  }
}
