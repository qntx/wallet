/**
 * The iOS secure-input approval (F-02 on a text-less biometric): Face ID never shows the keystore's
 * prompt text, so on an iOS host `sessions.create` and `sessions.open` first prove the limits were
 * seen on the kernel's secure-input view — the label is the approval prompt plus a kernel-drawn
 * 4-digit code as its last line, and the factor ceremony runs only after the user re-enters it.
 * Android's BiometricPrompt shows the bounded text and keystore-less hosts have no system dialog,
 * so neither requests a code.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { hyperliquidApproval } from "../src/modules/sessions/schemes/hyperliquid-l1-agent/prompt.ts";
import type { Random } from "../src/platform.ts";
import { PROMPT_BOUNDS, sessionApprovalCode } from "../src/prompts.ts";
import { createHarness, scriptedRandom } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";
import { fakeSecureInput, labelCode } from "./secure-input.ts";
import type { SessionApprovalAnswer } from "./secure-input.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const PASSKEY = () => ({
  kind: "passkey" as const,
  credentialId: utf8ToBytes("credential-1"),
  prf: new Uint8Array(32).fill(1),
});
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

const createParams = (walletId: string): Record<string, unknown> => ({
  scheme: SCHEME,
  owner: { walletId, groupIndex: 0 },
  scope: "Mainnet",
  name: "bot-1",
  validUntil: T0 + DAY,
  limits: LIMITS,
  verify: HARDWARE,
});

const isPresenceCall = (c: KeystoreCall): boolean =>
  "protection" in c && c.protection === "presence";

const approvalOf = (open: boolean) =>
  hyperliquidApproval(
    {
      scope: "Mainnet",
      name: "bot-1",
      validUntil: T0 + DAY,
      limits: LIMITS,
      spent: FRESH_SPENT,
    },
    open,
    "en",
  );

/** An iOS harness with a wallet whose app lock is on, ready for a session ceremony. */
async function iosSetup(opts?: { approval?: SessionApprovalAnswer; random?: Random }) {
  const fk = fakeKeystore();
  const input = fakeSecureInput(
    opts?.approval === undefined ? undefined : { approval: opts.approval },
  );
  const h = createHarness({
    keystore: fk.keystore,
    secureInput: input.secureInput,
    start: T0,
    ...(opts?.random === undefined ? {} : { random: opts.random }),
  });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  const session = strField(res, "session");
  const walletId = strField(field(res, "wallet"), "walletId");
  ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
  return { h, fk, input, session, walletId };
}

const create = async (w: {
  h: Harness;
  session: string;
  walletId: string;
}): Promise<KernelResponse> => w.h.call("sessions.create", createParams(w.walletId), w.session);

const sign = async (w: { h: Harness; session: string }, address: string): Promise<KernelResponse> =>
  w.h.call(
    "sessions.sign",
    {
      scheme: SCHEME,
      address,
      params: { action: { type: "twapCancel", a: 0, t: 1 }, nonce: T0, expiresAfter: T0 + 15_000 },
    },
    w.session,
  );

