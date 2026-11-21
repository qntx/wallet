/// <reference types="node" />
/**
 * Bundles the platform-neutral entries minified and enforces their gzip budgets:
 *
 * - `index`: the main entry, bundled with every package dependency external, so the number is the
 *   engine's own code — what a host that never touches apps pays. The bundle must also stay free of
 *   apps markers (the Hyperliquid base URL and the `@nktkas/hyperliquid` specifier survive
 *   minification), proving the apps entry never leaks into the main one.
 * - `apps`: the `@qntx/wallet-engine/apps` entry with `@qntx/*` workspace packages external (they are
 *   the host's peer deps) and the Hyperliquid SDK bundled — the apps entry's own incremental cost.
 * - `walletconnect`: the `@qntx/wallet-engine/walletconnect` entry with the same `@qntx/*` and
 *   engine-dependency externals, but the WalletKit/WalletConnect SDK bundled — the entry's own
 *   incremental cost (our glue + the SDK). The index bundle must stay free of its markers.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

type BunBuildOutput = {
  success: boolean;
  logs: ReadonlyArray<{ toString: () => string }>;
  outputs: ReadonlyArray<{ kind: string; text: () => Promise<string> }>;
};
declare const Bun: {
  build: (options: {
    entrypoints: string[];
    target: "browser";
    format: "esm";
    minify: boolean;
    packages?: "external";
    external?: ReadonlyArray<string>;
  }) => Promise<BunBuildOutput>;
};

const root = fileURLToPath(new URL("..", import.meta.url));

type Entry = {
  readonly name: string;
  readonly source: string;
  readonly budget: number;
  /** `true` → `packages: "external"` for every dep, or an explicit specifier list. */
  readonly external: true | ReadonlyArray<string>;
  /** Literals that must not appear in the (minified) bundle. */
  readonly forbidden: ReadonlyArray<string>;
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- package.json has a fixed shape
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

/** The `@qntx/*` workspace packages and every engine dependency but the WalletConnect SDK. */
const WALLETCONNECT_EXTERNAL = [
  ...Object.keys(pkg.peerDependencies),
  "@qntx/wallet/chains",
  "@qntx/wallet/hyperliquid",
  ...Object.keys(pkg.dependencies).filter(
    (name) => !name.startsWith("@reown/") && !name.startsWith("@walletconnect/"),
  ),
];

const ENTRIES: ReadonlyArray<Entry> = [
  {
    name: "index",
    source: "src/index.ts",
    /* 131 kB with the TRON family, the extra EVM fee models and the nonce/tracking fixes. */
    budget: 136 * 1024,
    external: true,
    forbidden: [
      "@nktkas/hyperliquid",
      "api.hyperliquid",
      "@walletconnect/",
      "@reown/",
      "relay.walletconnect",
    ],
  },
  {
    name: "apps",
    source: "src/apps/index.ts",
    /* Layer 5: the eligibility contract + zod/mini validator join the bundle (~6 kB). */
    budget: 26 * 1024,
    external: ["@qntx/wallet", "@qntx/wallet/chains", "@qntx/wallet/hyperliquid"],
    forbidden: [],
  },
  {
    name: "walletconnect",
    source: "src/walletconnect/index.ts",
    /* measured 418760 B gzipped — our glue plus WalletKit, the sign client and the core. */
    budget: 409 * 1024,
    external: WALLETCONNECT_EXTERNAL,
    forbidden: [],
  },
];

const measure = async (name: string, external: true | ReadonlyArray<string>): Promise<string> => {
  /* Bun emits a facade for a barrel-file entry, so measure a synthetic `export *` entry — the
     same shape a real consumer's bundler sees. */
  const result = await Bun.build({
    entrypoints: [resolve(root, ".size-check", `${name}.ts`)],
    target: "browser",
    format: "esm",
    minify: true,
    packages: external === true ? "external" : undefined,
    external: external === true ? undefined : external,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(String(log));
    }
    throw new Error(`engine-size ${name}: bundle failed`);
  }
  const texts = await Promise.all(result.outputs.map(async (output) => output.text()));
  return texts.join("\n");
};

async function main(): Promise<number> {
  let failed = false;
  const dir = resolve(root, ".size-check");
  try {
    mkdirSync(dir, { recursive: true });
    for (const { name, source } of ENTRIES) {
      writeFileSync(resolve(dir, `${name}.ts`), `export * from "../${source}";\n`);
    }
    for (const entry of ENTRIES) {
      // oxlint-disable-next-line no-await-in-loop -- sequential keeps each build's output ordered
      const text = await measure(entry.name, entry.external);
      const gzip = gzipSync(Buffer.from(text)).length;
      console.log(`engine-size ${entry.name}: ${gzip} B gzipped (budget ${entry.budget} B)`);
      if (gzip > entry.budget) {
        console.error(`engine-size ${entry.name}: budget exceeded`);
        failed = true;
      }
      for (const marker of entry.forbidden) {
        if (text.includes(marker)) {
          console.error(`engine-size ${entry.name}: bundle contains ${marker}`);
          failed = true;
        }
      }
    }
  } catch {
    failed = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
