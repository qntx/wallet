// Judges what the bundles actually load, not what the sources spell: each published entry is
// built with the repo's pinned bundler (rolldown via vite — the same build() build-kernel.ts and
// `vp pack` run) and every resolved module is recorded after symlink resolution, then the rules
// below judge it. That covers the spellings the source checker cannot see by construction:
// require(), .js/.cts payloads, symlinks, package.json `imports`, tsconfig `paths`, absolute
// imports and import.meta.glob — the bundler resolves them all to a real file or an external.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { ENCLAVE_CONDITIONS, loadWorkspace, resolveSpecifier, within } from "./check-boundaries.ts";
import type { Workspace } from "./check-boundaries.ts";
import { ENCLAVE_ZONE } from "./enclave-zone.ts";
import { KERNEL_BUILD_CONDITIONS } from "./kernel-build-config.ts";

// The repo does not depend on @types/bun; declare the used surface.
declare const Bun: {
  resolveSync: (specifier: string, directory: string) => string;
};

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** The five entry classes a bundle can be built from. */
export type EntryKind = "enclave" | "host-enclave" | "main" | "node-host" | "gateway";

export type Entry = { readonly file: string; readonly kind: EntryKind };

export type BundleViolation = {
  readonly entry: string;
  readonly rule: string;
  /** Repo-relative module path, `pkg:<specifier>` or `builtin:<name>`. */
  readonly module: string;
  /** Importer chain back to the entry, when the graph recorded one. */
  readonly chain?: string;
};

type External = { readonly kind: "package" | "builtin"; readonly name: string };

type Bundle = {
  /** Repo-relative paths (after realpath) of every workspace file the bundle loads. */
  readonly files: ReadonlyArray<string>;
  readonly externals: ReadonlyArray<External>;
  /** Bare specifiers nothing resolved — rolldown only warns on them. */
  readonly unresolved: ReadonlyArray<string>;
  /** First-seen importer per module — enough to rebuild a chain to the entry. */
  readonly parent: ReadonlyMap<string, string>;
};

const BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

const isBare = (id: string): boolean =>
  !id.startsWith(".") &&
  !id.startsWith("/") &&
  !id.startsWith("#") &&
  !id.startsWith("file:") &&
  !id.startsWith("\0");

const isBuiltin = (id: string): boolean => BUILTINS.has(id) || BUILTIN_RE.test(id);

