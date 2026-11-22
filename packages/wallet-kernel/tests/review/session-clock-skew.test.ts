/**
 * PoC for finding S-1 (session-clock-skew).
 *
 * Property that should hold: the "60 s post-lock exposure" a hyperliquid-l1-agent signature carries
 * is measured against real time — a device clock running ahead must not stretch it.
 *
 * Current behaviour pinned here: the kernel measures `expiresAfter` and the nonce window against
 * `platform.now()` — the device wall clock. With the clock 23 h ahead of true time T, a sign call
 * whose `nonce` and `expiresAfter` are "now"/"now+60 s" _on that skewed clock_ succeeds, and the
 * resulting signature is live for more than 23 h of real time (Hyperliquid itself accepts nonces up
 * to +1 day of its own time, so it stays submittable).
 *
 * Boundary assertions the scenario needs are already held by tests/session-signing-window.test.ts —
 * cited, not duplicated:
 *
 * - "requires expiresAfter and bounds it to (now, now + 60 s]": `now + 60_000` signs, `now + 60_001`
 *   → invalid-input.
 * - "nonce %s of now → %s" (it.each): `now − 60_000` and `now + 60_000` sign, `now − 60_001` and `now +
 *   60_001` → invalid-input.
 *
 * These assertions pin the buggy behaviour: they pass today and must be revisited by the fix.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { Harness, KernelResponse } from "../harness.ts";
import { createHarness } from "../harness.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSKEY = () => ({
  kind: "passkey" as const,
  credentialId: utf8ToBytes("credential-1"),
  prf: new Uint8Array(32).fill(1),
});
/** "True" time T — the instant the world agrees on; the device clock will run 23 h ahead of it. */
const T0 = Date.parse("2026-06-01T00:00:00Z");
const DAY = 86_400_000;
const SKEW = 23 * 3_600_000;
const SCHEME = "hyperliquid-l1-agent";
const ACTION = {
  type: "order",
  orders: [{ a: 0, b: true, p: "30000", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } }],
  grouping: "na",
};

const ok = (response: KernelResponse): ProtocolValue => {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
};
const field = (value: ProtocolValue, key: string): ProtocolValue => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
};
const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};
const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

const setup = async (
  h: Harness,
  validUntil = T0 + 32 * DAY,
): Promise<{ session: string; address: string }> => {
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: PASSKEY(),
    }),
  );
  const session = strField(res, "session");
  const walletId = strField(field(res, "wallet"), "walletId");
  const created = ok(
    await h.call(
      "sessions.create",
      {
        scheme: SCHEME,
        owner: { walletId, groupIndex: 0 },
        scope: "Mainnet",
        name: "bot-1",
        validUntil,
      },
      session,
    ),
  );
  return { session, address: strField(created, "address") };
};

describe("S-1: the signing window follows the device wall clock", () => {
  it("a 23 h skewed clock still signs nonce=now, expiresAfter=now+60 s — live >23 h of real time", async () => {
    const h = createHarness({ start: T0 });
    const { session, address } = await setup(h);
    /* The device's wall clock runs 23 h ahead of T. Everything below is expressed on that clock —
       as a caller with no better time source would. */
    h.advanceWall(SKEW);
    const deviceNow = h.wallNow();
    expect(deviceNow).toBe(T0 + SKEW);
    const nonce = deviceNow;
    const expiresAfter = deviceNow + 60_000;
    const response = await h.call(
      "sessions.sign",
      { scheme: SCHEME, address, params: { action: ACTION, nonce, expiresAfter } },
      session,
    );
    // The skewed-clock params satisfy every window check — the signature is produced.
    expect(bytesField(ok(response), "signature")).toHaveLength(65);
    // …but measured against true time T the "60 s" expiry is more than 23 h away.
    expect(expiresAfter - T0).toBeGreaterThan(SKEW);
    expect(expiresAfter - T0).toBe(23 * 3_600_000 + 60_000);
    /* The nonce itself is 23 h in Hyperliquid's future — inside its own ±1-day tolerance, so the
       document remains submittable until real time catches the device clock. */
    expect(nonce - T0).toBe(SKEW);
  });
});
