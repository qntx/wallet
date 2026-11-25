/**
 * The value-moving session gate (F-02): `hyperliquid-l1-agent` declares metering, so the kernel
 * binds it to approved limits — create/open verify a factor against the scheme's approval prompt,
 * sign answers `approval-required` until the session is opened in this kernel's memory, every
 * charged action's notional accumulates into the record's `spent` (committed before the signature
 * leaves), and on a keystore host whose vault still carries a `device` factor every one of those
 * operations answers `app-lock-required`.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { encodeSessionHeader, SESSION_KIND } from "../src/modules/sessions/record.ts";
import type { SessionHeader } from "../src/modules/sessions/record.ts";
import { meterHyperliquid } from "../src/modules/sessions/schemes/hyperliquid-l1-agent/meter.ts";
import { hyperliquidL1Spent } from "../src/modules/sessions/schemes/hyperliquid-l1-agent/params.ts";
import { hyperliquidApproval } from "../src/modules/sessions/schemes/hyperliquid-l1-agent/prompt.ts";
import { openSession, signSession } from "../src/modules/sessions/sessions.ts";
import type { KeystorePrompt } from "../src/platform.ts";
import { promptFits, PROMPT_BOUNDS } from "../src/prompts.ts";
import { Secret } from "../src/secret/secret.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import type { RecordStore, StoreOp, VaultImage } from "../src/vault/store.ts";
import { sealRecord } from "../src/vault/vault.ts";
import { createHarness, seededRandom } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";
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
const LIMITS = {
  notional: "1000",
  maxLeverage: 10,
  assets: [
    { asset: 0, size: "1000" },
    { asset: 1, size: "1000" },
    { asset: 10107, size: "100000" },
  ],
};
const FRESH_SPENT = { notional: "0", size: ["0", "0", "0"] };

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
  const v = value[key];
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

const prompts = (calls: ReadonlyArray<KeystoreCall>): KeystorePrompt[] =>
  calls.flatMap((call) =>
    call.op === "open" && call.protection === "presence" && call.prompt !== undefined
      ? [call.prompt]
      : [],
  );

/** A web harness (no keystore) with one password-verified wallet — PASSKEY verifies. */
async function webSetup() {
  const h = createHarness({ start: T0 });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: PASSKEY(),
    }),
  );
  return {
    h,
    session: strField(res, "session"),
    walletId: strField(field(res, "wallet"), "walletId"),
  };
}

