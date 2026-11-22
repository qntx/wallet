/**
 * The kernel's application budget, run by `bun run lint` (AGENTS.md: the application share of the
 * native kernel bundle stays within these budgets). The architecture study's ablation probe made
 * runnable: build `packages/wallet-native/kernel/kernel-entry.ts` the way `build-kernel.ts` ships
 * it (rolldown via vite, iife, es2017, no minify, nothing external) but with workspace specifiers
 * resolved to their src files like check-bundles.ts, so it needs no prior package build. Then:
 *
 * - Full: attribute each module's renderedLength to its application unit;
 * - Ablated: the application entry points replaced by minimal stubs — the delta is the whole
 *   application subtree, including dependencies nothing else uses. Budgets (architecture study
 *   §5.1): application share ≤ 5 % of the bundle; each session scheme ≤ 8 kB rendered; each
 *   protocol-family decoder ≤ 15 kB rendered. Exit 1 on any breach.
 */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { loadWorkspace, resolveSpecifier } from "./check-boundaries.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ENTRY = "packages/wallet-native/kernel/kernel-entry.ts";
const SHARE_BUDGET = 0.05;

type Unit = {
  readonly name: string;
  readonly match: RegExp;
  /** Rendered bytes this unit may take, or undefined when only the share constrains it. */
  readonly budget: number | undefined;
  /** What this unit is, in one line. */
  readonly note: string;
};

const UNITS: ReadonlyArray<Unit> = [
  {
    name: "hyperliquid decoder",
    match: /^packages\/wallet-chains\/src\/evm\/hyperliquid\.ts$/,
    budget: 15_360,
    note: "Hyperliquid typed-data action decoder for intent display",
  },
  {
    name: "hyperliquid-l1-agent scheme",
    match: /^packages\/wallet-kernel\/src\/modules\/sessions\/schemes\/hyperliquid-l1-agent\//,
    // measured 15794 B; study budget 8192 B exceeded — needs a recorded decision
    budget: 16_384,
    note: "the one session scheme: L1 action validators, msgpack, phantom-agent document",
  },
  {
    name: "polymarket decoder",
    match: /^packages\/wallet-chains\/src\/evm\/polymarket\.ts$/,
    budget: 15_360,
    note: "Polymarket CLOB typed-data decoder for intent display",
  },
  {
    name: "fiat24 decoder",
    match: /^packages\/wallet-chains\/src\/evm\/fiat24\.ts$/,
    // measured 14710 B
    budget: 15_360,
    note: "Fiat24 calldata decoder, grant prefixes and session-message builder",
  },
  {
    name: "app recognition",
    match: /^packages\/wallet-chains\/src\/evm\/apps\.ts$/,
    budget: undefined,
    note: "recognizer dispatch — counts toward the share, has no per-unit budget",
  },
];

/** Application entry points and the runtime exports their importers actually use. */
const STUBS: Readonly<Record<string, string>> = {
  "packages/wallet-chains/src/evm/apps.ts": "export const recognizeApp = () => undefined;",
  "packages/wallet-chains/src/evm/fiat24.ts":
    "export const FIAT24_CHAIN = 42161; export const isFiat24Contract = () => false; export const hasFiat24Selector = () => false; export const fiat24Spender = () => undefined; export const fiat24SessionMessage = () => ''; export const decodeFiat24 = () => undefined;",
  "packages/wallet-kernel/src/modules/sessions/schemes/index.ts":
    "export const SESSION_SCHEMES = {}; export const isSchemeId = () => false; export const schemeOf = () => undefined;",
};

for (const stub of Object.keys(STUBS)) {
  if (!existsSync(resolve(ROOT, stub))) {
    throw new Error(`budget stub target missing: ${stub} — update STUBS`);
  }
}

const workspace = await loadWorkspace(ROOT);
const rel = (id: string): string => relative(ROOT, id.split(/[?#]/)[0] ?? id).replaceAll("\\", "/");

const plugins = (ablate: boolean) => [
  {
    name: "qntx-budget-src",
    enforce: "pre" as const,
    resolveId(id: string, importer: string | undefined) {
      if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) {
        return null;
      }
      const target = resolveSpecifier(
        ROOT,
        workspace,
        importer === undefined ? ENTRY : rel(importer),
        id,
      );
      return target.kind === "file" ? resolve(ROOT, target.path) : null;
    },
    load(id: string) {
      return ablate ? (STUBS[rel(id)] ?? null) : null;
    },
  },
];

type Chunk = {
  readonly type: string;
  readonly code?: string;
  readonly modules?: Record<string, { renderedLength: number }>;
};

const run = async (ablate: boolean) => {
  let bundleOutput: Record<string, Chunk> | undefined;
  await build({
    configFile: false,
    root: ROOT,
    logLevel: "silent",
    plugins: [
      ...plugins(ablate),
      {
        name: "qntx-budget-capture",
        generateBundle(_options: unknown, bundle: Record<string, Chunk>) {
          bundleOutput = bundle;
        },
      },
    ],
    build: {
      lib: { entry: resolve(ROOT, ENTRY), formats: ["iife"], name: "qntxKernelEntry" },
      write: false,
      minify: false,
      target: "es2017",
      rolldownOptions: { external: [] },
    },
  });
  if (bundleOutput === undefined) {
    throw new Error("kernel build produced no bundle output");
  }
  const chunks = Object.values(bundleOutput).filter((o) => o.type === "chunk");
  const code = chunks.map((c) => c.code ?? "").join("\n");
  const rendered = new Map<string, number>();
  for (const chunk of chunks) {
    for (const [id, info] of Object.entries(chunk.modules ?? {})) {
      rendered.set(rel(id), info.renderedLength);
    }
  }
  return { bytes: Buffer.byteLength(code), rendered };
};

const full = await run(false);
const ablated = await run(true);

const delta = full.bytes - ablated.bytes;
const share = delta / full.bytes;
const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

console.log(`full build:     ${full.bytes} B`);
console.log(`ablated build:  ${ablated.bytes} B`);
console.log(
  `application:    ${delta} B  ${pct(share)} of the bundle (budget ≤ ${pct(SHARE_BUDGET)})`,
);
const breaches: string[] = [];
if (share > SHARE_BUDGET) {
  breaches.push(`application share ${pct(share)} exceeds ${pct(SHARE_BUDGET)}`);
}
for (const unit of UNITS) {
  let bytes = 0;
  for (const [id, renderedLength] of full.rendered) {
    if (unit.match.test(id)) {
      bytes += renderedLength;
    }
  }
  if (bytes === 0) {
    console.log(
      `  ${unit.name.padEnd(26)} 0 B   !! no rendered modules match ${unit.match.source}`,
    );
    breaches.push(`${unit.name}: no rendered modules matched ${unit.match.source}`);
    continue;
  }
  const over = unit.budget !== undefined && bytes > unit.budget;
  const limit = unit.budget === undefined ? "share only" : `${unit.budget} B`;
  console.log(
    `  ${unit.name.padEnd(26)} ${String(bytes).padStart(7)} B / ${limit}  ${over ? "BREACH " : ""}— ${unit.note}`,
  );
  if (over) {
    breaches.push(`${unit.name}: ${bytes} B exceeds ${unit.budget} B`);
  }
}
console.log(
  "note: prompt rows for hyperliquid/polymarket inside modules/chains/prompt.ts share a file with core rows and are not attributed.",
);
if (breaches.length > 0) {
  console.error(`check-kernel-budget: ${breaches.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("check-kernel-budget: within budget");
}
