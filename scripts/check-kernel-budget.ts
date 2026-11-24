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
 * - Card: a third build whose entry re-exports the card protocol index on top of the real entry.
 *   Nothing imports it yet, so an ablation cannot measure it; an `export *` build keeps every
 *   export and measures the upper bound of what wiring the client in can add. It is not part of the
 *   application share — it has its own budget.
 * - Signers: a fourth build the same way — namespace re-exports of every file under modules/signers/
 *   keep every export of the hardware signer module live (already wired, so the delta is only
 *   tree-shaken extras). Kernel infrastructure, not an application unit: it is out of the share and
 *   has its own budget.
 */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { loadWorkspace, resolveSpecifier } from "./check-boundaries.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ENTRY = "packages/wallet-native/kernel/kernel-entry.ts";
const SHARE_BUDGET = 0.05;
const CARD_ENTRY = "qntx-budget-card.ts";
const CARD_ENTRY_ID = "\0qntx-budget-card";
const CARD_PROTOCOL = "packages/wallet-kernel/src/modules/card/protocol/";
// measured 38260 B (rendered, all exports retained); budget from measurement with ≥ 5 % headroom
const CARD_BUDGET = 40_192;
const SIGNERS_ENTRY = "qntx-budget-signers.ts";
const SIGNERS_ENTRY_ID = "\0qntx-budget-signers";
const SIGNERS_MODULE = "packages/wallet-kernel/src/modules/signers/";
const SIGNERS_FILES = [
  "index.ts",
  "driver.ts",
  "drivers.ts",
  "operation.ts",
  "prompt.ts",
  "record.ts",
  "keystone/derive.ts",
  "keystone/driver.ts",
  "keystone/registry.ts",
  "keystone/sign.ts",
  "keystone/sync.ts",
  "ledger/display.ts",
  "ledger/driver.ts",
  "ledger/errors.ts",
  "ledger/link.ts",
  "ledger/pair.ts",
  "ledger/sign.ts",
  "ledger/verify.ts",
  "onekey/driver.ts",
  "onekey/protocol/bitcoin.ts",
  "onekey/protocol/device.ts",
  "onekey/protocol/errors.ts",
  "onekey/protocol/evm-typed-data.ts",
  "onekey/protocol/evm.ts",
  "onekey/protocol/frame.ts",
  "onekey/protocol/index.ts",
  "onekey/protocol/keys.ts",
  "onekey/protocol/messages.ts",
  "onekey/protocol/proto.ts",
  "onekey/protocol/session.ts",
  "onekey/protocol/solana.ts",
  "onekey/protocol/tron.ts",
];
// measured 220339 B (rendered, all exports retained); budget from measurement with ≥ 5 % headroom
const SIGNERS_BUDGET = 232_000;
const LEDGER_ENTRY = "qntx-budget-ledger.ts";
const LEDGER_ENTRY_ID = "\0qntx-budget-ledger";
const LEDGER_PROTOCOL = "packages/wallet-kernel/src/modules/ledger/protocol/";
// measured 69217 B (rendered, all exports retained); budget = measurement + ≥ 5 % headroom
const LEDGER_BUDGET = 72_678;

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
    // measured 11159 B; budget from measurement with ≥ 5 % headroom (owner decision 2026-11-22)
    budget: 11_776,
    note: "Hyperliquid typed-data action decoder for intent display",
  },
  {
    name: "hyperliquid-l1-agent scheme",
    match:
      /^packages\/(wallet-kernel\/src\/modules\/sessions\/schemes\/hyperliquid-l1-agent\/|wallet-chains\/src\/evm\/(hyperliquid-l1|msgpack)\.ts$)/,
    // budget 16 384 B by owner decision of 2026-11-22 (measured 15 794 B at introduction,
    // 15 940 B with the L1 encoder in @qntx/wallet-chains/evm; the study's 8 192 B is exceeded)
    budget: 16_384,
    note: "the one session scheme: L1 action validators, msgpack, phantom-agent document",
  },
  {
    name: "polymarket decoder",
    match: /^packages\/wallet-chains\/src\/evm\/polymarket\.ts$/,
    // measured 11688 B; budget from measurement with ≥ 5 % headroom (owner decision 2026-11-22)
    budget: 12_288,
    note: "Polymarket CLOB typed-data decoder for intent display",
  },
  {
    name: "fiat24 decoder",
    match: /^packages\/wallet-chains\/src\/evm\/fiat24\.ts$/,
    // measured 14710 B; budget from measurement with ≥ 5 % headroom (owner decision 2026-11-22),
    // above the study's 15 kB per decoder
    budget: 15_872,
    note: "Fiat24 calldata decoder, grant prefixes and session-message builder",
  },
  {
    name: "app recognition",
    match: /^packages\/wallet-chains\/src\/evm\/apps\.ts$/,
    budget: undefined,
    note: "recognizer dispatch — counts toward the share, has no per-unit budget",
  },
  {
    name: "card module",
    match: /^packages\/wallet-kernel\/src\/modules\/card\/(?!protocol\/)/,
    // measured 132741 B; budget from measurement with ≥ 5 % headroom (2026-11-23)
    budget: 139_776,
    note: "card operation engine — record, taps, ops, text (the protocol client has its own line)",
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
      // lib.entry is absolutized before plugins see it, so the virtual entry arrives as a path.
      if (id === resolve(ROOT, CARD_ENTRY)) {
        return CARD_ENTRY_ID;
      }
      if (id === resolve(ROOT, SIGNERS_ENTRY)) {
        return SIGNERS_ENTRY_ID;
      }
      if (id === resolve(ROOT, LEDGER_ENTRY)) {
        return LEDGER_ENTRY_ID;
      }
      // The virtual entry only references absolute paths; claim them as real files.
      if (
        importer === CARD_ENTRY_ID ||
        importer === SIGNERS_ENTRY_ID ||
        importer === LEDGER_ENTRY_ID
      ) {
        return id;
      }
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
      if (id === CARD_ENTRY_ID) {
        return `import "${resolve(ROOT, ENTRY)}"; export * from "${resolve(ROOT, CARD_PROTOCOL, "index.ts")}";`;
      }
      if (id === SIGNERS_ENTRY_ID) {
        // Namespace re-exports retain every export of every signers file; `export *` would
        // silently drop a colliding name. The module is kernel infrastructure, already wired
        // by the real entry — this build measures the upper bound of what it can cost.
        const imports = SIGNERS_FILES.map(
          (file, i) => `import * as s${i} from "${resolve(ROOT, SIGNERS_MODULE, file)}";`,
        ).join(" ");
        const names = SIGNERS_FILES.map((_file, i) => `s${i}`).join(", ");
        return `import "${resolve(ROOT, ENTRY)}"; ${imports} export { ${names} };`;
      }
      if (id === LEDGER_ENTRY_ID) {
        return `import "${resolve(ROOT, ENTRY)}"; export * from "${resolve(ROOT, LEDGER_PROTOCOL, "index.ts")}";`;
      }
      return ablate ? (STUBS[rel(id)] ?? null) : null;
    },
  },
];