const createParams = (
  walletId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> => ({
  scheme: SCHEME,
  owner: { walletId, groupIndex: 0 },
  scope: "Mainnet",
  name: "bot-1",
  validUntil: T0 + DAY,
  limits: LIMITS,
  verify: PASSKEY(),
  ...extra,
});

const order = (p: string, s: string, extra?: Record<string, unknown>) => ({
  a: 0,
  b: true,
  p,
  s,
  r: false,
  t: { limit: { tif: "Gtc" as const } },
  ...extra,
});

/** A store whose commits fail while `fail.on` — the flag lives outside so the stub stays dumb. */
const flakyStore = (inner: RecordStore, fail: { on: boolean }): RecordStore => ({
  load: async () => inner.load(),
  watch: (l) => inner.watch(l),
  commit: async (ops: ReadonlyArray<StoreOp>) => {
    if (fail.on) {
      throw new Error("disk full");
    }
    return inner.commit(ops);
  },
});

const codeOf = (res: KernelResponse): string => ("err" in res ? res.err.code : "ok");

const isPresenceCall = (c: KeystoreCall): boolean =>
  "protection" in c && c.protection === "presence";

const sign = async (
  h: Harness,
  session: string,
  address: string,
  action: Record<string, unknown>,
): Promise<KernelResponse> =>
  h.call(
    "sessions.sign",
    { scheme: SCHEME, address, params: { action, nonce: T0, expiresAfter: T0 + 15_000 } },
    session,
  );

const create = async (
  w: { h: Harness; session: string },
  params: Record<string, unknown>,
): Promise<ProtocolValue> => w.h.call("sessions.create", params, w.session).then((res) => ok(res));

const spentOf = async (
  h: Harness,
  session: string,
): Promise<{ notional: string; size: ReadonlyArray<string> }> => {
  const list = ok(await h.call("sessions.list", null, session)) as ReadonlyArray<
    Record<string, unknown>
  >;
  return list[0]?.["spent"] as { notional: string; size: ReadonlyArray<string> };
};

describe("app-lock gate", () => {
  it("a device-factor vault answers app-lock-required on create, open and sign", async () => {
    const fk = fakeKeystore();
    const input = fakeSecureInput({ approval: "correct" });
    const h = createHarness({ keystore: fk.keystore, secureInput: input.secureInput, start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: DEVICE,
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    /* Enable the lock long enough to mint a session, then switch it back off. */
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    const created = ok(
      await h.call("sessions.create", createParams(walletId, { verify: HARDWARE }), session),
    );
    const address = strField(created, "address");
    ok(await h.call("vault.setAppLock", { enabled: false, verify: HARDWARE }, session));
    const before = fk.calls.length;

    expect(
      errCode(
        await h.call("sessions.create", createParams(walletId, { verify: HARDWARE }), session),
      ),
    ).toBe("app-lock-required");
    expect(errCode(await h.call("sessions.open", { address, verify: HARDWARE }, session))).toBe(
      "app-lock-required",
    );
    expect(errCode(await sign(h, session, address, { type: "twapCancel", a: 0, t: 1 }))).toBe(
      "app-lock-required",
    );
    /* Nothing reached the keystore: the refusal happens before any verification prompt. */
    expect(fk.calls.slice(before).filter(isPresenceCall)).toHaveLength(0);

    /* Relaunch over the same store: a fresh kernel answers the same way. */
    const h2 = createHarness({
      keystore: fk.keystore,
      start: T0,
      store: h.store,
      anchor: h.anchor,
    });
    await h2.settle();
    const session2 = strField(ok(await h2.call("vault.unlock", { factor: DEVICE })), "session");
    expect(
      errCode(
        await h2.call("sessions.create", createParams(walletId, { verify: HARDWARE }), session2),
      ),
    ).toBe("app-lock-required");
    expect(errCode(await h2.call("sessions.open", { address, verify: HARDWARE }, session2))).toBe(
      "app-lock-required",
    );
    expect(errCode(await sign(h2, session2, address, { type: "twapCancel", a: 0, t: 1 }))).toBe(
      "app-lock-required",
    );
  });
});

describe("approval ceremony", () => {
  it("create shows the limits prompt and the new session signs immediately", async () => {
    const fk = fakeKeystore();
    const input = fakeSecureInput({ approval: "correct" });
    const h = createHarness({ keystore: fk.keystore, secureInput: input.secureInput, start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: DEVICE,
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    const before = fk.calls.length;
    const created = ok(
      await h.call("sessions.create", createParams(walletId, { verify: HARDWARE }), session),
    );
    const address = strField(created, "address");
    const shown = prompts(fk.calls.slice(before));
    expect(shown).toStrictEqual([
      hyperliquidApproval(
        {
          scope: "Mainnet",
          name: "bot-1",
          validUntil: T0 + DAY,
          limits: LIMITS,
          spent: FRESH_SPENT,
        },
        false,
        "en",
      ),
    ]);
    /* Born under an approval prompt: the session is opened and signs without a reopen. */
    const signature = ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("100", "1")],
        grouping: "na",
      }),
    );
    expect(field(signature, "signature")).toBeInstanceOf(Uint8Array);
  });

  it("create refuses limits whose reopen prompt overflows only at the worst-case spent", async () => {
    const fk = fakeKeystore();
    const input = fakeSecureInput({ approval: "correct" });
    const h = createHarness({ keystore: fk.keystore, secureInput: input.secureInput, start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: DEVICE,
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));

    /* The create variant and the fresh-spent reopen variant fit iOS (388 chars); only the
       worst-case remaining — the notional minus the smallest charge, 17 digits longer — pushes
       the reopen rendering to 405. Create must look at the worst case, not the fresh one. */
    const tight = {
      notional: "999999999999999",
      maxLeverage: 10,
      assets: Array.from({ length: 10 }, (_, i) => ({ asset: i, size: "1000" })),
    };
    const before = fk.calls.length;
    expect(
      errCode(
        await h.call(
          "sessions.create",
          createParams(walletId, { limits: tight, verify: HARDWARE }),
          session,
        ),
      ),
    ).toBe("invalid-input");
    // Refused before the verification prompt.
    expect(fk.calls.slice(before).filter(isPresenceCall)).toHaveLength(0);

    // One fewer asset fits the worst case too — that session is created.
    const loose = { ...tight, assets: tight.assets.slice(0, 9) };
    ok(
      await h.call(
        "sessions.create",
        createParams(walletId, { limits: loose, verify: HARDWARE }),
        session,
      ),
    );
  });

  it("after lock+unlock sign answers approval-required until sessions.open verifies", async () => {
    const fk = fakeKeystore();
    const input = fakeSecureInput({ approval: "correct" });
    const h = createHarness({ keystore: fk.keystore, secureInput: input.secureInput, start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: DEVICE,
      }),
    );
    let session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    const created = ok(
      await h.call("sessions.create", createParams(walletId, { verify: HARDWARE }), session),
    );
    const address = strField(created, "address");

    /* The idle lock clears the opened mark — the next signature must re-approve. */
    h.advance(15 * 60_000 + 1);
    await h.settle();
    session = strField(ok(await h.call("vault.unlock", { factor: HARDWARE })), "session");
    expect(errCode(await sign(h, session, address, { type: "twapCancel", a: 0, t: 1 }))).toBe(
      "approval-required",
    );

    /* The reopen shows the same approval text plus the remaining budget. */
    const before = fk.calls.length;
    ok(await h.call("sessions.open", { address, verify: HARDWARE }, session));
    expect(
      prompts(fk.calls.slice(before))
        .map((p) => p.description)
        .join("\n"),
    ).toContain("Remaining buy budget: 1000");
    const signature = ok(await sign(h, session, address, { type: "twapCancel", a: 0, t: 1 }));
    expect(field(signature, "signature")).toBeInstanceOf(Uint8Array);
  });

  it("deleting one session keeps the others' opened marks", async () => {
    const w = await webSetup();
    const first = strField(await create(w, createParams(w.walletId)), "address");
    const second = strField(
      await create(w, createParams(w.walletId, { name: "bot-2" })),
      "address",
    );
    ok(await sign(w.h, w.session, first, { type: "twapCancel", a: 0, t: 1 }));
    ok(await sign(w.h, w.session, second, { type: "twapCancel", a: 0, t: 1 }));
    /* The delete commits a removal; reconcile forgets only that record's mark. */
    ok(await w.h.call("sessions.delete", { address: first }, w.session));
    expect(errCode(await sign(w.h, w.session, first, { type: "twapCancel", a: 0, t: 1 }))).toBe(
      "not-found",
    );
    ok(await sign(w.h, w.session, second, { type: "twapCancel", a: 0, t: 1 }));
  });

  it("on the web the opened mark is lost on relaunch — open verifies, then sign works", async () => {
    const first = await webSetup();
    const created = await create(first, createParams(first.walletId));
    const address = strField(created, "address");
    ok(await sign(first.h, first.session, address, { type: "twapCancel", a: 0, t: 1 }));

    const second = createHarness({
      start: T0,
      store: first.h.store,
      anchor: first.h.anchor,
    });
    await second.settle();
    const session = strField(
      ok(await second.call("vault.unlock", { factor: PASSKEY() })),
      "session",
    );
    expect(errCode(await sign(second, session, address, { type: "twapCancel", a: 0, t: 1 }))).toBe(
      "approval-required",
    );
    ok(await second.call("sessions.open", { address, verify: PASSKEY() }, session));
    expect(
      errCode(await sign(second, session, address, { type: "twapCancel", a: 0, t: 1 })),
    ).toBeUndefined();
  });
});

const seeded = async (
  limits: Record<string, unknown>,
): Promise<{ h: Harness; session: string; address: string }> => {
  const { h, session, walletId } = await webSetup();
  const created = ok(await h.call("sessions.create", createParams(walletId, { limits }), session));
  return { h, session, address: strField(created, "address") };
};

