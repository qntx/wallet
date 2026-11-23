import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

import { fmt } from "@qntx/oxfmt";
import { config as lintConfig, merge } from "@qntx/oxlint";

import { ENCLAVE_ZONE } from "./scripts/enclave-zone.ts";

// Import boundaries are enforced on resolved module paths by scripts/check-boundaries.ts; this
// file holds the ambient-global half. oxlint REPLACES a rule's config for every override that
// matches a file, so a subtree that adds one ban must restate every ban it inherits. Each global
// restriction is therefore defined once below, and the BOUNDARIES zone tree says which files
// inherit, add, or lift which restrictions. The generator walks the tree depth-first and emits one
// override per zone — parents before children — holding the zone's COMPLETE accumulated rule
// config, so a deep override can never silently drop an ancestor's ban. Boundary overrides are
// appended after every other override and the config refuses to load when another override sets
// a boundary rule.

type GlobalRestriction = Array<{ name: string; message: string }>;

type Zone = {
  files: string[];
  globals?: GlobalRestriction[];
  /** Inherited restrictions removed here, matched by identity. */
  lift?: GlobalRestriction[];
  /**
   * An allow-list instead of a deny-list: only the ECMAScript built-ins and these names are
   * defined, and any other free identifier is an error.
   */
  allowOnly?: Record<string, "readonly">;
  /** Zones that inherit this zone's accumulated restrictions. */
  within?: Zone[];
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

// The bare Hermes kernel runtime installs only these beyond the ES built-ins (design/enclave.mdx
// "运行时全局对象"); timers, fetch, console and the rest reach the kernel through KernelPlatform.
const ENCLAVE_GLOBALS: Record<string, "readonly"> = {
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  crypto: "readonly",
};

// Built-ins the allow-list would otherwise admit: `globalThis.x` reaches any host global around
// the allow-list, and the runtime hides Intl.
const enclaveBuiltins: GlobalRestriction = [
  {
    name: "globalThis",
    message: "kernel code uses only the enclave globals — reach the host through KernelPlatform",
  },
  { name: "Intl", message: "the kernel runtime does not provide Intl" },
];

// The boundary zone tree. Each zone inherits every restriction its ancestors
// accumulated, minus what it lifts.
const BOUNDARIES: Zone[] = [
  {
    // Library src is platform-neutral (Hermes).
    files: ["packages/*/src/**"],
    globals: [nodeGlobals, browserGlobals],
    within: [
      {
        // The browser host entry IS browser code — Web globals are allowed
        // there, while the Node/CJS-only names stay banned.
        files: ["packages/wallet-worker/src/browser/**"],
        lift: [browserGlobals],
      },
      {
        // The browser kernel entry and the IndexedDB store are browser code too.
        files: [
          "packages/wallet-worker/src/worker/browser-kernel.ts",
          "packages/wallet-worker/src/worker/indexeddb.ts",
        ],
        lift: [browserGlobals],
      },
    ],
  },
  {
    // Everything the kernel bundle may contain runs in bare Hermes: an allow-list, last so it
    // replaces the library deny-list for these files.
    files: ENCLAVE_ZONE.map((path) => (path.endsWith(".ts") ? path : `${path}/**`)),
    globals: [enclaveBuiltins],
    allowOnly: ENCLAVE_GLOBALS,
  },
];

type OxlintOverride = (typeof lintConfig)["overrides"][number];

function boundaryOverrides(zones: Zone[]): OxlintOverride[] {
  const out: OxlintOverride[] = [];
  const walk = (
    zone: Zone,
    inherited: { globals: GlobalRestriction[]; allowOnly: Record<string, "readonly"> | undefined },
  ): void => {
    const lifted = new Set<GlobalRestriction>(zone.lift);
    const globals = [...inherited.globals, ...(zone.globals ?? [])].filter(
      (restriction) => !lifted.has(restriction),
    );
    const allowOnly = zone.allowOnly ?? inherited.allowOnly;
    out.push({
      files: zone.files,
      ...(allowOnly === undefined
        ? {}
        : { env: { builtin: true, browser: false, node: false }, globals: allowOnly }),
      rules: {
        "eslint/no-restricted-globals": globals.length > 0 ? ["error", ...globals.flat()] : "off",
        "eslint/no-undef": allowOnly === undefined ? "off" : ["error", { typeof: true }],
      },
    });
    for (const child of zone.within ?? []) {
      walk(child, { globals, allowOnly });
    }
  };
  for (const zone of zones) {
    walk(zone, { globals: [], allowOnly: undefined });
  }
  return out;
}

// Rules owned by the boundary zone tree; no hand-written override may set them.
const BOUNDARY_RULES = ["eslint/no-restricted-globals", "eslint/no-undef"];

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
    files: [
      "packages/wallet-kernel/tests/**",
      "packages/wallet-worker/tests/hermes/**",
      "packages/wallet-engine/tests/hermes/**",
    ],
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
      // Recorded Fiat24 API/RPC bodies stay byte-frozen (provenance in each SOURCE.json).
      "packages/wallet-engine/tests/fixtures/fiat24/**",
      // Generated kernel payloads stay byte-frozen.
      "packages/wallet-native/kernel/generated/**",
      "packages/wallet-engine/src/connect/inject.generated.ts",
      // Standalone Expo app (own toolchain), see the lint ignore above.
      "apps/harness/**",
      // Generated by `wrangler types`.
      "apps/gateway/worker-configuration.d.ts",
      // Generated by API Extractor via scripts/check-api.ts.
      "packages/*/api/**",
    ],
  },
  run: { cache: process.env["CI"] === undefined || process.env["CI"] === "" },
});

export default config;
