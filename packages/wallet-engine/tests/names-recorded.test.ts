// oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect, unicorn/prefer-ternary -- one row carries either an address or the exact refusal class
import { readFileSync } from "node:fs";

import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { ccipRequest } from "../src/names/ccip.ts";
import { lookupEns, resolveEns } from "../src/names/ens.ts";
import { lookupSns, resolveSns, SNS_MAINNET } from "../src/names/sns.ts";
import { NameDisagreementError } from "../src/names/types.ts";
import type { NetworkController, SolanaRpc } from "../src/networks/controller.ts";
import { networkById } from "../src/networks/registry.ts";
import type { NetworkInfo } from "../src/networks/registry.ts";

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
type EnsVector = {
  readonly rpc: ReadonlyArray<RpcEntry>;
  readonly ccip: ReadonlyArray<CcipEntry>;
  readonly rpcHostile: ReadonlyArray<RpcEntry>;
  readonly ccipHostile: ReadonlyArray<CcipEntry>;
};
type SnsVector = { readonly rpc: ReadonlyArray<RpcEntry> };

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;
const ensVector = parseJson(
  readFileSync(new URL("../../../vectors/names/ens-mainnet.json", import.meta.url), "utf8"),
) as EnsVector;
const snsVector = parseJson(
  readFileSync(new URL("../../../vectors/names/sns-mainnet.json", import.meta.url), "utf8"),
) as SnsVector;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item as unknown)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

const rpcKey = (method: string, params: unknown): string => `${method}\n${canonical(params)}`;

const rpcMap = (entries: ReadonlyArray<RpcEntry>): Map<string, RpcEntry> => {
  const map = new Map<string, RpcEntry>();
  for (const entry of entries) {
    const key = rpcKey(entry.method, entry.params);
    if (!map.has(key)) {
      map.set(key, entry);
    }
  }
  return map;
};

const ENS_RPC = rpcMap(ensVector.rpc);
const ENS_HOSTILE_RPC = rpcMap(ensVector.rpcHostile);
const SNS_RPC = rpcMap(snsVector.rpc);

const recordedRpc = (map: Map<string, RpcEntry>, method: string, params: unknown): RpcEntry => {
  const entry = map.get(rpcKey(method, params));
  if (entry === undefined) {
    throw new Error(`unrecorded rpc request ${rpcKey(method, params)}`);
  }
  return entry;
};

const evmRpcFetch = (
  entries: Map<string, RpcEntry>,
  mutateResult?: (result: string) => string,
): typeof globalThis.fetch => {
  // oxlint-disable-next-line typescript/require-await -- the fetch seam is asynchronous
  return async (_input, init) => {
    const request = parseJson(typeof init?.body === "string" ? init.body : "");
    const requests = Array.isArray(request) ? request : [request];
    const responses = requests.map((row) => {
      if (typeof row !== "object" || row === null) {
        throw new Error("malformed replayed rpc request");
      }
      const item = row as {
        readonly id?: unknown;
        readonly method?: unknown;
        readonly params?: unknown;
      };
      if (typeof item.method !== "string") {
        throw new TypeError("malformed replayed rpc method");
      }
      const entry = recordedRpc(entries, item.method, item.params ?? []);
      if (entry.error !== undefined) {
        return { jsonrpc: "2.0", id: item.id ?? null, error: entry.error };
      }
      const result =
        typeof entry.result === "string" && mutateResult !== undefined
          ? mutateResult(entry.result)
          : entry.result;
      return { jsonrpc: "2.0", id: item.id ?? null, result };
    });
    return Response.json(Array.isArray(request) ? responses : responses[0]);
  };
};

const ccipFetch = (entries: ReadonlyArray<CcipEntry>): typeof globalThis.fetch => {
  // oxlint-disable-next-line typescript/require-await -- the fetch seam is asynchronous
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    const entry = entries.find(
      (row) => row.url === url && row.method === method && row.body === body,
    );
    if (entry === undefined) {
      throw new Error(`unrecorded ccip request ${method} ${url}`);
    }
    return new Response(entry.text, {
      status: entry.status,
      headers: { "content-type": entry.contentType },
    });
  };
};

const timer = (ms: number, fn: () => unknown): (() => void) => {
  const id = setTimeout(() => {
    fn();
  }, ms);
  return () => {
    clearTimeout(id);
  };
};

