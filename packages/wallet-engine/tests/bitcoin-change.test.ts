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
  BITCOIN_SCAN_LIMIT,
  bitcoinAddressFromXpub,
  isDiscoverableChange,
  requestChangeMark,
} from "@qntx/wallet-chains/bitcoin";
import type { BitcoinPathTail } from "@qntx/wallet-chains/bitcoin";

import { scripthash } from "../src/chains/bitcoin-scan.ts";
import type { ScanAddress } from "../src/chains/bitcoin-scan.ts";
import { changeAddressOf } from "../src/transactions/bitcoin.ts";
import type { SignParams } from "../src/transactions/route.ts";
import { ACCOUNT, CHANGE_ADDR, HD, NET, RECIP, world } from "./support/btc-world.ts";

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
          const chosen = changeAddressOf(chainOf(used), tails, 0);
          expect(
            isDiscoverableChange(
              { purpose: PURPOSE, change: 1, index: chosen.index },
              tails,
              requestChangeMark(0, PURPOSE, tails, "internal"),
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("takes the first unused index inside the bound and the bound past it", () => {
    const allUnused = chainOf(Array.from({ length: 60 }, () => false));
    const noChangeInput: BitcoinPathTail[] = [{ purpose: PURPOSE, change: 0, index: 0 }];
    expect(changeAddressOf(allUnused, noChangeInput, 0).index).toBe(0);
    const spentTo25 = chainOf(Array.from({ length: 60 }, (_, i) => i < BITCOIN_GAP_LIMIT + 5));
    // 0..24 used: the first unused index 25 lies past the bound 20, so the build reuses 20.
    expect(changeAddressOf(spentTo25, noChangeInput, 0).index).toBe(BITCOIN_GAP_LIMIT);
    // A proven change input at index 30 raises the bound to 50 — 25 is free and inside it.
    const changeInput: BitcoinPathTail[] = [{ purpose: PURPOSE, change: 1, index: 30 }];
    expect(changeAddressOf(spentTo25, changeInput, 0).index).toBe(BITCOIN_GAP_LIMIT + 5);
    const spentTo55 = chainOf(Array.from({ length: 80 }, (_, i) => i < BITCOIN_GAP_LIMIT + 35));
    // Now 25 is used too: first unused 55 > bound 50 — reuse lands at 50.
    expect(changeAddressOf(spentTo55, changeInput, 0).index).toBe(50);
    // The exact boundary: 0..20 used leaves the first unused index at bound + 1 — still reuse.
    const spentTo21 = chainOf(Array.from({ length: 60 }, (_, i) => i <= BITCOIN_GAP_LIMIT));
    expect(changeAddressOf(spentTo21, noChangeInput, 0).index).toBe(BITCOIN_GAP_LIMIT);
    // A receive-chain input's index never raises the bound: index 30 stays receive-only, so the
    // bound is the bare gap limit and 25 remains past it — reuse at 20, not the free 25.
    const receiveInput: BitcoinPathTail[] = [{ purpose: PURPOSE, change: 0, index: 30 }];
    expect(changeAddressOf(spentTo25, receiveInput, 0).index).toBe(BITCOIN_GAP_LIMIT);
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
    expect(isDiscoverableChange(tail, [{ purpose: PURPOSE, change: 0, index: 0 }], 0)).toBe(true);
    // The tracked intent hides it too: no own-path row and no unusual-own-output warning.
    const { intent } = tx;
    expect(intent?.outflows.every((o) => o.ownPath === undefined)).toBe(true);
    expect(intent?.warnings.every((w) => w.kind !== "unusual-own-output")).toBe(true);
  });

  it("reaches an own change coin past the bare gap window when the mark proves it", async () => {
    /* Mark 100: the wallet's own change may sit anywhere under index 120 — a spend must scan
       to that reach, not to the default gap window a mark-0 account would need. */
    const w = world({ changeMark: 100 });
    const deep = w.fundChange(118, 7, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).not.toBe("failed");
    // The signed PSBT spends the deep change coin — and carries its change-1 derivation.
    const psbt = Transaction.fromPSBT(psbtOf(w.signedCalls));
    const inputTxid = Array.from({ length: psbt.inputsLength }, (_, i) =>
      Buffer.from(psbt.getInput(i).txid as Uint8Array).toString("hex"),
    );
    expect(inputTxid).toContain(deep.txid);
    const tail = changeTailOf(psbt);
    expect(tail.change).toBe(1);
    expect(tail.index).toBeLessThanOrEqual(138);
  });
});

