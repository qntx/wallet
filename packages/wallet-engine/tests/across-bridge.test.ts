import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import { ACROSS_SPOKEPOOLS, EVM_DELEGATOR } from "@qntx/wallet-chains/evm";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { AcrossBridgeQuote } from "../src/swaps/bridge.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const DEL_CODE = readFileSync(
  new URL("fixtures/eip7702-stateless-delegator-1.3.0.hex", import.meta.url).pathname,
  "utf8",
).trim();
const POOL = ACROSS_SPOKEPOOLS[1]!;
const USDC = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WETH_ARB = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const RELAYER = "0xFD03AbCAdaF3F930fA4E37Eb2f6ea3A44a41b7F0";
const N1 = "eip155:1";
const N8453 = "eip155:8453";
const N42161 = "eip155:42161";
const ADDR = "0xcfae4ade5ae06d1730520809c8c3db9f6c7fe7e1";
const HOST = "https://host.test/evm";
const GW = "https://gw.test";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "0a".repeat(8),
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const VERIFY = { kind: "password" as const, password: "pw" };
const logger = { warn: () => undefined };
const PRE = 10n ** 30n;

const word = (v: bigint | string): string =>
  `0x${(typeof v === "bigint" ? v.toString(16) : v).padStart(64, "0")}`;

const quote = (overrides: Partial<AcrossBridgeQuote> = {}): AcrossBridgeQuote => ({
  provider: "across",
  inputToken: USDC,
  outputToken: USDC_BASE,
  inputAmount: 10000000n,
  outputAmount: 9999000n,
  destinationNetwork: N8453,
  quoteTimestamp: 0,
  fillDeadline: 7200,
  exclusiveRelayer: RELAYER,
  exclusivityParameter: 160,
  spokePool: POOL,
  taker: ADDR,
  fetchedAt: 0,
  ...overrides,
});

const nativeQuote = (overrides: Partial<AcrossBridgeQuote> = {}): AcrossBridgeQuote =>
  quote({
    inputToken: WETH,
    outputToken: WETH_ARB,
    inputAmount: 10000000000000000n,
    outputAmount: 9980000000000000n,
    destinationNetwork: N42161,
    ...overrides,
  });

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const transferLog = (token: string, from: string, to: string, amount: bigint) => ({
  address: token,
  topics: [TRANSFER, `0x${from.slice(2).padStart(64, "0")}`, `0x${to.slice(2).padStart(64, "0")}`],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
  blockNumber: "0x1",
  transactionHash: `0x${"11".repeat(32)}`,
  transactionIndex: "0x0",
  blockHash: `0x${"22".repeat(32)}`,
  logIndex: "0x0",
});

/* `eth_simulateV1` for a deposit: the real call emits one Transfer of the input to the SpokePool
   (or the value for a native deposit); the probe blocks answer balanceOf/decimals/symbol. */
const simResult = (
  legs: { readonly inputToken: string; readonly inputAmount: bigint; readonly taker?: string },
  extra: ReadonlyArray<{ asset: string; amount: string }> = [],
  fail = false,
): ((params: unknown) => unknown) => {
  return (params: unknown) => {
    const blocks =
      (
        params as [{ blockStateCalls?: Array<{ calls?: Array<{ to?: string; data?: string }> }> }]
      )[0]?.blockStateCalls ?? [];
    return blocks.map((block, i) => {
      const calls = block.calls ?? [];
      return {
        number: `0x${(i + 1).toString(16)}`,
        hash: `0x${"00".repeat(32)}`,
        calls: calls.map((call) => {
          const data = call.data ?? "";
          if (data.startsWith("0xad5425c6")) {
            return {
              status: fail ? "0x0" : "0x1",
              returnData: "0x",
              gasUsed: "0x0",
              logs: [
                ...(legs.inputToken === WETH
                  ? []
                  : [transferLog(legs.inputToken, legs.taker ?? ADDR, POOL, legs.inputAmount)]),
                ...extra
                  .filter((c) => c.amount.startsWith("-"))
                  .map((c) =>
                    transferLog(c.asset, legs.taker ?? ADDR, POOL, BigInt(c.amount.slice(1))),
                  ),
              ],
            };
          }
          if (data.includes("70a08231") || data.includes("a9059cbb")) {
            const extraOut = extra.find(
              (c) =>
                c.amount.startsWith("-") &&
                data.toLowerCase().includes(c.asset.slice(2).toLowerCase()),
            );
            const post = data.toLowerCase().includes(legs.inputToken.slice(2).toLowerCase())
              ? PRE - legs.inputAmount
              : extraOut === undefined
                ? PRE
                : PRE - BigInt(extraOut.amount.slice(1));
            return {
              status: "0x1",
              returnData: `0x${post.toString(16).padStart(64, "0")}`,
              gasUsed: "0x0",
              logs: [],
            };
          }
          if (data.includes("313ce567")) {
            return {
              status: "0x1",
              returnData: `0x${(18).toString(16).padStart(64, "0")}`,
              gasUsed: "0x0",
              logs: [],
            };
          }
          if (data.includes("95d89b41")) {
            return {
              status: "0x1",
              returnData: `0x${"00".repeat(32)}${"00".repeat(31)}05${"544f4b454e".padEnd(64, "0")}`,
              gasUsed: "0x0",
              logs: [],
            };
          }
          return {
            status: "0x1",
            returnData: `0x${PRE.toString(16).padStart(64, "0")}`,
            gasUsed: "0x0",
            logs: [],
          };
        }),
      };
    });
  };
};

