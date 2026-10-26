import { describe, expect, it } from "vite-plus/test";

import { encodeSparkAddress } from "@qntx/spark";
import type { SparkClient, SparkExitChain } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { createWalletEngine } from "../src/engine.ts";
import type { EngineLogger } from "../src/events.ts";
import { SparkController } from "../src/spark/controller.ts";
import { decodeExitChain, encodeExitChain } from "../src/spark/exit-chain-codec.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const PK = new Uint8Array(33).fill(2);
const REF: SparkAccountRef = { walletId: "w1", groupIndex: 0, network: "regtest" };
const VERIFY = { kind: "password", password: new Uint8Array([1]) } as never;
const LOGGER: EngineLogger = { warn: () => {} };

function fakeClient(calls: string[], sendArgs: unknown[] = []) {
  const aborters: Array<{ aborted: boolean }> = [];
  const client = {
    identityPublicKey: async () => Promise.resolve(PK),
    balance: async () => Promise.resolve(42),
    transfers: {
      claimPending: async () => {
        calls.push("claimPending");
        return Promise.resolve({});
      },
      send: async (o: unknown) => {
        calls.push("send");
        sendArgs.push(o);
        return Promise.resolve(o);
      },
    },
    lightning: {
      createInvoice: async (o: unknown) => Promise.resolve(o),
      pay: async (o: unknown) => {
        calls.push("pay");
        return Promise.resolve(o);
      },
    },
    withdrawals: {
      quoteCooperativeExit: async () => Promise.resolve({ fees: { fast: 5, medium: 3, slow: 1 } }),
      cooperativeExit: async (o: unknown) => {
        calls.push("exit");
        return Promise.resolve(o);
      },
    },
    events: (signal?: AbortSignal) => {
      const rec = { aborted: false };
      aborters.push(rec);
      signal?.addEventListener("abort", () => {
        rec.aborted = true;
      });
      return (function* () {
        yield {
          type: "transfer",
          direction: "incoming",
          transferId: "t",
          senderIdentityPublicKey: PK,
          receiverIdentityPublicKey: PK,
        };
      })();
    },
    close: () => {
      calls.push("close");
    },
  };
  return { client: client as unknown as SparkClient, aborters, sendArgs };
}

function controller(calls: string[], approvals: unknown[]) {
  const sendArgs: unknown[] = [];
  const { client, aborters } = fakeClient(calls, sendArgs);
  const c = new SparkController({
    spark: {
      signer: () => ({}),
      approve: async (p: unknown) => {
        approvals.push(p);
        return Promise.resolve({});
      },
    },
    fetch: async () => Promise.reject(new Error("no fetch")),
    random: (n) => new Uint8Array(n).fill(1),
    now: () => 0,
    logger: LOGGER,
    createClient: () => client,
  });
  return { c, client, aborters, sendArgs };
}

describe("SparkController", () => {
  it("init starts the account, send approves first, lockAll resets", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c, aborters, sendArgs } = controller(calls, approvals);
    const store = createMemoryEngineStore();
    c.addAccount(REF);
    c.setStore(store);
    await c.init();
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    await c.send(REF, { receiver, amountSats: 10, verify: VERIFY });
    expect(approvals).toHaveLength(1);
    expect(calls.filter((x) => x === "claimPending").length).toBeGreaterThan(0);
    expect(calls.at(-1)).toBe("send");
    // transferId is a UUIDv7 minted from the injected random+now.
    expect((sendArgs[0] as { transferId?: string }).transferId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const state = c.getState().accounts["w1:0:regtest"];
    expect(state?.status).toBe("ready");
    expect(state?.balanceSats).toBe(42);
    await c.lockAll();
    expect(aborters[0]?.aborted).toBe(true);
    await c.destroy();
  });
});

describe("SparkExitChain codec", () => {
  it("round-trips byte fields", () => {
    const chain = {
      leafId: "l1",
      refundTxs: [new Uint8Array([1, 2])],
      cpfpTx: new Uint8Array([3]),
    } as unknown as SparkExitChain;
    const back = decodeExitChain(encodeExitChain(chain)) as unknown as {
      cpfpTx: Uint8Array;
    };
    expect(back.cpfpTx[0]).toBe(3);
  });
});

describe("withdraw approval intent", () => {
  const approval = (approvals: unknown[]) => approvals[0] as { intent: unknown };

  async function setup(calls: string[], approvals: unknown[]) {
    const { c, client } = controller(calls, approvals);
    const store = createMemoryEngineStore();
    c.addAccount(REF);
    c.setStore(store);
    await c.init();
    return { c, client };
  }

  it("explicit amount: payout intent is exit - quoted fee", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await c.withdraw(REF, { address: "bc1q…", amountSats: 1000, speed: "FAST", verify: VERIFY });
    // fast fee = 5, payout = 995
    expect(approval(approvals).intent).toStrictEqual({
      kind: "exit",
      address: "bc1q…",
      amountSats: 995,
      maxFeeSats: 5,
    });
    expect(calls.at(-1)).toBe("exit");
    await c.destroy();
  });

  it("whole-balance: defaults amount to the balance minus fee", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await c.withdraw(REF, { address: "bc1q…", speed: "SLOW", verify: VERIFY });
    // balance 42, slow fee 1, payout 41
    expect(approval(approvals).intent).toStrictEqual({
      kind: "exit",
      address: "bc1q…",
      amountSats: 41,
      maxFeeSats: 1,
    });
    await c.destroy();
  });

  it("rejects a caller cap below the quote without approving", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await expect(
      c.withdraw(REF, {
        address: "bc1q…",
        amountSats: 1000,
        speed: "FAST",
        maxFeeSats: 2,
        verify: VERIFY,
      }),
    ).rejects.toSatisfy((e) => (e as { category?: string }).category === "rejected");
    expect(approvals).toHaveLength(0);
    expect(calls).not.toContain("exit");
    await c.destroy();
  });

  it("rejects a fee at or above the exit amount", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await expect(
      c.withdraw(REF, { address: "bc1q…", amountSats: 5, speed: "FAST", verify: VERIFY }),
    ).rejects.toSatisfy((e) => (e as { category?: string }).category === "insufficient-funds");
    expect(approvals).toHaveLength(0);
    await c.destroy();
  });
});

describe("createWalletEngine lifecycle", () => {
  it("subscribes to wallet state and builds the controller", () => {
    expect.hasAssertions();
    const listeners = new Set<() => void>();
    const wallet = {
      getSnapshot: () => ({ vault: "locked" }),
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const engine = createWalletEngine({
      wallet: wallet as never,
      sparkApis: {
        signer: () => ({}),
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("nf")),
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger: LOGGER,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
    });
    expect(listeners.size).toBe(1);
    expect(engine.spark.getState().accounts).toStrictEqual({});
    engine.unsubscribe();
  });
});
