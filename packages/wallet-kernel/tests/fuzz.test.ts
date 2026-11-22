import { describe, expect, it } from "vite-plus/test";

import { METHODS, validate } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { encodeSessionHeader, parseSessionHeader } from "../src/modules/sessions/record.ts";
import { encodeL1Action } from "../src/modules/sessions/schemes/hyperliquid-l1-agent/l1.ts";
import { hyperliquidL1Action } from "../src/modules/sessions/schemes/hyperliquid-l1-agent/params.ts";
import { createHarness, mulberry32 } from "./harness.ts";
import type { KernelResponse } from "./harness.ts";

const METHOD_NAMES = Object.keys(METHODS);

/** Run count; the weekly job raises it via FUZZ_RUNS. */
const RUNS = Number(process.env["FUZZ_RUNS"] ?? "3000");

function randomMalformed(next: () => number): unknown {
  const pick = (n: number) => Math.floor(next() * n);
  // Every generator below produces a structurally invalid request part.
  const malformedScalar = (): unknown => {
    switch (pick(6)) {
      case 0:
        return "not-a-valid-shape";
      case 1:
        return -1.5;
      case 2:
        return { unexpected: true };
      case 3:
        return [1, 2, 3];
      case 4:
        return "x".repeat(3000);
      default:
        return false;
    }
  };

  let method =
    pick(10) === 0 ? "no.such.method" : (METHOD_NAMES[pick(METHOD_NAMES.length)] ?? "status");
  // These three methods accept `params: null` — keep them malformed by construction.
  const nullParamMethods = new Set([
    "status",
    "session.touch",
    "vault.reset",
    "vault.enrolVerification",
    "backup.update",
    "keys.list",
    "nostr.createNip46ClientKey",
    "sessions.list",
  ]);
  const style = pick(8);
  if (nullParamMethods.has(method) && (style === 4 || style === 5 || style === 7)) {
    method = "vault.unlock"; // a method whose null params are malformed
  }

  switch (style) {
    case 0:
      return malformedScalar(); // not even an object
    case 1:
      return { v: pick(2) + 4, id: pick(100), method, params: null }; // bad version
    case 2:
      return { v: 3, id: "nope", method, params: null }; // bad id type
    case 3:
      return { v: 3, id: pick(100), method, params: malformedScalar() };
    case 4:
      return { v: 3, id: pick(100), method, params: null, extra: "field" };
    case 5:
      return { v: 3, id: pick(100), method }; // missing params
    case 6:
      return { v: 3, id: pick(100), method, params: { factor: malformedScalar() } };
    default:
      return { v: 3, id: pick(100), method: "no.such.method", params: null };
  }
}

describe("protocol fuzz", () => {
  it(
    "malformed requests yield integrity errors and the kernel keeps serving",
    { timeout: 60000 * Math.max(1, Math.ceil(RUNS / 3000)) },
    async () => {
      const h = createHarness({ seed: 7 });
      await h.settle();
      const next = mulberry32(0xdeadbeef);
      let checked = 0;
      for (let i = 0; i < RUNS; i++) {
        const malformed = randomMalformed(next);
        // oxlint-disable-next-line eslint/no-await-in-loop -- requests are dispatched sequentially
        const response = await h.sendRaw(malformed);
        expect(response).toHaveProperty("err.code", "integrity");
        checked++;
      }
      expect(checked).toBe(RUNS);
      // Still serving: a well-formed request works after the fuzz barrage.
      const res = await h.call("status");
      expect("ok" in res).toBe(true);
    },
  );
});

/** A random JSON value: scalars, arrays and objects a few levels deep. */
function randomJson(next: () => number, depth = 0): unknown {
  const pick = (n: number) => Math.floor(next() * n);
  switch (pick(depth > 2 ? 6 : 9)) {
    case 0:
      return null;
    case 1:
      return next() < 0.5;
    case 2:
      return Math.floor(next() * 2 ** 53) - 2 ** 52;
    case 3:
      return next() * 1e6;
    case 4:
      return "x".repeat(pick(40));
    case 5:
      return `0x${pick(16).toString(16).repeat(pick(45))}`;
    case 6:
      return ["order", "na", "Mainnet", "vaultTransfer", "Gtc", "session-key"][pick(6)];
    case 7:
      return Array.from({ length: pick(5) }, () => randomJson(next, depth + 1));
    default:
      return Object.fromEntries(
        Array.from({ length: pick(6) }, (_, i) => [
          ["type", "a", "b", "p", "s", "orders", "grouping", "nonce", "agent", `k${i}`][pick(10)] ??
            "k",
          randomJson(next, depth + 1),
        ]),
      );
  }
}

/** Valid action seeds the generator interleaves with random values. */
const ACTION_SEEDS: ReadonlyArray<unknown> = [
  { type: "scheduleCancel" },
  { type: "scheduleCancel", time: 9 },
  { type: "updateLeverage", asset: 0, isCross: true, leverage: 1 },
  { type: "twapCancel", a: 3, t: 42 },
  { type: "cancel", cancels: [{ a: 0, o: 1 }], f: true },
];