describe("a send whose serving entry was never confirmed on the device", () => {
  it("shows the change as a foreign send with the danger warning and acknowledges on sign", async () => {
    const w = world({ confirmed: false });
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");

    // The sign call carries the acknowledgement the kernel demands for unconfirmed-served keys.
    expect(w.signedCalls.at(-1)?.acknowledgeUnconfirmed).toBe(true);
    // The change decoded as a plain send — never hidden, never an own path — plus the danger
    // warning the kernel prompt shows too.
    const { intent } = tx;
    expect(intent?.warnings.some((w) => w.kind === "unconfirmed-signer-output")).toBe(true);
    expect(intent?.outflows.every((o) => o.ownPath === undefined)).toBe(true);
    expect(intent?.outflows.some((o) => o.to === CHANGE_ADDR)).toBe(true);
    expect(intent?.warnings.every((w) => w.kind !== "unusual-own-output")).toBe(true);
  });
});

describe("a change coin past the sealed-mark reach", () => {
  const FAR = 1979;

  /** The hostile primary claims every change address before `end` was used — the gap walk follows. */
  const usedUpTo = (w: ReturnType<typeof world>, end: number): void => {
    for (let i = 0; i < end; i += 1) {
      const addr = bitcoinAddressFromXpub(HD.publicExtendedKey, "btc.bip84", NET, 1, i);
      w.markUsed(scripthash(addr, NETWORK), "ab".repeat(32));
    }
  };

  /** The world's raw bytes for `txid` — every funding transaction keeps them. */
  const fundingHex = (w: ReturnType<typeof world>, txid: string): string => {
    const raw = w.rawHexOf(txid);
    if (raw === undefined) {
      throw new Error(`world has no raw bytes for ${txid}`);
    }
    return raw;
  };

  /** The txs/utxo reads `requests` made against `hashes`'s addresses. */
  const scripthashReads = (
    requests: ReadonlyArray<string>,
    hashes: ReadonlySet<string>,
  ): string[] =>
    requests.flatMap((u) => {
      const h = /^\/scripthash\/([0-9a-f]{64})\/(txs|utxo)$/.exec(u)?.[1];
      return h !== undefined && hashes.has(h) ? [u] : [];
    });

  const prepareFarSend = async (w: ReturnType<typeof world>) =>
    w
      .boot()
      .then(async (booted) =>
        booted.ctl.prepareSend(
          { account: { ...ACCOUNT }, network: NET, to: RECIP, amount: 10_000n, fee: "slow" },
          "req-far",
        ),
      );

  it("is refused when the second endpoint does not know its funding transaction", async () => {
    const w = world({ independent: true });
    usedUpTo(w, FAR);
    // The primary invents this coin: the second endpoint's 404 settles the disagreement.
    w.fundChange(FAR, 9, 200_000);
    await expect(prepareFarSend(w)).rejects.toMatchObject({ code: "invalid-request" });
    // The invented coin never reached the signer — no internal PSBT exists to seal its index.
    expect(w.signedCalls).toStrictEqual([]);
    expect(w.independentRequests.filter((u) => u.endsWith("/hex"))).not.toStrictEqual([]);
  }, 120_000);

  it("frees the refused coin so a retry under an honest endpoint selects it", async () => {
    const w = world({ independent: true });
    usedUpTo(w, FAR);
    const coin = w.fundChange(FAR, 9, 200_000);
    const booted = await w.boot();
    // The independent's 404 refuses this prepare; the coin must not stay reserved under req-far.
    await expect(
      booted.ctl.prepareSend(
        { account: { ...ACCOUNT }, network: NET, to: RECIP, amount: 10_000n, fee: "slow" },
        "req-far",
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    w.setIndependentHex(coin.txid, fundingHex(w, coin.txid));
    const tx = await w.send(booted, 10_000n, "req-retry");
    expect(tx.state).not.toBe("failed");
    const psbt = Transaction.fromPSBT(psbtOf(w.signedCalls));
    const inputTxids = Array.from({ length: psbt.inputsLength }, (_, i) =>
      Buffer.from(psbt.getInput(i).txid as Uint8Array).toString("hex"),
    );
    expect(inputTxids).toContain(coin.txid);
  }, 120_000);

  it("is refused when the second endpoint's outpoint disagrees with the claim", async () => {
    const w = world({ independent: true });
    usedUpTo(w, FAR);
    const coin = w.fundChange(FAR, 9, 200_000);
    // A real transaction whose txid is not the coin's — too small to be selected over it.
    const other = w.fund(11, 600);
    w.setIndependentHex(coin.txid, fundingHex(w, other.txid));
    await expect(prepareFarSend(w)).rejects.toMatchObject({ code: "invalid-request" });
    expect(w.signedCalls).toStrictEqual([]);
  }, 120_000);

  it("proceeds when the second endpoint serves the same funding transaction", async () => {
    const w = world({ independent: true });
    usedUpTo(w, FAR);
    const coin = w.fundChange(FAR, 9, 200_000);
    w.setIndependentHex(coin.txid, fundingHex(w, coin.txid));
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-far");
    expect(tx.state).not.toBe("failed");
    // The coin is real, so the mark raise it carries is legitimate: the signed PSBT spends it.
    const psbt = Transaction.fromPSBT(psbtOf(w.signedCalls));
    const inputTxids = Array.from({ length: psbt.inputsLength }, (_, i) =>
      Buffer.from(psbt.getInput(i).txid as Uint8Array).toString("hex"),
    );
    expect(inputTxids).toContain(coin.txid);
  }, 120_000);

  it("proceeds flagged unverified when the second read fails transiently", async () => {
    const w = world({ independent: true });
    usedUpTo(w, FAR);
    const coin = w.fundChange(FAR, 9, 200_000);
    w.setIndependentHex(coin.txid, new TypeError("fetch failed"));
    const prepared = await prepareFarSend(w);
    expect(prepared.checks).toContain("reads-unverified");
    prepared.release();
  }, 120_000);

  it("proceeds on the primary's word alone when no second endpoint is configured", async () => {
    const w = world();
    usedUpTo(w, FAR);
    w.fundChange(FAR, 9, 200_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-far");
    expect(tx.state).not.toBe("failed");
  }, 120_000);

  it("never asks the second endpoint about a coin inside the reach", async () => {
    const w = world({ independent: true, changeMark: 100 });
    // Index 50 lies under the reach mark 100 proves — a spendable coin that is not far.
    w.fundChange(50, 7, 200_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-in");
    expect(tx.state).not.toBe("failed");
    expect(w.independentRequests.filter((u) => u.endsWith("/hex"))).toStrictEqual([]);
  }, 120_000);

  it("bounds the rescan a sealed mark costs to two reads per scanned address", async () => {
    const w = world({ changeMark: FAR });
    w.fund(1, 50_000);
    const booted = await w.boot();
    const before = w.requests.length;
    const prepared = await booted.ctl.prepareSend(
      { account: { ...ACCOUNT }, network: NET, to: RECIP, amount: 10_000n, fee: "slow" },
      "req-after",
    );
    prepared.release();
    const changeHashes = new Set(
      Array.from({ length: BITCOIN_SCAN_LIMIT }, (_, i) =>
        scripthash(bitcoinAddressFromXpub(HD.publicExtendedKey, "btc.bip84", NET, 1, i), NETWORK),
      ),
    );
    // txs + utxo per scanned change address, and the walk can never pass the scan limit.
    expect(scripthashReads(w.requests.slice(before), changeHashes).length).toBeLessThanOrEqual(
      2 * BITCOIN_SCAN_LIMIT,
    );
  }, 120_000);
});
