/**
 * Review PoC R14-03: the sealed change mark rises for every `origin: "internal"` request through
 * its signed change inputs (`requestChangeMark` in @qntx/wallet-chains/bitcoin `own.ts`, committed
 * by the kernel before the signature exists). The engine labels its own sends `internal`, but the
 * inputs it spends are whatever the single Esplora endpoint claims: `accountContext`
 * (src/transactions/bitcoin.ts) walks the change chain by the endpoint's `used` answers and takes
 * its UTXO list, with no second-endpoint check (only fee tiers are cross-checked). A hostile
 * gateway that answers "used" along the change chain and invents one coin at `/1/1979` therefore
 * gets a user-approved internal PSBT spending `/1/1979`; the kernel seals mark 1979 before signing
 * and the transaction never confirms (its prevout does not exist). From then on, for the life of
 * the wallet, every scan of that template walks the change chain to `changeScanReach(1979)` = 1999
 * — about 2000 upstream reads per refresh — against an honest endpoint too. R13-04 closed the
 * external route to the same ratchet; this is the internal one. Asserts today's behaviour.
 */
import { NETWORK, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import {
  bitcoinAddressFromXpub,
  changeScanReach,
  requestChangeMark,
} from "@qntx/wallet-chains/bitcoin";

import { scripthash } from "../../src/chains/bitcoin-scan.ts";
import type { SignParams } from "../../src/transactions/route.ts";
import { HD, NET, world } from "../support/btc-world.ts";

const XPUB = HD.publicExtendedKey;
const changeAddr = (i: number): string => bitcoinAddressFromXpub(XPUB, "btc.bip84", NET, 1, i);
const FAR = 1979;

/** The derivation paths of every input of the last signed `bitcoin.psbt` request. */
const lastPsbt = (calls: ReadonlyArray<SignParams>): { origin: string; paths: number[][] } => {
  const request = calls.at(-1)?.request;
  if (request?.kind !== "bitcoin.psbt") {
    throw new Error("expected a bitcoin.psbt sign call");
  }
  const psbt = Transaction.fromPSBT(request.psbt);
  const paths = Array.from({ length: psbt.inputsLength }, (_, i) =>
    (psbt.getInput(i).bip32Derivation ?? []).map(([, d]) => d.path),
  ).flat();
  return { origin: request.origin, paths };
};
const tailOf = (path: ReadonlyArray<number>) => ({
  purpose: 84,
  change: path[3] ?? -1,
  index: path[4] ?? -1,
});
const usedUpTo = (w: ReturnType<typeof world>, end: number): void => {
  for (let i = 0; i < end; i++) {
    w.markUsed(scripthash(changeAddr(i), NETWORK), "ab".repeat(32));
  }
};

describe("a hostile Esplora steers an internal send onto a far change index", () => {
  it("the engine signs an internal PSBT spending the invented /1/1979 coin", async () => {
    const w = world();
    // The endpoint claims every change address up to the coin was used — the gap walk follows.
    usedUpTo(w, FAR);
    w.fundChange(FAR, 9, 200_000);
    const booted = await w.boot();
    await w.send(booted, 10_000n, "req-far");

    const { origin, paths } = lastPsbt(w.signedCalls);
    expect(origin).toBe("internal");
    expect(paths.map(tailOf)).toContainEqual({ purpose: 84, change: 1, index: FAR });

    // What the kernel then seals: an internal request's change input is the new mark.
    expect(requestChangeMark(0, 84, paths.map(tailOf), "internal")).toBe(FAR);
    expect(changeScanReach(FAR)).toBe(1999);
  }, 120_000);

  it("after the mark is sealed, an honest endpoint is walked to index 1999 on every send", async () => {
    const honest = world({ changeMark: FAR });
    honest.fund(1, 50_000);
    const booted = await honest.boot();
    const before = honest.requests.length;
    await booted.ctl.prepareSend(
      {
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "btc.bip84" },
        network: NET,
        to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        amount: 10_000n,
        fee: "slow",
      },
      "req-after",
    );
    const changeReads = honest.requests
      .slice(before)
      .filter((url) => /^\/scripthash\/[0-9a-f]{64}\/(txs|utxo)$/.test(url));
    // ≥ 2000 change addresses (txs) plus their utxo reads, on a wallet with one coin.
    expect(changeReads.length).toBeGreaterThanOrEqual(2000);
  }, 120_000);
});
