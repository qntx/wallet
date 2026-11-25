/**
 * Review PoC: the native idle lock counts only `presence`-marked methods
 * (packages/wallet-native/kernel/policy.ts — 15 min idle, activity "presence", 24 h max), and
 * `session.touch` is presence-marked while doing nothing but `ctx.session.require`
 * (packages/wallet/src/protocol/core.ts:467, packages/wallet-kernel/src/commands/index.ts:18).
 * The main runtime may therefore call `session.touch` at will: a compromised main runtime keeps
 * the vault — and a Hyperliquid session's in-memory opened mark — alive past the idle lock, up to
 * the 24 h maximum, so `sessions.sign` still trades long after the user went idle. These tests
 * assert today's faulty behaviour so they pass on the current tree and fail once idle activity
 * requires genuine presence.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "../harness.ts";
import type { Harness, KernelResponse } from "../harness.ts";
import { fakeKeystore } from "../keystore.ts";
import { fakeSecureInput } from "../secure-input.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
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

const sign = (h: Harness, session: string, address: string): Promise<KernelResponse> =>
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
const boot = async (): Promise<{ h: Harness; session: string; address: string }> => {
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
  return { h, session, address: strField(created, "address") };
};

describe("session.touch holds the idle lock open for a hyperliquid session", () => {
  it("five runtime-driven touches keep sign working 70 minutes after the last real presence", async () => {
    const { h, session, address } = await boot();
    for (let i = 0; i < 5; i++) {
      h.advance(14 * 60_000);
      // oxlint-disable-next-line no-await-in-loop -- touches are sequential wall-clock steps
      expect(ok(await h.call("session.touch", null, session))).toBeNull();
    }
    /* 70 min of monotonic idle, zero user presence — yet the vault never locked and the session
       still carries its opened mark: the signature leaves without any approval. */
    const signature = ok(await sign(h, session, address));
    expect(field(signature, "signature")).toBeInstanceOf(Uint8Array);
  });

  it("control: without touches the same sign is locked after 16 idle minutes", async () => {
    const { h, session, address } = await boot();
    h.advance(IDLE_MS + 60_000);
    expect(errCode(await sign(h, session, address))).toBe("locked");
  });
});
