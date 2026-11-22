// Enforces the AGENTS.md package and layer boundaries on resolved module paths — the fast,
// source-first of two layers (check-bundles.ts judges what the bundles actually load, catching
// spellings a source scan cannot see: require(), .js/.cts payloads, symlinks, package.json
// `imports`, tsconfig `paths`, absolute imports, import.meta.glob). Every import, re-export and
// literal dynamic import in library src, the native kernel entry and the gateway is resolved to
// the workspace file it loads — whatever its spelling: a package name, `./`, `..`, a path into
// another package — or to an external package or Node builtin, and the rules below judge the
// resolved target. A boundary that only matched specifier text could be walked around by
// spelling the same file differently. Discovery is fail-closed too: symlinks in governed trees,
// non-TypeScript code files, package `imports`, tsconfig `paths`/`baseUrl` aliasing, absolute
// and `file:` specifiers, require()/createRequire()/import.meta.glob() calls and `export {}
// from` edges are all findings on their own.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseSync } from "vite/rolldown/utils";

import { ENCLAVE_ZONE } from "./enclave-zone.ts";
import { KERNEL_BUILD_CONDITIONS } from "./kernel-build-config.ts";

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
export const within = (path: string, ...zones: ReadonlyArray<string>): boolean =>
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

/** The card client is a sealed protocol library: its files and these crypto packages only. */
const CARD_PROTOCOL = `${KERNEL}/modules/card/protocol`;
const CARD_PROTOCOL_PACKAGES: ReadonlySet<string> = new Set([
  "@noble/curves",
  "@noble/hashes",
  "@noble/ciphers",
  "@scure/bip32",
]);
/** The engine's composition root: src/*.ts. Everything else in engine src is a subdirectory. */
const isEngineRoot = (path: string): boolean => /^packages\/wallet-engine\/src\/[^/]+$/.test(path);

type Rule = {
  readonly id: string;
  /** The violation message, or `undefined` when the edge is allowed. */
  readonly check: (edge: Edge) => string | undefined;
};

