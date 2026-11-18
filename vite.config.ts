import { builtinModules } from "node:module";

import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

import { fmt } from "@qntx/oxfmt";
import { config as lintConfig, merge } from "@qntx/oxlint";

// oxlint REPLACES a rule's config for every override that matches a file, so a
// subtree that adds one ban must restate every ban it inherits. Each boundary
// restriction is therefore defined once below, and the BOUNDARIES zone tree
// says which files inherit, add, or lift which restrictions. The generator
// walks the tree depth-first and emits one override per zone — parents before
// children — holding the zone's COMPLETE accumulated rule config, so a deep
// override can never silently drop an ancestor's ban. Boundary overrides are
// appended after every other override and the config refuses to load when
// another override sets a boundary rule.

type ImportRestriction = {
  paths?: Array<{ name: string; message: string }>;
  patterns?: Array<{ group: string[]; message: string }>;
};

type GlobalRestriction = Array<{ name: string; message: string }>;

type Zone = {
  files: string[];
  imports?: ImportRestriction[];
  globals?: GlobalRestriction[];
  /** Inherited restrictions removed here, matched by identity. */
  lift?: Array<ImportRestriction | GlobalRestriction>;
  /** Zones that inherit this zone's accumulated restrictions. */
  within?: Zone[];
};

// The kernel runs on Node, browsers, and a bare Hermes runtime: Node builtins
// must not be imported from src.
const nodeBuiltins: ImportRestriction = {
  paths: builtinModules.map((name) => ({
    name,
    message: "Node builtin — the library must stay platform-neutral",
  })),
  patterns: [
    {
      // `*` does not cross `/`, so subpaths need their own glob.
      group: ["node:*", "node:*/**"],
      message: "Node builtin — the library must stay platform-neutral",
    },
  ],
};

// The Node host entry and its worker bundle ARE Node code — the only builtins
// they may touch are worker_threads (the worker bridge) and fs/promises
// (worker/node.ts reads the kernel bundle). The store wire (shared.ts,
// store-client.ts, subtle.ts) stays platform-neutral for the W4 browser worker.
const nodeHostBuiltins: ImportRestriction = {
  paths: builtinModules
    .filter((name) => name !== "worker_threads" && name !== "fs/promises")
    .map((name) => ({
      name,
      message: "Node builtin — the library must stay platform-neutral",
    })),
  patterns: [
    {
      group: ["node:*", "node:*/**", "!node:worker_threads", "!node:fs/promises"],
      message:
        "Node builtin — only node:worker_threads and node:fs/promises are allowed in the Node host",
    },
  ],
};