describe("metering", () => {
  it("charges orders at the exact boundary, refuses the smallest unit over", async () => {
    const { h, session, address } = await seeded({ ...LIMITS, notional: "2" });
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("1", "1.99999999")],
        grouping: "na",
      }),
    );
    /* A buy charges the notional budget and its asset's size meter alike. */
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "1.99999999",
      size: ["1.99999999", "0", "0"],
    });
    /* spent + charge == budget still signs. */
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("1", "0.00000001")],
        grouping: "na",
      }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "2",
      size: ["2", "0", "0"],
    });
    /* One smallest unit (1e-16 of notional) past the budget refuses. */
    expect(
      errCode(
        await sign(h, session, address, {
          type: "order",
          orders: [order("0.00000001", "0.00000001")],
          grouping: "na",
        }),
      ),
    ).toBe("limit-exceeded");
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "2",
      size: ["2", "0", "0"],
    });
  });

  it("a sell within size charges size only — the notional meter stays untouched", async () => {
    const { h, session, address } = await seeded({ ...LIMITS, notional: "2" });
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("1", "0.5", { b: false })],
        grouping: "na",
      }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "0",
      size: ["0.5", "0", "0"],
    });
    /* A reduce-only sell charges size the same way — the flag buys no exemption. */
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("1", "0.25", { b: false, r: true })],
        grouping: "na",
      }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "0",
      size: ["0.75", "0", "0"],
    });
  });

  it("a trigger order is charged at max(p, triggerPx)", async () => {
    const { h, session, address } = await seeded({ ...LIMITS, notional: "5" });
    const triggerOrder = {
      a: 0,
      b: true,
      p: "1",
      s: "1",
      r: false,
      t: { trigger: { isMarket: true, triggerPx: "5", tpsl: "tp" } },
    };
    ok(await sign(h, session, address, { type: "order", orders: [triggerOrder], grouping: "na" }));
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "5",
      size: ["1", "0", "0"],
    });
    expect(
      errCode(
        await sign(h, session, address, {
          type: "order",
          orders: [order("1", "1")],
          grouping: "na",
        }),
      ),
    ).toBe("limit-exceeded");
  });

  it("reduce-only orders are charged, modify and batchModify charge the replacement", async () => {
    const { h, session, address } = await seeded({ ...LIMITS, notional: "10" });
    /* buys charge notional and size; the modify family charges size on the replacement too. */
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("2", "1", { r: true })],
        grouping: "na",
      }),
    );
    ok(
      await sign(h, session, address, {
        type: "modify",
        oid: 1,
        order: order("3", "1"),
      }),
    );
    ok(
      await sign(h, session, address, {
        type: "batchModify",
        modifies: [
          { oid: 1, order: order("2", "1") },
          { oid: 2, order: order("3", "1") },
        ],
      }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "10",
      size: ["4", "0", "0"],
    });
  });

  it("batchModify charges size per order and an off-list modify refuses", async () => {
    const { h, session, address } = await seeded({ ...LIMITS, assets: LIMITS.assets.slice(0, 1) });
    expect(
      errCode(
        await sign(h, session, address, {
          type: "batchModify",
          modifies: [
            { oid: 1, order: order("2", "1") },
            { oid: 2, order: order("3", "1", { a: 1 }) },
          ],
        }),
      ),
    ).toBe("limit-exceeded");
    /* A sell modify charges size without touching the buy budget. */
    ok(
      await sign(h, session, address, {
        type: "modify",
        oid: 1,
        order: order("1000", "0.5", { b: false }),
      }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "0",
      size: ["0.5"],
    });
  });

  it("cancels are free but restricted to the allow-list", async () => {
    const { h, session, address } = await seeded({
      ...LIMITS,
      assets: [{ asset: 0, size: "1" }],
      notional: "1",
    });
    /* A cancel on an asset the session never approved could strip the user's protection on
       positions outside its scope — every cancel kind answers limit-exceeded. */
    const offList: ReadonlyArray<Record<string, unknown>> = [
      { type: "cancel", cancels: [{ a: 999, o: 1 }] },
      {
        type: "cancelByCloid",
        cancels: [{ asset: 999, cloid: `0x${"ab".repeat(16)}` }],
      },
      { type: "twapCancel", a: 999, t: 1 },
    ];
    for (const action of offList) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential kernel calls.
      expect(errCode(await sign(h, session, address, action))).toBe("limit-exceeded");
    }
    const free: ReadonlyArray<Record<string, unknown>> = [
      { type: "cancel", cancels: [{ a: 0, o: 1 }] },
      {
        type: "cancelByCloid",
        cancels: [{ asset: 0, cloid: `0x${"ab".repeat(16)}` }],
      },
      { type: "twapCancel", a: 0, t: 1 },
    ];
    for (const action of free) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential kernel calls.
      ok(await sign(h, session, address, action));
    }
    await expect(spentOf(h, session)).resolves.toStrictEqual({ notional: "0", size: ["0"] });
  });

  it("scheduleCancel is not admitted — it cancels every open order on every asset", async () => {
    const { h, session, address } = await seeded(LIMITS);
    for (const action of [
      { type: "scheduleCancel" },
      { type: "scheduleCancel", time: T0 + 10_000 },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential kernel calls.
      expect(errCode(await sign(h, session, address, action))).toBe("invalid-input");
    }
  });

  it("updateLeverage respects the cap and both account actions the allow-list", async () => {
    const { h, session, address } = await seeded({
      ...LIMITS,
      maxLeverage: 5,
      assets: [{ asset: 0, size: "1" }],
    });
    expect(
      errCode(
        await sign(h, session, address, {
          type: "updateLeverage",
          asset: 0,
          isCross: true,
          leverage: 6,
        }),
      ),
    ).toBe("limit-exceeded");
    expect(
      errCode(
        await sign(h, session, address, {
          type: "updateLeverage",
          asset: 9,
          isCross: true,
          leverage: 1,
        }),
      ),
    ).toBe("limit-exceeded");
    expect(
      errCode(
        await sign(h, session, address, {
          type: "updateIsolatedMargin",
          asset: 9,
          isBuy: true,
          ntli: 1,
        }),
      ),
    ).toBe("limit-exceeded");
    ok(
      await sign(h, session, address, {
        type: "updateLeverage",
        asset: 0,
        isCross: false,
        leverage: 5,
      }),
    );
    ok(
      await sign(h, session, address, {
        type: "updateIsolatedMargin",
        asset: 0,
        isBuy: true,
        ntli: -100,
      }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({ notional: "0", size: ["0"] });
  });

  it("orders outside the allow-list and twapOrder refuse", async () => {
    const { h, session, address } = await seeded({ ...LIMITS, assets: [{ asset: 0, size: "1" }] });
    expect(
      errCode(
        await sign(h, session, address, {
          type: "order",
          orders: [order("1", "1", { a: 1 })],
          grouping: "na",
        }),
      ),
    ).toBe("limit-exceeded");
    expect(
      errCode(
        await sign(h, session, address, {
          type: "twapOrder",
          twap: { a: 0, b: true, s: "1", r: false, m: 30, t: false },
        }),
      ),
    ).toBe("invalid-input");
    await expect(spentOf(h, session)).resolves.toStrictEqual({ notional: "0", size: ["0"] });
  });

  it("size meters are per asset — charging one asset spends none of another's cap", async () => {
    const { h, session, address } = await seeded({
      ...LIMITS,
      assets: [
        { asset: 0, size: "1" },
        { asset: 1, size: "0.00000001" },
      ],
    });
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("0.00000001", "1")],
        grouping: "na",
      }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "0.00000001",
      size: ["1", "0"],
    });
    /* Asset 1's own cap is intact until an order on asset 1 runs. */
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("1", "0.00000001", { a: 1, b: false })],
        grouping: "na",
      }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "0.00000001",
      size: ["1", "0.00000001"],
    });
    /* One smallest unit past either cap refuses — notional or size alike. */
    expect(
      errCode(
        await sign(h, session, address, {
          type: "order",
          orders: [order("1", "0.00000001", { a: 1 })],
          grouping: "na",
        }),
      ),
    ).toBe("limit-exceeded");
  });

  it("the asset cap refuses at cap plus one 1e-16 unit", () => {
    /* Order sizes admit eight decimals, but the record's `canonical` spent grammar keeps
       sixteen: a charged total can sit exactly one unit over the cap, and only the strict `>`
       comparison refuses it. */
    const limits = { notional: "1000", maxLeverage: 10, assets: [{ asset: 0, size: "1" }] };
    const spent = { notional: "0", size: ["0.9999999900000001"] };
    expect(() =>
      meterHyperliquid(
        {
          action: {
            type: "order",
            orders: [order("1", "0.00000001", { b: false })],
            grouping: "na",
          },
          nonce: 0,
          expiresAfter: T0,
        },
        limits,
        spent,
      ),
    ).toThrow("the asset's size budget is exhausted");
  });

  it("the asset cap is exact — size equal to the cap charges, one unit over refuses", async () => {
    const { h, session, address } = await seeded({
      ...LIMITS,
      assets: [
        { asset: 0, size: "0.00000001" },
        { asset: 1, size: "0.00000001" },
      ],
    });
    // The cap itself is a legal charge.
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("1", "0.00000001")],
        grouping: "na",
      }),
    );
    // One smallest unit past the untouched sibling's cap is not.
    expect(
      errCode(
        await sign(h, session, address, {
          type: "order",
          orders: [order("1", "0.00000002", { a: 1 })],
          grouping: "na",
        }),
      ),
    ).toBe("limit-exceeded");
  });

  it("spent survives a relaunch over the same store", async () => {
    const { h, session, address } = await seeded({ ...LIMITS, notional: "10" });
    ok(
      await sign(h, session, address, { type: "order", orders: [order("4", "1")], grouping: "na" }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "4",
      size: ["1", "0", "0"],
    });

    const second = createHarness({ start: T0, store: h.store, anchor: h.anchor });
    await second.settle();
    const session2 = strField(
      ok(await second.call("vault.unlock", { factor: PASSKEY() })),
      "session",
    );
    await expect(spentOf(second, session2)).resolves.toStrictEqual({
      notional: "4",
      size: ["1", "0", "0"],
    });
    ok(await second.call("sessions.open", { address, verify: PASSKEY() }, session2));
    ok(
      await sign(second, session2, address, {
        type: "order",
        orders: [order("4", "1")],
        grouping: "na",
      }),
    );
    await expect(spentOf(second, session2)).resolves.toStrictEqual({
      notional: "8",
      size: ["2", "0", "0"],
    });
  });

  it("a failed commit returns no signature and leaves spent untouched", async () => {
    const inner = createMemoryStore();
    const fail = { on: false };
    const flaky = flakyStore(inner, fail);
    const h = createHarness({ start: T0, store: flaky });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: PASSKEY(),
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    const created = ok(await h.call("sessions.create", createParams(walletId), session));
    const address = strField(created, "address");

    fail.on = true;
    const refused = await sign(h, session, address, {
      type: "order",
      orders: [order("1", "1")],
      grouping: "na",
    });
    expect(errCode(refused)).toBe("unavailable");
    expect("ok" in refused).toBe(false);
    fail.on = false;
    await expect(spentOf(h, session)).resolves.toStrictEqual(FRESH_SPENT);
    /* And the session still signs once the store heals — the charge lands exactly once. */
    ok(
      await sign(h, session, address, { type: "order", orders: [order("1", "1")], grouping: "na" }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({
      notional: "1",
      size: ["1", "0", "0"],
    });
  });
});

