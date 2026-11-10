import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import { ALLOWANCE_HOLDER, EVM_DELEGATOR, EVM_NATIVE_ASSET } from "@qntx/wallet-chains/evm";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { ZeroExSwapQuote } from "../src/swaps/index.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const AH_CODE = readFileSync(
  new URL("fixtures/allowance-holder.hex", import.meta.url).pathname,
  "utf8",
).trim();
const DEL_CODE = readFileSync(
  new URL("fixtures/eip7702-stateless-delegator-1.3.0.hex", import.meta.url).pathname,
  "utf8",
).trim();
const AH = ALLOWANCE_HOLDER;
const USDC = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BUY_TOKEN = "0x19993B3Cf15c1055063468EB932F5e335A7526ea";
const SETTLER = "0xaddC26a3854feaBFd20d6BF658254088D83a425A";
const RECIPIENT = "0xcfae4ade5ae06d1730520809c8c3db9f6c7fe7e1";
const N1 = "eip155:1";
const ADDR = RECIPIENT;
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

const word = (v: bigint | string): string =>
  `0x${(typeof v === "bigint" ? v.toString(16) : v).padStart(64, "0")}`;
const addr = (a: string): string => `0x${a.slice(2).padStart(64, "0")}`;

/* The real `exec` calldata from vectors/chains/evm-zerox.json's erc20-sell-usdc. */
const EXEC_DATA =
  "0x2213bc0b000000000000000000000000addc26a3854feabfd20d6bf658254088d83a425a000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000000989680000000000000000000000000addc26a3854feabfd20d6bf658254088d83a425a00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000009e41fff991f000000000000000000000000cfae4ade5ae06d1730520809c8c3db9f6c7fe7e100000000000000000000000019993b3cf15c1055063468eb932f5e335a7526ea0000000000000000000000000000000000000000000000000002abce25fe32d700000000000000000000000000000000000000000000000000000000000000a0d43fc4c186731a584d861dd71d49ab0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000000000000000000000000000000000000000034000000000000000000000000000000000000000000000000000000000000005200000000000000000000000000000000000000000000000000000000000000660000000000000000000000000000000000000000000000000000000000000084000000000000000000000000000000000000000000000000000000000000000e4c1fb425e000000000000000000000000addc26a3854feabfd20d6bf658254088d83a425a000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000009896800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006af08fb900000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000012438c9c147000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000ad01c20d5886137e056775af56915de824c8fce50000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a468f5ee25000000000000000000000000addc26a3854feabfd20d6bf658254088d83a425a000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000ffffffffffffffc50000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000490f424000000000000000000000000000000001000276a401c02aaa39b223fe8d0a0e5c4f27ead9083c756cc280000000000a23d11bf40eb3162de69924b6ca4960c0fa3e80c4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010438c9c147000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000242e1a7d4d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a468f5ee25000000000000000000000000addc26a3854feabfd20d6bf658254088d83a425a000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee00000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000ffffffffffffffc50000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000490f424000000000000000000000000000000001000276a40119993b3cf15c1055063468eb932f5e335a7526ea00000000003c15e5e7206c661a1e881f5cd33a94eaf2328fa8cc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a45f80abae000000000000000000000000f5c4f3dc02c3fb9279495a8fef7b0741da95615700000000000000000000000019993b3cf15c1055063468eb932f5e335a7526ea0000000000000000000000000000000000000000000000000002d015ae67567b00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

