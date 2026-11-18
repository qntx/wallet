// Probes the lint boundaries end to end so they cannot silently rot: writes
// one throw-away file per expected ban — plus controls that must stay clean —
// into the real source trees, runs the repo lint on exactly those files, and
// fails unless every violation produced a no-restricted-* diagnostic and every
// control produced none. The expectations below are written from AGENTS.md,
// independently of the zone table in vite.config.ts: that is what makes this an
// oracle rather than a restatement of the config.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
   * A no-restricted-* diagnostic must fire at least `min` times, or "clean" for controls that must
   * produce no no-restricted-* diagnostic at all.
   */
  readonly expect: { readonly rule: "imports" | "globals"; readonly min: number } | "clean";
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
  // Chain signing happens inside the kernel only — the @qntx/wallet-chains/*/sign
  // ban must reach every library src subtree, not just the ones without their
  // own import overrides.
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
  ].map((dir): Probe => ({
    file: `${dir}/__lint_probe_a__.ts`,
    source: importing("@qntx/wallet-chains/evm/sign"),
    expect: fires(),
  })),
  {
    file: `${KERNEL}/modules/__lint_probe_a_control__.ts`,
    source: importing("@qntx/wallet-chains/evm/sign"),
    expect: "clean",
  },

  // @qntx/wallet-kernel is private — nothing in the main runtime imports it.
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

  // The kernel never imports backends or host packages — they are injected.
  // Must hold at the package root and inside every layer.
  ...[KERNEL, ...KERNEL_LAYERS].map((dir): Probe => ({
    file: `${dir}/__lint_probe_c__.ts`,
    source: importing("@qntx/spark-wasm", "@qntx/nostr-native", "@qntx/wallet-worker/browser"),
    expect: fires(3),
  })),

  // The kernel sees the wallet's wire protocol only, never the host entry.
  {
    file: `${KERNEL}/commands/__lint_probe_d__.ts`,
    source: importing("@qntx/wallet"),
    expect: fires(),
  },
  {
    file: `${KERNEL}/commands/__lint_probe_d_control__.ts`,
    source: importing("@qntx/wallet/protocol"),
    expect: "clean",
  },

  // Kernel layering is one-directional: secret is the leaf, session may reach
  // vault.
  {
    file: `${KERNEL}/secret/__lint_probe_e__.ts`,
    source: importing("../vault"),
    expect: fires(),
  },
  {
    file: `${KERNEL}/session/__lint_probe_e_control__.ts`,
    source: importing("../vault"),
    expect: "clean",
  },

  // The gateway speaks the engine's gateway contract and nothing else.
  {
    file: "apps/gateway/src/__lint_probe_f__.ts",
    source: importing("@qntx/wallet-engine"),
    expect: fires(),
  },
  {
    file: "apps/gateway/src/__lint_probe_f_control__.ts",
    source: importing("@qntx/wallet-engine/gateway/contract"),
    expect: "clean",
  },

  // Src stays platform-neutral: no Node builtins or Node/browser ambient
  // globals outside the host entries, no ambient timers inside the kernel.
  ...[
    "packages/wallet/src",
    "packages/wallet-engine/src",
    `${KERNEL}/vault`,
    "packages/wallet-worker/src/node",
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
  // Builtin subpaths are banned too — and allowed where the Node host needs
  // fs/promises.
  ...["packages/wallet/src", `${KERNEL}/vault`].map((dir): Probe => ({
    file: `${dir}/__lint_probe_g_fspromises__.ts`,
    source: importing("node:fs/promises"),
    expect: fires(),
  })),
  {
    file: "packages/wallet-worker/src/node/__lint_probe_g_fspromises__.ts",
    source: importing("node:fs/promises"),
    expect: "clean",
  },
  {
    file: "packages/wallet/src/__lint_probe_g_buffer__.ts",
    source: using("Buffer"),
    expect: firesGlobals(),
  },
  {
    file: `${KERNEL}/seed/__lint_probe_g_timeout__.ts`,
    source: using("setTimeout"),
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

  // The signer surface is types-only at the protocol layer — a value import
  // from it must not compile in the engine.
  {
    file: "packages/wallet-engine/src/__lint_probe_h__.ts",
    source: importing("@qntx/spark/signer"),
    expect: fires(),
  },

  // Fiat prices are display-only: no engine code that builds, approves or
  // signs reads them — only the composition root at src/ may import prices/.
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
    file: "packages/wallet-engine/src/__lint_probe_i_control__.ts",
    source: importing("./prices/controller.ts"),
    expect: "clean",
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

  const counts = new Map<string, { imports: number; globals: number }>();
  for (const diagnostic of report.diagnostics) {
    const file = diagnostic.filename.replaceAll("\\", "/");
    const entry = counts.get(file) ?? { imports: 0, globals: 0 };
    if (diagnostic.code.includes("no-restricted-imports")) {
      entry.imports += 1;
    } else if (diagnostic.code.includes("no-restricted-globals")) {
      entry.globals += 1;
    }
    counts.set(file, entry);
  }

  for (const probe of written) {
    const count = counts.get(probe.file) ?? { imports: 0, globals: 0 };
    if (probe.expect === "clean") {
      const total = count.imports + count.globals;
      rows.push({
        file: probe.file,
        ok: total === 0,
        detail: `no-restricted-* fired ${total}x (control: want 0)`,
      });
    } else {
      const fired = probe.expect.rule === "imports" ? count.imports : count.globals;
      rows.push({
        file: probe.file,
        ok: fired >= probe.expect.min,
        detail: `no-restricted-${probe.expect.rule} fired ${fired}x (want >= ${probe.expect.min})`,
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
