/* oxlint-disable unicorn/no-process-exit -- a script: process exit is the result channel */
/**
 * Workerd budget harness driver: runs scenarios against `wrangler dev` servers hosting
 * tests/workerd/entry.ts — the real gateway (createGateway) over the real ProviderBudgetObject
 * Durable Object and real rate-limit bindings, with every upstream answered by an in-worker stub
 * (nothing leaves loopback, no Cloudflare login needed).
 *
 * Usage: bun tests/workerd/drive.ts <scenario> <url-a> [url-b]
 *
 * Scenarios: steady | s1 | s2 | s4 | s5 | s6 | s7 | storm. Output is plain text; redirect it to the
 * evidence directory. The process exits non-zero when a scenario assertion fails.
 *
 * | scenario | servers | SCALE      | what it does                                                                         |
 * | -------- | ------- | ---------- | ------------------------------------------------------------------------------------ |
 * | `steady` | A       | production | 20 eth_call/s for 20 s, rotating IPs; lease RPCs/s must amortise, not 1:1            |
 * | `s1`     | A       | production | 200 sequential + 200 concurrent eth_call, unique IPs; lease RPCs vs upstream calls   |
 * | `s2`     | A+B     | small      | 15 s concurrent drive on both isolates; upstream units vs `400 + 80×elapsed`         |
 * | `s4`     | B       | small      | A stopped ⇒ every DO call fails; requests fail closed, no upstream is contacted      |
 * | `s5`     | A       | production | TRON 1/s×70, prices eur/usd, Jupiter 1/5s×15, Esplora ×30 burst — one IP             |
 * | `s6`     | A       | production | IP keying on eth_chainId: mapped-v4 pair, missing-address pair, IPv6 same-/48 pair   |
 * | `s7`     | A       | production | 100 concurrent eth_call from 100 IPs; wall time + DO lease RPC count                 |
 * | `pin`    | A       | production | Solana getSlot with x-gateway-provider: answered by the pin only; unknown pin → 400  |
 * | `storm`  | A+B     | small      | 30 s concurrent drive on two isolates; DO RPCs vs refusals; fails on over-grant      |
 * | `cap`    | A+B     | cap        | eth_call on two alchemy-first networks until the tiny caps refuse; units ≤ cap, 503s |
 *
 * Vars: `SCALE` = `production` (default, PRODUCTION_ACCOUNTS) or `small` (alchemy `[{400,5s}]`, all
 * other accounts `[{10,5s}]` — exhaustion in seconds); `UPSTREAM_DELAY_MS` adds latency to the stub
 * upstream.
 */
declare const process: { argv: string[]; exit: (code: number) => never };

const CLIENT_ID = "0123456789abcdef0123456789abcdef";
const CLIENT_ID_B = "fedcba9876543210fedcba9876543210";

const headers = (ip: string | undefined, client = CLIENT_ID): Record<string, string> => ({
  "x-client-id": client,
  "content-type": "application/json",
  ...(ip === undefined ? {} : { "x-test-ip": ip }),
});

const ETH_CALL = {
  jsonrpc: "2.0",
  id: 1,
  method: "eth_call",
  params: [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }, "latest"],
};

type Stats = {
  leases: Record<string, { calls: number; granted: number; refused: number }>;
  upstream: Record<string, { calls: number; units: number }>;
};

const isStats = (value: unknown): value is Stats =>
  typeof value === "object" &&
  value !== null &&
  "leases" in value &&
  typeof value.leases === "object" &&
  "upstream" in value &&
  typeof value.upstream === "object";

const stats = async (base: string): Promise<Stats> => {
  const res = await fetch(`${base}/__stats`);
  const body: unknown = await res.json();
  return isStats(body) ? body : { leases: {}, upstream: {} };
};

const upstreamCalls = (s: Stats): number =>
  Object.values(s.upstream).reduce((sum, u) => sum + u.calls, 0);

const reset = async (base: string): Promise<void> => {
  await fetch(`${base}/__reset`, { method: "POST" });
};

/**
 * `push` — the real gateway + real PushObject end to end inside workerd: PUT a subscription, POST a
 * signed Alchemy Address Activity webhook for Sepolia (`eip155:11155111`, the network the harness
 * `ALCHEMY_WEBHOOKS` var configures), then poll `/__stats` until the in-worker stub saw the APNs
 * delivery and the dashboard address-sync PATCH. The APNs body must carry only the opaque `qntx`
 * envelope — no address, hash, network id or amount.
 */
