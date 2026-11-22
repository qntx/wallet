/**
 * Model test: an EVM or Bitcoin send whose broadcast outcome is unknown stays non-terminal under
 * any schedule of clock advances, polls, lock/unlock and restarts — the node never learning the
 * transaction. A `stuck` flag is allowed; `dropped`/`failed`/`replaced` are not. The nonce or the
 * inputs stay owned the whole time. Only chain proof ends the row: an EVM nonce consumed by another
 * transaction for three polls with no receipt anywhere, or a confirmed foreign spend of a Bitcoin
 * input.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { EsploraError } from "../src/chains/bitcoin.ts";
import { send } from "./send-helpers.ts";
import * as btc from "./support/btc-world.ts";
import { DEAD_HOST, evmWorld, EVM_SEND, HOST2 } from "./support/refused-worlds.ts";

const TERMINAL = new Set(["dropped", "failed", "replaced"]);
/** Seconds through two days — far past the 30-minute stuck mark and every resubmit backoff. */
const ADVANCE_MS = { min: 1000, max: 172_800_000 };

/** How the independent endpoint answers; the node itself never learns the transaction. */
type Endpoint = "unavailable" | "available" | "failing" | "knows";

type Step =
  | { readonly kind: "advance"; readonly ms: number }
  | { readonly kind: "poll"; readonly n: number }
  | { readonly kind: "lockUnlock" }
  | { readonly kind: "reboot" }
  | { readonly kind: "endpoint"; readonly mode: Endpoint };

const stepArb = fc.oneof(
  fc.record({ kind: fc.constant("advance" as const), ms: fc.integer(ADVANCE_MS) }),
  fc.record({ kind: fc.constant("poll" as const), n: fc.integer({ min: 1, max: 4 }) }),
  fc.constant({ kind: "lockUnlock" as const }),
  fc.constant({ kind: "reboot" as const }),
  fc.record({
    kind: fc.constant("endpoint" as const),
    mode: fc.constantFrom(
      "unavailable" as const,
      "available" as const,
      "failing" as const,
      "knows" as const,
    ),
  }),
);

const evmHosts = (mode: Endpoint): ReadonlyArray<string> => {
  switch (mode) {
    case "unavailable":
      return [];
    case "failing":
      return [DEAD_HOST];
    default:
      return [HOST2];
  }
};

const runEvm = async (initial: Endpoint, steps: ReadonlyArray<Step>): Promise<void> => {
  const w = evmWorld();
  w.node.drop = true;
  let mode = initial;
  // The endpoint's host list is fixed per engine boot, so a mode change reboots.
  let live = await w.boot({ gateway: true, hosts: evmHosts(mode) });
  const tx = await send(live.ctl, EVM_SEND);
  const hash = tx.hash ?? "";
  const applyMode = (): void => {
    w.host.fail = false;
    w.host.known.delete(hash);
    w.host.receipts.delete(hash);
    if (mode === "knows") {
      w.host.known.add(hash);
    }
  };
  applyMode();
  const liveState = (): string | undefined => live.ctl.getState().txs[tx.id]?.state;
  const stillTracked = (): void => {
    const state = liveState();
    expect(state === undefined || !TERMINAL.has(state)).toBe(true);
  };
  stillTracked();

  for (const step of steps) {
    switch (step.kind) {
      case "advance":
        w.clock.t += step.ms;
        break;
      case "poll":
        /* Stuck rows re-arm at the finality interval, not pollMs — firing every armed timer is
           the faithful "let the schedule run" regardless of which interval each row sits on. */
        for (let i = 0; i < step.n; i += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- each fired poll re-arms the next
          await live.timers.fire();
          // oxlint-disable-next-line eslint/no-await-in-loop -- each fired poll re-arms the next
          await btc.flush();
        }
        break;
      case "lockUnlock":
        live.ctl.lock();
        // oxlint-disable-next-line eslint/no-await-in-loop -- unlock must follow the lock
        await live.ctl.init();
        break;
      case "reboot":
        // oxlint-disable-next-line eslint/no-await-in-loop -- a restart waits on the open
        live = await w.boot({ gateway: true, hosts: evmHosts(mode) });
        applyMode();
        break;
      case "endpoint":
        ({ mode } = step);
        // oxlint-disable-next-line eslint/no-await-in-loop -- a restart waits on the open
        live = await w.boot({ gateway: true, hosts: evmHosts(mode) });
        applyMode();
        break;
    }
    stillTracked();
  }

  // The held nonce is never handed to a sibling send.
  const sibling = await send(live.ctl, {
    ...EVM_SEND,
    to: "0x00000000000000000000000000000000cafef00d",
  });
  expect(sibling.nonce).toBeGreaterThan(tx.nonce);
  stillTracked();

  /* Proof: the nonce was consumed by another transaction, and no receipt exists anywhere. A
     failing independent read deliberately defers the drop (it proves nothing), so the proof runs
     with the host endpoint reachable and receiptless — exactly the "three polls" the rule needs. */
  w.host.known.clear();
  w.host.receipts.clear();
  w.host.fail = false;
  live = await w.boot({ gateway: true, hosts: [HOST2] });
  w.node.latest = tx.nonce + 1;
  for (let i = 0; i < 3; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each fired poll re-arms the next
    await live.timers.fire();
    // oxlint-disable-next-line eslint/no-await-in-loop -- each fired poll re-arms the next
    await btc.flush();
    if (i < 2) {
      stillTracked();
    }
  }
  expect(liveState()).toBe("dropped");
  // The sibling's nonce was not consumed — it stays tracked.
  expect(TERMINAL.has(live.ctl.getState().txs[sibling.id]?.state ?? "")).toBe(false);
};

