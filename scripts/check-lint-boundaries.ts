// Probes the boundaries end to end so they cannot silently rot: writes one
// throw-away file per expected ban — plus controls that must stay clean — into
// the real source trees, runs the import checker (check-boundaries.ts) and the
// repo lint on them, and fails unless every violation produced a boundary
// finding and every control produced none. Import probes spell the same target
// every way a specifier can (package name, `./`, `..`, a path into another
// package). The expectations below are written from AGENTS.md, independently of
// the rule tables in check-boundaries.ts and vite.config.ts: that is what makes
// this an oracle rather than a restatement of the config.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boundaryViolations } from "./check-boundaries.ts";

// The repo does not depend on @types/bun; declare the used surface.
declare const Bun: {
  spawnSync: (options: { cmd: string[]; cwd?: string; stdout: "pipe"; stderr: "pipe" }) => {
    exitCode: number;
    stdout: { toString: () => string };
    stderr: { toString: () => string };
  };
};

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KERNEL = "packages/wallet-kernel/src";
const KERNEL_LAYERS = ["secret", "seed", "derive", "vault", "session", "commands", "modules"].map(
  (layer) => `${KERNEL}/${layer}`,
);

type Probe = {
  /** Repo-relative path of the throw-away probe file. */
  readonly file: string;
  readonly source: string;
  /**
   * `imports`: the import checker reports at least `min` boundary violations (an unresolvable
   * import counts only where `unresolved` says so — elsewhere it fails the probe); `globals`: a
   * no-restricted-globals or no-undef lint diagnostic fires at least `min` times. "clean" for
   * controls that must produce neither, "ignored" for a helper that only sets up another probe.
   */
  readonly expect:
    | {
        readonly rule: "imports" | "globals";
        readonly min: number;
        readonly unresolved?: boolean;
      }
    | "clean"
    | "ignored";
};

// A probe body that stays clean for every rule except the one under test:
// `typeof` uses the import without re-exporting it, so only a boundary ban can
// fire.
const importing = (...specifiers: string[]): string => {
  const imports = specifiers
    .map((specifier, index) => `import * as s${index} from "${specifier}";`)
    .join("\n");
  const uses = specifiers.map((_, index) => `typeof s${index}`).join(", ");
  return `${imports}\n\nexport const x = [${uses}];\n`;
};

const using = (name: string): string => `export const x = typeof ${name};\n`;

type LintReport = {
  diagnostics: Array<{ filename: string; code: string }>;
};

const isLintReport = (value: unknown): value is LintReport =>
  typeof value === "object" &&
  value !== null &&
  "diagnostics" in value &&
  Array.isArray(value.diagnostics) &&
  value.diagnostics.every(
    (diagnostic: unknown) =>
      typeof diagnostic === "object" &&
      diagnostic !== null &&
      "filename" in diagnostic &&
      typeof diagnostic.filename === "string" &&
      "code" in diagnostic &&
      typeof diagnostic.code === "string",
  );

const fires = (min = 1): Probe["expect"] => ({ rule: "imports", min });
const firesGlobals = (min = 1): Probe["expect"] => ({ rule: "globals", min });

