/* oxlint-disable unicorn/no-process-exit -- a script: process exit is the result channel */
/**
 * Review probe: metering of the `x-gateway-provider` pin added in PR #432.
 *
 * Self-contained: boots `wrangler dev` for tests/workerd/wrangler.json on port 8821 with
 * SCALE=small, drives scenarios a-e, always stops workerd. Run:
 *
 * Bun apps/gateway/tests/workerd/review/drive-pin-metering.ts
 *
 * SCALE=small: alchemy budget [{400,5s}], every other account [{10,5s}] — exhaustion in seconds.
 * Share math (SHARE_LIMITER 1000/60s, key `account:`/24): drpc clientShare 0.05 of 10/5s -> 6
 * units/min -> delta 167/call -> ~5 calls per window alchemy 0.1 of 400/5s -> 480 CU/min -> delta
 * 42 per 20-CU getSlot -> ~23 calls per window trongrid/tatum 0.1 of 10/5s -> 12 units/min -> delta
 * 84/call -> ~11 calls per window
 */
import { connect } from "node:net";

declare const process: {
  readonly argv: ReadonlyArray<string>;
  readonly env: { readonly TMPDIR?: string };
  exit: (code: number) => never;
};
declare const Bun: {
  readonly spawn: (
    cmd: ReadonlyArray<string>,
    options: { readonly cwd?: string; readonly stdout?: string; readonly stderr?: string },
  ) => {
    readonly exited: Promise<number>;
    kill: (signal?: string | number) => void;
  };
};

const HERE = new URL("..", import.meta.url).pathname; // tests/workerd
const WRANGLER = new URL("../../../node_modules/.bin/wrangler", import.meta.url).pathname;
const PORT = 8821;
const BASE = `http://localhost:${String(PORT)}`;

const CLIENT_ID = "0123456789abcdef0123456789abcdef";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON = "tron:728126428";
const GET_SLOT = { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] };

const headers = (ip: string, client = CLIENT_ID): Record<string, string> => ({
  "x-client-id": client,
  "content-type": "application/json",
  "x-test-ip": ip,
});

type Stats = {
  leases: Record<string, { calls: number; granted: number; refused: number }>;
  upstream: Record<string, { calls: number; units: number }>;
};

const stats = async (): Promise<Stats> => {
  const res = await fetch(`${BASE}/__stats`);
  return res.json();
};

const reset = async (): Promise<void> => {
  await fetch(`${BASE}/__reset`, { method: "POST" });
};

const showStats = async (label: string): Promise<Stats> => {
  const s = await stats();
  console.log(`--- stats ${label}: ${JSON.stringify(s)}`);
  return s;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** Miniflare aligns limiter windows to the wall clock — land just past a 60 s rollover. */
const freshShareWindow = async (): Promise<void> => {
  await sleep(60_000 - (Date.now() % 60_000) + 300);
};

const failed: string[] = [];
const expect = (condition: boolean, label: string): void => {
  if (!condition) {
    failed.push(label);
    console.log(`FAIL: ${label}`);
  }
};

const statusCounts = (statuses: ReadonlyArray<number>): string => {
  const counts = new Map<number, number>();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([s, n]) => `${s}x${n}`).join(" ");
};

/** Per-account upstream call/unit deltas between two stats snapshots. */
const upstreamDelta = (
  before: Stats,
  after: Stats,
): Record<string, { calls: number; units: number }> =>
  Object.fromEntries(
    Object.entries(after.upstream).map(([account, v]) => [
      account,
      {
        calls: v.calls - (before.upstream[account]?.calls ?? 0),
        units: v.units - (before.upstream[account]?.units ?? 0),
      },
    ]),
  );

const solanaRpc = async (
  ip: string,
  pin: string | undefined,
  body: unknown = GET_SLOT,
): Promise<Response> =>
  fetch(`${BASE}/v1/rpc/${SOLANA}`, {
    method: "POST",
    headers: { ...headers(ip), ...(pin === undefined ? {} : { "x-gateway-provider": pin }) },
    body: JSON.stringify(body),
  });