// Chain sign functions hold key material: kernel-only (AGENTS.md invariant).
// The kernel zone lifts this.
const chainSign: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/wallet-chains/*/sign"],
      message:
        "chain sign functions may only run inside the kernel — import them only from packages/wallet-kernel (and the package's own tests)",
    },
  ],
};

// @qntx/wallet-kernel is private: only the worker and native bundles load it.
const kernelPackage: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/wallet-kernel", "@qntx/wallet-kernel/**"],
      message: "@qntx/wallet-kernel is private — the host packages bundle it, never import it",
    },
  ],
};

// Backends (wasm loaders, native bindings) are injected by the host packages.
const backendPackages: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/*-wasm", "@qntx/*-wasm/**", "@qntx/*-native", "@qntx/*-native/**"],
      message: "backends are injected by the host packages, never imported directly",
    },
  ],
};

const workerPackages: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/*-worker", "@qntx/*-worker/**"],
      message: "backends are injected by the host packages, never imported by the kernel",
    },
  ],
};

// The kernel sees only the wallet's wire protocol and types — never the host.
const hostEntry: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/wallet", "@qntx/wallet/**", "!@qntx/wallet/protocol", "!@qntx/wallet/types"],
      message:
        "the kernel may only import @qntx/wallet/protocol and @qntx/wallet/types — never the host entry",
    },
  ],
};

const sparkSignerTypes: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/spark/signer"],
      message: "@qntx/spark/signer is types-only for the engine",
    },
  ],
};

// @qntx/wallet-chains is the platform-neutral chain-semantic layer: it never
// reaches back into engine/kernel/host packages. Relative imports and
// dependency imports (ox) stay unrestricted beyond the platform-neutral rules.
const chainsLeaf: ImportRestriction = {
  patterns: [
    {
      group: [
        "@qntx/wallet",
        "@qntx/wallet/**",
        "@qntx/wallet-kernel",
        "@qntx/wallet-kernel/**",
        "@qntx/wallet-engine",
        "@qntx/wallet-engine/**",
        "@qntx/wallet-worker",
        "@qntx/wallet-worker/**",
        "@qntx/wallet-native",
        "@qntx/wallet-native/**",
      ],
      message:
        "@qntx/wallet-chains is the leaf chain-semantic package — it never imports engine, kernel or host packages",
    },
  ],
};

// Core runtime files never touch @qntx/nostr or the nostr module — the ./nostr
// subpath reaches the channel through the WeakMap in internal.ts.
const walletNostrOnly: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/nostr", "@qntx/nostr/**", "./nostr", "./nostr/**"],
      message: "only packages/wallet/src/nostr may import @qntx/nostr",
    },
  ],
};

// The wire protocol never sees @qntx/nostr — even types — and never reaches
// the runtime module; protocol/nostr.ts is protocol data composed in index.ts.
const protocolNoNostr: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/nostr", "@qntx/nostr/**", "../nostr", "../nostr/**"],
      message: "src/protocol stays free of @qntx/nostr and of src/nostr",
    },
  ],
};

// The nostr subpath may use @qntx/nostr (signer types, event verification) but
// never the transport subpaths.
const nostrTransport: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/nostr/client", "@qntx/nostr/relay", "@qntx/nostr/store"],
      message: "the nostr module uses only the core, nips and signer parts of @qntx/nostr",
    },
  ],
};

// Only the nostr module may touch @qntx/nostr — even types. Inside the
// module the chatty subpaths stay banned (signing happens in the pool).
const nostrModuleOnly: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/nostr", "@qntx/nostr/**"],
      message: "only packages/wallet-kernel/src/modules/nostr may import @qntx/nostr",
    },
  ],
};

const nostrModuleBoundary: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/nostr/client", "@qntx/nostr/relay", "@qntx/nostr/store"],
      message: "the kernel uses only the core, nips and signer parts of @qntx/nostr",
    },
  ],
};

// Fiat prices are display-only: nothing that builds, approves or signs a transaction may read
// them. Only the engine's composition root (src/*.ts) imports src/prices; every subdirectory —
// transactions, requests, connect, chains, swaps and the rest — is refused it.
const pricesDisplayOnly: ImportRestriction = {
  patterns: [
    {
      group: ["../prices", "../prices/**", "../../prices", "../../prices/**"],
      message:
        "prices are display-only — only the engine composition root (src/*.ts) may import src/prices",
    },
  ],
};

// The gateway is a deployable app, not a library: its only workspace dependency
// is the engine's gateway contract, never engine runtime code or any other
// package.
const gatewayContractOnly: ImportRestriction = {
  patterns: [
    {
      group: ["@qntx/**", "!@qntx/wallet-engine/gateway/contract"],
      message:
        "apps/gateway may only import @qntx/wallet-engine/gateway/contract from the workspace",
    },
  ],
};

// Node-only and browser-only globals are both absent on Hermes; library code
// must use globalThis lookups instead.
const nodeGlobals: GlobalRestriction = [
  { name: "Buffer", message: "Node-only global — use Uint8Array" },
  { name: "process", message: "Node-only global — not available in browsers or Hermes" },
  { name: "global", message: "Node-only global — use globalThis" },
  { name: "require", message: "CJS-only — use import" },
  { name: "module", message: "CJS-only global" },
  { name: "__dirname", message: "CJS-only global" },
  { name: "__filename", message: "CJS-only global" },
  { name: "setImmediate", message: "Node-only global — use setTimeout" },
  { name: "clearImmediate", message: "Node-only global — use clearTimeout" },
];

const browserGlobals: GlobalRestriction = [
  { name: "window", message: "browser-only global — use globalThis" },
  { name: "document", message: "browser-only global — use globalThis" },
  { name: "navigator", message: "browser-only global — use globalThis" },
  { name: "location", message: "browser-only global — use globalThis" },
  { name: "localStorage", message: "browser-only global — inject a store" },
  { name: "sessionStorage", message: "browser-only global — inject a store" },
];

// Bare Hermes has no ambient timers; Session receives them through
// platform.setTimer instead.
const kernelTimers: GlobalRestriction = [
  { name: "setTimeout", message: "no ambient timers — inject platform.setTimer" },
  { name: "clearTimeout", message: "no ambient timers — use the setTimer cancel" },
  { name: "setInterval", message: "no ambient timers — inject platform.setTimer" },
  { name: "clearInterval", message: "no ambient timers — use the setTimer cancel" },
];

// One-directional layer graph for packages/wallet-kernel/src — mirrors
// AGENTS.md "Architecture invariants". Each layer is a directory; the root
// files platform.ts, errors.ts, status.ts and kernel.ts compose them.
// `modules` is the protocol-module edge: it may import core layers and core
// commands (gate, context); nothing in core may import it back.
const KERNEL_SRC = "packages/wallet-kernel/src";
const LAYERS = {
  secret: [],
  seed: ["secret"],
  derive: ["secret"],
  vault: ["secret"],
  session: ["secret", "vault"],
  commands: ["secret", "seed", "derive", "vault", "session"],
  modules: ["secret", "seed", "derive", "vault", "session", "commands"],
} as const;

const LAYER_NAMES = Object.keys(LAYERS).filter(
  (name): name is keyof typeof LAYERS => name in LAYERS,
);

// Relative import specifiers that would reach the package-root index from a
// layer file. src/ layers are flat directories, so every cross-layer import
// is a single `../` hop.
const PACKAGE_ROOT = ["..", "../", "../index", "../index.ts"];

// Forbids a layer from importing any layer outside its allow list or the
// package root.
function layerImports(layer: keyof typeof LAYERS): ImportRestriction {
  const allowed: ReadonlyArray<string> = LAYERS[layer];
  const message =
    allowed.length > 0
      ? `${layer} may only import ${allowed.join(", ")} (AGENTS.md layering)`
      : `${layer} is the leaf layer (AGENTS.md layering)`;
  const forbidden = LAYER_NAMES.filter((name) => name !== layer && !allowed.includes(name));
  return {
    patterns: [
      {
        group: [...PACKAGE_ROOT, ...forbidden.flatMap((name) => [`../${name}`, `../${name}/**`])],
        message,
      },
    ],
  };
}

// The boundary zone tree. Each zone inherits every restriction its ancestors
// accumulated, minus what it lifts.
const BOUNDARIES: Zone[] = [
  {
    // Library src is platform-neutral (Hermes) and never holds chain signers.
    files: ["packages/*/src/**"],
    imports: [nodeBuiltins, chainSign],
    globals: [nodeGlobals, browserGlobals],
    within: [
      {
        files: ["packages/wallet-chains/src/**"],
        imports: [chainsLeaf],
      },
      {
        // The engine never reaches the kernel enclave or a crypto backend —
        // host packages inject backends; the signer surface is types-only at
        // the protocol layer.
        files: ["packages/wallet-engine/src/**"],
        imports: [kernelPackage, backendPackages, sparkSignerTypes],
        within: [
          {
            files: ["packages/wallet-engine/src/*/**"],
            imports: [pricesDisplayOnly],
          },
        ],
      },
      {
        // @qntx/wallet composes the kernel but never imports it — hosts load
        // the bundle. The ban covers every src file, chains/spark included.
        files: ["packages/wallet/src/**"],
        imports: [kernelPackage],
        within: [
          {
            files: ["packages/wallet/src/*.ts"],
            imports: [walletNostrOnly],
          },
          {
            files: ["packages/wallet/src/protocol/**"],
            imports: [protocolNoNostr],
          },
          {
            files: ["packages/wallet/src/nostr/**"],
            imports: [nostrTransport],
          },
        ],
      },
      {
        files: ["packages/wallet-native/src/**"],
        imports: [kernelPackage],
      },
      {
        // The browser host entry IS browser code — Web globals are allowed
        // there, while the Node/CJS-only names stay banned.
        files: ["packages/wallet-worker/src/browser/**"],
        imports: [kernelPackage],
        lift: [browserGlobals],
      },
      {
        // The browser kernel entry and the IndexedDB store are browser code
        // too. The worker bundles the kernel, so no kernelPackage ban.
        files: [
          "packages/wallet-worker/src/worker/browser-kernel.ts",
          "packages/wallet-worker/src/worker/indexeddb.ts",
        ],
        lift: [browserGlobals],
      },
      {
        // The Node host runs real Node. It may load the bundled kernel, so no
        // kernelPackage ban here either.
        files: [
          "packages/wallet-worker/src/node/**",
          "packages/wallet-worker/src/worker/node.ts",
          "packages/wallet-worker/src/worker/node-kernel.ts",
        ],
        imports: [nodeHostBuiltins],
        lift: [nodeBuiltins],
      },
      {
        // The kernel never imports the host entry, host packages, or backend
        // packages — backends are injected by the hosts. It is the only src
        // allowed to hold chain signers.
        files: [`${KERNEL_SRC}/**`],
        imports: [hostEntry, workerPackages, backendPackages],
        globals: [kernelTimers],
        lift: [chainSign],
        within: [
          {
            // Kernel root files (index.ts, platform.ts, errors.ts, status.ts,
            // kernel.ts) compose or feed the layers; @qntx/nostr stays
            // module-only.
            files: [`${KERNEL_SRC}/*.ts`],
            imports: [nostrModuleOnly],
          },
          ...LAYER_NAMES.map((layer): Zone => ({
            files: [`${KERNEL_SRC}/${layer}/**`],
            imports: [
              layerImports(layer),
              layer === "modules" ? nostrModuleBoundary : nostrModuleOnly,
            ],
          })),
        ],
      },
    ],
  },
  {
    files: ["apps/gateway/**"],
    imports: [gatewayContractOnly],
  },
];

