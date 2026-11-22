import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseAbi,
  numberToHex,
  parseTransaction,
  serializeTransaction,
} from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import {
  EvmChainAdapter,
  OP_GAS_PRICE_ORACLE,
  SCROLL_L1_GAS_PRICE_ORACLE,
} from "../src/chains/evm.ts";

const client = (handlers: Record<string, unknown>): PublicClient =>
  ({
    transport: {
      request: async ({ method }: { method: string; params?: unknown[] }) => {
        const v = handlers[method];
        return method in handlers
          ? Promise.resolve(typeof v === "function" ? v() : v)
          : Promise.reject(new Error(`unmocked ${method}`));
      },
    },
  }) as unknown as PublicClient;

const rpc = (h: Record<string, unknown>) => client(h);

const oracleClient = (calls: Array<{ to: string; data: string }>, operatorCall: string) =>
  createPublicClient({
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method !== "eth_call") {
          throw new Error(`unmocked ${method}`);
        }
        const [call] = params as [{ to: string; data: string }];
        calls.push(call);
        return Promise.resolve(numberToHex(call.data === operatorCall ? 40n : 1000n, { size: 32 }));
      },
    }),
  });

const GET_L1_FEE_ABI = parseAbi(["function getL1Fee(bytes data) view returns (uint256)"]);
const MAX_SIG = { r: `0x${"ff".repeat(32)}`, s: `0x${"ff".repeat(32)}`, v: 28n } as const;

/** The `bytes` argument of the first call to the scroll oracle — the getL1Fee read. */
const scrollBytes = (calls: ReadonlyArray<{ to: string; data: string }>): `0x${string}` => {
  const call = calls.find((c) => c.to.toLowerCase() === SCROLL_L1_GAS_PRICE_ORACLE.toLowerCase());
  const { args } = decodeFunctionData({
    abi: GET_L1_FEE_ABI,
    data: (call?.data ?? "0x") as `0x${string}`,
  });
  return args[0];
};

const SCROLL_TX = {
  family: "evm" as const,
  network: "eip155:534352",
  from: `0x${"1".repeat(40)}`,
  to: `0x${"2".repeat(40)}`,
  value: 5n,
  data: "0x",
  nonce: 0,
  gas: 21_000n,
  maxFeePerGas: 4n,
  maxPriorityFeePerGas: 2n,
};

const SCROLL_LEGACY_TX = {
  family: "evm" as const,
  network: "eip155:534352",
  from: `0x${"1".repeat(40)}`,
  to: `0x${"2".repeat(40)}`,
  value: 5n,
  data: "0x",
  nonce: 0,
  gas: 21_000n,
  gasPrice: 9n,
};

const authorizationOf = (bytes: `0x${string}`) => parseTransaction(bytes).authorizationList?.[0];