const world = (options: {
  readonly allowance?: bigint;
  readonly address?: string;
  readonly sim?: unknown;
  readonly code?: Readonly<Record<string, string>>;
  readonly chainIdHex?: string;
}) => {
  const net = "eip155:1";
  const calls: Array<{ url: string; method: string; params?: unknown }> = [];
  const signedRequests: SignRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GW}/v1/networks`) {
      return Response.json({ networks: [net] });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    calls.push({ url, method: body.method, params: body.params });
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    if (body.method === "eth_getCode") {
      const p = body.params?.[0] as string;
      return reply(
        {
          [EVM_DELEGATOR.address.toLowerCase()]: DEL_CODE,
          ...options.code,
        }[p?.toLowerCase() ?? ""] ?? "0x",
      );
    }
    if (body.method === "eth_call") {
      const call = body.params?.[0] as { data?: string } | undefined;
      const data = call?.data ?? "";
      if (data.includes("70a08231") || data.includes("f8b2cb4f") || data.includes("d4fac45d")) {
        return reply(word(PRE));
      }
      if (data.startsWith("0xdd62ed3e")) {
        return reply(word(options.allowance ?? 0n));
      }
      return reply(word(0n));
    }
    if (body.method === "eth_simulateV1") {
      const sim = options.sim ?? simResult({ inputToken: USDC, inputAmount: 10000000n });
      return reply(typeof sim === "function" ? sim(body.params) : sim);
    }
    const base: Record<string, unknown> = {
      eth_chainId: options.chainIdHex ?? "0x1",
      eth_blockNumber: "0x1",
      eth_getTransactionCount: "0x0",
      eth_estimateGas: "0x5208",
      eth_feeHistory: { baseFeePerGas: ["0x64", "0x64"], reward: [["0x1", "0x2", "0x3"]] },
      eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
      eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x1", blockHash: "0x1" },
      eth_getBlockByNumber: { number: "0x2" },
    };
    return body.method in base
      ? reply(base[body.method])
      : Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: `method not found: ${body.method}` },
        });
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [net]: [HOST] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway: { url: GW, installId: "a".repeat(32) },
  });
  const apis = {
    account: async () =>
      Promise.resolve({
        template: "evm.bip44",
        network: net,
        address: options.address ?? ADDR,
      }),
    sign: async ({ request }: { request: SignRequest }) => {
      signedRequests.push(request);
      return Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array(1) });
    },
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    wallet: {} as Wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: (n) => new Uint8Array(n).fill(3),
    setTimer: () => () => undefined,
    now: () => 0,
    logger,
    pollMs: 1,
    chains: apis,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: {} as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: fetchImpl,
    random: (n) => new Uint8Array(n).fill(4),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  const start = async () => {
    await networks.init();
    await transactions.init();
    await requests.init();
  };
  return { requests, transactions, calls, signedRequests, start };
};

const prepareBridge = async (w: ReturnType<typeof world>, q = quote()) =>
  w.requests.prepare({
    method: "evm-bridge",
    account: ACCOUNT,
    network: N1,
    quote: q,
    fee: "normal",
  });

const signTx = (r: SignRequest | undefined) =>
  (r as unknown as { tx: { type?: string; to: string; data: string; value?: string } }).tx;

describe("evm-bridge", () => {
  it("a fresh quote with enough allowance is one deposit to the SpokePool", async () => {
    const w = world({ allowance: 10000000n });
    await w.start();
    const request = await prepareBridge(w);
    await w.requests.approve(request.id, "evm-bridge", VERIFY);
    const tx = signTx(w.signedRequests[0]);
    expect(tx.to.toLowerCase()).toBe(POOL.toLowerCase());
    expect(tx.data.startsWith("0xad5425c6")).toBe(true);
    expect(tx.value).toBe("0x0");
  });

  it("a native deposit forwards exactly its amount to the SpokePool", async () => {
    const w = world({
      address: ADDR,
      sim: simResult({ inputToken: WETH, inputAmount: 10000000000000000n }),
    });
    await w.start();
    const request = await prepareBridge(w, nativeQuote());
    await w.requests.approve(request.id, "evm-bridge", VERIFY);
    const tx = signTx(w.signedRequests[0]);
    expect(tx.to.toLowerCase()).toBe(POOL.toLowerCase());
    expect(tx.value).toBe(`0x${10000000000000000n.toString(16)}`);
    expect(tx.data.startsWith("0xad5425c6")).toBe(true);
  });

  it("refuses a stale quote, a foreign taker and a spoofed SpokePool", async () => {
    const w = world({ allowance: 10000000n });
    await w.start();
    await expect(prepareBridge(w, quote({ fetchedAt: -61_000 }))).rejects.toThrow("stale");
    await expect(prepareBridge(w, quote({ taker: USDC }))).rejects.toThrow("for this account");
    await expect(prepareBridge(w, quote({ spokePool: USDC }))).rejects.toThrow("SpokePool");
  });

  it("refuses a destination without a SpokePool and out-of-range amounts", async () => {
    const w = world({ allowance: 10000000n });
    await w.start();
    await expect(prepareBridge(w, quote({ destinationNetwork: "eip155:5" }))).rejects.toThrow(
      "does not support Across",
    );
    await expect(prepareBridge(w, quote({ outputAmount: 0n }))).rejects.toThrow("output amount");
    await expect(prepareBridge(w, quote({ outputAmount: 20000000n }))).rejects.toThrow(
      "output amount",
    );
  });

  it("refuses a fill deadline that is past or beyond the protocol buffer", async () => {
    const w = world({ allowance: 10000000n });
    await w.start();
    await expect(prepareBridge(w, quote({ fillDeadline: -1 }))).rejects.toThrow("fill deadline");
    await expect(prepareBridge(w, quote({ fillDeadline: 7201 + 1 }))).rejects.toThrow(
      "fill deadline",
    );
  });

  it("batches an approve+deposit when the account is ours and the allowance is short", async () => {
    const w = world({
      allowance: 0n,
      code: {
        [ADDR.toLowerCase()]: `0xef0100${EVM_DELEGATOR.address.slice(2)}`,
        [EVM_DELEGATOR.address.toLowerCase()]: DEL_CODE,
      },
    });
    await w.start();
    const request = await prepareBridge(w);
    await w.requests.approve(request.id, "evm-bridge", VERIFY);
    const tx = signTx(w.signedRequests[0]);
    /* The batch executes approve+deposit through the delegator on the account itself. */
    expect(tx.to.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(tx.data).toContain(POOL.slice(2).toLowerCase());
  });

  it("refuses when the allowance is short and the account is not ours", async () => {
    const w = world({ allowance: 0n });
    await w.start();
    await expect(prepareBridge(w)).rejects.toThrow("approve the SpokePool");
  });

  it("refuses an unavailable simulation and a simulation with an extra outflow", async () => {
    const w = world({ allowance: 10000000n, sim: { status: "unavailable", error: "no tracer" } });
    await w.start();
    await expect(prepareBridge(w)).rejects.toThrow("simulation");
    const bad = world({
      allowance: 10000000n,
      sim: simResult({ inputToken: USDC, inputAmount: 10000000n }, [{ asset: WETH, amount: "-1" }]),
    });
    await bad.start();
    await expect(prepareBridge(bad)).rejects.toThrow("unrelated asset");
  });
});
