/* oxlint-disable eslint/no-console -- audit runner prints its results */
/**
 * R4 audit probes for scripts/check-boundaries.ts and the enclave-globals lint zone (vite.config.ts +
 * scripts/enclave-zone.ts). Modelled on scripts/check-lint-boundaries.ts, but the expectations are
 * inverted: each probe spells a FORBIDDEN load a checker should catch, and the table records
 * whether check-boundaries and `vp lint` actually saw it.
 *
 * Bun audit/r4/boundary-probes.ts
 *
 * Writes throw-away files/symlinks named __r4_probe_* into the real source trees (plus temporary
 * appends to packages/wallet/src/protocol/index.ts for the closure-reach probes, restored in the
 * same run), collects boundaryViolations() plus one `vp lint -f json` run over the probe files,
 * prints the findings, and removes everything it created. Bundle landing is proven separately —
 * evidence/boundary-bundle-proofs.txt.
 *
 * Columns: BND — violations check-boundaries attributes to the probe file (rule@line) LINT — vp
 * lint codes on the probe file (incidental style findings count too; they still fail `vp check`,
 * but they are annotated separately in the verdict) VERDICT — for "flag" cases: CAUGHT means a
 * boundary violation named the forbidden load; MISSED means the checker saw nothing (a real bypass
 * unless lint happened to fire on the spelling anyway, shown in the LINT column). For case 13:
 * ALLOWED = the enclave allow-list permits the global; BLOCKED = no-undef/no-restricted-globals or
 * another rule fired.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { boundaryViolations } from "../../scripts/check-boundaries.ts";

// The repo does not depend on @types/bun; declare the used surface.
declare const Bun: {
  spawnSync: (options: { cmd: string[]; cwd?: string; stdout: "pipe"; stderr: "pipe" }) => {
    exitCode: number;
    stdout: { toString: () => string };
    stderr: { toString: () => string };
  };
};

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const rel = (absolute: string): string => relative(ROOT, absolute).replaceAll("\\", "/");

type Extra = {
  readonly path: string;
  /** File contents, or a symlink target (repo-relative) when `link` is set. */
  readonly source?: string;
  readonly link?: string;
};

type Probe = {
  /** Case number(s) from the review brief. */
  readonly id: string;
  readonly desc: string;
  /** Extra files/symlinks the probe needs (created first, cleaned last). */
  readonly extra?: ReadonlyArray<Extra>;
  /**
   * Lines temporarily appended to a committed file for the duration of the check run (the closure
   * walk needs a real inbound edge — a kernel import spelled relatively would itself trip
   * relative-packages).
   */
  readonly append?: ReadonlyArray<{ path: string; lines: string }>;
  /** The probe file itself (its findings are what get reported). */
  readonly file: string;
  readonly source: string;
  /**
   * Whether the load is forbidden (a complete gate would report it) or a legitimate spelling that
   * must stay clean (false-positive probe).
   */
  readonly kind: "forbidden" | "legitimate" | "global";
};

const KERNEL = "packages/wallet-kernel/src";
const NATIVE_KERNEL = "packages/wallet-native/kernel";
const ENGINE = "packages/wallet-engine/src";
const PROTOCOL = "packages/wallet/src/protocol";
const PROTOCOL_INDEX = `${PROTOCOL}/index.ts`;
const SIGNER = "../../wallet-chains/src/evm/sign.ts";

// A self-contained marker: no imports, boundary-clean wherever it is judged
// from — anything that lands it is a real payload.
const CHAINS_MARKER = "packages/wallet-chains/src/__r4_marker.ts";
const ENGINE_MARKER = `${ENGINE}/__r4_marker.ts`;
const MARKER_SOURCE = 'export const R4_MARKER = "R4_MARKER_LANDED";\n';

