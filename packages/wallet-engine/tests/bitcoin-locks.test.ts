/**
 * Every terminal transition — including a replacement flipped to `replaced` when a sibling confirms
 * — frees the outputs that transaction locked. A losing speed-up's extra input must be spendable
 * again, before and after a restart. Polls run on `manualTimers`.
 */
import { describe, expect, it } from "vite-plus/test";

import { flush, hashOf, inputTxidsOf, stateOf, VERIFY, world } from "./support/btc-world.ts";

describe("bitcoin input locks on terminal states", () => {
  it("a losing replacement's extra input is freed when the original confirms", async () => {
    const w = world();
    // A's change cannot absorb the fee bump, so the speed-up must pull in the spare 30k utxo.
    const u50 = w.fund(1, 50_000);
    const u30 = w.fund(2, 30_000);
    const first = await w.boot();

    const txA = await w.send(first, 49_400n, "req-a");
    expect(txA.state).toBe("submitted");

    const repB = await first.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b");
    const txB = await repB.submit(VERIFY, () => undefined);
    expect(txB.state).toBe("submitted");
    expect(txB.replaces).toBe(txA.id);
    // B really is the +1-input replacement: A's outpoint plus the spare X.
    expect(inputTxidsOf(txB)).toContain(u50.txid);
    expect(inputTxidsOf(txB)).toContain(u30.txid);

    // On chain A wins: its spend confirms; B is out of the mempool and X is unspent again.
    w.spend(u50.txid, 0);
    w.setTip(600);
    w.setStatus(hashOf(txA), { confirmed: true, block_height: 500, block_hash: "bb".repeat(32) });
    await first.polls(1);

    expect(stateOf(first.ctl, txA)).toBe("confirmed");
    expect(stateOf(first.ctl, txB)).toBe("replaced");

    // The persisted lock table freed X — the dead replacement owns nothing.
    await flush();
    const saved = await w.persistedUtxos(first.backing);
    expect(saved[`${u30.txid}:0`]).not.toMatchObject({ status: "locked" });

    // A send funded only by X succeeds — it is selectable again.
    const txC = await w.send(first, 10_000n, "req-c");
    expect(txC.state).toBe("submitted");
    await flush();
    const afterSend = await w.persistedUtxos(first.backing);
    expect(afterSend[`${u30.txid}:0`]).toMatchObject({ status: "locked", txId: txC.id });

    // The same after a restart: the live owner of X survives the reload, not the dead one.
    const second = await w.boot(first.backing);
    await flush();
    const savedAfterRestart = await w.persistedUtxos(first.backing);
    expect(savedAfterRestart[`${u30.txid}:0`]).toMatchObject({
      status: "locked",
      txId: txC.id,
    });
    expect(second.ctl.getState().txs[txC.id]?.state).toBe("submitted");
  });
});
