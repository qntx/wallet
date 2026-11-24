/**
 * The change-index rule: a send's change goes on the spending template's own change chain at the
 * first unused index when it lies inside the bound the selected inputs prove — the highest
 * same-purpose change index among them plus the gap limit — and at the bound itself otherwise, a
 * deliberate reuse that keeps the output inside the window the wallet scans. The chosen index
 * always satisfies `isDiscoverableChange`, so the kernel hides the same output the engine does.
 */
import { NETWORK, Transaction } from "@scure/btc-signer";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  BITCOIN_GAP_LIMIT,
  bitcoinAddressFromXpub,
  isDiscoverableChange,
} from "@qntx/wallet-chains/bitcoin";
import type { BitcoinPathTail } from "@qntx/wallet-chains/bitcoin";

import { scripthash } from "../src/chains/bitcoin-scan.ts";
import type { ScanAddress } from "../src/chains/bitcoin-scan.ts";
import { changeAddressOf } from "../src/transactions/bitcoin.ts";
import type { SignParams } from "../src/transactions/route.ts";
import { HD, NET, world } from "./support/btc-world.ts";

const PURPOSE = 84;

const chainOf = (used: ReadonlyArray<boolean>): ScanAddress[] =>
  used.map((u, index) => ({
    chain: 1,
    index,
    address: `m/84'/0'/0'/1/${String(index)}`,
    used: u,
  }));

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

describe("changeAddressOf", () => {
  it("always lands inside the bound the selected inputs prove", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 80, maxLength: 80 }),
        fc.array(
          fc.record({
            purpose: fc.constant(PURPOSE),
            change: fc.constantFrom(0, 1),
            index: fc.nat(49),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (used, tails) => {
          const chosen = changeAddressOf(chainOf(used), tails);
          expect(
            isDiscoverableChange({ purpose: PURPOSE, change: 1, index: chosen.index }, tails),
          ).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("takes the first unused index inside the bound and the bound past it", () => {
    const allUnused = chainOf(Array.from({ length: 60 }, () => false));
    const noChangeInput: BitcoinPathTail[] = [{ purpose: PURPOSE, change: 0, index: 0 }];
    expect(changeAddressOf(allUnused, noChangeInput).index).toBe(0);
    const spentTo25 = chainOf(Array.from({ length: 60 }, (_, i) => i < BITCOIN_GAP_LIMIT + 5));
    // 0..24 used: the first unused index 25 lies past the bound 20, so the build reuses 20.
    expect(changeAddressOf(spentTo25, noChangeInput).index).toBe(BITCOIN_GAP_LIMIT);
    // A proven change input at index 30 raises the bound to 50 — 25 is free and inside it.
    const changeInput: BitcoinPathTail[] = [{ purpose: PURPOSE, change: 1, index: 30 }];
    expect(changeAddressOf(spentTo25, changeInput).index).toBe(BITCOIN_GAP_LIMIT + 5);
    const spentTo55 = chainOf(Array.from({ length: 80 }, (_, i) => i < BITCOIN_GAP_LIMIT + 35));
    // Now 25 is used too: first unused 55 > bound 50 — reuse lands at 50.
    expect(changeAddressOf(spentTo55, changeInput).index).toBe(50);
    // A receive-chain input's index never raises the bound: index 30 stays receive-only, so the
    // bound is the bare gap limit and 25 remains past it — reuse at 20, not the free 25.
    const receiveInput: BitcoinPathTail[] = [{ purpose: PURPOSE, change: 0, index: 30 }];
    expect(changeAddressOf(spentTo25, receiveInput).index).toBe(BITCOIN_GAP_LIMIT);
  });
});

describe("a send whose first unused change index lies past the scan's reach", () => {
  it("binds the bounded index and shows no unusual row", async () => {
    const w = world();
    w.fund(1, 50_000);
    // The change chain's first 25 addresses carry history — the first unused index is 25,
    // past the bound 20 the receive-only inputs prove.
    for (let i = 0; i < BITCOIN_GAP_LIMIT + 5; i += 1) {
      const addr = bitcoinAddressFromXpub(HD.publicExtendedKey, "btc.bip84", NET, 1, i);
      w.markUsed(scripthash(addr, NETWORK), `used-${String(i)}`);
    }
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");

    const psbt = Transaction.fromPSBT(psbtOf(w.signedCalls));
    const tail = changeTailOf(psbt);
    expect(tail.index).toBe(BITCOIN_GAP_LIMIT);
    // The kernel's own classification hides the same output: the tail is discoverable against
    // the signed inputs' tails — receive-chain only, so the bound is the bare gap limit.
    expect(isDiscoverableChange(tail, [{ purpose: PURPOSE, change: 0, index: 0 }])).toBe(true);
    // The tracked intent hides it too: no own-path row and no unusual-own-output warning.
    const { intent } = tx;
    expect(intent?.outflows.every((o) => o.ownPath === undefined)).toBe(true);
    expect(intent?.warnings.every((w) => w.kind !== "unusual-own-output")).toBe(true);
  });
});
