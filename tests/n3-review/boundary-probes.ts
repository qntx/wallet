/**
 * Boundary-bypass probes: each probe writes a throwaway file (plus helper files, symlinks,
 * node_modules artifacts or temporary committed-file edits), then every layer is measured — source
 * checker (check-boundaries.ts), bundle checker (check-bundles.ts with the probe as an extra
 * entry), repo lint (boundary/globals diagnostics only) and, for LAND probes, the real build
 * artifact is grepped for the probe's marker. Committed files are restored byte-for-byte from
 * in-memory copies; everything created is deleted afterwards.
 *
 * Bun tests/n3-review/boundary-probes.ts > <evidence>/boundary-probes.txt
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { boundaryViolations } from "../../scripts/check-boundaries.ts";
import { bundleViolations } from "../../scripts/check-bundles.ts";
import type { EntryKind } from "../../scripts/check-bundles.ts";

const ROOT = join(import.meta.dirname, "../..");
const KERNEL_ENTRY = "packages/wallet-native/kernel/kernel-entry.ts";
const ENGINE_INDEX = "packages/wallet-engine/src/index.ts";
const KERNEL_MARKER = "packages/wallet-kernel/src/n3probe-marker.ts";
const ENGINE_MARKER = "packages/wallet-engine/src/n3probe-marker.ts";
const KERNEL_ARTIFACT = "packages/wallet-native/kernel/generated/kernel-entry.js";
const ENGINE_DIST = "packages/wallet-engine/dist";
const M = (id: string): string => `N3PROBE_${id}`;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const errorText = (error: unknown, limit = 300): string => {
  const base =
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
      ? error.stderr
      : String(error);
  return base.replaceAll("\n", " ").slice(-limit);
};

const grepCount = (target: string, needle: string): number => {
  try {
    const text = execSync(`grep -rho "${needle}" "${target}" | wc -l`, {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    return Number(text);
  } catch {
    return 0;
  }
};

type Extra = { readonly path: string; readonly source?: string; readonly link?: string };
type Edit = { readonly path: string; readonly search: string; readonly replace: string };

type Probe = {
  readonly id: string;
  /** Probe file in a governed tree (repo-relative). */
  readonly file: string;
  readonly source?: string;
  readonly kind?: EntryKind;
  readonly extra?: ReadonlyArray<Extra>;
  readonly edits?: ReadonlyArray<Edit>;
  /** Other paths whose checker findings belong to this probe. */
  readonly also?: ReadonlyArray<string>;
  readonly land?: "kernel" | "engine";
  /** Grep string proving the forbidden payload landed. */
  readonly marker?: string;
};

const kernelProbe = (id: string, source: string, init: Partial<Probe> = {}): Probe => ({
  id,
  file: `packages/wallet-kernel/src/modules/n3probe-${id.toLowerCase()}.ts`,
  source,
  kind: "enclave",
  ...init,
});
const engineProbe = (id: string, source: string, init: Partial<Probe> = {}): Probe => ({
  id,
  file: `packages/wallet-engine/src/n3probe-${id.toLowerCase()}.ts`,
  source,
  kind: "main",
  ...init,
});
const markerExtra = (path: string, tag: string): Extra => ({
  path,
  source: `export const N3PROBE = "${M(tag)}";\n`,
});