type OxlintOverride = (typeof lintConfig)["overrides"][number];

function boundaryOverrides(zones: Zone[]): OxlintOverride[] {
  const out: OxlintOverride[] = [];
  const walk = (
    zone: Zone,
    inherited: { imports: ImportRestriction[]; globals: GlobalRestriction[] },
  ): void => {
    const lifted = new Set<ImportRestriction | GlobalRestriction>(zone.lift);
    const imports = [...inherited.imports, ...(zone.imports ?? [])].filter(
      (restriction) => !lifted.has(restriction),
    );
    const globals = [...inherited.globals, ...(zone.globals ?? [])].filter(
      (restriction) => !lifted.has(restriction),
    );
    if (imports.length > 0 || globals.length > 0) {
      out.push({
        files: zone.files,
        rules: {
          "eslint/no-restricted-imports":
            imports.length > 0
              ? [
                  "error",
                  {
                    paths: imports.flatMap((restriction) => restriction.paths ?? []),
                    patterns: imports.flatMap((restriction) => restriction.patterns ?? []),
                  },
                ]
              : "off",
          "eslint/no-restricted-globals": globals.length > 0 ? ["error", ...globals.flat()] : "off",
        },
      });
    }
    for (const child of zone.within ?? []) {
      walk(child, { imports, globals });
    }
  };
  for (const zone of zones) {
    walk(zone, { imports: [], globals: [] });
  }
  return out;
}

