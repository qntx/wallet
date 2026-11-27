/**
 * Review PoC R15-01 (engine half): the sealed change mark ratchets one gap limit per internal send.
 * `changeAddressOf` binds the change output at `min(mark + GAP, SCAN_LIMIT - 1)` whenever the first
 * unused index lies past the bound — and the kernel seals the hidden change index into the mark
 * (`target = max(markAfterInputs, hidden)`), so every ordinary send raises the sealed mark by
 * exactly BITCOIN_GAP_LIMIT with no far change input and no second-endpoint read. Repeats climb the
 * mark from 0 toward the scan limit, widening the window the kernel hides as "your own change" —
 * the same ladder a hostile primary rides when it claims used indexes.
 *
 * Each test asserts today's behaviour — it passes now and fails once the seal no longer ratchets on
 * a bounded reuse.
 */
import { NETWORK, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import {
  BITCOIN_SCAN_LIMIT,
  bitcoinAddressFromXpub,
  isDiscoverableChange,
} from "@qntx/wallet-chains/bitcoin";
import type { BitcoinPathTail } from "@qntx/wallet-chains/bitcoin";

import { scripthash } from "../../src/chains/bitcoin-scan.ts";
import type { SignParams } from "../../src/transactions/route.ts";
import { HD, NET, world } from "../support/btc-world.ts";

const PURPOSE = 84;

/** The hostile primary claims every change address before `end` was used — the gap walk follows. */
const usedUpTo = (w: ReturnType<typeof world>, end: number): void => {
  for (let i = 0; i < end; i += 1) {
    const addr = bitcoinAddressFromXpub(HD.publicExtendedKey, "btc.bip84", NET, 1, i);
    w.markUsed(scripthash(addr, NETWORK), "ab".repeat(32));
  }
};

const psbtOf = (calls: ReadonlyArray<SignParams>): Uint8Array => {
  const request = calls.at(-1)?.request;
  if (request?.kind !== "bitcoin.psbt") {
    throw new Error("expected a bitcoin.psbt sign call");
  }
  return request.psbt;
};

const changeTailOf = (psbt: Transaction): BitcoinPathTail => {
  const bound = Array.from({ length: psbt.outputsLength }, (_, i) => psbt.getOutput(i)).flatMap(
    (o) => o.bip32Derivation ?? [],
  );
  const found = bound.map(([, v]) => v.path).find((p) => p.length === 5 && p[3] === 1);
  if (found === undefined || found[4] === undefined) {
    throw new Error("no bound change derivation on the PSBT");
  }
  return { purpose: PURPOSE, change: 1, index: found[4] };
};

describe("R15-01: a bounded reuse seals mark + GAP — the ladder step", () => {
  it.each([
    // [sealed mark, claimed-used end]: the primary reports a used run then leaves an honest gap
    // window, so the scan completes with the first unused index past the old reach.
    [0, 60],
    [1940, 1980],
  ])(
    "mark %d: the change lands at min(mark + 20, 1999), discoverable, never cross-checked",
    async (mark, used) => {
      const w = world({ independent: true, changeMark: mark });
      // The primary reports the whole window used — the build must reuse the bound index.
      usedUpTo(w, used);
      w.fund(1, 50_000);
      const booted = await w.boot();
      const tx = await w.send(booted, 10_000n, "req");

      const psbt = Transaction.fromPSBT(psbtOf(w.signedCalls));
      const tail = changeTailOf(psbt);
      expect(tx.state).not.toBe("failed");
      // The reuse lands exactly at the old reach — the index the kernel is about to seal.
      expect(tail).toStrictEqual({
        purpose: PURPOSE,
        change: 1,
        index: Math.min(mark + 20, BITCOIN_SCAN_LIMIT - 1),
      });
      // No selected input sits past the reach, so the second endpoint is never asked.
      expect(w.independentRequests.filter((u) => u.endsWith("/hex"))).toStrictEqual([]);
      // The kernel's own rule hides this output as change against the receive-only inputs —
      // and its index is what the mark raise seals, one gap limit per internal send.
      expect(isDiscoverableChange(tail, [{ purpose: PURPOSE, change: 0, index: 0 }], mark)).toBe(
        true,
      );
    },
    120_000,
  );

  it("mark 1979: the ladder's last step — the bound is unreachable; a full claim wedges the send", async () => {
    // At mark 1979 the bound is min(1999, 1999) = 1999, but `changeAddressOf` prefers the first
    // unused index whenever the scan completes — a used claim covering the last window leaves no
    // unused index at all, and the scan itself hits BITCOIN_SCAN_LIMIT and throws. The PoC
    // prediction (change bound at 1999) does not reproduce: either the send fails outright or the
    // first unused index wins. Both are asserted here as today's behaviour.
    const wedged = world({ independent: true, changeMark: 1979 });
    usedUpTo(wedged, BITCOIN_SCAN_LIMIT);
    wedged.fund(1, 50_000);
    const booted = await wedged.boot();
    await expect(wedged.send(booted, 10_000n, "req")).rejects.toThrow(
      "bitcoin address scan exceeded 2000",
    );

    // With an honest gap window instead, the change binds the first unused index — still inside
    // the kernel's reach (1980 <= 1979 + 20), still hidden, still sealed as the +1 ratchet.
    const w = world({ independent: true, changeMark: 1979 });
    usedUpTo(w, 1980);
    w.fund(1, 50_000);
    const done = await w.boot();
    const tx = await w.send(done, 10_000n, "req");
    const psbt = Transaction.fromPSBT(psbtOf(w.signedCalls));
    const tail = changeTailOf(psbt);
    expect(tx.state).not.toBe("failed");
    expect(tail).toStrictEqual({ purpose: PURPOSE, change: 1, index: 1980 });
    expect(isDiscoverableChange(tail, [{ purpose: PURPOSE, change: 0, index: 0 }], 1979)).toBe(
      true,
    );
  }, 120_000);
});