const PROBES: Probe[] = [
  // Chain signing happens inside the kernel only — whatever the spelling, from every library src
  // subtree.
  ...[
    "packages/wallet-engine/src",
    "packages/wallet/src",
    "packages/wallet/src/protocol",
    "packages/wallet/src/nostr",
    "packages/wallet/src/chains",
    "packages/wallet/src/spark",
    "packages/wallet-worker/src/browser",
    "packages/wallet-worker/src/node",
    "packages/wallet-worker/src/worker",
    "packages/wallet-native/src",
    "packages/wallet-chains/src",
    "packages/wallet-native/kernel",
  ].map((dir): Probe => ({
    file: `${dir}/__lint_probe_a__.ts`,
    source: importing("@qntx/wallet-chains/evm/sign"),
    expect: fires(),
  })),
  {
    file: "packages/wallet-engine/src/__lint_probe_a_relative__.ts",
    source: importing(
      "../../wallet-chains/src/evm/sign.ts",
      "./../../wallet-chains/src/solana/sign",
    ),
    expect: fires(2),
  },
  {
    file: `${KERNEL}/modules/__lint_probe_a_control__.ts`,
    source: importing("@qntx/wallet-chains/evm/sign"),
    expect: "clean",
  },

  // @qntx/wallet-kernel is private — nothing in the main runtime imports it, by name or by path.
  ...[
    "packages/wallet/src",
    "packages/wallet/src/chains",
    "packages/wallet-engine/src",
    "packages/wallet-chains/src",
    "packages/wallet-native/src",
    "packages/wallet-worker/src/browser",
  ].map((dir): Probe => ({
    file: `${dir}/__lint_probe_b__.ts`,
    source: importing("@qntx/wallet-kernel"),
    expect: fires(),
  })),
  {
    file: "packages/wallet/src/__lint_probe_b_relative__.ts",
    source: importing("../../wallet-kernel/src/index.ts", "../../wallet-kernel/src/vault/store.ts"),
    expect: fires(2),
  },
  {
    file: "packages/wallet-worker/src/worker/__lint_probe_b_control__.ts",
    source: importing("@qntx/wallet-kernel"),
    expect: "clean",
  },
  {
    file: "packages/wallet-native/kernel/__lint_probe_b_control__.ts",
    source: importing("../../wallet-kernel/src/kernel.ts"),
    expect: "clean",
  },

  // The kernel never imports backends or host packages — they are injected. Must hold at the
  // package root, inside every layer and in the native kernel entry.
  ...[KERNEL, ...KERNEL_LAYERS, "packages/wallet-native/kernel"].map((dir): Probe => ({
    file: `${dir}/__lint_probe_c__.ts`,
    source: importing("@qntx/spark-wasm", "@qntx/nostr-native", "@qntx/wallet-worker/browser"),
    expect: fires(3),
  })),

  // The kernel sees the wallet's wire protocol only, never the host entry or the engine.
  {
    file: `${KERNEL}/commands/__lint_probe_d__.ts`,
    source: importing(
      "@qntx/wallet",
      "../../../wallet/src/wallet.ts",
      "../../../wallet-engine/src/engine.ts",
    ),
    expect: fires(3),
  },
  {
    file: `${KERNEL}/__lint_probe_d_relative__.ts`,
    source: importing("../../wallet/src/wallet.ts"),
    expect: fires(),
  },
  {
    file: `${KERNEL}/commands/__lint_probe_d_control__.ts`,
    source: importing("@qntx/wallet/protocol", "@qntx/wallet/types"),
    expect: "clean",
  },

  // Kernel layering is one-directional: secret is the leaf, session may reach vault — however the
  // path is spelled.
  {
    file: `${KERNEL}/secret/__lint_probe_e__.ts`,
    source: importing("../vault/store.ts", "../index.ts", "../kernel.ts"),
    expect: fires(3),
  },
  {
    file: `${KERNEL}/session/__lint_probe_e_spelled__.ts`,
    source: importing("../vault/../commands/index.ts", "./../commands/index.ts"),
    expect: fires(2),
  },
  {
    file: `${KERNEL}/session/__lint_probe_e_control__.ts`,
    source: importing("../vault/store.ts", "../platform.ts"),
    expect: "clean",
  },

  // The gateway speaks the engine's gateway contract and nothing else.
  {
    file: "apps/gateway/src/__lint_probe_f__.ts",
    source: importing("@qntx/wallet-engine", "../../../packages/wallet-engine/src/engine.ts"),
    expect: fires(2),
  },
  {
    file: "apps/gateway/src/__lint_probe_f_control__.ts",
    source: importing("@qntx/wallet-engine/gateway/contract"),
    expect: "clean",
  },

  // Src stays platform-neutral: no Node builtins outside the Node host entries.
  ...[
    "packages/wallet/src",
    "packages/wallet-engine/src",
    `${KERNEL}/vault`,
    "packages/wallet-worker/src/node",
    "packages/wallet-native/kernel",
  ].map((dir): Probe => ({
    file: `${dir}/__lint_probe_g_nodefs__.ts`,
    source: importing("node:fs"),
    expect: fires(),
  })),
  {
    file: "packages/wallet-worker/src/node/__lint_probe_g_wt__.ts",
    source: importing("node:worker_threads"),
    expect: "clean",
  },
  // Builtin subpaths are banned too — and allowed where the Node host needs fs/promises.
  ...["packages/wallet/src", `${KERNEL}/vault`].map((dir): Probe => ({
    file: `${dir}/__lint_probe_g_fspromises__.ts`,
    source: importing("node:fs/promises", "fs/promises"),
    expect: fires(2),
  })),
  {
    file: "packages/wallet-worker/src/node/__lint_probe_g_fspromises__.ts",
    source: importing("node:fs/promises"),
    expect: "clean",
  },

  // Ambient globals: Node/browser names are banned in library src; enclave code may use only the
  // ES built-ins plus TextEncoder, TextDecoder and crypto — `globalThis.x` included.
  {
    file: "packages/wallet/src/__lint_probe_g_buffer__.ts",
    source: using("Buffer"),
    expect: firesGlobals(),
  },
  {
    file: "packages/wallet/src/__lint_probe_g_window__.ts",
    source: using("window"),
    expect: firesGlobals(),
  },
  {
    file: "packages/wallet-worker/src/browser/__lint_probe_g_window__.ts",
    source: using("window"),
    expect: "clean",
  },
  ...[
    `${KERNEL}/seed`,
    `${KERNEL}/session`,
    KERNEL,
    "packages/wallet-native/kernel",
    "packages/wallet-chains/src",
    "packages/wallet/src/protocol",
  ].map((dir): Probe => ({
    file: `${dir}/__lint_probe_g_enclave__.ts`,
    source: [
      "export const t = typeof setTimeout;",
      "export const f = typeof fetch;",
      "export const g = globalThis.setTimeout;",
      'export const h = globalThis["fetch"];',
      "export const q = typeof queueMicrotask;",
      "export const i = typeof Intl;",
      "export const c = typeof console;",
      "",
    ].join("\n"),
    expect: firesGlobals(7),
  })),
  {
    file: `${KERNEL}/session/__lint_probe_g_enclave_control__.ts`,
    source: [
      "export const e = new TextEncoder();",
      "export const d = new TextDecoder();",
      "export const r = crypto.getRandomValues(new Uint8Array(1));",
      "export const p = Promise.resolve(BigInt(1));",
      "",
    ].join("\n"),
    expect: "clean",
  },

  // The signer surface is the kernel's: the engine never loads it.
  {
    file: "packages/wallet-engine/src/__lint_probe_h__.ts",
    source: importing("@qntx/spark/signer"),
    expect: fires(),
  },

  // Fiat prices are display-only: no engine code that builds, approves or signs reads them —
  // only the composition root at src/ may reach prices/, directly or through a root file.
  ...[
    "transactions",
    "requests",
    "connect",
    "chains",
    "swaps",
    "payments",
    "spark",
    "lido",
    "staking",
    "assets",
    "apps",
  ].map((dir): Probe => ({
    file: `packages/wallet-engine/src/${dir}/__lint_probe_i__.ts`,
    source: importing("../prices/controller.ts", "../prices/valuation.ts"),
    expect: fires(2),
  })),
  {
    file: "packages/wallet-engine/src/connect/inject/__lint_probe_i__.ts",
    source: importing("../../prices/controller.ts"),
    expect: fires(),
  },
  {
    file: "packages/wallet-engine/src/transactions/__lint_probe_i_spelled__.ts",
    source: importing(
      "./../prices/controller.ts",
      "../index.ts",
      "../engine.ts",
      "@qntx/wallet-engine",
    ),
    expect: fires(4),
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_i_control__.ts",
    source: importing("./prices/controller.ts"),
    expect: "clean",
  },

  // @qntx/nostr stays in the nostr modules, and they never take its transport parts.
  {
    file: "packages/wallet/src/__lint_probe_j__.ts",
    source: importing("@qntx/nostr", "./nostr/index.ts"),
    expect: fires(2),
  },
  {
    file: "packages/wallet/src/protocol/__lint_probe_j__.ts",
    source: importing("@qntx/nostr/nips/nip59", "../nostr/index.ts"),
    expect: fires(2),
  },
  {
    file: "packages/wallet/src/nostr/__lint_probe_j__.ts",
    source: importing("@qntx/nostr/client"),
    expect: fires(),
  },
  {
    file: `${KERNEL}/commands/__lint_probe_j__.ts`,
    source: importing("@qntx/nostr"),
    expect: fires(),
  },
  {
    file: `${KERNEL}/modules/nostr/__lint_probe_j__.ts`,
    source: importing("@qntx/nostr/relay"),
    expect: fires(),
  },
  {
    file: `${KERNEL}/modules/nostr/__lint_probe_j_control__.ts`,
    source: importing("@qntx/nostr"),
    expect: "clean",
  },

  // @qntx/wallet-chains is the leaf; and no package reaches into another's src by path.
  {
    file: "packages/wallet-chains/src/__lint_probe_k__.ts",
    source: importing("@qntx/wallet-engine", "../../wallet/src/protocol/index.ts"),
    expect: fires(2),
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_k_relative__.ts",
    source: importing("../../wallet-chains/src/evm/index.ts"),
    expect: fires(),
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_k_control__.ts",
    source: importing("@qntx/wallet-chains/evm"),
    expect: "clean",
  },

  // An import the checker cannot resolve fails closed.
  {
    file: "packages/wallet-engine/src/__lint_probe_l__.ts",
    source:
      'const name = "x";\nexport const m = import(name);\nexport { y } from "./__missing__.ts";\n',
    expect: { rule: "imports", min: 2, unresolved: true },
  },

  // The kernel bundle's import closure stays inside the enclave globals zone: a file the kernel
  // pulls in may not pull host code in after it.
  {
    file: `${KERNEL}/commands/__lint_probe_m_root__.ts`,
    source: importing("../../../wallet/src/protocol/__lint_probe_m__.ts"),
    expect: "ignored",
  },
  {
    file: "packages/wallet/src/protocol/__lint_probe_m__.ts",
    source: importing("../wallet.ts"),
    expect: fires(),
  },
];

