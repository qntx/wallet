import { describe, expect, it } from "vite-plus/test";
import { createStore } from "zustand/vanilla";

import type { Event } from "@qntx/nostr";
import {
  encodeSparkAddress,
  encodeTokenIdentifier,
  SparkError,
  SparkInputError,
  SparkRequestError,
  SparkTokenBroadcastError,
} from "@qntx/spark";
import type { SparkClient, SparkEvent, SparkPayment, SparkTokenOutput } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { PAYMENT_PENDING_CODE } from "../src/connect/errors.ts";
import { WeblnHandler } from "../src/connect/webln.ts";
import { HistoryController } from "../src/history/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import { SparkController, sparkTransferId } from "../src/spark/controller.ts";
import { SparkControllerError } from "../src/spark/errors.ts";
import {
  decodePaymentRecord,
  encodePaymentRecord,
  RECONCILE_BASE_MS,
} from "../src/spark/payments.ts";
import type { SparkPaymentRecord } from "../src/spark/payments.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import { approval } from "./approval.ts";
import { bookDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";
import { encodeTestBolt11 } from "./support/bolt11.ts";
import { manualTimers } from "./support/timers.ts";

const PK = new Uint8Array(33).fill(2);
const REF: SparkAccountRef = { walletId: "w1", groupIndex: 0, network: "regtest" };
const KEY = "w1:0:regtest";
const COLLECTION = `spark-payments:${KEY}`;
const VERIFY = { kind: "password", password: new Uint8Array([1]) } as never;
const TID = "01936f00-1111-7111-8111-111111111111";
const NOW = 1_800_000_000_000;
const RECEIVER = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
const BTKN = encodeTokenIdentifier(new Uint8Array(32).fill(9), "regtest");
const P2TR = "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz";
const PAYEE_SECRET = new Uint8Array(32).fill(7);
const INVOICE = encodeTestBolt11({
  network: "regtest",
  amountMsat: 21_000n,
  paymentHash: new Uint8Array(32).fill(3),
  secretKey: PAYEE_SECRET,
  timestamp: NOW / 1000,
});
const LOST = new SparkRequestError("response lost", { code: "unavailable" });

/** The page size of a reconciliation scan — the `recent` refresh reads 20. */
const SCAN_PAGE = 100;

type Page = { readonly payments: ReadonlyArray<SparkPayment>; readonly nextOffset?: number };
type Method = "send" | "pay" | "exit" | "token";

const payment = (id: string, status: SparkPayment["status"], createdAt = NOW): SparkPayment => ({
  id,
  direction: "send",
  status,
  method: "spark",
  amountSats: 10,
  feeSats: 0,
  createdAt,
  details: { kind: "spark" },
});

const output = (id: string, status: SparkTokenOutput["status"]): SparkTokenOutput => ({
  id,
  tokenIdentifier: new Uint8Array(32),
  amount: 5n,
  prevTransactionHash: new Uint8Array(32),
  prevTransactionVout: 0,
  ownerPublicKey: PK,
  ...(status === undefined ? {} : { status }),
});

async function until<T>(read: () => T, want: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 500; i += 1) {
    const value = read();
    if (want(value)) {
      return value;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling is the point
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`until() gave up on ${JSON.stringify(read())}`);
}

const storedRecord = async (
  store: EngineStore,
  id: string,
): Promise<SparkPaymentRecord | undefined> => {
  const rows = await stored(store);
  return rows[id];
};

const stored = async (store: EngineStore): Promise<Record<string, SparkPaymentRecord>> => {
  const col = store.collection(COLLECTION);
  const rows: Record<string, SparkPaymentRecord> = {};
  for (const id of await col.list()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of rows
    const bytes = await col.get(id);
    const record = bytes === undefined ? undefined : decodePaymentRecord(id, bytes);
    if (record !== undefined) {
      rows[id] = record;
    }
  }
  return rows;
};

/**
 * A SparkController over a fake client: each committing method runs its script (an Error rejects
 * that attempt, "ok" resolves with the call's options), `history` answers reconciliation and the
 * `recent` refresh, `outputs` answers token reconciliation. Commit backoffs run on the next
 * microtask; the reconciliation poll is armed on manual timers the test fires.
 */
function rig(
  options: {
    readonly store?: EngineStore;
    readonly script?: Partial<Record<Method, ReadonlyArray<Error | "ok">>>;
    /** Reconciliation reads: the operator's history page at `offset`. */
    readonly scan?: (offset: number) => Promise<Page>;
    /** The `recent` refresh's first page. */
    readonly recent?: () => Promise<Page>;
    readonly outputs?: () => Promise<ReadonlyArray<SparkTokenOutput>>;
    /** The operator's `balance()` answer — an Error rejects the read. */
    readonly balance?: number | Error;
    readonly now?: () => number;
    /** The kernel approval answer — default resolves. */
    readonly approve?: (params: unknown) => Promise<unknown>;
    /** Runs inside each commit call, before it answers. */
    readonly onCommit?: (store: EngineStore) => Promise<void>;
  } = {},
) {
  const timers = manualTimers();
  const store = options.store ?? createMemoryEngineStore();
  const calls: Array<{ method: Method; params: unknown }> = [];
  const historyCalls: Array<{ limit?: number; offset?: number }> = [];
  const queues: Record<Method, Array<Error | "ok">> = {
    send: [...(options.script?.send ?? [])],
    pay: [...(options.script?.pay ?? [])],
    exit: [...(options.script?.exit ?? [])],
    token: [...(options.script?.token ?? [])],
  };
  const commit = async (method: Method, params: unknown, ok: unknown): Promise<unknown> => {
    calls.push({ method, params });
    await options.onCommit?.(store);
    const outcome = queues[method].shift() ?? "ok";
    return outcome === "ok" ? Promise.resolve(ok) : Promise.reject(outcome);
  };
  const warnings: string[] = [];
  const client = {
    identityPublicKey: async () => Promise.resolve(PK),
    balance: async () =>
      options.balance instanceof Error
        ? Promise.reject(options.balance)
        : Promise.resolve(options.balance ?? 42),
    transfers: {
      claimPending: async () => Promise.resolve({ leaves: [], failures: [] }),
      claim: async () => Promise.resolve([]),
      history: async (page: { limit?: number; offset?: number }) => {
        historyCalls.push(page);
        const empty = async (): Promise<Page> => Promise.resolve({ payments: [] });
        return page.limit === SCAN_PAGE
          ? (options.scan ?? empty)(page.offset ?? 0)
          : (options.recent ?? empty)();
      },
      send: async (o: unknown) => commit("send", o, o),
    },
    lightning: {
      pay: async (o: unknown) => commit("pay", o, o),
      sendStatus: async () => Promise.resolve({ status: "PENDING", outcome: "pending" }),
    },
    tokens: {
      balances: async () => Promise.resolve([]),
      outputs: async () => (options.outputs ?? (async () => Promise.resolve([])))(),
      transfer: async (o: unknown) => commit("token", o, "tok-hash"),
    },
    withdrawals: {
      quoteCooperativeExit: async () => Promise.resolve({ fees: { fast: 5, medium: 3, slow: 1 } }),
      cooperativeExit: async (o: unknown) => commit("exit", o, o),
    },
    events: () =>
      (async function* (): AsyncGenerator<SparkEvent> {
        await new Promise(() => undefined);
        yield* [];
      })(),
    close: () => undefined,
  };
  const approvals: unknown[] = [];
  const c = new SparkController({
    setTimer: (ms, fn) => {
      if (ms < RECONCILE_BASE_MS) {
        queueMicrotask(fn);
        return () => undefined;
      }
      return timers.setTimer(ms, fn);
    },
    spark: {
      signer: () => null as never,
      approve: async (p: unknown) => {
        approvals.push(p);
        return options.approve === undefined ? Promise.resolve({}) : options.approve(p);
      },
    },
    fetch: async () => Promise.reject(new Error("no fetch")),
    now: options.now ?? (() => NOW),
    logger: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    createClient: () => client as unknown as SparkClient,
  });
  c.setAccounts([REF]);
  c.setStore(store);
  const records = (): Readonly<Record<string, SparkPaymentRecord>> =>
    c.getState().accounts[KEY]?.payments ?? {};
  return { c, store, calls, historyCalls, approvals, timers, records, warnings };
}

const send = async (c: SparkController, transferId = TID): Promise<unknown> =>
  c.send(REF, { receiver: RECEIVER, amountSats: 10, transferId, verify: VERIFY, commit: () => {} });

const sendToken = async (c: SparkController, transferId = TID): Promise<unknown> =>
  c.sendToken(REF, {
    receiver: RECEIVER,
    tokenIdentifier: BTKN,
    amount: 5n,
    transferId,
    verify: VERIFY,
    commit: () => {},
  });

const only = <T>(items: ReadonlyArray<T>): T => {
  const [item] = items;
  if (item === undefined || items.length !== 1) {
    throw new Error(`expected exactly one item, got ${String(items.length)}`);
  }
  return item;
};

const failure = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("Spark payment records", () => {
  it("persists a submitted record before the commit call", async () => {
    const atCommit: Array<Record<string, SparkPaymentRecord>> = [];
    const r = rig({
      onCommit: async (store) => {
        atCommit.push(await stored(store));
      },
    });
    await r.c.init();
    await send(r.c);
    expect(atCommit).toStrictEqual([
      {
        [TID]: {
          id: TID,
          kind: "transfer",
          state: "submitted",
          receiver: RECEIVER,
          amount: "10",
          submittedAt: NOW,
        },
      },
    ]);
    await r.c.destroy();
  });

  it("a failed record write sends nothing", async () => {
    const store = createMemoryEngineStore();
    const r = rig({ store });
    await r.c.init();
    await store.close();
    const error = await failure(send(r.c));
    expect(error).toBeInstanceOf(SparkControllerError);
    expect(r.calls).toHaveLength(0);
    await r.c.destroy();
  });

  it("a lost commit answer leaves a persisted unknown record and reports it", async () => {
    const r = rig({ script: { send: [LOST, LOST, LOST, LOST] } });
    await r.c.init();
    const error = await failure(send(r.c));
    expect(error).toBeInstanceOf(SparkControllerError);
    expect(error).toMatchObject({
      category: "unknown",
      payment: { id: TID, kind: "transfer", state: "unknown", amount: "10" },
    });
    expect(r.records()[TID]?.state).toBe("unknown");
    await expect(storedRecord(r.store, TID)).resolves.toMatchObject({ state: "unknown" });
    await r.c.destroy();
  });

  it("a definite error after an uncertain attempt is unknown, never failed", async () => {
    const r = rig({ script: { send: [LOST, new SparkInputError("insufficient leaves")] } });
    await r.c.init();
    const error = await failure(send(r.c));
    expect(error).toMatchObject({ category: "unknown", payment: { state: "unknown" } });
    expect(r.calls).toHaveLength(2);
    await expect(storedRecord(r.store, TID)).resolves.toMatchObject({ state: "unknown" });
    await r.c.destroy();
  });

  it("a definite first-attempt error is still unknown without positive evidence", async () => {
    const r = rig({ script: { send: [new SparkInputError("bad input")] } });
    await r.c.init();
    const error = await failure(send(r.c));
    expect(error).toMatchObject({ category: "unknown", payment: { state: "unknown" } });
    expect(r.records()[TID]).toMatchObject({ state: "unknown", error: "bad input" });
    await expect(storedRecord(r.store, TID)).resolves.toMatchObject({ state: "unknown" });
    await r.c.destroy();
  });

  it.each([
    ["a SparkError", new SparkError("weird")],
    ["a non-Spark error", new Error("boom")],
  ] as const)("%s on the first sats attempt is unknown", async (_name, failure_) => {
    const r = rig({ script: { send: [failure_] } });
    await r.c.init();
    const error = await failure(send(r.c));
    expect(error).toMatchObject({ category: "unknown", payment: { state: "unknown" } });
    expect(r.calls).toHaveLength(1);
    await r.c.destroy();
  });

  it("a retryable request error on the first attempt recovers", async () => {
    const r = rig({ script: { send: [LOST] } });
    await r.c.init();
    await send(r.c);
    expect(r.calls.filter((call) => call.method === "send")).toHaveLength(2);
    expect(r.records()[TID]?.state).not.toBe("unknown");
    await r.c.destroy();
  });

  it("an approval refusal writes no record and commits nothing", async () => {
    const r = rig({ approve: async () => Promise.reject(new Error("refused")) });
    await r.c.init();
    const error = await failure(send(r.c));
    expect(error).toBeInstanceOf(Error);
    expect(r.calls).toHaveLength(0);
    expect(r.records()).toStrictEqual({});
    await r.c.destroy();
  });

  it("a listed failure refolds the commit error, a listed success refolds as unknown", async () => {
    const TID2 = "01936f00-3333-7333-8333-333333333333";
    let listed: ReadonlyArray<SparkPayment> = [payment(TID, "failed")];
    const r = rig({
      script: { send: [LOST, LOST, LOST, LOST, LOST, LOST, LOST, LOST] },
      scan: async () => Promise.resolve({ payments: listed }),
    });
    await r.c.init();
    const failed = await failure(send(r.c));
    expect(failed).toBeInstanceOf(SparkControllerError);
    expect((failed as SparkControllerError).category).not.toBe("unknown");
    expect(r.records()[TID]?.state).toBe("failed");
    listed = [payment(TID2, "completed")];
    const settled = await failure(send(r.c, TID2));
    expect(settled).toMatchObject({
      category: "unknown",
      payment: { id: TID2, state: "settled" },
    });
    await r.c.destroy();
  });

  it("a returned payment settles from the recent page and leaves no row", async () => {
    let recent: ReadonlyArray<SparkPayment> = [];
    const r = rig({ recent: async () => Promise.resolve({ payments: recent }) });
    await r.c.init();
    recent = [payment(TID, "completed")];
    await send(r.c);
    await until(r.records, (records) => records[TID]?.state === "settled");
    await expect(stored(r.store)).resolves.toStrictEqual({});
    await r.c.destroy();
  });

  it("an unreadable row is skipped with a warning", async () => {
    const store = createMemoryEngineStore();
    await store.collection(COLLECTION).put("x", new TextEncoder().encode("{not json"));
    const misfiled = encodePaymentRecord({
      id: TID,
      kind: "transfer",
      state: "unknown",
      receiver: RECEIVER,
      amount: "10",
      submittedAt: NOW,
    });
    await store.collection(COLLECTION).put("other-id", misfiled);
    const r = rig({ store });
    await r.c.init();
    await until(
      () => r.warnings,
      (w) => w.filter((m) => m === "spark payment record ignored: unreadable").length === 2,
    );
    expect(r.records()).toStrictEqual({});
    await r.c.destroy();
  });
});

describe("Spark sats balance preflight", () => {
  const SPARK_INVOICE = encodeSparkAddress({
    network: "regtest",
    identityPublicKey: PK,
    invoice: {
      version: 1,
      id: "01936f00-0000-7000-8000-000000000001",
      payment: { type: "sats", amount: 30 },
    },
  });

  it("a transfer the balance cannot cover refuses before any record", async () => {
    const r = rig({ balance: 9 });
    await r.c.init();
    const error = await failure(send(r.c));
    expect(error).toMatchObject({ category: "insufficient-funds" });
    expect(r.calls).toHaveLength(0);
    expect(r.records()).toStrictEqual({});
    expect(r.approvals).toHaveLength(1);
    await r.c.destroy();
  });

  it("a lightning payment checks amount plus its fee bound", async () => {
    const r = rig({ balance: 25 });
    await r.c.init();
    const error = await failure(
      r.c.payInvoice(REF, {
        invoice: INVOICE,
        maxFeeSats: 5,
        transferId: TID,
        verify: VERIFY,
        commit: () => {},
      }),
    );
    expect(error).toMatchObject({ category: "insufficient-funds" });
    expect(r.calls).toHaveLength(0);
    expect(r.records()).toStrictEqual({});
    await r.c.destroy();
  });

  it("a spark invoice checks its amount", async () => {
    const r = rig({ balance: 29 });
    await r.c.init();
    const error = await failure(
      r.c.paySparkInvoice(REF, {
        invoice: SPARK_INVOICE,
        transferId: TID,
        verify: VERIFY,
        commit: () => {},
      }),
    );
    expect(error).toMatchObject({ category: "insufficient-funds" });
    expect(r.calls).toHaveLength(0);
    expect(r.records()).toStrictEqual({});
    await r.c.destroy();
  });

  it("a cooperative exit checks amount plus the converged fee", async () => {
    const r = rig({ balance: 0 });
    await r.c.init();
    const error = await failure(
      r.c.withdraw(REF, {
        address: P2TR,
        amountSats: 1000,
        speed: "FAST",
        maxFeeSats: 10,
        transferId: TID,
        verify: VERIFY,
        commit: () => {},
      }),
    );
    expect(error).toMatchObject({ category: "insufficient-funds" });
    expect(r.calls).toHaveLength(0);
    expect(r.records()).toStrictEqual({});
    await r.c.destroy();
  });

  it("a balance exactly covering the debit proceeds", async () => {
    const r = rig({ balance: 10 });
    await r.c.init();
    await send(r.c);
    expect(r.calls.filter((call) => call.method === "send")).toHaveLength(1);
    await r.c.destroy();
  });

  it("an unreadable balance is a network error with no record", async () => {
    const r = rig({ balance: new SparkRequestError("balance read failed") });
    await r.c.init();
    const error = await failure(send(r.c));
    expect(error).toMatchObject({ category: "network" });
    expect(r.calls).toHaveLength(0);
    expect(r.records()).toStrictEqual({});
    await r.c.destroy();
  });

  it("a token send has no sats preflight", async () => {
    const r = rig({ balance: 0 });
    await r.c.init();
    await expect(sendToken(r.c)).resolves.toBe("tok-hash");
    await r.c.destroy();
  });
});

describe("Spark duplicate refusal", () => {
  const OTHER_TID = "01936f00-2222-7222-8222-222222222222";

  it("a second send matching an unresolved record is refused", async () => {
    const r = rig({ script: { send: [LOST, LOST, LOST, LOST] } });
    await r.c.init();
    await failure(send(r.c));
    const second = await failure(send(r.c, OTHER_TID));
    expect(second).toMatchObject({
      category: "duplicate",
      payment: { id: TID, kind: "transfer", state: "unknown" },
    });
    expect(r.calls.filter((call) => call.method === "send")).toHaveLength(4);
    expect(r.records()[OTHER_TID]).toBeUndefined();
    await r.c.destroy();
  });

  it("the same transfer id is an idempotent resume, not a duplicate", async () => {
    const r = rig({ script: { send: [LOST, LOST, LOST, LOST] } });
    await r.c.init();
    await failure(send(r.c));
    await send(r.c);
    expect(r.calls.filter((call) => call.method === "send")).toHaveLength(5);
    expect(r.records()[TID]?.state).not.toBe("unknown");
    await r.c.destroy();
  });

  it("a different amount to the same receiver is not a duplicate", async () => {
    const r = rig({ script: { send: [LOST, LOST, LOST, LOST] } });
    await r.c.init();
    await failure(send(r.c));
    await r.c.send(REF, {
      receiver: RECEIVER,
      amountSats: 11,
      transferId: OTHER_TID,
      verify: VERIFY,
      commit: () => {},
    });
    expect(r.records()[OTHER_TID]?.state).toBe("submitted");
    await r.c.destroy();
  });

  it("an unresolved token record blocks its re-send too", async () => {
    /* A token record without its spent output ids is not reconcilable, so `holdsToken` does not
       refuse first — the duplicate check does. */
    const r = rig({ script: { token: [new SparkError("weird")] } });
    await r.c.init();
    await failure(sendToken(r.c));
    const second = await failure(sendToken(r.c, OTHER_TID));
    expect(second).toMatchObject({ category: "duplicate", payment: { id: TID, kind: "token" } });
    await r.c.destroy();
  });

  it("an unresolved record for a different token does not block", async () => {
    const lost = new SparkTokenBroadcastError("lost", { inputOutputIds: ["a:0"] });
    const r = rig({
      script: { token: [lost, lost, lost, lost] },
      outputs: async () => Promise.resolve([output("a:0", "pending-outbound")]),
    });
    await r.c.init();
    await failure(sendToken(r.c));
    await r.c.sendToken(REF, {
      receiver: RECEIVER,
      tokenIdentifier: encodeTokenIdentifier(new Uint8Array(32).fill(8), "regtest"),
      amount: 5n,
      transferId: OTHER_TID,
      verify: VERIFY,
      commit: () => {},
    });
    expect(r.records()[OTHER_TID]?.state).toBe("settled");
    await r.c.destroy();
  });
});

describe("Spark payment reconciliation", () => {
  const open = (overrides: Partial<SparkPaymentRecord> = {}): SparkPaymentRecord => ({
    id: TID,
    kind: "transfer",
    state: "unknown",
    receiver: RECEIVER,
    amount: "10",
    submittedAt: NOW,
    ...overrides,
  });

  const storeWith = async (...records: SparkPaymentRecord[]): Promise<EngineStore> => {
    const store = createMemoryEngineStore();
    for (const record of records) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of rows
      await store.collection(COLLECTION).put(record.id, encodePaymentRecord(record));
    }
    return store;
  };

  it("a restart reloads a pending record and settles it from the operator's history", async () => {
    const store = await storeWith(open());
    const r = rig({
      store,
      scan: async () => Promise.resolve({ payments: [payment(TID, "completed")] }),
    });
    await r.c.init();
    await until(r.records, (records) => records[TID]?.state === "settled");
    await expect(stored(store)).resolves.toStrictEqual({});
    await r.c.destroy();
  });

  it("a payment the operator still reports pending stays open and is polled with backoff", async () => {
    let now = NOW;
    let status: SparkPayment["status"] = "pending";
    const r = rig({
      store: await storeWith(open()),
      now: () => now,
      scan: async () => Promise.resolve({ payments: [payment(TID, status)] }),
    });
    await r.c.init();
    await until(
      () => r.timers.armed(),
      (n) => n === 1,
    );
    await until(
      () => r.historyCalls.filter((p) => p.limit === 100).length,
      (n) => n >= 1,
    );
    const scans = (): number => r.historyCalls.filter((p) => p.limit === 100).length;
    const first = scans();
    // Not due yet: a tick inside the backoff window asks nothing.
    now += RECONCILE_BASE_MS - 1;
    await r.timers.fire();
    expect(scans()).toBe(first);
    now += 1;
    await r.timers.fire();
    expect(scans()).toBe(first + 1);
    // The window doubled.
    now += RECONCILE_BASE_MS;
    await r.timers.fire();
    expect(scans()).toBe(first + 1);
    now += RECONCILE_BASE_MS;
    status = "completed";
    await r.timers.fire();
    expect(r.records()[TID]?.state).toBe("settled");
    // Nothing open: the poll stops.
    expect(r.timers.armed()).toBe(0);
    await r.c.destroy();
  });

  it("a definitive failure from the operator fails the record", async () => {
    const r = rig({
      store: await storeWith(open()),
      scan: async () => Promise.resolve({ payments: [payment(TID, "failed")] }),
    });
    await r.c.init();
    await until(r.records, (records) => records[TID]?.state === "failed");
    expect(r.records()[TID]?.error).toBe("the Spark operator reports the payment failed");
    await r.c.destroy();
  });

  it("an id the operator does not list stays unknown at any age", async () => {
    let now = NOW;
    const r = rig({ store: await storeWith(open()), now: () => now });
    await r.c.init();
    await until(
      () => r.historyCalls.filter((p) => p.limit === 100).length,
      (n) => n >= 1,
    );
    expect(r.records()[TID]?.state).toBe("unknown");
    now = NOW + 3_600_000;
    await r.timers.fire();
    expect(r.records()[TID]?.state).toBe("unknown");
    now = NOW + 86_400_000;
    await r.timers.fire();
    expect(r.records()[TID]?.state).toBe("unknown");
    await r.c.destroy();
  });

  it("an incomplete listing never fails an absent id", async () => {
    const r = rig({
      store: await storeWith(open()),
      now: () => NOW + 3_600_000,
      // Ten full pages, all newer than the record: the scan stops at its page limit.
      scan: async (offset) =>
        Promise.resolve({
          payments: [payment("other", "completed", NOW)],
          nextOffset: offset + 100,
        }),
    });
    await r.c.init();
    await until(
      () => r.historyCalls.filter((p) => p.limit === 100).length,
      (n) => n >= 10,
    );
    await until(
      () => r.timers.armed(),
      (n) => n === 1,
    );
    expect(r.historyCalls.filter((p) => p.limit === 100).map((p) => p.offset)).toStrictEqual([
      0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
    ]);
    expect(r.records()[TID]?.state).toBe("unknown");
    await r.c.destroy();
  });

  it("a listing complete past the record's age still proves nothing", async () => {
    const r = rig({
      store: await storeWith(open()),
      now: () => NOW + 3_600_000,
      scan: async (offset) =>
        Promise.resolve({
          payments: [payment("older", "completed", NOW - 3_600_000)],
          nextOffset: offset + 100,
        }),
    });
    await r.c.init();
    await until(
      () => r.timers.armed(),
      (n) => n === 1,
    );
    expect(r.historyCalls.filter((p) => p.limit === 100)).toHaveLength(1);
    expect(r.records()[TID]?.state).toBe("unknown");
    await r.c.destroy();
  });

  it("a history read error decides nothing", async () => {
    const r = rig({
      store: await storeWith(open()),
      now: () => NOW + 3_600_000,
      scan: async () => Promise.reject(new SparkRequestError("down")),
    });
    await r.c.init();
    await until(
      () => r.warnings,
      (w) => w.includes("spark payment reconciliation failed"),
    );
    expect(r.records()[TID]?.state).toBe("unknown");
    await r.c.destroy();
  });

  it("a lock during reconciliation writes nothing and stops the poll", async () => {
    let answer: (page: Page) => void = () => undefined;
    const store = await storeWith(open());
    const r = rig({
      store,
      scan: async () =>
        new Promise<Page>((resolve) => {
          answer = resolve;
        }),
    });
    await r.c.init();
    await until(
      () => r.historyCalls.filter((p) => p.limit === 100).length,
      (n) => n === 1,
    );
    await r.c.lockAll();
    answer({ payments: [payment(TID, "completed")] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.c.getState().accounts[KEY]).toStrictEqual({ status: "locked" });
    await expect(storedRecord(store, TID)).resolves.toMatchObject({ state: "unknown" });
    expect(r.timers.armed()).toBe(0);
    await r.c.destroy();
  });

  it("an exit whose answer was lost settles once the operator lists it", async () => {
    let listed: ReadonlyArray<SparkPayment> = [];
    const r = rig({
      script: { exit: [LOST, LOST, LOST, LOST] },
      balance: 2000,
      scan: async () => Promise.resolve({ payments: listed }),
    });
    await r.c.init();
    const error = await failure(
      r.c.withdraw(REF, {
        address: P2TR,
        amountSats: 1000,
        speed: "FAST",
        maxFeeSats: 10,
        transferId: TID,
        verify: VERIFY,
        commit: () => {},
      }),
    );
    expect(error).toMatchObject({
      category: "unknown",
      payment: { kind: "exit", receiver: P2TR, amount: "1000", state: "unknown" },
    });
    listed = [{ ...payment(TID, "completed"), method: "withdraw" }];
    await r.timers.fire();
    await until(r.records, (records) => records[TID]?.state === "settled");
    await r.c.destroy();
  });

  it("a lightning record names the payee and the invoice amount", async () => {
    const r = rig({ script: { pay: [LOST, LOST, LOST, LOST] } });
    await r.c.init();
    const error = await failure(
      r.c.payInvoice(REF, {
        invoice: INVOICE,
        maxFeeSats: 5,
        transferId: TID,
        verify: VERIFY,
        commit: () => {},
      }),
    );
    expect(error).toMatchObject({
      category: "unknown",
      payment: { kind: "lightning", amount: "21", state: "unknown" },
    });
    expect((error as SparkControllerError).payment?.receiver).toMatch(/^0[23][0-9a-f]{64}$/);
    await r.c.destroy();
  });
});

describe("Spark token payment records", () => {
  const broadcastLost = (): SparkTokenBroadcastError =>
    new SparkTokenBroadcastError("lost", { inputOutputIds: ["a:0", "b:1"] });

  it("a returned token transfer settles with its hash", async () => {
    const r = rig();
    await r.c.init();
    await expect(sendToken(r.c)).resolves.toBe("tok-hash");
    expect(r.records()[TID]).toMatchObject({
      kind: "token",
      state: "settled",
      tokenIdentifier: BTKN,
      amount: "5",
      transactionHash: "tok-hash",
    });
    await r.c.destroy();
  });

  it.each([
    ["a SparkRequestError", new SparkRequestError("down")],
    ["a SparkInputError", new SparkInputError("bad token input")],
  ] as const)("a definite commit error fails a token record: %s", async (_name, failure_) => {
    const r = rig({ script: { token: [failure_] } });
    await r.c.init();
    const error = await failure(sendToken(r.c));
    expect(error).toBeInstanceOf(SparkControllerError);
    expect((error as SparkControllerError).category).not.toBe("unknown");
    expect(r.records()[TID]).toMatchObject({ state: "failed" });
    await expect(stored(r.store)).resolves.toStrictEqual({});
    await r.c.destroy();
  });

  it.each([
    ["a SparkError", new SparkError("weird")],
    ["a non-Spark error", new Error("boom")],
  ] as const)("an uncertain commit error is unknown: %s", async (_name, failure_) => {
    const r = rig({ script: { token: [failure_] } });
    await r.c.init();
    const error = await failure(sendToken(r.c));
    expect(error).toMatchObject({ category: "unknown", payment: { kind: "token" } });
    expect(r.records()[TID]?.state).toBe("unknown");
    await r.c.destroy();
  });

  it("a failed token record write sends nothing", async () => {
    const store = createMemoryEngineStore();
    const r = rig({ store });
    await r.c.init();
    await store.close();
    const error = await failure(sendToken(r.c));
    expect(error).toBeInstanceOf(Error);
    expect(r.calls).toHaveLength(0);
    await r.c.destroy();
  });

  it.each([
    ["inputs available again fail it", [output("a:0", "available")], "failed"],
    ["inputs no longer owned settle it", [output("c:0", "available")], "settled"],
    ["inputs still pending-outbound keep it open", [output("a:0", "pending-outbound")], "unknown"],
  ] as const)("a lost token broadcast: %s", async (_name, answer, state) => {
    let owned: ReadonlyArray<SparkTokenOutput> = [output("a:0", "pending-outbound")];
    const r = rig({
      script: { token: [broadcastLost(), broadcastLost(), broadcastLost(), broadcastLost()] },
      outputs: async () => Promise.resolve(owned),
    });
    await r.c.init();
    const error = await failure(sendToken(r.c));
    expect(error).toMatchObject({
      category: "unknown",
      payment: { kind: "token", state: "unknown", inputOutputIds: ["a:0", "b:1"] },
    });
    await expect(storedRecord(r.store, TID)).resolves.toMatchObject({
      inputOutputIds: ["a:0", "b:1"],
    });
    owned = answer;
    await r.timers.fire();
    await until(r.records, (records) => records[TID]?.state === state);
    await r.c.destroy();
  });

  it("refuses another send of the token while an uncertain one is open", async () => {
    const r = rig({
      script: { token: [broadcastLost(), broadcastLost(), broadcastLost(), broadcastLost()] },
      outputs: async () => Promise.resolve([output("a:0", "pending-outbound")]),
    });
    await r.c.init();
    await failure(sendToken(r.c));
    const second = await failure(sendToken(r.c, "01936f00-2222-7222-8222-222222222222"));
    expect(second).toMatchObject({
      category: "rejected",
      message: "an earlier transfer of this token is still unresolved",
    });
    expect(r.approvals).toHaveLength(1);
    expect(r.calls.filter((call) => call.method === "token")).toHaveLength(4);
    await r.c.destroy();
  });
});

/** The request pipeline over the real SparkController of `rig`. */
function pipeline(spark: SparkController): RequestController {
  const unused = async (): Promise<never> => Promise.reject(new Error("unused"));
  return new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    nostrSign: async (): Promise<Event> => unused(),
    bitcoinPrepare: unused,
    bitcoinSignPsbts: unused,
    bitcoinSign: unused,
    solanaSign: unused,
    transactions: {} as TransactionController,
    ...bookDeps(),
    spark,
    fetch: async () => Promise.reject(new Error("no fetch")),
    random: (n) => new Uint8Array(n).fill(1),
    now: () => NOW,
    setTimer: () => () => undefined,
    logger: { warn: () => undefined },
  });
}

