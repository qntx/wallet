import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "@qntx/wallet-chains/evm";

import {
  RESIMULATE_AFTER_MS,
  RequestController,
  SimulationChangedError,
} from "../src/requests/controller.ts";
import { simulationChanged } from "../src/requests/simulation.ts";
import type { AssetChange, SimulationOutcome } from "../src/requests/simulation.ts";
import type { SparkController } from "../src/spark/controller.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type {
  DisplayIntent,
  PrepareParams,
  PreparedRequest,
  SendParams,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { bookDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const SEPOLIA = "eip155:11155111";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_ACCOUNT = {
  walletId: "w",
  groupIndex: 0,
  address: "11111111111111111111111111111112",
};
const ORIGIN = { kind: "browser", origin: "https://app.example" } as const;
const VERIFY = { kind: "password" as const, password: "pw" };
const START = 1000;

const INTENT: DisplayIntent = decodeEvm({
  kind: "evm.transaction",
  network: SEPOLIA,
  account: ACCOUNT,
  tx: {
    type: "legacy",
    chainId: 11155111,
    nonce: 0,
    gas: "0x5208",
    to: "0x00000000000000000000000000000000deadbeef",
    value: "0x64",
    data: "0x",
    gasPrice: "0x1",
  },
});

const succeed = (amount: string): SimulationOutcome => ({
  status: "success",
  changes: [{ asset: "native", amount, verified: true }],
});

const tracked = (id: string): TrackedTransaction => ({
  id,
  family: "evm",
  network: SEPOLIA,
  account: "w",
  hash: "0x1",
  state: "submitted",
  intent: undefined,
  nonce: 0,
  submittedAt: 0,
  error: undefined,
});

/**
 * A transactions stand-in whose prepared send simulates once, then re-simulates from a queue at
 * approval; `signed` records every submission.
 */
function rig(first: SimulationOutcome) {
  let now = START;
  let hook: (() => void) | undefined;
  const resimCalls: number[] = [];
  const queue: SimulationOutcome[] = [];
  const signed: string[] = [];
  const submit = (requestId: string): PreparedRequest["submit"] => {
    return async (verify: SendParams["verify"]) => {
      signed.push(verify.kind);
      return Promise.resolve(tracked(`tx-${requestId}`));
    };
  };
  const transactions = {
    getState: () => ({ txs: {} }),
    prepareSend: async (_params: PrepareParams, requestId: string): Promise<PreparedRequest> =>
      Promise.resolve({
        txId: `tx-${requestId}`,
        account: ACCOUNT,
        network: SEPOLIA,
        intent: INTENT,
        checks: [],
        simulation: first,
        resimulate: async () => {
          resimCalls.push(1);
          hook?.();
          return Promise.resolve(queue.shift() ?? first);
        },
        staleReason: () => undefined,
        submit: submit(requestId),
        release: () => undefined,
      }),
    prepareReplacement: async (_input: unknown, requestId: string): Promise<PreparedRequest> =>
      Promise.resolve({
        txId: `tx-${requestId}`,
        account: ACCOUNT,
        network: SEPOLIA,
        intent: INTENT,
        checks: [],
        staleReason: () => undefined,
        submit: submit(requestId),
        release: () => undefined,
      }),
  } as unknown as TransactionController;
  let counter = 0;
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: globalThis.fetch,
    random: (n) => {
      counter += 1;
      return new Uint8Array(n).fill(counter % 251);
    },
    now: () => now,
    setTimer: () => () => undefined,
    logger: { warn: () => undefined },
  });
  return {
    requests,
    resimCalls,
    queue,
    signed,
    advance: (ms: number) => {
      now += ms;
    },
    duringResimulate: (fn: () => void) => {
      hook = fn;
    },
  };
}