describe("the session-approval input", () => {
  it("create shows the approval prompt plus a code line and verifies after a correct entry", async () => {
    const w = await iosSetup({ approval: "correct" });
    const before = w.fk.calls.length;
    const created = ok(await create(w));
    const address = strField(created, "address");

    /* Exactly one request, kind session-approval, whose label is the approval prompt verbatim
       plus the code line — always last, so a clipped label drops it first. */
    expect(w.input.requests).toHaveLength(1);
    const request = w.input.requests[0]!;
    expect(request.kind).toBe("session-approval");
    const expected = approvalOf(false);
    const lines = request.label.split("\n");
    const codeLine = lines.at(-1);
    expect(codeLine).toMatch(/^Type [0-9]{4} below to approve these limits$/);
    expect(lines.slice(0, -1).join("\n")).toBe(`${expected.title}\n${expected.description}`);

    /* The factor ceremony ran after the entry, the record exists, and the born-open session
       signs. */
    expect(w.fk.calls.slice(before).some(isPresenceCall)).toBe(true);
    expect(field(ok(await sign(w, address)), "signature")).toBeInstanceOf(Uint8Array);
  });

  it("the zh-Hans label carries the zh code line", async () => {
    const fk = fakeKeystore("zh-Hans-CN");
    const input = fakeSecureInput({ approval: "correct" });
    const h = createHarness({
      keystore: fk.keystore,
      secureInput: input.secureInput,
      start: T0,
    });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    ok(await h.call("sessions.create", createParams(walletId), session));
    const { label } = input.requests.at(-1)!;
    expect(label.split("\n").at(-1)).toMatch(/^在下方输入 [0-9]{4} 以批准以上限额$/);
    expect(labelCode(label)).toMatch(/^[0-9]{4}$/);
  });

  it("a wrong code answers cancelled before any factor verification", async () => {
    const w = await iosSetup({ approval: "wrong" });
    const before = w.fk.calls.length;
    expect(errCode(await create(w))).toBe("cancelled");
    expect(w.fk.calls.slice(before).filter(isPresenceCall)).toHaveLength(0);
    const list = ok(await w.h.call("sessions.list", null, w.session));
    expect(list).toStrictEqual([]);
  });

  it("a dismissed input answers cancelled before any factor verification", async () => {
    const w = await iosSetup({ approval: "cancelled" });
    const before = w.fk.calls.length;
    expect(errCode(await create(w))).toBe("cancelled");
    expect(w.fk.calls.slice(before).filter(isPresenceCall)).toHaveLength(0);
  });

  it("an unavailable input answers unavailable", async () => {
    const w = await iosSetup({ approval: "unavailable" });
    expect(errCode(await create(w))).toBe("unavailable");
  });

  it("iOS without a secure-input view refuses unsupported before any prompt", async () => {
    const fk = fakeKeystore();
    const h = createHarness({ keystore: fk.keystore, start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    const before = fk.calls.length;
    expect(errCode(await h.call("sessions.create", createParams(walletId), session))).toBe(
      "unsupported",
    );
    expect(fk.calls.slice(before).filter(isPresenceCall)).toHaveLength(0);
  });

  it("Android shows the bounded prompt instead and never requests a code", async () => {
    const fk = fakeKeystore("en-US", "android");
    const input = fakeSecureInput({ approval: "correct" });
    const h = createHarness({
      keystore: fk.keystore,
      secureInput: input.secureInput,
      start: T0,
    });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    ok(await h.call("sessions.create", createParams(walletId), session));
    expect(input.requests).toHaveLength(0);
  });

  it("a keystore-less host never requests a code even with the view mounted", async () => {
    const input = fakeSecureInput({ approval: "correct" });
    const h = createHarness({ secureInput: input.secureInput, start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: PASSKEY(),
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    ok(await h.call("sessions.create", { ...createParams(walletId), verify: PASSKEY() }, session));
    expect(input.requests).toHaveLength(0);
  });

  it("open asks for the code again — correct entry opens, a wrong one cancels", async () => {
    const w = await iosSetup({ approval: "correct" });
    const created = ok(await create(w));
    const address = strField(created, "address");

    /* Idle past the lock: the opened mark is gone, open re-approves with the same input step. */
    w.h.advance(15 * 60_000 + 1);
    await w.h.settle();
    const session = strField(ok(await w.h.call("vault.unlock", { factor: HARDWARE })), "session");
    expect(errCode(await sign({ h: w.h, session }, address))).toBe("approval-required");

    const requestsBefore = w.input.requests.length;
    ok(await w.h.call("sessions.open", { address, verify: HARDWARE }, session));
    expect(w.input.requests).toHaveLength(requestsBefore + 1);
    const { label } = w.input.requests.at(-1)!;
    expect(label).toContain("Remaining buy budget: 1000");
    expect(labelCode(label)).toMatch(/^[0-9]{4}$/);
    expect(field(ok(await sign({ h: w.h, session }, address)), "signature")).toBeInstanceOf(
      Uint8Array,
    );

    /* A second lock, then a wrong entry: open cancels and sign still needs approval. */
    w.h.advance(15 * 60_000 + 1);
    await w.h.settle();
    const reopened = strField(ok(await w.h.call("vault.unlock", { factor: HARDWARE })), "session");
    w.input.setApproval("wrong");
    expect(errCode(await w.h.call("sessions.open", { address, verify: HARDWARE }, reopened))).toBe(
      "cancelled",
    );
    expect(errCode(await sign({ h: w.h, session: reopened }, address))).toBe("approval-required");
  });

  it("an out-of-range code draw is rejected and redrawn", async () => {
    /* First two-byte draw 0xFFFF is past the 60000 rejection bound; the redraw 0x3039 = 12345
       maps to code 2345. */
    const draws = [0xff_ff, 0x30_39];
    const w = await iosSetup({ approval: "correct", random: scriptedRandom(draws) });
    ok(await create(w));
    expect(draws).toHaveLength(0);
    expect(labelCode(w.input.requests[0]!.label)).toBe("2345");
  });

  it("the label stays inside the native bound at the worst iOS prompt", () => {
    /* KernelSecureInput.cpp caps the label at 2048 UTF-8 bytes. The worst label is title + LF +
       the iOS-bound description (400 code points, ≤ 4 bytes each) + LF + the code line; the
       overhead measured on the real renderings leaves the cap unhit. */
    const bytes = (text: string): number => utf8ToBytes(text).length;
    const session = {
      scope: "Mainnet",
      name: "bot-1",
      validUntil: T0 + DAY,
      limits: LIMITS,
      spent: FRESH_SPENT,
    };
    const overhead = Math.max(
      ...(["en", "zh-Hans"] as const).map(
        (locale) =>
          bytes(hyperliquidApproval(session, true, locale).title) +
          bytes(sessionApprovalCode(locale, "0000")),
      ),
    );
    expect(overhead + 2 + PROMPT_BOUNDS["ios"].characters * 4).toBeLessThanOrEqual(2048);
  });
});