const NATIVE_EXEC =
  "0x2213bc0b000000000000000000000000addc26a3854feabfd20d6bf658254088d83a425a000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee00000000000000000000000000000000000000000000000000f8b0a10e470000000000000000000000000000addc26a3854feabfd20d6bf658254088d83a425a00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000007c41fff991f000000000000000000000000b1673a692f7f99ddedd49c4a307b367544a3c4c2000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000094e2ad900000000000000000000000000000000000000000000000000000000000000a0c281a2c70d9a2c64b8b08dff63707100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006a438c9c147000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee00000000000000000000000000000000000000000000000000000000000f42400000000000000000000000006a000f20005980200259b80c510200304000106800000000000000000000000000000000000000000000000000000000000005a400000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000005c4e3ead59e000000000000000000000000006d0e0d006109f0020f3050000a713780b7b000000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000f8b0a10e47000000000000000000000000000000000000000000000000000000000000094e2ad900000000000000000000000000000000000000000000000000000000095555dcb99ba4f1a1414e41904903b8b7455e7a000000000000000000000000019262d8000000000000000000000000000000000000000000000000000000000000000005a6f611dc0770101a4f273b0c16a8d61826daaf90000000000000000000000000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000180000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003e4000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003e40000000000000000000000000000000000000000000003840000000000ff000000000000000000000000000000000000000000000000000000000000000001c0000001a0c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000002000040000ff00000900000000000000000000000000000000000000000000000000000000d0e30db0c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000006000240000ff00000300000000000000000000000000000000000000000000000000000000a9059cbb00000000000000000000000000000003f1ec2379e79f58e12ec6c4f51ee9214900000000000000000000000000000000000000000000000000f8b0a10e47000000000003f1ec2379e79f58e12ec6c4f51ee92149000000e000440000ff000003000000000000000000000000000000000000000000000000000000009908fc8b000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000f8b0a10e47000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000006a000f20005980200259b80c5102003040001068000000000000000000000000000000000000000000000000000000006af9c2a3c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000002000040000ff00000900000000000000000000000000000000000000000000000000000000d0e30db0e592427a0aece92de3edee1f18e0157c0586156400000140008400000000000300000000000000000000000000000000000000000000000000000000c04b8d59000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000006a000f20005980200259b80c5102003040001068000000000000000000000000000000000000000000000000000000006af9c2a300000000000000000000000000000000000000000000000000f8b0a10e4700000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002bc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000064a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

const nativeQuote = (): ZeroExSwapQuote => ({
  provider: "0x",
  network: N1,
  taker: "0xb1673a692f7f99DDEdd49c4a307B367544A3c4c2",
  sell: EVM_NATIVE_ASSET,
  buy: USDC,
  sellAmount: 70000000000000000n,
  buyAmount: 160000000n,
  minBuyAmount: 156117721n,
  allowanceTarget: undefined,
  transaction: { to: AH, data: NATIVE_EXEC, value: 70000000000000000n, gas: 210000n },
  fees: { integrator: undefined, zeroEx: undefined },
  blockNumber: 21000000n,
  fetchedAt: 0,
});

const quote = (overrides: Partial<ZeroExSwapQuote> = {}): ZeroExSwapQuote => ({
  provider: "0x",
  network: N1,
  taker: ADDR,
  sell: USDC,
  buy: BUY_TOKEN,
  sellAmount: 10000000n,
  buyAmount: 800000000000000n,
  minBuyAmount: 751851842450135n,
  allowanceTarget: AH,
  transaction: { to: AH, data: EXEC_DATA, value: 0n, gas: 210000n },
  fees: { integrator: undefined, zeroEx: undefined },
  blockNumber: 21000000n,
  fetchedAt: 0,
  ...overrides,
});

const PRE = 10n ** 27n;
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
  removed: false,
});

/**
 * `eth_simulateV1` for a swap: block 0 carries the call (its Transfer logs let viem discover the
 * tokens); the probe blocks answer `balanceOf`/`decimals`/`symbol` so the diffs come out as the
 * sell and buy legs. `sim` replaces the whole answer for the refusal cases.
 */
