// Enforces the AGENTS.md package and layer boundaries on resolved module paths. Every import,
// re-export and literal dynamic import in library src, the native kernel entry and the gateway is
// resolved to the workspace file it loads — whatever its spelling: a package name, `./`, `..`, a
// path into another package — or to an external package or Node builtin, and the rules below
// judge the resolved target. A boundary that only matched specifier text could be walked around
// by spelling the same file differently.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseSync } from "vite/rolldown/utils";

import { ENCLAVE_ZONE } from "./enclave-zone.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export type Target =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "builtin"; readonly name: string }
  | { readonly kind: "package"; readonly name: string; readonly subpath: string }
  | { readonly kind: "unresolved"; readonly reason: string };

export type Edge = {
  /** Repo-relative path of the importing file. */
  readonly from: string;
  readonly specifier: string;
  /** `import type` / `export type`: erased at runtime, so it never pulls code into a bundle. */
  readonly typeOnly: boolean;
  readonly line: number;
  readonly target: Target;
};

export type Violation = { readonly edge: Edge; readonly rule: string; readonly message: string };

/** `path` is `zone` or lies under it. */
const within = (path: string, ...zones: ReadonlyArray<string>): boolean =>
  zones.some((zone) => path === zone || path.startsWith(`${zone}/`));

const packageDirOf = (path: string): string | undefined =>
  /^(?:packages|apps)\/[^/]+/.exec(path)?.[0];

const KERNEL = "packages/wallet-kernel/src";
const NATIVE_KERNEL = "packages/wallet-native/kernel";
const CHAINS = "packages/wallet-chains/src";
const ENGINE = "packages/wallet-engine/src";
const WALLET = "packages/wallet/src";
const GATEWAY = "apps/gateway";
const CONTRACT = `${ENGINE}/gateway/contract`;
const PRICES = `${ENGINE}/prices`;
const NODE_HOST = [
  "packages/wallet-worker/src/node",
  "packages/wallet-worker/src/worker/node.ts",
  "packages/wallet-worker/src/worker/node-kernel.ts",
];
/** The hosts that bundle the private kernel package. */
const KERNEL_BUNDLERS = [
  "packages/wallet-kernel",
  NATIVE_KERNEL,
  "packages/wallet-worker/src/node",
  "packages/wallet-worker/src/worker",
  "packages/wallet-worker/src/shared.ts",
];
/** What the kernel source may load from the workspace: itself, chains, the wire protocol. */
const KERNEL_IMPORTABLE = [KERNEL, CHAINS, `${WALLET}/protocol`, `${WALLET}/types.ts`];
/** The native kernel entry adds itself and the frame codec it shares with the host. */
const NATIVE_KERNEL_IMPORTABLE = [
  ...KERNEL_IMPORTABLE,
  NATIVE_KERNEL,
  "packages/wallet-native/src/cbor.ts",
];
/**
 * The kernel's one-directional layer graph: each layer is a directory of src and may import only
 * the layers listed. The root files compose (index.ts, kernel.ts) or feed (platform.ts, errors.ts,
 * status.ts, prompts.ts) them; no layer may reach a composing root.
 */
const KERNEL_LAYERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  secret: [],
  seed: ["secret"],
  derive: ["secret"],
  vault: ["secret"],
  session: ["secret", "vault"],
  commands: ["secret", "seed", "derive", "vault", "session"],
  modules: ["secret", "seed", "derive", "vault", "session", "commands"],
};
const KERNEL_COMPOSING_ROOTS: ReadonlySet<string> = new Set(["index.ts", "kernel.ts"]);
const NODE_HOST_BUILTINS: ReadonlySet<string> = new Set(["worker_threads", "fs/promises"]);
const CHAIN_SIGNER = /^packages\/wallet-chains\/src\/[^/]+\/sign\.ts$/;
const BACKEND_PACKAGE = /^@qntx\/[^/]+-(?:wasm|native)$/;
const NOSTR_TRANSPORT: ReadonlySet<string> = new Set(["./client", "./relay", "./store"]);

const isLibrarySource = (path: string): boolean => /^packages\/[^/]+\/src\//.test(path);
const fileTarget = (edge: Edge): string | undefined =>
  edge.target.kind === "file" ? edge.target.path : undefined;