export const RULES: ReadonlyArray<Rule> = [
  {
    id: "package-imports",
    check: (edge) =>
      edge.specifier.startsWith("#")
        ? "package.json `imports` aliases resolve modules behind opaque names — import by path"
        : undefined,
  },
  {
    id: "absolute-specifier",
    check: (edge) =>
      edge.specifier.startsWith("/") || edge.specifier.startsWith("file:")
        ? "an absolute or file: specifier bypasses module resolution — import by path or name"
        : undefined,
  },
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
    id: "card-protocol",
    check: (edge) => {
      if (!within(edge.from, CARD_PROTOCOL)) {
        return undefined;
      }
      const target = fileTarget(edge);
      if (target !== undefined) {
        return within(target, CARD_PROTOCOL)
          ? undefined
          : "the card protocol is self-contained — it imports nothing outside modules/card/protocol";
      }
      const pkg = packageTarget(edge);
      return pkg === undefined || !CARD_PROTOCOL_PACKAGES.has(pkg.name)
        ? "the card protocol imports only protocol files, @noble/* and @scure/bip32"
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
  // Seed from every file in the zone, not only those reached from the kernel entries: a zone
  // file's value edge out of the zone pulls its target into any bundle that loads it, however
  // the file itself was reached — a conditional export that hides the zone's entry point cannot
  // hide the edges inside it.
  const queue = edges.map((edge) => edge.from).filter((file) => within(file, ...ENCLAVE_ZONE));
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

export type Workspace = {
  readonly packages: ReadonlyMap<string, { readonly dir: string; readonly exports: unknown }>;
  /** Per package dir: built entry name → its source file (from the package's `pack.entry`). */
  readonly entries: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const packEntries = (pack: unknown): Array<[string, string]> => {
  const configs = Array.isArray(pack) ? (pack as unknown[]) : [pack];
  return configs.flatMap((config) =>
    isRecord(config) && isRecord(config["entry"])
      ? Object.entries(config["entry"]).flatMap(([name, source]): Array<[string, string]> =>
          typeof source === "string" ? [[name, source]] : [],
        )
      : [],
  );
};

export async function loadWorkspace(root: string): Promise<Workspace> {
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

/**
 * Picks the `exports` target for `subpath` the way Node and the bundler do: iterate the condition
 * keys in exports-object order and take the first whose name is an active condition. `conditions`
 * is the importer's active-condition set — the ESM default (`import`, `default`) outside the
 * enclave, the kernel build's conditions inside it (scripts/kernel-build-config.ts), so a
 * conditional export resolves the way the real kernel bundle resolves it.
 */
export const exportTarget = (
  exports: unknown,
  subpath: string,
  conditions: ReadonlyArray<string> = ["import", "default"],
): string | undefined => {
  const entry = isRecord(exports) ? exports[subpath] : subpath === "." ? exports : undefined;
  if (typeof entry === "string") {
    return entry;
  }
  if (isRecord(entry)) {
    const active = new Set(conditions);
    for (const [condition, chosen] of Object.entries(entry)) {
      if (active.has(condition) && typeof chosen === "string") {
        return chosen;
      }
    }
  }
  return undefined;
};

const realpath = (absolute: string): string => {
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

const asFile = (absolute: string): string | undefined => {
  const candidates = absolute.endsWith(".js")
    ? [`${absolute.slice(0, -3)}.ts`, absolute]
    : [absolute, `${absolute}.ts`, `${absolute}.tsx`, join(absolute, "index.ts")];
  const found = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  // The rules judge the real file, not the link or the path through a symlinked directory.
  return found === undefined ? undefined : realpath(found);
};

export const splitPackage = (specifier: string): { name: string; subpath: string } => {
  const parts = specifier.split("/");
  const size = specifier.startsWith("@") ? 2 : 1;
  const rest = parts.slice(size).join("/");
  return { name: parts.slice(0, size).join("/"), subpath: rest === "" ? "." : `./${rest}` };
};

export function resolveSpecifier(
  root: string,
  workspace: Workspace,
  from: string,
  specifier: string,
  conditions?: ReadonlyArray<string>,
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
  const exported = exportTarget(pkg.exports, subpath, conditions);
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
/** Non-code assets a scoped tree legitimately keeps today (test fixtures, nested tsconfigs). */
const ASSET_FILE = /\.(?:json)$/;
/** Committed generated output — checked by build-kernel.ts, not by the source rules. */
const GENERATED = `${NATIVE_KERNEL}/generated`;

/** A boundary finding that is not an import edge (file discovery, tsconfig, symlink). */
const fileViolation = (
  file: string,
  rule: string,
  specifier: string,
  message: string,
): Violation => ({
  edge: {
    from: file,
    specifier,
    typeOnly: false,
    line: 1,
    target: { kind: "unresolved", reason: "" },
  },
  rule,
  message,
});

const walk = (
  root: string,
  dir: string,
  out: { files: string[]; violations: Violation[] },
): void => {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) {
    return;
  }
  // Dirent entries are lstat results: a symlink is reported as such, never followed — a link in a
  // scoped tree is a boundary smell whatever it points at (resolveSpecifier realpaths the target).
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      out.violations.push(
        fileViolation(
          path,
          "symlink",
          path,
          "a symlinked module hides its real target — no symlinks in governed trees",
        ),
      );
      continue;
    }
    if (entry.isDirectory()) {
      // Only the package-root dist/node_modules and the committed kernel bundle are skipped —
      // and the scoped roots never contain the former, so a nested dist/generated/node_modules
      // directory is walked like any other.
      if (path !== GENERATED) {
        walk(root, path, out);
      }
      continue;
    }
    if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.files.push(path);
      continue;
    }
    if (entry.name.endsWith(".d.ts") || ASSET_FILE.test(entry.name)) {
      continue;
    }
    out.violations.push(
      fileViolation(
        path,
        "source-extension",
        entry.name,
        "non-TypeScript payload in a governed tree — .js/.cts/.mjs code escapes the source rules",
      ),
    );
  }
};

/** The files the boundaries govern and the discovery violations under them. */
const scopedTrees = (root: string): { files: string[]; violations: Violation[] } => {
  const out: { files: string[]; violations: Violation[] } = { files: [], violations: [] };
  for (const name of readdirSync(join(root, "packages"))) {
    walk(root, `packages/${name}/src`, out);
  }
  walk(root, NATIVE_KERNEL, out);
  for (const dir of ["src", "tests", "scripts"]) {
    walk(root, `${GATEWAY}/${dir}`, out);
  }
  return out;
};

/**
 * `paths`/`baseUrl` aliasing in a tsconfig that can govern bundled or governed source reroutes a
 * module behind an opaque name — the bundler honours it silently (R4 tsconfig-paths proof), so its
 * presence anywhere under a package root, a package's src or the gateway app is a violation.
 * Test-only programs (packages/*\/tests/**, tests/migration) are out of scope.
 */
const tsconfigViolations = (root: string): Violation[] => {
  const files: string[] = [];
  for (const name of readdirSync(join(root, "packages"))) {
    const dir = join(root, "packages", name);
    for (const entry of readdirSync(dir)) {
      if (/^tsconfig.*\.json$/.test(entry)) {
        files.push(`packages/${name}/${entry}`);
      }
    }
    const src = join(dir, "src");
    if (existsSync(src)) {
      const deep: string[] = [];
      const collect = (subdir: string): void => {
        for (const entry of readdirSync(subdir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            collect(join(subdir, entry.name));
          } else if (/^tsconfig.*\.json$/.test(entry.name)) {
            deep.push(relative(root, join(subdir, entry.name)).replaceAll("\\", "/"));
          }
        }
      };
      collect(src);
      files.push(...deep);
    }
  }
  const gatewayTsconfigs: string[] = [];
  const collectGateway = (subdir: string): void => {
    for (const entry of readdirSync(subdir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        collectGateway(join(subdir, entry.name));
      } else if (/^tsconfig.*\.json$/.test(entry.name)) {
        gatewayTsconfigs.push(relative(root, join(subdir, entry.name)).replaceAll("\\", "/"));
      }
    }
  };
  collectGateway(join(root, GATEWAY));
  files.push(...gatewayTsconfigs);
  return files.flatMap((file): Violation[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(root, file), "utf8")
          .replaceAll(/\/\/[^\n]*/g, "")
          .replaceAll(/\/\*[\s\S]*?\*\//g, ""),
      );
    } catch {
      return [
        fileViolation(
          file,
          "tsconfig-paths",
          file,
          "tsconfig does not parse — cannot verify it carries no path aliasing",
        ),
      ];
    }
    const options =
      isRecord(parsed) && isRecord(parsed["compilerOptions"]) ? parsed["compilerOptions"] : {};
    if (options["paths"] === undefined && options["baseUrl"] === undefined) {
      return [];
    }
    return [
      fileViolation(
        file,
        "tsconfig-paths",
        file,
        "paths/baseUrl aliases resolve modules behind opaque names — remove the alias and import by path",
      ),
    ];
  });
};

