/// <reference types="node" />
/**
 * Every Hermes call site in the repo runs with the same flags — HERMES_FLAGS in
 * scripts/kernel-build-config.ts, today just -Xes6-block-scoping — whether it compiles bytecode
 * with hermesc or runs a bundle on the bare hermes CLI. hermesc defaults to ES5 scoping where
 * loop-scoped let/const share one binding across iterations and closures capture the last
 * iteration's value, so a single spawn missing the flag silently runs different capture semantics
 * from every other bundle; the kernel also fails closed in startKernel
 * (packages/wallet-kernel/src/kernel.ts). The set of files containing a call site is pinned below,
 * so a new Hermes invocation has to be registered here on purpose.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { HERMES_FLAGS } from "./kernel-build-config.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = "scripts/check-hermes-flags.test.ts";
const FLAG = "-Xes6-block-scoping";
const FLAG_SOURCE = "HERMES_FLAGS";
const COMPILE_SCRIPT = "compile-kernel.mjs";

// Call sites are looked for in the repo's TS scripts, the native build glue (CMake,
// podspec, gradle, shell) and the CI workflows. packages/*/scripts is covered per
// package; the WalletNative podspec lives at its package root and is listed alone.
const SCAN_DIRS = [
  "scripts",
  "apps/harness/scripts",
  "apps/harness/modules",
  "packages/wallet-native/android",
  "packages/wallet-native/ios",
  "packages/wallet-native/cpp",
  ".github/workflows",
];
const SCAN_FILES = ["packages/wallet-native/WalletNative.podspec"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
const JS_EXT = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const BUILD_EXT = new Set([".sh", ".bash", ".yml", ".yaml", ".cmake", ".gradle", ".podspec"]);

const isBuildFile = (rel: string): boolean =>
  BUILD_EXT.has(extname(rel)) || basename(rel) === "CMakeLists.txt";

type Site = {
  file: string;
  line: number;
  // Delegated call sites run compile-kernel.mjs, which is itself registered as a
  // direct call site — the flag lives inside it and the rule below pins it there.
  delegated: boolean;
  args: string;
};

const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

// The source slice spanning the "[" at `start` through its matching "]", treating
// strings, template literals and comments as opaque.
const arrayText = (src: string, start: number): string => {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < src.length && src[i] !== ch) {
        i += src[i] === "\\" ? 2 : 1;
      }
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        i += 1;
      }
    } else if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
    i += 1;
  }
  return src.slice(start);
};

// A spawn array whose first element is a variable named for the Hermes CLI or hermesc
// ([hermes, ...], [hermesc, ...]), and a two-argument execFile/spawn where the binary
// is that variable and the second argument is the argv array (execFileSync(hermesc,
// [...])).
const HERMES_VAR = String.raw`hermes\w*`;
const ARRAY_CMD = new RegExp(`\\[\\s*(${HERMES_VAR})\\s*,`, "g");
const CALL_CMD = new RegExp(
  `(?:execFile\\w*|execa\\w*|spawn\\w*)\\(\\s*(${HERMES_VAR})\\s*,\\s*\\[`,
  "g",
);

const scanJs = (rel: string, src: string, sites: Site[]): void => {
  for (const re of [ARRAY_CMD, CALL_CMD]) {
    for (let match = re.exec(src); match !== null; match = re.exec(src)) {
      const bracket = re === ARRAY_CMD ? match.index : match.index + match[0].length - 1;
      sites.push({
        file: rel,
        line: lineOf(src, match.index),
        delegated: false,
        args: arrayText(src, bracket),
      });
    }
  }
};