const simResult = (
  legs: {
    readonly sell: string;
    readonly sellAmount: bigint;
    readonly buy: string;
    readonly buyAmount: bigint;
    readonly taker?: string;
  },
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
          /* The real call: succeed and emit the two Transfer legs. */
          if (data.includes("2213bc0b")) {
            return {
              status: fail ? "0x0" : "0x1",
              returnData: "0x",
              gasUsed: "0x0",
              logs: [
                transferLog(legs.sell, legs.taker ?? ADDR, SETTLER, legs.sellAmount),
                transferLog(legs.buy, SETTLER, legs.taker ?? ADDR, legs.buyAmount),
              ],
            };
          }
          /* balanceOf probes: post balances differ from pre by the leg amounts. */
          if (data.includes("70a08231") || data.includes("a9059cbb")) {
            const token = data.toLowerCase().includes(legs.sell.slice(2).toLowerCase())
              ? "sell"
              : "buy";
            const post = token === "sell" ? PRE - legs.sellAmount : PRE + legs.buyAmount;
            return {
              status: "0x1",
              returnData: `0x${post.toString(16).padStart(64, "0")}`,
              gasUsed: "0x0",
              logs: [],
            };
          }
          /* decimals → 18, symbol → 32-byte ABI string. */
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

function world(options: {
  address?: string;
  code?: Record<string, string>;
  allowance?: bigint;
  settler?: string;
  prev?: string;
  registryFail?: boolean;
  prevFail?: boolean;
  ahCode?: string;
  independentAhCode?: string;
  independentSettler?: string;
  independentRegistryFail?: boolean;
  sim?: unknown;
  net?: string;
  chainIdHex?: string;
}) {
  const net = options.net ?? N1;
  const calls: Array<{ url: string; method: string; params?: unknown }> = [];
  const signedRequests: SignRequest[] = [];
  const code = { [EVM_DELEGATOR.address.toLowerCase()]: DEL_CODE, ...options.code };
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
      if (p?.toLowerCase() === AH.toLowerCase()) {
        const independent = url === HOST;
        const ah =
          (independent ? (options.independentAhCode ?? options.ahCode) : options.ahCode) ?? AH_CODE;
        if (ah === "fail") {
          return Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "x" } });
        }
        return reply(ah);
      }
      return reply(code[p?.toLowerCase() ?? ""] ?? "0x");
    }
    if (body.method === "eth_call") {
      const call = body.params?.[0] as { to?: string; data?: string } | undefined;
      const data = call?.data ?? "";
      const selector = data.slice(0, 10);
      /* `readBalance` probes for the simulation's pre-balances. */
      if (data.includes("70a08231") || data.includes("f8b2cb4f") || data.includes("d4fac45d")) {
        return reply(word(PRE));
      }
      if (selector === "0xdd62ed3e") {
        return reply(word(options.allowance ?? 0n));
      }
      if (selector === "0x6352211e") {
        const independent = url === HOST;
        const fail = independent
          ? (options.independentRegistryFail ?? options.registryFail)
          : options.registryFail;
        if (fail === true) {
          return Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "revert" } });
        }
        const settler = independent
          ? (options.independentSettler ?? options.settler)
          : options.settler;
        return reply(addr(settler ?? SETTLER));
      }
      if (selector === "0xe2603dc2") {
        if (options.prevFail === true) {
          return Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "revert" } });
        }
        return reply(addr(options.prev ?? "0x0000000000000000000000000000000000000000"));
      }
      return reply(word(0n));
    }
    if (body.method === "eth_simulateV1") {
      const sim =
        options.sim ??
        simResult({
          sell: USDC,
          sellAmount: 10000000n,
          buy: BUY_TOKEN,
          buyAmount: 800000000000000n,
        });
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
}

const prepareSwap = async (w: ReturnType<typeof world>, q = quote()) =>
  w.requests.prepare({
    method: "evm-swap",
    account: ACCOUNT,
    network: N1,
    quote: q,
    fee: "normal",
  });
const prepareApprove = async (w: ReturnType<typeof world>, amount = 10000000n) =>
  w.requests.prepare({
    method: "evm-approve",
    account: ACCOUNT,
    network: N1,
    token: USDC,
    spender: AH,
    amount,
    fee: "normal",
  });

const signTx = (r: SignRequest | undefined) =>
  (
    r as unknown as {
      tx: { type?: string; to: string; data: string; authorization?: unknown };
    }
  ).tx;

