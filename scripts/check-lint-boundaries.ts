// Probes the boundaries end to end so they cannot silently rot: writes one
// throw-away file per expected ban — plus controls that must stay clean — into
// the real source trees, runs the import checker (check-boundaries.ts), the
// bundle checker (check-bundles.ts, on the probes marked `bundle:`) and the
// repo lint on them, and fails unless every violation produced a boundary
// finding and every control produced none. Import probes spell the same target
// every way a specifier can (package name, `./`, `..`, a path into another
// package). The expectations below are written from AGENTS.md, independently of
// the rule tables in check-boundaries.ts and vite.config.ts: that is what makes
// this an oracle rather than a restatement of the config.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boundaryViolations } from "./check-boundaries.ts";
import { bundleViolations } from "./check-bundles.ts";
import type { EntryKind } from "./check-bundles.ts";

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
  /** Extra throw-away files (`source`) or symlinks (`link`, repo-relative target) the probe needs. */
  readonly extra?: ReadonlyArray<{
    readonly path: string;
    readonly source?: string;
    readonly link?: string;
  }>;
  /** Lines temporarily appended to a committed file, restored byte-for-byte afterwards. */
  readonly append?: ReadonlyArray<{ readonly path: string; readonly lines: string }>;
  /**
   * A temporary text edit to a committed file (package.json `imports`, tsconfig `paths`), restored
   * byte-for-byte afterwards: the first occurrence of `search` is replaced by `replacement`.
   */
  readonly edit?: ReadonlyArray<{
    readonly path: string;
    readonly search: string;
    readonly replacement: string;
  }>;
  /** Other paths whose source-checker findings count towards this probe (payloads, edited configs). */
  readonly also?: ReadonlyArray<string>;
  /**
   * Build this probe (`entry`, defaulting to `file`) as an extra bundle entry of `kind`: `min`
   * requires at least that many bundle violations attributed to it, `min` absent requires the
   * entry's bundle stay clean.
   */
  readonly bundle?: { readonly kind: EntryKind; readonly entry?: string; readonly min?: number };
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
  ]
    .filter((dir) => dir !== "packages/wallet-engine/src")
    .map((dir): Probe => ({
      file: `${dir}/__lint_probe_a__.ts`,
      source: importing("@qntx/wallet-chains/evm/sign"),
      expect: fires(),
    })),
  {
    // The engine probe also builds as a `main` entry: it pins the workspace→source mapping —
    // without it the specifier lands on dist/*.mjs and the sign rule sees nothing.
    file: "packages/wallet-engine/src/__lint_probe_a__.ts",
    source: importing("@qntx/wallet-chains/evm/sign"),
    expect: fires(),
    bundle: { kind: "main", min: 1 },
  },
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

  // --- R4 load spellings: every way a module can load without a module-record edge. Each must be
  // caught by BOTH the source checker and the bundle checker, unless the spelling cannot reach a
  // bundle by construction (noted per case).

  // Case 1: CommonJS calls. Rolldown statically resolves require() into the bundle, so both layers
  // fire on 1a and 1c (1c's builtin:module external is forbidden for the main bundle); 1b
  // (module.require) is not statically resolved by rolldown — only the source check sees it, which
  // is correct: at runtime it would be a dynamic load, caught here by the spelling ban.
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_1a__.ts",
    source:
      'const s = require("../../wallet-chains/src/evm/sign.ts");\nexport const x = typeof s;\n',
    expect: fires(2),
    bundle: { kind: "main", min: 1 },
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_1b__.ts",
    source:
      'const s = module.require("../../wallet-chains/src/evm/sign.ts");\nexport const x = typeof s;\n',
    expect: fires(),
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_1c__.ts",
    source: [
      'import { createRequire } from "node:module";',
      "const r = createRequire(import.meta.url);",
      'export const x = typeof r("../../wallet-chains/src/evm/sign.ts");',
      "",
    ].join("\n"),
    expect: fires(2),
    bundle: { kind: "main", min: 1 },
  },

  // Case 2: TS import-equals — an erasableSyntaxOnly rejection at typecheck and a runtime load
  // the module record omits. The bundler still resolves and bundles the target.
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_2__.ts",
    source:
      'import s = require("../../wallet-chains/src/evm/sign.ts");\nexport const x = typeof s;\n',
    expect: fires(2),
    bundle: { kind: "main", min: 1 },
  },

  // Case 3: dynamic-import spellings. Every one fails closed at the source check (either
  // unresolvable or chain-signers) and every one is resolved by the bundler into the sign file.
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_3a__.ts",
    source: "export const m = import(`../../wallet-chains/src/evm/sign.ts`);\n",
    expect: { rule: "imports", min: 1, unresolved: true },
    bundle: { kind: "main", min: 1 },
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_3b__.ts",
    source: 'export const m = import(/* r4 */ "../../wallet-chains/src/evm/sign.ts");\n',
    expect: fires(),
    bundle: { kind: "main", min: 1 },
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_3c__.ts",
    source: 'export const m = import("../../wallet-chains/src/evm/sign.ts", { with: {} });\n',
    expect: fires(),
    bundle: { kind: "main", min: 1 },
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_3d__.ts",
    source: 'export const m = import("../../wallet-chains/src/evm/" + "sign.ts");\n',
    expect: { rule: "imports", min: 1, unresolved: true },
    bundle: { kind: "main", min: 1 },
  },

  // Case 4: non-TypeScript payloads. The source checker flags the payload's extension (it can
  // carry un-inspected code); the bundle checker sees the engine source it re-exports land.
  {
    file: `${KERNEL}/__lint_probe_r4_4a__.ts`,
    source: 'import { R4 } from "./__lint_probe_r4_payload.js";\nexport const x = R4;\n',
    extra: [
      {
        path: `${KERNEL}/__lint_probe_r4_payload.js`,
        source: `export { R4 } from "../../wallet-engine/src/engine.ts";\n`,
      },
    ],
    also: [`${KERNEL}/__lint_probe_r4_payload.js`],
    expect: fires(),
    bundle: { kind: "enclave", min: 1 },
  },
  {
    file: `${KERNEL}/__lint_probe_r4_4b__.ts`,
    source: 'import { R4 } from "./__lint_probe_r4_payload.cts";\nexport const x = R4;\n',
    extra: [
      {
        path: `${KERNEL}/__lint_probe_r4_payload.cts`,
        source: `export { R4 } from "../../wallet-engine/src/engine.ts";\n`,
      },
    ],
    also: [`${KERNEL}/__lint_probe_r4_payload.cts`],
    expect: fires(),
    bundle: { kind: "enclave", min: 1 },
  },

  // Case 5: nested dist/generated/node_modules are walked like any other directory — only the
  // committed kernel bundle (kernel/generated) is exempt. 5d's rule is prices-display-only, a
  // source-layer closure rule with no bundle counterpart, so it has no bundle expectation.
  ...["generated", "dist", "node_modules"].map((dir, index): Probe => ({
    file: `${KERNEL}/__lint_probe_r4_5${String.fromCodePoint(97 + index)}__.ts`,
    source: `import { R4 } from "./${dir}/__lint_probe_r4_payload.ts";\nexport const x = R4;\n`,
    extra: [
      {
        path: `${KERNEL}/${dir}/__lint_probe_r4_payload.ts`,
        source: `export { R4 } from "../../../wallet-engine/src/engine.ts";\n`,
      },
    ],
    also: [`${KERNEL}/${dir}/__lint_probe_r4_payload.ts`],
    expect: fires(),
    bundle: { kind: "enclave", min: 1 },
  })),
  {
    file: "packages/wallet-engine/src/transactions/__lint_probe_r4_5d__.ts",
    source:
      'import * as p from "../generated/__lint_probe_r4_prices.ts";\nexport const x = typeof p;\n',
    extra: [
      {
        path: "packages/wallet-engine/src/generated/__lint_probe_r4_prices.ts",
        source: 'export * from "../prices/controller.ts";\n',
      },
    ],
    also: ["packages/wallet-engine/src/generated/__lint_probe_r4_prices.ts"],
    expect: fires(),
  },

  // Case 6: `export {} from` is a real runtime edge the module record omits (oxc emits no
  // staticExports entry for it); the AST scan restores the edge and rolldown resolves it.
  // 6b/6c are positive controls: ordinary re-export spellings must keep firing.
  {
    file: "packages/wallet-native/kernel/__lint_probe_r4_6a__.ts",
    source: 'export {} from "../../wallet-engine/src/index.ts";\n',
    expect: fires(),
    bundle: { kind: "enclave", min: 1 },
  },
  {
    file: "packages/wallet-native/kernel/__lint_probe_r4_6b__.ts",
    source: 'export * from "../../wallet-engine/src/index.ts";\n',
    expect: fires(),
    bundle: { kind: "enclave", min: 1 },
  },
  {
    file: "packages/wallet-native/kernel/__lint_probe_r4_6c__.ts",
    source: 'export * as e from "../../wallet-engine/src/index.ts";\n',
    expect: fires(),
    bundle: { kind: "enclave", min: 1 },
  },
  {
    file: "packages/wallet/src/protocol/__lint_probe_r4_6d__.ts",
    source: 'export * as engine from "@qntx/wallet-engine";\n',
    append: [
      {
        path: "packages/wallet/src/protocol/index.ts",
        lines: 'export {} from "./__lint_probe_r4_6d__.ts";\n',
      },
    ],
    // The closure walk reaches this payload through the appended export-{}-from edge and flags its
    // engine pull; the dedicated entry file proves the same chain lands in a bundle.
    expect: fires(),
    extra: [
      {
        path: "packages/wallet/src/protocol/__lint_probe_r4_6d_entry__.ts",
        source: 'export {} from "./__lint_probe_r4_6d__.ts";\n',
      },
    ],
    bundle: {
      kind: "enclave",
      entry: "packages/wallet/src/protocol/__lint_probe_r4_6d_entry__.ts",
      min: 1,
    },
  },

  // Case 7: erased type edges stay quiet at BOTH layers — a correct outcome, not a bypass:
  // `import { type X }` / `export { type X }` emit no module request, so nothing can land.
  {
    file: "packages/wallet/src/protocol/__lint_probe_r4_7a__.ts",
    source:
      'import type { ConnectOptions } from "../wallet.ts";\nexport type { ConnectOptions };\n',
    append: [
      {
        path: "packages/wallet/src/protocol/index.ts",
        lines: 'import "./__lint_probe_r4_7a__.ts";\n',
      },
    ],
    expect: "clean",
    extra: [
      {
        path: "packages/wallet/src/protocol/__lint_probe_r4_7a_entry__.ts",
        source: 'import "./__lint_probe_r4_7a__.ts";\n',
      },
    ],
    bundle: {
      kind: "enclave",
      entry: "packages/wallet/src/protocol/__lint_probe_r4_7a_entry__.ts",
    },
  },
  {
    file: "packages/wallet/src/protocol/__lint_probe_r4_7b__.ts",
    source: 'import * as w from "../wallet.ts";\nexport const x = w;\n',
    append: [
      {
        path: "packages/wallet/src/protocol/index.ts",
        lines: 'import "./__lint_probe_r4_7b__.ts";\n',
      },
    ],
    expect: fires(),
    extra: [
      {
        path: "packages/wallet/src/protocol/__lint_probe_r4_7b_entry__.ts",
        source: 'import "./__lint_probe_r4_7b__.ts";\n',
      },
    ],
    bundle: {
      kind: "enclave",
      entry: "packages/wallet/src/protocol/__lint_probe_r4_7b_entry__.ts",
      min: 1,
    },
  },
  {
    file: "packages/wallet/src/protocol/__lint_probe_r4_7c__.ts",
    source:
      'export type { ConnectOptions as y } from "../wallet.ts";\nexport type { ConnectOptions };\n',
    append: [
      {
        path: "packages/wallet/src/protocol/index.ts",
        lines: 'export type { y } from "./__lint_probe_r4_7c__.ts";\n',
      },
    ],
    expect: "clean",
    extra: [
      {
        path: "packages/wallet/src/protocol/__lint_probe_r4_7c_entry__.ts",
        source: 'export type { y } from "./__lint_probe_r4_7c__.ts";\n',
      },
    ],
    bundle: {
      kind: "enclave",
      entry: "packages/wallet/src/protocol/__lint_probe_r4_7c_entry__.ts",
    },
  },

  // Case 8: a chains file re-exporting the engine breaks the chains-leaf rule — a source-layer
  // direction rule with no bundle-entry counterpart (a chains bundle may contain engine code
  // only if something imports it; the bundle classes encode no leaf constraint).
  {
    file: "packages/wallet-chains/src/__lint_probe_r4_8__.ts",
    source: 'export * from "../../wallet-engine/src/index.ts";\n',
    expect: fires(),
  },

  // Case 9: package.json `imports` and tsconfig `paths` reroute a bare specifier behind an opaque
  // name. The config edits are restored byte-for-byte. The `imports` field resolves through the
  // bundler's package resolution; `paths` resolves through the nearest tsconfig.json (a
  // tsconfig.src.json alias is caught by the tsconfig-paths source rule instead).
  {
    file: `${KERNEL}/__lint_probe_r4_9a__.ts`,
    source: 'import { R4 } from "#r4";\nexport const x = R4;\n',
    extra: [
      {
        path: `${KERNEL}/__lint_probe_r4_hash_marker.ts`,
        source: 'export * from "../../wallet-engine/src/engine.ts";\n',
      },
    ],
    edit: [
      {
        path: "packages/wallet-kernel/package.json",
        search: '  "exports": {',
        replacement:
          '  "imports": { "#r4": "./src/__lint_probe_r4_hash_marker.ts" },\n  "exports": {',
      },
    ],
    also: [`${KERNEL}/__lint_probe_r4_hash_marker.ts`],
    expect: fires(),
    bundle: { kind: "enclave", min: 1 },
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_9b__.ts",
    source: 'import * as s from "@r4alias";\nexport const x = typeof s;\n',
    edit: [
      {
        path: "packages/wallet-engine/tsconfig.json",
        search: '"compilerOptions": {',
        replacement:
          '"compilerOptions": {\n    "paths": { "@r4alias": ["../wallet-chains/src/evm/sign.ts"] },',
      },
    ],
    also: ["packages/wallet-engine/tsconfig.json"],
    expect: fires(),
    bundle: { kind: "main", min: 1 },
  },

  // Case 10: symlinks. The walk lstats and reports the link itself; resolution realpaths the
  // target so the importer is judged against what it actually loads.
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_10a__.ts",
    source: 'import * as s from "./__lint_probe_r4_link.ts";\nexport const x = typeof s;\n',
    extra: [
      {
        path: "packages/wallet-engine/src/__lint_probe_r4_link.ts",
        link: "../../wallet-chains/src/evm/sign.ts",
      },
    ],
    also: ["packages/wallet-engine/src/__lint_probe_r4_link.ts"],
    expect: fires(),
    bundle: { kind: "main", min: 1 },
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_10b__.ts",
    source: 'import * as s from "./__lint_probe_r4_dir/sign.ts";\nexport const x = typeof s;\n',
    extra: [
      {
        path: "packages/wallet-engine/src/__lint_probe_r4_dir",
        link: "../../wallet-chains/src/evm",
      },
    ],
    also: ["packages/wallet-engine/src/__lint_probe_r4_dir"],
    expect: fires(),
    bundle: { kind: "main", min: 1 },
  },
  {
    file: `${KERNEL}/__lint_probe_r4_10c__.ts`,
    source: 'import { R4 } from "./__lint_probe_r4_link.ts";\nexport const x = R4;\n',
    extra: [
      {
        path: `${KERNEL}/__lint_probe_r4_link.ts`,
        link: "../../wallet-engine/src/engine.ts",
      },
      {
        path: "packages/wallet-engine/src/__lint_probe_r4_marker.ts",
        source: 'export const R4 = "LANDED";\n',
      },
    ],
    also: [`${KERNEL}/__lint_probe_r4_link.ts`],
    expect: fires(),
    bundle: { kind: "enclave", min: 1 },
  },

  // Case 15: import.meta.glob, absolute paths, and the .mts/JSON-attribute controls.
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_15a__.ts",
    source: 'export const g = import.meta.glob("../../wallet-chains/src/*/sign.ts");\n',
    expect: fires(),
    bundle: { kind: "main", min: 1 },
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_15b__.ts",
    source: `import * as s from "${join(ROOT, "packages/wallet-chains/src/evm/sign.ts")}";\nexport const x = typeof s;\n`,
    expect: fires(),
    bundle: { kind: "main", min: 1 },
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_15c__.mts",
    source:
      'import * as s from "../../wallet-chains/src/evm/sign.ts";\nexport const x = typeof s;\n',
    expect: fires(),
    bundle: { kind: "main", min: 1 },
  },
  {
    file: "packages/wallet-engine/src/__lint_probe_r4_15d__.ts",
    source:
      'import data from "./__lint_probe_r4_data.json" with { type: "json" };\nexport const x = data;\n',
    extra: [
      { path: "packages/wallet-engine/src/__lint_probe_r4_data.json", source: '{ "r4": true }\n' },
    ],
    expect: "clean",
    bundle: { kind: "main" },
  },

  // The gateway reaches the workspace only through the contract entry — at the bundle layer too.
  {
    file: "apps/gateway/src/__lint_probe_r4_gw__.ts",
    source: importing("../../../packages/wallet-engine/src/engine.ts"),
    expect: fires(),
    bundle: { kind: "gateway", min: 1 },
  },
];

