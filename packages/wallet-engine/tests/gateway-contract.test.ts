import { describe, expect, it } from "vite-plus/test";
import * as z from "zod/mini";

import {
  BITCOIN_NETWORKS,
  ESPLORA_ROUTES,
  EVM_RPC_METHODS,
  NETWORKS,
  RPC_BATCH_MAX,
  accepts,
  applyDiff,
  contains,
  decodeHashList,
  difference,
  encodeHashList,
  hashCount,
  hashList,
  union,
  SOLANA_RPC_METHODS,
  caip2,
  esploraBasePath,
  esploraGet,
  esploraPathAllowed,
  esploraPost,
  evmRpcRequest,
  gatewayError,
  health,
  installId,
  networkById,
  networksPath,
  PHISHING_MAX_PATH_SEGMENTS,
  phishingCandidates,
  phishingHash,
  phishingKey,
  phishingList,
  phishingListResponse,
  rpc,
  rpcPath,
  rpcRequest,
  rpcResponse,
  servedNetworks,
  swapQuoteRequest,
  swapQuoteResponse,
  servedNetworksResponse,
  solanaRpcRequest,
} from "../src/gateway/contract/index.ts";
import type { HashList } from "../src/gateway/contract/index.ts";
import { listOf } from "./phishing-helpers.ts";

const call = (method: string, id: number | string | null = 1, params: unknown[] = []) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params,
});
const ok = (schema: z.ZodMiniType, value: unknown): boolean => z.safeParse(schema, value).success;

const HASH = "ab".repeat(32);

