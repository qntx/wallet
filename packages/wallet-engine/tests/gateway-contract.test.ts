import { describe, expect, it } from "vite-plus/test";
import * as z from "zod/mini";

import {
  BITCOIN_NETWORKS,
  ESPLORA_ROUTES,
  EVM_RPC_METHODS,
  NETWORKS,
  RPC_BATCH_MAX,
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
  rpc,
  rpcPath,
  rpcRequest,
  rpcResponse,
  servedNetworks,
  servedNetworksResponse,
  solanaRpcRequest,
} from "../src/gateway/contract/index.ts";

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
