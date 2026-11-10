import { toFunctionSelector, numberToHex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { chains } from "@qntx/wallet/chains";

import { OP_GAS_PRICE_ORACLE } from "../src/chains/evm.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { fakeSignedEvm, idleNetworkDeps } from "./send-helpers.ts";

const GATEWAY = "https://gateway.test";
const HOST = "http://host.local";
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const BASE = "eip155:8453";
const ETHEREUM = "eip155:1";
const VERIFY = { kind: "password" as const, password: "pw" };
const GET_L1_FEE = toFunctionSelector("getL1Fee(bytes)");
const GET_OPERATOR_FEE = toFunctionSelector("getOperatorFee(uint256)");

type Node = { l1: bigint | "fail"; operator: bigint; calls: Array<{ to: string; data: string }> };
const newNode = (l1: bigint | "fail" = 0n, operator = 0n): Node => ({ l1, operator, calls: [] });

const answer = (node: Node, method: string, params: unknown[]): unknown => {
  switch (method) {
    case "eth_getTransactionCount":
      return "0x0";
    case "eth_estimateGas":
      return "0x5208";
    case "eth_feeHistory":
      return {
        baseFeePerGas: ["0x1", "0x1"],
        reward: [
          ["0x1", "0x2", "0x3"],
          ["0x1", "0x2", "0x3"],
        ],
      };
    case "eth_sendRawTransaction":
      return `0x${"ab".repeat(32)}`;
    case "eth_call": {
      const { to, data } = params[0] as { to: string; data: string };
      node.calls.push({ to, data });
      if (node.l1 === "fail") {
        throw new Error("oracle unavailable");
      }
      if (data.startsWith(GET_L1_FEE)) {
        return numberToHex(node.l1, { size: 32 });
      }
      if (data.startsWith(GET_OPERATOR_FEE)) {
        return numberToHex(node.operator, { size: 32 });
      }
      throw new Error("unexpected call");
    }
    default:
      throw new Error(`unmocked ${method}`);
  }
};

const world = (options: { gateway?: boolean } = {}) => {
  const primary = newNode();
  const independent = newNode();
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const logger = { warn: () => {} };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Promise.resolve(Response.json({ networks: [BASE, ETHEREUM] }));
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    const node = options.gateway === true && !url.startsWith(GATEWAY) ? independent : primary;
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: answer(node, body.method, body.params ?? []) };
      } catch (error) {
        // An unmocked method answers like a node without it (-32601, which viem never retries).
        const message = error instanceof Error ? error.message : "failed";
        return { error: { code: message.startsWith("unmocked") ? -32601 : -1, message } };
      }
    })();
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, ...reply }));
  };

  const apis = {
    account: async () => Promise.resolve({ template: "evm.bip44", network: BASE, address: ADDR }),
    sign: async ({ request }: { request: Parameters<typeof fakeSignedEvm>[0] }) =>
      Promise.resolve(fakeSignedEvm(request)),
  } as unknown as ReturnType<typeof chains>;

  const boot = async () => {
    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: fetchImpl,
      rpc: { [BASE]: [HOST], [ETHEREUM]: [HOST] },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger,
      ...(options.gateway === true ? { gateway: { url: GATEWAY, installId: "a".repeat(32) } } : {}),
    });
    if (options.gateway === true) {
      await networks.init();
    }
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => new Uint8Array(n).fill(7),
      setTimer: () => () => {},
      now: () => 1000,
      logger,
      pollMs: 1,
      chains: apis,
    });
    await ctl.init();
    return ctl;
  };
  return { primary, independent, boot };
};

const params = (network: string, amount: bigint) => ({
  account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm.bip44" as const },
  network,
  to: "0x00000000000000000000000000000000deadbeef",
  amount,
  fee: "normal" as const,
});

describe("OP Stack L1 fee", () => {
  it("adds the L1 data fee and the operator fee to the intent", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    w.primary.operator = 234n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    expect(prepared.intent.fee?.l1Data).toStrictEqual({ asset: "native", amount: "1234" });
    expect(prepared.checks).not.toContain("reads-unverified");
  });

  it("queries the GasPriceOracle predeploy", async () => {
    const w = world();
    w.primary.l1 = 5n;
    const ctl = await w.boot();
    await ctl.prepareSend(params(BASE, 1n), "req-1");
    expect(w.primary.calls).toHaveLength(2);
    expect(w.primary.calls.map((c) => c.to.toLowerCase())).toStrictEqual([
      OP_GAS_PRICE_ORACLE.toLowerCase(),
      OP_GAS_PRICE_ORACLE.toLowerCase(),
    ]);
  });

  it("flags fee-exceeds-amount only when the L1 fee pushes the fee over the amount", async () => {
    const amount = 101_000n;
    const without = world();
    const ctlWithout = await without.boot();
    const none = await ctlWithout.prepareSend(params(BASE, amount), "req-1");
    expect(none.checks).not.toContain("fee-exceeds-amount");

    const withL1 = world();
    withL1.primary.l1 = 1000n;
    const ctlWith = await withL1.boot();
    const over = await ctlWith.prepareSend(params(BASE, amount), "req-1");
    expect(over.checks).toContain("fee-exceeds-amount");
  });

  it("uses the larger independent read and flags a mismatch", async () => {
    const w = world({ gateway: true });
    w.primary.l1 = 1000n;
    w.independent.l1 = 2000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    expect(prepared.checks).toContain("fee-mismatch");
    expect(prepared.intent.fee?.l1Data?.amount).toBe("2000");
  });

  it("keeps the larger primary read when the independent one is smaller", async () => {
    const w = world({ gateway: true });
    w.primary.l1 = 2000n;
    w.independent.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    expect(prepared.checks).toContain("fee-mismatch");
    expect(prepared.intent.fee?.l1Data?.amount).toBe("2000");
  });

  it("agreeing reads raise no mismatch", async () => {
    const w = world({ gateway: true });
    w.primary.l1 = 1000n;
    w.independent.l1 = 1100n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    expect(prepared.checks).not.toContain("fee-mismatch");
    expect(prepared.intent.fee?.l1Data?.amount).toBe("1100");
  });

  it("a failed read is reads-unverified and leaves the L1 fee out", async () => {
    const w = world();
    w.primary.l1 = "fail";
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    expect(prepared.checks).toContain("reads-unverified");
    expect(prepared.intent.fee?.l1Data).toBeUndefined();
  });

  it("a failed independent read is reads-unverified but keeps the primary fee", async () => {
    const w = world({ gateway: true });
    w.primary.l1 = 1000n;
    w.independent.l1 = "fail";
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    expect(prepared.checks).toContain("reads-unverified");
    expect(prepared.intent.fee?.l1Data?.amount).toBe("1000");
  });

  it("does not query the oracle on other networks", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(ETHEREUM, 1n), "req-1");
    expect(w.primary.calls).toHaveLength(0);
    expect(prepared.intent.fee?.l1Data).toBeUndefined();
  });

  it("a replacement carries the L1 fee", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    const original = await prepared.submit(VERIFY);
    w.primary.l1 = 3000n;
    const replacement = await ctl.prepareReplacement(
      { method: "speed-up", txId: original.id },
      "req-2",
    );
    expect(replacement.intent.fee?.l1Data?.amount).toBe("3000");
  });

  it("persists the L1 fee with the transaction", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    const tx = await prepared.submit(VERIFY);
    const reloaded = await w.boot();
    expect(reloaded.getState().txs[tx.id]?.intent?.fee?.l1Data).toStrictEqual({
      asset: "native",
      amount: "1000",
    });
  });
});