const chainOf = (info: NetworkInfo) => ({
  id: info.chainId,
  name: info.name,
  nativeCurrency: { name: info.symbol, symbol: info.symbol, decimals: info.decimals },
  rpcUrls: { default: { http: ["https://replayed.invalid"] } },
});

const evmClient = (network: string, hostile = false, mutateResult?: (result: string) => string) => {
  const info = networkById(network);
  if (info === undefined) {
    throw new Error(`unknown network ${network}`);
  }
  const rpcEntries = hostile ? ENS_HOSTILE_RPC : ENS_RPC;
  const ccipEntries = hostile ? ensVector.ccipHostile : ensVector.ccip;
  return createPublicClient({
    chain: chainOf(info),
    transport: http("https://replayed.invalid", {
      fetchFn: evmRpcFetch(rpcEntries, mutateResult),
    }),
    batch: { multicall: true },
    ccipRead: { request: ccipRequest({ fetch: ccipFetch(ccipEntries), setTimer: timer }) },
  });
};

const flipHex = (result: string): string =>
  result.replace(
    "d8da6bf26964af9d7eed9e03e53415d37aa96045",
    "d8da6bf26964af9d7eed9e03e53415d37aa96046",
  );

const evmNetworks = (
  independent: "same" | "mutated" | "not-needed" = "same",
  hostile = false,
): Pick<NetworkController, "info" | "ensClient" | "independentEnsClient"> => ({
  info: (network) => {
    const info = networkById(network);
    if (info === undefined) {
      throw new Error(`unknown network ${network}`);
    }
    return info;
  },
  ensClient: (network) => evmClient(network, hostile),
  independentEnsClient: (network) =>
    independent === "not-needed"
      ? { kind: "not-needed" }
      : {
          kind: "available",
          source: "host",
          client: evmClient(network, hostile, independent === "mutated" ? flipHex : undefined),
        },
});

const solanaRpc = (mutateFirstAccount = false): SolanaRpc => ({
  call: async (method, params) => {
    const entry = recordedRpc(SNS_RPC, method, params);
    if (entry.error !== undefined) {
      const message =
        typeof entry.error === "object" && entry.error !== null && "message" in entry.error
          ? String(entry.error.message)
          : method;
      return Promise.reject(new Error(message));
    }
    if (!mutateFirstAccount) {
      return Promise.resolve(entry.result);
    }
    const clone = parseJson(JSON.stringify(entry.result)) as {
      value?: ReadonlyArray<{ data?: [string, string] } | null>;
    };
    const account = clone.value?.find((row) => row !== null);
    const data = account?.data?.[0];
    if (account?.data !== undefined && data !== undefined) {
      account.data[0] = `${data.slice(0, -1)}${data.endsWith("A") ? "B" : "A"}`;
    }
    return Promise.resolve(clone);
  },
});

const snsNetworks = (
  independent: "same" | "mutated" | "not-needed" = "same",
): Pick<NetworkController, "info" | "solanaRpc" | "independentSolanaRpc"> => ({
  info: (network) => {
    const info = networkById(network);
    if (info === undefined) {
      throw new Error(`unknown network ${network}`);
    }
    return info;
  },
  solanaRpc: () => solanaRpc(),
  independentSolanaRpc: () =>
    independent === "not-needed"
      ? { kind: "not-needed" }
      : {
          kind: "available",
          source: "host",
          client: solanaRpc(independent === "mutated"),
        },
});

