/// <reference types="node" />
/**
 * Records the mainnet JSON-RPC and CCIP-Read exchanges of the name-resolution tests. The script
 * drives the engine's own resolvers against public endpoints; outcomes are not written — the
 * offline test derives its expectations from the recorded bytes.
 *
 * Run from the repo root: bun packages/wallet-engine/scripts/record-names.ts Endpoints can be
 * overridden with NAMES_ETH_RPC and NAMES_SOL_RPC. Set NAMES_ENS_ONLY=1 to refresh only the ENS
 * vector.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { createPublicClient, http } from "viem";

import { ccipRequest, CCIP_MAX_BYTES, CCIP_MAX_FETCHES } from "../src/names/ccip.ts";
import { lookupEns, resolveEns } from "../src/names/ens.ts";
import { lookupSns, resolveSns } from "../src/names/sns.ts";
import type { NetworkController } from "../src/networks/controller.ts";
import type { NetworkInfo } from "../src/networks/registry.ts";
import { networkById } from "../src/networks/registry.ts";

const ETH_ENDPOINT = process.env.NAMES_ETH_RPC ?? "https://ethereum-rpc.publicnode.com";
const SOL_ENDPOINT = process.env.NAMES_SOL_RPC ?? "https://solana-rpc.publicnode.com";
const OUT = new URL("../../../vectors/names/", import.meta.url);
const SCRIPT = "packages/wallet-engine/scripts/record-names.ts";

type RpcEntry = {
  readonly method: string;
  readonly params: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};
type CcipEntry = {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

const write = (file: string, value: unknown): void => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL(file, OUT), `${JSON.stringify(value, null, 2)}\n`);
};

const entryOf = (method: string, params: unknown, response: unknown): RpcEntry => {
  const row = isObject(response) ? response : {};
  return row.error === undefined
    ? { method, params, result: row.result }
    : { method, params, error: row.error };
};

/** A Solana RPC client that records every raw method/params pair without JSON-RPC ids. */
const solanaRpcRecorder = (entries: RpcEntry[]) => ({
  call: async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(SOL_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = parseJson(await res.text());
    entries.push(entryOf(method, params, body));
    const row = isObject(body) ? body : {};
    if (row.error !== undefined) {
      const message = isObject(row.error) ? row.error.message : undefined;
      throw new Error(typeof message === "string" ? message : method);
    }
    return row.result;
  },
});

/** A viem transport fetch that records JSON-RPC requests, including batch bodies. */
const evmRpcFetch = (entries: RpcEntry[]): typeof globalThis.fetch => {
  return async (input, init) => {
    const res = await fetch(input, init);
    const text = await res.text();
    try {
      const request = parseJson(typeof init?.body === "string" ? init.body : "");
      const response = parseJson(text);
      const requests: ReadonlyArray<unknown> = Array.isArray(request)
        ? (request as ReadonlyArray<unknown>)
        : [request];
      const responses: ReadonlyArray<unknown> = Array.isArray(response)
        ? (response as ReadonlyArray<unknown>)
        : [response];
      for (const [index, item] of requests.entries()) {
        if (!isObject(item) || typeof item.method !== "string") {
          continue;
        }
        const answer =
          responses.find((row) => isObject(row) && row.id === item.id) ?? responses[index];
        entries.push(entryOf(item.method, item.params ?? [], answer));
      }
    } catch {
      entries.push({ method: "unparseable", params: [], error: { status: res.status, text } });
    }
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
};

/** A CCIP fetch that records the exact gateway answer handed back to viem. */
const ccipRecordingFetch = (
  entries: CcipEntry[],
  tamper: (text: string) => string = (text) => text,
): typeof globalThis.fetch => {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await fetch(input, init);
    const original = await res.text();
    const text = tamper(original);
    entries.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text,
    });
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
};

const realTimer = (ms: number, fn: () => unknown): (() => void) => {
  const id = setTimeout(() => {
    fn();
  }, ms);
  return () => {
    clearTimeout(id);
  };
};

const chainOf = (info: NetworkInfo, endpoint: string) => ({
  id: info.chainId,
  name: info.name,
  nativeCurrency: { name: info.symbol, symbol: info.symbol, decimals: info.decimals },
  rpcUrls: { default: { http: [endpoint] } },
});