const BUILTIN_RE =
  /^(?:assert|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(?:\/|$)/;

const CHAIN_SIGNER = /^packages\/wallet-chains\/src\/[^/]+\/sign\.ts$/;
const BACKEND_PACKAGE = /^@qntx\/[^/]+-(?:wasm|native)(?:\/|$)/;
const NODE_HOST_BUILTINS: ReadonlySet<string> = new Set(["worker_threads", "fs/promises"]);

// `new Worker(new URL("kernel.worker.js", import.meta.url))` names a dist artefact that does not
// exist in the tree; the worker plugin insists on bundling it, so an empty module stands in.
const WORKER_STUB_DIR = "node_modules/.qntx-bundle-check";

const realpath = (id: string): string => {
  const clean = id.split(/[?#]/)[0] ?? id;
  try {
    return realpathSync(clean);
  } catch {
    return clean;
  }
};

/** A loaded file inside the workspace (not node_modules) — the set the zone rules judge. */
const WORKSPACE_TREE = /^(?:packages|apps)\//;

/**
 * One `build()` per entry: write nothing, bundle every workspace file from source (workspace
 * specifiers are mapped to their `pack.entry` source in a pre resolveId, everything else the
 * bundler resolves itself — relative, absolute, `#imports`, tsconfig paths, symlinks, require,
 * glob), and record each loaded module with the importer that first reached it.
 *
 * `enclave` entries build under the kernel bundle's own resolve conditions and keep NOTHING
 * external: a bare specifier the bundler can resolve is bundled and every loaded module —
 * node_modules included — is recorded by realpath, so a third-party trampoline package's re-export
 * of engine source lands and is judged. The bare specifier itself is still recorded as a `pkg:`
 * external for the name rules (backends, host packages, engine), it just is not excluded from the
 * bundle.
 */
async function bundle(
  root: string,
  workspace: Workspace,
  entry: string,
  kind: EntryKind,
): Promise<Bundle> {
  const files: string[] = [];
  const externals = new Map<string, External>();
  const unresolved = new Set<string>();
  const parent = new Map<string, string>();
  const rel = (id: string): string => relative(root, realpath(id)).replaceAll("\\", "/");
  // Importer-relative ESM resolution (bun does not hoist every dep to the root, and require()
  // cannot see import-only exports): a bare specifier resolving into node_modules is a real
  // installed package and stays external. Anything else — an alias a tsconfig `paths` maps to
  // source, an unresolvable name — is handed to the bundler, which either lands the file it
  // points at or fails the build closed.
  const importerResolve = (id: string, importer: string | undefined): boolean => {
    const from = importer === undefined ? resolve(root, entry) : realpath(importer);
    try {
      return Bun.resolveSync(id, dirname(from)).includes("/node_modules/");
    } catch {
      return false;
    }
  };
  const enclave = kind === "enclave";
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    build: {
      write: false,
      lib: { entry: resolve(root, entry), formats: ["es"] },
      minify: false,
      ...(enclave ? { rolldownOptions: { external: [] } } : {}),
    },
    resolve: {
      tsconfigPaths: true,
      ...(enclave ? { conditions: [...KERNEL_BUILD_CONDITIONS] } : {}),
      // The worker plugin resolves the URL through its own resolver (config.createResolver),
      // which honours resolve.alias but not user resolveId hooks — alias it to the stub.
      alias: [
        {
          find: "kernel.worker.js",
          replacement: resolve(root, WORKER_STUB_DIR, "kernel.worker.js"),
        },
      ],
    },
    plugins: [
      {
        name: "qntx-bundle-boundary",
        enforce: "pre",
        // Rolldown only warns on an unresolved import and leaves it external — that would let an
        // opaque specifier skip every rule, so each one is recorded and reported fail-closed.
        onLog(_level, log) {
          if (log.code === "UNRESOLVED_IMPORT") {
            unresolved.add(log.id ?? "unresolved import");
          }
        },
        resolveId(id, importer) {
          if (isBuiltin(id)) {
            externals.set(`builtin:${id}`, {
              kind: "builtin",
              name: id.replace(/^node:/, ""),
            });
            return { id, external: true };
          }
          if (!isBare(id)) {
            return null;
          }
          const target = resolveSpecifier(
            root,
            workspace,
            importer === undefined ? entry : rel(importer),
            id,
            enclave ? ENCLAVE_CONDITIONS : undefined,
          );
          if (target.kind === "file") {
            return resolve(root, target.path);
          }
          // Scheme specifier (cloudflare:workers): a runtime builtin, always external.
          if (/^[a-z][a-z0-9+.-]*:/i.test(id)) {
            externals.set(`pkg:${id}`, { kind: "package", name: id });
            return { id, external: true };
          }
          if (importerResolve(id, importer)) {
            externals.set(`pkg:${id}`, { kind: "package", name: id });
            // The enclave bundles its dependencies — record the name for the external rules
            // but let the bundler load the package so its contents are judged too.
            return enclave ? null : { id, external: true };
          }
          return null;
        },
        load(id) {
          const clean = id.split(/[?#]/)[0] ?? id;
          if (!clean.startsWith(`${root}/`)) {
            return null;
          }
          files.push(rel(clean));
          return null;
        },
        moduleParsed(info) {
          const clean = info.id.split(/[?#]/)[0] ?? info.id;
          const importer = [...info.importers, ...info.dynamicImporters].find((id) =>
            id.startsWith(`${root}/`),
          );
          if (clean.startsWith(`${root}/`) && importer !== undefined && !parent.has(rel(clean))) {
            parent.set(rel(clean), rel(importer));
          }
        },
      },
    ],
  });
  return {
    files,
    externals: [...externals.values()],
    unresolved: [...unresolved],
    parent,
  };
}

const chainOf = (parent: ReadonlyMap<string, string>, module: string): string | undefined => {
  const chain: string[] = [];
  let at = module;
  const seen = new Set<string>();
  for (let depth = 0; depth < 32 && !seen.has(at); depth += 1) {
    seen.add(at);
    const next = parent.get(at);
    if (next === undefined) {
      break;
    }
    at = next;
    chain.push(at);
  }
  return chain.length === 0 ? undefined : chain.toReversed().join(" <- ");
};

const packageName = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

/** The violations one bundle's module set commits under `kind`. */
function judge(
  kind: EntryKind,
  entry: string,
  result: Bundle,
  gatewayAllow: ReadonlySet<string>,
  workspaceNames: ReadonlySet<string>,
): BundleViolation[] {
  const out: BundleViolation[] = [];
  const fileRule = (path: string): string | undefined => {
    // Only workspace files are content-judged; a bundled node_modules payload (the enclave
    // keeps nothing external) is a third-party package judged by its recorded specifier name.
    if (!WORKSPACE_TREE.test(path)) {
      return undefined;
    }
    if (kind === "enclave") {
      return within(path, ...ENCLAVE_ZONE)
        ? undefined
        : "pulls code outside the enclave globals zone into the kernel bundle";
    }
    if (kind === "host-enclave") {
      return within(
        path,
        ...ENCLAVE_ZONE,
        "packages/wallet-worker/src/worker",
        "packages/wallet-worker/src/shared.ts",
      )
        ? undefined
        : "the kernel worker bundle may load only the enclave zone and its own worker code";
    }
    if (kind === "main") {
      if (CHAIN_SIGNER.test(path)) {
        return "chain sign functions hold key material — only the kernel bundle may load them";
      }
      return within(path, "packages/wallet-kernel")
        ? "@qntx/wallet-kernel is private — only the enclave and Node host bundles load it"
        : undefined;
    }
    if (kind === "gateway") {
      return within(path, "apps/gateway") || gatewayAllow.has(path)
        ? undefined
        : "apps/gateway bundles the workspace only through the gateway contract entry";
    }
    return undefined;
  };
  const externalRule = (external: External): string | undefined => {
    if (external.kind === "builtin") {
      return (kind === "node-host" || kind === "host-enclave") &&
        NODE_HOST_BUILTINS.has(external.name)
        ? undefined
        : "Node builtin — bundled code stays platform-neutral";
    }
    const { name } = external;
    // A workspace specifier that stayed external did not resolve to a source export — it would
    // resolve to dist in a real build, so no entry may carry one.
    if (workspaceNames.has(packageName(name))) {
      return "workspace specifier resolved to a package instead of its source";
    }
    switch (kind) {
      case "enclave":
        if (BACKEND_PACKAGE.test(name)) {
          return "backends are injected by the host packages, never bundled from kernel code";
        }
        return /^@qntx\/wallet-(?:worker|native|engine)(?:\/|$)/.test(name)
          ? "the kernel bundle never reaches a host package or the engine"
          : undefined;
      case "host-enclave":
        return /^@qntx\/wallet-engine(?:\/|$)/.test(name)
          ? "the kernel worker never loads the engine"
          : undefined;
      case "main":
        if (!entry.startsWith("packages/wallet-engine/")) {
          return undefined;
        }
        if (BACKEND_PACKAGE.test(name)) {
          return "backends are injected by the host packages, never bundled from the engine";
        }
        return name === "@qntx/spark/signer"
          ? "@qntx/spark/signer is the kernel's signer surface — the engine never loads it"
          : undefined;
      default:
        return undefined;
    }
  };
  for (const path of result.files) {
    const message = fileRule(path);
    if (message !== undefined) {
      const chain = chainOf(result.parent, path);
      out.push({
        entry,
        rule: `${kind}-bundle`,
        module: path,
        ...(chain === undefined ? {} : { chain }),
      });
    }
  }
  for (const name of result.unresolved) {
    out.push({ entry, rule: "unresolved-specifier", module: name });
  }
  for (const external of result.externals) {
    const message = externalRule(external);
    if (message !== undefined) {
      out.push({
        entry,
        rule: `${kind}-bundle`,
        module: external.kind === "builtin" ? `builtin:${external.name}` : `pkg:${external.name}`,
      });
    }
  }
  return out;
}

/** Every entry the checks run, derived from the workspace's pack config (no hand list). */
export async function bundleEntries(
  root: string,
  workspace?: Workspace,
  extra: ReadonlyArray<Entry> = [],
): Promise<Entry[]> {
  const ws = workspace ?? (await loadWorkspace(root));
  const entries: Entry[] = [
    { file: "packages/wallet-kernel/src/index.ts", kind: "enclave" },
    { file: "packages/wallet-native/kernel/kernel-entry.ts", kind: "enclave" },
    { file: "packages/wallet-worker/src/worker/worker.ts", kind: "host-enclave" },
    { file: "packages/wallet-worker/src/worker/node.ts", kind: "host-enclave" },
    { file: "apps/gateway/src/index.ts", kind: "gateway" },
  ];
  const pack = (dir: string): ReadonlyMap<string, string> => ws.entries.get(dir) ?? new Map();
  for (const dir of ["packages/wallet-engine", "packages/wallet", "packages/wallet-native"]) {
    for (const source of pack(dir).values()) {
      entries.push({ file: `${dir}/${source}`, kind: "main" });
    }
  }
  for (const [name, source] of pack("packages/wallet-chains")) {
    if (!name.endsWith("sign")) {
      entries.push({ file: `packages/wallet-chains/${source}`, kind: "main" });
    }
  }
  for (const [name, source] of pack("packages/wallet-worker")) {
    entries.push({
      file: `packages/wallet-worker/${source}`,
      kind: name === "node" ? "node-host" : "main",
    });
  }
  return [...entries, ...extra];
}

/**
 * Every bundle-level boundary violation in the repository at `root`. `extraEntries` builds probe
 * files as the named entry class without touching any committed file (the lint-boundary harness
 * uses it).
 */
export async function bundleViolations(
  root: string = ROOT,
  options: { readonly extraEntries?: ReadonlyArray<Entry> } = {},
): Promise<BundleViolation[]> {
  const normalized = root.replace(/\/+$/, "");
  const workspace = await loadWorkspace(normalized);
  const entries = await bundleEntries(normalized, workspace, options.extraEntries ?? []);
  const stub = resolve(normalized, WORKER_STUB_DIR);
  mkdirSync(stub, { recursive: true });
  writeFileSync(resolve(stub, "kernel.worker.js"), "export {};\n");
  try {
    const contract = await bundle(
      normalized,
      workspace,
      "packages/wallet-engine/src/gateway/contract/index.ts",
      "main",
    );
    const gatewayAllow = new Set(contract.files);
    const results: Array<{ readonly entry: Entry; readonly result: Bundle }> = [];
    const failed: BundleViolation[] = [];
    // oxlint-disable eslint/no-await-in-loop -- concurrent build() calls crash the rolldown
    // worker threads ("ModuleLoader channel closed"); each build takes ~50 ms.
    for (const entry of entries) {
      try {
        results.push({
          entry,
          result: await bundle(normalized, workspace, entry.file, entry.kind),
        });
      } catch (error) {
        // Fail closed: an entry that cannot be built cannot be judged — surface it, don't skip it.
        failed.push({
          entry: entry.file,
          rule: "build-error",
          module:
            String(error)
              .split("\n")
              .find((line) => line.trim() !== "") ?? "build failed",
        });
      }
    }
    const workspaceNames = new Set(workspace.packages.keys());
    return [
      ...failed,
      ...results.flatMap(({ entry, result }) =>
        judge(entry.kind, entry.file, result, gatewayAllow, workspaceNames),
      ),
    ];
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const violations = await bundleViolations();
  for (const { entry, rule, module, chain } of violations) {
    console.error(`${entry}  ${rule}  ${module}${chain ?? ""}`);
  }
  if (violations.length > 0) {
    console.error(`\ncheck-bundles: ${violations.length} violation(s)`);
    process.exitCode = 1;
  }
}