const tronCall = async (ip: string, pin: string | undefined, path: string, body: string) =>
  fetch(`${BASE}/v1/tron/${TRON}${path}`, {
    method: "POST",
    headers: { ...headers(ip), ...(pin === undefined ? {} : { "x-gateway-provider": pin }) },
    body,
  });

/** Sequential posts until `stop` consecutive non-200s or `max` attempts; returns statuses. */
const driveUntilRefused = async (
  send: () => Promise<Response>,
  max = 40,
  stop = 3,
): Promise<{ statuses: number[]; providers: Array<string | undefined> }> => {
  const statuses: number[] = [];
  const providers: Array<string | undefined> = [];
  let refused = 0;
  for (let i = 0; i < max && refused < stop; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential drive by design
    const res = await send();
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    statuses.push(res.status);
    providers.push(res.headers.get("x-gateway-providers") ?? undefined);
    refused = res.status === 200 ? 0 : refused + 1;
  }
  return { statuses, providers };
};

/** Sends one literal HTTP/1.1 request over a raw socket; returns the status line + first body line. */
const rawRequest = async (
  requestHeaders: ReadonlyArray<string>,
  body: string,
): Promise<{ status: number; head: string }> => {
  const payload =
    `POST /v1/rpc/${SOLANA} HTTP/1.1\r\n` +
    `Host: localhost:${String(PORT)}\r\n` +
    `x-client-id: ${CLIENT_ID}\r\n` +
    `x-test-ip: 66.77.88.99\r\n` +
    `content-type: application/json\r\n${requestHeaders.join(
      "",
    )}content-length: ${String(body.length)}\r\n` +
    `connection: close\r\n\r\n${body}`;
  return new Promise((resolve, reject) => {
    const socket = connect(PORT, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (match === null) {
        reject(new Error(`no status line in raw response: ${data.slice(0, 200)}`));
        return;
      }
      resolve({ status: Number(match[1]), head: data.slice(0, 300) });
    });
    socket.write(payload);
  });
};

/* Scenario (a): pinned vs unpinned single-call allowance. */
const scenarioA = async (): Promise<void> => {
  console.log("=== (a) pinned vs unpinned Solana getSlot, one IP, SCALE=small ===");
  await freshShareWindow();
  const ip = "60.1.1.9";
  await reset();
  const pinned = await driveUntilRefused(async () => solanaRpc(ip, "drpc"));
  const s1 = await showStats("a1 after pinned drpc drive");
  console.log(
    `A1 pinned drpc: statuses=${statusCounts(pinned.statuses)} ` +
      `providers=[${[...new Set(pinned.providers)].join(",")}]`,
  );
  const pinned200 = pinned.statuses.filter((s) => s === 200).length;
  expect(
    pinned200 > 0 && pinned200 < 40,
    `a1: pinned drpc allowed ${String(pinned200)} calls (unbounded?)`,
  );
  expect(
    pinned.statuses.some((s) => s === 429 || s === 503),
    "a1: pinned drive never refused 429/503",
  );
  expect(
    (s1.upstream["alchemy"]?.calls ?? 0) === 0,
    "a1: alchemy contacted during pinned drpc drive",
  );
  expect(
    (s1.upstream["drpc"]?.calls ?? 0) === pinned200,
    `a1: drpc upstream calls ${String(s1.upstream["drpc"]?.calls ?? 0)} != pinned 200s ${String(pinned200)}`,
  );

  const unpinned = await driveUntilRefused(async () => solanaRpc(ip, undefined));
  const s2 = await showStats("a2 after unpinned drive (same IP)");
  console.log(
    `A2 unpinned: statuses=${statusCounts(unpinned.statuses)} ` +
      `providers=[${[...new Set(unpinned.providers)].join(",")}]`,
  );
  const unpinned200 = unpinned.statuses.filter((s) => s === 200).length;
  expect(unpinned200 > 0 && unpinned200 < 40, `a2: unpinned allowed ${String(unpinned200)} calls`);
  expect(
    unpinned.statuses.some((s) => s === 429 || s === 503),
    "a2: unpinned drive never refused",
  );
  expect((s2.upstream["alchemy"]?.calls ?? 0) > 0, "a2: unpinned drive never reached alchemy");
  console.log(
    `A-SUMMARY: pinned allowance=${String(pinned200)} (drpc share, refusal 429/503 expected), ` +
      `unpinned allowance=${String(unpinned200)} (alchemy share + drpc leftover)`,
  );
};

