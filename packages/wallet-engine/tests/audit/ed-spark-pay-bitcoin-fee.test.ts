/**
 * ED-PoC-9 — paying a parsed `bitcoin` option through the generic `pay` pipeline applies the SSP
 * cooperative-exit quote with NO caller-bound maximum: the payee receives `amountSats - quoteFee`,
 * however large the quote is.
 *
 * Exercises src/payments/pay.ts `preparePay` default branch (≈232-261): display is built with
 * `maxFeeSats` omitted when the caller didn't supply one and `checks` stays `[]` (feeCheck only
 * fires when a bound EXISTS and exceeds the amount, src/payments/action.ts:49).
 * src/spark/controller.ts `withdraw` (≈693-748): `params.maxFeeSats === undefined` skips the bound
 * check entirely — only `fee >= exitAmount` is rejected — then approves the intent `{kind:"exit",
 * amountSats: exitAmount - fee, maxFeeSats: fee}` and exits. The requests pipeline `pay` passes
 * PayParams straight through (src/requests/controller.ts ≈963-971); the `spark-exit` method
 * requires maxFeeSats but `pay` does not.
 *
 * Demonstrated: a 100_000-sat bitcoin payment whose SSP quote returns a 99_000-sat fee is approved
 * and executed — payout 1_000 sats — without any fee bound ever being enforced.
 */
import { describe, expect, it } from "vite-plus/test";

import type { SparkClient } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import type { EngineLogger } from "../../src/events.ts";
import { preparePay } from "../../src/payments/pay.ts";
import { SparkController } from "../../src/spark/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { realTimer } from "../send-helpers.ts";

const REF: SparkAccountRef = { walletId: "w1", groupIndex: 0, network: "regtest" };
const VERIFY = { kind: "password", password: new Uint8Array([1]) } as never;
const LOGGER: EngineLogger = { warn: () => {} };
const ADDRESS = "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz";

const PK = new Uint8Array(33).fill(2);

const rig = () => {
  const approvals: unknown[] = [];
  const exitArgs: unknown[] = [];
  const quoteArgs: unknown[] = [];
  const client = {
    identityPublicKey: async () => Promise.resolve(PK),
    balance: async () => Promise.resolve(1_000_000),
    transfers: {
      claimPending: async () => Promise.resolve({ leaves: [], failures: [] }),
      claim: async () => Promise.resolve([]),
      history: async () => Promise.resolve({ payments: [], nextOffset: undefined }),
      send: async (o: unknown) => Promise.resolve(o),
    },
    lightning: {
      createInvoice: async (o: unknown) => Promise.resolve(o),
      pay: async (o: unknown) => Promise.resolve(o),
      sendStatus: async (o: unknown) => Promise.resolve(o),
    },
    withdrawals: {
      quoteCooperativeExit: async (o: unknown) => {
        quoteArgs.push(o);
        return Promise.resolve({ fees: { fast: 99_000, medium: 99_000, slow: 99_000 } });
      },
      cooperativeExit: async (o: unknown) => {
        exitArgs.push(o);
        return Promise.resolve({ id: "exit-1" });
      },
    },
    async *events() {
      await Promise.resolve();
      yield* [];
    },
    close: () => undefined,
  };
  const spark = new SparkController({
    setTimer: realTimer,
    spark: {
      signer: () => null as never,
      approve: async (p: unknown) => {
        approvals.push(p);
        return Promise.resolve({});
      },
    },
    fetch: async () => Promise.reject(new Error("offline")),
    random: (n) => new Uint8Array(n).fill(1),
    now: () => 0,
    logger: LOGGER,
    createClient: () => client as unknown as SparkClient,
  });
  return { spark, approvals, exitArgs, quoteArgs };
};

describe("ED-PoC-9 spark pay of a bitcoin option applies an unbounded SSP fee", () => {
  it("ED-PoC-9: 99% quote fee on a 100k-sat payment is approved and executed — payout 1k sats", async () => {
    const { spark, approvals, exitArgs, quoteArgs } = rig();
    spark.setAccounts([REF]);
    spark.setStore(createMemoryEngineStore());
    await spark.init();

    const action = await preparePay(
      { fetch: async () => Promise.reject(new Error("offline")), now: () => 0 },
      { account: REF, option: { kind: "bitcoin", address: ADDRESS }, amountSats: 100_000 },
    );

    // The approval display carries NO fee bound — and no check fires either.
    expect(action.display).toStrictEqual({
      family: "spark",
      network: "regtest",
      kind: "exit",
      amountSats: 100_000,
      receiver: ADDRESS,
    });
    expect(action.display.maxFeeSats).toBeUndefined();
    expect(action.checks).toStrictEqual([]);

    // Execute: the 99_000-sat quote sails through — only `fee >= amount` would have stopped it.
    const result = await action.execute(spark, VERIFY);
    expect(result.kind).toBe("withdraw");

    expect(quoteArgs[0]).toStrictEqual({ address: ADDRESS, amountSats: 100_000 });
    expect(exitArgs[0]).toMatchObject({
      address: ADDRESS,
      speed: "MEDIUM",
      maxFeeSats: 99_000,
      amountSats: 100_000,
    });
    // The intent approved to the user/kernel is a 1_000-sat payout with a 99_000-sat fee.
    expect(approvals[0]).toMatchObject({
      account: REF,
      intent: { kind: "exit", address: ADDRESS, amountSats: 1000, maxFeeSats: 99_000 },
    });

    await spark.destroy();
  });
});
