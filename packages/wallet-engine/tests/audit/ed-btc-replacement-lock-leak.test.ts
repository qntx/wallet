/**
 * ED-PoC-2 — an extra input pulled in by a speed-up stays locked forever when the ORIGINAL
 * confirms.
 *
 * Exercises src/transactions/bitcoin.ts:
 *
 * - PrepareReplace "adds confirmed inputs when the change cannot absorb the bump" (≈640-680):
 *   replacement B spends A's inputs plus a spare utxo X.
 * - Replacement broadcast: `bitcoinUtxos.endTx(old.id,"dropped")` then `lock(record.inputs, B.id)`
 *   (≈528-535) — X is now held under B's id.
 * - Src/transactions/controller.ts sibling handling (≈574-597): when A confirms, B is moved to
 *   `replaced` — terminal, never polled again — but nothing calls `endTx(B.id, …)`.
 * - `pollAndRelease` (≈852-862) only releases the inputs of the tx id that itself confirmed.
 *
 * Result: X, which is still unspent on chain, stays `locked` in the persisted `btc-utxos`
 * collection under the dead replacement's id and can never be selected again — a permanent UTXO
 * leak.
 */
import { describe, expect, it } from "vite-plus/test";

import { flush, hashOf, inputTxidsOf, stateOf, tick, world } from "./btc-fakes.ts";

describe("ED-PoC-2 replacement extra-input lock leak", () => {
  it("ED-PoC-2: after the original confirms, the losing replacement's extra input stays locked under the dead txId and is never selectable again", async () => {
    const w = world();
    // A's change cannot absorb the fee bump, so prepareReplace must pull in the spare 30k utxo.
    const u50 = w.fund(1, 50_000);
    const u30 = w.fund(2, 30_000);
    const first = await w.boot();

    const txA = await w.send(first, 49_400n, "req-a");
    expect(txA.state).toBe("submitted");

    const repB = await first.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b");
    const txB = await repB.submit({ kind: "password", password: "pw" });
    expect(txB.state).toBe("submitted");
    expect(txB.replaces).toBe(txA.id);
    // B really is the +1-input replacement: A's outpoint plus the spare X.
    expect(inputTxidsOf(txB)).toContain(u50.txid);
    expect(inputTxidsOf(txB)).toContain(u30.txid);

    // On chain A wins: its spend of the 50k input confirms; B is dropped from the mempool,
    // so the 30k X it grabbed is unspent again.
    w.spend(u50.txid, 0);
    w.setStatus(hashOf(txA), { confirmed: true, block_height: 500 });
    await tick(first.timers, 0);

    expect(stateOf(first.ctl, txA)).toBe("confirmed");
    expect(stateOf(first.ctl, txB)).toBe("replaced");

    // The persisted btc-utxos state still holds X — status locked, owned by the dead B.
    await flush();
    const saved = await w.persistedUtxos(first.backing);
    expect(saved[`${u30.txid}:0`]).toMatchObject({ status: "locked", txId: txB.id });
    // (A's own input was re-locked under B too, but it is genuinely spent, so it does not matter.)

    // X is the only unspent coin left — yet a new send cannot use it.
    await expect(w.send(first, 10_000n, "req-c")).rejects.toThrow(/insufficient/i);

    // …and the leak survives a wallet restart: init reloads the persisted lock table.
    const second = await w.boot(first.backing);
    await expect(w.send(second, 10_000n, "req-d")).rejects.toThrow(/insufficient/i);
    const savedAfterRestart = await w.persistedUtxos(first.backing);
    expect(savedAfterRestart[`${u30.txid}:0`]).toMatchObject({ status: "locked", txId: txB.id });
  });
});