/* Scenario (b): pinned batch of 10. */
const scenarioB = async (): Promise<void> => {
  console.log("=== (b) pinned vs unpinned batch of 10 getSlot, SCALE=small ===");
  await sleep(5500); // drpc DO bucket back to 10
  const batch10 = Array.from({ length: 10 }, (_, i) => ({ ...GET_SLOT, id: i + 1 }));
  const batch6 = batch10.slice(0, 6);
  const batch7 = batch10.slice(0, 7);

  await reset();
  let before = await stats();
  const b1 = await solanaRpc("61.1.1.1", "drpc", batch10);
  const b1Body = await b1.text();
  const sB1 = await showStats("b1 after pinned drpc batch10");
  const dB1 = upstreamDelta(before, sB1);
  console.log(`B1 pinned drpc batch10 -> ${String(b1.status)} body=${b1Body.slice(0, 120)}`);
  // 10 drpc units = shareDelta 1667 > 1000 -> too-costly before any upstream call.
  expect(
    (dB1["drpc"]?.calls ?? 0) === 0 && (dB1["alchemy"]?.calls ?? 0) === 0,
    "b1: upstream contacted for a too-costly pinned batch",
  );

  before = await stats();
  const b2 = await solanaRpc("61.1.1.1", undefined, batch10);
  await b2.text();
  const sB2 = await showStats("b2 after unpinned batch10");
  const dB2 = upstreamDelta(before, sB2);
  console.log(
    `B2 unpinned batch10 -> ${String(b2.status)} x-gateway-providers=${b2.headers.get("x-gateway-providers") ?? "-"}`,
  );
  expect(b2.status === 200, `b2: unpinned batch10 got ${String(b2.status)}`);
  expect(
    (dB2["alchemy"]?.units ?? 0) === 200,
    `b2: alchemy units ${String(dB2["alchemy"]?.units ?? 0)} != 200 (10 x getSlot x 20 CU)`,
  );

  // Boundary: batch6 delta=1000 (= SHARE_LIMIT) admitted; batch7 delta=1167 refused.
  before = await stats();
  const b3 = await solanaRpc("61.2.1.1", "drpc", batch6);
  await b3.text();
  const sB3 = await showStats("b3 after pinned drpc batch6");
  const dB3 = upstreamDelta(before, sB3);
  console.log(
    `B3 pinned drpc batch6 -> ${String(b3.status)} x-gateway-providers=${b3.headers.get("x-gateway-providers") ?? "-"}`,
  );
  expect(b3.status === 200, `b3: pinned drpc batch6 got ${String(b3.status)}`);
  expect((dB3["drpc"]?.units ?? 0) === 6, `b3: drpc units ${String(dB3["drpc"]?.units ?? 0)} != 6`);
  expect((dB3["alchemy"]?.calls ?? 0) === 0, "b3: alchemy contacted despite the drpc pin");

  before = await stats();
  const b4 = await solanaRpc("61.3.1.1", "drpc", batch7);
  await b4.text();
  const sB4 = await showStats("b4 after pinned drpc batch7");
  const dB4 = upstreamDelta(before, sB4);
  console.log(`B4 pinned drpc batch7 -> ${String(b4.status)}`);
  expect(
    (dB4["drpc"]?.calls ?? 0) === 0 && (dB4["alchemy"]?.calls ?? 0) === 0,
    "b4: upstream contacted for an over-share pinned batch7",
  );
};