// Rules owned by the boundary zone tree; no hand-written override may set them.
const BOUNDARY_RULES = ["eslint/no-restricted-imports", "eslint/no-restricted-globals"];

const otherOverrides: OxlintOverride[] = [
  {
    files: ["scripts/**", "packages/*/scripts/**"],
    rules: {
      // Maintenance scripts print their results.
      "eslint/no-console": "off",
    },
  },
  {
    files: ["packages/*/src/**"],
    rules: {
      // Hermes V1 (what React Native ships) has no ES2023 immutable array
      // methods, so the library must sort/reverse copies in place.
      "unicorn/no-array-sort": "off",
      "unicorn/no-array-reverse": "off",
    },
  },
  {
    files: ["packages/wallet-kernel/tests/**", "packages/wallet-worker/tests/hermes/**"],
    rules: {
      // The seeded PRNG (mulberry32) and the Hermes UTF-8/xorshift shims are integer
      // arithmetic on purpose.
      "eslint/no-bitwise": "off",
    },
  },
  {
    files: ["apps/gateway/**"],
    rules: {
      // Workers capture console output as the log stream.
      "eslint/no-console": "off",
    },
  },
  {
    // The memory stores implement async store contracts synchronously; the async
    // signature stays without an await.
    files: [
      "packages/wallet-kernel/src/vault/memory.ts",
      "packages/wallet-engine/src/store/memory.ts",
    ],
    rules: {
      "typescript/require-await": "off",
    },
  },
];