describe("limits validation at create", () => {
  const entry = (asset: number, size = "1") => ({ asset, size });

  it.each([
    ["missing", null],
    ["notional zero", { ...LIMITS, notional: "0" }],
    ["notional noncanonical", { ...LIMITS, notional: "01" }],
    ["notional too large", { ...LIMITS, notional: "1000000000000000.1" }],
    ["maxLeverage 0", { ...LIMITS, maxLeverage: 0 }],
    ["maxLeverage 101", { ...LIMITS, maxLeverage: 101 }],
    ["assets empty", { ...LIMITS, assets: [] }],
    [
      "assets 17",
      { ...LIMITS, assets: Array.from({ length: 17 }, (_, i) => ({ asset: i, size: "1" })) },
    ],
    ["assets unsorted", { ...LIMITS, assets: [entry(1), entry(0)] }],
    ["assets duplicated", { ...LIMITS, assets: [entry(0), entry(0)] }],
    ["assets builder-dex id", { ...LIMITS, assets: [entry(100_000)] }],
    ["size missing", { ...LIMITS, assets: [{ asset: 0 }] }],
    ["size zero", { ...LIMITS, assets: [entry(0, "0")] }],
    ["size noncanonical", { ...LIMITS, assets: [entry(0, "01")] }],
    ["entry extra key", { ...LIMITS, assets: [{ ...entry(0), memo: "x" }] }],
  ])("%s answers invalid-input", async (_name, limits) => {
    const { h, session, walletId } = await webSetup();
    expect(
      errCode(await h.call("sessions.create", createParams(walletId, { limits }), session)),
    ).toBe("invalid-input");
  });
});

