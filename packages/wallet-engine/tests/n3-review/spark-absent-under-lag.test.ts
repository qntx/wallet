/**
 * Right after a sats commit throws a definite error, the ledger probes the operator's listing once:
 * a complete page without the transfer id means "the coordinator holds no such transfer" and the
 * record fails immediately — the thirty-minute absence bound applies only to the periodic pass. A
 * listing that was merely lagging (the commit landed, the id turns up completed a call later) still
 * resolves `failed`, and a final record is never reconciled back.
 */
import { describe, expect, it } from "vite-plus/test";

import { encodeSparkAddress, SparkInputError } from "@qntx/spark";
import type { SparkClient, SparkEvent, SparkPayment } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { SparkController } from "../../src/spark/controller.ts";
import { RECONCILE_BASE_MS, RECONCILE_MAX_MS } from "../../src/spark/payments.ts";
import type { SparkPaymentRecord } from "../../src/spark/payments.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import type { EngineStore } from "../../src/store/port.ts";
import { manualTimers } from "../support/timers.ts";

const PK = new Uint8Array(33).fill(2);
const REF: SparkAccountRef = { walletId: "w1", groupIndex: 0, network: "regtest" };
const KEY = "w1:0:regtest";
const VERIFY = { kind: "password", password: new Uint8Array([1]) } as never;
const TID = "01936f00-1111-7111-8111-111111111111";
const NOW = 1_800_000_000_000;
const RECEIVER = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
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

function rig(
  options: {
    readonly store?: EngineStore;
    readonly script?: Partial<Record<Method, ReadonlyArray<Error | "ok">>>;
    readonly scan?: (offset: number) => Promise<Page>;
    readonly recent?: () => Promise<Page>;
    readonly now?: () => number;
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
    const outcome = queues[method].shift() ?? "ok";
    return outcome === "ok" ? Promise.resolve(ok) : Promise.reject(outcome);
  };
  const client = {
    identityPublicKey: async () => Promise.resolve(PK),
    balance: async () => Promise.resolve(42),
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
      outputs: async () => Promise.resolve([]),
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
      approve: async () => Promise.resolve({}),
    },
    fetch: async () => Promise.reject(new Error("no fetch")),
    now: options.now ?? (() => NOW),
    logger: { warn: () => {} },
    createClient: () => client as unknown as SparkClient,
  });
  c.setAccounts([REF]);
  c.setStore(store);
  const records = (): Readonly<Record<string, SparkPaymentRecord>> =>
    c.getState().accounts[KEY]?.payments ?? {};
  const scans = (): number => historyCalls.filter((p) => p.limit === SCAN_PAGE).length;
  return { c, store, calls, timers, records, scans };
}

const failure = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("a sats commit error probed against a lagging operator listing", () => {
  it("fails immediately on the complete empty page — and stays failed when the id later lists", async () => {
    let now = NOW;
    // The listing lags the commit: the first scan is complete and empty, later scans carry the
    // transfer the coordinator had already accepted.
    const listing = { payments: [] as SparkPayment[] };
    const r = rig({
      script: { send: [new SparkInputError("the committed id is unknown")] },
      now: () => now,
      scan: async () => Promise.resolve(listing),
    });
    await r.c.init();

    const error = await failure(
      r.c.send(REF, {
        receiver: RECEIVER,
        amountSats: 10,
        transferId: TID,
        verify: VERIFY,
        commit: () => {},
      }),
    );

    // The caller is told the payment failed — no wait for the absence bound.
    expect(error).toMatchObject({ category: "rejected" });
    expect(r.records()[TID]).toMatchObject({
      state: "failed",
      error: "the committed id is unknown",
    });
    const probed = r.scans();
    expect(probed).toBeGreaterThanOrEqual(1);
    expect(r.timers.armed()).toBe(0); // a final record never polls

    // The id turns up completed — the operator did accept it — but nothing reconciles a final
    // record: no scan runs again and the row stays failed.
    listing.payments = [payment(TID, "completed")];
    now += RECONCILE_MAX_MS + 1;
    await r.timers.fire();
    expect(r.scans()).toBe(probed);
    expect(r.records()[TID]?.state).toBe("failed");
    await r.c.destroy();
  });
});
