/**
 * The idle lock on a keystore host re-arms only at a successful factor verification: the native
 * policy counts presence (packages/wallet-native/kernel/policy.ts — 15 min idle, activity
 * "presence", 24 h max), but on a host with a platform keystore a `verify` field is the only
 * presence the runtime cannot forge. `session.touch` and every other presence-marked method still
 * re-arm on hosts without a keystore (Web, Node), where the runtime already runs the WebAuthn
 * ceremony — there `session.touch` is the honest presence signal. Without this split a compromised
 * main runtime could call `session.touch` forever and keep an opened hyperliquid session trading up
 * to the 24 h maximum, long after the user went idle.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { FakeKeystore } from "./keystore.ts";
import { fakeSecureInput } from "./secure-input.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSKEY = () => ({
  kind: "passkey" as const,
  credentialId: utf8ToBytes("credential-1"),
  prf: new Uint8Array(32).fill(1),
});
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const T0 = Date.parse("2026-06-01T00:00:00Z");
const DAY = 86_400_000;
const SCHEME = "hyperliquid-l1-agent";

/* The NATIVE_POLICY values (packages/wallet-native/kernel/policy.ts) as harness options. */
const IDLE_MS = 15 * 60_000;
const MAX_SESSION_MS = 24 * 3_600_000;

const LIMITS = {
  notional: "1000",
  maxLeverage: 10,
  assets: [
    { asset: 0, size: "1000" },
    { asset: 1, size: "1000" },
    { asset: 10107, size: "100000" },
  ],
};

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
function errCode(response: KernelResponse): string | undefined {
  return "err" in response ? response.err.code : undefined;
}
function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = (value as Record<string, ProtocolValue>)[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}
const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

const createParams = (walletId: string): Record<string, unknown> => ({
  scheme: SCHEME,
  owner: { walletId, groupIndex: 0 },
  scope: "Mainnet",
  name: "bot-1",
  validUntil: T0 + DAY,
  limits: LIMITS,
  verify: HARDWARE,
});

const sign = async (h: Harness, session: string, address: string): Promise<KernelResponse> =>
  h.call(
    "sessions.sign",
    {
      scheme: SCHEME,
      address,
      params: {
        action: {
          type: "order",
          orders: [{ a: 0, b: true, p: "100", s: "1", r: false, t: { limit: { tif: "Gtc" } } }],
          grouping: "na",
        },
        nonce: T0,
        expiresAfter: T0 + 60_000,
      },
    },
    session,
  );

/** Android keystore host: app lock on, one opened hyperliquid session, 15-minute idle lock. */
const boot = async (): Promise<{
  h: Harness;
  fk: FakeKeystore;
  session: string;
  address: string;
}> => {
  const fk = fakeKeystore("en-US", "android");
  const input = fakeSecureInput({ approval: "correct" });
  const h = createHarness({
    keystore: fk.keystore,
    secureInput: input.secureInput,
    start: T0,
    idleMs: IDLE_MS,
    maxSessionMs: MAX_SESSION_MS,
    activity: "presence",
  });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  const session = strField(res, "session");
  const walletId = strField(field(res, "wallet"), "walletId");
  ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
  const created = ok(await h.call("sessions.create", createParams(walletId), session));
  return { h, fk, session, address: strField(created, "address") };
};

/** Web host (no keystore): one opened hyperliquid session, same idle values. */
const bootWeb = async (): Promise<{ h: Harness; session: string; address: string }> => {
  const h = createHarness({
    start: T0,
    idleMs: IDLE_MS,
    maxSessionMs: MAX_SESSION_MS,
    activity: "presence",
  });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: PASSKEY() }),
  );
  const session = strField(res, "session");
  const walletId = strField(field(res, "wallet"), "walletId");
  const created = ok(
    await h.call("sessions.create", { ...createParams(walletId), verify: PASSKEY() }, session),
  );
  return { h, session, address: strField(created, "address") };
};

describe("the idle lock on a keystore host", () => {
  it("locks 15 minutes after the last verification no matter how often the runtime touches", async () => {
    const { h, session, address } = await boot();
    /* The deadline armed by the sessions.create verification is t+15 min: the first touch lands
       inside it, and every later one already finds a locked vault — the runtime cannot keep it
       alive. */
    h.advance(14 * 60_000);
    expect(ok(await h.call("session.touch", null, session))).toBeNull();
    for (let i = 0; i < 4; i++) {
      h.advance(14 * 60_000);
      // oxlint-disable-next-line no-await-in-loop -- touches are sequential wall-clock steps
      expect(errCode(await h.call("session.touch", null, session))).toBe("locked");
    }
    expect(errCode(await sign(h, session, address))).toBe("locked");
  });

  it("control: without touches the same sign is locked after 16 idle minutes", async () => {
    const { h, session, address } = await boot();
    h.advance(IDLE_MS + 60_000);
    expect(errCode(await sign(h, session, address))).toBe("locked");
  });

  it("a successful factor verification re-arms the deadline", async () => {
    const { h, session, address } = await boot();
    h.advance(14 * 60_000);
    ok(await h.call("sessions.open", { address, verify: HARDWARE }, session));
    /* Re-armed at t=14 min: a signature at t=28 still leaves, then the vault locks at t=29. */
    h.advance(14 * 60_000);
    const signature = ok(await sign(h, session, address));
    expect(field(signature, "signature")).toBeInstanceOf(Uint8Array);
    h.advance(16 * 60_000);
    expect(errCode(await sign(h, session, address))).toBe("locked");
  });

  it("a failed verification does not re-arm the deadline", async () => {
    const { h, fk, session, address } = await boot();
    h.advance(14 * 60_000);
    fk.fail("cancelled");
    expect(errCode(await h.call("sessions.open", { address, verify: HARDWARE }, session))).toBe(
      "cancelled",
    );
    h.advance(2 * 60_000);
    expect(errCode(await sign(h, session, address))).toBe("locked");
  });
});

describe("the idle lock without a keystore", () => {
  it("a presence-marked method still re-arms the deadline", async () => {
    const { h, session, address } = await bootWeb();
    for (let i = 0; i < 5; i++) {
      h.advance(14 * 60_000);
      // oxlint-disable-next-line no-await-in-loop -- touches are sequential wall-clock steps
      expect(ok(await h.call("session.touch", null, session))).toBeNull();
    }
    const signature = ok(await sign(h, session, address));
    expect(field(signature, "signature")).toBeInstanceOf(Uint8Array);
  });
});