const push = async (base: string): Promise<void> => {
  const SECRET_B64URL = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const KEY_B64URL = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const DEVICE_TOKEN = "ab".repeat(32);
  const ADDRESS = "0x1111111111111111111111111111111111111111";
  const HASH = `0x${"a".repeat(64)}`;
  const NETWORK = "eip155:11155111";
  const SIGNING_KEY = "harness-signing-key";

  const sub = await fetch(`${base}/v1/push/evm/subscription`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-client-id": CLIENT_ID,
      "x-test-ip": "203.0.113.60",
      authorization: `Bearer ${SECRET_B64URL}`,
    },
    body: JSON.stringify({
      platform: "apns",
      token: DEVICE_TOKEN,
      key: KEY_B64URL,
      networks: [NETWORK],
      addresses: [ADDRESS],
    }),
  });
  const subBody = await sub.text();
  expect(sub.status === 200, `push subscribe status ${String(sub.status)}: ${subBody}`);

  const webhookBody = JSON.stringify({
    webhookId: "wh_harness",
    id: "evt-harness-1",
    createdAt: "2025-01-01T00:00:00.000Z",
    type: "ADDRESS_ACTIVITY",
    event: {
      network: "ETH_SEPOLIA",
      activity: [
        {
          blockNum: "0x64",
          hash: HASH,
          fromAddress: "0x9999999999999999999999999999999999999999",
          toAddress: ADDRESS,
          value: 1.5,
          asset: "ETH",
          category: "external",
          rawContract: { rawValue: "0x14d1120d7b160000" },
        },
      ],
    },
  });
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(webhookBody));
  const signature = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const hook = await fetch(`${base}/hooks/alchemy`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-alchemy-signature": signature },
    body: webhookBody,
  });
  const hookBody = await hook.text();
  expect(hook.status === 200, `push webhook status ${String(hook.status)}: ${hookBody}`);

  // The DO alarm fires once the ingest schedules it; the APNs delivery and the dashboard sync
  // PATCH should both land within the bounded wait.
  let seen: SeenRequest[] = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- bounded poll for the alarm to fire
    const res = await fetch(`${base}/__stats`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- same bounded poll
    const parsed: unknown = await res.json();
    const list = recordOf(parsed)?.["seen"];
    seen = Array.isArray(list) ? list.filter(isSeenRequest) : [];
    if (
      seen.some((request) => request.host === "api.sandbox.push.apple.com") &&
      seen.some((request) => request.host === "dashboard.alchemy.com")
    ) {
      break;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- bounded poll interval
    await sleep(500);
  }

  const apns = seen.find(
    (request) =>
      request.host === "api.sandbox.push.apple.com" &&
      request.method === "POST" &&
      request.path === `/3/device/${DEVICE_TOKEN}`,
  );
  expect(apns !== undefined, `push: stub never saw the APNs delivery (seen ${seen.length})`);
  if (apns !== undefined) {
    const qntx = recordOf(recordOf(JSON.parse(apns.body))?.["qntx"]);
    expect(
      qntx?.["v"] === "1" && typeof qntx["e"] === "string" && typeof qntx["c"] === "string",
      `push: APNs body is not the opaque envelope: ${apns.body}`,
    );
    for (const leaked of [ADDRESS, HASH, NETWORK, "1500000000000000000", DEVICE_TOKEN]) {
      expect(!apns.body.includes(leaked), `push: APNs body leaked ${leaked}`);
    }
  }
  const patch = seen.find(
    (request) => request.host === "dashboard.alchemy.com" && request.method === "PATCH",
  );
  expect(patch !== undefined, "push: stub never saw the Alchemy address-sync PATCH");
  if (patch !== undefined) {
    const patchBody = recordOf(JSON.parse(patch.body));
    const adds = patchBody?.["addresses_to_add"];
    expect(
      patchBody?.["webhook_id"] === "wh_harness" && Array.isArray(adds) && adds.includes(ADDRESS),
      `push: PATCH body misses the subscribed address: ${patch.body}`,
    );
  }
  console.log(
    `PUSH: seen=${String(seen.length)} apns=${String(apns !== undefined)} patch=${String(patch !== undefined)}`,
  );
};

const ethCall = async (base: string, ip: string): Promise<Response> =>
  fetch(`${base}/v1/rpc/eip155:1`, {
    method: "POST",
    headers: headers(ip),
    body: JSON.stringify(ETH_CALL),
  });

const esplora = async (base: string, ip: string): Promise<Response> =>
  fetch(`${base}/v1/esplora/bip122:000000000019d6689c085ae165831e93/blocks/tip/height`, {
    headers: headers(ip),
  });

const tronBlock = async (base: string, ip: string, client = CLIENT_ID): Promise<Response> =>
  fetch(`${base}/v1/tron/tron:728126428/wallet/getnowblock`, {
    method: "POST",
    headers: headers(ip, client),
    body: "{}",
  });

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
};

type SeenRequest = { host: string; method: string; path: string; body: string };

