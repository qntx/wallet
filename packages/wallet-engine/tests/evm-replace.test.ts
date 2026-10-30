import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { chains } from "@qntx/wallet/chains";

import type { EngineLogger } from "../src/events.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";

const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const SEND = {
  account: ACCOUNT,
  network: "eip155:1",
  to: "0x00000000000000000000000000000000deadbeef",
  amount: 1n,
  fee: "normal" as const,
  verify: { kind: "password" as const, password: "pw" },
};

const logger: EngineLogger = { warn: () => {} };
const field = (r: { maxFeePerGas?: string }): string => r.maxFeePerGas ?? "0x0";
const captureRequest = (tx: { to?: string; value?: string; gas?: string }) => ({
  to: tx.to,
  value: tx.value ?? "0x0",
  gas: tx.gas ?? "0x0",
});
const memoryStore = () => createMemoryEngineStore();

const rpcFetch = (overrides: Record<string, unknown> = {}): typeof fetch =>
  (async (_url: unknown, init: { body?: string } | undefined) => {
    const body = JSON.parse(init?.body ?? "{}") as { method: string };
    const table: Record<string, unknown> = {
      eth_getTransactionCount: "0x0",
      eth_estimateGas: "0x5208",
      eth_feeHistory: {
        baseFeePerGas: ["0x1", "0x1"],
        reward: [
          ["0x1", "0x2", "0x3"],
          ["0x1", "0x2", "0x3"],
        ],
      },
      eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
      eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x1", blockHash: "0x1" },
      eth_getBlockByNumber: { number: "0x2" },
      ...overrides,
    };
    return Promise.resolve(
      body.method in table
        ? Response.json({ result: table[body.method] })
        : Response.json({ error: { message: `unmocked ${body.method}` } }, { status: 500 }),
    );
  }) as typeof fetch;

type Sign = ReturnType<typeof chains>["sign"];
const apis = (sign: Sign): ReturnType<typeof chains> => {
  const account: ReturnType<typeof chains>["account"] = async () =>
    Promise.resolve({ template: "evm.bip44", network: "eip155:1", address: ADDR });
  return { account, sign };
};

const ctlWith = (sign: Sign): TransactionController =>
  new TransactionController({
    wallet: {} as Wallet,
    networks: new NetworkController({
      fetch: rpcFetch(),
      rpc: { "eip155:1": ["http://fake.local"] },
      openStore: async () => Promise.resolve(memoryStore()),
      logger,
    }),
    openStore: async () => Promise.resolve(memoryStore()),
    random: (n) => new Uint8Array(n).fill(1),
    setTimer: () => () => {},
    now: () => 1000,
    logger,
    pollMs: 1,
    chains: apis(sign),
  });

describe("TransactionController.replace", () => {
  it("speed-up rebuilds at the same nonce with a bumped fee and replaces the original", async () => {
    let signedCount = 0;
    const seen: Array<{ nonce: number; maxFeePerGas?: string; maxPriorityFeePerGas?: string }> = [];
    const ctl = ctlWith(async ({ request }) => {
      signedCount += 1;
      if (request.kind !== "evm.transaction" || request.tx.type !== "eip1559") {
        return Promise.reject(new Error("unexpected request"));
      }
      const { nonce, maxFeePerGas, maxPriorityFeePerGas } = request.tx;
      seen.push({ nonce, maxFeePerGas, maxPriorityFeePerGas });
      return Promise.resolve({
        kind: "evm.transaction",
        signedTransaction: new Uint8Array([1, 2]),
      });
    });
    await ctl.init();
    const original = await ctl.send(SEND);
    expect(original.state).toBe("submitted");
    const bumped = await ctl.replace(original.id, "speed-up", SEND.verify);
    expect(bumped.state).toBe("submitted");
    expect(bumped.replaces).toBe(original.id);
    expect(bumped.nonce).toBe(original.nonce);
    expect(signedCount).toBe(2);
    const first = seen[0]!;
    const second = seen[1]!;
    expect(second.nonce).toBe(first.nonce);
    const oldFee = BigInt(first.maxFeePerGas ?? "0x0");
    const newFee = BigInt(second.maxFeePerGas ?? "0x0");
    const bumpedFee = oldFee * 11n;
    expect(newFee * 10n).toBeGreaterThanOrEqual(bumpedFee);
    expect(newFee * 10n).toBeLessThan(bumpedFee + oldFee + 10n);
  });

  it("cancel rebuilds as a 0-value transfer to self with gas 21000", async () => {
    const seen: Array<{ to: string | undefined; value: string; gas: string }> = [];
    const ctl = ctlWith(async ({ request }) => {
      if (request.kind !== "evm.transaction") {
        return Promise.reject(new Error("unexpected request"));
      }
      seen.push(captureRequest(request.tx));
      return Promise.resolve({
        kind: "evm.transaction",
        signedTransaction: new Uint8Array([1, 2]),
      });
    });
    await ctl.init();
    const original = await ctl.send(SEND);
    const cancelled = await ctl.replace(original.id, "cancel", SEND.verify);
    expect(cancelled.replaces).toBe(original.id);
    const last = seen.at(-1)!;
    expect(last.to).toBe(ADDR);
    expect(BigInt(last.value ?? "0x0")).toBe(0n);
    expect(BigInt(last.gas ?? "0x0")).toBe(21000n);
  });

  it("wrong password → rejected, nothing broadcast, original untouched", async () => {
    let calls = 0;
    const ctl = ctlWith(async () => {
      calls += 1;
      return Promise.reject(new Error("wrong-password"));
    });
    await ctl.init();
    await expect(ctl.send(SEND)).rejects.toThrow("wrong-password");
    const [original] = Object.values(ctl.getState().txs);
    expect(original?.state).toBe("rejected");
    expect(calls).toBe(1);
    await expect(ctl.replace("tx-missing", "speed-up", SEND.verify)).rejects.toThrow(
      "unknown transaction",
    );
  });

  it("refuses to replace a rejected transaction", async () => {
    const ctl = ctlWith(async () => Promise.reject(new Error("wrong-password")));
    await ctl.init();
    await expect(ctl.send(SEND)).rejects.toThrow("wrong-password");
    const [original] = Object.values(ctl.getState().txs);
    await expect(ctl.replace(original!.id, "cancel", SEND.verify)).rejects.toThrow(
      "cannot replace",
    );
  });
});
