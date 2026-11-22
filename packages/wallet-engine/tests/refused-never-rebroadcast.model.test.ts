/**
 * Cross-family model of the refusal rule: once the caller has seen a send refused, that exact raw
 * is never broadcast again — however the refusal lands (locked window, a bombed bookkeeping write)
 * and whatever happens next (same-controller unlock, a restart over the durable rows, or both). A
 * sibling send accepted in the same run must stay live and polled: refusing one transaction never
 * freezes the rest.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { BroadcastRefusedError } from "../src/transactions/broadcast.ts";
import { txRowPut } from "./send-helpers.ts";
import type { Booted, RefusedRig } from "./support/refused-worlds.ts";
import { POLL_MS, refusedRigs } from "./support/refused-worlds.ts";

/** Polls `cond` on the real clock — `vi.waitFor` never fires under this runner. */
const until = async <T>(probe: () => T | undefined, what: string): Promise<T> => {
  for (let i = 0; i < 500; i += 1) {
    const found = probe();
    if (found !== undefined) {
      return found;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- a fixed-interval probe stays sequential
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
};

const raised = (probe: () => boolean) => (): true | undefined => (probe() ? true : undefined);

const LIVE = new Set(["signed", "submitted", "pending"]);

/** A `bomb.fail` matcher that fails the next `n` failed-row writes, then lets them through. */
const failFailedWrites = (
  n: number,
): ((collection: string, key: string, bytes: Uint8Array) => boolean) => {
  let left = n;
  const match = txRowPut(['"state":"failed"']);
  return (collection, key, bytes) => {
    if (left === 0 || !match(collection, key, bytes)) {
      return false;
    }
    left -= 1;
    return true;
  };
};

type Scenario = {
  family: keyof typeof refusedRigs;
  lockedAtRefusal: boolean;
  failWrites: number;
  restart: "unlock" | "reboot" | "both";
  polls: number;
};

const scenario: fc.Arbitrary<Scenario> = fc.record({
  family: fc.constantFrom("evm", "bitcoin", "solana", "tron"),
  lockedAtRefusal: fc.boolean(),
  failWrites: fc.integer({ min: 0, max: 3 }),
  restart: fc.constantFrom("unlock", "reboot", "both"),
  polls: fc.integer({ min: 2, max: 5 }),
});

const runScenario = async (s: Scenario): Promise<void> => {
  const rig = refusedRigs[s.family]();
  const first = await rig.boot();
  if (s.failWrites > 0) {
    rig.bomb.fail = failFailedWrites(s.failWrites);
  }
  rig.refuse();
  const sendRefused = s.lockedAtRefusal ? gatedSend(rig, first) : rig.send(first);
  if (s.lockedAtRefusal) {
    await until(
      raised(() => rig.attemptCount() === 1),
      "the broadcast attempt",
    );
    first.ctl.lock();
    rig.releaseSendGate();
  }
  // The caller has now seen the refusal; from here on the invariant applies.
  await expect(sendRefused).rejects.toThrow(BroadcastRefusedError);
  const refusedRaw = rig.nodePosts.at(-1);
  expect(refusedRaw).toBeDefined();

  let live = first;
  if (s.restart !== "reboot") {
    first.ctl.lock();
    await first.ctl.init();
  }
  if (s.restart !== "unlock") {
    live = await rig.boot();
  }

  rig.accept();
  const sibling = await rig.sendSibling(live);
  const postsAtRefusal = rig.nodePosts.length;
  for (let i = 0; i < s.polls; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polls are sequential on purpose
    await live.timers.fire(POLL_MS);
  }

  const reposts = rig.nodePosts.filter((p) => p === refusedRaw).length;
  expect(reposts, `${s.family}: refused bytes broadcast ${String(reposts)} times in total`).toBe(1);
  const row = live.ctl.getState().txs[sibling.id];
  expect(row !== undefined && LIVE.has(row.state)).toBe(true);
  expect(live.timers.armed(POLL_MS)).toBeGreaterThanOrEqual(1);
  expect(postsAtRefusal).toBeGreaterThanOrEqual(1);
};

/** A send whose rejection never goes unhandled while it is held at the broadcast gate. */
const gatedSend = async (rig: RefusedRig, first: Booted): Promise<unknown> => {
  rig.armSendGate();
  const sent = rig.send(first);
  void sent.catch(() => undefined);
  return sent;
};

describe("refused bytes are never broadcast again", () => {
  // oxlint-disable-next-line vitest/expect-expect -- the assertions run inside runScenario
  it(
    "holds over lock timing, bombed writes and restarts, while a sibling stays tracked",
    { timeout: 120_000 },
    async () => {
      await fc.assert(fc.asyncProperty(scenario, runScenario), { numRuns: 40 });
    },
  );
});