const lineAt = (source: string, offset: number): number =>
  source.slice(0, offset).split("\n").length;

const STRING_LITERAL = /^(?:(["'])(.*)\1|`([^$`]*)`)$/s;

type AstNode = { readonly type: string } & Record<string, unknown>;

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

const isIdentifier = (value: unknown, name: string): boolean =>
  isAstNode(value) && value.type === "Identifier" && value["name"] === name;

const isImportMeta = (value: unknown): boolean =>
  isAstNode(value) &&
  value.type === "MetaProperty" &&
  isIdentifier(value["meta"], "import") &&
  isIdentifier(value["property"], "meta");

/** `import.meta.url` — the second `new URL()` argument of a module-relative reference. */
const isImportMetaUrl = (value: unknown): boolean =>
  isAstNode(value) &&
  value.type === "MemberExpression" &&
  isImportMeta(value["object"]) &&
  isIdentifier(value["property"], "url");

const literalOf = (node: AstNode): string | undefined => {
  if (node.type === "Literal" && typeof node["value"] === "string") {
    return node["value"];
  }
  const { expression } = node;
  return isAstNode(expression) &&
    expression.type === "Literal" &&
    typeof expression["value"] === "string"
    ? expression["value"]
    : undefined;
};

/** Extensions a `new URL(x, import.meta.url)` module reference can load — code, not data. */
const MODULE_EXT = /\.(?:[cm]?[jt]sx?|wasm)$/;

/** The trailing static text of a template literal's last quasi, if the node is a template. */
const templateTail = (node: AstNode): string | undefined => {
  const quasis: unknown = node["quasis"];
  if (!Array.isArray(quasis) || quasis.length === 0) {
    return undefined;
  }
  const last: unknown = quasis.at(-1);
  if (!isAstNode(last)) {
    return undefined;
  }
  const value: unknown = last["value"];
  if (typeof value === "string") {
    return value;
  }
  const cooked = isRecord(value) ? value["cooked"] : undefined;
  return typeof cooked === "string" ? cooked : undefined;
};

/**
 * A module reference the module record does not list: `new URL(<spec>, import.meta.url)` (the `new
 * Worker(new URL(...))` worker-construction spelling included) and `import.meta.resolve(<spec>)`.
 * The specifier is resolved and judged like an import — a literal string, or an unresolvable
 * finding when it is computed. `new URL` is only a module reference when the specifier can name
 * code: a literal or template tail ending in another extension is a data path (fixture reads,
 * worker binaries) and stays unchecked.
 */
const moduleReference = (
  node: AstNode,
): { readonly specifier: string } | "computed" | undefined => {
  if (node.type === "NewExpression") {
    const { callee } = node;
    const args: unknown = node["arguments"];
    if (
      isIdentifier(callee, "URL") &&
      Array.isArray(args) &&
      args.length === 2 &&
      isImportMetaUrl(args[1])
    ) {
      const first: unknown = args[0];
      if (isAstNode(first)) {
        const literal = literalOf(first);
        if (literal !== undefined) {
          return MODULE_EXT.test(literal) ? { specifier: literal } : undefined;
        }
        // Computed first argument: a static tail in a data extension is provably not a module;
        // anything else cannot be checked — fail closed.
        const tail = templateTail(first);
        return tail !== undefined && !MODULE_EXT.test(tail) && tail !== "" ? undefined : "computed";
      }
    }
    return undefined;
  }
  if (node.type === "CallExpression") {
    const { callee } = node;
    const args: unknown = node["arguments"];
    if (
      isAstNode(callee) &&
      callee.type === "MemberExpression" &&
      isImportMeta(callee["object"]) &&
      isIdentifier(callee["property"], "resolve") &&
      Array.isArray(args) &&
      args.length > 0
    ) {
      const first: unknown = args[0];
      if (isAstNode(first)) {
        const literal = literalOf(first);
        return literal === undefined ? "computed" : { specifier: literal };
      }
    }
  }
  return undefined;
};

/** The CJS/glob call spellings that load modules outside the module record (rule commonjs-or-glob). */
const forbiddenCall = (node: AstNode): string | undefined => {
  if (node.type !== "CallExpression") {
    return undefined;
  }
  const { callee } = node;
  if (!isAstNode(callee)) {
    return undefined;
  }
  if (isIdentifier(callee, "require")) {
    return "require";
  }
  if (isIdentifier(callee, "createRequire")) {
    return "createRequire";
  }
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  if (isIdentifier(callee["object"], "module") && isIdentifier(callee["property"], "require")) {
    return "module.require";
  }
  return isImportMeta(callee["object"]) && isIdentifier(callee["property"], "glob")
    ? "import.meta.glob"
    : undefined;
};

/**
 * The active `exports` conditions of the real kernel bundle's resolve (the build conditions plus
 * the always-on ESM ones), used for files inside the enclave zone.
 */
export const ENCLAVE_CONDITIONS: ReadonlyArray<string> = [
  ...KERNEL_BUILD_CONDITIONS,
  "import",
  "default",
];

type Findings = { readonly edges: Edge[]; readonly violations: Violation[] };

function fileFindings(root: string, workspace: Workspace, from: string): Findings {
  const source = readFileSync(join(root, from), "utf8");
  const { module, program } = parseSync(from, source);
  const violations: Violation[] = [];
  const conditions = within(from, ...ENCLAVE_ZONE) ? ENCLAVE_CONDITIONS : undefined;
  const edge = (specifier: string, typeOnly: boolean, offset: number): Edge => ({
    from,
    specifier,
    typeOnly,
    line: lineAt(source, offset),
    target: resolveSpecifier(root, workspace, from, specifier, conditions),
  });
  // The module record has no entry for these spellings; the AST still names them:
  //   export {} from "x"        — evaluates the module (no module-record edge, bundler may keep it)
  //   import x = require("y")   — TS import-equals loads the target at runtime
  const extraEdges: Edge[] = [];
  const visit = (node: AstNode): void => {
    const call = forbiddenCall(node);
    if (call !== undefined) {
      const start = typeof node["start"] === "number" ? node["start"] : 0;
      violations.push({
        edge: {
          from,
          specifier: call,
          typeOnly: false,
          line: lineAt(source, start),
          target: { kind: "unresolved", reason: "" },
        },
        rule: "commonjs-or-glob",
        message: `${call}() loads modules the module record cannot see — use a static import`,
      });
      // A literal require target is judged by the boundary rules like any other load.
      if (call === "require" || call === "module.require") {
        const callArgs: unknown = node["arguments"];
        const argument: unknown = Array.isArray(callArgs) ? callArgs[0] : undefined;
        if (isAstNode(argument)) {
          const literal = literalOf(argument);
          if (literal !== undefined) {
            extraEdges.push(edge(literal, false, start));
          }
        }
      }
    }
    const reference = moduleReference(node);
    if (reference !== undefined) {
      const start = typeof node["start"] === "number" ? node["start"] : 0;
      if (reference === "computed") {
        extraEdges.push({
          from,
          specifier: "new URL(?, import.meta.url) / import.meta.resolve(?)",
          typeOnly: false,
          line: lineAt(source, start),
          target: {
            kind: "unresolved",
            reason: "a computed module reference cannot be checked",
          },
        });
      } else {
        extraEdges.push(edge(reference.specifier, false, start));
      }
    }
    if (
      node.type === "TSImportEqualsDeclaration" &&
      isAstNode(node["moduleReference"]) &&
      node["moduleReference"].type === "TSExternalModuleReference"
    ) {
      const literal = literalOf(node["moduleReference"]);
      const importEquals = edge(
        literal ?? "?",
        false,
        typeof node["start"] === "number" ? node["start"] : 0,
      );
      extraEdges.push(importEquals);
      violations.push({
        edge: importEquals,
        rule: "commonjs-or-glob",
        message:
          "import = require() loads modules the module record cannot see — use a static import",
      });
    }
    if (
      node.type === "ExportNamedDeclaration" &&
      isAstNode(node["source"]) &&
      Array.isArray(node["specifiers"]) &&
      node["specifiers"].length === 0
    ) {
      const literal = literalOf(node["source"]);
      if (literal !== undefined) {
        extraEdges.push(
          edge(
            literal,
            node["exportKind"] === "type",
            typeof node["start"] === "number" ? node["start"] : 0,
          ),
        );
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isAstNode(item)) {
            visit(item);
          }
        }
      } else if (isAstNode(value)) {
        visit(value);
      }
    }
  };
  for (const statement of (program as { body?: unknown[] }).body ?? []) {
    if (isAstNode(statement)) {
      visit(statement);
    }
  }
  return {
    violations,
    edges: [
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
        const match = STRING_LITERAL.exec(text);
        const literal = match?.[2] ?? match?.[3];
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
      ...extraEdges,
    ],
  };
}

/** Every boundary violation in the repository at `root`. */
export async function boundaryViolations(root: string = ROOT): Promise<Violation[]> {
  const workspace = await loadWorkspace(root);
  const scoped = scopedTrees(root);
  const findings = scoped.files.map((file) => fileFindings(root, workspace, file));
  const edges = findings.flatMap((finding) => finding.edges);
  return [
    ...scoped.violations,
    ...tsconfigViolations(root),
    ...findings.flatMap((finding) => finding.violations),
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
