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
import { assessRecipients, knownAddresses } from "../src/requests/risk.ts";
import { changeAddressOf } from "../src/transactions/bitcoin.ts";
import type { SignParams } from "../src/transactions/route.ts";
import { ACCOUNT, CHANGE_ADDR, HD, NET, RECIP, VERIFY, world } from "./support/btc-world.ts";

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
  });

  it("an exhausted window reuses the entry at the reach — the pick never refuses", () => {
    const deep = chainOf(Array.from({ length: BITCOIN_SCAN_LIMIT }, () => false));
    // At mark 1999 the reach is 1999: the window above the mark is empty, so the entry at the
    // reach — the mark itself — is handed out again.
    expect(changeAddressOf(deep, BITCOIN_SCAN_LIMIT - 1, new Set()).index).toBe(
      BITCOIN_SCAN_LIMIT - 1,
    );
    // Mark 0 covers indexes 1..changeScanReach(0): taken 1..19 leaves the reach itself the pick.
    const chain = chainOf(Array.from({ length: 60 }, () => false));
    const almost = new Set(chain.slice(1, changeScanReach(0)).map((a) => a.address));
    expect(changeAddressOf(chain, 0, almost).index).toBe(changeScanReach(0));
    // Take the whole window and the same reach entry is reused — a refusal would lock the funds
    // while reusing it only links payments.
    const taken = new Set(deep.map((a) => a.address));
    expect(changeAddressOf(deep, 0, taken).index).toBe(changeScanReach(0));
    // Mark 1980 with 1981..1999 taken falls back to the reach too — never one past it.
    const takenDeep = new Set(deep.slice(1981).map((a) => a.address));
    expect(changeAddressOf(deep, 1980, takenDeep).index).toBe(BITCOIN_SCAN_LIMIT - 1);
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

  it("an unconfirmed account's tracked change is still skipped even while the mark is 0", async () => {
    /* A device entry never confirmed shows its change as a plain send; the kernel now still seals
       the raise for it (the signed bytes pay that address, so the wallet must scan there). Either
       way `taken` covers the tracked transaction's own output — the next send never reuses the
       first send's change address. */
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

  it("the unconfirmed change never vouches — out of `knownAddresses`, still a first recipient", async () => {
    /* The tracked send's intent lists the change as a plain outflow to CHANGE_ADDR, but the
       `unconfirmed-signer-output` warning names it — `knownAddresses` takes only vouching
       outflows, so paying CHANGE_ADDR stays a first-recipient finding. */
    const w = world({ confirmed: false });
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).not.toBe("failed");
    expect(tx.intent?.outflows.some((o) => o.to === CHANGE_ADDR)).toBe(true);

    const known = knownAddresses([], Object.values(booted.ctl.getState().txs), "bitcoin");
    expect(known).not.toContain(CHANGE_ADDR);
    expect(assessRecipients("bitcoin", [CHANGE_ADDR], known).map((f) => f.code)).toContain(
      "first-recipient",
    );
  });
});

describe("a send whose window the sealed mark opens is exhausted", () => {
  it("mark 1999 signs with change at /1/1999 — the last index, hidden as change", async () => {
    /* The window above mark 1999 is empty, so the pick reuses the entry at the reach — the mark
       itself — and the send still builds and signs. Reusing the index only links payments; a
       refusal would lock the funds, and the kernel still classifies the output as change. */
    const w = world({ changeMark: BITCOIN_SCAN_LIMIT - 1 });
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-edge");
    expect(tx.state).not.toBe("failed");
    const tail = changeTailOf(Transaction.fromPSBT(psbtOf(w.signedCalls)));
    expect(tail).toStrictEqual({ purpose: PURPOSE, change: 1, index: BITCOIN_SCAN_LIMIT - 1 });
    // /1/1999 is discoverable change at the mark-1999 reach — the intent hides it.
    const last = bitcoinAddressFromXpub(HD.publicExtendedKey, "btc.bip84", NET, 1, 1999);
    expect(tx.intent?.outflows.every((o) => o.to !== last)).toBe(true);
  }, 120_000);
});

describe("a change window the wallet itself already filled", () => {
  const prepare = async (
    booted: Awaited<ReturnType<ReturnType<typeof world>["boot"]>>,
    requestId: string,
    amount = 10_000n,
  ) =>
    booted.ctl.prepareSend(
      { account: { ...ACCOUNT }, network: NET, to: RECIP, amount, fee: "slow" },
      requestId,
    );

  it("twenty rejected rows take nothing — the next send builds, sweeps too, across a restart", async () => {
    /* A cancelled prompt flips the draft to `rejected` — bytes that never existed. Their own
       outputs stay free: the next send still picks /1/1, a sweep builds, and a restart — the
       rows persisted — changes nothing. */
    const w = world();
    w.fund(1, 500_000);
    const booted = await w.boot();
    const { sign } = w.apis;
    (w.apis as { sign: (p: SignParams) => Promise<unknown> }).sign = async () => {
      await Promise.resolve();
      throw new Error("user cancelled");
    };
    for (let i = 0; i < 20; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each rejected row must land first
      const prepared = await prepare(booted, `req-${String(i)}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential attempts
      await expect(prepared.submit(VERIFY, () => undefined)).rejects.toThrow("user cancelled");
      prepared.release();
    }
    const states = Object.values(booted.ctl.getState().txs).map((t) => t.state);
    expect(new Set(states)).toStrictEqual(new Set(["rejected"]));

    (w.apis as { sign: typeof sign }).sign = sign;
    const tx = await w.send(booted, 10_000n, "req-ok");
    expect(tx.state).not.toBe("failed");
    expect(changeTailOf(Transaction.fromPSBT(psbtOf(w.signedCalls))).index).toBe(1);
    // A fresh coin — req-ok's input is locked to its broadcast — sweeps just the same: the
    // build never blocks on a change pick.
    w.fund(2, 600_000);
    const sweep = await prepare(booted, "req-sweep", 599_000n);
    sweep.release();
    // The rows are persisted: a restart changes nothing — req-ok's signed change is taken.
    const rebooted = await w.boot(booted.backing);
    const again = await w.send(rebooted, 10_000n, "req-after-restart");
    expect(again.state).not.toBe("failed");
    expect(changeTailOf(Transaction.fromPSBT(psbtOf(w.signedCalls))).index).toBe(2);
  }, 240_000);

  it("a mark that follows each unconfirmed-entry send walks the indexes it used", async () => {
    /* The kernel seals the raise for an internal request's discoverable change even when the
       serving entry never confirmed on the device — modelled here by the fake `account`
       reporting each signed send's change index: twenty-two sends all build at fresh indexes. */
    let mark = 0;
    const w = world({ confirmed: false });
    for (let i = 1; i <= 22; i += 1) {
      w.fund(i, 50_000);
    }
    const { account } = w.apis;
    (w.apis as { account: typeof account }).account = async (p: Parameters<typeof account>[0]) => ({
      ...(await account(p)),
      changeMark: mark,
    });
    const booted = await w.boot();
    const indexes: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the mark follows each signed send
      const tx = await w.send(booted, 10_000n, `req-${String(i)}`);
      expect(tx.state).not.toBe("failed");
      const { index } = changeTailOf(Transaction.fromPSBT(psbtOf(w.signedCalls)));
      indexes.push(index);
      mark = index;
    }
    expect(indexes).toStrictEqual(Array.from({ length: 22 }, (_, i) => i + 1));
  }, 240_000);

  it("a stuck mark with the window taken reuses the reach — the twenty-first send signs /1/20", async () => {
    /* A device entry never confirmed that raises nothing — the pre-fix kernel's behaviour — keeps
       the fake mark at 0 while twenty signed sends fill the window. The twenty-first still builds:
       every index in (0, 20] is taken, so the pick falls back to the reach itself. */
    const w = world({ confirmed: false });
    for (let i = 1; i <= 22; i += 1) {
      w.fund(i, 50_000);
    }
    const booted = await w.boot();
    for (let i = 0; i < 20; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each send's row must land before the next picks
      const tx = await w.send(booted, 10_000n, `req-${String(i)}`);
      expect(tx.state).not.toBe("failed");
    }
    const tx = await w.send(booted, 10_000n, "req-20");
    expect(tx.state).not.toBe("failed");
    expect(changeTailOf(Transaction.fromPSBT(psbtOf(w.signedCalls))).index).toBe(20);
  }, 240_000);

  it("a mark reset under kept rows reuses the reach, then climbs once the mark follows", async () => {
    /* Twenty signed sends fill the mark-0 window 1..20 (the mark follows each send). The mark
       then answers 0 again — the wallet's own rows still hold the window — so the next send
       reuses the reach index /1/20 rather than refusing. Once the mark catches up to 20 the
       window opens again and the next pick is /1/21. */
    let mark = 0;
    const w = world();
    for (let i = 1; i <= 22; i += 1) {
      w.fund(i, 50_000);
    }
    const { account } = w.apis;
    (w.apis as { account: typeof account }).account = async (p: Parameters<typeof account>[0]) => ({
      ...(await account(p)),
      changeMark: mark,
    });
    const booted = await w.boot();
    for (let i = 1; i <= 20; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the mark follows each signed send
      const tx = await w.send(booted, 10_000n, `req-${String(i)}`);
      expect(tx.state).not.toBe("failed");
      mark = i;
    }
    mark = 0;
    const reuse = await w.send(booted, 10_000n, "req-after-reset");
    expect(reuse.state).not.toBe("failed");
    expect(changeTailOf(Transaction.fromPSBT(psbtOf(w.signedCalls))).index).toBe(20);
    mark = 20;
    const next = await w.send(booted, 10_000n, "req-caught-up");
    expect(next.state).not.toBe("failed");
    expect(changeTailOf(Transaction.fromPSBT(psbtOf(w.signedCalls))).index).toBe(21);
  }, 240_000);
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

describe("a ratcheted mark places change a mark-0 restore cannot see (documented residual)", () => {
  it("mark 1979: change binds /1/1980; a seed-only restore starts at mark 0 and never scans there", async () => {
    /* Documented residual, kept on purpose: the sealed mark only ratchets up — a mark a hostile
       endpoint already walked to 1979 keeps placing change at mark + 1, and marks are not in the
       backup, so a seed-only restore starts at 0 and its gap-limited scan never reaches /1/1980.
       No API lowers a mark. */
    const upgraded = world({ changeMark: 1979 });
    upgraded.fund(1, 50_000);
    const booted = await upgraded.boot();
    const tx = await upgraded.send(booted, 10_000n, "req-1");
    expect(tx.state).not.toBe("failed");
    expect(changeTailOf(Transaction.fromPSBT(psbtOf(upgraded.signedCalls))).index).toBe(1980);

    // The same seed restored elsewhere: honest history (receive /0/0, the change at /1/1980).
    const restored = world();
    restored.fund(2, 50_000);
    const change = restored.fundChange(1980, 9, 39_000);
    const rbooted = await restored.boot();
    // The change coin is not an account candidate: the gap scan never walked to /1/1980.
    await expect(
      rbooted.ctl.prepareSend(
        {
          account: { ...ACCOUNT },
          network: NET,
          to: RECIP,
          amount: 10_000n,
          fee: "slow",
          inputs: [`${change.txid}:${String(change.vout)}`],
        },
        "req-r",
      ),
    ).rejects.toThrow("is not a spendable output of this account");
    const far = scripthash(
      bitcoinAddressFromXpub(HD.publicExtendedKey, "btc.bip84", NET, 1, 1980),
      NETWORK,
    );
    expect(restored.requests.some((u) => u.includes(far))).toBe(false);
  }, 120_000);
});