describe("primitives", () => {
  it("installId is 32 lowercase hex characters", () => {
    expect(ok(installId, "0123456789abcdef0123456789abcdef")).toBe(true);
    expect(ok(installId, "0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(ok(installId, "0123456789abcdef")).toBe(false);
    expect(ok(installId, "g".repeat(32))).toBe(false);
    expect(ok(installId, undefined)).toBe(false);
  });

  it("caip2 accepts every registry network and rejects malformed ids", () => {
    for (const n of [...NETWORKS, ...BITCOIN_NETWORKS]) {
      expect(ok(caip2, n.id)).toBe(true);
    }
    for (const bad of ["", "eip155", "eip155:", ":1", "EIP155:1", "eip155:1/2", "a:b c"]) {
      expect(ok(caip2, bad)).toBe(false);
    }
  });

  it("gatewayError carries one known code", () => {
    expect(ok(gatewayError, { error: "unavailable" })).toBe(true);
    expect(ok(gatewayError, { error: "boom" })).toBe(false);
    expect(ok(gatewayError, {})).toBe(false);
  });

  it("networks come from the engine registry", () => {
    expect(networkById("eip155:11155111")?.name).toBe("Sepolia");
  });
});

describe("health", () => {
  it("responds with a literal ok", () => {
    expect(health.method).toBe("GET");
    expect(ok(health.response, { status: "ok" })).toBe(true);
    expect(ok(health.response, { status: "down" })).toBe(false);
  });
});

describe("rpc requests", () => {
  it("accepts a single call and a batch up to the cap", () => {
    expect(ok(rpcRequest, call("anything"))).toBe(true);
    expect(ok(rpcRequest, [call("a"), call("b", "x"), call("c", null)])).toBe(true);
    expect(
      ok(
        rpcRequest,
        Array.from({ length: RPC_BATCH_MAX }, () => call("a")),
      ),
    ).toBe(true);
  });

  it("rejects empty batches, oversized batches and malformed calls", () => {
    expect(ok(rpcRequest, [])).toBe(false);
    expect(
      ok(
        rpcRequest,
        Array.from({ length: RPC_BATCH_MAX + 1 }, () => call("a")),
      ),
    ).toBe(false);
    expect(ok(rpcRequest, { ...call("a"), jsonrpc: "1.0" })).toBe(false);
    expect(ok(rpcRequest, { jsonrpc: "2.0", method: "a" })).toBe(false);
    expect(ok(rpcRequest, { ...call("a"), params: "nope" })).toBe(false);
    expect(ok(rpcRequest, "text")).toBe(false);
  });

  it("evm allow-list: every listed method passes, signing and admin methods fail", () => {
    for (const m of EVM_RPC_METHODS) {
      expect(ok(evmRpcRequest, call(m))).toBe(true);
    }
    for (const m of [
      "eth_sign",
      "personal_sign",
      "eth_signTypedData",
      "eth_signTypedData_v4",
      "eth_sendTransaction",
      "eth_signTransaction",
      "eth_accounts",
      "eth_getLogs",
      "admin_peers",
      "debug_traceTransaction",
      "txpool_content",
      "miner_start",
      "getBalance",
      "eth_*",
      "",
    ]) {
      expect(ok(evmRpcRequest, call(m))).toBe(false);
    }
    expect(EVM_RPC_METHODS).toContain("eth_sendRawTransaction");
    expect(EVM_RPC_METHODS).toContain("eth_simulateV1");
  });

  it("solana allow-list: every listed method passes, others fail", () => {
    for (const m of SOLANA_RPC_METHODS) {
      expect(ok(solanaRpcRequest, call(m))).toBe(true);
    }
    for (const m of [
      "requestAirdrop",
      "getProgramAccounts",
      "eth_chainId",
      "getBalances",
      "sendBundle",
      "get",
    ]) {
      expect(ok(solanaRpcRequest, call(m))).toBe(false);
    }
    expect(SOLANA_RPC_METHODS).toContain("sendTransaction");
  });

  it("one forbidden call rejects the whole batch", () => {
    expect(ok(evmRpcRequest, [call("eth_chainId"), call("eth_sign")])).toBe(false);
    expect(ok(solanaRpcRequest, [call("getSlot"), call("requestAirdrop")])).toBe(false);
  });

  it("allow-lists contain no wildcards or duplicates", () => {
    for (const list of [EVM_RPC_METHODS, SOLANA_RPC_METHODS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const m of list) {
        expect(m).toMatch(/^[A-Za-z0-9_]+$/);
      }
    }
  });
});

describe("rpc responses", () => {
  it("accepts results, errors and batches of both", () => {
    expect(ok(rpcResponse, { jsonrpc: "2.0", id: 1, result: "0x1" })).toBe(true);
    expect(ok(rpcResponse, { jsonrpc: "2.0", id: 1, result: null })).toBe(true);
    expect(
      ok(rpcResponse, { jsonrpc: "2.0", id: "a", error: { code: -32000, message: "x" } }),
    ).toBe(true);
    expect(
      ok(rpcResponse, [
        { jsonrpc: "2.0", id: 1, result: 1 },
        { jsonrpc: "2.0", id: 2, error: { code: 3, message: "m", data: { a: 1 } } },
      ]),
    ).toBe(true);
    expect(rpc.path).toBe("/v1/rpc/:caip2");
  });

  it("rejects bodies that are neither", () => {
    expect(ok(rpcResponse, { jsonrpc: "2.0", id: 1 })).toBe(false);
    expect(ok(rpcResponse, { jsonrpc: "2.0", id: 1, error: { code: 1.5, message: "x" } })).toBe(
      false,
    );
    expect(ok(rpcResponse, { id: 1, result: 1 })).toBe(false);
    expect(ok(rpcResponse, "<html>")).toBe(false);
  });
});

describe("esplora allow-list", () => {
  it("passes exactly the engine's read surface plus POST /tx", () => {
    for (const path of [
      "/block-height/0",
      "/block-height/123456",
      "/fee-estimates",
      `/scripthash/${HASH}/txs`,
      `/scripthash/${HASH}/utxo`,
      `/tx/${HASH}/hex`,
      `/tx/${HASH}/status`,
    ]) {
      expect(esploraPathAllowed("GET", path)).toBe(true);
    }
    expect(esploraPathAllowed("POST", "/tx")).toBe(true);
    expect(ESPLORA_ROUTES).toHaveLength(7);
  });

  it("rejects other paths, verbs, traversal and malformed hashes", () => {
    for (const path of [
      "/",
      "/blocks",
      "/block-height/abc",
      "/block-height/0/extra",
      "/address/bc1qxyz/txs",
      `/scripthash/${HASH}`,
      `/scripthash/${HASH}/txs/chain`,
      `/scripthash/${"AB".repeat(32)}/txs`,
      `/scripthash/${"ab".repeat(31)}/txs`,
      `/tx/${HASH}`,
      `/tx/${HASH}/raw`,
      `/tx/${HASH}/hex/`,
      `/../tx/${HASH}/hex`,
      `/tx/${HASH}/hex?x=1`,
      "/tx",
      "/mempool",
    ]) {
      expect(esploraPathAllowed("GET", path)).toBe(false);
    }
    expect(esploraPathAllowed("POST", `/tx/${HASH}/hex`)).toBe(false);
    expect(esploraPathAllowed("POST", "/fee-estimates")).toBe(false);
    expect(esploraPathAllowed("GET", "/tx/")).toBe(false);
    expect(esploraPathAllowed("DELETE", "/tx")).toBe(false);
  });
});

describe("served networks", () => {
  it("answers with a list of CAIP-2 ids", () => {
    expect(servedNetworks.method).toBe("GET");
    expect(ok(servedNetworksResponse, { networks: [] })).toBe(true);
    expect(
      ok(servedNetworksResponse, {
        networks: ["eip155:1", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      }),
    ).toBe(true);
  });

  it("rejects malformed answers", () => {
    expect(ok(servedNetworksResponse, {})).toBe(false);
    expect(ok(servedNetworksResponse, { networks: "eip155:1" })).toBe(false);
    expect(ok(servedNetworksResponse, { networks: ["not a caip2"] })).toBe(false);
    expect(ok(servedNetworksResponse, ["eip155:1"])).toBe(false);
  });
});

describe("path helpers", () => {
  it("match the endpoint templates", () => {
    const id = "eip155:11155111";
    expect(rpcPath(id)).toBe("/v1/rpc/eip155:11155111");
    expect(rpc.path.replace(":caip2", id)).toBe(rpcPath(id));
    expect(esploraBasePath("bip122:00000008819873e925422c1ff0f99f7c")).toBe(
      "/v1/esplora/bip122:00000008819873e925422c1ff0f99f7c",
    );
    expect(`${esploraBasePath(id)}/*`).toBe(esploraGet.path.replace(":caip2", id));
    expect(esploraPost.path.replace(":caip2", id)).toBe(`${esploraBasePath(id)}/tx`);
    expect(networksPath).toBe(servedNetworks.path);
    expect(networksPath).toBe("/v1/networks");
  });
});

describe("phishing list contract", () => {
  it.each([
    ["Example.COM", "example.com"],
    ["  example.com  ", "example.com"],
    ["*.example.com", "example.com"],
    ["example.com.", "example.com"],
    ["example.com/", "example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["coinbase_prologin1.godaddysites.com", "coinbase_prologin1.godaddysites.com"],
    [
      "sites.google.com/view/launch-trezor-desktop-app",
      "sites.google.com/view/launch-trezor-desktop-app",
    ],
    ["Sites.Google.com/View/Case/", "sites.google.com/View/Case"],
    ["a.com//b///c", "a.com/b/c"],
  ])("normalizes %s to %s", (entry, key) => {
    expect(phishingKey(entry)).toBe(key);
  });

  it.each([
    "https://example.com",
    "http://example.com",
    "example.com:8080",
    "example.com:443/path",
    "example.com?x=1",
    "example.com/path?x=1",
    "example.com#top",
    "user@example.com",
    "exa mple.com",
    String.raw`example.com\path`,
    "localhost",
    "",
    "*.",
    "a..com",
    `example.com/${Array.from({ length: PHISHING_MAX_PATH_SEGMENTS + 1 }, () => "s").join("/")}`,
  ])("drops the entry %j", (entry) => {
    expect(phishingKey(entry)).toBeUndefined();
  });

  it("keeps a path of exactly the segment limit", () => {
    const path = Array.from({ length: PHISHING_MAX_PATH_SEGMENTS }, () => "s").join("/");
    expect(phishingKey(`example.com/${path}`)).toBe(`example.com/${path}`);
  });

  it("hashes to the first 8 bytes of SHA-256 over the key", () => {
    expect(phishingHash("example.com")).toStrictEqual(
      Uint8Array.from([0xa3, 0x79, 0xa6, 0xf6, 0xee, 0xaf, 0xb9, 0xa5]),
    );
    expect(phishingHash("sites.google.com/view/launch-trezor-desktop-app")).toStrictEqual(
      Uint8Array.from([0x7b, 0x65, 0x7d, 0xc5, 0x38, 0x28, 0x1f, 0xe9]),
    );
  });

  it("lists candidates from the deepest path to the registrable parents", () => {
    expect(phishingCandidates("https://Sites.Google.com/view/x/y?q=1#f")).toStrictEqual([
      "sites.google.com/view/x/y",
      "sites.google.com/view/x",
      "sites.google.com/view",
      "sites.google.com",
      "google.com",
    ]);
    expect(phishingCandidates("https://a.b.example.co.uk./")).toStrictEqual([
      "a.b.example.co.uk",
      "b.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
    expect(phishingCandidates("http://example.com")).toStrictEqual(["example.com"]);
  });

  it("caps candidate paths at the segment limit", () => {
    const segments = Array.from(
      { length: PHISHING_MAX_PATH_SEGMENTS + 3 },
      (_, i) => `s${String(i)}`,
    );
    const candidates = phishingCandidates(`https://example.com/${segments.join("/")}`);
    expect(candidates[0]).toBe(
      `example.com/${segments.slice(0, PHISHING_MAX_PATH_SEGMENTS).join("/")}`,
    );
    expect(candidates).toHaveLength(PHISHING_MAX_PATH_SEGMENTS + 1);
  });

  it("gives an IP address only its full host", () => {
    expect(phishingCandidates("http://192.168.1.10/login")).toStrictEqual(["192.168.1.10"]);
    expect(phishingCandidates("http://[2001:db8::1]/login")).toStrictEqual(["[2001:db8::1]"]);
  });

  it.each(["ftp://example.com", "file:///etc/hosts", "data:text/html,x", "not a url", ""])(
    "gives %j no candidates",
    (url) => {
      expect(phishingCandidates(url)).toStrictEqual([]);
    },
  );

  it("accepts the three response kinds and rejects malformed ones", () => {
    const hashes = "AAAAAAAAAAA=";
    const delta = { add: hashes, remove: "" };
    for (const body of [
      { kind: "current", version: 1 },
      { kind: "diff", from: 1, version: 2, deny: delta, allow: delta },
      { kind: "snapshot", version: 2, deny: hashes, allow: "" },
    ]) {
      expect(accepts(phishingListResponse, body)).toBe(true);
    }
    for (const body of [
      { kind: "current" },
      { kind: "current", version: -1 },
      { kind: "current", version: 1.5 },
      { kind: "snapshot", version: 1, deny: "not base64!", allow: "" },
      { kind: "diff", from: 1, version: 2, deny: delta },
      { kind: "other", version: 1 },
    ]) {
      expect(accepts(phishingListResponse, body)).toBe(false);
    }
  });

  it("takes an optional decimal since", () => {
    expect(accepts(phishingList.request, {})).toBe(true);
    expect(accepts(phishingList.request, { since: "1700000000000" })).toBe(true);
    for (const since of ["", "-1", "1.5", "abc", "1234567890123456"]) {
      expect(accepts(phishingList.request, { since })).toBe(false);
    }
  });
});

const keysIn = (list: HashList, candidates: ReadonlyArray<string>): string[] =>
  candidates.filter((key) => contains(list, phishingHash(key)));

describe("hash lists", () => {
  it("round-trips a sorted list through base64", () => {
    const list = listOf(["a.com", "b.com", "c.com"]);
    expect(decodeHashList(encodeHashList(list))).toStrictEqual(list);
  });

  it("treats the empty string as an empty list", () => {
    expect(decodeHashList("")).toStrictEqual(new Uint8Array());
    expect(contains(new Uint8Array(), phishingHash("a.com"))).toBe(false);
  });

  it("rejects a length that is not a multiple of 8", () => {
    expect(decodeHashList(encodeHashList(new Uint8Array(12)))).toBeUndefined();
    expect(decodeHashList(encodeHashList(new Uint8Array([1, 2, 3])))).toBeUndefined();
  });

  it("rejects unsorted, duplicated and non-base64 input", () => {
    const sorted = listOf(["a.com", "b.com"]);
    const swapped = new Uint8Array([...sorted.subarray(8), ...sorted.subarray(0, 8)]);
    const duplicated = new Uint8Array([...sorted.subarray(0, 8), ...sorted.subarray(0, 8)]);
    expect(decodeHashList(encodeHashList(swapped))).toBeUndefined();
    expect(decodeHashList(encodeHashList(duplicated))).toBeUndefined();
    expect(decodeHashList("not base64!")).toBeUndefined();
  });

  it("finds exactly the members", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `host${String(i)}.com`);
    const list = listOf(keys);
    expect(keysIn(list, keys)).toHaveLength(200);
    expect(keysIn(list, ["other.com", "host200.com", "host.com"])).toStrictEqual([]);
  });

  it("applies a diff as (list - remove) + add, keeping order", () => {
    const list = listOf(["a.com", "b.com", "c.com"]);
    const next = applyDiff(list, listOf(["d.com", "b.com"]), listOf(["a.com", "missing.com"]));
    expect(next).toStrictEqual(listOf(["b.com", "c.com", "d.com"]));
    expect(decodeHashList(encodeHashList(next))).toStrictEqual(next);
  });

  it("builds a sorted, deduplicated set from any order", () => {
    const hashes = ["c.com", "a.com", "b.com", "a.com"].map((key) => phishingHash(key));
    const list = hashList(hashes);
    expect(list).toHaveLength(24);
    expect(hashCount(list)).toBe(3);
    expect(decodeHashList(encodeHashList(list))).toStrictEqual(list);
    expect(hashList([])).toStrictEqual(new Uint8Array());
  });

  it("takes the union of two sets", () => {
    expect(union(listOf(["a.com", "b.com"]), listOf(["b.com", "c.com"]))).toStrictEqual(
      listOf(["a.com", "b.com", "c.com"]),
    );
    expect(union(listOf(["a.com"]), new Uint8Array())).toStrictEqual(listOf(["a.com"]));
  });

  it("takes the difference of two sets", () => {
    expect(
      difference(listOf(["a.com", "b.com", "c.com"]), listOf(["b.com", "x.com"])),
    ).toStrictEqual(listOf(["a.com", "c.com"]));
    expect(difference(listOf(["a.com"]), listOf(["a.com"]))).toStrictEqual(new Uint8Array());
    expect(difference(new Uint8Array(), listOf(["a.com"]))).toStrictEqual(new Uint8Array());
  });

  it("applies empty diffs as the identity", () => {
    const list = listOf(["a.com"]);
    expect(applyDiff(list, new Uint8Array(), new Uint8Array())).toStrictEqual(list);
    expect(applyDiff(new Uint8Array(), listOf(["a.com"]), new Uint8Array())).toStrictEqual(list);
  });
});

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The pre-fast-path normalization: every entry through `new URL`. */
function referenceKey(entry: string): string | undefined {
  let raw = entry.trim();
  if (raw.startsWith("*.")) {
    raw = raw.slice(2);
  }
  if (raw === "" || /:\/\/|[?#@\\\s]/.test(raw)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    return undefined;
  }
  if ((raw.split("/")[0] ?? "").includes(":")) {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || labels.includes("")) {
    return undefined;
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return host;
  }
  return segments.length > PHISHING_MAX_PATH_SEGMENTS ? undefined : `${host}/${segments.join("/")}`;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) % 4_294_967_296;
    return Math.abs(state) / 4_294_967_296;
  };
}

describe("phishingKey fast path", () => {
  it("returns exactly what the URL parser path returns", () => {
    const random = seeded(7);
    const alphabet = "abcdeXYZ019-_.. :/*~xn";
    const pick = (): string => alphabet.charAt(Math.floor(random() * alphabet.length));
    const generated = Array.from({ length: 20_000 }, () =>
      Array.from({ length: 1 + Math.floor(random() * 24) }, pick).join(""),
    );
    const fixed = [
      "example.com",
      "a.b.c.example.co.uk",
      "example.com.",
      "EXAMPLE.com",
      "1.2.3.4",
      "1.2.3",
      "0x7f.1",
      "999.1.1.1",
      "a.1",
      "1.example",
      "xn--bcher-kva.example",
      "xn--zz.example",
      "-a-.com",
      "a_b.com",
      "a..com",
      ".com",
      "com",
      `${"x".repeat(250)}.com`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`,
      "tld-with-hyphen.a-b",
      "coinbase_prologin1.godaddysites.com",
    ];
    const mismatches = [...fixed, ...generated].filter(
      (entry) => phishingKey(entry) !== referenceKey(entry),
    );
    expect(mismatches).toStrictEqual([]);
  });
});

function shuffle(items: Uint8Array[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = items[i]!;
    items[i] = items[j]!;
    items[j] = swap;
  }
}

describe("hashList at scale", () => {
  it("matches a naive sort-and-dedupe over a large shuffled input with duplicates", () => {
    const random = seeded(11);
    const count = 20_000;
    const hashes = Array.from({ length: count }, (_, i) => {
      const hash = new Uint8Array(8);
      for (let k = 0; k < 8; k += 1) {
        hash[k] = Math.floor(random() * 256);
      }
      // Force collisions on the high bytes so the radix passes see long equal runs.
      hash[0] = i % 7;
      hash[1] = i % 3;
      return hash;
    });
    const duplicated = [...hashes, ...hashes.filter((_, i) => i % 5 === 0)];
    shuffle(duplicated, random);
    const expected = [...new Set(duplicated.map(hexOf))].toSorted();
    const list = hashList(duplicated);
    expect(hashCount(list)).toBe(expected.length);
    expect(
      Array.from({ length: hashCount(list) }, (_, i) => hexOf(list.subarray(i * 8, i * 8 + 8))),
    ).toStrictEqual(expected);
    expect(decodeHashList(encodeHashList(list))).toStrictEqual(list);
  });
});

describe("swapQuote", () => {
  const AH = "0x0000000000001fF3684f28c67538d4D072C22734";
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const TAKER = "0x8f3796aa4dB3f47E0fE0D19f9c3c96a51aD5f0F8";

  it("validates the request: an eip155 network, hex tokens, a positive sellAmount, bps 1-5000", () => {
    const good = {
      network: "eip155:1",
      sellToken: USDC,
      buyToken: NATIVE,
      sellAmount: "1000000",
      taker: TAKER,
      slippageBps: 100,
    };
    expect(accepts(swapQuoteRequest, good)).toBe(true);
    expect(accepts(swapQuoteRequest, { ...good, network: "bip122:x" })).toBe(false);
    expect(accepts(swapQuoteRequest, { ...good, sellToken: "usdc" })).toBe(false);
    expect(accepts(swapQuoteRequest, { ...good, sellAmount: "0" })).toBe(false);
    expect(accepts(swapQuoteRequest, { ...good, slippageBps: 0 })).toBe(false);
    expect(accepts(swapQuoteRequest, { ...good, slippageBps: 5001 })).toBe(false);
    expect(accepts(swapQuoteRequest, { ...good, slippageBps: 1.5 })).toBe(false);
  });

  it("a filled response carries the exec calldata and the quote's terms", () => {
    const filled = {
      liquidity: true,
      provider: "0x",
      sellToken: USDC,
      buyToken: WETH,
      sellAmount: "1000000",
      buyAmount: "400000000000000",
      minBuyAmount: "380000000000000",
      allowanceTarget: AH,
      transaction: { to: AH, data: "0x2213bc0b00", value: "0", gas: "210000" },
      fees: { integrator: null, zeroEx: { token: USDC, amount: "500" } },
      blockNumber: "21000000",
    };
    expect(accepts(swapQuoteResponse, filled)).toBe(true);
    expect(accepts(swapQuoteResponse, { liquidity: false })).toBe(true);
    /* `transaction.gas` may be null; a non-hex address or a bad data string is rejected. */
    expect(
      accepts(swapQuoteResponse, {
        ...filled,
        transaction: { ...filled.transaction, gas: null },
      }),
    ).toBe(true);
    expect(
      accepts(swapQuoteResponse, { ...filled, transaction: { ...filled.transaction, data: "zz" } }),
    ).toBe(false);
    expect(accepts(swapQuoteResponse, { ...filled, allowanceTarget: "nope" })).toBe(false);
  });
});
