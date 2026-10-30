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
type Request = Parameters<Sign>[0]["request"];
const evmTx = (request: Request) => {
  if (request.kind !== "evm.transaction") {
    throw new Error("unexpected request");
  }
  return request.tx;
};
const evm1559 = (request: Request) => {
  const tx = evmTx(request);
  if (tx.type !== "eip1559") {
    throw new Error("expected eip1559");
  }
  return tx;
};
const ok = {
  kind: "evm.transaction" as const,
  signedTransaction: new Uint8Array([1, 2]),
};
const recordEvmSign =
  (seen: Array<{ nonce: number; maxFeePerGas: string; maxPriorityFeePerGas: string }>) =>
  async ({ request }: { request: Request; verify: Parameters<Sign>[0]["verify"] }) => {
    const { nonce, maxFeePerGas, maxPriorityFeePerGas } = evm1559(request);
    seen.push({
      nonce,
      maxFeePerGas: maxFeePerGas ?? "0x0",
      maxPriorityFeePerGas: maxPriorityFeePerGas ?? "0x0",
    });
    return Promise.resolve(ok);
  };
const recordCancelSign =
  (seen: Array<{ to: string | undefined; value: string; gas: string }>) =>
  async ({ request }: { request: Request; verify: Parameters<Sign>[0]["verify"] }) => {
    const tx = evmTx(request);
    seen.push({ to: tx.to, value: tx.value ?? "0x0", gas: tx.gas ?? "0x0" });
    return Promise.resolve(ok);
  };
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

/** RPC mock that assigns sequential tx hashes and reports a chosen one as confirmed. */
const receiptFetch = (confirmed: string | undefined): typeof fetch => {
  const hashes = [`0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`, `0x${"cc".repeat(32)}`];
  let sent = 0;
  return (async (_url: unknown, init: { body?: string } | undefined) => {
    const body = JSON.parse(init?.body ?? "{}") as { method: string; params?: unknown[] };
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
      eth_getBlockByNumber: { number: "0x2" },
    };
    if (body.method === "eth_sendRawTransaction") {
      sent += 1;
      return Promise.resolve(Response.json({ result: hashes[sent - 1] }));
    }
    if (body.method === "eth_getTransactionReceipt") {
      const hash = String(body.params?.[0]);
      return Promise.resolve(
        Response.json({
          result: hash === confirmed ? { status: "0x1", blockNumber: "0x1" } : null,
        }),
      );
    }
    return Promise.resolve(
      body.method in table
        ? Response.json({ result: table[body.method] })
        : Response.json({ error: { message: `unmocked ${body.method}` } }, { status: 500 }),
    );
  }) as typeof fetch;
};

const ctlWithFetch = (fetchFn: typeof fetch, sign: Sign, timers: Array<() => unknown>) => {
  let tag = 0;
  return new TransactionController({
    wallet: {} as Wallet,
    networks: new NetworkController({
      fetch: fetchFn,
      rpc: { "eip155:1": ["http://fake.local"] },
      openStore: async () => Promise.resolve(memoryStore()),
      logger,
    }),
    openStore: async () => Promise.resolve(memoryStore()),
    random: (n) => {
      tag += 1;
      return new Uint8Array(n).fill(tag);
    },
    setTimer: (_ms, fn) => {
      timers.push(fn);
      return () => {};
    },
    now: () => 1000,
    logger,
    pollMs: 1,
    chains: apis(sign),
  });
};
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
    const seen: Array<{ nonce: number; maxFeePerGas: string; maxPriorityFeePerGas: string }> = [];
    const ctl = ctlWith(recordEvmSign(seen));
    await ctl.init();
    const original = await ctl.send(SEND);
    expect(original.state).toBe("submitted");
    const bumped = await ctl.replace(original.id, "speed-up", SEND.verify);
    expect(bumped.state).toBe("submitted");
    expect(bumped.replaces).toBe(original.id);
    expect(bumped.nonce).toBe(original.nonce);
    expect(seen).toHaveLength(2);
    const first = seen[0]!;
    const second = seen[1]!;
    expect(second.nonce).toBe(first.nonce);
    const oldFee = BigInt(first.maxFeePerGas);
    const newFee = BigInt(second.maxFeePerGas);
    const bumpedFee = oldFee * 11n;
    expect(newFee * 10n).toBeGreaterThanOrEqual(bumpedFee);
    expect(newFee * 10n).toBeLessThan(bumpedFee + oldFee + 10n);
  });

  it("cancel rebuilds as a 0-value transfer to self with gas 21000", async () => {
    const seen: Array<{ to: string | undefined; value: string; gas: string }> = [];
    const ctl = ctlWith(recordCancelSign(seen));
    await ctl.init();
    const original = await ctl.send(SEND);
    const cancelled = await ctl.replace(original.id, "cancel", SEND.verify);
    expect(cancelled.replaces).toBe(original.id);
    const last = seen.at(-1)!;
    expect(last.to).toBe(ADDR);
    expect(BigInt(last.value)).toBe(0n);
    expect(BigInt(last.gas)).toBe(21000n);
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

describe("TransactionController.replace — state resolution", () => {
  it("replacement confirms → the original flips to replaced", async () => {
    const timers: Array<() => unknown> = [];
    const ctl = ctlWithFetch(
      receiptFetch(`0x${"bb".repeat(32)}`),
      async () =>
        Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array([1]) }),
      timers,
    );
    await ctl.init();
    const original = await ctl.send(SEND);
    const bumped = await ctl.replace(original.id, "speed-up", SEND.verify);
    await Promise.all(
      timers.map(async (fn) => {
        await fn();
      }),
    );
    const { txs } = ctl.getState();
    expect(txs[bumped.id]?.state).toBe("confirmed");
    expect(txs[original.id]?.state).toBe("replaced");
  });

  it("original confirms first → the replacement flips to replaced", async () => {
    const timers: Array<() => unknown> = [];
    const ctl = ctlWithFetch(
      receiptFetch(`0x${"aa".repeat(32)}`),
      async () =>
        Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array([1]) }),
      timers,
    );
    await ctl.init();
    const original = await ctl.send(SEND);
    const bumped = await ctl.replace(original.id, "speed-up", SEND.verify);
    await Promise.all(
      timers.map(async (fn) => {
        await fn();
      }),
    );
    const { txs } = ctl.getState();
    expect(txs[original.id]?.state).toBe("confirmed");
    expect(txs[bumped.id]?.state).toBe("replaced");
  });

  it("a new send while a replace is pending gets the next nonce, not the replaced one", async () => {
    const timers: Array<() => unknown> = [];
    const ctl = ctlWithFetch(
      receiptFetch(undefined),
      async () =>
        Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array([1]) }),
      timers,
    );
    await ctl.init();
    const original = await ctl.send(SEND);
    const bumped = await ctl.replace(original.id, "speed-up", SEND.verify);
    const next = await ctl.send(SEND);
    expect(bumped.nonce).toBe(original.nonce);
    expect(next.nonce).toBe(original.nonce + 1);
  });
});