describe("EvmChainAdapter", () => {
  it("builds a transaction at the nonce the caller assigns", async () => {
    const a = new EvmChainAdapter();
    const c = rpc({ eth_estimateGas: "0x5208" });
    const intent = {
      kind: "native" as const,
      to: `0x${"2".repeat(40)}`,
      value: 1n,
    };
    const t1 = await a.build(c, "eip155:1", `0x${"1".repeat(40)}`, intent, 5);
    const t2 = await a.build(c, "eip155:1", `0x${"1".repeat(40)}`, intent, 6);
    expect(t1.nonce).toBe(5);
    expect(t2.nonce).toBe(6);
    expect(t1.gas).toBe(25200n);
  });

  it("computes 1559 tiers from feeHistory p10/p50/p90", async () => {
    const a = new EvmChainAdapter();
    const c = rpc({
      eth_feeHistory: {
        baseFeePerGas: ["0x10", "0x14"],
        reward: [
          [`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`, "0x3"],
          ["0x4", "0x5", "0x6"],
        ],
      },
    });
    const [slow, normal, fast] = await a.estimateFee(c, "eip1559");
    expect(slow?.maxFeePerGas).toBe(2n * 0x14n + 0x4n);
    expect(normal?.maxFeePerGas).toBe(2n * 0x14n + 0x5n);
    expect(fast?.maxFeePerGas).toBe(2n * 0x14n + 0x6n);
    expect(slow?.maxPriorityFeePerGas).toBe(4n);
  });

  it("falls back to eth_gasPrice when feeHistory is unsupported", async () => {
    const a = new EvmChainAdapter();
    const c = rpc({
      eth_feeHistory: () => {
        throw new Error("method not found");
      },
      eth_gasPrice: "0x3b9aca00",
    });
    const quotes = await a.estimateFee(c, "eip1559");
    expect(quotes.every((q) => q.maxFeePerGas === 0x3b9aca00n)).toBe(true);
    expect(quotes[0]?.maxPriorityFeePerGas).toBeUndefined();
  });

  it("legacy pricing quotes eth_gasPrice without asking feeHistory", async () => {
    const a = new EvmChainAdapter();
    const called: string[] = [];
    const c = rpc({
      eth_feeHistory: () => {
        called.push("eth_feeHistory");
        throw new Error("feeHistory must not be called");
      },
      eth_gasPrice: () => {
        called.push("eth_gasPrice");
        return "0x7";
      },
    });
    const quotes = await a.estimateFee(c, "legacy");
    expect(quotes.every((q) => q.maxFeePerGas === 7n)).toBe(true);
    expect(quotes[0]?.maxPriorityFeePerGas).toBeUndefined();
    expect(called).toStrictEqual(["eth_gasPrice"]);
  });

  it("produces a normalized eip1559 sign request", async () => {
    const a = new EvmChainAdapter();
    const tx = await a.build(
      rpc({ eth_estimateGas: "0x5208" }),
      "eip155:1",
      "0xA",
      { kind: "native", to: `0x${"b".repeat(40)}`, value: 7n },
      0,
    );
    const priced = a.applyFee(tx, {
      tier: "normal",
      wei: 0n,
      maxFeePerGas: 30n,
      maxPriorityFeePerGas: 2n,
    });
    const req = a.toSignRequest(
      priced,
      { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
      1,
    );
    expect(req.tx.type).toBe("eip1559");
    expect(req.tx.chainId).toBe(1);
    expect(req.tx.gas).toBe("0x6270");
    const maxFee: unknown = Object.getOwnPropertyDescriptor(req.tx, "maxFeePerGas")?.value;
    expect(maxFee).toBe("0x1e");
  });

  it("reads the receipt block, the finalized tag and a block hash by height", async () => {
    const a = new EvmChainAdapter();
    const c = rpc({
      eth_getTransactionReceipt: {
        status: `0x${"1".repeat(40)}`,
        blockNumber: "0x5",
        blockHash: `0x${"11".repeat(32)}`,
      },
      eth_getBlockByNumber: { number: "0x6", hash: `0x${"22".repeat(32)}` },
    });
    await expect(a.receipt(c, "0x0")).resolves.toStrictEqual({
      failed: false,
      block: { hash: `0x${"11".repeat(32)}`, height: 5 },
    });
    await expect(a.finalizedHeight(c)).resolves.toBe(6);
    await expect(a.blockHashAt(c, 5)).resolves.toBe(`0x${"22".repeat(32)}`);
    const pending = rpc({ eth_getTransactionReceipt: null });
    await expect(a.receipt(pending, "0x0")).resolves.toBeUndefined();
    const failed = rpc({
      eth_getTransactionReceipt: {
        status: "0x0",
        blockNumber: "0x5",
        blockHash: `0x${"11".repeat(32)}`,
      },
    });
    await expect(a.receipt(failed, "0x0")).resolves.toMatchObject({ failed: true });
    const malformed = rpc({
      eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x5", blockHash: "0x1" },
    });
    await expect(a.receipt(malformed, "0x0")).rejects.toBeInstanceOf(TypeError);
    const tipless = rpc({ eth_getBlockByNumber: null });
    await expect(a.finalizedHeight(tipless)).rejects.toBeInstanceOf(TypeError);
    await expect(a.blockHashAt(tipless, 5)).resolves.toBeUndefined();
  });

  it("reads the L1 data fee and the operator fee from the GasPriceOracle", async () => {
    const calls: Array<{ to: string; data: string }> = [];
    const operatorAbi = parseAbi([
      "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
    ]);
    const operatorCall = encodeFunctionData({
      abi: operatorAbi,
      functionName: "getOperatorFee",
      args: [21_000n],
    });
    const oracle = oracleClient(calls, operatorCall);
    const a = new EvmChainAdapter();
    const fee = await a.opStackFee(
      oracle,
      {
        family: "evm",
        network: "eip155:8453",
        from: `0x${"1".repeat(40)}`,
        to: `0x${"2".repeat(40)}`,
        value: 5n,
        data: "0x",
        nonce: 0,
        gas: 21_000n,
        maxFeePerGas: 4n,
        maxPriorityFeePerGas: 2n,
      },
      { operatorFee: true, tokenRatio: false },
    );
    expect(fee).toStrictEqual({ raw: 1000n, extra: 40n });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.to.toLowerCase())).toStrictEqual([
      OP_GAS_PRICE_ORACLE.toLowerCase(),
      OP_GAS_PRICE_ORACLE.toLowerCase(),
    ]);
    expect(calls.map((c) => c.data)).toContain(operatorCall);
  });

  it("skips the operator fee on a model without it", async () => {
    const calls: Array<{ to: string; data: string }> = [];
    const oracle = oracleClient(calls, "0x");
    const a = new EvmChainAdapter();
    const fee = await a.opStackFee(
      oracle,
      {
        family: "evm",
        network: "eip155:204",
        from: `0x${"1".repeat(40)}`,
        to: `0x${"2".repeat(40)}`,
        value: 5n,
        data: "0x",
        nonce: 0,
        gas: 21_000n,
        gasPrice: 4n,
      },
      { operatorFee: false, tokenRatio: false },
    );
    expect(fee).toStrictEqual({ raw: 1000n, extra: 0n });
    expect(calls).toHaveLength(1);
  });

  it("prices the signed eip1559 encoding on the scroll oracle", async () => {
    const calls: Array<{ to: string; data: string }> = [];
    const a = new EvmChainAdapter();
    const fee = await a.scrollL1Fee(oracleClient(calls, "0x"), SCROLL_TX);
    expect(fee).toStrictEqual({ raw: 1000n, extra: 0n });
    expect(calls).toHaveLength(1);
    expect(scrollBytes(calls)).toBe(
      serializeTransaction(
        {
          type: "eip1559",
          chainId: 534352,
          nonce: 0,
          gas: 21_000n,
          to: getAddress(`0x${"2".repeat(40)}`),
          value: 5n,
          data: "0x",
          accessList: [],
          maxFeePerGas: 4n,
          maxPriorityFeePerGas: 2n,
        },
        MAX_SIG,
      ),
    );
  });

  it("serializes a legacy transaction for the scroll oracle", async () => {
    const calls: Array<{ to: string; data: string }> = [];
    const a = new EvmChainAdapter();
    await a.scrollL1Fee(oracleClient(calls, "0x"), SCROLL_LEGACY_TX);
    const parsed = parseTransaction(scrollBytes(calls));
    expect(parsed.type).toBe("legacy");
    expect(parsed.gasPrice).toBe(9n);
  });

  it("serializes a self-sponsored authorization for the scroll oracle", async () => {
    const calls: Array<{ to: string; data: string }> = [];
    const a = new EvmChainAdapter();
    await a.scrollL1Fee(oracleClient(calls, "0x"), {
      ...SCROLL_TX,
      authorization: { address: `0x${"3".repeat(40)}` },
    });
    const auth = authorizationOf(scrollBytes(calls));
    expect(auth?.address.toLowerCase()).toBe(`0x${"3".repeat(40)}`);
    expect(auth?.nonce).toBe(1);
  });

  it("serializes under a signature at least as long as any real one", async () => {
    const calls: Array<{ to: string; data: string }> = [];
    const a = new EvmChainAdapter();
    await a.scrollL1Fee(oracleClient(calls, "0x"), SCROLL_TX);
    const bytes = scrollBytes(calls);
    // A short real signature encodes strictly shorter; the oracle always sees the maximum.
    const small = serializeTransaction(
      {
        type: "eip1559",
        chainId: 534352,
        nonce: 0,
        gas: 21_000n,
        to: getAddress(`0x${"2".repeat(40)}`),
        value: 5n,
        data: "0x",
        accessList: [],
        maxFeePerGas: 4n,
        maxPriorityFeePerGas: 2n,
      },
      { r: "0x01", s: "0x01", yParity: 0 },
    );
    expect(bytes.length).toBeGreaterThan(small.length);
  });
});