describe("Spark payment outcomes through the request pipeline", () => {
  const PAY = {
    method: "pay",
    account: REF,
    option: { kind: "spark", address: RECEIVER },
    amountSats: 10,
  } as const;

  it("a lost commit answer resolves pending with the record the account keeps following", async () => {
    const r = rig({ script: { send: [LOST, LOST, LOST, LOST] } });
    await r.c.init();
    const requests = pipeline(r.c);
    await requests.init();
    const request = await requests.prepare(PAY);
    const id = sparkTransferId(request.id, NOW);
    const result = await requests.approve(request.id, "pay", approval(request, VERIFY));
    expect(result).toStrictEqual({
      kind: "pending",
      payment: {
        id,
        kind: "transfer",
        state: "unknown",
        receiver: RECEIVER,
        amount: "10",
        submittedAt: NOW,
        error: "response lost",
      },
    });
    expect(requests.getState().requests[request.id]?.stage).toBe("submitted");
    expect(r.records()[id]?.state).toBe("unknown");
    await expect(storedRecord(r.store, id)).resolves.toMatchObject({ state: "unknown" });
    await r.c.destroy();
  });

  it("a duplicate approve of one request commits once", async () => {
    const r = rig();
    await r.c.init();
    const requests = pipeline(r.c);
    await requests.init();
    const request = await requests.prepare(PAY);
    const first = requests.approve(request.id, "pay", approval(request, VERIFY));
    const second = failure(requests.approve(request.id, "pay", approval(request, VERIFY)));
    await first;
    await expect(second).resolves.toBeInstanceOf(Error);
    await expect(requests.approve(request.id, "pay", approval(request, VERIFY))).rejects.toThrow(
      /submitted, not awaiting approval/,
    );
    expect(r.calls).toHaveLength(1);
    expect(r.approvals).toHaveLength(1);
    expect(Object.keys(r.records())).toStrictEqual([sparkTransferId(request.id, NOW)]);
    await r.c.destroy();
  });
});