const PROBES: Probe[] = [
  // Case 1: CJS require is invisible to the import-walker (it only reads the
  // parser's module record). The globals lint is the only gate on `require`.
  {
    id: "1a",
    desc: 'require("…/evm/sign.ts") in engine src',
    file: `${ENGINE}/__r4_probe_require.ts`,
    source: `const s = require("${SIGNER}");\nexport const x = typeof s;\n`,
    kind: "forbidden",
  },
  {
    id: "1b",
    desc: "module.require(…) in engine src",
    file: `${ENGINE}/__r4_probe_modreq.ts`,
    source: `const s = module.require("${SIGNER}");\nexport const x = typeof s;\n`,
    kind: "forbidden",
  },
  {
    id: "1c",
    desc: 'createRequire from "node:module" in engine src',
    file: `${ENGINE}/__r4_probe_createreq.ts`,
    source: [
      'import { createRequire } from "node:module";',
      "const r = createRequire(import.meta.url);",
      `export const x = typeof r("${SIGNER}");`,
      "",
    ].join("\n"),
    kind: "forbidden",
  },

  // Case 2: TS import-require. erasableSyntaxOnly rejects it at typecheck
  // (TS1294); the walker records no edge for it either.
  {
    id: "2",
    desc: 'import s = require("…/evm/sign.ts") in engine src',
    file: `${ENGINE}/__r4_probe_importeq.ts`,
    source: `import s = require("${SIGNER}");\nexport const x = typeof s;\n`,
    kind: "forbidden",
  },

  // Case 3: dynamic-import spellings. Anything but a quoted literal is judged
  // "a computed dynamic import cannot be checked" — fail closed.
  {
    id: "3a",
    desc: "import(`…`) template literal without expressions",
    file: `${ENGINE}/__r4_probe_dyn_tpl.ts`,
    source: `export const m = import(\`${SIGNER}\`);\n`,
    kind: "forbidden",
  },
  {
    id: "3b",
    desc: 'import(/* c */ "…") leading comment',
    file: `${ENGINE}/__r4_probe_dyn_comment.ts`,
    source: `export const m = import(/* r4 */ "${SIGNER}");\n`,
    kind: "forbidden",
  },
  {
    id: "3c",
    desc: 'import("…", { with: {} }) import attributes',
    file: `${ENGINE}/__r4_probe_dyn_attrs.ts`,
    source: `export const m = import("${SIGNER}", { with: {} });\n`,
    kind: "forbidden",
  },
  {
    id: "3d",
    desc: 'import("a" + "b") concatenated literal',
    file: `${ENGINE}/__r4_probe_dyn_concat.ts`,
    source: 'export const m = import("../../wallet-chains/src/" + "evm/sign.ts");\n',
    kind: "forbidden",
  },

  // Case 4: extensions the walker ignores (.js, .cts — SOURCE_FILE is
  // ts|tsx|mts). The .ts importer resolves fine; the payload file is never
  // parsed, so the engine code it re-exports reaches bundles unchecked.
  {
    id: "4a",
    desc: "kernel .ts imports ./payload.js (unwalked) that re-exports engine src",
    extra: [
      { path: ENGINE_MARKER, source: MARKER_SOURCE },
      {
        path: `${KERNEL}/__r4_probe_payload.js`,
        source: `export { R4_MARKER } from "../../wallet-engine/src/__r4_marker.ts";\n`,
      },
    ],
    file: `${KERNEL}/__r4_probe_use_js.ts`,
    source: 'import { R4_MARKER } from "./__r4_probe_payload.js";\nexport const m = R4_MARKER;\n',
    kind: "forbidden",
  },
  {
    id: "4b",
    desc: "kernel .ts imports ./payload.cts (unwalked) that re-exports engine src",
    extra: [
      { path: ENGINE_MARKER, source: MARKER_SOURCE },
      {
        path: `${KERNEL}/__r4_probe_payload.cts`,
        source: `export { R4_MARKER } from "../../wallet-engine/src/__r4_marker.ts";\n`,
      },
    ],
    file: `${KERNEL}/__r4_probe_use_cts.ts`,
    source: 'import { R4_MARKER } from "./__r4_probe_payload.cts";\nexport const m = R4_MARKER;\n',
    kind: "forbidden",
  },

  // Case 5: directories named generated/dist/node_modules under src are
  // skipped by the walker everywhere — the payload's edges never exist.
  {
    id: "5a",
    desc: "kernel file imports src/generated/payload.ts re-exporting engine src",
    extra: [
      { path: ENGINE_MARKER, source: MARKER_SOURCE },
      {
        path: `${KERNEL}/generated/__r4_probe.ts`,
        source: `export { R4_MARKER } from "../../../wallet-engine/src/__r4_marker.ts";\n`,
      },
    ],
    file: `${KERNEL}/__r4_probe_use_gen.ts`,
    source: 'import { R4_MARKER } from "./generated/__r4_probe.ts";\nexport const m = R4_MARKER;\n',
    kind: "forbidden",
  },
  {
    id: "5b",
    desc: "kernel file imports src/dist/payload.ts re-exporting engine src",
    extra: [
      { path: ENGINE_MARKER, source: MARKER_SOURCE },
      {
        path: `${KERNEL}/dist/__r4_probe.ts`,
        source: `export { R4_MARKER } from "../../../wallet-engine/src/__r4_marker.ts";\n`,
      },
    ],
    file: `${KERNEL}/__r4_probe_use_dist.ts`,
    source: 'import { R4_MARKER } from "./dist/__r4_probe.ts";\nexport const m = R4_MARKER;\n',
    kind: "forbidden",
  },
  {
    id: "5c",
    desc: "kernel file imports src/node_modules/payload.ts re-exporting engine src",
    extra: [
      { path: ENGINE_MARKER, source: MARKER_SOURCE },
      {
        path: `${KERNEL}/node_modules/__r4_probe.ts`,
        source: `export { R4_MARKER } from "../../../wallet-engine/src/__r4_marker.ts";\n`,
      },
    ],
    file: `${KERNEL}/__r4_probe_use_nm.ts`,
    source:
      'import { R4_MARKER } from "./node_modules/__r4_probe.ts";\nexport const m = R4_MARKER;\n',
    kind: "forbidden",
  },
  {
    id: "5d",
    desc: "engine transactions file reaches src/prices via src/generated/ helper",
    extra: [
      {
        path: `${ENGINE}/generated/__r4_prices.ts`,
        source: 'export * from "../prices/controller.ts";\n',
      },
    ],
    file: `${ENGINE}/transactions/__r4_probe_genuse.ts`,
    source: 'import * as p from "../generated/__r4_prices.ts";\nexport const x = typeof p;\n',
    kind: "forbidden",
  },

  // Case 6: `export {} from` records NO edge at all (the parser emits a
  // staticExports entry with an empty binding list), yet at runtime it still
  // requests and evaluates the module — an invisible pull into any bundle.
  {
    id: "6a",
    desc: 'native-kernel file: export {} from "../../wallet-engine/src/index.ts"',
    file: `${NATIVE_KERNEL}/__r4_probe_emptyre.ts`,
    source: 'export {} from "../../wallet-engine/src/index.ts";\n',
    kind: "forbidden",
  },
  {
    id: "6b",
    desc: "control — native-kernel file: export * from engine (enclave-imports)",
    file: `${NATIVE_KERNEL}/__r4_probe_starre.ts`,
    source: 'export * from "../../wallet-engine/src/index.ts";\n',
    kind: "forbidden",
  },
  {
    id: "6c",
    desc: "control — native-kernel file: export * as e from engine",
    file: `${NATIVE_KERNEL}/__r4_probe_nsre.ts`,
    source: 'export * as e from "../../wallet-engine/src/index.ts";\n',
    kind: "forbidden",
  },
  {
    // The closure-walk half: index.ts legitimately reaches the payload via a
    // recorded edge … except `export {}` records none, so the payload's own
    // forbidden value edge is never walked.
    id: "6d",
    desc: 'protocol/index.ts += export {} from "./payload.ts"; payload imports @qntx/wallet-engine',
    append: [{ path: PROTOCOL_INDEX, lines: 'export {} from "./__r4_probe_emptyre.ts";\n' }],
    file: `${PROTOCOL}/__r4_probe_emptyre.ts`,
    source: 'export * as engine from "@qntx/wallet-engine";\n',
    kind: "forbidden",
  },
  {
    id: "6e",
    desc: 'control — protocol/index.ts += export { x } from "./payload.ts" (recorded)',
    append: [{ path: PROTOCOL_INDEX, lines: 'export { x } from "./__r4_probe_namedre.ts";\n' }],
    file: `${PROTOCOL}/__r4_probe_namedre.ts`,
    source: 'import * as engine from "@qntx/wallet-engine";\nexport const x = engine;\n',
    kind: "forbidden",
  },

  // Case 7: inline type modifiers mark the edge typeOnly; the enclave-closure
  // walk skips typeOnly edges, but verbatimModuleSyntax emits a side-effect
  // import — whether it survives bundling is proven separately.
  {
    id: "7a",
    desc: 'protocol/index.ts += import "./payload.ts"; payload: import { type X } from "../wallet.ts"',
    append: [{ path: PROTOCOL_INDEX, lines: 'import "./__r4_probe_typeimp.ts";\n' }],
    file: `${PROTOCOL}/__r4_probe_typeimp.ts`,
    source:
      'import { type ConnectOptions } from "../wallet.ts";\nexport type { ConnectOptions };\n',
    kind: "forbidden",
  },
  {
    id: "7b",
    desc: 'control — same reach; payload: import * as w from "../wallet.ts" (value edge)',
    append: [{ path: PROTOCOL_INDEX, lines: 'import "./__r4_probe_valimp.ts";\n' }],
    file: `${PROTOCOL}/__r4_probe_valimp.ts`,
    source: 'import * as w from "../wallet.ts";\nexport const x = w;\n',
    kind: "forbidden",
  },
  {
    id: "7c",
    desc: 'protocol/index.ts += export { x } from "./payload.ts"; payload: export { type X } from "../wallet.ts"',
    append: [{ path: PROTOCOL_INDEX, lines: 'export { y } from "./__r4_probe_typeexp.ts";\n' }],
    file: `${PROTOCOL}/__r4_probe_typeexp.ts`,
    source:
      'export { type ConnectOptions as y } from "../wallet.ts";\nexport type { ConnectOptions };\n',
    kind: "forbidden",
  },

  // Case 8: the inner edge of a re-export chain through an allowed package is
  // still judged — chains-leaf flags it on the re-exporting file.
  {
    id: "8",
    desc: "chains file re-exports engine index (chains-leaf should flag it)",
    file: "packages/wallet-chains/src/__r4_probe_reexport.ts",
    source: 'export * from "../../wallet-engine/src/index.ts";\n',
    kind: "forbidden",
  },

  // Case 10: symlinks. The checker resolves the link PATH, not the realpath.
  // A file symlink to a self-contained chains marker is judged as engine src;
  // a dir symlink lets `import "./dir/sign.ts"` reach sign.ts under an engine
  // path the CHAIN_SIGNER regex does not match.
  {
    id: "10a",
    desc: "engine file imports ./link.ts which is a symlink to chains src",
    extra: [
      { path: CHAINS_MARKER, source: MARKER_SOURCE },
      {
        path: `${ENGINE}/__r4_probe_link.ts`,
        link: "../../wallet-chains/src/__r4_marker.ts",
      },
    ],
    file: `${ENGINE}/__r4_probe_use_link.ts`,
    source: 'import { R4_MARKER } from "./__r4_probe_link.ts";\nexport const m = R4_MARKER;\n',
    kind: "forbidden",
  },
  {
    id: "10b",
    desc: "engine file imports ./dir/sign.ts through a dir symlink into chains",
    extra: [{ path: `${ENGINE}/__r4_probe_dir`, link: "../../wallet-chains/src/evm" }],
    file: `${ENGINE}/__r4_probe_use_dir.ts`,
    source: 'import * as s from "./__r4_probe_dir/sign.ts";\nexport const x = typeof s;\n',
    kind: "forbidden",
  },
  {
    id: "10c",
    desc: "kernel file imports ./link.ts symlinked to engine src",
    extra: [
      { path: ENGINE_MARKER, source: MARKER_SOURCE },
      { path: `${KERNEL}/__r4_probe_link.ts`, link: "../../wallet-engine/src/__r4_marker.ts" },
    ],
    file: `${KERNEL}/__r4_probe_use_link.ts`,
    source: 'import { R4_MARKER } from "./__r4_probe_link.ts";\nexport const m = R4_MARKER;\n',
    kind: "forbidden",
  },

  // Other spellings the module record never produces.
  {
    id: "15a",
    desc: "import.meta.glob of all chains sign.ts in engine src",
    file: `${ENGINE}/__r4_probe_glob.ts`,
    source: [
      "declare global {",
      "  interface ImportMeta {",
      "    glob(pattern: string): Record<string, () => Promise<unknown>>;",
      "  }",
      "}",
      'export const m = import.meta.glob("../../wallet-chains/src/*/sign.ts");',
      "",
    ].join("\n"),
    kind: "forbidden",
  },
  {
    id: "15b",
    desc: "absolute-path import of the chain signer in engine src",
    file: `${ENGINE}/__r4_probe_abspath.ts`,
    source: `import * as s from "${join(ROOT, "packages/wallet-chains/src/evm/sign.ts")}";\nexport const x = typeof s;\n`,
    kind: "forbidden",
  },
  {
    id: "15c",
    desc: "control — .mts file IS walked (importing the signer must flag)",
    file: `${ENGINE}/__r4_probe_mts.mts`,
    source: `import * as s from "${SIGNER}";\nexport const x = typeof s;\n`,
    kind: "forbidden",
  },
  {
    id: "15d",
    desc: "json import with attributes — legitimate, must stay clean",
    extra: [{ path: `${ENGINE}/__r4_probe_data.json`, source: '{ "r4": true }\n' }],
    file: `${ENGINE}/__r4_probe_json.ts`,
    source:
      'import data from "./__r4_probe_data.json" with { type: "json" };\nexport const x = data;\n',
    kind: "legitimate",
  },
];