/* Scenario (c): pin to an already-exhausted account budget. */
const scenarioC = async (): Promise<void> => {
  console.log("=== (c) pinned call when drpc account budget is exhausted ===");
  await sleep(5500); // drpc DO bucket back to 10
  const batch6 = Array.from({ length: 6 }, (_, i) => ({ ...GET_SLOT, id: i + 1 }));
  const batch4 = batch6.slice(0, 4);

  await reset();
  // Drain drpc's 10-unit/5s DO bucket via two /24s (a single /24's share is only 6 units/min,
  // so one IP alone can never exhaust the account budget — by design).
  const c1 = await solanaRpc("62.1.1.1", "drpc", batch6);
  await c1.text();
  console.log(`C1 drain pinned batch6 (ip .1) -> ${String(c1.status)}`);
  const c2 = await solanaRpc("62.2.1.1", "drpc", batch4);
  await c2.text();
  console.log(`C2 drain pinned batch4 (ip .2) -> ${String(c2.status)}`);

  const c3 = await solanaRpc("62.3.1.1", "drpc");
  const c3Body = await c3.text();
  console.log(
    `C3 pinned single on exhausted drpc -> ${String(c3.status)} body=${c3Body.slice(0, 120)}`,
  );
  const c3b = await solanaRpc("62.4.1.1", "drpc");
  await c3b.text();
  console.log(`C3b second pinned single -> ${String(c3b.status)}`);
  const sC = await showStats("c after drain + probes");
  expect(
    c1.status === 200 && c2.status === 200,
    `c: drain failed ${String(c1.status)}/${String(c2.status)}`,
  );
  expect(
    c3.status === 503,
    `c3: pinned call on exhausted drpc got ${String(c3.status)}, expected 503`,
  );
  expect(
    (sC.upstream["alchemy"]?.calls ?? 0) === 0,
    "c: alchemy contacted while the pin pointed at exhausted drpc",
  );

  const c4 = await solanaRpc("62.3.1.1", undefined);
  await c4.text();
  console.log(
    `C4 unpinned single after drpc exhaustion -> ${String(c4.status)} ` +
      `x-gateway-providers=${c4.headers.get("x-gateway-providers") ?? "-"}`,
  );
  expect(c4.status === 200, `c4: unpinned call got ${String(c4.status)}`);
  expect(
    c4.headers.get("x-gateway-providers") === "alchemy",
    `c4: unpinned answered by ${c4.headers.get("x-gateway-providers") ?? "-"}`,
  );
};

/* Scenario (d): pinned TRON route. */
const scenarioD = async (): Promise<void> => {
  console.log("=== (d) pinned TRON getnowblock (tatum pin), one IP, SCALE=small ===");
  await freshShareWindow();
  const ip = "63.1.1.9";
  await reset();
  const pinned = await driveUntilRefused(async () =>
    tronCall(ip, "tatum", "/wallet/getnowblock", "{}"),
  );
  const s1 = await showStats("d1 after pinned tatum drive");
  console.log(
    `D1 pinned tatum: statuses=${statusCounts(pinned.statuses)} ` +
      `providers=[${[...new Set(pinned.providers)].join(",")}]`,
  );
  const pinned200 = pinned.statuses.filter((s) => s === 200).length;
  expect(pinned200 > 0 && pinned200 < 40, `d1: pinned tatum allowed ${String(pinned200)} calls`);
  expect(
    pinned.statuses.some((s) => s === 429 || s === 503),
    "d1: pinned TRON never refused",
  );
  expect(
    (s1.upstream["trongrid"]?.calls ?? 0) === 0,
    "d1: trongrid contacted during pinned tatum drive",
  );
  expect(
    (s1.upstream["tatum"]?.calls ?? 0) === pinned200,
    `d1: tatum calls ${String(s1.upstream["tatum"]?.calls ?? 0)} != pinned 200s ${String(pinned200)}`,
  );

  const unpinned = await driveUntilRefused(async () =>
    tronCall(ip, undefined, "/wallet/getnowblock", "{}"),
  );
  const s2 = await showStats("d2 after unpinned TRON drive");
  console.log(
    `D2 unpinned: statuses=${statusCounts(unpinned.statuses)} ` +
      `providers=[${[...new Set(unpinned.providers)].join(",")}]`,
  );
  const unpinned200 = unpinned.statuses.filter((s) => s === 200).length;
  expect(unpinned200 > 0 && unpinned200 < 40, `d2: unpinned TRON allowed ${String(unpinned200)}`);
  expect((s2.upstream["trongrid"]?.calls ?? 0) > 0, "d2: unpinned TRON never reached trongrid");
};