const created: string[] = [];
const createdDirs: string[] = [];
const restored = new Map<string, string>();
const cleanup = (): void => {
  for (const [path, original] of restored) {
    writeFileSync(path, original);
  }
  for (const file of created.toReversed()) {
    rmSync(file, { force: true, recursive: true });
  }
  for (const dir of createdDirs.toReversed()) {
    rmSync(dir, { force: true, recursive: true });
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
  if (existsSync(dir)) {
    return;
  }
  ensureDir(dirname(dir));
  mkdirSync(dir);
  createdDirs.push(dir);
};

/** Save a committed file's bytes once so `edit`/`append` restore it exactly, even on failure. */
const keepOriginal = (absolute: string): string => {
  const known = restored.get(absolute);
  if (known !== undefined) {
    return known;
  }
  const original = readFileSync(absolute, "utf8");
  restored.set(absolute, original);
  return original;
};

const rows: Array<{ file: string; ok: boolean; detail: string }> = [];
try {
  const written: Probe[] = [];
  for (const probe of PROBES) {
    for (const extra of probe.extra ?? []) {
      const absolute = join(ROOT, extra.path);
      ensureDir(dirname(absolute));
      if (extra.link === undefined) {
        writeFileSync(absolute, extra.source ?? "");
      } else {
        symlinkSync(extra.link, absolute);
      }
      created.push(absolute);
    }
    for (const edit of probe.edit ?? []) {
      const absolute = join(ROOT, edit.path);
      keepOriginal(absolute);
      const current = readFileSync(absolute, "utf8");
      if (!current.includes(edit.search)) {
        rows.push({
          file: probe.file,
          ok: false,
          detail: `edit anchor not found in ${edit.path}`,
        });
        continue;
      }
      writeFileSync(absolute, current.replace(edit.search, edit.replacement));
    }
    for (const append of probe.append ?? []) {
      const absolute = join(ROOT, append.path);
      keepOriginal(absolute);
      // Append to the CURRENT content — an earlier probe's append to the same file must survive.
      writeFileSync(absolute, `${readFileSync(absolute, "utf8")}${append.lines}`);
    }
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

  // Bundle layer: every probe that asks for it is built as an extra entry of its declared kind;
  // violations come back attributed to that entry path.
  const bundleProbes = written.filter((probe) => probe.bundle !== undefined);
  const bundleCounts = new Map<string, number>();
  if (bundleProbes.length > 0) {
    const extraEntries = [
      ...new Map(
        bundleProbes.map((probe) => [
          probe.bundle?.entry ?? probe.file,
          { file: probe.bundle?.entry ?? probe.file, kind: probe.bundle?.kind ?? "main" },
        ]),
      ).values(),
    ];
    for (const violation of await bundleViolations(ROOT, { extraEntries })) {
      bundleCounts.set(violation.entry, (bundleCounts.get(violation.entry) ?? 0) + 1);
    }
  }

  for (const probe of written) {
    const summed = { imports: 0, unresolved: 0, globals: 0 };
    for (const path of [probe.file, ...(probe.also ?? [])]) {
      const count = counts.get(path);
      if (count === undefined) {
        continue;
      }
      summed.imports += count.imports;
      summed.unresolved += count.unresolved;
      summed.globals += count.globals;
    }
    const count = summed;
    if (probe.bundle !== undefined) {
      const entry = probe.bundle.entry ?? probe.file;
      const fired = bundleCounts.get(entry) ?? 0;
      const want = probe.bundle.min;
      rows.push({
        file: probe.file,
        ok: want === undefined ? fired === 0 : fired >= want,
        detail:
          want === undefined
            ? `bundle boundaries fired ${fired}x on ${entry} (control: want 0)`
            : `bundle boundaries fired ${fired}x on ${entry} (want >= ${want})`,
      });
    }
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