describe("evm-swap", () => {
  it("a fresh quote with enough allowance is one exec through AllowanceHolder", async () => {
    const w = world({ allowance: 10000000n });
    await w.start();
    const request = await prepareSwap(w);
    await w.requests.approve(request.id, "evm-swap", VERIFY);
    const tx = signTx(w.signedRequests[0]);
    expect(tx.to.toLowerCase()).toBe(AH.toLowerCase());
    expect(tx.data).toBe(EXEC_DATA);
  });

  it("refuses a stale quote, a foreign taker and a non-AllowanceHolder target", async () => {
    const w = world({ allowance: 10000000n });
    await w.start();
    await expect(prepareSwap(w, quote({ fetchedAt: -61_000 }))).rejects.toThrow("stale");
    await expect(prepareSwap(w, quote({ taker: USDC }))).rejects.toThrow("for this account");
    await expect(
      prepareSwap(w, quote({ transaction: { ...quote().transaction, to: USDC } })),
    ).rejects.toThrow("AllowanceHolder");
  });

  it("a native sell forwards exactly its amount to AllowanceHolder", async () => {
    const w = world({
      address: "0xb1673a692f7f99DDEdd49c4a307B367544A3c4c2",
      sim: simResult({
        sell: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        sellAmount: 70000000000000000n,
        buy: USDC,
        buyAmount: 160000000n,
        taker: "0xb1673a692f7f99DDEdd49c4a307B367544A3c4c2",
      }),
    });
    await w.start();
    const request = await prepareSwap(w, nativeQuote());
    await w.requests.approve(request.id, "evm-swap", VERIFY);
    const tx = signTx(w.signedRequests[0]);
    expect(tx.to.toLowerCase()).toBe(AH.toLowerCase());
    expect(tx.data).toBe(NATIVE_EXEC);
  });

  it("refuses a sell/amount/recipient/value mismatch", async () => {
    const w = world({ allowance: 10000000n });
    await w.start();
    await expect(prepareSwap(w, quote({ sell: BUY_TOKEN }))).rejects.toThrow("sell token");
    await expect(prepareSwap(w, quote({ sellAmount: 1n }))).rejects.toThrow("sell amount");
    await expect(prepareSwap(w, quote({ buy: USDC }))).rejects.toThrow("buy token");
    await expect(prepareSwap(w, quote({ minBuyAmount: 1n }))).rejects.toThrow("minimum");
    await expect(
      prepareSwap(w, quote({ transaction: { ...quote().transaction, value: 1n } })),
    ).rejects.toThrow("0x swap");
  });

  it("refuses a Settler outside the registry and a paused one", async () => {
    const w = world({ allowance: 10000000n, settler: USDC });
    await w.start();
    await expect(prepareSwap(w)).rejects.toThrow("unrecognised Settler");
    const paused = world({ allowance: 10000000n, registryFail: true });
    await paused.start();
    await expect(prepareSwap(paused)).rejects.toThrow("paused");
  });

  it("accepts the current Settler when the registry has no previous entry", async () => {
    const w = world({ allowance: 10000000n, prevFail: true });
    await w.start();
    const request = await prepareSwap(w);
    await w.requests.approve(request.id, "evm-swap", VERIFY);
    expect(w.signedRequests).toHaveLength(1);
  });

  it("refuses an AllowanceHolder code-hash mismatch on the independent endpoint", async () => {
    const w = world({ allowance: 10000000n, independentAhCode: "0x1234" });
    await w.start();
    await expect(prepareSwap(w)).rejects.toThrow("AllowanceHolder");
  });

  it("refuses a Settler missing on the independent endpoint's registry", async () => {
    const w = world({ allowance: 10000000n, independentSettler: USDC });
    await w.start();
    await expect(prepareSwap(w)).rejects.toThrow("unrecognised Settler");
  });

  it("flags reads-unverified when the independent endpoint fails", async () => {
    const w = world({ allowance: 10000000n, independentAhCode: "fail" });
    await w.start();
    const request = await prepareSwap(w);
    expect(request.checks).toContain("reads-unverified");
  });
});

const designator = (a: string) => `0xef0100${a.slice(2)}`;
const OURS = { [ADDR.toLowerCase()]: designator(EVM_DELEGATOR.address) };