/** The same client shape as the network controller's ENS client, with recording transports. */
const recordingEnsClient = (
  info: NetworkInfo,
  rpcEntries: RpcEntry[],
  ccipEntries: CcipEntry[],
  tamper?: (text: string) => string,
) =>
  createPublicClient({
    chain: chainOf(info, ETH_ENDPOINT),
    transport: http(ETH_ENDPOINT, { fetchFn: evmRpcFetch(rpcEntries) }),
    batch: { multicall: true },
    ccipRead: {
      request: ccipRequest({
        fetch: ccipRecordingFetch(ccipEntries, tamper),
        setTimer: realTimer,
      }),
    },
  });

const registryInfo = (network: string): NetworkInfo => {
  const info = networkById(network);
  if (info === undefined) {
    throw new Error(`unknown registry network ${network}`);
  }
  return info;
};

type EnsNetworks = Pick<NetworkController, "info" | "ensClient" | "independentEnsClient">;
type SnsNetworks = Pick<NetworkController, "info" | "solanaRpc" | "independentSolanaRpc">;

const evmNetworks = (
  rpcEntries: RpcEntry[],
  ccipEntries: CcipEntry[],
  tamper?: (text: string) => string,
): EnsNetworks => ({
  info: (network: string) => registryInfo(network),
  ensClient: (network: string) =>
    recordingEnsClient(registryInfo(network), rpcEntries, ccipEntries, tamper),
  independentEnsClient: () => ({ kind: "not-needed" }),
});

/** Flip the final byte of the Basename address inside the gateway's returned hex `data`. */
const tamperHexData = (text: string): string => {
  try {
    const body = parseJson(text);
    if (!isObject(body) || typeof body.data !== "string" || !body.data.startsWith("0x")) {
      return text;
    }
    const { data } = body;
    const address = "2211d1d0020daea8039e46cf1367962070d77da9";
    if (!data.includes(address)) {
      return text;
    }
    return JSON.stringify({
      ...body,
      data: data.replace(address, `${address.slice(0, -2)}a8`),
    });
  } catch {
    return text;
  }
};

const ccipStats = (
  entries: ReadonlyArray<CcipEntry>,
  before: number,
): { count: number; size: number } => {
  let size = 0;
  for (const entry of entries.slice(before)) {
    size = Math.max(size, new TextEncoder().encode(entry.text).length);
  }
  return { count: entries.length - before, size };
};

const assertCcipBounds = (label: string, count: number, size: number): void => {
  if (count > CCIP_MAX_FETCHES || size > CCIP_MAX_BYTES) {
    throw new Error(`${label}: ccip bounds exceeded`);
  }
};

