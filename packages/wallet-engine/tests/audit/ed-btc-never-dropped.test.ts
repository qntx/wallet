/**
 * ED-PoC-4 — a bitcoin send that was evicted from the mempool is tracked forever, its inputs stay
 * locked, and after a restart there is no in-wallet way to unstick them.
 *
 * Exercises src/transactions/bitcoin.ts:
 *
 * - `poll` (≈113-125) only maps a confirmed /status to `confirmed`; an Esplora 404 (tx evicted/never
 *   seen) is just a failed fetch — it never yields `dropped`/`failed` and the outspends of the
 *   inputs are never consulted.
 * - `prepareReplace` (≈566-569) needs the in-memory `pending` build-context stash, which is lost on
 *   restart: "the original build context is gone — cannot replace after restart".
 *
 * Scenario: broadcast a send, then make Esplora answer 404 for its /status (evicted). Poll for days
 * — the tx stays `submitted`, the funding input stays locked, and after a restart speed-up / cancel
 * / CPFP all refuse to run.
 */
import { describe, expect, it } from "vite-plus/test";

import { flush, hashOf, stateOf, tick, ticks, world } from "./btc-fakes.ts";

describe("ED-PoC-4 evicted bitcoin tx is never dropped", () => {
  it("ED-PoC-4: a 404-evicted send stays submitted for days, keeps its inputs locked, and after restart cannot be replaced/cancelled/CPFP'd", async () => {
    const w = world();
    const u50 = w.fund(1, 50_000);
    const first = await w.boot();

    const txA = await w.send(first, 10_000n, "req-a");
    expect(txA.state).toBe("submitted");

    // The node accepts the broadcast, then the tx is evicted: /status now answers 404 and the
    // input is unspent again — but no poll path ever notices.
    w.setStatus(hashOf(txA), "404");
    w.clock.t += 30 * 24 * 60 * 60 * 1000; // a month of polling still cannot see the eviction
    await ticks(first.timers, 30);
    expect(stateOf(first.ctl, txA)).toBe("submitted");

    // The funding input is still locked: the only unspent coin cannot be re-selected.
    await expect(w.send(first, 10_000n, "req-b")).rejects.toThrow(/insufficient/i);
    await flush();
    const saved = await w.persistedUtxos(first.backing);
    expect(saved[`${u50.txid}:0`]).toMatchObject({ status: "locked", txId: txA.id });

    // Restart: the tx reloads and is tracked again — but the build context is gone.
    const second = await w.boot(first.backing);
    const reloaded = second.ctl.getState().txs[txA.id];
    expect(reloaded?.state).toBe("submitted");
    await tick(second.timers, 0); // still polls, still cannot see the eviction
    expect(second.ctl.getState().txs[txA.id]?.state).toBe("submitted");

    await expect(
      second.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-fast"),
    ).rejects.toThrow("the original build context is gone — cannot replace after restart");
    await expect(
      second.ctl.prepareReplacement({ method: "cancel", txId: txA.id }, "req-cancel"),
    ).rejects.toThrow("the original build context is gone — cannot replace after restart");
    await expect(
      second.ctl.prepareReplacement({ method: "cpfp", txId: txA.id, feeRate: 10 }, "req-cpfp"),
    ).rejects.toThrow(/build context is gone/);

    // And the locked coin still cannot fund anything after the restart.
    await expect(w.send(second, 10_000n, "req-c")).rejects.toThrow(/insufficient/i);
  });
});
