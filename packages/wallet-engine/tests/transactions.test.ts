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

const logger: EngineLogger = { warn: () => {} };

type Sign = ReturnType<typeof chains>["sign"];
const apis = (sign: Sign): ReturnType<typeof chains> => {
  const account: ReturnType<typeof chains>["account"] = async () =>
    Promise.resolve({
      template: "evm.bip44",
      network: "eip155:1",
      address: ADDR,
    });
  return { account, sign };
};

const nets = (fetchFn: typeof fetch) =>
  new NetworkController({
    fetch: fetchFn,
    rpc: { "eip155:1": ["http://fake.local"] },
    openStore: async () => Promise.resolve(memoryStore()),
    logger,
  });

const SEND = {
  account: ACCOUNT,
  network: "eip155:1",
  to: "0x00000000000000000000000000000000deadbeef",
  amount: 1n,
  fee: "normal" as const,
  verify: { kind: "password" as const, password: "pw" },
};

describe("TransactionController", () => {
  it("send: build → sign → broadcast → confirmed; intent and nonce tracked", async () => {
    const timers: Array<() => unknown> = [];
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks: nets(rpcFetch()),
      openStore: async () => Promise.resolve(memoryStore()),
      random: (n) => new Uint8Array(n).fill(1),
      setTimer: (_ms, fn) => {
        timers.push(fn);
        return () => {};
      },
      now: () => 1000,
      logger,
      pollMs: 1,
      chains: apis(async () =>
        Promise.resolve({
          kind: "evm.transaction",
          signedTransaction: new Uint8Array([1, 2]),
        }),
      ),
    });
    await ctl.init();
    const tx = await ctl.send(SEND);
    expect(tx.state).toBe("submitted");
    expect(tx.intent?.summary).toBe("transfer");
    expect(timers).toHaveLength(1);
    await timers[0]?.();
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
  });

  it("wrong password → rejected, nothing broadcast", async () => {
    let broadcast = false;
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks: nets(
        rpcFetch({
          eth_sendRawTransaction: () => {
            broadcast = true;
            return "0x0";
          },
        }),
      ),
      openStore: async () => Promise.resolve(memoryStore()),
      random: (n) => new Uint8Array(n).fill(1),
      setTimer: () => () => {},
      now: () => 0,
      logger,
      chains: apis(async () => Promise.reject(new Error("wrong-password"))),
    });
    await ctl.init();
    await expect(ctl.send(SEND)).rejects.toThrow("wrong-password");
    expect(broadcast).toBe(false);
    expect(Object.values(ctl.getState().txs)[0]?.state).toBe("rejected");
  });

  it("resumes a persisted pending transaction on init", async () => {
    const store = memoryStore();
    await store.collection("transactions").put(
      "tx-x",
      new TextEncoder().encode(
        JSON.stringify({
          id: "tx-x",
          family: "evm",
          network: "eip155:1",
          account: "w",
          hash: "0x1",
          state: "pending",
          intent: undefined,
          nonce: 0,
          submittedAt: 0,
        }),
      ),
    );
    const timers: Array<() => unknown> = [];
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks: nets(rpcFetch()),
      openStore: async () => Promise.resolve(store),
      random: (n) => new Uint8Array(n),
      setTimer: (_ms, fn) => {
        timers.push(fn);
        return () => {};
      },
      now: () => 0,
      logger,
      pollMs: 1,
      chains: apis(async () =>
        Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array() }),
      ),
    });
    await ctl.init();
    expect(ctl.getState().txs["tx-x"]?.state).toBe("pending");
    expect(timers).toHaveLength(1);
    await timers[0]?.();
    expect(ctl.getState().txs["tx-x"]?.state).toBe("confirmed");
  });
});