/** A Solana rig whose `simulateSolana` answers from `outcomes` in order. */
function solanaRig(outcomes: ReadonlyArray<SimulationOutcome>) {
  let now = START;
  let counter = 0;
  const simulateCalls: Uint8Array[] = [];
  const signCalls: string[] = [];
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    tokens: tokensStub,
    simulateSolana: async (_account, _network, message) => {
      simulateCalls.push(message);
      const outcome = outcomes[Math.min(simulateCalls.length - 1, outcomes.length - 1)];
      if (outcome === undefined) {
        throw new Error("no outcome queued");
      }
      return Promise.resolve(outcome);
    },
    transactions: {} as unknown as TransactionController,
    ...bookDeps(),
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => {
      signCalls.push("sign");
      return Promise.resolve({ kind: "solana.transactions" as const, send: false });
    },
    fetch: globalThis.fetch,
    random: (n) => {
      counter += 1;
      return new Uint8Array(n).fill(counter % 251);
    },
    now: () => now,
    setTimer: () => () => undefined,
    logger: { warn: () => undefined },
  });
  return {
    requests,
    simulateCalls,
    signCalls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const PARAMS = {
  method: "send" as const,
  account: ACCOUNT,
  network: SEPOLIA,
  to: "0x00000000000000000000000000000000deadbeef",
  amount: 100n,
  fee: "normal" as const,
};

describe("simulationChanged", () => {
  const outcome = (entries: ReadonlyArray<[string, string]>): SimulationOutcome => ({
    status: "success",
    changes: entries.map(([asset, amount]): AssetChange => ({ asset, amount, verified: false })),
  });

  it("an identical outcome is unchanged", () => {
    const a = outcome([["native", "-100"]]);
    expect(simulationChanged(a, outcome([["native", "-100"]]))).toBe(false);
  });

  it("within 5% is unchanged, beyond it in either direction is changed", () => {
    const a = outcome([["native", "100"]]);
    expect(simulationChanged(a, outcome([["native", "105"]]))).toBe(false);
    expect(simulationChanged(a, outcome([["native", "104"]]))).toBe(false);
    expect(simulationChanged(a, outcome([["native", "106"]]))).toBe(true);
    expect(simulationChanged(a, outcome([["native", "94"]]))).toBe(true);
    const out = outcome([["native", "-100"]]);
    expect(simulationChanged(out, outcome([["native", "-105"]]))).toBe(false);
    expect(simulationChanged(out, outcome([["native", "-106"]]))).toBe(true);
  });

  it("an appearing or disappearing asset is changed", () => {
    const a = outcome([["native", "-100"]]);
    expect(
      simulationChanged(
        a,
        outcome([
          ["native", "-100"],
          ["0xToken", "50"],
        ]),
      ),
    ).toBe(true);
    expect(
      simulationChanged(
        outcome([
          ["native", "-100"],
          ["0xToken", "50"],
        ]),
        a,
      ),
    ).toBe(true);
  });

  it("a zero amount becoming non-zero is changed", () => {
    expect(simulationChanged(outcome([["native", "0"]]), outcome([["native", "1"]]))).toBe(true);
  });

  it("EVM asset ids compare case-insensitively", () => {
    const a = outcome([["0xAbC", "100"]]);
    expect(simulationChanged(a, outcome([["0xabc", "100"]]))).toBe(false);
  });

  it("a status change is changed; two failing outcomes are not", () => {
    const success = outcome([["native", "-100"]]);
    const reverted: SimulationOutcome = { status: "reverted", error: "boom" };
    const other: SimulationOutcome = { status: "reverted", error: "different" };
    const unavailable: SimulationOutcome = { status: "unavailable", error: "down" };
    expect(simulationChanged(success, reverted)).toBe(true);
    expect(simulationChanged(reverted, success)).toBe(true);
    expect(simulationChanged(success, unavailable)).toBe(true);
    expect(simulationChanged(reverted, other)).toBe(false);
  });
});

describe("approval-time re-simulation", () => {
  it("approve within 60 s signs without re-simulating", async () => {
    const f = rig(succeed("-100"));
    await f.requests.init();
    const request = await f.requests.prepare(PARAMS);
    expect(request.simulatedAt).toBe(START);
    f.advance(RESIMULATE_AFTER_MS - 1);
    await f.requests.approve(request.id, "send", VERIFY);
    expect(f.resimCalls).toHaveLength(0);
    expect(f.signed).toHaveLength(1);
  });

  it("an unchanged re-simulation signs and refreshes simulatedAt", async () => {
    const f = rig(succeed("-100"));
    await f.requests.init();
    const request = await f.requests.prepare(PARAMS);
    f.advance(RESIMULATE_AFTER_MS);
    await f.requests.approve(request.id, "send", VERIFY);
    expect(f.resimCalls).toHaveLength(1);
    expect(f.signed).toHaveLength(1);
    expect(f.requests.getState().requests[request.id]).toMatchObject({
      stage: "submitted",
      simulatedAt: START + RESIMULATE_AFTER_MS,
    });
  });

  it("a changed re-simulation throws, stays approvable with the fresh result, and the next approval signs", async () => {
    const f = rig(succeed("-100"));
    f.queue.push(succeed("-1000"));
    await f.requests.init();
    const request = await f.requests.prepare(PARAMS);
    f.advance(RESIMULATE_AFTER_MS);
    await expect(f.requests.approve(request.id, "send", VERIFY)).rejects.toBeInstanceOf(
      SimulationChangedError,
    );
    const pending = f.requests.getState().requests[request.id];
    expect(pending).toMatchObject({
      stage: "awaiting-approval",
      simulation: succeed("-1000"),
      simulatedAt: START + RESIMULATE_AFTER_MS,
      verification: "verified",
    });
    expect(pending?.risk).toContainEqual({ code: "simulation-mismatch", level: "danger" });
    expect(f.signed).toHaveLength(0);

    const tx = await f.requests.approve(request.id, "send", VERIFY);
    expect(f.resimCalls).toHaveLength(1);
    expect(f.signed).toHaveLength(1);
    expect(tx.state).toBe("submitted");
    expect(f.requests.getState().requests[request.id]?.stage).toBe("submitted");
  });

  it("a re-simulation that becomes unavailable is a change and makes the request unverifiable", async () => {
    const f = rig(succeed("-100"));
    f.queue.push({ status: "unavailable", error: "node down" });
    await f.requests.init();
    const request = await f.requests.prepare(PARAMS);
    f.advance(RESIMULATE_AFTER_MS);
    await expect(f.requests.approve(request.id, "send", VERIFY)).rejects.toBeInstanceOf(
      SimulationChangedError,
    );
    expect(f.requests.getState().requests[request.id]).toMatchObject({
      stage: "awaiting-approval",
      simulation: { status: "unavailable", error: "node down" },
      verification: "unverifiable",
      checks: ["simulation-unavailable"],
    });
    expect(f.signed).toHaveLength(0);
  });

  it("a lock during re-simulation invalidates the request and nothing signs", async () => {
    const f = rig(succeed("-100"));
    f.queue.push(succeed("-200"));
    await f.requests.init();
    const request = await f.requests.prepare(PARAMS);
    f.advance(RESIMULATE_AFTER_MS);
    f.duringResimulate(() => {
      f.requests.lock();
    });
    await expect(f.requests.approve(request.id, "send", VERIFY)).rejects.toThrow("invalidated");
    expect(f.requests.getState().requests[request.id]?.stage).toBe("invalidated");
    expect(f.signed).toHaveLength(0);
  });

  it("replacements never re-simulate", async () => {
    const f = rig(succeed("-100"));
    await f.requests.init();
    const request = await f.requests.prepare({ method: "speed-up", txId: "tx-old" });
    expect(request.simulation).toBeUndefined();
    f.advance(RESIMULATE_AFTER_MS);
    await f.requests.approve(request.id, "speed-up", VERIFY);
    expect(f.resimCalls).toHaveLength(0);
    expect(f.signed).toHaveLength(1);
  });
});

describe("solana-sign re-simulation", () => {
  const sign = (transactions: Uint8Array[]) => ({
    method: "solana-sign" as const,
    origin: ORIGIN,
    account: SOLANA_ACCOUNT,
    network: SOLANA_NETWORK,
    request: { kind: "transactions" as const, transactions, send: false },
  });

  it("a single transaction re-simulates at approval", async () => {
    const outcome: SimulationOutcome = {
      status: "success",
      changes: [{ asset: "lamports", amount: "-5000", verified: true }],
    };
    const f = solanaRig([outcome, outcome]);
    await f.requests.init();
    const message = new Uint8Array([1, 2, 3]);
    const request = await f.requests.prepare(sign([message]));
    f.advance(RESIMULATE_AFTER_MS);
    const result = await f.requests.approve(request.id, "solana-sign", VERIFY);
    expect(f.simulateCalls).toStrictEqual([message, message]);
    expect(f.signCalls).toHaveLength(1);
    expect(result).toMatchObject({ kind: "solana.transactions" });
  });

  it("a batch does not re-simulate", async () => {
    const f = solanaRig([]);
    await f.requests.init();
    const request = await f.requests.prepare(sign([new Uint8Array([1]), new Uint8Array([2])]));
    expect(request.simulation).toStrictEqual({ status: "unavailable", error: "batch" });
    f.advance(RESIMULATE_AFTER_MS);
    await f.requests.approve(request.id, "solana-sign", VERIFY);
    expect(f.simulateCalls).toHaveLength(0);
    expect(f.signCalls).toHaveLength(1);
  });
});
