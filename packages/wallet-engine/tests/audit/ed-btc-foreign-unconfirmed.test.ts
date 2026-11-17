/**
 * ED-PoC-3 — foreign unconfirmed (mempool) coins are treated as spendable.
 *
 * Exercises src/transactions/bitcoin.ts prepare (≈205-215): every utxo returned by
 * src/chains/bitcoin-scan.ts `scanAddressUtxos` is mapped to `status: "confirmed"`, even when the
 * Esplora record says `status.confirmed === false` (height 0 / mempool). Design says only the
 * wallet's OWN unconfirmed change may be spent.
 *
 * Scenario: receive address 0 holds exactly one utxo — an unconfirmed deposit from a foreign txid —
 * and nothing else. `prepareSend` for an amount only that coin can cover must not build a spend;
 * today it happily selects the foreign mempool output.
 */
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import type { SignParams } from "../../src/transactions/route.ts";
import { inputTxidsOf, world } from "./btc-fakes.ts";

const inputTxids = (psbt: Uint8Array): ReadonlyArray<string> => {
  const tx = Transaction.fromPSBT(psbt);
  return Array.from({ length: tx.inputsLength }, (_, i) =>
    hex.encode(tx.getInput(i).txid ?? new Uint8Array()),
  );
};

/** Scure stores input txids internally; a txid may appear in either byte order. */
const sameTxid = (got: string, want: string): boolean =>
  got === want || got === hex.encode(Uint8Array.from(hex.decode(want)).toReversed());

const psbtOf = (calls: ReadonlyArray<SignParams>): Uint8Array => {
  const req = calls.at(-1)?.request;
  if (req?.kind !== "bitcoin.psbt") {
    throw new Error("expected a bitcoin.psbt sign request");
  }
  return req.psbt;
};

describe("ED-PoC-3 foreign unconfirmed utxo is spendable", () => {
  it("ED-PoC-3: a mempool utxo reported as confirmed:false is selected into the PSBT", async () => {
    const w = world();
    // The only coin: an unconfirmed foreign transaction paying our receive address.
    const foreign = w.fund(1, 50_000, false);
    const first = await w.boot();

    const tx = await w.send(first, 10_000n, "req-1");
    expect(tx.state).toBe("submitted");

    // The engine recorded the foreign unconfirmed outpoint as a selected input…
    expect(inputTxidsOf(tx)).toContain(foreign.txid);

    // …and it is in the PSBT that was handed to the signer.
    const txids = inputTxids(psbtOf(w.signedCalls));
    expect(txids.some((t) => sameTxid(t, foreign.txid))).toBe(true);
  });
});
