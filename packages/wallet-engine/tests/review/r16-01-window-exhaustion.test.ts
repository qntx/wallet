/**
 * Review PoC R16-01: the change window can be exhausted without the mark ever moving, and once it
 * is, every send from the account — a no-change sweep included — is refused for good.
 *
 * `changeAddressOf` takes the lowest index in `(mark, changeScanReach(mark)]` that `changeTaken`
 * does not hold. `changeTaken` holds the own output of EVERY tracked transaction "whatever their
 * state" — including `rejected` rows, which the route writes as a `draft` before `apis.sign` and
 * flips to `rejected` when the sign call throws before the kernel's marks commit (passkey prompt
 * cancelled, wrong password, a pre-verify refusal). Such a row never raised the mark (the kernel
 * commits marks only after the factor verifies), so it eats one of the window's twenty indexes for
 * free. The same happens to every successful send of a device entry that was never confirmed: its
 * change is shown as a plain send, never hidden, so the mark never rises at all. And a mark that
 * drops back to 0 while the engine store keeps its rows (card import, delete-and-re-add:
 * `walletDeleteOps` removes the marks record; tracked rows are never pruned) faces a window its own
 * history already filled.
 *
 * The only thing that moves the mark is an internal send that hides change — which the exhausted
 * window can no longer build. Each test asserts today's behaviour and fails once it is fixed.
 */
import { describe, expect, it } from "vite-plus/test";

import type { SignParams } from "../../src/transactions/route.ts";
import { ACCOUNT, NET, RECIP, VERIFY, world } from "../support/btc-world.ts";

const REFUSAL = {
  code: "invalid-request",
  message: "no unused change address inside the scan window",
};

const prepare = async (
  booted: Awaited<ReturnType<ReturnType<typeof world>["boot"]>>,
  requestId: string,
  amount = 10_000n,
) =>
  booted.ctl.prepareSend(
    { account: { ...ACCOUNT }, network: NET, to: RECIP, amount, fee: "slow" },
    requestId,
  );

describe("R16-01 change-window exhaustion", () => {
  it("twenty cancelled sign prompts brick a confirmed account — across a restart, sweeps included", async () => {
    const w = world();
    w.fund(1, 500_000);
    const booted = await w.boot();
    const { sign } = w.apis;
    // The user cancels the passkey/biometric prompt: the kernel throws before any mark commit.
    (w.apis as { sign: (p: SignParams) => Promise<unknown> }).sign = async () => {
      await Promise.resolve();
      throw new Error("user cancelled");
    };
    for (let i = 0; i < 20; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each rejected row must land first
      const prepared = await prepare(booted, `req-${String(i)}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential attempts
      await expect(prepared.submit(VERIFY, () => undefined)).rejects.toThrow("user cancelled");
      // The request pipeline ends the failed request, handing its reservations back.
      prepared.release();
    }
    const states = Object.values(booted.ctl.getState().txs).map((t) => t.state);
    expect(states).toHaveLength(20);
    expect(new Set(states)).toStrictEqual(new Set(["rejected"]));

    // The user now approves — but the 21st send cannot even be built.
    (w.apis as { sign: typeof sign }).sign = sign;
    await expect(prepare(booted, "req-ok")).rejects.toMatchObject(REFUSAL);
    // A sweep of the whole balance needs no change output — it is refused the same way.
    await expect(prepare(booted, "req-sweep", 499_000n)).rejects.toMatchObject(REFUSAL);
    // The rows are persisted: a restart (or relock) changes nothing.
    const rebooted = await w.boot(booted.backing);
    await expect(prepare(rebooted, "req-after-restart")).rejects.toMatchObject(REFUSAL);
    // Nothing was ever signed: the mark the kernel sealed is still 0 — no raise ever ran.
    expect(w.signedCalls).toStrictEqual([]);
  }, 120_000);

  it("a never-confirmed device entry gets twenty change-bearing sends for its lifetime", async () => {
    // A paired device whose address was never verified on-screen (the default after pairing; a
    // Keystone BTC group > 0 or testnet entry can never be verified): the kernel never hides its
    // change, so the sealed mark stays 0 and every send consumes one index of (0, 20].
    const w = world({ confirmed: false });
    for (let i = 1; i <= 22; i += 1) {
      w.fund(i, 50_000);
    }
    const booted = await w.boot();
    for (let i = 0; i < 20; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each send tracks its change first
      const tx = await w.send(booted, 10_000n, `req-${String(i)}`);
      expect(tx.state).not.toBe("failed");
    }
    await expect(prepare(booted, "req-21")).rejects.toMatchObject(REFUSAL);
    await expect(prepare(booted, "req-sweep", 40_000n)).rejects.toMatchObject(REFUSAL);
    // Verifying the address on the device now does not help: the mark can only rise through a
    // send that hides change, and the engine refuses to build one.
    const { account } = w.apis;
    (w.apis as { account: typeof account }).account = async (p: Parameters<typeof account>[0]) => ({
      ...(await account(p)),
      confirmed: true,
    });
    await expect(prepare(booted, "req-after-verify")).rejects.toMatchObject(REFUSAL);
  }, 240_000);

  it("a mark reset under a kept engine store (card import, delete + re-add) refuses at once", async () => {
    // Twenty honest sends seal marks 1..20 (modelled: the fake kernel reports the sealed mark the
    // way `wallet.accounts` does). Then `walletDeleteOps` drops the marks record — card `create`
    // from this software wallet keeps the walletId and the addresses — while the engine store
    // keeps every tracked row.
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
    // Card import / delete + re-add: the kernel answers mark 0 again.
    mark = 0;
    await expect(prepare(booted, "req-after-import")).rejects.toMatchObject(REFUSAL);
  }, 240_000);
});