const packageTarget = (edge: Edge): { name: string; subpath: string } | undefined =>
  edge.target.kind === "package" ? edge.target : undefined;
/** The engine's composition root: src/*.ts. Everything else in engine src is a subdirectory. */
const isEngineRoot = (path: string): boolean => /^packages\/wallet-engine\/src\/[^/]+$/.test(path);

type Rule = {
  readonly id: string;
  /** The violation message, or `undefined` when the edge is allowed. */
  readonly check: (edge: Edge) => string | undefined;
};

const RULES: ReadonlyArray<Rule> = [
  {
    id: "resolvable",
    check: (edge) => (edge.target.kind === "unresolved" ? edge.target.reason : undefined),
  },
  {
    id: "platform-neutral",
    check: (edge) => {
      if (edge.target.kind !== "builtin") {
        return undefined;
      }
      if (!isLibrarySource(edge.from) && !within(edge.from, NATIVE_KERNEL)) {
        return undefined;
      }
      if (within(edge.from, ...NODE_HOST) && NODE_HOST_BUILTINS.has(edge.target.name)) {
        return undefined;
      }
      return within(edge.from, ...NODE_HOST)
        ? "the Node host may use only node:worker_threads and node:fs/promises"
        : "Node builtin — library code stays platform-neutral";
    },
  },
  {
    id: "chain-signers",
    check: (edge) => {
      const target = fileTarget(edge);
      return target !== undefined && CHAIN_SIGNER.test(target) && !within(edge.from, KERNEL)
        ? "chain sign functions hold key material — only packages/wallet-kernel/src may load them"
        : undefined;
    },
  },
  {
    id: "kernel-private",
    check: (edge) => {
      const target = fileTarget(edge);
      return target !== undefined &&
        within(target, "packages/wallet-kernel") &&
        !within(edge.from, ...KERNEL_BUNDLERS)
        ? "@qntx/wallet-kernel is private — only the host bundles load it"
        : undefined;
    },
  },
  {
    id: "enclave-imports",
    check: (edge) => {
      const importable = within(edge.from, KERNEL)
        ? KERNEL_IMPORTABLE
        : within(edge.from, NATIVE_KERNEL)
          ? NATIVE_KERNEL_IMPORTABLE
          : undefined;
      if (importable === undefined) {
        return undefined;
      }
      const target = fileTarget(edge);
      if (target !== undefined && !within(target, ...importable)) {
        return "kernel code sees only the kernel, chains and @qntx/wallet/protocol|types — never a host or the engine";
      }
      const pkg = packageTarget(edge);
      return pkg !== undefined && BACKEND_PACKAGE.test(pkg.name)
        ? "backends are injected by the host packages, never imported by the kernel"
        : undefined;
    },
  },
  {
    id: "kernel-layers",
    check: (edge) => {
      const target = fileTarget(edge);
      const [fromLayer = ""] = edge.from.slice(KERNEL.length + 1).split("/");
      const allowed = KERNEL_LAYERS[fromLayer];
      if (
        !within(edge.from, KERNEL) ||
        allowed === undefined ||
        target === undefined ||
        !within(target, KERNEL)
      ) {
        return undefined;
      }
      const [toLayer = ""] = target.slice(KERNEL.length + 1).split("/");
      if (KERNEL_COMPOSING_ROOTS.has(toLayer)) {
        return `${fromLayer} may not import the kernel's composition root ${toLayer}`;
      }
      return toLayer in KERNEL_LAYERS && toLayer !== fromLayer && !allowed.includes(toLayer)
        ? `${fromLayer} may only import ${allowed.length > 0 ? allowed.join(", ") : "itself (the leaf layer)"} (AGENTS.md layering)`
        : undefined;
    },
  },
  {
    id: "chains-leaf",
    check: (edge) => {
      const target = fileTarget(edge);
      return within(edge.from, CHAINS) && target !== undefined && !within(target, CHAINS)
        ? "@qntx/wallet-chains is the leaf chain-semantic package — it imports no other workspace package"
        : undefined;
    },
  },
  {
    id: "engine-backends",
    check: (edge) => {
      const pkg = packageTarget(edge);
      if (!within(edge.from, ENGINE) || pkg === undefined) {
        return undefined;
      }
      if (BACKEND_PACKAGE.test(pkg.name)) {
        return "backends are injected by the host packages, never imported by the engine";
      }
      return pkg.name === "@qntx/spark" && pkg.subpath === "./signer"
        ? "@qntx/spark/signer is the kernel's signer surface — the engine never loads it"
        : undefined;
    },
  },
  {
    id: "nostr",
    check: (edge) => {
      const pkg = packageTarget(edge);
      const target = fileTarget(edge);
      const nostr = pkg?.name === "@qntx/nostr";
      const transport = nostr && NOSTR_TRANSPORT.has(pkg.subpath);
      const nostrModule = target !== undefined && within(target, `${WALLET}/nostr`);
      if (
        /^packages\/wallet\/src\/[^/]+$/.test(edge.from) ||
        within(edge.from, `${WALLET}/protocol`)
      ) {
        return nostr || nostrModule
          ? "only packages/wallet/src/nostr may reach @qntx/nostr or the nostr module"
          : undefined;
      }
      if (within(edge.from, `${WALLET}/nostr`) || within(edge.from, `${KERNEL}/modules/nostr`)) {
        return transport
          ? "the nostr module uses only the core, nips and signer parts of @qntx/nostr"
          : undefined;
      }
      return within(edge.from, KERNEL) && nostr
        ? "only packages/wallet-kernel/src/modules/nostr may import @qntx/nostr"
        : undefined;
    },
  },
  {
    id: "gateway-contract-only",
    check: (edge) => {
      const target = fileTarget(edge);
      const pkg = packageTarget(edge);
      return within(edge.from, GATEWAY) &&
        ((target !== undefined && !within(target, GATEWAY, CONTRACT)) ||
          pkg?.name.startsWith("@qntx/") === true)
        ? "apps/gateway may only import @qntx/wallet-engine/gateway/contract from the workspace"
        : undefined;
    },
  },
  {
    id: "relative-packages",
    check: (edge) => {
      const target = fileTarget(edge);
      if (target === undefined || !edge.specifier.startsWith(".")) {
        return undefined;
      }
      if (packageDirOf(target) === packageDirOf(edge.from)) {
        return undefined;
      }
      return within(target, "packages/wallet-kernel") && within(edge.from, ...KERNEL_BUNDLERS)
        ? undefined
        : "a relative import into another package bypasses its exports — import it by name";
    },
  },
];