const created: string[] = [];
const cleanup = (): void => {
  for (const file of created) {
    rmSync(file, { force: true });
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

const rows: Array<{ file: string; ok: boolean; detail: string }> = [];
try {
  const written: Probe[] = [];
  for (const probe of PROBES) {
    const file = join(ROOT, probe.file);
    if (!existsSync(dirname(file))) {
      rows.push({ file: probe.file, ok: false, detail: "probe directory does not exist" });
      continue;
    }
    writeFileSync(file, probe.source);
    created.push(file);
    written.push(probe);
  }

  const result = Bun.spawnSync({
    cmd: [
      join(ROOT, "node_modules", ".bin", "vp"),
      "lint",
      ...written.map((p) => p.file),
      "-f",
      "json",
    ],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();

  let report: LintReport;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isLintReport(parsed)) {
      throw new Error("unexpected shape");
    }
    report = parsed;
  } catch {
    throw new Error(
      `could not parse \`vp lint -f json\` output (exit ${result.exitCode}):\n${stdout}\n${result.stderr.toString()}`,
    );
  }

  const counts = new Map<string, { imports: number; unresolved: number; globals: number }>();
  const entry = (file: string) => {
    const known = counts.get(file) ?? { imports: 0, unresolved: 0, globals: 0 };
    counts.set(file, known);
    return known;
  };
  for (const diagnostic of report.diagnostics) {
    const file = diagnostic.filename.replaceAll("\\", "/");
    if (diagnostic.code.includes("no-restricted-globals") || diagnostic.code.includes("no-undef")) {
      entry(file).globals += 1;
    }
  }
  for (const violation of await boundaryViolations(ROOT)) {
    if (violation.rule === "resolvable") {
      entry(violation.edge.from).unresolved += 1;
    } else {
      entry(violation.edge.from).imports += 1;
    }
  }

  for (const probe of written) {
    const count = counts.get(probe.file) ?? { imports: 0, unresolved: 0, globals: 0 };
    if (probe.expect === "ignored") {
      continue;
    }
    if (probe.expect === "clean") {
      const total = count.imports + count.unresolved + count.globals;
      rows.push({
        file: probe.file,
        ok: total === 0,
        detail: `boundary findings ${total}x (control: want 0)`,
      });
    } else if (probe.expect.rule === "imports") {
      const fired = count.imports + (probe.expect.unresolved === true ? count.unresolved : 0);
      const stray = probe.expect.unresolved === true ? 0 : count.unresolved;
      rows.push({
        file: probe.file,
        ok: fired >= probe.expect.min && stray === 0,
        detail: `import boundaries fired ${fired}x (want >= ${probe.expect.min}), unresolvable ${stray}x (want 0)`,
      });
    } else {
      rows.push({
        file: probe.file,
        ok: count.globals >= probe.expect.min,
        detail: `global boundaries fired ${count.globals}x (want >= ${probe.expect.min})`,
      });
    }
  }
} finally {
  cleanup();
}

let failures = 0;
for (const row of rows) {
  if (!row.ok) {
    failures += 1;
  }
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.file}  ${row.detail}`);
}
console.log(`\n${rows.length - failures}/${rows.length} probes as expected`);
if (failures > 0) {
  process.exitCode = 1;
}