describe("approval prompt bounds", () => {
  /* The longest grammar admits: sixteen five-digit spot ids at the largest size, a ~1e15 budget,
     and the spent whose remaining renders longest. */
  const worstLimits = {
    notional: "999999999999999.99999999",
    maxLeverage: 100,
    assets: Array.from({ length: 16 }, (_, i) => ({
      asset: 99_983 + i,
      size: "999999999999999.99999999",
    })),
  };
  const worstSpent = {
    notional: "0.0000000000000001",
    size: worstLimits.assets.map(() => "0"),
  };
  const worst = {
    scope: "Mainnet",
    name: "1234567890123456",
    validUntil: Date.parse("2099-12-31T00:00:00Z"),
    limits: worstLimits,
  };

  it("a typical three-asset session fits both platforms and locales", () => {
    for (const open of [false, true]) {
      for (const locale of ["en", "zh-Hans"] as const) {
        for (const platform of ["ios", "android"] as const) {
          const prompt = hyperliquidApproval(
            {
              scope: "Mainnet",
              name: "bot-1",
              validUntil: T0 + DAY,
              limits: LIMITS,
              /* The open variant renders the longest remaining at this spent; the create
                 variant ignores it. */
              spent: { notional: "0.0000000000000001", size: ["0", "0", "0"] },
            },
            open,
            locale,
          );
          expect(promptFits(prompt, PROMPT_BOUNDS[platform])).toBe(true);
        }
      }
    }
  });

  it("the sixteen-asset worst case fits no platform", () => {
    for (const open of [false, true]) {
      for (const locale of ["en", "zh-Hans"] as const) {
        for (const platform of ["ios", "android"] as const) {
          const prompt = hyperliquidApproval({ ...worst, spent: worstSpent }, open, locale);
          expect(promptFits(prompt, PROMPT_BOUNDS[platform])).toBe(false);
        }
      }
    }
  });

  it("asset ids render as #id, split perp/spot at id 10000", () => {
    const session = {
      scope: "Mainnet",
      name: "bot-1",
      validUntil: T0 + DAY,
      limits: {
        ...LIMITS,
        /* The first spot id is exactly 10000 — it must land on the spot line, never perp. */
        assets: [
          { asset: 0, size: "10" },
          { asset: 159, size: "1000000" },
          { asset: 10_000, size: "5" },
          { asset: 10_107, size: "100000" },
        ],
      },
      spent: { notional: "0", size: ["0", "0", "0", "0"] },
    };
    const en = hyperliquidApproval(session, false, "en").description;
    expect(en).toContain("Max size, buys and sells — perp: #0 ≤ 10, #159 ≤ 1000000");
    expect(en).toContain("Max size, buys and sells — spot: #10000 ≤ 5, #10107 ≤ 100000");
    const zh = hyperliquidApproval(session, false, "zh-Hans").description;
    expect(zh).toContain("最大数量，买与卖——永续：#0 ≤ 10, #159 ≤ 1000000");
    expect(zh).toContain("最大数量，买与卖——现货：#10000 ≤ 5, #10107 ≤ 100000");
  });

  it("the prompt text is pinned", () => {
    const session = {
      scope: "Mainnet",
      name: "bot-1",
      validUntil: T0 + DAY,
      limits: LIMITS,
      spent: { notional: "250.5", size: ["1", "0", "0"] },
    };
    expect(hyperliquidApproval(session, false, "en").description).toBe(
      `Hyperliquid trading agent "bot-1" on Mainnet\n` +
        `Valid until 2026-06-02\n` +
        `Buy budget: 1000 (sum of price × size of buys, quote currency)\n` +
        `Max leverage: 10x\n` +
        `Max size, buys and sells — perp: #0 ≤ 1000, #1 ≤ 1000\n` +
        `Max size, buys and sells — spot: #10107 ≤ 100000\n` +
        `Sells may fill at any price the exchange accepts`,
    );
    expect(hyperliquidApproval(session, true, "en").description).toBe(
      `Hyperliquid trading agent "bot-1" on Mainnet\n` +
        `Valid until 2026-06-02\n` +
        `Buy budget: 1000 (sum of price × size of buys, quote currency)\n` +
        `Max leverage: 10x\n` +
        `Max size, buys and sells — perp: #0 ≤ 1000, #1 ≤ 1000\n` +
        `Max size, buys and sells — spot: #10107 ≤ 100000\n` +
        `Sells may fill at any price the exchange accepts\n` +
        `Remaining buy budget: 749.5`,
    );
    expect(hyperliquidApproval(session, false, "zh-Hans").description).toBe(
      `Hyperliquid 交易代理 "bot-1"（Mainnet）\n` +
        `有效期至 2026-06-02\n` +
        `买入预算：1000（买单价格 × 数量之和，按各市场报价币计）\n` +
        `最大杠杆：10x\n` +
        `最大数量，买与卖——永续：#0 ≤ 1000, #1 ≤ 1000\n` +
        `最大数量，买与卖——现货：#10107 ≤ 100000\n` +
        `卖单可按交易所接受的任意价格成交`,
    );
    expect(hyperliquidApproval(session, true, "zh-Hans").description).toBe(
      `Hyperliquid 交易代理 "bot-1"（Mainnet）\n` +
        `有效期至 2026-06-02\n` +
        `买入预算：1000（买单价格 × 数量之和，按各市场报价币计）\n` +
        `最大杠杆：10x\n` +
        `最大数量，买与卖——永续：#0 ≤ 1000, #1 ≤ 1000\n` +
        `最大数量，买与卖——现货：#10107 ≤ 100000\n` +
        `卖单可按交易所接受的任意价格成交\n` +
        `剩余买入预算：749.5`,
    );
  });

  it.each(["ios", "android"] as const)(
    "create on %s refuses limits the dialog cannot show",
    async (platform) => {
      const fk = fakeKeystore("en-US", platform);
      const h = createHarness({ keystore: fk.keystore, start: T0 });
      await h.settle();
      const res = ok(
        await h.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(MNEMONIC),
          factor: DEVICE,
        }),
      );
      const session = strField(res, "session");
      const walletId = strField(field(res, "wallet"), "walletId");
      ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
      /* Sixteen spot ids at the largest size cannot fit either dialog — create refuses before any
         verification prompt. */
      const before = fk.calls.length;
      expect(
        errCode(
          await h.call(
            "sessions.create",
            createParams(walletId, { limits: worstLimits, verify: HARDWARE }),
            session,
          ),
        ),
      ).toBe("invalid-input");
      expect(fk.calls.slice(before).filter(isPresenceCall)).toHaveLength(0);
    },
  );

  it("create refuses limits that only fit while the session is closed", async () => {
    const fk = fakeKeystore("en-US", "ios");
    const h = createHarness({ keystore: fk.keystore, start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: DEVICE,
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    /* Four spot ids at the largest size: the create prompt is 386 code points — inside the iOS
       bound — while the reopen variant's remaining-budget line reaches 441. */
    const borderline = {
      notional: "999999999999999.99999999",
      maxLeverage: 100,
      assets: Array.from({ length: 4 }, (_, i) => ({
        asset: 99_983 + i,
        size: "999999999999999.99999999",
      })),
    };
    const before = fk.calls.length;
    expect(
      errCode(
        await h.call(
          "sessions.create",
          createParams(walletId, { limits: borderline, verify: HARDWARE }),
          session,
        ),
      ),
    ).toBe("invalid-input");
    expect(fk.calls.slice(before).filter(isPresenceCall)).toHaveLength(0);
  });

  it("create on a non-keystore host accepts limits no dialog could show", async () => {
    const { h, session, walletId } = await webSetup();
    const created = ok(
      await h.call("sessions.create", createParams(walletId, { limits: worstLimits }), session),
    );
    expect(strField(created, "address")).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("F-02 regression: the prod-audit PoC", () => {
  /* The audit PoC signed a 1e-8 spot sell and a 1000x leverage change after a silent device-factor
     relaunch, without a single presence check. Each step is now refused: create cannot run while
     the app lock is off, the relaunched session is unopened until open verifies, and the leverage
     sign is past the approved cap. */
  it("a device-factor relaunch cannot sign — and the capped actions refuse typed", async () => {
    const fk = fakeKeystore();
    const input = fakeSecureInput({ approval: "correct" });
    const store = createMemoryStore();
    const h1 = createHarness({
      keystore: fk.keystore,
      secureInput: input.secureInput,
      store,
      start: T0,
    });
    await h1.settle();
    const imported = ok(
      await h1.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
    );
    const session1 = strField(imported, "session");
    const walletId = strField(field(imported, "wallet"), "walletId");
    const params = {
      scheme: SCHEME,
      owner: { walletId, groupIndex: 0 },
      scope: "Mainnet",
      name: "bot-1",
      validUntil: T0 + 30 * DAY,
      limits: {
        notional: "1000",
        maxLeverage: 10,
        assets: [
          { asset: 0, size: "1000" },
          { asset: 10107, size: "100000" },
        ],
      },
      verify: HARDWARE,
    };

    /* The PoC's first step — a session on a silent device-factor vault — is refused outright. */
    expect(errCode(await h1.call("sessions.create", params, session1))).toBe("app-lock-required");

    /* With the app lock on, create is a presence ceremony. */
    ok(await h1.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session1));
    const created = ok(await h1.call("sessions.create", params, session1));
    const address = strField(created, "address");

    /* Relaunch on the same store: the vault reopens only through a hardware verify, and the
       session's opened mark is gone — sign answers approval-required until open verifies. */
    const h2 = createHarness({
      keystore: fk.keystore,
      secureInput: input.secureInput,
      store,
      start: T0 + 5000,
    });
    await h2.settle();
    const session2 = strField(ok(await h2.call("vault.unlock", { factor: HARDWARE })), "session");
    const spotSell = {
      type: "order",
      orders: [
        {
          a: 10107,
          b: false,
          p: "0.00000001",
          s: "99999",
          r: false,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    };
    const sign2 = async (action: Record<string, unknown>): Promise<KernelResponse> => {
      const nonce = h2.wallNow();
      return h2.call(
        "sessions.sign",
        { scheme: SCHEME, address, params: { action, nonce, expiresAfter: nonce + 30_000 } },
        session2,
      );
    };
    expect(errCode(await sign2(spotSell))).toBe("approval-required");
    ok(await h2.call("sessions.open", { address, verify: HARDWARE }, session2));

    /* The PoC's signs: the 1e-8 spot sell sits inside the approved budget and signs; 1000x
       leverage is past the cap and refuses `limit-exceeded`. */
    expect(field(ok(await sign2(spotSell)), "signature")).toBeInstanceOf(Uint8Array);
    expect(
      errCode(await sign2({ type: "updateLeverage", asset: 0, isCross: false, leverage: 1000 })),
    ).toBe("limit-exceeded");
  });
});

describe("metered header integrity", () => {
  /* The kernel seals `limits` and `spent` together, so a metered-scheme record missing either is
     tampered: open and sign answer latched `integrity` before any factor or signing work. */
  const platform = { now: () => T0, random: (n: number) => new Uint8Array(n) };
  const address = `0x${"ab".repeat(20)}`;
  const base: Omit<SessionHeader, "limits" | "spent"> = {
    scheme: SCHEME,
    walletId: "aa".repeat(8),
    groupIndex: 0,
    owner: `0x${"cd".repeat(20)}`,
    scope: "Mainnet",
    name: "bot-1",
    validUntil: T0 + DAY,
    createdAt: T0,
  };

  it.each([
    ["neither limits nor spent", {}],
    ["no spent", { limits: LIMITS }],
    ["no limits", { spent: { notional: "0", size: ["0"] } }],
  ])("a record with %s answers integrity on open and sign", async (_name, extra) => {
    const dek = Secret.take(new Uint8Array(32).fill(7));
    const record = sealRecord(
      platform as never,
      dek,
      SESSION_KIND,
      address,
      encodeSessionHeader({ ...base, ...extra }),
      new Uint8Array(32).fill(3),
    );
    const image: VaultImage = { meta: undefined, records: [record], factors: [] };
    const ctx = {
      platform,
      image,
      session: { require: () => ({ dek }) },
    } as unknown as Parameters<ReturnType<typeof signSession>>[0];
    await expect(
      openSession(new Set())(ctx, { address, verify: { kind: "hardware" } }, "00".repeat(16)),
    ).rejects.toThrow("the session record carries no metering");
    await expect(
      signSession(new Set([address]))(
        ctx,
        {
          scheme: SCHEME,
          address,
          params: {
            action: {
              type: "order",
              orders: [order("1", "1")],
              grouping: "na",
            },
            nonce: T0,
            expiresAfter: T0 + 15_000,
          },
        },
        "00".repeat(16),
      ),
    ).rejects.toThrow("the session record carries no metering");
  });

  it.each([
    [
      "limits the scheme rejects",
      { limits: { ...LIMITS, notional: "oops" }, spent: { notional: "0", size: ["0", "0", "0"] } },
    ],
    ["a spent of the wrong length", { limits: LIMITS, spent: { notional: "0", size: ["0"] } }],
    [
      "a spent over an asset's cap",
      { limits: LIMITS, spent: { notional: "0", size: ["0", "0", "100001"] } },
    ],
    ["a non-canonical spent", { limits: LIMITS, spent: { notional: "00", size: ["0", "0", "0"] } }],
    [
      "a spent over the buy budget",
      { limits: LIMITS, spent: { notional: "1001", size: ["0", "0", "0"] } },
    ],
  ])("a record with %s answers integrity on open and sign", async (_name, extra) => {
    const dek = Secret.take(new Uint8Array(32).fill(7));
    const record = sealRecord(
      platform as never,
      dek,
      SESSION_KIND,
      address,
      encodeSessionHeader({ ...base, ...extra }),
      new Uint8Array(32).fill(3),
    );
    const image: VaultImage = { meta: undefined, records: [record], factors: [] };
    const ctx = {
      platform,
      image,
      session: { require: () => ({ dek }) },
    } as unknown as Parameters<ReturnType<typeof signSession>>[0];
    await expect(
      openSession(new Set())(ctx, { address, verify: { kind: "hardware" } }, "00".repeat(16)),
    ).rejects.toThrow("invalid session metering in the vault");
    await expect(
      signSession(new Set([address]))(
        ctx,
        {
          scheme: SCHEME,
          address,
          params: {
            action: {
              type: "order",
              orders: [order("1", "1")],
              grouping: "na",
            },
            nonce: T0,
            expiresAfter: T0 + 15_000,
          },
        },
        "00".repeat(16),
      ),
    ).rejects.toThrow("invalid session metering in the vault");
  });
});

describe("per-owner session cap", () => {
  /* Two live metered sessions may share one owner and scope — an agent plus its renewal — and a
     third is conflict. Each session's limits are separately approved, so the cap is what bounds
     the aggregate exposure per account and network. */
  const mk = (walletId: string, extra?: Record<string, unknown>): Record<string, unknown> =>
    createParams(walletId, extra);

  it("a third unexpired session on one owner and scope is refused", async () => {
    const { h, session, walletId } = await webSetup();
    ok(await h.call("sessions.create", mk(walletId), session));
    ok(await h.call("sessions.create", mk(walletId, { name: "bot-2" }), session));
    expect(errCode(await h.call("sessions.create", mk(walletId, { name: "bot-3" }), session))).toBe(
      "conflict",
    );
  });

  it("an expired session does not count", async () => {
    const h = createHarness({ start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: PASSKEY(),
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("sessions.create", mk(walletId, { validUntil: T0 + 1000 }), session));
    h.advanceWall(2000);
    ok(await h.call("sessions.create", mk(walletId, { name: "bot-2" }), session));
    ok(await h.call("sessions.create", mk(walletId, { name: "bot-3" }), session));
    expect(errCode(await h.call("sessions.create", mk(walletId, { name: "bot-4" }), session))).toBe(
      "conflict",
    );
  });

  it("another scope or account group counts separately", async () => {
    const { h, session, walletId } = await webSetup();
    ok(await h.call("sessions.create", mk(walletId), session));
    ok(await h.call("sessions.create", mk(walletId, { name: "bot-2" }), session));
    ok(await h.call("sessions.create", mk(walletId, { name: "bot-3", scope: "Testnet" }), session));
    ok(
      await h.call(
        "sessions.create",
        mk(walletId, { name: "bot-4", owner: { walletId, groupIndex: 1 } }),
        session,
      ),
    );
    const list = ok(await h.call("sessions.list", null, session)) as unknown as unknown[];
    expect(list).toHaveLength(4);
  });
});

describe("sell metering", () => {
  /* The kernel cannot know a market price, so a sell's self-declared price never bounds it: every
     order's size charges its asset's size meter whatever the side. With a one-dollar budget and a
     one-unit size cap on the BTC perp, a sell past the cap refuses — at any price the caller picks. */
  const NARROW = { notional: "1", maxLeverage: 1, assets: [{ asset: 0, size: "1" }] };
  const sell = (p: string, s: string, extra?: Record<string, unknown>) =>
    order(p, s, { b: false, t: { limit: { tif: "Ioc" } }, ...extra });

  it("sells past the size cap refuse at any price — and so does the same-size buy", async () => {
    const { h, session, address } = await seeded(NARROW);
    for (const orders of [
      [sell("0.1", "10")],
      [sell("0.00000001", "100000000")],
      [{ ...sell("0.1", "10"), t: { trigger: { isMarket: true, triggerPx: "0.1", tpsl: "sl" } } }],
      [order("100000", "10")],
    ]) {
      expect(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential kernel calls.
        errCode(await sign(h, session, address, { type: "order", orders, grouping: "na" })),
      ).toBe("limit-exceeded");
    }
    /* Within the cap the sell signs and charges only the size meter. */
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [sell("0.1", "1")],
        grouping: "na",
      }),
    );
    await expect(spentOf(h, session)).resolves.toStrictEqual({ notional: "0", size: ["1"] });
    expect(
      errCode(
        await sign(h, session, address, {
          type: "order",
          orders: [sell("0.1", "0.00000001")],
          grouping: "na",
        }),
      ),
    ).toBe("limit-exceeded");
  });
});

describe("charging concurrency", () => {
  it("two racing signs cannot both charge past the budget", async () => {
    /* The kernel handles commands on one queue and commit updates the image before the handler
       returns, so the second sign reads the first's committed spent. */
    const { h, session, walletId } = await webSetup();
    const created = ok(
      await h.call(
        "sessions.create",
        createParams(walletId, {
          limits: { notional: "10", maxLeverage: 10, assets: [{ asset: 0, size: "10" }] },
        }),
        session,
      ),
    );
    const address = strField(created, "address");
    const racing = async (): Promise<KernelResponse> =>
      sign(h, session, address, {
        type: "order",
        orders: [order("6", "1")],
        grouping: "na",
      });
    const settled = await Promise.all([racing(), racing()]);
    const outcomes = settled.map(codeOf).toSorted();
    expect(outcomes).toStrictEqual(["limit-exceeded", "ok"]);
    await expect(spentOf(h, session)).resolves.toStrictEqual({ notional: "6", size: ["1"] });
  });
});

describe("spent decimal extremes", () => {
  const bigLimits = {
    notional: "999999999999999.99999999",
    maxLeverage: 10,
    assets: [{ asset: 0, size: "9999999.99999999" }],
  };

  it("the grammar's edges stay exact inside the canonical spent grammar", async () => {
    const { h, session, walletId } = await webSetup();
    const created = ok(
      await h.call("sessions.create", createParams(walletId, { limits: bigLimits }), session),
    );
    const address = strField(created, "address");

    /* The smallest charge the params grammar admits: 0.00000001 × 0.00000001 = 1e-16, all sixteen
       fractional digits — the kernel must seal it and the scheme's own validator must parse it. */
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("0.00000001", "0.00000001")],
        grouping: "na",
      }),
    );
    const smallest = await spentOf(h, session);
    expect(smallest).toStrictEqual({ notional: "0.0000000000000001", size: ["0.00000001"] });
    expect(() => hyperliquidL1Spent(smallest, bigLimits)).not.toThrow();

    /* Max-decimal price × max-decimal size near the 1e15 ceiling: the exact sixteen-fractional-
       digit product, then the smallest further charge — and no more room. */
    ok(
      await sign(h, session, address, {
        type: "order",
        orders: [order("99999999.99999999", "9999999.99999998")],
        grouping: "na",
      }),
    );
    const near = await spentOf(h, session);
    expect(near).toStrictEqual({
      notional: "999999999999997.9000000000000003",
      size: ["9999999.99999999"],
    });
    expect(() => hyperliquidL1Spent(near, bigLimits)).not.toThrow();
    expect(
      errCode(
        await sign(h, session, address, {
          type: "order",
          orders: [order("2", "1")],
          grouping: "na",
        }),
      ),
    ).toBe("limit-exceeded");
  });
});

