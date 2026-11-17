/**
 * ED-PoC-12 — a 546-sat "frozen" UTXO is counted in a replacement's fee/change accounting and its
 * recorded inputs, but is NOT an input of the PSBT: the broadcast "speed-up" pays less than the
 * recorded fee — here, exactly the ORIGINAL fee — and locks the outpoint anyway.
 *
 * Exercises src/transactions/bitcoin.ts `prepareReplace` (≈640-690): in the extra-input loop
 * `extraUtxos.push(next)` (≈646) runs BEFORE `bitcoin.toInputs([...])` (≈659), and toInputs filters
 * 546/330-sat values (src/chains/bitcoin.ts:225 isFrozen, :241 the spendable filter). So the utxo
 * inflates `feeNeeded`/`changeValue`, lands in `record.inputs` (≈697) and gets locked on broadcast
 * — while `extraInputs` (the actual PSBT input list, ≈689) stays empty.
 *
 * Scenario: original send whose change can't absorb the BIP-125 floor (newFee = fee_A + vsize_A ≈
 * 710); the only spare utxo is 546 sats. The PSBT carries only A's input but the change math
 * credited 546 → the real fee is fee_A (600), not record.fee (710): a "speed-up" that every node
 * rejects as not-a-bump, with the 546 outpoint recorded + locked as spent.
 */
import { Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { flush, inputTxidsOf, send, world } from "./btc-fakes.ts";

const inputValueSum = (psbt: Uint8Array): bigint => {
  const tx = Transaction.fromPSBT(psbt);
  let sum = 0n;
  for (let i = 0; i < tx.inputsLength; i += 1) {
    const w = tx.getInput(i).witnessUtxo;
    if (w !== undefined) {
      sum += w.amount;
    }
  }
  return sum;
};

const outputValueSum = (psbt: Uint8Array): bigint => {
  const tx = Transaction.fromPSBT(psbt);
  let sum = 0n;
  for (let i = 0; i < tx.outputsLength; i += 1) {
    sum += tx.getOutput(i).amount ?? 0n;
  }
  return sum;
};

const psbtOf = (call: unknown): Uint8Array => {
  if (
    typeof call === "object" &&
    call !== null &&
    "request" in call &&
    typeof call.request === "object" &&
    call.request !== null &&
    "kind" in call.request &&
    call.request.kind === "bitcoin.psbt" &&
    "psbt" in call.request &&
    call.request.psbt instanceof Uint8Array
  ) {
    return call.request.psbt;
  }
  throw new Error("expected a bitcoin.psbt sign call");
};

const inputTxid = (tx: Transaction, i: number): string =>
  Buffer.from(tx.getInput(i).txid ?? new Uint8Array()).toString("hex");

describe("ED-PoC-12 RBF replacement counts a frozen 546-sat utxo it never spends", () => {
  it("ED-PoC-12: the 'speed-up' pays exactly the original fee but records fee_A + vsize_A and locks the phantom input", async () => {
    const w = world();
    const u50 = w.fund(1, 50_000);
    const u546 = w.fund(2, 546);
    const first = await w.boot();

    // A's change drops to dust (50_000 − 49_400 − fee < 546), so the BIP-125 floor forces an
    // extra input — and the only spare is the frozen 546-sat utxo.
    const txA = await send(first, 49_400n, "req-a");
    expect(txA.state).toBe("submitted");
    expect(txA.btc?.fee).toBe(600);

    const repB = await first.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b");
    const txB = await repB.submit({ kind: "password", password: "pw" });
    expect(txB.state).toBe("submitted");
    expect(txB.replaces).toBe(txA.id);

    // The RECORD claims the 546 outpoint is an input, and the target fee is fee_A + vsize_A.
    expect(inputTxidsOf(txB)).toContain(u50.txid);
    expect(inputTxidsOf(txB)).toContain(u546.txid);
    expect(txB.btc?.fee).toBe(710);

    // The PSBT actually spends only A's input — the 546 outpoint is nowhere in it.
    const psbt = psbtOf(w.signedCalls.at(-1));
    const psbtTx = Transaction.fromPSBT(psbt);
    expect(psbtTx.inputsLength).toBe(1);
    const inTxids = Array.from({ length: psbtTx.inputsLength }, (_, i) => inputTxid(psbtTx, i));
    expect(inTxids).toContain(u50.txid);
    expect(inTxids).not.toContain(u546.txid);

    // Real fee = inputs − outputs = 600 — exactly the ORIGINAL's fee, not the recorded 710.
    // A node enforcing BIP-125 rule 4 (replacement must pay more than the original) rejects it.
    const realFee = inputValueSum(psbt) - outputValueSum(psbt);
    expect(realFee).toBe(600n);
    expect(realFee).toBeLessThan(710n);

    // …and the phantom input is persisted as locked under the replacement's id.
    await flush();
    const saved = await w.persistedUtxos(first.backing);
    expect(saved[`${u546.txid}:0`]).toMatchObject({ status: "locked", txId: txB.id });
  });
});
