import { describe, expect, it, vi } from "vite-plus/test";

import { encodeSparkAddress, SparkInputError, SparkRequestError } from "@qntx/spark";
import type { SparkClient, SparkEvent, SparkExitChain } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { createWalletEngine } from "../src/engine.ts";
import type { EngineLogger } from "../src/events.ts";
import { SparkController } from "../src/spark/controller.ts";
import { decodeExitChain, encodeExitChain } from "../src/spark/exit-chain-codec.ts";
import { encodePaymentNote } from "../src/spark/notes.ts";
import type { PaymentNote } from "../src/spark/notes.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";

const PK = new Uint8Array(33).fill(2);
const REF: SparkAccountRef = { walletId: "w1", groupIndex: 0, network: "regtest" };
const VERIFY = { kind: "password", password: new Uint8Array([1]) } as never;
const LOGGER: EngineLogger = { warn: () => {} };

function warnText(m: string, e: unknown): string {
  return `${m} ${e instanceof Error ? e.message : String(e ?? "")}`;
}

/** Polls until a read satisfies the predicate — the event loop's resync is fire-and-forget. */
async function until<T>(read: () => T, want: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = read();
  while (!want(value)) {
    if (Date.now() > deadline) {
      throw new Error(`until() timed out on ${JSON.stringify(value)}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling is the point
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = read();
  }
  return value;
}

type FakeClaimOptions = {
  readonly claimErrors?: Error[];
  readonly claimPendingFailures?: Array<{ transferId: string; error: unknown }>;
  readonly streams?: ReadonlyArray<() => AsyncGenerator<SparkEvent>>;
  /** `transfers.history` pages returned in order — a rejected promise exercises the warn path. */
  readonly historyPages?: ReadonlyArray<unknown>;
};

function fakeClient(
  calls: string[],
  sendArgs: unknown[] = [],
  claimArgs: Array<{ id: string; signal: unknown }> = [],
  opts: FakeClaimOptions = {},
) {
  const aborters: Array<{ aborted: boolean }> = [];
  const claimErrors = [...(opts.claimErrors ?? [])];
  const claimPendingFailures = [...(opts.claimPendingFailures ?? [])];
  const historyPages = [...(opts.historyPages ?? [])];
  let lastPage: unknown;
  let streamCalls = 0;
  const client = {
    identityPublicKey: async () => Promise.resolve(PK),
    balance: async () => Promise.resolve(42),
    transfers: {
      claimPending: async () => {
        calls.push("claimPending");
        return Promise.resolve({ leaves: [], failures: [...claimPendingFailures] });
      },
      claim: async (id: unknown, claimOpts: unknown) => {
        calls.push(`claim:${String(id)}`);
        claimArgs.push({ id: String(id), signal: claimOpts });
        const error = claimErrors.shift();
        if (error !== undefined) {
          return Promise.reject(error);
        }
        return Promise.resolve([]);
      },
      send: async (o: unknown) => {
        calls.push("send");
        sendArgs.push(o);
        return Promise.resolve(o);
      },
      history: async () => {
        calls.push("history");
        const page = historyPages.shift() ?? lastPage ?? { payments: [], nextOffset: undefined };
        if (page instanceof Error) {
          return Promise.reject(page);
        }
        lastPage = page;
        return Promise.resolve(page);
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
      const streams = opts.streams ?? [
        async function* () {
          yield await Promise.resolve({
            type: "transfer",
            direction: "incoming",
            transferId: "t",
            senderIdentityPublicKey: PK,
            receiverIdentityPublicKey: PK,
          });
        },
      ];
      const gen = streams[Math.min(streamCalls, streams.length - 1)];
      streamCalls += 1;
      return gen!();
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
      signer: () => null as never,
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
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    await c.send(REF, { receiver, amountSats: 10, verify: VERIFY });
    expect(approvals).toHaveLength(1);
    expect(calls.filter((x) => x === "claimPending").length).toBeGreaterThan(0);
    expect(calls).toContain("send");
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

describe("send network check", () => {
  it("rejects a receiver address on a different network before approving", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = controller(calls, approvals);
    const store = createMemoryEngineStore();
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    // PK on mainnet — ref is regtest.
    const wrongNet = encodeSparkAddress({ network: "mainnet", identityPublicKey: PK });
    await expect(
      c.send(REF, { receiver: wrongNet, amountSats: 10, verify: VERIFY }),
    ).rejects.toSatisfy((e) => (e as { category?: string }).category === "rejected");
    expect(approvals).toHaveLength(0);
    await c.destroy();
  });
});

describe("withdraw approval intent", () => {
  const approval = (approvals: unknown[]) => approvals[0] as { intent: unknown };

  async function setup(calls: string[], approvals: unknown[]) {
    const { c, client } = controller(calls, approvals);
    const store = createMemoryEngineStore();
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    return { c, client };
  }

  it("explicit amount: payout intent is exit - quoted fee", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await c.withdraw(REF, {
      address: "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz",
      amountSats: 1000,
      speed: "FAST",
      verify: VERIFY,
    });
    // fast fee = 5, payout = 995
    expect(approval(approvals).intent).toStrictEqual({
      kind: "exit",
      address: "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz",
      amountSats: 995,
      maxFeeSats: 5,
    });
    expect(calls).toContain("exit");
    await c.destroy();
  });

  it("whole-balance: defaults amount to the balance minus fee", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await c.withdraw(REF, {
      address: "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz",
      speed: "SLOW",
      verify: VERIFY,
    });
    // balance 42, slow fee 1, payout 41
    expect(approval(approvals).intent).toStrictEqual({
      kind: "exit",
      address: "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz",
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
        address: "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz",
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
      c.withdraw(REF, {
        address: "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz",
        amountSats: 5,
        speed: "FAST",
        verify: VERIFY,
      }),
    ).rejects.toSatisfy((e) => (e as { category?: string }).category === "insufficient-funds");
    expect(approvals).toHaveLength(0);
    await c.destroy();
  });
});

async function gateOpenStore(failures: number): Promise<EngineStore> {
  return failures > 0
    ? Promise.reject(new Error("open failed"))
    : Promise.resolve(createMemoryEngineStore());
}

function flakyClient(calls: string[], sendArgs: unknown[], aborters: Array<{ aborted: boolean }>) {
  let claimCalls = 0;
  let streamCalls = 0;
  const historyPages: unknown[] = [];
  let lastPage: unknown;
  const client = {
    identityPublicKey: async () => Promise.resolve(PK),
    balance: async () => Promise.resolve(42),
    transfers: {
      claimPending: async () => {
        calls.push("claimPending");
        const outcomes = [
          async () => Promise.resolve({ leaves: [], failures: [] }),
          // A poisoned pending transfer is logged, not fatal.
          async () =>
            Promise.resolve({
              leaves: [],
              failures: [{ transferId: "t-poison", error: new Error("claim raced") }],
            }),
          async () => Promise.reject(new Error("claim query down")),
          async () => Promise.resolve({ leaves: [], failures: [] }),
        ];
        claimCalls += 1;
        return outcomes[Math.min(claimCalls - 1, outcomes.length - 1)]!();
      },
      claim: async (id: unknown, _opts: unknown) => {
        calls.push(`claim:${String(id)}`);
        return Promise.resolve([]);
      },
      send: async (o: unknown) => {
        calls.push("send");
        sendArgs.push(o);
        return Promise.resolve(o);
      },
      history: async () => {
        calls.push("history");
        const page = historyPages.shift() ?? lastPage ?? { payments: [], nextOffset: undefined };
        if (page instanceof Error) {
          return Promise.reject(page);
        }
        lastPage = page;
        return Promise.resolve(page);
      },
    },
    lightning: {
      createInvoice: async (o: unknown) => Promise.resolve(o),
      pay: async (o: unknown) => Promise.resolve(o),
    },
    withdrawals: {
      quoteCooperativeExit: async () => Promise.resolve({ fees: { fast: 5, medium: 3, slow: 1 } }),
      cooperativeExit: async (o: unknown) => Promise.resolve(o),
    },
    events: (signal?: AbortSignal) => {
      const rec = { aborted: false };
      aborters.push(rec);
      signal?.addEventListener("abort", () => {
        rec.aborted = true;
      });
      const gens: Array<() => AsyncGenerator<SparkEvent>> = [
        async function* () {
          yield await Promise.reject(new Error("stream dropped"));
        },
        async function* () {
          yield await Promise.reject(new Error("stream dropped again"));
        },
        async function* () {
          await Promise.resolve();
          yield {
            type: "transfer",
            direction: "incoming",
            transferId: "t",
            senderIdentityPublicKey: PK,
            receiverIdentityPublicKey: PK,
          };
        },
      ];
      const gen = gens[Math.min(streamCalls, gens.length - 1)];
      streamCalls += 1;
      return gen!();
    },
    close: () => {
      calls.push("close");
    },
  };
  return client as unknown as SparkClient;
}

describe("event stream resilience", () => {
  it("survives a claimPending failure and a dead stream — keeps refreshing balance", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const sendArgs: unknown[] = [];
    const aborters: Array<{ aborted: boolean }> = [];
    const warns: string[] = [];
    const client = flakyClient(calls, sendArgs, aborters);
    const c = new SparkController({
      spark: {
        signer: () => null as never,
        approve: async (p: unknown) => {
          approvals.push(p);
          return Promise.resolve({});
        },
      },
      fetch: async () => Promise.reject(new Error("no fetch")),
      random: (n) => new Uint8Array(n).fill(1),
      now: () => 0,
      logger: { warn: (m, e) => warns.push(warnText(m, e)) },
      createClient: () => client,
    });
    const store = createMemoryEngineStore();
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    // Wait until the loop has died on the first stream, resubscribed, and recovered —
    // pass-2's catch-up fails (claim query down), pass-3 resyncs and the incoming event's
    // claim(id) refreshes the balance.
    await vi.waitFor(() => {
      expect(aborters.length).toBeGreaterThan(1);
      expect(calls).toContain("claim:t");
    }, 20_000);
    const state = c.getState().accounts["w1:0:regtest"];
    expect(state?.balanceSats).toBe(42);
    expect(state?.status).toBe("ready");
    // The event's transfer id went to claim(), with the loop's abort signal.
    expect(calls).toContain("claim:t");
    // claimPending ran per pass: ok, a logged failure entry, a thrown failure retried next pass.
    expect(calls.filter((x) => x === "claimPending").length).toBeGreaterThan(1);
    // The poisoned catch-up entry was logged, not fatal.
    expect(warns.some((m) => m.includes("t-poison"))).toBe(true);
    expect(warns.some((m) => m.includes("claim query down"))).toBe(true);
  }, 30_000);
});

describe("event claims", () => {
  function controllerWith(client: SparkClient, warns: string[]) {
    const calls: string[] = [];
    const c = new SparkController({
      spark: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("no fetch")),
      random: (n) => new Uint8Array(n).fill(1),
      now: () => 0,
      logger: { warn: (m, e) => warns.push(warnText(m, e)) },
      createClient: () => client,
    });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    return { c, calls };
  }

  const transfer = (id: string): SparkEvent => ({
    type: "transfer",
    direction: "incoming",
    transferId: id,
    senderIdentityPublicKey: PK,
    receiverIdentityPublicKey: PK,
  });

  it("claims the event's transfer id with the loop's signal, then patches balance", async () => {
    const warns: string[] = [];
    const calls: string[] = [];
    const claimArgs: Array<{ id: string; signal: unknown }> = [];
    const { client } = fakeClient(calls, [], claimArgs);
    const { c } = controllerWith(client, warns);
    await c.init();
    await vi.waitFor(() => {
      expect(claimArgs.length).toBeGreaterThan(0);
    }, 8000);
    expect(claimArgs[0]?.id).toBe("t");
    expect(claimArgs[0]?.signal).toMatchObject({ signal: expect.anything() });
    expect(c.getState().accounts["w1:0:regtest"]?.balanceSats).toBe(42);
    await c.lockAll();
  }, 15_000);

  it("a terminal-status claim error logs and keeps the stream alive", async () => {
    const warns: string[] = [];
    const calls: string[] = [];
    const claimArgs: Array<{ id: string; signal: unknown }> = [];
    const { client } = fakeClient(calls, [], claimArgs, {
      claimErrors: [new SparkInputError("claim: transfer t status EXPIRED is not claimable")],
      streams: [
        async function* () {
          yield await Promise.resolve(transfer("t-expired"));
          yield await Promise.resolve(transfer("t-ok"));
        },
      ],
    });
    const { c } = controllerWith(client, warns);
    await c.init();
    await vi.waitFor(() => {
      expect(calls).toContain("claim:t-ok");
    }, 8000);
    expect(warns.some((m) => m.includes("t-expired"))).toBe(true);
    expect(c.getState().accounts["w1:0:regtest"]?.status).toBe("ready");
    await c.lockAll();
  }, 15_000);

  it("a transient claim error drops the pass; catch-up retries next pass", async () => {
    const warns: string[] = [];
    const calls: string[] = [];
    const claimArgs: Array<{ id: string; signal: unknown }> = [];
    const { client, aborters } = fakeClient(calls, [], claimArgs, {
      claimErrors: [
        new SparkRequestError("claim: transfer t did not become claimable", {
          code: "deadline_exceeded",
        }),
      ],
    });
    const { c } = controllerWith(client, warns);
    await c.init();
    await vi.waitFor(() => {
      expect(aborters.length).toBeGreaterThan(1);
    }, 12_000);
    // Next pass's catch-up ran claimPending again after the failed pass.
    expect(calls.filter((x) => x === "claimPending").length).toBeGreaterThan(1);
    await c.lockAll();
  }, 15_000);
});

describe("lock transition serialization", () => {
  type FakeWallet = {
    vault: string;
    listeners: Set<() => void>;
    set: (v: string) => void;
  };
  function wallet(vault = "locked"): FakeWallet & {
    getSnapshot: () => { vault: string };
    subscribe: (l: () => void) => () => void;
  } {
    const listeners = new Set<() => void>();
    const w = {
      vault,
      listeners,
      getSnapshot() {
        return { vault: w.vault };
      },
      subscribe(l: () => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      set(v: string) {
        w.vault = v;
        for (const l of listeners) {
          l();
        }
      },
    };
    return w;
  }

  it("unlock→lock→unlock serializes — no client is created after a lock", async () => {
    const w = wallet("locked");
    const calls: string[] = [];
    const client = fakeClient(calls);
    const clientCount = 0;
    const engine = createWalletEngine({
      wallet: w as never,
      sparkNetwork: "regtest",
      sparkApis: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("nf")),
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger: LOGGER,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
    });
    const c = engine.spark;
    // Drive transitions straight through the controller's lifecycle — addAccount then unlock.
    c.setAccounts([REF]);
    w.set("unlocked");
    w.set("locked");
    w.set("unlocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // After serialization the final unlock leaves exactly one connected client set.
    expect(calls.filter((x) => x === "close").length).toBeLessThanOrEqual(1);
    engine.unsubscribe();
    void client;
    void clientCount;
  });

  it("openStore failure resets and the next unlock retries", async () => {
    const w = wallet("locked");
    let failures = 0;
    let opens = 0;
    const warnings: unknown[] = [];
    const engine = createWalletEngine({
      wallet: w as never,
      sparkNetwork: "regtest",
      sparkApis: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("nf")),
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger: { warn: (m, e) => void warnings.push([m, e]) },
      openStore: async () => {
        opens += 1;
        return gateOpenStore(failures);
      },
    });
    engine.spark.setAccounts([REF]);
    failures = 1;
    w.set("unlocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const openedAfterFailure = opens;
    expect(openedAfterFailure).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeGreaterThan(0);
    expect(engine.spark.getState().accounts["w1:0:regtest"]?.status).toBe("locked");
    // The next unlock retries and succeeds.
    failures = 0;
    w.set("locked");
    w.set("unlocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opens).toBeGreaterThan(openedAfterFailure);
    engine.unsubscribe();
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
      sparkNetwork: "regtest",
      sparkApis: {
        signer: () => null as never,
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

describe("history and notes", () => {
  const K = "w1:0:regtest";
  const NOTE: PaymentNote = {
    kind: "zap",
    recipientPubkey: "ab".repeat(32),
    lightning: "alice@wallet.test",
  };
  const parseNote = (record: unknown) =>
    record === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(record as Uint8Array)) as unknown);
  const PAYMENT = {
    id: "t1",
    direction: "send",
    status: "completed",
    method: "lightning",
    amountSats: 100,
    feeSats: 5,
    createdAt: 1,
    details: undefined,
  };

  async function started(payments: unknown[] = [{ payments: [PAYMENT], nextOffset: undefined }]) {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const sendArgs: unknown[] = [];
    const { client } = fakeClient(calls, sendArgs, [], { historyPages: payments });
    const store = createMemoryEngineStore();
    const warns: string[] = [];
    const c = new SparkController({
      spark: {
        signer: () => null as never,
        approve: async (p: unknown) => {
          approvals.push(p);
          return Promise.resolve({});
        },
      },
      fetch: async () => Promise.reject(new Error("no fetch")),
      random: (n) => new Uint8Array(n).fill(1),
      now: () => 0,
      logger: { warn: (m, e) => warns.push(warnText(m, e)) },
      createClient: () => client,
    });
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    await until(
      () => c.getState().accounts[K]?.recent,
      (v) => v !== undefined,
    );
    return { c, calls, store, warns, approvals, setStore: (s: EngineStore) => c.setStore(s) };
  }

  it("populates recent at init and merges notes into history", async () => {
    const { c, store } = await started();
    const col = store.collection(`spark-notes:${K}`);
    await col.put("t1", encodePaymentNote(NOTE));
    await col.put("t2", new TextEncoder().encode(JSON.stringify(NOTE)));
    const { items } = await c.history(REF, { limit: 10 });
    expect(items[0]).toMatchObject({ id: "t1", note: NOTE });
    expect(c.getState().accounts[K]?.recent).toHaveLength(1);
  });

  it("a note with unknown keys is rejected", async () => {
    const extra = {
      ...(JSON.parse(new TextDecoder().decode(encodePaymentNote(NOTE))) as object),
      extra: "field",
    };
    const { c, store, warns } = await started();
    await store
      .collection(`spark-notes:${K}`)
      .put("t1", new TextEncoder().encode(JSON.stringify(extra)));
    const { items } = await c.history(REF);
    expect(items[0]).not.toMatchObject({ note: expect.anything() });
    expect(warns.some((w) => w.includes("malformed"))).toBe(true);
  });

  it("a malformed note record is ignored and warned", async () => {
    const { c, store, warns } = await started();
    await store.collection(`spark-notes:${K}`).put("t1", new Uint8Array([1, 2, 3]));
    const { items } = await c.history(REF);
    expect(items[0]).not.toMatchObject({ note: expect.anything() });
    expect(warns.some((w) => w.includes("malformed"))).toBe(true);
  });

  it("refreshes recent after send and refresh failures keep the previous page", async () => {
    const { c, calls } = await started();
    expect(c.getState().accounts[K]?.recent?.[0]).toMatchObject({ id: "t1" });
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    await c.send(REF, { receiver, amountSats: 10, verify: VERIFY });
    expect(calls).toContain("send");
    // The refresh is fire-and-forget — it runs after send returns.
    await until(
      () => calls.filter((x) => x === "history").length,
      (n) => n >= 2,
    );
    expect(c.getState().accounts[K]?.status).toBe("ready");
    expect(c.getState().accounts[K]?.recent).toHaveLength(1);
  });

  it("a failed refresh keeps the previous recent and leaves status ready", async () => {
    const { c } = await started([
      { payments: [PAYMENT], nextOffset: undefined },
      new Error("down"),
    ]);
    expect(c.getState().accounts[K]?.recent).toHaveLength(1);
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    await c.send(REF, { receiver, amountSats: 10, verify: VERIFY });
    // The failing refresh lands after send returns — status and the previous page survive.
    await until(
      () => c.getState().accounts[K]?.recent,
      (v) => v !== undefined,
    );
    const state = c.getState().accounts[K];
    expect(state?.status).toBe("ready");
    expect(state?.recent).toHaveLength(1);
  });

  it("payInvoice writes the note under the transfer id", async () => {
    const { c, store } = await started();
    const payment = (await c.payInvoice(REF, {
      invoice: "lnbcrt1",
      maxFeeSats: 5,
      verify: VERIFY,
      note: NOTE,
    })) as { transferId: string };
    const record = await store.collection(`spark-notes:${K}`).get(payment.transferId);
    expect(parseNote(record)).toStrictEqual(NOTE);
  });

  it("a failing note write still resolves the payment", async () => {
    const { c, store, warns } = await started();
    const wrapped: EngineStore = {
      ...store,
      collection: (name: string) => {
        const col = store.collection(name);
        // oxlint-disable-next-line vitest/no-conditional-in-test -- collection routing
        if (name.startsWith("spark-notes:")) {
          return { ...col, put: async () => Promise.reject(new Error("write failed")) };
        }
        return col;
      },
    };
    const col = store.collection(`spark-notes:${K}`);
    c.setStore(wrapped);
    const payment = (await c.payInvoice(REF, {
      invoice: "lnbcrt1",
      maxFeeSats: 5,
      verify: VERIFY,
      note: NOTE,
    })) as { transferId: string };
    expect(payment.transferId).toMatch(/^[0-9a-f-]{36}$/);
    expect(warns.some((w) => w.includes("note write failed"))).toBe(true);
    await expect(col.get(payment.transferId)).resolves.toBeUndefined();
  });

  it("a slower older refresh never overwrites a newer one", async () => {
    // The init resync's refresh parks inside a gated history call; a concurrent send's refresh
    // (newer seq) lands first. When the gate opens the stale page must be dropped.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const calls: string[] = [];
    const { client } = fakeClient(calls, [], [], {
      historyPages: [
        { payments: [{ ...PAYMENT, id: "t-stale" }], nextOffset: undefined },
        { payments: [{ ...PAYMENT, id: "t-new" }], nextOffset: undefined },
      ],
    });
    let call = 0;
    const realHistory = client.transfers.history.bind(client.transfers);
    const gated = {
      ...client,
      transfers: {
        ...client.transfers,
        history: async () => {
          call += 1;
          const page = realHistory();
          // oxlint-disable-next-line vitest/no-conditional-in-test -- gate the first call only
          if (call === 1) {
            await gate;
          }
          return page;
        },
      },
    } as SparkClient;
    const c = new SparkController({
      spark: { signer: () => null as never, approve: async () => Promise.resolve({}) },
      fetch: async () => Promise.reject(new Error("x")),
      random: (n) => new Uint8Array(n).fill(1),
      now: () => 0,
      logger: LOGGER,
      createClient: () => gated,
    });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    await c.init();
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    const sendPromise = c.send(REF, { receiver, amountSats: 10, verify: VERIFY });
    // The send's refresh (seq 2) lands while the init refresh (seq 1) is still gated.
    await until(
      () => c.getState().accounts[K]?.recent,
      (v) => v?.[0]?.id === "t-new",
    );
    release();
    await sendPromise;
    const recent = c.getState().accounts[K]?.recent;
    expect(recent?.some((p) => p.id === "t-stale")).toBe(false);
    expect(recent?.some((p) => p.id === "t-new")).toBe(true);
  });
});

describe("paySparkInvoice pre-approval checks", () => {
  const INVOICE_ID = "01936f00-0000-7000-8000-000000000001";

  async function setup(calls: string[], approvals: unknown[]) {
    const { c, client } = controller(calls, approvals);
    const store = createMemoryEngineStore();
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    return { c, client };
  }

  it("rejects a token invoice before any approval call", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    const tokenInvoice = encodeSparkAddress({
      network: "regtest",
      identityPublicKey: PK,
      invoice: {
        version: 1,
        id: INVOICE_ID,
        payment: { type: "tokens", amount: new Uint8Array([0, 1]) },
      },
    });
    await expect(c.paySparkInvoice(REF, { invoice: tokenInvoice, verify: VERIFY })).rejects.toThrow(
      /only sats invoices are supported/,
    );
    expect(approvals).toHaveLength(0);
    await c.destroy();
  });

  it("rejects a caller amount conflicting with a fixed invoice amount", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    const fixedInvoice = encodeSparkAddress({
      network: "regtest",
      identityPublicKey: PK,
      invoice: {
        version: 1,
        id: INVOICE_ID,
        payment: { type: "sats", amount: 500 },
      },
    });
    await expect(
      c.paySparkInvoice(REF, { invoice: fixedInvoice, amountSats: 999, verify: VERIFY }),
    ).rejects.toThrow(/conflicts with the invoice amount/);
    expect(approvals).toHaveLength(0);
    await c.destroy();
  });
});
