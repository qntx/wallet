/**
 * Mutation testing of the N2 guard code: one exact string replacement at a time, then the existing
 * gateway suite (`bunx vitest run --exclude 'tests/n3-review/**'`). Each file is restored
 * byte-for-byte from the in-memory copy in `finally`. Output is a killed/survived table with the
 * first failing test for every killed mutant.
 *
 * Bun mutants.ts > <evidence>/mutation.txt
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GATEWAY = join(import.meta.dirname, "../..");
const ROOT = join(GATEWAY, "../..");

type Mutant = {
  readonly id: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly note: string;
};

const RATE_LIMIT = "apps/gateway/src/middleware/rate-limit.ts";
const FORWARD = "apps/gateway/src/providers/forward.ts";
const LEASED = "apps/gateway/src/budget/leased.ts";
const BUCKET = "apps/gateway/src/budget/bucket.ts";
const DURABLE = "apps/gateway/src/budget/durable.ts";
const NETWORK = "apps/gateway/src/middleware/network.ts";
const APP = "apps/gateway/src/app.ts";
const COSTS = "apps/gateway/src/budget/costs.ts";
const RPC = "apps/gateway/src/routes/rpc.ts";
const PRICES = "apps/gateway/src/providers/prices.ts";
const TRON_PROVIDER = "apps/gateway/src/providers/tron.ts";
const TRON_ROUTE = "apps/gateway/src/routes/tron.ts";
const ELIGIBILITY_ROUTE = "apps/gateway/src/routes/eligibility.ts";
const ELIGIBILITY_CONFIG = "apps/gateway/src/config/eligibility.ts";
const ESPLORA_ROUTE = "apps/gateway/src/routes/esplora.ts";

const MUTANTS: ReadonlyArray<Mutant> = [
  {
    id: "M1",
    file: RATE_LIMIT,
    find: '      if (delta > SHARE_LIMIT) {\n        throw new GatewayHttpError(413, "too-costly");\n      }\n',
    replace: "",
    note: "share delta cap 413 removed",
  },
  {
    id: "M2",
    file: RATE_LIMIT,
    find: `key: \`\${account}:\${key}\``,
    replace: `key: \`\${key}\``,
    note: "share key loses the account prefix",
  },
  {
    id: "M3",
    file: RATE_LIMIT,
    find: "for (const key of keys)",
    replace: "for (const key of keys.slice(0, 1))",
    note: "share charges only the most specific key",
  },
  {
    id: "M4",
    file: RATE_LIMIT,
    find: "const SHARE_OF_ACCOUNT = 0.05;",
    replace: "const SHARE_OF_ACCOUNT = 1;",
    note: "one IP may take the whole account",
  },
  {
    id: "M5",
    file: RATE_LIMIT,
    find: "Math.min(...account.budget.map(",
    replace: "Math.max(...account.budget.map(",
    note: "perMinute uses the fastest window",
  },
  {
    id: "M6",
    file: RATE_LIMIT,
    find: "  const meter: Meter = async (account, units) => {\n      if (units <= 0) {",
    replace: "  const meter: Meter = async (account, units) => {\n      if (units < 0) {",
    note: "zero-cost calls are share-metered",
  },
  {
    id: "M7",
    file: RATE_LIMIT,
    find: `\`, \${normalized.slice(0, 3).join(":")}::/48\``,
    replace: "`",
    note: "IPv6 loses the coarse /48 key",
  },
  {
    id: "M8",
    file: RATE_LIMIT,
    find: "octets.slice(0, 3)",
    replace: "octets.slice(0, 4)",
    note: "IPv4 keyed on the whole address, not /24",
  },
  {
    id: "M9",
    file: FORWARD,
    find: "    await meter(provider.account, request.cost);\n",
    replace: "",
    note: "sendTo stops metering the client's share",
  },
  {
    id: "M10",
    file: FORWARD,
    find: "    if (request.cost > 0) {\n      // Then the account's shared quota: a refusal fails over — never a breaker outage, and the\n      // account's known wait time reaches the client when every provider is out of budget.\n      const decision = await budget.take(provider.account, request.cost);\n      if (!decision.ok) {\n        throw new ProviderFailure(\"budget\", true, decision.retryAfterSeconds);\n      }\n    }\n",
    replace: "",
    note: "sendTo never consults the account budget",
  },
  {
    id: "M11",
    file: FORWARD,
    find: 'new ProviderFailure("budget", true, decision.retryAfterSeconds)',
    replace: 'new ProviderFailure("budget", false, decision.retryAfterSeconds)',
    note: "budget refusal counts as an outage",
  },
  {
    id: "M12",
    file: FORWARD,
    find: "    if (request.cost > 0) {\n      // Then the account's shared quota:",
    replace: "    if (request.cost >= 0) {\n      // Then the account's shared quota:",
    note: "zero-cost calls still take budget",
  },
  {
    id: "M13",
    file: FORWARD,
    find: '    if (cooled > 0) {\n      // The account itself announced the wait: the client is never charged for a skipped call.\n      throw new ProviderFailure("cooling-down", true, cooled);\n    }\n',
    replace: "",
    note: "cooled-down accounts are called anyway",
  },
  {
    id: "M14",
    file: FORWARD,
    find: 'throw new ProviderFailure("status-429", true, seconds);',
    replace: 'throw new ProviderOutage("status-429", true);',
    note: "upstream 429 counts as an outage",
  },
  {
    id: "M15",
    file: FORWARD,
    find: '      const seconds = Math.min(\n        parseRetryAfter(response.headers.get("retry-after")) ?? COOLDOWN_DEFAULT_SECONDS,\n        COOLDOWN_MAX_SECONDS,\n      );',
    replace:
      '      const seconds =\n        parseRetryAfter(response.headers.get("retry-after")) ?? COOLDOWN_DEFAULT_SECONDS;',
    note: "upstream retry-after is trusted without a clamp",
  },
  {
    id: "M16",
    file: FORWARD,
    find: '    (await probeFailed(provider))\n      ? new ProviderOutage("probe", false)\n      : new ProviderFailure("timeout", false);',
    replace: '    new ProviderOutage("probe", false);',
    note: "every timeout counts as a dead provider",
  },
  {
    id: "M17",
    file: FORWARD,
    find: "export const PROBE_VERDICT_MS = 10_000;",
    replace: "export const PROBE_VERDICT_MS = 0;",
    note: "probe verdicts never cache",
  },
  {
    id: "M18",
    file: FORWARD,
    find: "const probeMeter: Meter = async () => {\n  await Promise.resolve();\n};",
    replace:
      'const probeMeter: Meter = async () => {\n  await Promise.resolve();\n  throw new GatewayHttpError(429, "rate-limited");\n};',
    note: "probes charged to the client share",
  },
  {
    id: "M19",
    file: LEASED,
    find: "live.expiresAt > now() && ",
    replace: "",
    note: "expired leases still spend",
  },
  {
    id: "M20",
    file: LEASED,
    find: "        // The shared quota cannot be consulted; refuse rather than overspend it.\n        return { ok: false, retryAfterSeconds: 1 };",
    replace: "        return { ok: true, granted: units };",
    note: "DO errors fail open",
  },
  {
    id: "M21",
    file: LEASED,
    find: "    if (existing !== undefined) {\n      return existing;\n    }\n",
    replace: "",
    note: "no single-flight: concurrent takes each hit the DO",
  },
  {
    id: "M22",
    file: LEASED,
    find: "live.remaining >= units",
    replace: "live.remaining > 0",
    note: "a part-covered lease still spends",
  },
  {
    id: "M23",
    file: BUCKET,
    find: "state.levels[index] = Math.min(window.units, level);",
    replace: "state.levels[index] = level;",
    note: "refill above capacity",
  },
  {
    id: "M24",
    file: BUCKET,
    find: "retryAfterSeconds: Math.max(1, ...waits)",
    replace: "retryAfterSeconds: Math.max(0, ...waits)",
    note: "refusal can announce a zero wait",
  },
  {
    id: "M25",
    file: DURABLE,
    find: "      const stored = this.ctx.storage.kv.get<BucketState>(LEVELS_KEY);\n      const state =\n        stored !== undefined && stored.levels.length === windows.length\n          ? stored\n          : fullBuckets(windows, now);",
    replace: "      const state = fullBuckets(windows, now);",
    note: "DO ignores stored levels (restart resets to full)",
  },
  {
    id: "M26",
    file: DURABLE,
    find: "      this.ctx.storage.kv.put(LEVELS_KEY, state);\n",
    replace: "",
    note: "DO never persists levels",
  },
  {
    id: "M27",
    file: NETWORK,
    find: `      if (\n        (info.family === "bitcoin" || info.family === "tron") &&\n        account.costs.kind !== "request"\n      ) {\n        throw new Error(\n          \`provider \${provider.id} on \${network.id} has a \${account.costs.kind} cost model\`,\n        );\n      }\n`,
    replace: "",
    note: "rpc-priced accounts allowed on bitcoin/tron providers",
  },
  {
    id: "M28",
    file: NETWORK,
    find: `      if (account === undefined) {\n        throw new Error(\`provider \${provider.id} on \${network.id} has no account "\${accountName}"\`);\n      }\n`,
    replace: "",
    note: "providers without an account pass construction",
  },
  {
    id: "M29",
    file: APP,
    find: `    if (account.costs.kind !== "request") {\n      throw new Error(\`provider \${provider.id} has a \${account.costs.kind} cost model\`);\n    }\n`,
    replace: "",
    note: "code-built providers accept any cost model",
  },
  {
    id: "M30",
    file: COSTS,
    find: "    return calls.length * model.request.units;",
    replace: "    return model.request.units;",
    note: "request-priced batches billed once",
  },
  {
    id: "M31",
    file: RPC,
    find: 'await c.get("charge")((Array.isArray(body) ? body.length : 1) - 1);',
    replace: 'await c.get("charge")(0);',
    note: "batches charge one unit regardless of length",
  },
  {
    id: "M32",
    file: PRICES,
    find: "error.status === 429 || error.status === 413",
    replace: "false",
    note: "a share-refused price source counts as a provider failure",
  },
  {
    id: "M33",
    file: TRON_PROVIDER,
    find: '  network.providers.filter((provider) => provider.id === "trongrid");',
    replace: "  network.providers;",
    note: "indexer paths sent to any node provider",
  },
  {
    id: "M34",
    file: TRON_ROUTE,
    find: "broadcast: path === TRON_BROADCAST_PATH",
    replace: "broadcast: false",
    note: "broadcast loses its outcome-unknown guard",
  },
  {
    id: "M35",
    file: TRON_ROUTE,
    find: '  if (!accepts(schema, parsed)) {\n    throw new ProviderFailure("malformed", false);\n  }',
    replace: "",
    note: "upstream tron answers unvalidated",
  },
  {
    id: "M36",
    file: TRON_PROVIDER,
    find: '    only_confirmed: "true",\n',
    replace: "",
    note: "indexer may return unconfirmed rows",
  },
  {
    id: "M37",
    file: ELIGIBILITY_ROUTE,
    find: 'country === null || country === "XX" || country === "T1"',
    replace: 'country === null || country === "XX"',
    note: "Tor exit nodes unblocked",
  },
  {
    id: "M38",
    file: ELIGIBILITY_CONFIG,
    find: `const codes = region === undefined ? [country] : [\`\${country}-\${region}\`, country];`,
    replace: "const codes = [country];",
    note: "subdivision blocks ignored",
  },
  {
    id: "M39",
    file: ELIGIBILITY_ROUTE,
    find: '  return c.json({ country, region, apps: resolved }, 200, {\n    "cache-control": "private, no-store",\n  });',
    replace: "  return c.json({ country, region, apps: resolved }, 200, {});",
    note: "eligibility answers become cacheable",
  },
  {
    id: "M40",
    file: ESPLORA_ROUTE,
    find: 'broadcast: path === "/tx"',
    replace: "broadcast: false",
    note: "esplora broadcast loses its outcome-unknown guard",
  },
  {
    id: "M41",
    file: ESPLORA_ROUTE,
    find: `          if (REFUSED_STATUSES.has(response.status)) {\n            throw new ProviderFailure(\`status-\${response.status}\`, true);\n          }\n`,
    replace: "",
    note: "esplora 401/403 relayed as the answer",
  },
  {
    id: "M42",
    file: TRON_ROUTE,
    find: '    if (!accepts(entry.request, body)) {\n      throw new GatewayHttpError(400, "invalid-request");\n    }\n',
    replace: "",
    note: "tron request bodies unvalidated",
  },
];

const run = (command: string, cwd: string): string => {
  try {
    return execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
  } catch (error) {
    const stdout =
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string"
        ? error.stdout
        : "";
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : "";
    return `${stdout}\n${stderr}`;
  }
};

const firstFailure = (output: string): string => {
  const named = /✗\s+(.+)/.exec(output) ?? /FAIL\s+(tests\/\S+)/.exec(output);
  return (
    named?.[1]?.trim() ??
    output
      .split("\n")
      .find((line) => line.includes("FAIL"))
      ?.trim() ??
    "-"
  );
};

console.log(
  `mutation run at ${new Date().toISOString()} — suite: bunx vitest run --exclude 'tests/n3-review/**'`,
);
const results: string[] = [];
for (const mutant of MUTANTS) {
  const path = join(ROOT, mutant.file);
  const original = readFileSync(path, "utf8");
  const occurrences = original.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    console.log(
      `${mutant.id} SKIP — search string found ${String(occurrences)}× in ${mutant.file} (${mutant.note})`,
    );
    results.push(`${mutant.id}\tSKIP(${String(occurrences)})\t-\t${mutant.note}`);
    continue;
  }
  try {
    writeFileSync(path, original.replace(mutant.find, mutant.replace), "utf8");
    const output = run("bunx vitest run --exclude 'tests/n3-review/**'", GATEWAY);
    const killed = /\b\d+ failed\b|FAIL|✗/.test(output) || !output.includes("passed");
    const failing = firstFailure(output);
    const verdict = killed ? "KILLED" : "SURVIVED";
    console.log(`${mutant.id} ${verdict} ${failing}`);
    results.push(`${mutant.id}\t${verdict}\t${failing}\t${mutant.note}`);
  } finally {
    writeFileSync(path, original, "utf8");
  }
}

console.log("\nid\tverdict\tfirst-failure\tnote");
for (const line of results) {
  console.log(line);
}
const diff = run("git diff --name-only -- apps/gateway/src packages", ROOT);
console.log(`\nrestored-clean: ${diff.trim() === "" ? "yes" : `NO — ${diff}`}`);