const isSeenRequest = (value: unknown): value is SeenRequest => {
  const row = recordOf(value);
  return (
    row !== undefined &&
    typeof row["host"] === "string" &&
    typeof row["method"] === "string" &&
    typeof row["path"] === "string" &&
    typeof row["body"] === "string"
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

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
  return [...counts.entries()].map(([s, n]) => `${s}×${n}`).join(" ");
};

const countStatus = (statuses: ReadonlyArray<number>, status: number): number =>
  statuses.filter((s) => s === status).length;

const percentile = (sorted: ReadonlyArray<number>, p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

const report = (sorted: ReadonlyArray<number>): string =>
  `p50=${String(percentile(sorted, 50))}ms p95=${String(percentile(sorted, 95))}ms max=${String(sorted.at(-1) ?? 0)}ms`;

const showStats = async (base: string, label: string): Promise<Stats> => {
  const s = await stats(base);
  console.log(`--- stats ${label}: ${JSON.stringify(s)}`);
  return s;
};

/**
 * Drives `requestsPerSecond` eth_calls against `base` for `durationMs`, each from a fresh /24.
 * Returns the observed statuses.
 */
const paced = async (
  base: string,
  requestsPerSecond: number,
  durationMs: number,
): Promise<number[]> => {
  const statuses: number[] = [];
  const t0 = Date.now();
  const end = t0 + durationMs;
  for (let seq = 1; Date.now() < end; seq += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- paced request stream by design
    const res = await ethCall(
      base,
      `20.${(seq % 250) + 1}.${Math.floor(seq / 250) % 250}.${(seq % 200) + 1}`,
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    statuses.push(res.status);
    const wait = t0 + (seq * 1000) / requestsPerSecond - Date.now();
    if (wait > 0) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- pacing to the target rate
      await sleep(wait);
    }
  }
  return statuses;
};

/** Concurrent drivers pulling eth_call from `base` until the deadline, `worker`-keyed IPs. */
const driveUntil = async (base: string, worker: number, end: number): Promise<number[]> => {
  const statuses: number[] = [];
  for (let seq = 1; Date.now() < end; seq += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- rate-limited loop until deadline
    const res = await ethCall(base, `30.${worker}.${(seq % 250) + 1}.1`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    statuses.push(res.status);
  }
  return statuses;
};

const steady = async (base: string): Promise<void> => {
  await reset(base);
  const t0 = Date.now();
  const statuses = await paced(base, 20, 20_000);
  const elapsed = (Date.now() - t0) / 1000;
  const s = await showStats(base, "after steady");
  const leaseCalls = s.leases["alchemy"]?.calls ?? 0;
  const upstreamCalls = s.upstream["alchemy"]?.calls ?? 0;
  const upstreamUnits = s.upstream["alchemy"]?.units ?? 0;
  const perSecond = leaseCalls / elapsed;
  const perUpstream = leaseCalls / Math.max(1, upstreamCalls);
  console.log(
    `STEADY: requests=${String(statuses.length)} statuses=${statusCounts(statuses)} ` +
      `elapsed=${elapsed.toFixed(1)}s\n` +
      `  upstream alchemy calls=${String(upstreamCalls)} units=${String(upstreamUnits)}\n` +
      `  DO lease RPCs=${String(leaseCalls)} granted=${String(s.leases["alchemy"]?.granted ?? 0)} ` +
      `refused=${String(s.leases["alchemy"]?.refused ?? 0)}\n` +
      `  lease-RPCs/s=${perSecond.toFixed(2)} lease-RPCs/upstream-call=${perUpstream.toFixed(3)}`,
  );
  // The converged ask is ceil(1.25 × 260 units/s × 2 s) = 650 units ≈ 25 calls, so 20 calls/s
  // amortises to ≤1 DO RPC/s even through the two-second rate ramp and pacing jitter.
  expect(perSecond <= 1, `steady: ${perSecond.toFixed(2)} lease-RPCs/s exceeds amortised bound`);
  expect(perUpstream <= 0.1, `steady: ${perUpstream.toFixed(3)} lease-RPCs/call — no amortisation`);
  expect(countStatus(statuses, 200) === statuses.length, "steady: non-200 statuses");
};

const s1 = async (base: string): Promise<void> => {
  await reset(base);
  let seqLatencies: number[] = [];
  const seqStatuses: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    const t = Date.now();
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
    const res = await ethCall(base, `10.${(i % 240) + 1}.0.1`);
    seqLatencies.push(Date.now() - t);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    seqStatuses.push(res.status);
  }
  const seqWall = Date.now() - t0;
  seqLatencies = seqLatencies.toSorted((a, b) => a - b);
  const sSeq = await showStats(base, "after 200 sequential");
  console.log(
    `S1 sequential: statuses=${statusCounts(seqStatuses)} wall=${String(seqWall)}ms ` +
      `latency ${report(seqLatencies)}\n` +
      `  upstream alchemy calls=${String(sSeq.upstream["alchemy"]?.calls ?? 0)} ` +
      `units=${String(sSeq.upstream["alchemy"]?.units ?? 0)}\n` +
      `  DO lease RPCs alchemy=${String(sSeq.leases["alchemy"]?.calls ?? 0)} ` +
      `granted=${String(sSeq.leases["alchemy"]?.granted ?? 0)} ` +
      `refused=${String(sSeq.leases["alchemy"]?.refused ?? 0)}\n` +
      `  lease-RPCs / upstream-call = ${((sSeq.leases["alchemy"]?.calls ?? 0) / (sSeq.upstream["alchemy"]?.calls ?? 1)).toFixed(3)}`,
  );
  expect(countStatus(seqStatuses, 200) === 200, "s1 sequential: non-200 statuses");

  await reset(base);
  let concLatencies: number[] = [];
  const concStatuses: number[] = [];
  const t1 = Date.now();
  for (let batch = 0; batch < 4; batch++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- batches are sequential, requests inside concurrent
    const responses = await Promise.all(
      Array.from({ length: 50 }, async (_, j) => {
        const t = Date.now();
        const res = await ethCall(base, `10.${batch}.${j + 1}.1`);
        const ms = Date.now() - t;
        await res.text();
        return { status: res.status, ms };
      }),
    );
    for (const { status, ms } of responses) {
      concStatuses.push(status);
      concLatencies.push(ms);
    }
  }
  const concWall = Date.now() - t1;
  concLatencies = concLatencies.toSorted((a, b) => a - b);
  const sConc = await showStats(base, "after 200 concurrent (4×50)");
  console.log(
    `S1 concurrent: statuses=${statusCounts(concStatuses)} wall=${String(concWall)}ms ` +
      `latency ${report(concLatencies)}\n` +
      `  upstream alchemy calls=${String(sConc.upstream["alchemy"]?.calls ?? 0)} ` +
      `units=${String(sConc.upstream["alchemy"]?.units ?? 0)}\n` +
      `  DO lease RPCs alchemy=${String(sConc.leases["alchemy"]?.calls ?? 0)} ` +
      `granted=${String(sConc.leases["alchemy"]?.granted ?? 0)} ` +
      `refused=${String(sConc.leases["alchemy"]?.refused ?? 0)}\n` +
      `  lease-RPCs / upstream-call = ${((sConc.leases["alchemy"]?.calls ?? 0) / (sConc.upstream["alchemy"]?.calls ?? 1)).toFixed(3)}`,
  );
  expect(countStatus(concStatuses, 200) === 200, "s1 concurrent: non-200 statuses");
};

const s2 = async (a: string, b: string): Promise<void> => {
  await Promise.all([reset(a), reset(b)]);
  const DURATION_MS = 15_000;
  const WORKERS_PER_ISOLATE = 4;
  const end = Date.now() + DURATION_MS;
  const t0 = Date.now();
  const results = await Promise.all(
    [a, b].flatMap((base, i) =>
      Array.from({ length: WORKERS_PER_ISOLATE }, async (_, w) =>
        driveUntil(base, i * 10 + w, end),
      ),
    ),
  );
  const elapsed = (Date.now() - t0) / 1000;
  const [sa, sb] = await Promise.all([showStats(a, "A"), showStats(b, "B")]);
  const upstreamUnits = (sa.upstream["alchemy"]?.units ?? 0) + (sb.upstream["alchemy"]?.units ?? 0);
  const upstreamCalls = (sa.upstream["alchemy"]?.calls ?? 0) + (sb.upstream["alchemy"]?.calls ?? 0);
  const leaseCalls = (sa.leases["alchemy"]?.calls ?? 0) + (sb.leases["alchemy"]?.calls ?? 0);
  const granted = (sa.leases["alchemy"]?.granted ?? 0) + (sb.leases["alchemy"]?.granted ?? 0);
  const refused = (sa.leases["alchemy"]?.refused ?? 0) + (sb.leases["alchemy"]?.refused ?? 0);
  // Small-scale bucket: alchemy [{units:400, seconds:5}] → cap 400, refill 80/s.
  const theoreticalMax = 400 + 80 * elapsed;
  const statuses = results.flat();
  console.log(
    `S2: elapsed=${elapsed.toFixed(2)}s statuses=${statusCounts(statuses)}\n` +
      `  upstream alchemy: calls=${String(upstreamCalls)} units(CU)=${String(upstreamUnits)}\n` +
      `  DO lease RPCs=${String(leaseCalls)} units granted=${String(granted)} refused=${String(refused)}\n` +
      `  theoretical max = 400 + 80×${elapsed.toFixed(2)} = ${theoreticalMax.toFixed(0)} CU\n` +
      `  over-grant (upstream CU > max) = ${String(upstreamUnits > theoreticalMax)}`,
  );
  expect(
    upstreamUnits <= theoreticalMax,
    `s2 over-grant: ${String(upstreamUnits)} CU upstream > ${theoreticalMax.toFixed(0)}`,
  );
};

const s4 = async (b: string): Promise<void> => {
  await reset(b);
  const statuses: number[] = [];
  for (let i = 0; i < 20; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
    const res = await ethCall(b, `15.${i + 1}.0.1`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    statuses.push(res.status);
  }
  const tStatuses: number[] = [];
  const bodies: string[] = [];
  for (let i = 0; i < 10; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
    const res = await tronBlock(b, `15.50.${i + 1}.1`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    const body = await res.text();
    if (bodies.length < 3) {
      bodies.push(`${String(res.status)}:${body.slice(0, 60)}`);
    }
    tStatuses.push(res.status);
  }
  const s = await showStats(b, "B with A stopped");
  const upstreamCalls =
    (s.upstream["alchemy"]?.calls ?? 0) +
    (s.upstream["trongrid"]?.calls ?? 0) +
    (s.upstream["tatum"]?.calls ?? 0);
  console.log(
    `S4: eth_call statuses=${statusCounts(statuses)} tron statuses=${statusCounts(tStatuses)} ` +
      `[${bodies.join(" | ")}]\n` +
      `  B upstream: alchemy calls=${String(s.upstream["alchemy"]?.calls ?? 0)} ` +
      `trongrid=${String(s.upstream["trongrid"]?.calls ?? 0)} tatum=${String(s.upstream["tatum"]?.calls ?? 0)}\n` +
      `  B leases: ${JSON.stringify(s.leases)}`,
  );
  // With the objects' owner stopped, every take fails closed: 503 and no upstream is contacted.
  // `budget-error` lines appear once per failed call in B's wrangler log.
  expect(
    statuses.every((status) => status === 503),
    "s4: eth_call not all 503",
  );
  expect(
    tStatuses.every((status) => status === 503),
    "s4: tron not all 503",
  );
  expect(upstreamCalls === 0, "s4: upstream contacted while the object was down");
};

const s5 = async (base: string): Promise<void> => {
  const ip = "198.51.101.7";
  const statuses: number[] = [];
  const okAt: number[] = [];
  const retryAfters: string[] = [];
  const t0 = Date.now();
  for (let i = 0; i < 70; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one request per second
    const res = await tronBlock(base, ip);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    statuses.push(res.status);
    if (res.status === 200) {
      okAt.push(i);
    }
    const ra = res.headers.get("retry-after");
    if (ra !== null) {
      retryAfters.push(ra);
    }
    const wait = t0 + (i + 1) * 1000 - Date.now();
    if (wait > 0) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- pacing to one request per second
      await sleep(wait);
    }
  }
  console.log(
    `S5a TRON 1/s×70 from ${ip}: statuses=${statusCounts(statuses)} ` +
      `retry-afters=[${[...new Set(retryAfters)].join(",")}] 200s at indices=[${okAt.join(",")}]`,
  );
  // One /24 may spend TronGrid's per-minute share (29 calls), then fails over to Tatum's share
  // (14 calls): at least 29 successful calls before the shared-prefix limiter refuses.
  expect(
    statuses.slice(0, 29).every((status) => status === 200),
    "s5a: first 29 TRON calls not all 200",
  );
  expect(countStatus(statuses, 200) >= 29, "s5a: fewer than 29 successful TRON calls");

  for (const currency of ["eur", "usd"]) {
    for (const [family, assets] of [
      ["evm", ["eip155:56/slip44:714"]],
      ["bitcoin", ["bip122:000000000019d6689c085ae165831e93/slip44:0"]],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- requests in order
      const res = await fetch(`${base}/v1/prices/${family}`, {
        method: "POST",
        headers: headers(ip),
        body: JSON.stringify({ currency, assets }),
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      const body = await res.text();
      console.log(
        `S5b prices ${currency}/${family}: status=${String(res.status)} x-gateway-providers=${res.headers.get("x-gateway-providers") ?? "-"} body=${body.slice(0, 400)}`,
      );
      expect(res.status === 200, `s5b: prices ${currency}/${family} status ${String(res.status)}`);
    }
  }

  const jStatuses: number[] = [];
  const jOkAt: number[] = [];
  const t1 = Date.now();
  for (let i = 0; i < 15; i++) {
    const query = new URLSearchParams({
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      taker: "11111111111111111111111111111111",
      slippageBps: "50",
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- one request per 5 seconds
    const res = await fetch(`${base}/v1/quotes/swap/solana?${query.toString()}`, {
      headers: headers(ip),
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    jStatuses.push(res.status);
    if (res.status === 200) {
      jOkAt.push(i);
    }
    const wait = t1 + (i + 1) * 5000 - Date.now();
    if (wait > 0) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- pacing to one request per 5 seconds
      await sleep(wait);
    }
  }
  console.log(
    `S5c Jupiter 1/5s×15 from ${ip}: statuses=${statusCounts(jStatuses)} 200s at indices=[${jOkAt.join(",")}]`,
  );
  // Three calls/minute/prefix fits Jupiter's twelve-call share — every call succeeds.
  expect(
    jStatuses.every((status) => status === 200),
    "s5c: non-200 Jupiter statuses",
  );

  const eStatuses: number[] = [];
  for (let i = 0; i < 30; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- burst of 30
    const res = await esplora(base, ip);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    eStatuses.push(res.status);
  }
  console.log(`S5d Esplora ×30 burst from ${ip}: statuses=${statusCounts(eStatuses)}`);
  // Blockstream's per-prefix share pays fourteen one-unit calls.
  expect(
    eStatuses.slice(0, 14).every((status) => status === 200),
    "s5d: first 14 Esplora calls not all 200",
  );
};

/** Miniflare aligns limiter windows to the wall clock — wait until just past a 10 s rollover. */
const freshWindow = async (): Promise<void> => {
  await sleep(10_000 - (Date.now() % 10_000) + 50);
};

const s6 = async (base: string): Promise<void> => {
  /* One JSON-RPC batch charges every keyed limiter `batch.length` units (the middleware's one
     plus `charge(length - 1)`; the contract caps a batch at RPC_BATCH_MAX = 20), so a few
     20-call posts drive a key to its limit inside one limiter window. Miniflare aligns limiter
     windows to the wall clock, so each phase waits for a fresh 10 s epoch first — a boundary
     mid-phase would reset the counters and the flood would never refuse. The /v1/rpc route
     keeps the provider budget (alchemy 480k CU/min) far above the flood-limiter numbers, so
     refusals always come from a keyed limiter, never the upstream budget. Rotating the client
     id leaves only the IP-limiter keys to fill: the /48 pair shares its IP-limiter bucket, not
     a client-scoped one. */
  const rpcIp = async (ip: string, client: string, size: number): Promise<number> => {
    const body = Array.from({ length: size }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "eth_chainId",
      params: [],
    }));
    const res = await fetch(`${base}/v1/rpc/eip155:1`, {
      method: "POST",
      headers: headers(ip, client),
      body: JSON.stringify(size === 1 ? body[0] : body),
    });
    await res.text();
    return res.status;
  };
  const flood = async (ip: string, posts: number, rotate: boolean): Promise<number[]> => {
    const statuses: number[] = [];
    for (let i = 0; i < posts; i++) {
      const client = rotate ? (i + 1).toString(16).padStart(32, "0") : CLIENT_ID;
      // oxlint-disable-next-line eslint/no-await-in-loop -- count to the refusal
      statuses.push(await rpcIp(ip, client, 20));
    }
    return statuses;
  };

  await freshWindow();
  const a1 = await flood("::ffff:198.51.100.1", 6, false);
  const a2 = await rpcIp("::ffff:203.0.113.9", CLIENT_ID, 1);
  console.log(
    `S6a mapped-v4: first ::ffff:198.51.100.1 → ${statusCounts(a1)}; second ::ffff:203.0.113.9 → ${String(a2)}`,
  );
  // Mapped forms key the embedded IPv4's /24: the first address exhausts it, a different /24 is free.
  expect(a1.at(-1) === 429, "s6a: first mapped address never refused");
  expect(a2 === 200, `s6a: second mapped address got ${String(a2)}`);

  const b1 = await rpcIp("none", CLIENT_ID, 1);
  const b2 = await rpcIp("none", CLIENT_ID_B, 1);
  console.log(
    `S6b no-ip: client A → ${String(b1)}; client B (different client id) → ${String(b2)}`,
  );
  // The gateway requires a parseable client address — a missing one is a 400, not a shared bucket.
  expect(b1 === 400, "s6b: missing address not rejected with 400");
  expect(b2 === 400, `s6b: second client's missing address got ${String(b2)}`);

  await freshWindow();
  const c1 = await flood("2001:db8:1:1::1", 16, true);
  const c2 = await rpcIp("2001:db8:1:2::1", CLIENT_ID, 1);
  console.log(
    `S6c same-/48: first 2001:db8:1:1::1 → ${statusCounts(c1)}; second 2001:db8:1:2::1 → ${String(c2)}`,
  );
  // Distinct /64s inside one /48 share the /48 IP-limiter key — the neighbour is refused too.
  expect(c1.at(-1) === 429, "s6c: first /64 never refused");
  expect(c2 === 429, `s6c: same-/48 neighbour got ${String(c2)}`);
};

const s7 = async (base: string): Promise<void> => {
  await reset(base);
  const t0 = Date.now();
  const responses = await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const t = Date.now();
      const res = await ethCall(base, `13.${i + 1}.0.1`);
      const ms = Date.now() - t;
      await res.text();
      return { status: res.status, ms };
    }),
  );
  const wall = Date.now() - t0;
  const latencies = responses.map((r) => r.ms).toSorted((a, b) => a - b);
  const s = await showStats(base, "after 100-burst");
  console.log(
    `S7: statuses=${statusCounts(responses.map((r) => r.status))} wall=${String(wall)}ms ` +
      `latency ${report(latencies)}\n` +
      `  DO lease RPCs alchemy=${String(s.leases["alchemy"]?.calls ?? 0)} ` +
      `granted=${String(s.leases["alchemy"]?.granted ?? 0)} ` +
      `refused=${String(s.leases["alchemy"]?.refused ?? 0)}`,
  );
  expect(
    responses.every((r) => r.status === 200),
    "s7: non-200 statuses in the 100-burst",
  );
};

/**
 * The `x-gateway-provider` pin on the JSON-RPC route: a pinned Solana call is served by the named
 * provider alone — the walk never touches the leading one — and a pin naming no provider is a 400
 * before any upstream call.
 */
const pin = async (base: string): Promise<void> => {
  await reset(base);
  const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const ip = "198.51.100.23";
  const getSlot = { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] };
  const solanaRpc = async (pinHeader: string | undefined): Promise<Response> =>
    fetch(`${base}/v1/rpc/${SOLANA}`, {
      method: "POST",
      headers: {
        ...headers(ip),
        ...(pinHeader === undefined ? {} : { "x-gateway-provider": pinHeader }),
      },
      body: JSON.stringify(getSlot),
    });

  // Solana's providers are alchemy then drpc: a drpc pin must skip alchemy entirely.
  const pinned = await solanaRpc("drpc");
  await pinned.text();
  const answeredBy = pinned.headers.get("x-gateway-providers");
  console.log(
    `PIN: getSlot x-gateway-provider=drpc → ${String(pinned.status)} ` +
      `x-gateway-providers=${answeredBy ?? "-"}`,
  );
  expect(pinned.status === 200, `pin: pinned getSlot got ${String(pinned.status)}`);
  expect(answeredBy === "drpc", `pin: answered by ${answeredBy ?? "-"}, not drpc`);

  const pinnedStats = await showStats(base, "after the pinned call");
  expect(pinnedStats.upstream["drpc"]?.calls === 1, "pin: drpc not called exactly once");
  expect(
    (pinnedStats.upstream["alchemy"]?.calls ?? 0) === 0,
    "pin: alchemy contacted despite the drpc pin",
  );

  const unpinned = await solanaRpc(undefined);
  await unpinned.text();
  console.log(
    `PIN: unpinned getSlot → ${String(unpinned.status)} ` +
      `x-gateway-providers=${unpinned.headers.get("x-gateway-providers") ?? "-"}`,
  );
  expect(
    unpinned.headers.get("x-gateway-providers") === "alchemy",
    "pin: unpinned getSlot not answered by the leading provider",
  );

  const unknown = await solanaRpc("nobody");
  await unknown.text();
  console.log(`PIN: unknown pin → ${String(unknown.status)}`);
  expect(unknown.status === 400, `pin: unknown pin got ${String(unknown.status)}`);

  // A pin on a TRON indexer path selects nothing — the indexer provider set is fixed — so it is
  // refused 400 before any upstream call.
  const beforeIndexer = upstreamCalls(await stats(base));
  const indexerPinned = await fetch(`${base}/v1/tron/tron:728126428/v1/accounts/account`, {
    method: "POST",
    headers: { ...headers(ip), "x-gateway-provider": "tatum" },
    body: JSON.stringify({ address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }),
  });
  await indexerPinned.text();
  const indexerDelta = upstreamCalls(await stats(base)) - beforeIndexer;
  console.log(`PIN: tatum pin on indexer /v1/accounts/account → ${String(indexerPinned.status)}`);
  expect(indexerPinned.status === 400, `pin: indexer pin got ${String(indexerPinned.status)}`);
  expect(indexerDelta === 0, `pin: indexer pin reached upstream ${String(indexerDelta)} times`);
};

const storm = async (a: string, b: string): Promise<void> => {
  await Promise.all([reset(a), reset(b)]);
  const DURATION_MS = 30_000;
  const WORKERS_PER_ISOLATE = 4;
  const t0 = Date.now();
  const end = t0 + DURATION_MS;
  const results = await Promise.all(
    [a, b].flatMap((base, i) =>
      Array.from({ length: WORKERS_PER_ISOLATE }, async (_, w) =>
        driveUntil(base, i * 10 + w, end),
      ),
    ),
  );
  const elapsed = (Date.now() - t0) / 1000;
  const [sa, sb] = await Promise.all([showStats(a, "A"), showStats(b, "B")]);
  const upstreamUnits = (sa.upstream["alchemy"]?.units ?? 0) + (sb.upstream["alchemy"]?.units ?? 0);
  const upstreamCalls = (sa.upstream["alchemy"]?.calls ?? 0) + (sb.upstream["alchemy"]?.calls ?? 0);
  const leaseCalls = (sa.leases["alchemy"]?.calls ?? 0) + (sb.leases["alchemy"]?.calls ?? 0);
  const granted = (sa.leases["alchemy"]?.granted ?? 0) + (sb.leases["alchemy"]?.granted ?? 0);
  const refused = (sa.leases["alchemy"]?.refused ?? 0) + (sb.leases["alchemy"]?.refused ?? 0);
  // Small-scale bucket: alchemy [{units:400, seconds:5}] → cap 400, refill 80/s, drained by the
  // opening burst and refilled continuously through the storm.
  const bound = 400 + 80 * elapsed;
  const statuses = results.flat();
  console.log(
    `STORM: elapsed=${elapsed.toFixed(2)}s statuses=${statusCounts(statuses)}\n` +
      `  upstream alchemy: calls=${String(upstreamCalls)} units(CU)=${String(upstreamUnits)}\n` +
      `  DO lease RPCs=${String(leaseCalls)} units granted=${String(granted)} refused=${String(refused)}\n` +
      `  bound = 400 + 80×${elapsed.toFixed(2)} = ${bound.toFixed(0)} CU\n` +
      `  over-grant (upstream CU > bound) = ${String(upstreamUnits > bound)}`,
  );
  expect(
    upstreamUnits <= bound,
    `storm over-grant: ${String(upstreamUnits)} CU upstream > ${bound.toFixed(0)}`,
  );
};

/**
 * `cap` — SCALE=cap: production rates and costs but tiny spend caps (alchemy day 2,600 CU = 100
 * eth_calls, every other account 10 units/day). Concurrent eth_call on eip155:1 and eip155:10 (both
 * alchemy-first) from rotating /24s on both isolates until refusals appear, then twenty more.
 * Asserts the summed upstream units per account never exceed its day cap, every refusal is a 503
 * `unavailable` with an hours-scale Retry-After, and post-cap requests produce no upstream call at
 * all.
 */
const capScenario = async (a: string, b: string): Promise<void> => {
  await Promise.all([reset(a), reset(b)]);
  const DAY_CAPS: Readonly<Record<string, number>> = { alchemy: 2600 };
  const OTHER_DAY_CAP = 10;
  const networks = ["eip155:1", "eip155:10"];
  type Row = { status: number; retryAfter: number | undefined; body: string };
  const rows: Row[] = [];
  let sawRefusal = false;

  const call = async (base: string, network: string, ip: string): Promise<void> => {
    const res = await fetch(`${base}/v1/rpc/${network}`, {
      method: "POST",
      headers: headers(ip),
      body: JSON.stringify(ETH_CALL),
    });
    const body = await res.text();
    const retry = res.headers.get("retry-after");
    rows.push({
      status: res.status,
      retryAfter: retry === null ? undefined : Number(retry),
      body,
    });
    if (res.status === 503) {
      sawRefusal = true;
    }
  };

  const workers = [a, b].flatMap((base, isolate) =>
    Array.from({ length: 3 }, async (_, w) => {
      const seed = isolate * 10 + w + 1;
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `call` flips it on a refusal
      for (let seq = 1; !sawRefusal && seq <= 2000; seq += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- drive until the first refusal
        await call(base, networks[seq % 2] ?? "eip155:1", `40.${seed}.${(seq % 250) + 1}.1`);
      }
    }),
  );
  await Promise.all(workers);
  console.log(
    `CAP: drive ended after ${String(rows.length)} requests, statuses=${statusCounts(rows.map((r) => r.status))}`,
  );
  expect(sawRefusal, "cap: no refusal ever appeared");

  // Let every live lease die, then twenty more requests across both isolates.
  await sleep(2500);
  const before = await Promise.all([stats(a), stats(b)]);
  const callsBefore = before.map(upstreamCalls);
  for (let i = 0; i < 20; i += 1) {
    const base = i % 2 === 0 ? a : b;
    // oxlint-disable-next-line eslint/no-await-in-loop -- twenty sequential post-cap requests
    await call(base, networks[i % 2] ?? "eip155:1", `41.${i + 1}.0.1`);
  }
  const after = await Promise.all([stats(a), stats(b)]);

  // Per-account upstream units summed over both isolates never exceed the day cap.
  const accounts = new Set([
    ...Object.keys(after[0]?.upstream ?? {}),
    ...Object.keys(after[1]?.upstream ?? {}),
  ]);
  for (const account of accounts) {
    const units =
      (after[0]?.upstream[account]?.units ?? 0) + (after[1]?.upstream[account]?.units ?? 0);
    const dayCap = DAY_CAPS[account] ?? OTHER_DAY_CAP;
    console.log(`CAP: upstream ${account} units=${String(units)} day-cap=${String(dayCap)}`);
    expect(
      units <= dayCap,
      `cap: ${account} upstream units ${String(units)} exceed day cap ${String(dayCap)}`,
    );
  }

  // Every non-200 is a 503 {"error":"unavailable"} with an hours-scale numeric retry-after.
  const refused = rows.filter((row) => row.status !== 200);
  expect(refused.length > 0, "cap: no refused requests recorded");
  for (const row of refused) {
    expect(row.status === 503, `cap: refusal status ${String(row.status)} is not 503`);
    expect(row.body === JSON.stringify({ error: "unavailable" }), `cap: refusal body ${row.body}`);
    expect(
      row.retryAfter !== undefined && row.retryAfter >= 600,
      `cap: retry-after ${String(row.retryAfter)} is not hours-scale`,
    );
  }

  // Post-cap requests add zero upstream calls on either isolate.
  const callsAfter = after.map(upstreamCalls);
  console.log(
    `CAP: upstream calls before extra=${String(callsBefore[0] ?? 0)},${String(callsBefore[1] ?? 0)} after=${String(callsAfter[0] ?? 0)},${String(callsAfter[1] ?? 0)}`,
  );
  expect(
    callsAfter[0] === callsBefore[0] && callsAfter[1] === callsBefore[1],
    "cap: post-cap requests reached an upstream",
  );

  // The refusals come from the object itself, not only isolate caches.
  const leaseRefusals =
    (after[0]?.leases["alchemy"]?.refused ?? 0) + (after[1]?.leases["alchemy"]?.refused ?? 0);
  expect(leaseRefusals > 0, "cap: the budget object never refused a lease");
};

const main = async (): Promise<void> => {
  const [scenario, a, b] = process.argv.slice(2);
  const needsB = scenario === "s2" || scenario === "storm" || scenario === "cap";
  if (scenario === undefined || a === undefined || (needsB && b === undefined)) {
    console.log(
      "usage: bun drive.ts <steady|s1|s2|s4|s5|s6|s7|pin|storm|cap> <url-a> [url-b]  (s2/storm/cap need both; s4 drives the url given)",
    );
    process.exit(2);
  }
  console.log(`scenario=${scenario} A=${a} B=${b ?? "-"} at ${new Date().toISOString()}`);
  switch (scenario) {
    case "steady":
      await steady(a);
      break;
    case "s1":
      await s1(a);
      break;
    case "s2":
      await s2(a, b ?? a);
      break;
    case "s4":
      await s4(a);
      break;
    case "s5":
      await s5(a);
      break;
    case "s6":
      await s6(a);
      break;
    case "s7":
      await s7(a);
      break;
    case "pin":
      await pin(a);
      break;
    case "push":
      await push(a);
      break;
    case "storm":
      await storm(a, b ?? a);
      break;
    case "cap":
      await capScenario(a, b ?? a);
      break;
    default:
      console.log(`unknown scenario ${scenario}`);
      process.exit(2);
  }
  if (failed.length > 0) {
    console.log(`${String(failed.length)} assertion(s) failed: ${failed.join("; ")}`);
    process.exit(1);
  }
  console.log("all assertions passed");
};

await main();
