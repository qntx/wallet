/**
 * The change-index rule: a send's change goes on the spending template's own change chain at the
 * first index above the kernel's sealed mark that still lies inside the scan's reach — `mark <
 * index <= changeScanReach(mark)` — skipping every address this wallet already used for change
 * (in-flight picks and the tracked transactions' own outputs). The pick never reads the endpoint's
 * "used" answers, so one lying endpoint can move the sealed mark by at most one index per real
 * signed send, and a burned index — signed, never confirmed — is never handed out again. The chosen
 * index always satisfies `isDiscoverableChange`, so the kernel hides the same output the engine
 * does.
 */
import { HDKey } from "@scure/bip32";
import { NETWORK, Transaction } from "@scure/btc-signer";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  BITCOIN_SCAN_LIMIT,
  bitcoinAddressFromXpub,
  changeScanReach,
  isDiscoverableChange,
} from "@qntx/wallet-chains/bitcoin";
import type { BitcoinAccountTemplate, BitcoinPathTail } from "@qntx/wallet-chains/bitcoin";

import { scripthash } from "../src/chains/bitcoin-scan.ts";
import type { ScanAddress } from "../src/chains/bitcoin-scan.ts";
import { EsploraError } from "../src/chains/bitcoin.ts";
import { changeAddressOf } from "../src/transactions/bitcoin.ts";
import type { SignParams } from "../src/transactions/route.ts";
import { ACCOUNT, CHANGE_ADDR, HD, NET, RECIP, world } from "./support/btc-world.ts";

const PURPOSE = 84;
const SEED = new Uint8Array(64).fill(1);
const ROOT86 = HDKey.fromMasterSeed(SEED).derive("m/86'/0'/0'");

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

/** The change output's derivation tail — bip32 for segwit v0, taproot for bip86. */
const changeTailOf = (psbt: Transaction): BitcoinPathTail => {
  const paths = Array.from({ length: psbt.outputsLength }, (_, i) => psbt.getOutput(i)).flatMap(
    (o) => [
      ...(o.bip32Derivation ?? []).map(([, v]) => v.path),
      ...(o.tapBip32Derivation ?? []).map(([, v]) => v.der.path),
    ],
  );
  const found = paths.find((p) => p.length === 5 && p[3] === 1);
  if (found === undefined || found[4] === undefined || found[0] === undefined) {
    throw new Error("no bound change derivation on the PSBT");
  }
  return { purpose: found[0] - 0x80000000, change: 1, index: found[4] };
};

/** `changeAddressOf`'s refusal — a ChainError whose code reads `unavailable`. */
const expectUnavailable = (pick: () => unknown): void => {
  try {
    pick();
  } catch (error) {
    expect(error).toMatchObject({
      code: "invalid-request",
      message: "no unused change address inside the scan window",
    });
    return;
  }
  throw new Error("expected the change pick to refuse");
};

const inputTxidsOf = (psbt: Transaction): ReadonlyArray<string> =>
  Array.from({ length: psbt.inputsLength }, (_, i) =>
    Buffer.from(psbt.getInput(i).txid as Uint8Array).toString("hex"),
  );

/** The hostile primary claims every change address before `end` was used — the gap walk follows. */
const usedUpTo = (
  w: ReturnType<typeof world>,
  end: number,
  template: BitcoinAccountTemplate = "btc.bip84",
): void => {
  const xpub = template === "btc.bip86" ? ROOT86.publicExtendedKey : HD.publicExtendedKey;
  for (let i = 0; i < end; i += 1) {
    const addr = bitcoinAddressFromXpub(xpub, template, NET, 1, i);
    w.markUsed(scripthash(addr, NETWORK), "ab".repeat(32));
  }
};