const PROBES: ReadonlyArray<Probe> = [
  kernelProbe(
    "B1",
    'const s = ["@qntx", "wallet-worker"].join("/");\nexport const p = (): Promise<unknown> => import(s);\n',
  ),
  kernelProbe("B2", "export const p = (): Promise<unknown> => import(`@qntx/wallet-engine`);\n"),
  kernelProbe(
    "B3",
    "export const p = new Function(\"return import('@qntx/wallet-engine')\") as () => Promise<unknown>;\n",
  ),
  kernelProbe(
    "B4",
    'const g = globalThis as Record<string, unknown>;\nexport const p = (): unknown =>\n  (g["ev" + "al"] as (code: string) => unknown)("import(\'@qntx/wallet-engine\')");\n',
  ),
  kernelProbe(
    "B5",
    'import { Controller } from "../../../wallet/src/protocol/index.ts";\nexport const x = typeof Controller;\n',
    {
      also: ["packages/wallet/src/protocol/index.ts"],
      edits: [
        {
          path: "packages/wallet/src/protocol/index.ts",
          search: "",
          replace: '\nexport { Controller } from "@qntx/wallet-engine";\n',
        },
      ],
    },
  ),
  kernelProbe("B6", 'import "../../../wallet-chains/src/n3probe-b6.ts";\nexport const x = 1;\n', {
    also: ["packages/wallet-chains/src/n3probe-b6.ts"],
    extra: [
      {
        path: "packages/wallet-chains/src/n3probe-b6.ts",
        source: 'export * from "../../wallet-engine/src/index.ts";\n',
      },
    ],
  }),
  kernelProbe(
    "B7",
    'import * as m from "@qntx/wallet-chains/n3probe";\nexport const keys = Object.keys(m);\n',
    {
      also: ["packages/wallet-chains/src/n3probe-rn.ts"],
      extra: [
        {
          path: "packages/wallet-chains/src/n3probe-rn.ts",
          source: `export { N3PROBE } from "../../wallet-engine/src/n3probe-marker.ts";\nexport const ${M("B7")} = "${M("B7")}";\n`,
        },
        markerExtra(ENGINE_MARKER, "ENGINE"),
      ],
      edits: [
        {
          path: "packages/wallet-chains/package.json",
          search: '"exports": {',
          replace:
            '"exports": {\n    "./n3probe": {\n      "react-native": "./src/n3probe-rn.ts",\n      "browser": "./src/n3probe-rn.ts",\n      "worker": "./src/n3probe-rn.ts",\n      "default": "./src/index.ts"\n    },',
        },
      ],
      land: "kernel",
      marker: M("B7"),
    },
  ),
  kernelProbe(
    "B8",
    'import type { BrowserWorkerInit } from "@qntx/wallet-worker/browser";\nexport type X = BrowserWorkerInit;\n',
  ),
  engineProbe(
    "B9",
    'export const w = (): unknown =>\n  new Worker(new URL("../../wallet-kernel/src/n3probe-marker.ts", import.meta.url), {\n    type: "module",\n  });\n',
    {
      extra: [markerExtra(KERNEL_MARKER, "KERNEL")],
      land: "engine",
      marker: M("KERNEL"),
    },
  ),
  engineProbe(
    "B10",
    'export const href = new URL("../../wallet-kernel/src/n3probe-marker.ts", import.meta.url).href;\n',
    { extra: [markerExtra(KERNEL_MARKER, "KERNEL")] },
  ),
  engineProbe(
    "B11",
    'import W from "../../wallet-kernel/src/n3probe-marker.ts?worker";\nimport WI from "../../wallet-kernel/src/n3probe-marker.ts?worker&inline";\nexport const p = [typeof W, typeof WI];\n',
    {
      extra: [markerExtra(KERNEL_MARKER, "KERNEL")],
      land: "engine",
      marker: M("KERNEL"),
    },
  ),
  engineProbe(
    "B12",
    'import raw from "../../wallet-kernel/src/n3probe-marker.ts?raw";\nexport const t = typeof raw;\n',
    { extra: [markerExtra(KERNEL_MARKER, "KERNEL")] },
  ),
  engineProbe("B13", 'import * as b from "@scure/base";\nexport const keys = Object.keys(b);\n', {
    extra: [markerExtra(KERNEL_MARKER, "KERNEL")],
    land: "engine",
    marker: M("KERNEL"),
  }),
  engineProbe(
    "B14",
    'import * as m from "n3-probe-link/n3probe-marker.ts";\nexport const x = typeof m;\n',
    {
      extra: [
        { path: "node_modules/n3-probe-link", link: "packages/wallet-kernel/src" },
        markerExtra(KERNEL_MARKER, "KERNEL"),
      ],
    },
  ),
  kernelProbe(
    "B15",
    'import { N3PROBE_B15 } from "n3-probe-tramp";\nexport const x = typeof N3PROBE_B15;\n',
    {
      extra: [
        {
          path: "node_modules/n3-probe-tramp/package.json",
          source: '{"name":"n3-probe-tramp","type":"module","exports":"./index.js"}\n',
        },
        {
          path: "node_modules/n3-probe-tramp/index.js",
          // @qntx/wallet-engine is not resolvable from inside node_modules (isolated install), so
          // the trampoline walks out to the workspace source by relative path instead.
          source: `export * from "../../packages/wallet-engine/src/n3probe-marker.ts";\nexport const ${M("B15")} = "${M("B15")}";\n`,
        },
        markerExtra(ENGINE_MARKER, "ENGINE"),
      ],
      land: "kernel",
      marker: M("B15"),
    },
  ),
  kernelProbe("B16", 'import * as viem from "viem";\nexport const all = viem;\n', {
    land: "kernel",
    marker: "viem.sh",
  }),
  kernelProbe("B17", 'export * as e from "@qntx/wallet-engine";\n'),
  kernelProbe("B18", 'export const r = import.meta.resolve("@qntx/wallet-engine");\n'),
  {
    id: "B19",
    file: "packages/wallet-engine/src/gateway/contract/index.ts",
    also: ["apps/gateway/src/index.ts"],
    extra: [markerExtra(ENGINE_MARKER, "ENGINE")],
    edits: [
      {
        path: "packages/wallet-engine/src/gateway/contract/index.ts",
        search: "",
        replace: '\nexport { N3PROBE } from "../../n3probe-marker.ts";\n',
      },
    ],
  },
  kernelProbe(
    "B20",
    'import pkg from "../../../wallet-engine/package.json" with { type: "json" };\nexport const n = pkg.name;\n',
  ),
  kernelProbe(
    "B21",
    'import * as w from "@qntx/wallet-worker/node";\nexport const x = typeof w;\n',
    {
      edits: [
        {
          path: "packages/wallet-kernel/package.json",
          search: '"@metamask/eth-sig-util": "9.0.0",',
          replace: '"@qntx/wallet-worker": "workspace:*",\n    "@metamask/eth-sig-util": "9.0.0",',
        },
      ],
    },
  ),
];