// Case 13: one probe file per ambient global, inside the enclave zone. The
// allow-list admits ES built-ins plus TextEncoder/TextDecoder/crypto; anything
// else must draw a no-undef (typeof:true) or no-restricted-globals diagnostic.
const GLOBAL_PROBES: ReadonlyArray<readonly [string, string]> = [
  ["eval", 'eval("1")'],
  ["indirect_eval", '(0, eval)("1")'],
  ["Function", 'Function("return 1")()'],
  ["new_Function", 'new Function("return 1")()'],
  ["ctor_ctor", '({}).constructor.constructor("return 1")()'],
  ["self", "typeof self"],
  ["window", "typeof window"],
  ["global", "typeof global"],
  ["globalThis", "typeof globalThis"],
  ["globalThis_prop", "globalThis.fetch"],
  ["WebAssembly", "typeof WebAssembly"],
  ["SharedArrayBuffer", "typeof SharedArrayBuffer"],
  ["Atomics", "typeof Atomics"],
  ["WeakRef", "typeof WeakRef"],
  ["FinalizationRegistry", "typeof FinalizationRegistry"],
  ["queueMicrotask", "typeof queueMicrotask"],
  ["structuredClone", "typeof structuredClone"],
  ["setTimeout", "typeof setTimeout"],
  ["escape", "typeof escape"],
  ["unescape", "typeof unescape"],
  ["atob", "typeof atob"],
  ["URL", "typeof URL"],
  ["console", "typeof console"],
  ["fetch", "typeof fetch"],
  ["Proxy", "typeof Proxy"],
  ["Reflect_get", 'Reflect.get(Reflect, "x")'],
  ["import_meta", "import.meta.url"],
  ["top_this", "this"],
  // Controls: allowed names must stay clean.
  ["TextEncoder", "typeof TextEncoder"],
  ["Promise", "typeof Promise"],
];