describe("evm-swap allowance routing", () => {
  it("insufficient allowance on a delegated account builds [approve, exec] batch", async () => {
    const w = world({ allowance: 0n, code: OURS });
    await w.start();
    const request = await prepareSwap(w);
    await w.requests.approve(request.id, "evm-swap", VERIFY);
    const tx = signTx(w.signedRequests[0]);
    /* The batch is a self-call whose data is the encoded [approve(AllowanceHolder), exec]. */
    expect(tx.to.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(tx.data.startsWith("0x")).toBe(true);
  });

  it("insufficient allowance with a nonzero current resets to zero first", async () => {
    const w = world({ allowance: 1n, code: OURS });
    await w.start();
    const request = await prepareSwap(w);
    await w.requests.approve(request.id, "evm-swap", VERIFY);
    expect(w.signedRequests).toHaveLength(1);
  });

  it("insufficient allowance on an undelegated account refuses", async () => {
    const w = world({ allowance: 0n });
    await w.start();
    await expect(prepareSwap(w)).rejects.toThrow("approve AllowanceHolder");
  });

  it("a reverted or unavailable simulation refuses", async () => {
    const reverted = world({
      allowance: 10000000n,
      sim: simResult(
        { sell: USDC, sellAmount: 10000000n, buy: BUY_TOKEN, buyAmount: 800000000000000n },
        true,
      ),
    });
    await reverted.start();
    await expect(prepareSwap(reverted)).rejects.toThrow("reverted");
    const unavailable = world({
      allowance: 10000000n,
      sim: () => {
        throw new Error("no sim");
      },
    });
    await unavailable.start();
    await expect(prepareSwap(unavailable)).rejects.toThrow("unavailable");
  });

  it("a simulation gaining below the minimum refuses", async () => {
    const w = world({
      allowance: 10000000n,
      sim: simResult({ sell: USDC, sellAmount: 10000000n, buy: BUY_TOKEN, buyAmount: 1n }),
    });
    await w.start();
    await expect(prepareSwap(w)).rejects.toThrow("minimum");
  });
});

describe("evm-approve", () => {
  it("approves the exact amount", async () => {
    const w = world({ allowance: 0n });
    await w.start();
    const request = await prepareApprove(w);
    await w.requests.approve(request.id, "evm-approve", VERIFY);
    const tx = signTx(w.signedRequests[0]);
    expect(tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(tx.data.startsWith("0x095ea7b3")).toBe(true);
  });

  it("refuses an unlimited approval, a nonzero overwrite and a no-op", async () => {
    const w = world({ allowance: 5n });
    await w.start();
    await expect(
      w.requests.prepare({
        method: "evm-approve",
        account: ACCOUNT,
        network: N1,
        token: USDC,
        spender: AH,
        amount: 2n ** 256n - 1n,
        fee: "normal",
      }),
    ).rejects.toThrow("unlimited");
    await expect(prepareApprove(w, 7n)).rejects.toThrow("zero");
    await expect(prepareApprove(w, 5n)).rejects.toThrow("already");
  });
});

describe("internal requests on a network without EIP-7702", () => {
  const AVAX = "eip155:43114";
  const AVAX_ID = "0xa86a";
  /* The exec operator word (hex chars 34..98) names chain 1's taker Settler — swap in Avalanche's. */
  const AVAX_SETTLER = "584a4e93f11331d318165b04099e53708b1fa915";
  const AVAX_SETTLER_ADDR = `0x${AVAX_SETTLER}`;
  const EXEC_AVAX = EXEC_DATA.replaceAll(SETTLER.slice(2).toLowerCase(), AVAX_SETTLER);
  const avaxQuote = (overrides: Partial<ZeroExSwapQuote> = {}): ZeroExSwapQuote =>
    quote({
      network: AVAX,
      transaction: { to: AH, data: EXEC_AVAX, value: 0n, gas: 210000n },
      ...overrides,
    });

  it("evm-approve succeeds on Avalanche", async () => {
    const w = world({ net: AVAX, chainIdHex: AVAX_ID });
    await w.start();
    const pending = await w.requests.prepare({
      method: "evm-approve",
      account: ACCOUNT,
      network: AVAX,
      token: USDC,
      spender: AH,
      amount: 5n,
      fee: "normal",
    });
    expect((pending.display as { summary?: string }).summary).toBe("approve");
  });

  it("evm-swap with enough allowance is a direct exec on Avalanche", async () => {
    const w = world({
      net: AVAX,
      chainIdHex: AVAX_ID,
      allowance: 10n ** 9n,
      settler: AVAX_SETTLER_ADDR,
    });
    await w.start();
    const pending = await w.requests.prepare({
      method: "evm-swap",
      account: ACCOUNT,
      network: AVAX,
      quote: avaxQuote(),
      fee: "normal",
    });
    expect((pending.display as { summary?: string }).summary).toBe("swap");
  });

  it("evm-swap with short allowance refuses with the approve-first message", async () => {
    const w = world({ net: AVAX, chainIdHex: AVAX_ID, allowance: 0n, settler: AVAX_SETTLER_ADDR });
    await w.start();
    await expect(
      w.requests.prepare({
        method: "evm-swap",
        account: ACCOUNT,
        network: AVAX,
        quote: avaxQuote(),
        fee: "normal",
      }),
    ).rejects.toThrow(/approve AllowanceHolder/);
  });
});
