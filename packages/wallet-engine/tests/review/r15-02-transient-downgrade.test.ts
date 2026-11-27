/**
 * Review PoC R15-02: a far-change-coin cross-check that fails for any reason other than a
 * non-transient `EsploraError` is downgraded to `reads-unverified` and the spend proceeds — the
 * invented coin is signed as an internal send and its change-chain index is sealed. A response body
 * slower than the request timeout is exactly such a failure: the abort fires while `res.text()` is
 * awaited, outside the `try` that wraps `fetchFn`, so the raw `AbortError` — not an `EsploraError`
 * — reaches `crossCheckFarChangeCoins`, which cannot tell it apart from a dropped connection and
 * proceeds flagged.
 *
 * Each test asserts today's behaviour — it passes now and fails once a body-timeout refusal (or the
 * second endpoint's answer going missing) refuses the build instead.
 */
/* oxlint-disable vitest/no-conditional-in-test -- scripted failures and typed reads vary per branch */
import { NETWORK, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinAddressFromXpub } from "@qntx/wallet-chains/bitcoin";

import { scripthash } from "../../src/chains/bitcoin-scan.ts";
import { esplora, EsploraError } from "../../src/chains/bitcoin.ts";
import type { EsploraFetch } from "../../src/chains/bitcoin.ts";
import { ACCOUNT, HD, NET, RECIP, world } from "../support/btc-world.ts";

const FAR = 1979;

/** The hostile primary claims every change address before `end` was used — the gap walk follows. */
const usedUpTo = (w: ReturnType<typeof world>, end: number): void => {
  for (let i = 0; i < end; i += 1) {
    const addr = bitcoinAddressFromXpub(HD.publicExtendedKey, "btc.bip84", NET, 1, i);
    w.markUsed(scripthash(addr, NETWORK), "ab".repeat(32));
  }
};

describe("R15-02a: a body slower than the request timeout fails open, not as EsploraError", () => {
  it("the get rejects with a raw AbortError — never an EsploraError, transient or not", async () => {
    // A 200 whose body never lands: text() hangs until the client's timeout aborts the signal.
    const fetchFn: EsploraFetch = async (_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => undefined },
        json: async () => new Promise<unknown>(() => {}),
        text: async () =>
          new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      });
    const client = esplora(
      ["https://e.invalid"],
      fetchFn,
      {
        setTimer: (ms, fn) => {
          const t = setTimeout(fn, ms);
          return () => {
            clearTimeout(t);
          };
        },
        random: (n) => new Uint8Array(n),
      },
      50,
    );

    const failure = await client.get("/tx/aa/hex").then(
      () => {
        throw new Error("the get resolved");
      },
      (error: unknown) => error,
    );
    // Today the failure is not an EsploraError at all — the abort escapes the fetch-only try as
    // the DOMException the body read raised, so the far-coin branch below downgrades it.
    expect(failure instanceof Error && failure.name === "AbortError").toBe(true);
    expect(failure instanceof EsploraError && !failure.transient).toBe(false);
  });
});

describe("R15-02b: the same failure at the second endpoint signs and seals the invented coin", () => {
  it("downgrades to reads-unverified and spends the far change coin as an internal send", async () => {
    const w = world({ independent: true });
    usedUpTo(w, FAR);
    const coin = w.fundChange(FAR, 9, 200_000);
    // The second endpoint's body read aborts — not an EsploraError, so not a definite refusal.
    w.setIndependentHex(coin.txid, new DOMException("aborted", "AbortError"));
    const booted = await w.boot();

    const prepared = await booted.ctl.prepareSend(
      { account: { ...ACCOUNT }, network: NET, to: RECIP, amount: 10_000n, fee: "slow" },
      "req-transient",
    );
    expect(prepared.checks).toContain("reads-unverified");
    const tx = await prepared.submit({ kind: "password", password: "pw" }, () => undefined);
    expect(tx.state).not.toBe("failed");

    const request = w.signedCalls.at(-1)?.request;
    expect(request?.kind).toBe("bitcoin.psbt");
    if (request?.kind !== "bitcoin.psbt") {
      throw new Error("expected a bitcoin.psbt sign call");
    }
    // The invented coin went to the signer under origin "internal" — the kernel seals its index.
    expect(request.origin).toBe("internal");
    const psbt = Transaction.fromPSBT(request.psbt);
    const inputs = Array.from({ length: psbt.inputsLength }, (_, i) => psbt.getInput(i));
    expect(inputs.map((i) => Buffer.from(i.txid as Uint8Array).toString("hex"))).toContain(
      coin.txid,
    );
    const tails = inputs.flatMap((i) => (i.bip32Derivation ?? []).map(([, v]) => v.path));
    expect(tails).toContainEqual([84 + 0x80000000, 0x80000000, 0x80000000, 1, FAR]);
  }, 120_000);
});
