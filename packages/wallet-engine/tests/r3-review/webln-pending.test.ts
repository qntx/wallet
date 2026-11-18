/**
 * PoC for r3-review: a Spark lightning payment whose commit response was lost ends the request
 * `submitted` with `{ kind: "pending", transferId }` (payments/action.ts `pendingOnUnknown` — the
 * payment may have been made under that transfer id). But connect/webln.ts `sendPayment`/`lnurl`
 * map any non-"lightning" outcome to ProviderError -32603 "the lightning payment settled
 * unexpectedly" — so the dApp sees a hard failure for a payment that may have gone through.
 * Correct behaviour: surface the pending state truthfully (e.g. keep polling / report
 * in-progress), never report failure for a payment that may have settled.
 * This test ASSERTS THE CURRENT (BUGGY) BEHAVIOUR.
 */
import { describe, expect, it } from "vite-plus/test";

import type { LightningSendStatus } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { unauthorized } from "../../src/connect/errors.ts";
import { WeblnHandler } from "../../src/connect/webln.ts";
import { encodeTestBolt11 } from "../support/bolt11.ts";

const SITE = "https://app.example.com";
const REF: SparkAccountRef = { walletId: "w", groupIndex: 0, network: "mainnet" };

const session = { id: "s1" } as never;

function rig(options: {
  authorized?: boolean;
  bound?: { walletId: string; groupIndex: number } | null;
  balancePolicy?: boolean;
  balance?: number;
  paymentStatus?: () => Promise<LightningSendStatus>;
  prepareResult?: unknown;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const sleeps: number[] = [];
  const requestsCalls: string[] = [];
  const preparedInputs: unknown[] = [];
  const handler = new WeblnHandler({
    connections: {
      checkOrigin: (origin) => ({ kind: "browser", origin }),
      authorize: () => {
        if (options.authorized === false) {
          throw unauthorized("test unauthorized");
        }
        return session;
      },
      session: () => session,
      sessionAccounts: () => {
        const bound =
          "bound" in options
            ? options.bound
            : { walletId: REF.walletId, groupIndex: REF.groupIndex };
        return bound === null || bound === undefined
          ? undefined
          : { group: bound, addresses: [`spark:${bound.walletId}:${String(bound.groupIndex)}`] };
      },
      lightningPolicy: () =>
        options.authorized === false ? undefined : { balance: options.balancePolicy === true },
      request: async () => {
        await Promise.resolve();
        throw new Error("connection request is not wired in this test");
      },
      touch: async () => Promise.resolve(),
    },
    requests: {
      prepare: async (input) => {
        await Promise.resolve();
        requestsCalls.push(input.method);
        preparedInputs.push(input);
        return { id: "req-1" } as never;
      },
      outcome: async () => Promise.resolve(options.prepareResult as never),
    },
    spark: {
      accountBalance: () => options.balance,
      paymentStatus: async () =>
        options.paymentStatus === undefined
          ? Promise.resolve({ outcome: "pending" } as LightningSendStatus)
          : options.paymentStatus(),
    },
    sparkNetwork: REF.network,
    now: options.now ?? (() => 0),
    alias: "qntx",
    lightningMaxFee: () => 10,
    sleep: async (ms) => {
      sleeps.push(ms);
      await Promise.resolve();
      if (options.sleep !== undefined) {
        await options.sleep(ms);
      }
    },
  });
  return { handler, sleeps, requestsCalls, preparedInputs };
}

const TIMESTAMP = 1_700_000_000;
const invoice = encodeTestBolt11({
  network: "mainnet",
  amountMsat: 100_000n,
  timestamp: TIMESTAMP,
  expirySeconds: 600,
  paymentHash: new Uint8Array(32).fill(9),
  secretKey: new Uint8Array(32).fill(1),
});

describe("PoC: a lost lightning commit answer is reported to the dApp as a failure", () => {
  it("PoC: a pending (unknown-outcome) payment rejects sendPayment with -32603", async () => {
    // The pay request settles `submitted` with kind "pending": the commit response was lost and
    // the payment may settle under this transfer id — it is NOT a failure.
    const { handler, requestsCalls } = rig({
      prepareResult: { kind: "pending", transferId: "0190f0f0-0000-7000-8000-000000000000" },
      now: () => (TIMESTAMP + 10) * 1000,
    });
    await expect(handler.handle(SITE, { method: "sendPayment", params: invoice })).rejects
      .toMatchObject({
        code: -32603,
        message: "the lightning payment settled unexpectedly",
      });
    expect(requestsCalls).toStrictEqual(["pay"]);
  });
});