describe("recorded ENS mainnet vectors", () => {
  it("resolves vitalik.eth forward", async () => {
    await expect(resolveEns(evmNetworks(), "vitalik.eth", "eip155:1")).resolves.toMatchObject({
      name: "vitalik.eth",
      address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      checks: [],
      risk: [],
    });
  });

  it("resolves vitalik.eth reverse", async () => {
    await expect(
      lookupEns(evmNetworks(), "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "eip155:1"),
    ).resolves.toMatchObject({
      name: "vitalik.eth",
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    });
  });

  it("resolves jesse.base.eth forward through the recorded Coinbase CCIP gateway", async () => {
    const result = await resolveEns(evmNetworks(), "jesse.base.eth", "eip155:8453");
    expect(result.address).toBe("0x2211d1d0020daea8039e46cf1367962070d77da9");
    expect(ensVector.ccip.length).toBeGreaterThan(0);
  });

  it("does not show a Basename primary through the ENS Universal Resolver at the recording block", async () => {
    await expect(
      lookupEns(evmNetworks(), "0x2211d1d0020daea8039e46cf1367962070d77da9", "eip155:8453"),
    ).resolves.toBeUndefined();
  });

  it("does not show the Basename as an Arbitrum primary", async () => {
    await expect(
      lookupEns(evmNetworks(), "0x2211d1d0020daea8039e46cf1367962070d77da9", "eip155:42161"),
    ).resolves.toBeUndefined();
  });

  it("refuses the tampered Basename CCIP answer through the recorded on-chain callback", async () => {
    await expect(
      resolveEns(evmNetworks("not-needed", true), "jesse.base.eth", "eip155:8453"),
    ).rejects.toThrow('ENS name "jesse.base.eth" does not resolve');
    expect(ensVector.ccipHostile.length).toBeGreaterThan(0);
    expect(ensVector.rpcHostile.some((entry) => entry.error !== undefined)).toBe(true);
  });

  it("throws when the independent endpoint changes one eth_call byte", async () => {
    await expect(resolveEns(evmNetworks("mutated"), "vitalik.eth", "eip155:1")).rejects.toThrow(
      NameDisagreementError,
    );
  });
});

/*
 * SNS rows are derived from the recorded account bytes, not copied from resolver output. SDK
 * comments are the oracle values in js/tests/sns/resolve.test.ts and tests/primary.test.ts. Our
 * policy is stricter by design: a SOL record is only a consistency proof of the registry owner, so
 * content pointing elsewhere refuses; PDA/tokenized owners refuse; stale primaries are not shown.
 */
const SNS_FORWARD: ReadonlyArray<
  readonly [
    name: string,
    outcome: { readonly address?: string; readonly refused?: string },
    sdk: string,
  ]
> = [
  ["bonfida.sns", { address: "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v" }, "registry owner"],
  ["dex.bonfida.sns", { refused: "does not resolve" }, "derivation fixture; no live .sns account"],
  [
    "sns-ip-5-wallet-1.sns",
    { refused: "program-derived address" },
    "SDK follows a record to ALd1XSrQMCPSRayYUoUZnp6KcP6gERfJhWzkP49CkXKs",
  ],
  [
    "sns-ip-5-wallet-2.sns",
    { refused: "SOL record v2 points away" },
    "SDK follows a record to AxwzQXhZNJb9zLyiHUQA12L2GL7CxvUNrp6neee6r3cA",
  ],
  [
    "sns-ip-5-wallet-3.sns",
    { refused: "SOL record v2 points away" },
    "SDK rejects WrongValidation",
  ],
  [
    "sns-ip-5-wallet-4.sns",
    { refused: "SOL record v2 points away" },
    "SDK follows a record to 7PLHHJawDoa4PGJUK3mUnusV7SEVwZwEyV5csVzm86J4",
  ],
  [
    "sns-ip-5-wallet-5.sns",
    { refused: "program-derived address" },
    "SDK allows PDA owner 96GKJgm2W3P8Bae78brPrJf4Yi9AN1wtPJwg2XVQ2rMr",
  ],
  [
    "sns-ip-5-wallet-6.sns",
    { refused: "program-derived address" },
    "SDK rejects PdaOwnerNotAllowed",
  ],
  [
    "sns-ip-5-wallet-7.sns",
    { refused: "SOL record v1 points away" },
    "SDK follows a record to 53Ujp7go6CETvC7LTyxBuyopp5ivjKt6VSfixLm1pQrH",
  ],
  [
    "sns-ip-5-wallet-8.sns",
    { refused: "SOL record v1 points away" },
    "SDK follows a record to ALd1XSrQMCPSRayYUoUZnp6KcP6gERfJhWzkP49CkXKs",
  ],
  [
    "sns-ip-5-wallet-9.sns",
    { address: "ALd1XSrQMCPSRayYUoUZnp6KcP6gERfJhWzkP49CkXKs" },
    "SDK owner",
  ],
  [
    "sns-ip-5-wallet-10.sns",
    { refused: "program-derived address" },
    "SDK allows PDA owner 96GKJgm2W3P8Bae78brPrJf4Yi9AN1wtPJwg2XVQ2rMr",
  ],
  [
    "sns-ip-5-wallet-11.sns",
    { refused: "program-derived address" },
    "SDK rejects PdaOwnerNotAllowed",
  ],
  [
    "sns-ip-5-wallet-12.sns",
    { refused: "SOL record v2 points away" },
    "SDK rejects WrongValidation",
  ],
  [
    "wallet-guide-0.sns",
    { refused: "program-derived address" },
    "SDK follows owner/record path to Fxuoy3gFjfJALhwkRcuKjRdechcgffUApeYAfMWck6w8",
  ],
  [
    "wallet-guide-1.sns",
    { refused: "program-derived address" },
    "SDK follows owner/record path to 36Dn3RWhB8x4c83W6ebQ2C2eH9sh5bQX2nMdkP2cWaA4",
  ],
  [
    "wallet-guide-2.sns",
    { refused: "SOL record v1 points away" },
    "SDK follows a record to 36Dn3RWhB8x4c83W6ebQ2C2eH9sh5bQX2nMdkP2cWaA4",
  ],
  ["wallet-guide-3.sns", { address: "Fxuoy3gFjfJALhwkRcuKjRdechcgffUApeYAfMWck6w8" }, "SDK owner"],
  [
    "wallet-guide-4.sns",
    { refused: "SOL record v1 points away" },
    "SDK follows a record to Hf4daCT4tC2Vy9RCe9q8avT68yAsNJ1dQe6xiQqyGuqZ",
  ],
  [
    "wallet-guide-5.sns",
    { refused: "program-derived address" },
    "SDK follows owner/record path to Fxuoy3gFjfJALhwkRcuKjRdechcgffUApeYAfMWck6w8",
  ],
  [
    "wallet-guide-6.sns",
    { refused: "SOL record v1 points away" },
    "SDK follows a v2 record to Hf4daCT4tC2Vy9RCe9q8avT68yAsNJ1dQe6xiQqyGuqZ",
  ],
  [
    "wallet-guide-7.sns",
    { refused: "SOL record v2 points away" },
    "not in the SDK's positive fixture rows",
  ],
  [
    "wallet-guide-8.sns",
    { refused: "SOL record v2 points away" },
    "SDK follows a v2 record to 36Dn3RWhB8x4c83W6ebQ2C2eH9sh5bQX2nMdkP2cWaA4",
  ],
  [
    "sub-0.wallet-guide-3.sns",
    { address: "Fxuoy3gFjfJALhwkRcuKjRdechcgffUApeYAfMWck6w8" },
    "SDK owner",
  ],
  [
    "sub-1.wallet-guide-3.sns",
    { address: "Hf4daCT4tC2Vy9RCe9q8avT68yAsNJ1dQe6xiQqyGuqZ" },
    "SDK owner",
  ],
];

describe("recorded SNS mainnet vectors", () => {
  it.each(SNS_FORWARD)("%s", async (name, outcome) => {
    const promise = resolveSns(snsNetworks(), name, SNS_MAINNET);
    if (outcome.address === undefined) {
      await expect(promise).rejects.toThrow(outcome.refused ?? "");
    } else {
      await expect(promise).resolves.toMatchObject({ name, address: outcome.address });
    }
  });

  it("hides the stale bonfida primary", async () => {
    await expect(
      lookupSns(snsNetworks(), "FidaeBkZkvDqi1GXNEwB8uWmj9Ngx2HXSS5nyGRuVFcZ", SNS_MAINNET),
    ).resolves.toBeUndefined();
  });

  it("shows the live couponvault.sns primary", async () => {
    await expect(
      lookupSns(snsNetworks(), "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v", SNS_MAINNET),
    ).resolves.toMatchObject({ name: "couponvault.sns" });
  });

  it("hides the tokenized primary", async () => {
    await expect(
      lookupSns(snsNetworks(), "36Dn3RWhB8x4c83W6ebQ2C2eH9sh5bQX2nMdkP2cWaA4", SNS_MAINNET),
    ).resolves.toBeUndefined();
  });

  it("throws when the independent endpoint changes one account byte", async () => {
    await expect(resolveSns(snsNetworks("mutated"), "bonfida.sns", SNS_MAINNET)).rejects.toThrow(
      NameDisagreementError,
    );
  });
});