describe("changeAddressOf", () => {
  it("always lands inside the window the sealed mark opens, past the mark and outside `taken`", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 80, maxLength: 80 }),
        fc.nat(40),
        fc.array(fc.nat(79), { maxLength: 10 }),
        (used, mark, takenIndexes) => {
          const chain = chainOf(used);
          const taken = new Set(takenIndexes.map((i) => chain[i]!.address));
          const chosen = changeAddressOf(chain, mark, taken);
          expect(chosen.index).toBeGreaterThan(mark);
          expect(chosen.index).toBeLessThanOrEqual(changeScanReach(mark));
          expect(taken.has(chosen.address)).toBe(false);
          // The kernel hides it under the same mark: the pick is always discoverable change.
          expect(
            isDiscoverableChange(
              { purpose: PURPOSE, change: 1, index: chosen.index },
              [{ purpose: PURPOSE, change: 0, index: 0 }],
              mark,
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never reads the endpoint's used answers — an all-used claim still picks mark + 1", () => {
    const allClaimedUsed = chainOf(Array.from({ length: 60 }, () => true));
    expect(changeAddressOf(allClaimedUsed, 0, new Set()).index).toBe(1);
    expect(changeAddressOf(allClaimedUsed, 30, new Set()).index).toBe(31);
  });

  it("skips indexes at or below the mark and every taken address", () => {
    const chain = chainOf(Array.from({ length: 60 }, () => false));
    // Index 0 is never handed out: the mark-0 window starts above the mark itself.
    expect(changeAddressOf(chain, 0, new Set()).index).toBe(1);
    // A reserved or already-used change address is skipped for the next free index.
    expect(changeAddressOf(chain, 0, new Set([chain[1]!.address])).index).toBe(2);
    // The reach caps the pick: at mark 1979 the first usable index is 1980.
    const deep = chainOf(Array.from({ length: BITCOIN_SCAN_LIMIT }, () => true));
    expect(changeAddressOf(deep, 1979, new Set()).index).toBe(1980);
    // Taking every index inside the window leaves nothing — the pick refuses.
    expectUnavailable(() =>
      changeAddressOf(deep, 1979, new Set(deep.slice(1980).map((a) => a.address))),
    );
  });

  // oxlint-disable-next-line vitest/expect-expect -- expectUnavailable wraps the expect calls
  it("throws `invalid-request` once the window the mark opens is exhausted", () => {
    const deep = chainOf(Array.from({ length: BITCOIN_SCAN_LIMIT }, () => false));
    // At mark 1999 the reach is 1999: no index above the mark can ever lie inside it.
    expectUnavailable(() => changeAddressOf(deep, BITCOIN_SCAN_LIMIT - 1, new Set()));
    // Every index inside the window already taken by the wallet itself ends the same way.
    const taken = new Set(deep.map((a) => a.address));
    expectUnavailable(() => changeAddressOf(deep, 0, taken));
  });
});