describe("WebLN payments past the preimage poll budget", () => {
  const SITE = "https://app.example.com";

  it("answer payment-pending, stay recorded, and settle once the operator lists them", async () => {
    let listed: ReadonlyArray<SparkPayment> = [];
    const r = rig({ scan: async () => Promise.resolve({ payments: listed }) });
    await r.c.init();
    const requests = pipeline(r.c);
    await requests.init();
    const webln = new WeblnHandler({
      connections: {
        checkOrigin: (origin) => ({ kind: "browser", origin }),
        authorize: () => ({ id: "s1" }) as never,
        session: () => ({ id: "s1" }) as never,
        sessionAccounts: () => ({ group: { walletId: "w1", groupIndex: 0 }, addresses: [] }),
        lightningPolicy: () => ({ balance: false }),
        request: async () => Promise.reject(new Error("unused")),
        touch: async () => Promise.resolve(),
      },
      requests,
      spark: r.c,
      sparkNetwork: "regtest",
      now: () => NOW,
      alias: "qntx",
      lightningMaxFee: () => 5,
      sleep: async () => Promise.resolve(),
    });
    const paid = failure(webln.handle(SITE, { method: "sendPayment", params: INVOICE }));
    const request = only(
      await until(
        () => Object.values(requests.getState().requests),
        (all) => all.length === 1,
      ),
    );
    await requests.approve(request.id, "pay", approval(request, VERIFY));
    await expect(paid).resolves.toMatchObject({ code: PAYMENT_PENDING_CODE });
    const id = sparkTransferId(request.id, NOW);
    expect(r.records()[id]).toMatchObject({ kind: "lightning", state: "submitted", amount: "21" });
    listed = [{ ...payment(id, "completed"), method: "lightning" }];
    await r.timers.fire();
    await until(r.records, (records) => records[id]?.state === "settled");
    await r.c.destroy();
  });
});