for (const override of otherOverrides) {
  for (const rule of BOUNDARY_RULES) {
    if (override.rules !== undefined && rule in override.rules) {
      throw new Error(
        `${rule} belongs to the boundary zone tree — a plain override for ${override.files.join(", ")} would silently replace it`,
      );
    }
  }
}

// Boundary overrides go last so nothing else can shadow an accumulated set.
const overrides = [...otherOverrides, ...boundaryOverrides(BOUNDARIES)];

const config: UserConfig = defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  test: {
    include: ["scripts/**/*.test.ts"],
  },
  lint: merge(lintConfig, {
    // merge() concatenates arrays onto the preset's own ignorePatterns.
    // crates/, target/ and .vite-hooks/ are ignored leftovers from the
    // pre-reset repository.
    ignorePatterns: [
      "crates/**",
      "target/**",
      ".vite-hooks/**",
      "vectors/**",
      "packages/wallet-native/kernel/generated/**",
      "packages/wallet-engine/src/connect/inject.generated.ts",
      // Nitrogen spec files require method signatures and are machine-consumed.
      "**/*.nitro.ts",
      // apps/harness is a standalone Expo project with its own toolchain and
      // RN types; it is deliberately outside the root lint/typecheck gates.
      "apps/harness/**",
      // The consumer template is likewise a standalone Expo scaffold: it is
      // copied to a temp dir and installed against npm/tarballs, so its imports
      // do not resolve inside the repo.
      "packages/wallet-native/tests/consumer/**",
      // Generated by `wrangler types`.
      "apps/gateway/worker-configuration.d.ts",
    ],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides,
  }),
  fmt: {
    ...fmt,
    ignorePatterns: [
      ...fmt.ignorePatterns,
      "crates/**",
      "target/**",
      ".vite-hooks/**",
      "bun.lock",
      "**/*.toml",
      // Generated vectors stay byte-frozen.
      "vectors/**",
      // Generated kernel payloads stay byte-frozen.
      "packages/wallet-native/kernel/generated/**",
      "packages/wallet-engine/src/connect/inject.generated.ts",
      // Standalone Expo app (own toolchain), see the lint ignore above.
      "apps/harness/**",
      // Generated by `wrangler types`.
      "apps/gateway/worker-configuration.d.ts",
    ],
  },
  run: { cache: process.env["CI"] === undefined || process.env["CI"] === "" },
});

export default config;