const probeEdge = async (label: string, init: () => Promise<Response>): Promise<void> => {
  const before = await stats();
  const res = await init();
  const body = await res.text();
  const delta = upstreamDelta(before, await stats());
  const deltaText = Object.entries(delta)
    .map(([k, v]) => `${k}:${String(v.calls)}`)
    .filter((entry) => !entry.endsWith(":0"))
    .join(" ");
  console.log(
    `E ${label} -> ${String(res.status)} providers=${res.headers.get("x-gateway-providers") ?? "-"} ` +
      `upstream_delta=[${deltaText}] body=${body.slice(0, 80)}`,
  );
};

/* Scenario (e): pin header edge cases. */
const scenarioE = async (): Promise<void> => {
  console.log("=== (e) x-gateway-provider header edge cases ===");
  await sleep(1000);

  await probeEdge(`pin "DRPC" (case)`, async () => solanaRpc("64.1.1.1", "DRPC"));
  await probeEdge(`pin " drpc" via fetch (client normalizes OWS)`, async () =>
    solanaRpc("64.1.1.2", " drpc"),
  );
  await probeEdge(`pin "drpc " trailing space via fetch`, async () =>
    solanaRpc("64.1.1.3", "drpc "),
  );
  await probeEdge(`pin "" empty`, async () => solanaRpc("64.1.1.4", ""));
  await probeEdge(`two pin headers (drpc + alchemy)`, async () => {
    const h = new Headers(headers("64.1.1.5"));
    h.append("x-gateway-provider", "drpc");
    h.append("x-gateway-provider", "alchemy");
    return fetch(`${BASE}/v1/rpc/${SOLANA}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(GET_SLOT),
    });
  });
  await probeEdge(`pin "drpc,alchemy" single header`, async () =>
    solanaRpc("64.1.1.6", "drpc,alchemy"),
  );

  // Literal leading whitespace, raw socket — bypasses fetch's header normalization.
  const raw = await rawRequest(["x-gateway-provider:  drpc\r\n"], JSON.stringify(GET_SLOT));
  console.log(`E raw literal "x-gateway-provider:  drpc" -> ${String(raw.status)}`);
  const raw2 = await rawRequest(
    ["x-gateway-provider: drpc\r\n", "x-gateway-provider: alchemy\r\n"],
    JSON.stringify(GET_SLOT),
  );
  console.log(`E raw two pin headers -> ${String(raw2.status)}`);

  // Bonus: pin on a TRON indexer path — the pin is only consulted on the node branch.
  await probeEdge(`pin "tatum" on indexer /v1/accounts/account`, async () =>
    tronCall(
      "64.1.1.7",
      "tatum",
      "/v1/accounts/account",
      JSON.stringify({ address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }),
    ),
  );
  await probeEdge(`pin "tatum" on node /wallet/getnowblock`, async () =>
    tronCall("64.1.1.8", "tatum", "/wallet/getnowblock", "{}"),
  );
};

/* Runner. */
const main = async (): Promise<void> => {
  const persistTo = `${process.env.TMPDIR ?? "/tmp"}/gateway-pin-metering-${String(Date.now())}`;
  const proc = Bun.spawn(
    [
      WRANGLER,
      "dev",
      "-c",
      "wrangler.json",
      "--port",
      String(PORT),
      "--persist-to",
      persistTo,
      "--var",
      "SCALE:small",
    ],
    { cwd: HERE, stdout: "inherit", stderr: "inherit" },
  );
  try {
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- readiness poll
        const res = await fetch(`${BASE}/__stats`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- consume body
        await res.text();
        if (res.ok) {
          break;
        }
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        throw new Error("workerd never became ready");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- poll interval
      await sleep(300);
    }
    console.log(`worker up on ${BASE} (SCALE=small, persist ${persistTo})`);
    const only = process.argv.at(2);
    const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (only === undefined || only === name) {
        await fn();
      }
    };
    await run("a", scenarioA);
    await run("b", scenarioB);
    await run("c", scenarioC);
    await run("d", scenarioD);
    await run("e", scenarioE);
  } finally {
    proc.kill();
    await proc.exited.catch(() => undefined);
  }
  if (failed.length > 0) {
    console.log(`${String(failed.length)} assertion(s) failed: ${failed.join("; ")}`);
    process.exit(1);
  }
  console.log("all assertions passed");
};

await main();