const runBtc = async (initial: Endpoint, steps: ReadonlyArray<Step>): Promise<void> => {
  let kind: "available" | "unavailable" = "available";
  const w = btc.world({ independent: () => kind });
  w.fund(1, 50_000);
  w.fund(2, 60_000);
  w.setPost({ kind: "throw", error: new EsploraError("500", true) });
  let live = await w.boot();
  const tx = await w.send(live, 10_000n, "req-1");
  const txid = btc.hashOf(tx);
  // The node never learns the transaction: its status read answers a definite 404.
  w.setStatus(txid, "404");
  const inputs = tx.btc?.inputs ?? [];
  expect(inputs.length).toBeGreaterThan(0);
  const applyMode = (m: Endpoint): void => {
    kind = m === "unavailable" ? "unavailable" : "available";
    if (m === "failing") {
      w.setIndependentStatus(txid, new EsploraError("503", true));
    } else if (m === "knows") {
      w.setIndependentStatus(txid, { confirmed: false });
    } else {
      w.setIndependentStatus(txid, "404");
    }
  };
  applyMode(initial);
  const stillTracked = (): void => {
    const state = btc.stateOf(live.ctl, tx);
    expect(state === undefined || !TERMINAL.has(state)).toBe(true);
  };
  stillTracked();

  for (const step of steps) {
    switch (step.kind) {
      case "advance":
        w.clock.t += step.ms;
        break;
      case "poll":
        for (let i = 0; i < step.n; i += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- each fired poll re-arms the next
          await live.timers.fire();
          // oxlint-disable-next-line eslint/no-await-in-loop -- each fired poll re-arms the next
          await btc.flush();
        }
        break;
      case "lockUnlock":
        live.ctl.lock();
        // oxlint-disable-next-line eslint/no-await-in-loop -- unlock must follow the lock
        await live.ctl.init();
        break;
      case "reboot":
        // oxlint-disable-next-line eslint/no-await-in-loop -- a restart waits on the open
        live = await w.boot(live.backing);
        break;
      case "endpoint":
        applyMode(step.mode);
        break;
    }
    stillTracked();
  }

  // The inputs stay locked to the unknown send; a sibling never selects them.
  await btc.flush();
  const locks = await btc.persistedUtxos(live.backing);
  for (const input of inputs) {
    expect(locks[`${input.txid}:${input.vout}`]).toMatchObject({ status: "locked", txId: tx.id });
  }
  const sibling = await w.send(live, 20_000n, "req-2");
  const siblingInputs = new Set(btc.inputTxidsOf(sibling));
  for (const input of inputs) {
    expect(siblingInputs.has(input.txid)).toBe(false);
  }
  stillTracked();

  // Proof: a confirmed foreign spend of a held input ends the row exactly now.
  const [input] = inputs;
  if (input === undefined) {
    throw new Error("the tracked send has no inputs");
  }
  w.spendBy(input.txid, input.vout, "ff".repeat(32), true);
  await live.timers.fire();
  await btc.flush();
  expect(btc.stateOf(live.ctl, tx)).toBe("replaced");
};

describe("no timer ends an unknown send", () => {
  it("an unknown EVM send stays non-terminal until nonce-consumed proof", async () => {
    expect.hasAssertions();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "unavailable" as const,
          "available" as const,
          "failing" as const,
          "knows" as const,
        ),
        fc.array(stepArb, { minLength: 4, maxLength: 24 }),
        async (initial, steps) => {
          await runEvm(initial, steps);
        },
      ),
      { numRuns: 40, seed: 11 },
    );
  }, 60_000);

  it("an unknown Bitcoin send stays non-terminal until a confirmed foreign spend", async () => {
    expect.hasAssertions();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "unavailable" as const,
          "available" as const,
          "failing" as const,
          "knows" as const,
        ),
        fc.array(stepArb, { minLength: 4, maxLength: 24 }),
        async (initial, steps) => {
          await runBtc(initial, steps);
        },
      ),
      { numRuns: 40, seed: 13 },
    );
  }, 240_000);
});