/** The session-key draw of a just-run `sessions.create` — the first 32-byte draw it makes. */
const sessionKeyDraw = (draws: ReadonlyArray<Uint8Array>): Uint8Array => {
  const draw = draws.find((d) => d.length === 32);
  if (draw === undefined) {
    throw new Error("sessions.create drew no session key");
  }
  return draw;
};

/** A Random whose first 32-byte draw replays `key` — what `sessions.create` consumes first. */
const replayKeyRandom = (key: Uint8Array): ((n: number) => Uint8Array) => {
  const fallback = seededRandom(0x5eed).random;
  let replayed = false;
  return (n) => {
    if (!replayed && n === 32) {
      replayed = true;
      return new Uint8Array(key);
    }
    return fallback(n);
  };
};

describe("approval follows the record, not the kernel's memory", () => {
  it("an opened record another writer deletes and re-creates signs only after re-approval", async () => {
    /* `opened` is in-memory, so an approval could outlive the record it approved. A second kernel
       over the same store deletes the session record, then re-creates a session with the same
       secret key — the identical record id returns, manifest-consistent. The reload's `forget`
       drops the stale approval, so signing needs sessions.open again; without it the dead id's
       approval would silently transfer to the new record. */
    const { h, session, walletId } = await webSetup();
    const drawsBefore = h.draws.length;
    const created = ok(
      await h.call("sessions.create", createParams(walletId, { limits: LIMITS }), session),
    );
    const address = strField(created, "address");
    const keyDraw = sessionKeyDraw(h.draws.slice(drawsBefore));
    ok(await h.call("sessions.open", { address, verify: PASSKEY() }, session));
    ok(await sign(h, session, address, { type: "twapCancel", a: 0, t: 1 }));

    /* A second kernel over the same store: its first 32-byte draw replays the session key, so
       its sessions.create seals a record under the very id the first kernel approved. */
    const h2 = createHarness({
      store: h.store,
      anchor: h.anchor,
      random: replayKeyRandom(keyDraw),
      start: T0,
    });
    await h2.settle();
    const session2 = strField(ok(await h2.call("vault.unlock", { factor: PASSKEY() })), "session");
    ok(await h2.call("sessions.delete", { address }, session2));
    await h.settle(); // the reload observes the removal — forget drops the approval
    const recreated = ok(
      await h2.call(
        "sessions.create",
        createParams(walletId, { limits: LIMITS, name: "bot-2" }),
        session2,
      ),
    );
    expect(strField(recreated, "address").toLowerCase()).toBe(address.toLowerCase());
    await h.settle(); // the reload claims the re-created record — without its stale approval

    expect(errCode(await sign(h, session, address, { type: "twapCancel", a: 0, t: 1 }))).toBe(
      "approval-required",
    );
    /* Re-approving the new record works — the record is whole, only the approval was lost. */
    ok(await h.call("sessions.open", { address, verify: PASSKEY() }, session));
    ok(await sign(h, session, address, { type: "twapCancel", a: 0, t: 1 }));
  });
});

describe("expired sessions", () => {
  it("open of an expired session refuses before any secure-input request or keystore verify", async () => {
    /* An expired session cannot be re-approved — the open prompt would verify the user for
       nothing. The refusal precedes the iOS confirmation code and the factor ceremony alike. */
    const fk = fakeKeystore();
    const input = fakeSecureInput({ approval: "correct" });
    const h = createHarness({ keystore: fk.keystore, secureInput: input.secureInput, start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: DEVICE,
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    const created = ok(
      await h.call("sessions.create", createParams(walletId, { verify: HARDWARE }), session),
    );
    const address = strField(created, "address");

    h.advanceWall(DAY + 1);
    const keystoreCalls = fk.calls.length;
    const inputCalls = input.requests.length;
    expect(errCode(await h.call("sessions.open", { address, verify: HARDWARE }, session))).toBe(
      "invalid-input",
    );
    expect(fk.calls.slice(keystoreCalls)).toStrictEqual([]);
    expect(input.requests.slice(inputCalls)).toStrictEqual([]);
    /* And sign refuses the same way — expiry is checked before metering or approval. */
    expect(errCode(await sign(h, session, address, { type: "twapCancel", a: 0, t: 1 }))).toBe(
      "invalid-input",
    );
  });
});
