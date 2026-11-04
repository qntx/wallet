import { describe, expect, it } from "vite-plus/test";

import { AddressBookController } from "../src/addresses/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SimulationOutcome } from "../src/requests/simulation.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TransactionController } from "../src/transactions/controller.ts";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ACCOUNT = { walletId: "w", groupIndex: 0, address: "11111111111111111111111111111112" };
const ORIGIN = { kind: "browser", origin: "https://app.example" } as const;

function rig(simulate: (message: Uint8Array) => Promise<SimulationOutcome>) {
  const calls: Uint8Array[] = [];
  const openStore = async () => Promise.resolve(createMemoryEngineStore());
  const logger = { warn: () => undefined };
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    simulateSolana: async (_account, _network, message) => {
      calls.push(message);
      return simulate(message);
    },
    transactions: {} as unknown as TransactionController,
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    addressBook: new AddressBookController({
      openStore,
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger,
    }),
    openStore,
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(1),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  return { requests, calls };
}

const sign = (transactions: Uint8Array[], send = false) => ({
  method: "solana-sign" as const,
  origin: ORIGIN,
  account: ACCOUNT,
  network: NETWORK,
  request: { kind: "transactions" as const, transactions, send },
});

describe("solana-sign simulation", () => {
  it("simulates a single transaction and attaches the outcome", async () => {
    const outcome: SimulationOutcome = {
      status: "success",
      changes: [{ asset: "lamports", amount: "-5000", verified: true }],
    };
    const { requests, calls } = rig(async () => Promise.resolve(outcome));
    await requests.init();
    const message = new Uint8Array([1, 2, 3]);
    const request = await requests.prepare(sign([message]));
    expect(calls).toStrictEqual([message]);
    expect(request.simulation).toStrictEqual(outcome);
    expect(request.checks).toStrictEqual([]);
  });

  it("does not simulate a batch: unavailable with error batch", async () => {
    const { requests, calls } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    const request = await requests.prepare(sign([new Uint8Array([1]), new Uint8Array([2])]));
    expect(calls).toHaveLength(0);
    expect(request.simulation).toStrictEqual({ status: "unavailable", error: "batch" });
    expect(request.checks).toStrictEqual(["simulation-unavailable"]);
    expect(request.verification).toBe("unverifiable");
  });

  it("turns a thrown simulation into unavailable", async () => {
    const { requests } = rig(async () => Promise.reject(new Error("rpc down")));
    await requests.init();
    const request = await requests.prepare(sign([new Uint8Array([1])]));
    expect(request.simulation).toStrictEqual({ status: "unavailable", error: "rpc down" });
  });

  it("flags a revert as a danger", async () => {
    const { requests } = rig(async () =>
      Promise.resolve({ status: "reverted" as const, error: "boom" }),
    );
    await requests.init();
    const request = await requests.prepare(sign([new Uint8Array([1])]));
    expect(request.risk).toContainEqual({ code: "simulation-reverted", level: "danger" });
  });

  it("does not simulate a message signature", async () => {
    const { requests, calls } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    const request = await requests.prepare({
      method: "solana-sign",
      origin: ORIGIN,
      account: ACCOUNT,
      network: NETWORK,
      request: { kind: "message", message: new Uint8Array([1]) },
    });
    expect(calls).toHaveLength(0);
    expect(request.simulation).toBeUndefined();
  });
});