const recordEns = async (): Promise<void> => {
  const rpcEntries: RpcEntry[] = [];
  const ccipEntries: CcipEntry[] = [];
  const run = async <T>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
    const before = ccipEntries.length;
    try {
      const result = await action();
      const { count, size } = ccipStats(ccipEntries, before);
      console.log(
        `${label}: ok, ccip fetches ${count}, max response ${size} bytes — ${JSON.stringify(result)}`,
      );
      assertCcipBounds(label, count, size);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.includes("ccip bounds exceeded")) {
        throw error;
      }
      const { count } = ccipStats(ccipEntries, before);
      console.log(`${label}: threw, ccip fetches ${count} — ${String(error).split("\n")[0]}`);
      return undefined;
    }
  };

  const networks = evmNetworks(rpcEntries, ccipEntries);
  const mainnet = "eip155:1";
  const base = "eip155:8453";
  await run("vitalik forward", async () => resolveEns(networks, "vitalik.eth", mainnet));
  await run("vitalik reverse", async () =>
    lookupEns(networks, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", mainnet),
  );
  const jesse = await run("jesse.base.eth forward", async () =>
    resolveEns(networks, "jesse.base.eth", base),
  );
  const reverseBefore = ccipEntries.length;
  const basenameReverse = await run("jesse.base.eth reverse", async () =>
    lookupEns(networks, jesse?.address ?? "0x2211d1d0020daea8039e46cf1367962070d77da9", base),
  );
  const reverseCcip = ccipEntries.length - reverseBefore;

  if (basenameReverse === undefined || reverseCcip === 0) {
    console.log("basename reverse: unavailable through the Universal Resolver at this block");
  }
  await run("jesse.base.eth arbitrum reverse", async () =>
    lookupEns(
      networks,
      jesse?.address ?? "0x2211d1d0020daea8039e46cf1367962070d77da9",
      "eip155:42161",
    ),
  );

  /* Hostile forward gateway: the recorded JSON is the tampered text the client actually received. */
  const rpcHostileEntries: RpcEntry[] = [];
  const ccipHostileEntries: CcipEntry[] = [];
  const hostileNetworks = evmNetworks(rpcHostileEntries, ccipHostileEntries, tamperHexData);
  const hostileBefore = ccipHostileEntries.length;
  try {
    await resolveEns(hostileNetworks, "jesse.base.eth", base);
    throw new Error("hostile jesse.base.eth forward unexpectedly resolved");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "hostile jesse.base.eth forward unexpectedly resolved"
    ) {
      throw error;
    }
    const { count, size } = ccipStats(ccipHostileEntries, hostileBefore);
    console.log(
      `hostile jesse.base.eth forward: threw, ccip fetches ${count}, max response ${size} bytes — ${String(error).split("\n")[0]}`,
    );
    assertCcipBounds("hostile jesse.base.eth forward", count, size);
  }
  const block = await fetch(ETH_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  })
    .then(async (res) => {
      const body = parseJson(await res.text());
      return isObject(body) && typeof body.result === "string" ? body.result : undefined;
    })
    .catch(() => undefined);
  write("ens-mainnet.json", {
    provenance: {
      endpoint: ETH_ENDPOINT,
      recordedAt: new Date().toISOString(),
      ...(block === undefined ? {} : { block }),
      script: SCRIPT,
      basename: "jesse.base.eth",
      basenameReverse:
        basenameReverse === undefined || reverseCcip === 0
          ? "unavailable through the Universal Resolver at this block"
          : "ccip-backed",
    },
    rpc: rpcEntries,
    ccip: ccipEntries,
    rpcHostile: rpcHostileEntries,
    ccipHostile: ccipHostileEntries,
  });
};

const SNS_NAMES = [
  "bonfida.sns",
  "dex.bonfida.sns",
  ...Array.from({ length: 12 }, (_, i) => `sns-ip-5-wallet-${String(i + 1)}.sns`),
  ...Array.from({ length: 9 }, (_, i) => `wallet-guide-${String(i)}.sns`),
  "sub-0.wallet-guide-3.sns",
  "sub-1.wallet-guide-3.sns",
];
const SNS_LOOKUPS = [
  "FidaeBkZkvDqi1GXNEwB8uWmj9Ngx2HXSS5nyGRuVFcZ",
  "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v",
  "36Dn3RWhB8x4c83W6ebQ2C2eH9sh5bQX2nMdkP2cWaA4",
];

const recordSns = async (): Promise<void> => {
  const entries: RpcEntry[] = [];
  const rpc = solanaRpcRecorder(entries);
  const networks: SnsNetworks = {
    info: (network: string) => registryInfo(network),
    solanaRpc: () => rpc,
    independentSolanaRpc: () => ({ kind: "not-needed" }),
  };
  const network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  for (const name of SNS_NAMES) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- recording order must match resolution order
      const result = await resolveSns(networks, name, network);
      console.log(`${name}: ${result.address}`);
    } catch (error) {
      console.log(`${name}: threw — ${String(error).split("\n")[0]}`);
    }
  }
  for (const owner of SNS_LOOKUPS) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- recording order must match lookup order
      const result = await lookupSns(networks, owner, network);
      console.log(`${owner}: ${result?.name ?? "<none>"}`);
    } catch (error) {
      console.log(`${owner}: threw — ${String(error).split("\n")[0]}`);
    }
  }
  const slotResult =
    entries.length > 0 ? await rpc.call("getSlot", [{ commitment: "confirmed" }]) : undefined;
  write("sns-mainnet.json", {
    provenance: {
      endpoint: SOL_ENDPOINT,
      recordedAt: new Date().toISOString(),
      ...(typeof slotResult === "number" ? { slot: slotResult } : {}),
      script: SCRIPT,
    },
    rpc: entries,
  });
};

await recordEns();
if (process.env.NAMES_ENS_ONLY !== "1") {
  await recordSns();
}
