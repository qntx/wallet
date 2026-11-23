/// <reference types="node" />
/**
 * Bundles the platform-neutral entries minified and enforces their gzip budgets:
 *
 * - `index`: the main entry, bundled with every package dependency external, so the number is the
 *   engine's own code — what a host that never touches apps pays. The bundle must also stay free of
 *   apps markers (the Hyperliquid base URL and the `@nktkas/hyperliquid` specifier survive
 *   minification), proving the apps entry never leaks into the main one.
 * - `apps`, `apps-fiat24`, `apps-hyperliquid`, `apps-polymarket`: the `@qntx/wallet-engine/apps` core
 *   entry and the three provider sub-entries, each with `@qntx/*` workspace packages external (they
 *   are the host's peer deps). The core must stay free of every venue's markers — providers only
 *   reach a bundle through their own sub-entry — and of every provider dir name under src/apps,
 *   read from the filesystem at run time and matched case-insensitively like the other markers.
 * - `walletconnect`: the `@qntx/wallet-engine/walletconnect` entry with the same `@qntx/*` and
 *   engine-dependency externals, but the WalletKit/WalletConnect SDK bundled — the entry's own
 *   incremental cost (our glue + the SDK). The index bundle must stay free of its markers.
 * - `push`: the `@qntx/wallet-engine/push` opener with nothing external — notification extensions
 *   ship the bundle standalone, so the number includes @noble/@scure. It must stay free of zod,
 *   which the wire-format module deliberately avoids.
 * - `qr`: the `@qntx/wallet-engine/qr` air-gapped codec layer with `@qntx/*` external like `apps`;
 *   the bundled share is the UR/CBOR transport plus the viem/ox codecs the decoders pull.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "@qntx/wallet/sessions",
  ...Object.keys(pkg.dependencies).filter(
    (name) => !name.startsWith("@reown/") && !name.startsWith("@walletconnect/"),
  ),
];

/** Every provider dir under src/apps is a forbidden marker in the core bundle, folded lowercase. */
const PROVIDER_DIRS = readdirSync(resolve(root, "src/apps"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name.toLowerCase());

const ENTRIES: ReadonlyArray<Entry> = [
  {
    name: "index",
    source: "src/index.ts",
    /* Measured 173 412 B on the merged tree: the approvals lane's 156 692 B plus the NFT
       controller (accepted +6 KiB index increase), the notifications controller, the versioned
       backup controller with cloud transports and the hardware-wallet custody handling. */
    budget: 172 * 1024,
    external: true,
    forbidden: [
      "@nktkas/hyperliquid",
      "api.hyperliquid",
      "polymarket.com",
      "@qntx/fiat24",
      "api.fiat24",
      "@walletconnect/",
      "@reown/",
      "relay.walletconnect",
    ],
  },
  {
    name: "apps",
    source: "src/apps/index.ts",
    /* Measured 9779 B: the controller (incl. the app storage + prune) + shared socket core —
       no provider ships in this entry. The merge added ~740 B: per-app eligibility answers
       (a record keyed by app id) and the per-definition AppRequests stamping. */
    budget: 10 * 1024,
    external: ["@qntx/wallet", "@qntx/wallet/chains", "@qntx/wallet/sessions"],
    forbidden: [
      ...PROVIDER_DIRS,
      "@nktkas/hyperliquid",
      "api.hyperliquid",
      "polymarket.com",
      "@qntx/fiat24",
      "api.fiat24",
    ],
  },
  {
    name: "apps-fiat24",
    source: "src/apps/fiat24/index.ts",
    /* Measured 115557 B: the bundled @qntx/fiat24 SDK (read actions, flows state machines, the
       REST/session client, deployments, zod schemas) + the viem client core, plus the provider
       itself — errors, the corroborating rpc transport, owner/account reads, the live view, the
       enablement record machine, the signer bridge, flows and sessions. */
    budget: 118 * 1024,
    external: ["@qntx/wallet", "@qntx/wallet/chains", "@qntx/wallet/sessions"],
    forbidden: ["@nktkas/hyperliquid", "api.hyperliquid", "polymarket.com"],
  },
  {
    name: "apps-hyperliquid",
    source: "src/apps/hyperliquid/index.ts",
    /* Measured 19372 B (base drift from the earlier 18798 — the provider's own modules, led by
       enable/exchange/actions, plus valibot): the Hyperliquid SDK client + zod/mini + the
       provider (incl. the CCTP deposit reads through the injected networks client). */
    budget: 20 * 1024,
    external: ["@qntx/wallet", "@qntx/wallet/chains", "@qntx/wallet/sessions"],
    forbidden: ["polymarket.com", "@qntx/fiat24", "api.fiat24"],
  },
  {
    name: "apps-polymarket",
    source: "src/apps/polymarket/index.ts",
    /* Measured 40497 B: the full Polymarket client (markets, account, L2 signing + credential
       store, orders, relayer, enable, live market + user channels, funding) incl. viem hashing,
       the order-corrections channel with defensive cancels, and the on-chain deposit-wallet
       verification. */
    budget: 40 * 1024,
    external: ["@qntx/wallet", "@qntx/wallet/chains", "@qntx/wallet/sessions"],
    forbidden: ["@nktkas/hyperliquid", "api.hyperliquid", "@qntx/fiat24", "api.fiat24"],
  },
  {
    name: "push",
    source: "src/push/index.ts",
    /* Measured 5828 B: the opener plus its full dependency closure — @noble/ciphers AES-GCM and
       @scure/base bundled so the number is what a notification extension pays. */
    budget: 7 * 1024,
    external: [],
    forbidden: ["zod"],
  },
  {
    name: "qr",
    source: "src/qr/index.ts",
    /* Measured 71723 B: the bounded scanner, request/response/export codecs and the inspect-only
       digest helpers plus their bundled viem/ox/dcbor closure — the @qntx/* workspace packages
       (ur, wallet, wallet-chains) are the host's peer deps and stay external. */
    budget: 76 * 1024,
    external: ["@qntx/*"],
    forbidden: [],
  },
  {
    name: "gateway-contract",
    source: "src/gateway/contract/index.ts",
    /* Measured 40573 B: the zod schemas and parsers of every contract endpoint — what the
       gateway app and a validating host pay for the wire contract alone. */
    budget: 42 * 1024,
    external: ["@qntx/wallet", "@qntx/wallet/chains", "@qntx/wallet/sessions"],
    forbidden: [
      "@nktkas/hyperliquid",
      "api.hyperliquid",
      "polymarket.com",
      "@qntx/fiat24",
      "api.fiat24",
      "@walletconnect/",
      "@reown/",
    ],
  },
  {
    name: "idb",
    source: "src/idb/indexeddb.ts",
    /* Measured 9187 B: the IndexedDB public store and its record cipher — the browser host's
       durable-store entry. */
    budget: 10 * 1024,
    external: ["@qntx/wallet", "@qntx/wallet/chains", "@qntx/wallet/sessions"],
    forbidden: [
      "@nktkas/hyperliquid",
      "polymarket.com",
      "@qntx/fiat24",
      "@walletconnect/",
      "@reown/",
    ],
  },
  {
    name: "connect",
    source: "src/connect/index.ts",
    /* Measured 135618 B: the injected provider script and the message bridge with its EVM,
       Solana, Bitcoin, TRON and Nostr surfaces plus the codecs they pull. */
    budget: 136 * 1024,
    external: ["@qntx/wallet", "@qntx/wallet/chains", "@qntx/wallet/sessions"],
    forbidden: [
      "@nktkas/hyperliquid",
      "api.hyperliquid",
      "polymarket.com",
      "@qntx/fiat24",
      "api.fiat24",
      "@walletconnect/",
      "@reown/",
    ],
  },
  {
    name: "walletconnect",
    source: "src/walletconnect/index.ts",
    /* Measured 18806 B: our session glue only — WalletKit, the sign client and the core are
       optional peers the host installs and bundler-external here. */
    budget: 20 * 1024,
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
      const folded = text.toLowerCase();
      for (const marker of entry.forbidden) {
        if (folded.includes(marker)) {
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
