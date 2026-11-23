/// <reference types="node" />
/**
 * Records the Arbitrum One JSON-RPC answers the Fiat24 SDK's `loadAccount` issues into
 * packages/wallet-engine/tests/fixtures/fiat24/rpc-<name>.json — `{source, recordedAt, calls:
 * [{method, params, result}]}` — so engine tests replay real wire data through the faked
 * primary/independent endpoints.
 *
 * Three owners: `live` resolves the owner of Fiat24 account #469709 on-chain (`getAccount` by
 * tokenId — never hard-coded) and records its `loadAccount`; `no-account` records the same read for
 * the abandon×11+about mnemonic's `evm.bip44` index-2 address
 * (0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A), which owns no token; and `closed` records the
 * mnemonic's first address (0x9858EfFD232B4033E47d90003D41EC34EcaEda94), which on-chain owns the
 * closed account #72347 — the wallet test kernel derives that address for group 0, so its real view
 * is recorded rather than a hypothetical one.
 *
 * Run from the repo root: bun scripts/vectors/fiat24-rpc-recordings.ts
 */
/* oxlint-disable typescript/no-unsafe-type-assertion -- the SDK is loaded through a require anchored at the engine package */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, custom } from "viem";
import type { Client } from "viem";
import { arbitrum } from "viem/chains";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = resolve(ROOT, "../packages/wallet-engine/tests/fixtures/fiat24");
const SOURCE = "https://arb1.arbitrum.io/rpc";
const TOKEN_ID = 469709n;
/* `evm.bip44` index 0 and 2 of the abandon×11+about test mnemonic — index 0 owns the closed
   account #72347 (the public test mnemonic was registered on-chain at some point), index 2 owns
   nothing. */
const CLOSED = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as const;
const NO_ACCOUNT = "0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A" as const;

type RecordedCall = {
  readonly method: string;
  readonly params: unknown;
  readonly result: unknown;
};

/* The SDK's `AccountStatus` union — spelled out here because the recorder cannot type-import the
   engine-installed package. */
type AccountStatus = "na" | "soft-blocked" | "tourist" | "blocked" | "closed" | "live";

type LiveView = {
  readonly step: AccountStatus | "stale";
  readonly account: { readonly tokenId: bigint };
  readonly iban: string | undefined;
};

/* `@qntx/fiat24` is installed only for @qntx/wallet-engine — the require is anchored at that
   package so the recorder runs from the repo root like its siblings. */
const engineRequire = createRequire(resolve(ROOT, "../packages/wallet-engine/package.json"));
const { getAccount } = (await import(engineRequire.resolve("@qntx/fiat24/chain"))) as {
  getAccount: (
    client: Client,
    args: { tokenId: bigint },
  ) => Promise<{ readonly owner: `0x${string}` } | undefined>;
};
const { loadAccount } = (await import(engineRequire.resolve("@qntx/fiat24/flows"))) as {
  loadAccount: (
    deps: { readonly client: Client },
    args: { readonly owner: `0x${string}` },
  ) => Promise<{ readonly step: "no-account" } | LiveView>;
};

const rpc = async (method: string, params: unknown): Promise<unknown> => {
  const response = await fetch(SOURCE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    (body as Record<string, unknown>)["error"] !== undefined
  ) {
    throw new Error(`${method}: ${JSON.stringify(body)}`);
  }
  return (body as Record<string, unknown>)["result"];
};

const recordingClient = (calls: RecordedCall[]) =>
  createClient({
    chain: arbitrum,
    transport: custom(
      {
        request: async (args: { method: string; params?: unknown }): Promise<unknown> => {
          const result = await rpc(args.method, args.params);
          calls.push({ method: args.method, params: args.params, result });
          return result;
        },
      },
      { retryCount: 0 },
    ),
  });

const record = async (
  name: string,
  run: (calls: RecordedCall[]) => Promise<void>,
): Promise<void> => {
  const calls: RecordedCall[] = [];
  await run(calls);
  const fixture = { source: SOURCE, recordedAt: Date.now(), calls };
  writeFileSync(resolve(OUT, `rpc-${name}.json`), `${JSON.stringify(fixture)}\n`);
  console.log(`rpc-${name}.json ${calls.length} calls`);
};

mkdirSync(OUT, { recursive: true });

/* The owner of #469709, resolved on-chain — the recording never embeds it by hand. */
const resolver = recordingClient([]);
const account = await getAccount(resolver, { tokenId: TOKEN_ID });
if (account === undefined) {
  throw new Error(`account ${TOKEN_ID} no longer exists on Arbitrum One`);
}
const { owner } = account;
console.log(`account ${TOKEN_ID} owner ${owner}`);

await record("live", async (calls) => {
  const view = await loadAccount({ client: recordingClient(calls) }, { owner });
  if (view.step === "no-account") {
    throw new Error(`${owner} resolved to no account`);
  }
  console.log(`live: tokenId ${view.account.tokenId} status ${view.step} iban ${view.iban ?? "-"}`);
});

await record("closed", async (calls) => {
  const view = await loadAccount({ client: recordingClient(calls) }, { owner: CLOSED });
  if (view.step === "no-account") {
    throw new Error(`${CLOSED} no longer owns an account`);
  }
  console.log(`closed: tokenId ${view.account.tokenId} status ${view.step}`);
});

await record("no-account", async (calls) => {
  const view = await loadAccount({ client: recordingClient(calls) }, { owner: NO_ACCOUNT });
  if (view.step !== "no-account") {
    throw new Error(`${NO_ACCOUNT} unexpectedly owns an account`);
  }
  console.log("no-account: empty view recorded");
});