describe("a send against a primary that claims the whole change chain used", () => {
  it.each([
    // [sealed mark, claimed-used end]: the primary reports a used run covering the window the
    // mark opens — the pick must still land at mark + 1, never at the old endpoint-driven bound.
    [0, 60],
    [1940, 1980],
  ])(
    "mark %d: the change binds index mark + 1 and the second endpoint is never asked /hex",
    async (mark, used) => {
      const w = world({ independent: true, changeMark: mark });
      usedUpTo(w, used);
      w.fund(1, 50_000);
      const booted = await w.boot();
      const tx = await w.send(booted, 10_000n, "req");

      expect(tx.state).not.toBe("failed");
      const tail = changeTailOf(Transaction.fromPSBT(psbtOf(w.signedCalls)));
      expect(tail).toStrictEqual({ purpose: PURPOSE, change: 1, index: mark + 1 });
      // No far-coin read exists anymore: the second endpoint learns nothing about the send.
      expect(w.independentRequests.filter((u) => u.endsWith("/hex"))).toStrictEqual([]);
      // The kernel's own rule hides this output — index mark + 1 is inside mark + 20.
      expect(isDiscoverableChange(tail, [{ purpose: PURPOSE, change: 0, index: 0 }], mark)).toBe(
        true,
      );
    },
    120_000,
  );

  it("three consecutive sends climb the mark one index each — never the full gap limit", async () => {
    /* The mark the fake kernel seals is the hidden change index itself, so under the all-used
       claim the picks walk mark + 1, +2, +3 — each step paid for by a real signed send — while
       the endpoint's answers move nothing. */
    const w = world({ independent: true });
    usedUpTo(w, 60);
    w.fund(1, 50_000);
    w.fund(2, 50_000);
    w.fund(3, 50_000);
    const booted = await w.boot();

    const indexes: number[] = [];
    for (const requestId of ["req-a", "req-b", "req-c"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each send tracks its change before the next picks
      const tx = await w.send(booted, 10_000n, requestId);
      expect(tx.state).not.toBe("failed");
      indexes.push(changeTailOf(Transaction.fromPSBT(psbtOf(w.signedCalls))).index);
    }
    expect(indexes).toStrictEqual([1, 2, 3]);
    expect(w.independentRequests.filter((u) => u.endsWith("/hex"))).toStrictEqual([]);
  }, 120_000);
});

describe("change reservations", () => {
  it("two prepares in flight pick different indexes; releasing one frees it for the next", async () => {
    const w = world();
    w.fund(1, 50_000);
    w.fund(2, 50_000);
    const booted = await w.boot();
    const params = async (requestId: string) =>
      booted.ctl.prepareSend(
        { account: { ...ACCOUNT }, network: NET, to: RECIP, amount: 10_000n, fee: "slow" },
        requestId,
      );
    const [a, b] = await Promise.all([params("req-a"), params("req-b")]);
    const txA = await a.submit({ kind: "password", password: "pw" }, () => undefined);
    const txB = await b.submit({ kind: "password", password: "pw" }, () => undefined);
    expect(txA.state).not.toBe("failed");
    expect(txB.state).not.toBe("failed");
    // The two signed PSBTs carry different change indexes — neither reuses the other's pick.
    const tails = w.signedCalls
      .map((call) => Transaction.fromPSBT(psbtOf([call])))
      .map(changeTailOf)
      .map((t) => t.index);
    expect([...tails].toSorted((x, y) => x - y)).toStrictEqual([1, 2]);

    // A fresh world: release the only pick, then watch the next prepare take the same index.
    const w3 = world();
    w3.fund(1, 50_000);
    const booted3 = await w3.boot();
    const first = await booted3.ctl.prepareSend(
      { account: { ...ACCOUNT }, network: NET, to: RECIP, amount: 10_000n, fee: "slow" },
      "req-1",
    );
    first.release();
    const second = await booted3.ctl.prepareSend(
      { account: { ...ACCOUNT }, network: NET, to: RECIP, amount: 10_000n, fee: "slow" },
      "req-2",
    );
    const tx2 = await second.submit({ kind: "password", password: "pw" }, () => undefined);
    expect(tx2.state).not.toBe("failed");
    expect(changeTailOf(Transaction.fromPSBT(psbtOf(w3.signedCalls))).index).toBe(1);
  }, 120_000);

  it("an unconfirmed account's tracked change is still skipped — the mark never rose", async () => {
    /* A device entry never confirmed shows its change as a plain send, so no internal request
       seals a mark for it. The next send must still not reuse the first send's change address:
       `taken` covers the tracked transaction's own output whatever the mark says. */
    const w = world({ confirmed: false });
    w.fund(1, 50_000);
    w.fund(2, 50_000);
    const booted = await w.boot();
    const first = await w.send(booted, 10_000n, "req-1");
    const second = await w.send(booted, 10_000n, "req-2");
    expect(first.state).not.toBe("failed");
    expect(second.state).not.toBe("failed");
    const tails = w.signedCalls
      .map((call) => Transaction.fromPSBT(psbtOf([call])))
      .map(changeTailOf)
      .map((t) => t.index);
    expect(tails).toStrictEqual([1, 2]);
  }, 120_000);
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

describe("a send whose window the sealed mark opens is exhausted", () => {
  it("mark 1999 refuses with `invalid-request` and signs nothing", async () => {
    const w = world({ changeMark: BITCOIN_SCAN_LIMIT - 1 });
    w.fund(1, 50_000);
    const booted = await w.boot();
    await expect(
      booted.ctl.prepareSend(
        { account: { ...ACCOUNT }, network: NET, to: RECIP, amount: 10_000n, fee: "slow" },
        "req-edge",
      ),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "no unused change address inside the scan window",
    });
    expect(w.signedCalls).toStrictEqual([]);
  }, 120_000);
});

describe("a far change coin the primary reports", () => {
  const FAR = 150;

  it("is signed on the primary's word — a hostile second endpoint's 403 vetoes nothing", async () => {
    const w = world({ independent: true });
    usedUpTo(w, FAR);
    // A REAL coin the world holds raw bytes for — the wallet restored and its history is honest.
    const coin = w.fundChange(FAR, 9, 200_000);
    w.setIndependentHex(
      coin.txid,
      new EsploraError(`esplora https://x/tx/${coin.txid}/hex: 403`, false),
    );
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-honest");
    expect(tx.state).not.toBe("failed");
    const psbt = Transaction.fromPSBT(psbtOf(w.signedCalls));
    expect(inputTxidsOf(psbt)).toContain(coin.txid);
    // The change binds mark + 1, and the second endpoint never learned the coin's txid.
    expect(changeTailOf(psbt).index).toBe(1);
    expect(w.independentRequests.filter((u) => u.endsWith("/hex"))).toStrictEqual([]);
  }, 120_000);

  it("is signed the same way when the second endpoint simply does not know it", async () => {
    const w = world({ independent: true });
    usedUpTo(w, FAR);
    const coin = w.fundChange(FAR, 9, 200_000);
    // No scripted answer: the independent stub 404s an unknown txid like a real Esplora.
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-honest");
    expect(tx.state).not.toBe("failed");
    expect(inputTxidsOf(Transaction.fromPSBT(psbtOf(w.signedCalls)))).toContain(coin.txid);
    expect(w.independentRequests.filter((u) => u.endsWith("/hex"))).toStrictEqual([]);
  }, 120_000);

  it("an invented far coin on bip86 costs only the send itself — never a second-endpoint read", async () => {
    /* The primary invents a coin past the whole scan reach; its body read at the second
       endpoint aborts. There is no cross-check left to fail open or closed: the coin is
       signed (a failed broadcast costs availability), the change binds mark + 1, and the
       second endpoint is asked nothing. The taproot coin is inscription-protected, so the
       send names it — exactly what a request carrying this input would do. */
    const w = world({ independent: true, template: "btc.bip86" });
    usedUpTo(w, 1979, "btc.bip86");
    const coin = w.fundChange(1979, 9, 200_000);
    w.setIndependentHex(coin.txid, new DOMException("aborted", "AbortError"));
    const booted = await w.boot();
    const prepared = await booted.ctl.prepareSend(
      {
        account: { ...ACCOUNT, template: "btc.bip86" },
        network: NET,
        to: RECIP,
        amount: 10_000n,
        fee: "slow",
        inputs: [`${coin.txid}:${String(coin.vout)}`],
      },
      "req-far",
    );
    const tx = await prepared.submit({ kind: "password", password: "pw" }, () => undefined);
    expect(tx.state).not.toBe("failed");
    const psbt = Transaction.fromPSBT(psbtOf(w.signedCalls));
    const tail = changeTailOf(psbt);
    expect(tail).toStrictEqual({ purpose: 86, change: 1, index: 1 });
    expect(w.independentRequests.filter((u) => u.endsWith("/hex"))).toStrictEqual([]);
  }, 120_000);
});

describe("a change coin past the sealed-mark reach", () => {
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
    const w = world({ changeMark: 1979 });
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
    const scripthashReads = w.requests
      .slice(before)
      .map((u) => /^\/scripthash\/([0-9a-f]{64})\/(txs|utxo)$/.exec(u)?.[1])
      .filter((h): h is string => h !== undefined)
      .filter((h) => changeHashes.has(h));
    // txs + utxo per scanned change address, and the walk can never pass the scan limit.
    expect(scripthashReads.length).toBeLessThanOrEqual(2 * BITCOIN_SCAN_LIMIT);
  }, 120_000);
});