/** A seed, a one-field mutation of one, or a fully random value. */
const actionSample = (next: () => number): unknown => {
  const pick = (n: number) => Math.floor(next() * n);
  switch (pick(4)) {
    case 0:
      return ACTION_SEEDS[pick(ACTION_SEEDS.length)];
    case 1: {
      // A seed with one field replaced by a random value — stays valid often enough to keep
      // the encoder path hot, mutates into rejected shapes the rest of the time.
      const seed = { ...(ACTION_SEEDS[pick(ACTION_SEEDS.length)] as Record<string, unknown>) };
      const keys = [...Object.keys(seed), "extra"];
      seed[keys[pick(keys.length)] ?? "extra"] = randomJson(next, 1);
      return seed;
    }
    default:
      return randomJson(next);
  }
};

/** What happened to a random header string: "kernel-error" | "round-trip" | "other". */
const headerOutcome = (raw: string): string => {
  try {
    const parsed = parseSessionHeader(raw);
    const again = parseSessionHeader(encodeSessionHeader(parsed));
    const same =
      parsed.scheme === again.scheme &&
      parsed.walletId === again.walletId &&
      parsed.groupIndex === again.groupIndex &&
      parsed.owner === again.owner &&
      parsed.scope === again.scope &&
      parsed.name === again.name &&
      parsed.validUntil === again.validUntil &&
      parsed.createdAt === again.createdAt;
    return same ? "round-trip" : "other";
  } catch (error) {
    return error instanceof KernelError ? "kernel-error" : "other";
  }
};

/** Digs `res.ok` for a field path; `undefined` on any miss. */
const okField = (res: KernelResponse, ...path: ReadonlyArray<string>): unknown => {
  let value: unknown = "ok" in res ? res.ok : undefined;
  for (const key of path) {
    value =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value;
};

/** "err" | "sig65" | "bad" — a sessions.sign response's shape. */
const signOutcome = (res: KernelResponse): string => {
  if ("err" in res) {
    return "err";
  }
  const signature = okField(res, "signature");
  return signature instanceof Uint8Array && signature.length === 65 ? "sig65" : "bad";
};

/** Every third sample is a near-valid sessions.sign request — it reaches the handler's checks. */
const signParams = (next: () => number, address: string, i: number): unknown =>
  i % 3 === 0
    ? {
        scheme: "hyperliquid-l1-agent",
        address,
        params: { action: randomJson(next, 1), nonce: randomJson(next) },
      }
    : randomJson(next);

describe("sessions parser fuzz", () => {
  it("a validated action always encodes and re-validates identically", { timeout: 60000 }, () => {
    const next = mulberry32(0xc0ffee);
    const parsed = Array.from({ length: RUNS }, () => actionSample(next))
      .map((value) => validate(hyperliquidL1Action, value))
      .filter((value) => value !== undefined);
    for (const action of parsed) {
      // Encoding a validated action is total, and the parsed value is a fixpoint.
      expect(() => encodeL1Action(action)).not.toThrow();
      expect(validate(hyperliquidL1Action, action)).toStrictEqual(action);
    }
    // The generator does produce valid actions — the property is not vacuous.
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("random header strings throw only KernelError or round-trip", { timeout: 60000 }, () => {
    const next = mulberry32(0x5eed);
    for (let i = 0; i < RUNS; i++) {
      expect(headerOutcome(String(randomJson(next)))).not.toBe("other");
    }
  });

  it(
    "random sessions.sign params through the real dispatch yield an error or a 65-byte signature",
    { timeout: 60000 },
    async () => {
      const h = createHarness({ seed: 7 });
      await h.settle();
      const imported = await h.call("wallet.importMnemonic", {
        mnemonic: new TextEncoder().encode(
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        ),
        factor: {
          kind: "passkey",
          credentialId: new TextEncoder().encode("fuzz-credential"),
          prf: new Uint8Array(32).fill(1),
        },
      });
      const session = String(okField(imported, "session"));
      expect(session).toMatch(/^[0-9a-f]{32}$/);
      const walletId = String(okField(imported, "wallet", "walletId"));
      const created = await h.call(
        "sessions.create",
        {
          scheme: "hyperliquid-l1-agent",
          owner: { walletId, groupIndex: 0 },
          scope: "Mainnet",
          name: "fuzz",
          validUntil: h.wallNow() + 86_400_000,
        },
        session,
      );
      const address = String(okField(created, "address"));
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const next = mulberry32(0xf00d);
      for (let i = 0; i < RUNS; i++) {
        const params = signParams(next, address, i);
        // oxlint-disable-next-line eslint/no-await-in-loop -- requests are dispatched sequentially
        const response = await h.sendRaw({
          v: 3,
          id: i + 1,
          method: "sessions.sign",
          session,
          params,
        });
        expect(["err", "sig65"]).toContain(signOutcome(response));
      }
      // Still serving after the barrage.
      const res = await h.call("status");
      expect("ok" in res).toBe(true);
    },
  );
});