describe("Spark payment records in history", () => {
  function history(spark: SparkController, page: () => ReadonlyArray<SparkPayment>) {
    return new HistoryController({
      networks: {
        enabled: () => [],
        client: () => undefined,
        independentClient: () => ({ kind: "unavailable" }),
        independentSolanaRpc: () => ({ kind: "unavailable" }),
        independentEsplora: () => ({ kind: "unavailable" }),
        solanaRpc: () => undefined,
        esplora: () => undefined,
      },
      chains: { account: async () => Promise.resolve({}) },
      spark: {
        history: async () => Promise.resolve({ items: page(), nextOffset: undefined }),
        store: spark.store,
      },
      sparkNetwork: "regtest",
      transactions: { store: createStore(() => ({ txs: {} })) },
      addressBook: { store: createStore(() => ({ entries: {} })) },
      gateway: undefined,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: () => () => undefined,
      now: () => NOW,
      logger: { warn: () => undefined },
    } as never);
  }

  it("shows an open payment as pending and lets the operator's entry replace it", async () => {
    let operator: ReadonlyArray<SparkPayment> = [];
    const r = rig({ script: { send: [LOST, LOST, LOST, LOST] } });
    await r.c.init();
    const h = history(r.c, () => operator);
    await h.init();
    await h.load({ walletId: "w1", groupIndex: 0 });
    await failure(send(r.c));
    const entries = (): ReadonlyArray<unknown> | undefined => h.getState().groups["w1:0"]?.entries;
    expect(entries()).toMatchObject([
      {
        id: `spark:regtest:${TID}`,
        family: "spark",
        status: "pending",
        origin: "local",
        verified: false,
        counterparties: [RECEIVER],
        changes: [{ direction: "out", asset: "sats", amount: "10" }],
      },
    ]);
    operator = [payment(TID, "completed")];
    await h.load({ walletId: "w1", groupIndex: 0 });
    expect(entries()).toMatchObject([
      { id: `spark:regtest:${TID}`, status: "confirmed", origin: "chain" },
    ]);
    h.lock();
    await r.c.destroy();
  });

  it("lists a settled token send, which the operator's history never shows", async () => {
    const r = rig();
    await r.c.init();
    const h = history(r.c, () => []);
    await h.init();
    await h.load({ walletId: "w1", groupIndex: 0 });
    await sendToken(r.c);
    expect(h.getState().groups["w1:0"]?.entries).toMatchObject([
      {
        id: `spark:regtest:${TID}`,
        status: "confirmed",
        origin: "local",
        changes: [{ direction: "out", asset: BTKN, amount: "5", listed: false }],
      },
    ]);
    h.lock();
    await r.c.destroy();
  });
});