const globalProbes: Probe[] = GLOBAL_PROBES.map(([name, expr]) => ({
  id: `13-${name}`,
  desc: `enclave global: ${expr}`,
  file: `${KERNEL}/session/__r4_probe_g_${name}.ts`,
  source: `export const x = ${expr};\n`,
  kind: "global",
}));

const ALL_PROBES = [...PROBES, ...globalProbes];

const created: string[] = [];
const createdDirs: string[] = [];
const appended: Array<{ path: string; original: string }> = [];
const cleanup = (): void => {
  for (const { path, original } of appended) {
    writeFileSync(path, original);
  }
  for (const path of created.toReversed()) {
    rmSync(path, { force: true, recursive: true });
  }
  for (const dir of createdDirs.toReversed()) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      // not empty — a real file lives there, leave it
    }
  }
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

const ensureDir = (dir: string): void => {
  if (!existsSync(dir)) {
    ensureDir(dirname(dir));
    mkdirSync(dir);
    createdDirs.push(dir);
  }
};

const writeExtra = (extra: Extra): void => {
  const absolute = join(ROOT, extra.path);
  ensureDir(dirname(absolute));
  if (extra.link === undefined) {
    writeFileSync(absolute, extra.source ?? "");
  } else {
    symlinkSync(extra.link, absolute);
  }
  created.push(absolute);
};

