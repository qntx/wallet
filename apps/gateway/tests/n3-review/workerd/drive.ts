/**
 * N3 review driver: runs the budget-path scenarios against `wrangler dev` servers hosting
 * tests/n3-review/workerd/entry.ts. Usage:
 *
 * Bun tests/n3-review/workerd/drive.ts <scenario> <url-a> [url-b]
 *
 * Scenarios: s1 | s2 | s3 | s3probe | s4 | s5 | s6 | s7. Output is plain text; redirect it to the
 * evidence directory.
 */
declare const process: { argv: string[] };

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

const reset = async (base: string): Promise<void> => {
  await fetch(`${base}/__reset`, { method: "POST" });
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

const statusCounts = (statuses: ReadonlyArray<number>): string => {
  const counts = new Map<number, number>();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([s, n]) => `${s}×${n}`).join(" ");
};

const percentile = (sorted: ReadonlyArray<number>, p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

const report = (sorted: ReadonlyArray<number>): string =>
  `p50=${String(percentile(sorted, 50))}ms p95=${String(percentile(sorted, 95))}ms max=${String(sorted.at(-1) ?? 0)}ms`;

const showStats = async (base: string, label: string): Promise<Stats> => {
  const s = await stats(base);
  console.log(`--- stats ${label}: ${JSON.stringify(s)}`);
  return s;
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
};

const s2 = async (a: string, b: string): Promise<void> => {
  await Promise.all([reset(a), reset(b)]);
  const DURATION_MS = 15_000;
  const WORKERS_PER_ISOLATE = 4;
  const end = Date.now() + DURATION_MS;
  const t0 = Date.now();
  const drive = async (base: string, worker: number): Promise<number[]> => {
    const statuses: number[] = [];
    let seq = 0;
    while (Date.now() < end) {
      seq += 1;
      // oxlint-disable-next-line eslint/no-await-in-loop -- rate-limited loop until deadline
      const res = await ethCall(base, `12.${worker}.${(seq % 250) + 1}.1`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      statuses.push(res.status);
    }
    return statuses;
  };
  const results = await Promise.all(
    [a, b].flatMap((base, i) =>
      Array.from({ length: WORKERS_PER_ISOLATE }, async (_, w) => drive(base, i * 10 + w)),
    ),
  );
  const elapsed = (Date.now() - t0) / 1000;
  const [sa, sb] = await Promise.all([showStats(a, "A"), showStats(b, "B")]);
  const upstreamUnits = (sa.upstream["alchemy"]?.units ?? 0) + (sb.upstream["alchemy"]?.units ?? 0);
  const upstreamCalls = (sa.upstream["alchemy"]?.calls ?? 0) + (sb.upstream["alchemy"]?.calls ?? 0);
  const leaseCalls = (sa.leases["alchemy"]?.calls ?? 0) + (sb.leases["alchemy"]?.calls ?? 0);
  const granted = (sa.leases["alchemy"]?.granted ?? 0) + (sb.leases["alchemy"]?.granted ?? 0);
  // Small-scale bucket: alchemy [{units:400, seconds:5}] → cap 400, refill 80/s.
  const theoreticalMax = 400 + 80 * elapsed;
  const statuses = results.flat();
  console.log(
    `S2: elapsed=${elapsed.toFixed(2)}s statuses=${statusCounts(statuses)}\n` +
      `  upstream alchemy: calls=${String(upstreamCalls)} units(CU)=${String(upstreamUnits)}\n` +
      `  DO lease RPCs=${String(leaseCalls)} units granted=${String(granted)} ` +
      `refused=${String((sa.leases["alchemy"]?.refused ?? 0) + (sb.leases["alchemy"]?.refused ?? 0))}\n` +
      `  theoretical max = 400 + 80×${elapsed.toFixed(2)} = ${theoreticalMax.toFixed(0)} CU\n` +
      `  over-grant (upstream CU > max) = ${String(upstreamUnits > theoreticalMax)}`,
  );
};

const s3 = async (base: string): Promise<void> => {
  await reset(base);
  const statuses: number[] = [];
  for (let i = 0; i < 100; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
    const res = await ethCall(base, `14.${i + 1}.0.1`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    const body = await res.text();
    statuses.push(res.status);
    console.log(
      `req ${String(i + 1)}: ${String(res.status)} retry-after=${res.headers.get("retry-after") ?? "-"} body=${body.slice(0, 80)}`,
    );
    if (res.status !== 200) {
      break;
    }
  }
  await showStats(base, "at exhaustion");
  console.log(`S3 exhaust: statuses=${statusCounts(statuses)}`);
};

/**
 * Drains the s3slow blockstream bucket via Esplora (single provider → clean 503 on refusal). Each
 * request uses a fresh /24: the share delta is exactly 1000, i.e. one request per IP.
 */
const s3t = async (base: string): Promise<void> => {
  await reset(base);
  const t0 = Date.now();
  const statuses: number[] = [];
  for (let i = 0; i < 1400; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
    const res = await esplora(base, `15.${Math.floor(i / 256)}.${i % 256}.1`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    const body = await res.text();
    statuses.push(res.status);
    if (res.status !== 200 || i % 200 === 0) {
      console.log(
        `req ${String(i + 1)}: ${String(res.status)} retry-after=${res.headers.get("retry-after") ?? "-"} body=${body.slice(0, 80)}`,
      );
    }
    if (res.status !== 200) {
      break;
    }
  }
  const s = await showStats(base, "at exhaustion");
  console.log(
    `S3t exhaust: wall=${String(Date.now() - t0)}ms statuses=${statusCounts(statuses)} leases=${JSON.stringify(s.leases)}`,
  );
};

const s3probe = async (base: string): Promise<void> => {
  const statuses: number[] = [];
  let first = "";
  const target = process.argv.includes("esplora")
    ? "esplora"
    : process.argv.includes("tron")
      ? "tron"
      : "";
  for (let i = 0; i < 40; i++) {
    const res =
      target === "esplora"
        ? // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
          await esplora(base, `15.${200 + Math.floor(i / 256)}.${i % 256}.1`)
        : target === "tron"
          ? // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
            await tronBlock(base, `14.${240 + i}.0.1`)
          : // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
            await ethCall(base, `14.${240 + i}.0.1`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    const body = await res.text();
    statuses.push(res.status);
    if (first === "") {
      first = `${String(res.status)} retry-after=${res.headers.get("retry-after") ?? "-"} body=${body.slice(0, 80)}`;
    }
  }
  const s = await showStats(base, "after restart probe");
  const acct = target === "esplora" ? "blockstream" : "alchemy";
  console.log(
    `S3 probe after restart: first=${first}\n  sequence=${statusCounts(statuses)} ` +
      `granted=${String(s.leases[acct]?.granted ?? 0)} ` +
      `lease-RPCs=${String(s.leases[acct]?.calls ?? 0)} ` +
      `refused=${String(s.leases[acct]?.refused ?? 0)}`,
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
  console.log(
    `S4: eth_call statuses=${statusCounts(statuses)} tron statuses=${statusCounts(tStatuses)} ` +
      `[${bodies.join(" | ")}]\n` +
      `  B upstream: alchemy calls=${String(s.upstream["alchemy"]?.calls ?? 0)} ` +
      `trongrid=${String(s.upstream["trongrid"]?.calls ?? 0)} tatum=${String(s.upstream["tatum"]?.calls ?? 0)}\n` +
      `  B leases: ${JSON.stringify(s.leases)}`,
  );
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

  for (const currency of ["eur", "usd"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- two requests in order
    const res = await fetch(`${base}/v1/prices`, {
      method: "POST",
      headers: headers(ip),
      body: JSON.stringify({
        currency,
        assets: ["eip155:56/slip44:714", "bip122:000000000019d6689c085ae165831e93/slip44:0"],
      }),
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    const body = await res.text();
    console.log(
      `S5b prices ${currency}: status=${String(res.status)} x-gateway-providers=${res.headers.get("x-gateway-providers") ?? "-"} body=${body.slice(0, 400)}`,
    );
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

  const eStatuses: number[] = [];
  for (let i = 0; i < 30; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- burst of 30
    const res = await fetch(
      `${base}/v1/esplora/bip122:000000000019d6689c085ae165831e93/blocks/tip/height`,
      { headers: headers(ip) },
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    eStatuses.push(res.status);
    console.log(`  esplora ${String(i + 1)}: ${String(res.status)}`);
  }
  console.log(`S5d Esplora ×30 burst from ${ip}: statuses=${statusCounts(eStatuses)}`);
};

const s6 = async (base: string): Promise<void> => {
  const untilBlocked = async (ip: string, client = CLIENT_ID): Promise<number[]> => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- until refusal
      const res = await tronBlock(base, ip, client);
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      statuses.push(res.status);
      if (res.status === 429) {
        break;
      }
    }
    return statuses;
  };
  const one = async (ip: string, client = CLIENT_ID): Promise<number> => {
    const res = await tronBlock(base, ip, client);
    await res.text();
    return res.status;
  };

  const a1 = await untilBlocked("::ffff:198.51.100.1");
  const a2 = await one("::ffff:203.0.113.9");
  console.log(
    `S6a mapped-v4: first ::ffff:198.51.100.1 → ${statusCounts(a1)}; second ::ffff:203.0.113.9 → ${String(a2)}`,
  );

  const b1 = await untilBlocked("none");
  const b2 = await one("none", CLIENT_ID_B);
  console.log(
    `S6b no-ip: client A → ${statusCounts(b1)}; client B (different client id) → ${String(b2)}`,
  );

  const c1 = await untilBlocked("2001:db8:1:1::1");
  const c2 = await one("2001:db8:1:2::1");
  console.log(
    `S6c same-/48: first 2001:db8:1:1::1 → ${statusCounts(c1)}; second 2001:db8:1:2::1 → ${String(c2)}`,
  );
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
};

const main = async (): Promise<void> => {
  const [scenario, a, b] = process.argv.slice(2);
  if (scenario === undefined || a === undefined || (scenario === "s2" && b === undefined)) {
    console.log(
      "usage: bun drive.ts <s1|s2|s3|s3t|s3probe|s4|s5|s6|s7> <url-a> [url-b]  (s2 needs both, s3t/s3probe-tron for SCALE=s3slow)",
    );
    return;
  }
  console.log(`scenario=${scenario} A=${a} B=${b ?? "-"} at ${new Date().toISOString()}`);
  switch (scenario) {
    case "s1":
      await s1(a);
      break;
    case "s2":
      await s2(a, b ?? a);
      break;
    case "s3":
      await s3(a);
      break;
    case "s3probe":
      await s3probe(a);
      break;
    case "s3t":
      await s3t(a);
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
    default:
      console.log(`unknown scenario ${scenario}`);
  }
};

await main();