// In build glue and workflows a Hermes call is a line that invokes compile-kernel.mjs
// (delegated — the flag is inside that script) or names the bare binary in command
// position. Comment lines do not count; neither do package/module names such as
// hermes-engine, hermesvm, libhermes or React-hermes (the token must not be glued to
// a word character or a dash/colon on either side).
const COMMENT_LINE = /^\s*(?:#|\/\/|\*)/;
// A `key: single-token` yaml line — `name: Hermes`, `hermes-commit: …` — is config, not
// an invocation; a `run:` line with real arguments still scans normally.
const YAML_SCALAR = /^\s*[A-Za-z_-][\w-]*\s*:\s*\S+\s*$/;
const BINARY = /(?:^|[\s"'`/]|\$[({]?)\.?hermesc?(?:\.exe)?(?=[\s"'`)\]}:;,]|$)/i;

const scanBuild = (rel: string, src: string, sites: Site[]): void => {
  const yaml = rel.endsWith(".yml") || rel.endsWith(".yaml");
  const lines = src.split("\n");
  for (const [index, line] of lines.entries()) {
    if (COMMENT_LINE.test(line) || (yaml && YAML_SCALAR.test(line))) {
      continue;
    }
    if (line.includes(COMPILE_SCRIPT)) {
      sites.push({ file: rel, line: index + 1, delegated: true, args: line.trim() });
    } else if (BINARY.test(line)) {
      sites.push({ file: rel, line: index + 1, delegated: false, args: line.trim() });
    }
  }
};

const collectSites = (): Site[] => {
  const files = SCAN_FILES.map((file) => join(ROOT, file));
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          visit(path);
        }
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  for (const dir of SCAN_DIRS) {
    visit(join(ROOT, dir));
  }
  for (const pkg of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory()) {
      continue;
    }
    const scriptsDir = join(ROOT, "packages", pkg.name, "scripts");
    if (existsSync(scriptsDir)) {
      visit(scriptsDir);
    }
  }
  const sites: Site[] = [];
  for (const path of new Set(files)) {
    const rel = relative(ROOT, path);
    if (rel === SELF) {
      continue;
    }
    const src = readFileSync(path, "utf8");
    if (JS_EXT.has(extname(rel))) {
      scanJs(rel, src, sites);
    } else if (isBuildFile(rel)) {
      scanBuild(rel, src, sites);
    }
  }
  return sites;
};

// A RuntimeConfig is built by chaining .with*() calls on RuntimeConfig::Builder() or
// on hardenedHermesRuntimeConfig().rebuild(); the chain ends at .build(). Every chain
// in the wallet-native C++ must set withES6BlockScoping(true) — the runtime side of
// the same flag the CLI invocations get.
const CPP_EXT = new Set([".cpp", ".cc", ".cxx", ".hpp", ".h", ".mm"]);
const BUILDER =
  /RuntimeConfig::Builder\s*\(\s*\)|hardenedHermesRuntimeConfig\s*\(\s*\)\s*\.rebuild\s*\(\s*\)/g;
const CHAIN_END = /\.build\s*\(/;

const collectBuilders = (): { files: string[]; missing: string[] } => {
  const files: string[] = [];
  const missing: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          visit(path);
        }
      } else if (entry.isFile() && CPP_EXT.has(extname(entry.name))) {
        const rel = relative(ROOT, path);
        const src = readFileSync(path, "utf8");
        let found = false;
        for (let match = BUILDER.exec(src); match !== null; match = BUILDER.exec(src)) {
          found = true;
          const rest = src.slice(match.index);
          const end = rest.search(CHAIN_END);
          const chain = end === -1 ? rest : rest.slice(0, end);
          if (!chain.includes(".withES6BlockScoping(true)")) {
            missing.push(`${rel}:${lineOf(src, match.index)}`);
          }
        }
        if (found) {
          files.push(rel);
        }
      }
    }
  };
  visit(join(ROOT, "packages/wallet-native"));
  return { files, missing };
};

const sites = collectSites();
const builders = collectBuilders();
const siteFiles = [...new Set(sites.map((site) => site.file))].toSorted();
const flagless = sites
  .filter(
    (site) => !site.delegated && !site.args.includes(FLAG) && !site.args.includes(FLAG_SOURCE),
  )
  .map((site) => `${site.file}:${site.line} — ${site.args}`);
const builderFiles = builders.files.toSorted();
const compileScript = readFileSync(
  join(ROOT, "packages/wallet-native/scripts", COMPILE_SCRIPT),
  "utf8",
);
const kernelEntry = readFileSync(join(ROOT, "packages/wallet-kernel/src/kernel.ts"), "utf8");

// Files that contain at least one direct or delegated Hermes call site. A new spawn
// anywhere in the scanned tree shows up here and fails until it is registered.
const EXPECTED_SITE_FILES = [
  "packages/wallet-chains/scripts/hermes-smoke.ts",
  "packages/wallet-engine/scripts/hermes-smoke.ts",
  "packages/wallet-kernel/scripts/hermes-smoke.ts",
  "packages/wallet-native/WalletNative.podspec",
  "packages/wallet-native/android/CMakeLists.txt",
  "packages/wallet-native/scripts/compile-kernel.mjs",
  "packages/wallet-worker/scripts/hermes-smoke.ts",
  "scripts/harness-bundles.ts",
  "scripts/native-host-test.ts",
];

const EXPECTED_BUILDER_FILES = [
  "packages/wallet-native/cpp/runtime/KernelRuntime.cpp",
  "packages/wallet-native/tests/host/RuntimeHostTest.cpp",
];

describe("check-hermes-flags", () => {
  it("finds exactly the registered Hermes call sites", () => {
    expect(siteFiles).toStrictEqual(EXPECTED_SITE_FILES);
  });

  it("passes the shared flags to every direct hermes/hermesc invocation", () => {
    expect(flagless).toStrictEqual([]);
  });

  it("keeps -Xes6-block-scoping as the shared flag", () => {
    expect(HERMES_FLAGS).toStrictEqual([FLAG]);
  });

  it("finds every RuntimeConfig builder in wallet-native C++", () => {
    expect(builderFiles).toStrictEqual(EXPECTED_BUILDER_FILES);
  });

  it("sets withES6BlockScoping(true) on every RuntimeConfig builder", () => {
    expect(builders.missing).toStrictEqual([]);
  });

  it("keeps the flag literal inside the shipped compile-kernel.mjs", () => {
    expect(compileScript).toContain(FLAG);
  });

  it("keeps the fail-closed loop-capture check in startKernel", () => {
    expect(kernelEntry).toContain("captures.push(() => each)");
    expect(kernelEntry).toContain(`"kernel requires Hermes compiled with ${FLAG}"`);
  });
});