type LintReport = {
  diagnostics: Array<{ filename: string; code: string; severity?: string }>;
};
const isLintReport = (value: unknown): value is LintReport =>
  typeof value === "object" &&
  value !== null &&
  "diagnostics" in value &&
  Array.isArray(value.diagnostics) &&
  value.diagnostics.every(
    (d: unknown) => typeof d === "object" && d !== null && "filename" in d && "code" in d,
  );

// Lint codes that name an ambient-global boundary rather than an incidental
// style complaint on the probe's own spelling.
const GLOBAL_CODES = /no-undef|no-restricted-globals/;
const BOUNDARYISH_LINT =
  /no-undef|no-restricted-globals|no-eval|no-new-func|no-implied-eval|no-commonjs|no-absolute-path/;

try {
  const written = new Set<string>();
  for (const probe of ALL_PROBES) {
    for (const extra of probe.extra ?? []) {
      if (!written.has(extra.path)) {
        writeExtra(extra);
        written.add(extra.path);
      }
    }
    for (const edit of probe.append ?? []) {
      const absolute = join(ROOT, edit.path);
      if (!appended.some((a) => a.path === absolute)) {
        appended.push({ path: absolute, original: readFileSync(absolute, "utf8") });
      }
      writeFileSync(absolute, `${readFileSync(absolute, "utf8")}${edit.lines}`);
    }
    const file = join(ROOT, probe.file);
    if (!existsSync(dirname(file))) {
      console.log(`SKIP ${probe.id}  ${probe.file}  directory does not exist`);
      continue;
    }
    ensureDir(dirname(file));
    writeFileSync(file, probe.source);
    created.push(file);
  }

  const lintFiles = created.filter(
    (p) => /\.(?:ts|mts|cts|js)$/.test(p) && !p.endsWith(".d.ts") && !p.endsWith(".json"),
  );
  const lintRun = Bun.spawnSync({
    cmd: [join(ROOT, "node_modules", ".bin", "vp"), "lint", ...lintFiles, "-f", "json"],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  let report: LintReport = { diagnostics: [] };
  try {
    const parsed: unknown = JSON.parse(lintRun.stdout.toString());
    if (isLintReport(parsed)) {
      report = parsed;
    }
  } catch {
    console.log(
      `(vp lint -f json unparsable, exit ${lintRun.exitCode})\n${lintRun.stdout.toString()}\n${lintRun.stderr.toString()}`,
    );
  }
  const lintByFile = new Map<string, string[]>();
  const lintGlobalByFile = new Map<string, string[]>();
  for (const d of report.diagnostics) {
    const file = rel(d.filename);
    const code = `${d.code}${d.severity !== undefined && d.severity !== "error" ? `(${d.severity})` : ""}`;
    const known = lintByFile.get(file) ?? [];
    lintByFile.set(file, [...known, code]);
    if (GLOBAL_CODES.test(d.code)) {
      const knownGlobal = lintGlobalByFile.get(file) ?? [];
      lintGlobalByFile.set(file, [...knownGlobal, code]);
    }
  }

  const violations = await boundaryViolations(ROOT);
  const byFrom = new Map<string, string[]>();
  for (const v of violations) {
    const known = byFrom.get(v.edge.from) ?? [];
    byFrom.set(v.edge.from, [...known, `${v.rule}@${v.edge.line}`]);
  }

  console.log(`${"CASE".padEnd(22)} ${"DESC".padEnd(72)}`);
  for (const probe of ALL_PROBES) {
    const boundary = byFrom.get(probe.file) ?? [];
    const lint = lintByFile.get(probe.file) ?? [];
    const lintGlobal = lintGlobalByFile.get(probe.file) ?? [];
    const boundaryishLint = lint.filter((c) => BOUNDARYISH_LINT.test(c));
    const extrasFlagged = (probe.extra ?? []).flatMap((e) => {
      if (e.link !== undefined) {
        return [];
      }
      const name = e.path.split("/").pop() ?? e.path;
      const flagged: string[] = (byFrom.get(e.path) ?? []).map((v) => `${name}!${v}`);
      for (const c of lintByFile.get(e.path) ?? []) {
        if (BOUNDARYISH_LINT.test(c)) {
          flagged.push(`${name}!${c}`);
        }
      }
      return flagged;
    });
    let verdict: string;
    if (probe.kind === "global") {
      verdict =
        lint.length === 0
          ? "ALLOWED — enclave allow-list permits it"
          : lintGlobal.length > 0
            ? "BLOCKED (allow-list: no-undef/no-restricted-globals)"
            : "allowed by allow-list; other rules fire";
    } else if (probe.kind === "forbidden") {
      verdict =
        boundary.length > 0
          ? "CAUGHT by boundary checker"
          : boundaryishLint.length > 0 || extrasFlagged.length > 0
            ? "MISSED by checker; boundary-ish lint fires"
            : lint.length > 0
              ? "MISSED by checker; only style lint fires"
              : "MISSED entirely";
    } else {
      verdict = boundary.length > 0 ? "FALSE-POS (boundary flags a clean spelling)" : "clean";
    }
    console.log(`${probe.id.padEnd(22)} ${probe.desc.padEnd(72)}`);
    console.log(
      `${"".padEnd(22)} BND: ${boundary.join(", ") || "-"}   LINT: ${lint.join(", ") || "-"}   => ${verdict}`,
    );
    if (extrasFlagged.length > 0) {
      console.log(`${"".padEnd(22)} helpers: ${extrasFlagged.join(", ")}`);
    }
  }

  const probeFiles = new Set([
    ...ALL_PROBES.map((p) => p.file),
    ...ALL_PROBES.flatMap((p) => (p.extra ?? []).map((e) => e.path)),
  ]);
  const collateral = violations.filter((v) => !probeFiles.has(v.edge.from));
  if (collateral.length > 0) {
    console.log("\nfindings on non-probe files:");
    for (const v of collateral) {
      console.log(`  ${v.edge.from}:${v.edge.line} ${v.rule} "${v.edge.specifier}"`);
    }
  }
} finally {
  cleanup();
}