/** Engine subdirectory files may not read prices: not directly, nor through a root file. */
const pricesViolations = (edges: ReadonlyArray<Edge>): Violation[] => {
  const valueTargets = new Map<string, string[]>();
  for (const edge of edges) {
    const target = fileTarget(edge);
    if (!edge.typeOnly && target !== undefined && within(target, ENGINE)) {
      valueTargets.set(edge.from, [...(valueTargets.get(edge.from) ?? []), target]);
    }
  }
  const memo = new Map<string, boolean>();
  const reachesPrices = (file: string): boolean => {
    const known = memo.get(file);
    if (known !== undefined) {
      return known;
    }
    memo.set(file, false);
    const reached =
      within(file, PRICES) || (valueTargets.get(file) ?? []).some((next) => reachesPrices(next));
    memo.set(file, reached);
    return reached;
  };
  return edges.flatMap((edge): Violation[] => {
    const target = fileTarget(edge);
    if (
      target === undefined ||
      !within(edge.from, ENGINE) ||
      isEngineRoot(edge.from) ||
      within(edge.from, PRICES)
    ) {
      return [];
    }
    const direct = within(target, PRICES);
    const viaRoot = !edge.typeOnly && isEngineRoot(target) && reachesPrices(target);
    return direct || viaRoot
      ? [
          {
            edge,
            rule: "prices-display-only",
            message:
              "prices are display-only — only the engine composition root (src/*.ts) may reach src/prices",
          },
        ]
      : [];
  });
};

/**
 * Every value edge that carries the kernel bundle out of {@link ENCLAVE_ZONE}: the code there is
 * linted against the enclave global allow-list, code outside it is not.
 */