type Chunk = {
  readonly type: string;
  readonly code?: string;
  readonly modules?: Record<string, { renderedLength: number }>;
};

const run = async (ablate: boolean, entry: string = ENTRY) => {
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
      lib: { entry, formats: ["iife"], name: "qntxKernelEntry" },
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
const card = await run(false, CARD_ENTRY);
const signers = await run(false, SIGNERS_ENTRY);
const ledger = await run(false, LEDGER_ENTRY);

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
let cardBytes = 0;
for (const [id, renderedLength] of card.rendered) {
  if (id.startsWith(CARD_PROTOCOL)) {
    cardBytes += renderedLength;
  }
}
const cardDelta = card.bytes - full.bytes;
console.log(
  `  ${"card protocol client".padEnd(26)} ${String(cardBytes).padStart(7)} B / ${CARD_BUDGET} B  ${cardBytes === 0 || cardBytes > CARD_BUDGET ? "BREACH " : ""}— qntx card protocol client, all exports retained (bundle delta +${cardDelta} B)`,
);
if (cardBytes === 0) {
  breaches.push(`card protocol client: no rendered modules under ${CARD_PROTOCOL}`);
}
if (cardBytes > CARD_BUDGET) {
  breaches.push(`card protocol client: ${cardBytes} B exceeds ${CARD_BUDGET} B`);
}
let signersBytes = 0;
for (const [id, renderedLength] of signers.rendered) {
  if (id.startsWith(SIGNERS_MODULE)) {
    signersBytes += renderedLength;
  }
}
const signersDelta = signers.bytes - full.bytes;
console.log(
  `  ${"signers module".padEnd(26)} ${String(signersBytes).padStart(7)} B / ${SIGNERS_BUDGET} B  ${signersBytes === 0 || signersBytes > SIGNERS_BUDGET ? "BREACH " : ""}— hardware signer module, all exports retained (bundle delta +${signersDelta} B)`,
);
if (signersBytes === 0) {
  breaches.push(`signers module: no rendered modules under ${SIGNERS_MODULE}`);
}
if (signersBytes > SIGNERS_BUDGET) {
  breaches.push(`signers module: ${signersBytes} B exceeds ${SIGNERS_BUDGET} B`);
}
let ledgerBytes = 0;
for (const [id, renderedLength] of ledger.rendered) {
  if (id.startsWith(LEDGER_PROTOCOL)) {
    ledgerBytes += renderedLength;
  }
}
const ledgerDelta = ledger.bytes - full.bytes;
const ledgerLimit = `${LEDGER_BUDGET} B`;
console.log(
  `  ${"ledger protocol client".padEnd(26)} ${String(ledgerBytes).padStart(7)} B / ${ledgerLimit}  ${ledgerBytes > LEDGER_BUDGET ? "BREACH " : ""}— ledger protocol client, all exports retained (bundle delta +${ledgerDelta} B)`,
);
if (ledgerBytes === 0) {
  breaches.push(`ledger protocol client: no rendered modules under ${LEDGER_PROTOCOL}`);
}
if (ledgerBytes > LEDGER_BUDGET) {
  breaches.push(`ledger protocol client: ${ledgerBytes} B exceeds ${LEDGER_BUDGET} B`);
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