const created: string[] = [];
const createdDirs: string[] = [];
const restored = new Map<string, string>();
const cleanup = (): void => {
  for (const [path, original] of restored) {
    try {
      writeFileSync(path, original);
    } catch {
      /* best effort */
    }
  }
  for (let index = created.length - 1; index >= 0; index -= 1) {
    try {
      rmSync(created[index] ?? "", { force: true, recursive: true });
    } catch {
      /* best effort */
    }
  }
  for (let index = createdDirs.length - 1; index >= 0; index -= 1) {
    const dir = createdDirs[index] ?? "";
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch {
      /* best effort */
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
const keepOriginal = (absolute: string): void => {
  if (!restored.has(absolute)) {
    restored.set(absolute, readFileSync(absolute, "utf8"));
  }
};
/** Revert every committed-file edit, then re-apply only the ones this probe needs for its build. */
const restoreExcept = (probe: Probe): void => {
  for (const [path, original] of restored) {
    writeFileSync(path, original);
  }
  for (const edit of probe.edits ?? []) {
    const absolute = join(ROOT, edit.path);
    const original = restored.get(absolute) ?? readFileSync(absolute, "utf8");
    writeFileSync(absolute, original.replace(edit.search, edit.replace));
  }
};
const put = (map: Map<string, string[]>, key: string, value: string): void => {
  map.set(key, [...(map.get(key) ?? []), value]);
};
const uniqRules = (findings: ReadonlyArray<string>): string =>
  [...new Set(findings.map((finding) => finding.split(":")[0]))].join(",") || "clean";

type LintDiagnostic = { filename: string; code: string };
const isDiagnostic = (value: unknown): value is LintDiagnostic =>
  typeof value === "object" &&
  value !== null &&
  "filename" in value &&
  typeof value.filename === "string" &&
  "code" in value &&
  typeof value.code === "string";

const rowFor = new Map<string, { src: string; bundle: string; lint: string; land: string }>();
for (const probe of PROBES) {
  rowFor.set(probe.id, { src: "-", bundle: "-", lint: "-", land: "-" });
}

try {
  for (const probe of PROBES) {
    for (const extra of probe.extra ?? []) {
      const absolute = join(ROOT, extra.path);
      ensureDir(dirname(absolute));
      if (extra.link === undefined) {
        writeFileSync(absolute, extra.source ?? "");
      } else {
        symlinkSync(join(ROOT, extra.link), absolute);
      }
      created.push(absolute);
    }
    for (const edit of probe.edits ?? []) {
      const absolute = join(ROOT, edit.path);
      keepOriginal(absolute);
      const current = readFileSync(absolute, "utf8");
      if (edit.search !== "" && !current.includes(edit.search)) {
        out(`EDIT-ANCHOR-MISSING ${probe.id} in ${edit.path}`);
        continue;
      }
      writeFileSync(absolute, current.replace(edit.search, edit.replace), "utf8");
    }
    if (probe.source !== undefined) {
      const file = join(ROOT, probe.file);
      ensureDir(dirname(file));
      writeFileSync(file, probe.source);
      created.push(file);
    }
  }

  const srcBy = new Map<string, string[]>();
  for (const violation of await boundaryViolations(ROOT)) {
    put(srcBy, violation.edge.from, `${violation.rule}:${violation.edge.specifier}`);
  }

  const extraEntries = PROBES.filter(
    (probe): probe is Probe & { kind: EntryKind } => probe.kind !== undefined,
  ).map((probe) => ({ file: probe.file, kind: probe.kind }));
  const bundleBy = new Map<string, string[]>();
  for (const violation of await bundleViolations(ROOT, { extraEntries })) {
    put(bundleBy, violation.entry, `${violation.rule}:${violation.module}`);
  }

  const lintBy = new Map<string, string[]>();
  try {
    // `vp lint` exits non-zero when it finds diagnostics; the JSON report is still on stdout.
    let stdout = "";
    try {
      stdout = execFileSync(
        join(ROOT, "node_modules", ".bin", "vp"),
        ["lint", ...PROBES.filter((p) => p.source !== undefined).map((p) => p.file), "-f", "json"],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (error) {
      stdout =
        typeof error === "object" &&
        error !== null &&
        "stdout" in error &&
        typeof error.stdout === "string"
          ? error.stdout
          : "";
    }
    const parsed: unknown = JSON.parse(stdout);
    const diagnostics =
      typeof parsed === "object" &&
      parsed !== null &&
      "diagnostics" in parsed &&
      Array.isArray(parsed.diagnostics)
        ? parsed.diagnostics.filter(isDiagnostic)
        : [];
    for (const diagnostic of diagnostics) {
      if (/boundar|restricted|undef|globals|import/.test(diagnostic.code)) {
        put(lintBy, diagnostic.filename.replaceAll("\\", "/"), diagnostic.code);
      }
    }
  } catch (error) {
    out(`lint-run: ${errorText(error, 200)}`);
  }

  for (const probe of PROBES) {
    const row = rowFor.get(probe.id);
    if (row === undefined) {
      continue;
    }
    const srcFindings = [
      probe.file,
      ...(probe.also ?? []),
      ...(probe.extra?.map((extra) => extra.path) ?? []),
    ].flatMap((path) => srcBy.get(path) ?? []);
    row.src = `${String(srcFindings.length)} [${uniqRules(srcFindings)}]`;
    const bundleFindings = [
      ...(probe.kind === undefined ? [] : (bundleBy.get(probe.file) ?? [])),
      ...(probe.id === "B19" ? (bundleBy.get("apps/gateway/src/index.ts") ?? []) : []),
    ];
    row.bundle = `${String(bundleFindings.length)} [${uniqRules(bundleFindings)}]`;
    const lintFindings = lintBy.get(probe.file) ?? [];
    row.lint = `${String(lintFindings.length)} [${[...new Set(lintFindings)].join(",") || "-"}]`;
  }

  const LAND_ORDER = ["B15", "B16", "B7", "B9", "B11", "B13"];
  const landProbes = LAND_ORDER.map((id) => PROBES.find((probe) => probe.id === id)).filter(
    (probe): probe is Probe => probe !== undefined && probe.land !== undefined,
  );
  for (const probe of landProbes) {
    const row = rowFor.get(probe.id);
    if (row === undefined || probe.land === undefined) {
      continue;
    }
    if (probe.land === "kernel") {
      out(`LAND kernel: ${probe.id} via kernel-entry.ts…`);
      restoreExcept(probe);
      keepOriginal(join(ROOT, KERNEL_ENTRY));
      try {
        // A bare side-effect import is tree-shaken out of the IIFE; a globalThis
        // assignment forces the whole probe module graph into the artifact.
        writeFileSync(
          join(ROOT, KERNEL_ENTRY),
          `${readFileSync(join(ROOT, KERNEL_ENTRY), "utf8")}\nimport * as n3probe${probe.id} from "../../wallet-kernel/src/modules/n3probe-${probe.id.toLowerCase()}.ts";\nglobalThis.__n3probe${probe.id} = n3probe${probe.id};\n`,
        );
        const tail = execSync("bun scripts/build-kernel.ts", {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 900_000,
          maxBuffer: 128 * 1024 * 1024,
        });
        out(tail.split("\n").slice(-4).join("\n"));
        const hits =
          probe.marker === undefined ? 0 : grepCount(join(ROOT, KERNEL_ARTIFACT), probe.marker);
        row.land = hits > 0 ? `LANDED (${String(hits)}× ${probe.marker ?? ""})` : "absent";
      } catch (error) {
        row.land = `build-failed (${errorText(error)})`;
      } finally {
        writeFileSync(join(ROOT, KERNEL_ENTRY), restored.get(join(ROOT, KERNEL_ENTRY)) ?? "");
        try {
          execSync("git restore packages/wallet-native/kernel/generated", { cwd: ROOT });
        } catch {
          out("kernel/generated restore failed — restore manually");
        }
      }
    } else {
      out(`LAND engine: ${probe.id} via engine index.ts…`);
      // dts generation (tsgo) would fail on deliberately ill-typed probes before the JS artifact
      // is emitted; drop it so the landing question (does the marker reach dist JS) is answered.
      const extraEdits: Edit[] = [
        {
          path: "packages/wallet-engine/vite.config.ts",
          search: '      dts: { generator: "tsgo" },\n',
          replace: "",
        },
        {
          path: "packages/wallet-engine/vite.config.ts",
          search: '      dts: { generator: "tsgo" },\n',
          replace: "",
        },
        ...(probe.id === "B13"
          ? [
              {
                path: "packages/wallet-engine/vite.config.ts",
                search: '      entry: {\n        index: "src/index.ts",',
                replace: `      alias: { "@scure/base": "${join(ROOT, KERNEL_MARKER)}" },\n      entry: {\n        index: "src/index.ts",`,
              },
            ]
          : []),
      ];
      try {
        restoreExcept(probe);
        keepOriginal(join(ROOT, ENGINE_INDEX));
        for (const edit of extraEdits) {
          keepOriginal(join(ROOT, edit.path));
          writeFileSync(
            join(ROOT, edit.path),
            readFileSync(join(ROOT, edit.path), "utf8").replace(edit.search, edit.replace),
          );
        }
        // export * keeps the probe reachable from the lib entry — a bare import
        // is dropped from dist by tree-shaking.
        writeFileSync(
          join(ROOT, ENGINE_INDEX),
          `${readFileSync(join(ROOT, ENGINE_INDEX), "utf8")}\nexport * as n3probe${probe.id} from "./n3probe-${probe.id.toLowerCase()}.ts";\n`,
        );
        execSync("bunx vp pack", {
          cwd: join(ROOT, "packages/wallet-engine"),
          timeout: 900_000,
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 128 * 1024 * 1024,
        });
        const hits =
          probe.marker === undefined ? 0 : grepCount(join(ROOT, ENGINE_DIST), probe.marker);
        row.land = hits > 0 ? `LANDED (${String(hits)}× ${probe.marker ?? ""})` : "absent";
      } catch (error) {
        row.land = `build-failed (${errorText(error)})`;
      } finally {
        for (const edit of extraEdits) {
          writeFileSync(join(ROOT, edit.path), restored.get(join(ROOT, edit.path)) ?? "");
        }
        writeFileSync(join(ROOT, ENGINE_INDEX), restored.get(join(ROOT, ENGINE_INDEX)) ?? "");
      }
    }
  }
} finally {
  cleanup();
}
// Leave dist clean: one last engine build after all LAND probes removed their imports.
if (PROBES.some((probe) => probe.land === "engine")) {
  try {
    execSync("bunx vp run @qntx/wallet-engine#build", { cwd: ROOT, timeout: 900_000 });
  } catch {
    out("final engine rebuild failed — dist may contain probe artifacts");
  }
}

out("\nid\tfile\tsrc\tbundle\tlint\tland");
for (const probe of PROBES) {
  const row = rowFor.get(probe.id);
  if (row !== undefined) {
    out(`${probe.id}\t${probe.file}\t${row.src}\t${row.bundle}\t${row.lint}\t${row.land}`);
  }
}
out(
  `\ngit status --porcelain:\n${execSync("git status --porcelain", { cwd: ROOT, encoding: "utf8" })}`,
);