const enclaveClosureViolations = (edges: ReadonlyArray<Edge>): Violation[] => {
  const out = new Map<string, Edge[]>();
  for (const edge of edges) {
    if (!edge.typeOnly && edge.target.kind === "file") {
      out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
    }
  }
  const reached = new Set<string>();
  const queue = edges
    .map((edge) => edge.from)
    .filter((file) => within(file, KERNEL, NATIVE_KERNEL));
  const violations: Violation[] = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || reached.has(file)) {
      continue;
    }
    reached.add(file);
    for (const edge of out.get(file) ?? []) {
      const target = fileTarget(edge);
      if (target === undefined) {
        continue;
      }
      if (within(target, ...ENCLAVE_ZONE)) {
        queue.push(target);
      } else {
        violations.push({
          edge,
          rule: "enclave-closure",
          message: `pulls ${target} into the kernel bundle, outside the enclave globals zone (scripts/enclave-zone.ts)`,
        });
      }
    }
  }
  return violations;
};

type Workspace = {
  readonly packages: ReadonlyMap<string, { readonly dir: string; readonly exports: unknown }>;
  /** Per package dir: built entry name → its source file (from the package's `pack.entry`). */
  readonly entries: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const packEntries = (pack: unknown): Array<[string, string]> => {
  const configs = Array.isArray(pack) ? (pack as unknown[]) : [pack];
  return configs.flatMap((config) =>
    isRecord(config) && isRecord(config["entry"])
      ? Object.entries(config["entry"]).flatMap(([name, source]): Array<[string, string]> =>
          typeof source === "string" ? [[name, source]] : [],
        )
      : [],
  );
};

async function loadWorkspace(root: string): Promise<Workspace> {
  const packages = new Map<string, { dir: string; exports: unknown }>();
  const entries = new Map<string, Map<string, string>>();
  const dirs = ["packages", "apps"].flatMap((parent) =>
    readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`),
  );
  for (const dir of dirs) {
    const manifest = join(root, dir, "package.json");
    if (!existsSync(manifest)) {
      continue;
    }
    const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (!isRecord(pkg) || typeof pkg["name"] !== "string") {
      continue;
    }
    packages.set(pkg["name"], { dir, exports: pkg["exports"] });
    const config = join(root, dir, "vite.config.ts");
    if (dir.startsWith("packages/") && existsSync(config)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of configs, read once
      const loaded: unknown = await import(pathToFileURL(config).href);
      const pack = isRecord(loaded) && isRecord(loaded["default"]) ? loaded["default"]["pack"] : {};
      entries.set(dir, new Map(packEntries(pack)));
    }
  }
  return { packages, entries };
}

const exportTarget = (exports: unknown, subpath: string): string | undefined => {
  const entry = isRecord(exports) ? exports[subpath] : subpath === "." ? exports : undefined;
  if (typeof entry === "string") {
    return entry;
  }
  if (isRecord(entry)) {
    const chosen = entry["import"] ?? entry["default"];
    return typeof chosen === "string" ? chosen : undefined;
  }
  return undefined;
};

const asFile = (absolute: string): string | undefined => {
  const candidates = absolute.endsWith(".js")
    ? [`${absolute.slice(0, -3)}.ts`, absolute]
    : [absolute, `${absolute}.ts`, `${absolute}.tsx`, join(absolute, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
};

const splitPackage = (specifier: string): { name: string; subpath: string } => {
  const parts = specifier.split("/");
  const size = specifier.startsWith("@") ? 2 : 1;
  const rest = parts.slice(size).join("/");
  return { name: parts.slice(0, size).join("/"), subpath: rest === "" ? "." : `./${rest}` };
};

function resolveSpecifier(
  root: string,
  workspace: Workspace,
  from: string,
  specifier: string,
): Target {
  if (specifier.startsWith("node:") || builtinModules.includes(specifier)) {
    return { kind: "builtin", name: specifier.replace(/^node:/, "") };
  }
  if (specifier.startsWith(".")) {
    const file = asFile(resolve(root, dirname(from), specifier));
    return file === undefined
      ? { kind: "unresolved", reason: `cannot resolve ${specifier}` }
      : { kind: "file", path: relative(root, file).replaceAll("\\", "/") };
  }
  const { name, subpath } = splitPackage(specifier);
  const pkg = workspace.packages.get(name);
  if (pkg === undefined) {
    return { kind: "package", name, subpath };
  }
  const exported = exportTarget(pkg.exports, subpath);
  const built = exported === undefined ? undefined : /^\.\/dist\/(.+)\.mjs$/.exec(exported)?.[1];
  const source =
    exported?.endsWith(".ts") === true
      ? exported
      : built === undefined
        ? undefined
        : workspace.entries.get(pkg.dir)?.get(built);
  const file = source === undefined ? undefined : asFile(resolve(root, pkg.dir, source));
  return file === undefined
    ? {
        kind: "unresolved",
        reason: `${specifier} is not an export of the workspace package ${name}`,
      }
    : { kind: "file", path: relative(root, file).replaceAll("\\", "/") };
}

const SOURCE_FILE = /\.(?:ts|tsx|mts)$/;
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "generated"]);

const walk = (root: string, dir: string): string[] => {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) {
    return [];
  }
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : walk(root, path);
    }
    return SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
};

/** The files the boundaries govern: library src, the native kernel entry, the gateway. */
const scopedFiles = (root: string): string[] => [
  ...readdirSync(join(root, "packages")).flatMap((name) => walk(root, `packages/${name}/src`)),
  ...walk(root, NATIVE_KERNEL),
  ...["src", "tests", "scripts"].flatMap((dir) => walk(root, `${GATEWAY}/${dir}`)),
];

const lineAt = (source: string, offset: number): number =>
  source.slice(0, offset).split("\n").length;

const STRING_LITERAL = /^(["'])(.*)\1$/s;

function fileEdges(root: string, workspace: Workspace, from: string): Edge[] {
  const source = readFileSync(join(root, from), "utf8");
  const { module } = parseSync(from, source);
  const edge = (specifier: string, typeOnly: boolean, offset: number): Edge => ({
    from,
    specifier,
    typeOnly,
    line: lineAt(source, offset),
    target: resolveSpecifier(root, workspace, from, specifier),
  });
  return [
    ...module.staticImports.map((entry) =>
      edge(
        entry.moduleRequest.value,
        entry.entries.length > 0 && entry.entries.every((binding) => binding.isType),
        entry.start,
      ),
    ),
    ...module.staticExports.flatMap((entry) => {
      const bindings = entry.entries.filter((binding) => binding.moduleRequest !== null);
      const [first] = bindings;
      return first?.moduleRequest === null || first === undefined
        ? []
        : [
            edge(
              first.moduleRequest.value,
              bindings.every((binding) => binding.isType),
              entry.start,
            ),
          ];
    }),
    ...module.dynamicImports.map((entry): Edge => {
      const text = source.slice(entry.moduleRequest.start, entry.moduleRequest.end);
      const literal = STRING_LITERAL.exec(text)?.[2];
      return literal === undefined
        ? {
            from,
            specifier: text,
            typeOnly: false,
            line: lineAt(source, entry.start),
            target: { kind: "unresolved", reason: "a computed dynamic import cannot be checked" },
          }
        : edge(literal, false, entry.start);
    }),
  ];
}

/** Every boundary violation in the repository at `root`. */
export async function boundaryViolations(root: string = ROOT): Promise<Violation[]> {
  const workspace = await loadWorkspace(root);
  const edges = scopedFiles(root).flatMap((file) => fileEdges(root, workspace, file));
  return [
    ...edges.flatMap((edge) =>
      RULES.flatMap((rule): Violation[] => {
        const message = rule.check(edge);
        return message === undefined ? [] : [{ edge, rule: rule.id, message }];
      }),
    ),
    ...pricesViolations(edges),
    ...enclaveClosureViolations(edges),
  ];
}

if (import.meta.main) {
  const violations = await boundaryViolations();
  for (const { edge, rule, message } of violations) {
    console.error(`${edge.from}:${edge.line}  ${rule}  "${edge.specifier}"  ${message}`);
  }
  if (violations.length > 0) {
    console.error(`\ncheck-boundaries: ${violations.length} violation(s)`);
    process.exitCode = 1;
  }
}
