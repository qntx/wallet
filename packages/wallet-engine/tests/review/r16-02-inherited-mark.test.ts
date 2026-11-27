/**
 * Review PoC R16-02: a mark 0.14.0 already ratcheted (R15-01: a hostile primary walked it one gap
 * limit per send, to 1979 after ~99 sends) is persisted and #468 never brings it back. The v2 rule
 * keeps placing change at mark + 1 — 1980, 1981, … — far past what a seed-only restore (marks are
 * not in the backup, so it starts at 0) or any gap-limit-20 wallet scans, so the coin is invisible
 * there, contrary to SECURITY's "address reuse that costs privacy, never visibility". Twenty such
 * sends later the window is exhausted and every send from the template is refused (R16-01). There
 * is no API that lowers a mark. Asserts today's behaviour.
 */
import { NETWORK, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinAddressFromXpub } from "@qntx/wallet-chains/bitcoin";

import { scripthash } from "../../src/chains/bitcoin-scan.ts";
import { ACCOUNT, HD, NET, RECIP, world } from "../support/btc-world.ts";

const psbtOf = (request: unknown): Uint8Array => {
  const r = request as { kind?: string; psbt?: Uint8Array } | undefined;
  if (r?.kind !== "bitcoin.psbt" || r.psbt === undefined) {
    throw new Error("expected a psbt sign");
  }
  return r.psbt;
};

const changeIndexOf = (psbt: Uint8Array): number => {
  const tx = Transaction.fromPSBT(psbt);
  for (let i = 0; i < tx.outputsLength; i += 1) {
    for (const [, v] of tx.getOutput(i).bip32Derivation ?? []) {
      if (v.path[3] === 1) {
        return v.path[4] ?? -1;
      }
    }
  }
  return -1;
};

describe("R16-02 a ratcheted 0.14.0 mark keeps change out of any restore's reach", () => {
  it("mark 1979: change binds /1/1980; a restored wallet (mark 0) cannot see or spend it", async () => {
    const upgraded = world({ changeMark: 1979 });
    upgraded.fund(1, 50_000);
    const booted = await upgraded.boot();
    const tx = await upgraded.send(booted, 10_000n, "req-1");
    expect(tx.state).not.toBe("failed");
    expect(changeIndexOf(psbtOf(upgraded.signedCalls.at(-1)?.request))).toBe(1980);

    // The same seed restored elsewhere: honest history (receive /0/0 and the change at /1/1980).
    const restored = world({ changeMark: 0 });
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
