/**
 * Consumer smoke: the real guard for the published web host. Packs @qntx/wallet and
 *
 * @qntx/wallet-worker like a release, installs the tarballs into a throwaway Vite app with the
 * documented consumer config (worker.format "es", optimizeDeps.exclude), builds and previews it,
 * then drives a real browser: the wallet must start (the 0.3.0 spawn form dies with "the kernel
 * port died"), Nostr must sign, and the spark chunk + spark.wasm must arrive only on first use —
 * any .js/.wasm request answered with the SPA fallback's text/html is the bundler-entry bug.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";
import { build, preview } from "vite";

const ROOT = new URL("../../..", import.meta.url).pathname;
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";
const PORT = 4287;

const run = (cmd: string, args: string[], cwd: string): void => {
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
};

const pack = (pkg: string, dest: string): string => {
  const out = execFileSync("npm", ["pack", "--pack-destination", dest], {
    cwd: join(ROOT, "packages", pkg),
    encoding: "utf8",
  }).trim();
  const name = out.split("\n").at(-1);
  if (name === undefined) {
    throw new Error("npm pack produced no tarball name");
  }
  return join(dest, name);
};

const app = mkdtempSync(join(tmpdir(), "qntx-consumer-smoke-"));
console.log("consumer app:", app);

mkdirSync(join(app, "src"), { recursive: true });
writeFileSync(
  join(app, "package.json"),
  JSON.stringify({ name: "qntx-consumer-smoke", private: true, type: "module" }, null, 2),
);
writeFileSync(
  join(app, "index.html"),
  `<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>`,
);
writeFileSync(
  join(app, "vite.config.ts"),
  `export default {
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@qntx/wallet-worker"] },
  preview: { headers: { "Content-Security-Policy": ${JSON.stringify(CSP)} } },
};`,
);
writeFileSync(
  join(app, "src/main.ts"),
  `import { createWebWallet } from "@qntx/wallet-worker/browser";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";
import { verifyEvent } from "@qntx/nostr";

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const OPTIONS = {
  passkey: { rpId: "localhost", rpName: "Smoke", walletSalt: "w", vaultSalt: "v", backupSalt: "b" },
  autoLock: { platform: "web", idleMinutes: 5 },
} as const;

declare global {
  // oxlint-disable-next-line no-var -- the page exposes the api on window
  var qntx: { run: () => Promise<Record<string, string>> };
}

globalThis.qntx = {
  async run(): Promise<Record<string, string>> {
    const wallet = await createWebWallet(OPTIONS);
    const draft = await wallet.wallets.createMnemonic({
      words: 12,
      factor: { kind: "password", password: "smoke password" },
    });
    const words = new TextDecoder().decode(draft.words.read()).split(" ");
    const created = await draft.confirm(draft.quiz.map((i) => words[i]!));
    const key = await nostr(wallet).deriveKey(created.walletId, 0);
    const event = await nostr(wallet).signer(key.ref).signEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: "consumer smoke",
      pubkey: key.publicKey,
    });
    const identity = await spark(wallet)
      .signer({ walletId: created.walletId, groupIndex: 0, network: "regtest" })
      .identityPublicKey();
    const out: Record<string, string> = {
      verified: String(verifyEvent(event)),
      identity: toHex(identity),
    };
    return out;
  },
};
`,
);

const walletTgz = pack("wallet", app);
const workerTgz = pack("wallet-worker", app);
console.log("packed:", walletTgz, workerTgz);

// npm does not auto-install peers of local tarballs: name the published peers exactly as a
// consumer would after reading the README (@qntx/wallet peers on nostr + spark).
run(
  "npm",
  [
    "install",
    "--no-audit",
    "--no-fund",
    walletTgz,
    workerTgz,
    "@qntx/nostr@0.15.1",
    "@qntx/spark@0.5.0",
    "vite@npm:@voidzero-dev/vite-plus-core@1.3.0",
  ],
  app,
);

const outDir = join(app, "dist");
await build({ configFile: false, root: app, build: { outDir }, logLevel: "warn" });

const server = await preview({
  configFile: false,
  root: app,
  build: { outDir },
  preview: {
    host: "localhost",
    port: PORT,
    strictPort: true,
    headers: { "Content-Security-Policy": CSP },
  },
  logLevel: "warn",
});

const requests: Array<{ url: string; status: number; contentType: string }> = [];

const fail = (msg: string): never => {
  throw new Error(`CONSUMER SMOKE FAILED: ${msg}`);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("response", (r) => {
    void (async () => {
      const ct = await r.headerValue("content-type");
      requests.push({ url: r.url(), status: r.status(), contentType: ct ?? "" });
    })();
  });
  await page.goto(`http://localhost:${PORT}/`);
  const result: unknown = await page.evaluate("globalThis.qntx.run()");
  if (!isRecord(result)) {
    fail(`page returned ${JSON.stringify(result)}`);
  }
  const record = result;
  // Give the response-listener microtasks a beat to land before asserting on captured types.
  await page.waitForTimeout(500);
  const badMime = requests.filter(
    (r) => /\.(js|wasm)(\?|$)/.test(r.url) && r.contentType.includes("text/html"),
  );
  const sparkBefore: string[] = [];
  // The assertions below double-check laziness by re-walking request order.
  const identityIndex = requests.findIndex((r) => /spark-[^/]*\.wasm/.test(r.url));
  for (const r of requests.slice(0, identityIndex === -1 ? requests.length : identityIndex)) {
    if (/signer-[^/]*\.js|browser-[^/]*\.js|spark-[^/]*\.wasm/.test(r.url)) {
      sparkBefore.push(r.url);
    }
  }
  if (badMime.length > 0) {
    fail(`requests answered text/html: ${badMime.map((r) => r.url).join(", ")}`);
  }
  if (record["verified"] !== "true") {
    fail(`nostr sign/verify returned ${JSON.stringify(result)}`);
  }
  if (typeof record["identity"] !== "string" || !/^[0-9a-f]{66}$/.test(record["identity"])) {
    fail(`spark identity missing: ${JSON.stringify(result)}`);
  }
  if (identityIndex === -1) {
    fail("spark.wasm was never fetched despite a spark call succeeding");
  }
  if (sparkBefore.length > 0) {
    fail(`spark payloads fetched before the wasm (eager load): ${sparkBefore.join(", ")}`);
  }
  console.log("CONSUMER SMOKE PASS — wallet started, nostr signed, spark loaded lazily");
} finally {
  await browser.close();
  server.httpServer.close();
}
