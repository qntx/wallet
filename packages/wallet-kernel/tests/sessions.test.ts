/**
 * The sessions module: `session-key` lifecycle, L1 phantom-agent signing against the oracle
 * vectors, session key isolation, the ApproveAgent binding, and unknown schemes staying inert.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import {
  assembleEvm,
  evmAddressFromPublicKey,
  hyperliquidL1Document,
  normalizeEvm,
  planEvm,
} from "@qntx/wallet-chains/evm";
import { signEvmTask, signEvmTypedData } from "@qntx/wallet-chains/evm/sign";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createSessionsModule } from "../src/modules/sessions/index.ts";
import {
  encodeSessionHeader,
  findSession,
  parseSessionHeader,
  SESSION_KIND,
} from "../src/modules/sessions/record.ts";
import type { SessionHeader } from "../src/modules/sessions/record.ts";
import { hyperliquidL1Agent } from "../src/modules/sessions/schemes/hyperliquid-l1-agent/index.ts";
import { signSession } from "../src/modules/sessions/sessions.ts";
import { Secret, wipe } from "../src/secret/secret.ts";
import { passkeyKek, unwrapDek } from "../src/vault/factors.ts";
import { withManifest } from "../src/vault/manifest.ts";
import type { VaultImage } from "../src/vault/store.ts";
import { openRecord, sealRecord } from "../src/vault/vault.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSKEY = () => ({
  kind: "passkey" as const,
  credentialId: utf8ToBytes("credential-1"),
  prf: new Uint8Array(32).fill(1),
});
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
// Fresh bytes each call: the kernel wipes password buffers after hashing them.
const backupPassword = () => ({
  kind: "password" as const,
  password: utf8ToBytes("backup password"),
});
const EVM_SECRET = hexToBytes("822e9959e022b78423eb653a62ea0020cd283e71a2a8133a6ff2aeffaf373cff");
const EVM_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const T0 = Date.parse("2026-06-01T00:00:00Z");
const DAY = 86_400_000;
const SCHEME = "hyperliquid-l1-agent";

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
const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

async function setup(start?: number): Promise<{
  h: Harness;
  session: string;
  walletId: string;
}> {
  const h = createHarness(start === undefined ? {} : { start });
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
  ...extra,
});

async function createSession(
  h: Harness,
  session: string,
  walletId: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const res = ok(await h.call("sessions.create", createParams(walletId, extra), session));
  return strField(res, "address");
}

const sessionRecord = (
  image: {
    records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: Uint8Array }>;
  },
  id?: string,
) =>
  image.records.find(
    (r) => r.kind === SESSION_KIND && (id === undefined || r.id === id.toLowerCase()),
  );

const mustSessionRecord = (image: {
  records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: Uint8Array }>;
}) => {
  const record = sessionRecord(image);
  if (record === undefined) {
    throw new Error("missing session record");
  }
  return record;
};

const flipByte = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(bytes);
  out[0] = (out[0] ?? 0) ^ 0xff;
  return out;
};

/**
 * Every `key` record id is 16-hex — the structural proof a kind+id lookup can never reach a
 * session's `0x`-prefixed 40-hex id.
 */
const keyIdsAre16Hex = (image: { records: ReadonlyArray<{ kind: string; id: string }> }) =>
  image.records.every((r) => r.kind !== "key" || /^[0-9a-f]{16}$/.test(r.id));

const FUTURE_SCOPE = `0x${"11".repeat(20)}`;
const sealer = {
  random: (n: number) => new Uint8Array(n).fill(3),
  now: () => T0,
} as never;

/** The session DEK, unwrapped the way unlock does — from the test passkey factor's KEK. */
const sessionDek = async (h: Harness): Promise<Secret> => {
  const image = await h.store.load();
  const factor = image.factors.find((f) => f.kind === "passkey");
  if (factor === undefined) {
    throw new Error("missing passkey factor");
  }
  const kek = passkeyKek(new Uint8Array(32).fill(1), utf8ToBytes("credential-1"));
  try {
    return unwrapDek(kek, factor);
  } finally {
    wipe(kek);
  }
};

/**
 * Reseal the session record at `address` under a different header — authentic through the AEAD
 * binding a bare header rewrite lacks. The record's id and sealed key stay.
 */
const resealSession = async (h: Harness, address: string, header: SessionHeader): Promise<void> => {
  const dek = await sessionDek(h);
  try {
    const image = await h.store.load();
    const record = sessionRecord(image, address);
    if (record === undefined) {
      throw new Error("missing session record");
    }
    const plaintext = openRecord(dek, record);
    let resealed;
    try {
      resealed = sealRecord(
        sealer,
        dek,
        SESSION_KIND,
        record.id,
        encodeSessionHeader(header),
        plaintext,
      );
    } finally {
      wipe(plaintext);
    }
    await h.store.commit(
      withManifest(sealer, image, [{ op: "put-record", record: resealed }], dek),
    );
  } finally {
    dek.wipe();
  }
};

/**
 * A Random that serves `key` for 32-byte draws made while armed and deterministic bytes otherwise —
 * platform.random is also the seal-nonce source, so the oracle key goes only to the draw inside
 * sessions.create.
 */
const injectingRandom = (
  key: Uint8Array,
): { random: (n: number) => Uint8Array; arm: (on: boolean) => void } => {
  let armed = false;
  return {
    arm: (on) => {
      armed = on;
    },
    random: (n) => {
      if (armed && n === 32) {
        return new Uint8Array(key);
      }
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = (i * 31 + n) & 0xff;
      }
      return out;
    },
  };
};

type L1Case = {
  readonly name: string;
  readonly action: Record<string, unknown>;
  readonly nonce: number;
  readonly vaultAddress?: string;
  readonly expiresAfter?: number;
  readonly network: "Mainnet" | "Testnet";
  readonly connectionId: string;
  readonly digest: string;
  readonly privateKey: string;
  readonly signature: string;
};

const l1Cases = (loadVectors("chains/hyperliquid.json") as { l1: L1Case[] }).l1;
const allowListed = l1Cases.filter((c) => c.action["type"] !== "dummy");
const dummies = l1Cases.filter((c) => c.action["type"] === "dummy");

describe("sessions.sign against the oracle vectors", () => {
  /* The oracle scheduleCancel vectors' `time` values are far in the past — under the window policy
     the kernel refuses them, so the sign call substitutes the session's own validUntil (their
     encoding stays pinned by the connectionId checks above and the window test's bounds). */
  const signArgs = (vector: L1Case) => ({
    action:
      vector.action["type"] === "scheduleCancel" && vector.action["time"] !== undefined
        ? ({ ...vector.action, time: vector.nonce + DAY } as never)
        : (vector.action as never),
    nonce: vector.nonce,
    ...(vector.vaultAddress === undefined ? {} : { vaultAddress: vector.vaultAddress }),
    expiresAfter: vector.expiresAfter ?? vector.nonce + 15_000,
  });
  const signEndToEnd = async (
    vector: L1Case,
    start: number,
  ): Promise<{
    signed: ProtocolValue;
    keyBytes: Uint8Array;
    header: SessionHeader;
    now: number;
  }> => {
    const keyBytes = hexToBytes(vector.privateKey.slice(2));
    const expectedAddress = evmAddressFromPublicKey(
      secp256k1.getPublicKey(keyBytes, true),
    ).toLowerCase();
    const injected = injectingRandom(keyBytes);
    const h = createHarness({ start, random: injected.random });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: PASSKEY(),
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    injected.arm(true);
    const created = ok(
      await h.call(
        "sessions.create",
        {
          scheme: SCHEME,
          owner: { walletId, groupIndex: 0 },
          scope: vector.network,
          name: "bot-1",
          validUntil: vector.nonce + DAY,
        },
        session,
      ),
    );
    injected.arm(false);
    const address = strField(created, "address").toLowerCase();
    expect(address).toBe(expectedAddress);
    const signed = ok(
      await h.call("sessions.sign", { scheme: SCHEME, address, params: signArgs(vector) }, session),
    );
    const record = sessionRecord(await h.store.load(), address);
    if (record === undefined) {
      throw new Error("missing session record");
    }
    return { signed, keyBytes, header: parseSessionHeader(record.header), now: h.wallNow() };
  };

  /* Vectors carrying expiresAfter byte-compare end to end: the clock starts at nonce−1 so the
     required expiresAfter = nonce is inside (now, now + 60 s]. */
  const withExpires = allowListed.filter((c) => c.expiresAfter !== undefined);

  it.each(withExpires)("$name signs byte-identically", async (vector) => {
    const { signed } = await signEndToEnd(vector, vector.nonce - 1);
    expect(bytesToHex(bytesField(signed, "signature"))).toBe(vector.signature.slice(2));
  });

  /* Vectors without expiresAfter sign with a 15 s expiresAfter and compare against the
     document+signature assembled outside the kernel — the encoder itself stays pinned by the
     connectionId checks above. */
  const withoutExpires = allowListed.filter((c) => c.expiresAfter === undefined);

  it.each(withoutExpires)("$name signs byte-identically", async (vector) => {
    const { signed, keyBytes } = await signEndToEnd(vector, vector.nonce);
    const expected = bytesToHex(
      signEvmTypedData(hyperliquidL1Document(signArgs(vector), vector.network), keyBytes),
    );
    expect(bytesToHex(bytesField(signed, "signature"))).toBe(expected);
  });

  /* The seam: sessions.sign's output is the plan → task signer → assemble artefact of the
     scheme's document, not a bespoke signature. */
  const startFor = (vector: L1Case): number =>
    vector.expiresAfter === undefined ? vector.nonce : vector.nonce - 1;

  const signedArtefact = (assembled: { kind: string; artefact?: Uint8Array }): Uint8Array => {
    if (assembled.kind !== "signed" || assembled.artefact === undefined) {
      throw new Error("expected a signed artefact");
    }
    return assembled.artefact;
  };

  it.each(allowListed)("$name is the plan → task signer → assemble artefact", async (vector) => {
    const { signed, keyBytes, header, now } = await signEndToEnd(vector, startFor(vector));
    const document = hyperliquidL1Agent.document(signArgs(vector), header, now);
    const plan = planEvm({ kind: "evm.typed-data", typedData: document } as never, {
      path: [],
      publicKey: secp256k1.getPublicKey(keyBytes, true),
    });
    const [task] = plan.tasks;
    const artefact = signedArtefact(assembleEvm(plan, [signEvmTask(task, keyBytes)]));
    expect(bytesToHex(bytesField(signed, "signature"))).toBe(bytesToHex(artefact));
  });

  it.each(dummies)("$name is rejected as invalid-input", async (vector) => {
    const { h, session, walletId } = await setup(vector.nonce);
    const address = await createSession(h, session, walletId, {
      validUntil: vector.nonce + DAY,
    });
    expect(
      errCode(
        await h.call(
          "sessions.sign",
          {
            scheme: SCHEME,
            address,
            params: { action: vector.action, nonce: vector.nonce },
          },
          session,
        ),
      ),
    ).toBe("invalid-input");
  });
});

describe("protocol: strict action validation", () => {
  const order = {
    a: 0,
    b: true,
    p: "30000",
    s: "0.1",
    r: false,
    t: { limit: { tif: "Gtc" } },
  };
  const sign = async (
    h: Harness,
    session: string,
    address: string,
    action: unknown,
  ): Promise<string | undefined> =>
    errCode(
      await h.call(
        "sessions.sign",
        {
          scheme: SCHEME,
          address,
          params: { action, nonce: T0, expiresAfter: T0 + 15_000 },
        },
        session,
      ),
    );

  async function withSession(
    run: (h: Harness, session: string, address: string) => Promise<void>,
  ): Promise<void> {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId);
    await run(h, session, address);
  }

  it.each([
    { type: "order", orders: [order], grouping: "na" },
    {
      type: "order",
      orders: [order],
      grouping: "na",
      builder: { b: `0x${"00".repeat(20)}`, f: 1000 },
    },
    { type: "cancel", cancels: [{ a: 0, o: 1 }] },
    { type: "cancel", cancels: [{ a: 0, o: 1 }], f: true },
    { type: "cancelByCloid", cancels: [{ asset: 0, cloid: `0x${"00".repeat(16)}` }] },
    { type: "modify", oid: 1, order },
    { type: "modify", oid: `0x${"00".repeat(16)}`, order, a: true },
    { type: "batchModify", modifies: [{ oid: 1, order }] },
    { type: "scheduleCancel" },
    { type: "scheduleCancel", time: T0 + 10_000 },
    { type: "updateLeverage", asset: 0, isCross: true, leverage: 5 },
    { type: "updateIsolatedMargin", asset: 0, isBuy: true, ntli: -100 },
    { type: "twapOrder", twap: { a: 0, b: true, s: "1", r: false, m: 30, t: false } },
    { type: "twapCancel", a: 0, t: 1 },
  ])("allow-listed action %j is accepted", async (action) => {
    await withSession(async (h, session, address) => {
      await expect(sign(h, session, address, action)).resolves.toBeUndefined();
    });
  });

  it.each([
    { type: "vaultTransfer", vaultAddress: `0x${"00".repeat(20)}`, usd: 1, isDeposit: true },
    {
      type: "subAccountTransfer",
      subAccountUser: `0x${"00".repeat(20)}`,
      usd: 1,
      isDeposit: true,
    },
    { type: "usdClassTransfer", amount: "1", toPerp: true },
    {
      type: "withdraw3",
      destination: `0x${"00".repeat(20)}`,
      amount: "1",
      nonce: 1,
    },
    { type: "createSubAccount", name: "x" },
    { type: "noop" },
    { type: "reserveRequestWeight", weight: 1 },
    { type: "agentSendAsset" },
    { type: "cDeposit2" },
    { type: "setReferrer", code: "X" },
    { type: "trailingStop" },
    { type: "userOutcome" },
  ])("excluded action %j answers invalid-input", async (action) => {
    await withSession(async (h, session, address) => {
      await expect(sign(h, session, address, action)).resolves.toBe("invalid-input");
    });
  });

  it.each([
    ["{p} grouping", { type: "order", orders: [order], grouping: { p: 1 } }],
    ["priority-fee grouping", { type: "order", orders: [order], grouping: "p" }],
    [
      "builder fee above the cap",
      {
        type: "order",
        orders: [order],
        grouping: "na",
        builder: { b: `0x${"00".repeat(20)}`, f: 1001 },
      },
    ],
    [
      "builder split list",
      {
        type: "order",
        orders: [order],
        grouping: "na",
        builder: { b: `0x${"00".repeat(20)}`, f: 1, s: [] },
      },
    ],
    [
      "twap details",
      {
        type: "twapOrder",
        twap: { a: 0, b: true, s: "1", r: false, m: 30, t: false },
        details: {},
      },
    ],
    [
      "uppercase builder address",
      {
        type: "order",
        orders: [order],
        grouping: "na",
        builder: { b: `0x${"AA".repeat(20)}`, f: 1 },
      },
    ],
    ["trailing zero decimal", { type: "order", orders: [{ ...order, p: "1.0" }], grouping: "na" }],
    ["leading zero", { type: "order", orders: [{ ...order, p: "01" }], grouping: "na" }],
    ["scientific notation", { type: "order", orders: [{ ...order, p: "1e3" }], grouping: "na" }],
    ["negative price", { type: "order", orders: [{ ...order, p: "-1" }], grouping: "na" }],
    ["zero price", { type: "order", orders: [{ ...order, p: "0" }], grouping: "na" }],
    ["zero size", { type: "order", orders: [{ ...order, s: "0" }], grouping: "na" }],
    [
      "65 orders",
      { type: "order", orders: Array.from({ length: 65 }, () => order), grouping: "na" },
    ],
    ["extra key", { type: "cancel", cancels: [{ a: 0, o: 1 }], extra: 1 }],
    ["extra key inside order", { type: "order", orders: [{ ...order, extra: 1 }], grouping: "na" }],
  ])("malformed action %s answers invalid-input", async (_name, action) => {
    await withSession(async (h, session, address) => {
      await expect(sign(h, session, address, action)).resolves.toBe("invalid-input");
    });
  });
});

describe("session-key lifecycle", () => {
  it("create/list/delete round trip with header fields and derived owner", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId, {
      scope: "Testnet",
      name: "bot-2",
      validUntil: T0 + 30 * DAY,
    });
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(address).not.toBe(address.toLowerCase());

    const image = await h.store.load();
    const record = sessionRecord(image);
    expect(record?.id).toBe(address.toLowerCase());
    expect(record?.header).toBe(
      `{"scheme":"${SCHEME}","walletId":"${walletId}","groupIndex":0,"owner":"${EVM_ADDRESS}","scope":"Testnet","name":"bot-2","validUntil":${T0 + 30 * DAY},"createdAt":${T0}}`,
    );

    const list = ok(await h.call("sessions.list", null, session)) as unknown as Array<
      Record<string, unknown>
    >;
    expect(list).toStrictEqual([
      {
        address,
        scheme: SCHEME,
        supported: true,
        owner: EVM_ADDRESS,
        walletId,
        groupIndex: 0,
        scope: "Testnet",
        name: "bot-2",
        validUntil: T0 + 30 * DAY,
        createdAt: T0,
      },
    ]);

    ok(await h.call("sessions.delete", { address }, session));
    const after = ok(await h.call("sessions.list", null, session)) as unknown as unknown[];
    expect(after).toHaveLength(0);
    expect(errCode(await h.call("sessions.delete", { address }, session))).toBe("not-found");
  });

  it.each([
    ["now", T0, "invalid-input"],
    ["past", T0 - 1, "invalid-input"],
    ["now + 180d", T0 + 180 * DAY, undefined],
    ["now + 180d + 1", T0 + 180 * DAY + 1, "invalid-input"],
  ])("validUntil %s → %s", async (_label, validUntil, code) => {
    const { h, session, walletId } = await setup(T0);
    expect(
      errCode(await h.call("sessions.create", createParams(walletId, { validUntil }), session)),
    ).toBe(code);
  });

  it("an unknown scheme cannot be created", async () => {
    const { h, session, walletId } = await setup(T0);
    expect(
      errCode(
        await h.call(
          "sessions.create",
          createParams(walletId, { scheme: "future-scheme" }),
          session,
        ),
      ),
    ).toBe("unsupported");
  });

  it("caps live sessions of one scheme at 16", async () => {
    const { h, session, walletId } = await setup(T0);
    for (let i = 0; i < 16; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- creates run serially on the session
      await createSession(h, session, walletId, { name: `bot-${i}` });
    }
    expect(
      errCode(await h.call("sessions.create", createParams(walletId, { name: "bot-16" }), session)),
    ).toBe("conflict");
    const list = ok(await h.call("sessions.list", null, session)) as unknown as unknown[];
    expect(list).toHaveLength(16);
  });

  it("caps live sessions at 64 across all schemes", async () => {
    const { h, session, walletId } = await setup(T0);
    /* 49 real session-key records of an unknown scheme + 15 known = 64 live — the next create is
       the 65th and the per-scheme cap (16) cannot be what refuses it. */
    const dek = await sessionDek(h);
    try {
      const image = await h.store.load();
      const ops = [];
      for (let i = 0; i < 49; i++) {
        const key = new Uint8Array(32);
        key[31] = i + 1;
        const id = evmAddressFromPublicKey(secp256k1.getPublicKey(key, true)).toLowerCase();
        ops.push({
          op: "put-record" as const,
          record: sealRecord(
            sealer,
            dek,
            SESSION_KIND,
            id,
            encodeSessionHeader({
              scheme: "future-scheme",
              walletId,
              groupIndex: 0,
              owner: EVM_ADDRESS,
              scope: FUTURE_SCOPE,
              name: `s-${i}`,
              validUntil: T0 + DAY,
              createdAt: T0,
            }),
            key,
          ),
        });
      }
      await h.store.commit(withManifest(sealer, image, ops, dek));
    } finally {
      dek.wipe();
    }
    for (let i = 0; i < 15; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- creates run serially on the session
      await createSession(h, session, walletId, { name: `bot-${i}` });
    }
    expect(
      errCode(await h.call("sessions.create", createParams(walletId, { name: "bot-15" }), session)),
    ).toBe("conflict");
    const list = ok(await h.call("sessions.list", null, session)) as unknown as unknown[];
    expect(list).toHaveLength(64);
  });

  it("sessions.create needs a live session and a real wallet", async () => {
    const { h, session, walletId } = await setup(T0);
    expect(errCode(await h.call("sessions.create", createParams(walletId), "00".repeat(16)))).toBe(
      "locked",
    );
    expect(errCode(await h.call("sessions.create", createParams("ff".repeat(8)), session))).toBe(
      "not-found",
    );
  });
});

describe("sessions.sign checks", () => {
  const orderAction = {
    type: "order",
    orders: [{ a: 0, b: true, p: "30000", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } }],
    grouping: "na",
  };
  const signCall = async (
    h: Harness,
    session: string,
    params: Record<string, unknown>,
  ): Promise<KernelResponse> => h.call("sessions.sign", params, session);

  it("a foreign session cannot sign", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId);
    expect(
      errCode(
        await signCall(h, "00".repeat(16), {
          scheme: SCHEME,
          address,
          params: { action: orderAction, nonce: T0 },
        }),
      ),
    ).toBe("locked");
  });

  it("a session that idled out cannot sign with a previously valid key", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId);
    h.advance(15 * 60_000 + 1);
    await h.settle();
    expect(
      errCode(
        await signCall(h, session, {
          scheme: SCHEME,
          address,
          params: { action: orderAction, nonce: T0 },
        }),
      ),
    ).toBe("locked");
  });

  it("an expired session key cannot sign", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId, { validUntil: T0 + 1000 });
    h.advanceWall(1000); // now == validUntil ⇒ expired
    expect(
      errCode(
        await signCall(h, session, {
          scheme: SCHEME,
          address,
          params: {
            action: orderAction,
            nonce: h.wallNow(),
            expiresAfter: h.wallNow() + 15_000,
          },
        }),
      ),
    ).toBe("invalid-input");
    h.advanceWall(1000);
    expect(
      errCode(
        await signCall(h, session, {
          scheme: SCHEME,
          address,
          params: {
            action: orderAction,
            nonce: h.wallNow(),
            expiresAfter: h.wallNow() + 15_000,
          },
        }),
      ),
    ).toBe("invalid-input");
  });

  it.each([
    ["+60_000", 60_000, undefined],
    ["+60_001", 60_001, "invalid-input"],
    ["-60_000", -60_000, undefined],
    ["-60_001", -60_001, "invalid-input"],
  ])("nonce %s of now → %s", async (_label, delta, code) => {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId, { validUntil: T0 + 400_000 });
    expect(
      errCode(
        await signCall(h, session, {
          scheme: SCHEME,
          address,
          params: { action: orderAction, nonce: T0 + delta, expiresAfter: T0 + 15_000 },
        }),
      ),
    ).toBe(code);
  });

  it("an imported key's address and the HD account's address are not sessions", async () => {
    const { h, session } = await setup(T0);
    const imported = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session),
    );
    const importedAddress = strField(imported, "address").toLowerCase();
    for (const address of [importedAddress, EVM_ADDRESS.toLowerCase()]) {
      expect(
        errCode(
          // oxlint-disable-next-line eslint/no-await-in-loop -- lookups are sequential
          await signCall(h, session, {
            scheme: SCHEME,
            address,
            params: { action: orderAction, nonce: T0 },
          }),
        ),
      ).toBe("not-found");
    }
  });

  it("a scheme mismatch with the record answers invalid-input", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId);
    expect(
      errCode(
        await signCall(h, session, {
          scheme: "future-scheme",
          address,
          params: { action: orderAction, nonce: T0 },
        }),
      ),
    ).toBe("invalid-input");
  });
});

describe("session defense-in-depth checks", () => {
  const imageOf = (
    ...records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: Uint8Array }>
  ): VaultImage => ({ meta: undefined, records: [...records], factors: [] });

  it("findSession only matches session-key records — a `key` record is never a session", () => {
    const image = imageOf(
      { kind: "key", id: `0x${"ab".repeat(20)}`, header: "{}", sealed: new Uint8Array(1) },
      {
        kind: SESSION_KIND,
        id: `0x${"cd".repeat(20)}`,
        header: "{}",
        sealed: new Uint8Array(1),
      },
    );
    expect(findSession(image, `0x${"ab".repeat(20)}`)).toBeUndefined();
    expect(findSession(image, `0x${"cd".repeat(20)}`)).toBeDefined();
  });

  it("claimUnlocked latches corrupted when the sealed key is not the record id", () => {
    const { vault } = createSessionsModule();
    const key = new Uint8Array(32).fill(9); // a valid secret whose address is not 0x00…
    expect(() =>
      vault.claimUnlocked([{ kind: SESSION_KIND, id: `0x${"00".repeat(20)}`, plaintext: key }]),
    ).toThrow("session key does not match its record");
  });

  it("claimUnlocked claims a well-formed session and returns the rest", () => {
    const { vault } = createSessionsModule();
    const key = new Uint8Array(EVM_SECRET);
    const id = evmAddressFromPublicKey(secp256k1.getPublicKey(key, true)).toLowerCase();
    const other = { kind: "key", id: "0123456789abcdef", plaintext: new Uint8Array(32) };
    const rest = vault.claimUnlocked([{ kind: SESSION_KIND, id, plaintext: key }, other]);
    expect(rest).toStrictEqual([other]);
  });

  it("sessions.sign refuses a record whose sealed key is not the record id", () => {
    const dek = Secret.take(new Uint8Array(32).fill(7));
    const platform = {
      now: () => T0,
      random: (n: number) => new Uint8Array(n),
    };
    const wrongId = `0x${"00".repeat(20)}`;
    const record = sealRecord(
      platform as never,
      dek,
      SESSION_KIND,
      wrongId,
      encodeSessionHeader({
        scheme: SCHEME,
        walletId: "aa".repeat(8),
        groupIndex: 0,
        owner: EVM_ADDRESS,
        scope: "Mainnet",
        name: "bot-1",
        validUntil: T0 + DAY,
        createdAt: T0,
      }),
      new Uint8Array(EVM_SECRET), // authentic seal — the key inside is not `wrongId`
    );
    const ctx = {
      platform,
      image: imageOf(record),
      session: { require: () => ({ dek }) },
    } as unknown as Parameters<typeof signSession>[0];
    expect((): unknown =>
      signSession(
        ctx,
        {
          scheme: SCHEME,
          address: wrongId,
          params: {
            action: {
              type: "order",
              orders: [{ a: 0, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Gtc" } } }],
              grouping: "na",
            },
            nonce: T0,
            expiresAfter: T0 + 15_000,
          },
        },
        "00".repeat(16),
      ),
    ).toThrow("session key does not match its record");
  });
});

describe("session key isolation", () => {
  it("keys.list/export/remove never see sessions", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId);
    const list = ok(await h.call("keys.list", null, session)) as unknown as unknown[];
    expect(list).toHaveLength(0);
    // The `0x`-prefixed address fails the 16-hex keyId envelope shape.
    expect(
      errCode(await h.call("keys.export", { verify: PASSKEY(), keyId: address }, session)),
    ).toBe("integrity");
    expect(
      errCode(await h.call("keys.remove", { verify: PASSKEY(), keyId: address }, session)),
    ).toBe("integrity");
    // And a well-formed id colliding with nothing answers not-found.
    expect(
      errCode(
        await h.call(
          "keys.export",
          { verify: PASSKEY(), keyId: address.toLowerCase().slice(2, 18) },
          session,
        ),
      ),
    ).toBe("not-found");
  });

  it("chain.sign imported lookup cannot reach a session record", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId);
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "m", type: "string" }],
      },
      domain: { name: "X" },
      primaryType: "Mail",
      message: { m: "hi" },
    });
    // The session record id is a `0x`-prefixed 40-hex address; the imported keyId validator accepts
    // only 16-hex, so the address form is rejected at the envelope — before any record lookup.
    const requests = [
      normalizeEvm({
        kind: "evm.typed-data",
        network: "eip155:1",
        account: { kind: "imported", keyId: address, family: "evm" },
        typedData,
      }),
      normalizeEvm({
        kind: "evm.personal-message",
        network: "eip155:1",
        account: { kind: "imported", keyId: address, family: "evm" },
        message: utf8ToBytes("hi"),
      }),
      normalizeEvm({
        kind: "evm.transaction",
        network: "eip155:1",
        account: { kind: "imported", keyId: address, family: "evm" },
        tx: {
          type: "eip1559",
          chainId: 1,
          nonce: 0,
          gas: "0x5208",
          value: "0x1",
          data: "0x",
          to: "0x00000000000000000000000000000000deadbeef",
          maxFeePerGas: "0x59682f00",
          maxPriorityFeePerGas: "0x1",
          accessList: [],
        },
      }),
    ];
    for (const request of requests) {
      expect(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sign calls run serially on the session
        errCode(await h.call("chain.sign", { request, verify: PASSKEY() }, session)),
      ).toBe("integrity");
    }
    // A well-formed 16-hex keyId colliding with nothing answers not-found…
    expect(
      errCode(
        await h.call(
          "chain.sign",
          {
            request: normalizeEvm({
              kind: "evm.personal-message",
              network: "eip155:1",
              account: { kind: "imported", keyId: "0123456789abcdef", family: "evm" },
              message: utf8ToBytes("hi"),
            }),
            verify: PASSKEY(),
          },
          session,
        ),
      ),
    ).toBe("not-found");
    // …and every `key` record id is 16-hex, so kind+id lookup can never land on a session id.
    const image = await h.store.load();
    expect(keyIdsAre16Hex(image)).toBe(true);
  });

  it("backups never contain sessions", async () => {
    const { h, session, walletId } = await setup(T0);
    await createSession(h, session, walletId);
    ok(await h.call("backup.enable", { verify: PASSKEY(), factors: [backupPassword()] }, session));
    const envelope = strField(ok(await h.call("backup.update", null, session)), "envelope");

    const restored = createHarness({ start: T0 });
    await restored.settle();
    const res = ok(
      await restored.call("backup.restore", {
        envelope,
        backupFactor: backupPassword(),
        factor: { kind: "password" as const, password: utf8ToBytes("vault password") },
      }),
    );
    const session2 = strField(res, "session");
    const list = ok(await restored.call("sessions.list", null, session2)) as unknown as unknown[];
    expect(list).toHaveLength(0);
    const image = await restored.store.load();
    expect(image.records.every((r) => r.kind !== SESSION_KIND)).toBe(true);
  });

  it("wallet.delete removes that wallet's sessions only", async () => {
    const { h, session, walletId } = await setup(T0);
    await createSession(h, session, walletId);
    // Second wallet inside the same session — `factor` is establish-only.
    const res2 = ok(
      await h.call(
        "wallet.importMnemonic",
        {
          mnemonic: utf8ToBytes(
            "legal winner thank year wave sausage worth useful legal winner thank yellow",
          ),
        },
        session,
      ),
    );
    const walletId2 = strField(field(res2, "wallet"), "walletId");
    await createSession(h, session, walletId2);
    const before = ok(await h.call("sessions.list", null, session)) as unknown as unknown[];
    expect(before).toHaveLength(2);

    ok(await h.call("wallet.delete", { walletId, verify: PASSKEY() }, session));
    const list = ok(await h.call("sessions.list", null, session)) as unknown as Array<{
      walletId: string;
    }>;
    expect(list.map((a) => a.walletId)).toStrictEqual([walletId2]);
  });

  it("tampered session plaintext corrupts the vault on reconcile", async () => {
    const { h, session, walletId } = await setup(T0);
    await createSession(h, session, walletId);
    const image = await h.store.load();
    const record = mustSessionRecord(image);
    await h.store.commit([
      { op: "put-record", record: { ...record, sealed: flipByte(record.sealed) } },
    ]);
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
    expect(errCode(await h.call("session.touch", null, session))).toBe("integrity");
  });

  it("a malformed session-key header corrupts status", async () => {
    const { h, session, walletId } = await setup(T0);
    await createSession(h, session, walletId);
    const image = await h.store.load();
    const record = mustSessionRecord(image);
    await h.store.commit([{ op: "put-record", record: { ...record, header: '{"walletId":1}' } }]);
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
  });

  it("a known scheme's invalid scope corrupts status", async () => {
    const { h, session, walletId } = await setup(T0);
    await createSession(h, session, walletId);
    const image = await h.store.load();
    const record = mustSessionRecord(image);
    await h.store.commit([
      {
        op: "put-record",
        record: { ...record, header: record.header.replace('"Mainnet"', '"Devnet"') },
      },
    ]);
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
  });

  it("a resealed known-scheme record whose scope the scheme rejects corrupts status", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await createSession(h, session, walletId);
    /* Resealed under the DEK, so authentication passes — only the scheme's own parseScope can see
       that "Devnet" is wrong for hyperliquid-l1-agent. */
    await resealSession(h, address, {
      scheme: SCHEME,
      walletId,
      groupIndex: 0,
      owner: EVM_ADDRESS,
      scope: "Devnet",
      name: "bot-1",
      validUntil: T0 + DAY,
      createdAt: T0,
    });
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
  });
});

describe("unknown schemes stay inert", () => {
  /**
   * A stored session-key record under a scheme this build does not know: a real record's key is
   * resealed under the DEK with an unknown-scheme header — authentic through the AEAD binding.
   */
  async function injectUnknown(h: Harness, session: string, walletId: string): Promise<string> {
    const address = await createSession(h, session, walletId, { name: "future" });
    await resealSession(h, address, {
      scheme: "future-scheme",
      walletId,
      groupIndex: 0,
      owner: EVM_ADDRESS,
      scope: FUTURE_SCOPE,
      name: "future",
      validUntil: T0 + DAY,
      createdAt: T0,
    });
    return address;
  }

  it("unlocks healthy, lists as unsupported, cannot sign, deletes", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await injectUnknown(h, session, walletId);
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("unlocked");

    const list = ok(await h.call("sessions.list", null, session)) as unknown as Array<
      Record<string, unknown>
    >;
    expect(list).toStrictEqual([
      {
        address,
        scheme: "future-scheme",
        supported: false,
        scope: FUTURE_SCOPE,
        walletId,
        groupIndex: 0,
        owner: EVM_ADDRESS,
        name: "future",
        validUntil: T0 + DAY,
        createdAt: T0,
      },
    ]);

    expect(
      errCode(
        await h.call(
          "sessions.sign",
          { scheme: "future-scheme", address, params: { nonce: T0 } },
          session,
        ),
      ),
    ).toBe("unsupported");
    // The record's own scheme must be passed; signing with the known scheme is a mismatch.
    expect(
      errCode(
        await h.call(
          "sessions.sign",
          { scheme: SCHEME, address, params: { action: {}, nonce: T0 } },
          session,
        ),
      ),
    ).toBe("invalid-input");

    ok(await h.call("sessions.delete", { address }, session));
    const after = ok(await h.call("sessions.list", null, session)) as unknown as unknown[];
    expect(after).toHaveLength(0);
  });

  it("wallet.delete removes unknown-scheme records with the known ones", async () => {
    const { h, session, walletId } = await setup(T0);
    await createSession(h, session, walletId, { name: "known" });
    const address = await injectUnknown(h, session, walletId);
    await h.settle();
    const before = ok(await h.call("sessions.list", null, session)) as unknown as Array<{
      scheme: string;
    }>;
    expect(before.map((s) => s.scheme)).toStrictEqual([SCHEME, "future-scheme"]);

    ok(await h.call("wallet.delete", { walletId, verify: PASSKEY() }, session));
    const list = ok(await h.call("sessions.list", null, session)) as unknown as unknown[];
    expect(list).toHaveLength(0);
    const image = await h.store.load();
    expect(image.records.every((r) => r.id !== address.toLowerCase())).toBe(true);
  });

  it("an unknown-scheme record whose key is not its id latches integrity at unlock", async () => {
    const { h, session, walletId } = await setup(T0);
    const dek = await sessionDek(h);
    try {
      const forged = sealRecord(
        sealer,
        dek,
        SESSION_KIND,
        // A valid address that EVM_SECRET does not derive — authentic seal, false binding.
        `0x${"22".repeat(20)}`,
        encodeSessionHeader({
          scheme: "future-scheme",
          walletId,
          groupIndex: 0,
          owner: EVM_ADDRESS,
          scope: FUTURE_SCOPE,
          name: "forged",
          validUntil: T0 + DAY,
          createdAt: T0,
        }),
        new Uint8Array(EVM_SECRET),
      );
      await h.store.commit(
        withManifest(sealer, await h.store.load(), [{ op: "put-record", record: forged }], dek),
      );
    } finally {
      dek.wipe();
    }
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
    expect(errCode(await h.call("session.touch", null, session))).toBe("integrity");
  });
});

describe("ApproveAgent binding", () => {
  const approveDoc = (agent: string, name: string, chain = "Mainnet") =>
    JSON.stringify({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        "HyperliquidTransaction:ApproveAgent": [
          { name: "hyperliquidChain", type: "string" },
          { name: "agentAddress", type: "address" },
          { name: "agentName", type: "string" },
          { name: "nonce", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:ApproveAgent",
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 42161,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      message: {
        type: "approveAgent",
        signatureChainId: "0xa4b1",
        hyperliquidChain: chain,
        agentAddress: agent,
        agentName: name,
        nonce: T0,
      },
    });

  const approveRequest = (walletId: string, agent: string, name: string, chain = "Mainnet") =>
    normalizeEvm({
      kind: "evm.typed-data",
      network: "eip155:42161",
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      typedData: approveDoc(agent, name, chain),
    });

  const descriptions = (calls: ReadonlyArray<KeystoreCall>): string[] =>
    calls.flatMap((call) =>
      call.op === "open" && "prompt" in call && call.prompt !== undefined
        ? [call.prompt.description]
        : [],
    );

  async function keystoreSetup(): Promise<{
    h: Harness;
    fk: ReturnType<typeof fakeKeystore>;
    session: string;
    walletId: string;
  }> {
    const fk = fakeKeystore();
    const h = createHarness({ keystore: fk.keystore, start: T0 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: DEVICE,
      }),
    );
    return {
      h,
      fk,
      session: strField(res, "session"),
      walletId: strField(field(res, "wallet"), "walletId"),
    };
  }

  it("a locally held agent renders the held line and signs", async () => {
    const { h, fk, session, walletId } = await keystoreSetup();
    const validUntil = T0 + 180 * DAY;
    const agent = await createSession(h, session, walletId, { validUntil });
    ok(
      await h.call(
        "chain.sign",
        {
          request: approveRequest(walletId, agent, `bot-1 valid_until ${validUntil}`),
          verify: HARDWARE,
        },
        session,
      ),
    );
    expect(descriptions(fk.calls).at(-1)).toContain("The agent key is held by this wallet");
  });

  it("an unknown agent renders the not-held warning and signs", async () => {
    const { h, fk, session, walletId } = await keystoreSetup();
    ok(
      await h.call(
        "chain.sign",
        {
          request: approveRequest(
            walletId,
            "0x1234567890abcdef1234567890abcdef12345678",
            "other valid_until 1",
          ),
          verify: HARDWARE,
        },
        session,
      ),
    );
    expect(descriptions(fk.calls).at(-1)).toContain(
      "The agent key is not held by this wallet: whoever holds it can trade this account",
    );
  });

  it("a record that disagrees with the approval is refused", async () => {
    const { h, session, walletId } = await keystoreSetup();
    const validUntil = T0 + 180 * DAY;
    const agent = await createSession(h, session, walletId, { validUntil });
    for (const name of [
      "bot-1", // right name, missing the expiry the record holds
      `bot-1 valid_until ${validUntil + 1}`, // wrong expiry
      `bot-9 valid_until ${validUntil}`, // wrong name
    ]) {
      expect(
        errCode(
          // oxlint-disable-next-line eslint/no-await-in-loop -- sign calls run serially on the session
          await h.call(
            "chain.sign",
            { request: approveRequest(walletId, agent, name), verify: HARDWARE },
            session,
          ),
        ),
      ).toBe("invalid-input");
    }
    expect(
      errCode(
        await h.call(
          "chain.sign",
          {
            request: approveRequest(walletId, agent, `bot-1 valid_until ${validUntil}`, "Testnet"),
            verify: HARDWARE,
          },
          session,
        ),
      ),
    ).toBe("invalid-input");
  });

  it("a session record of another scheme at the agent address is refused", async () => {
    const { h, session, walletId } = await setup(T0);
    const validUntil = T0 + 180 * DAY;
    const agent = await createSession(h, session, walletId, { validUntil });
    /* Control: the same approval signs while the record's scheme is hyperliquid-l1-agent. */
    ok(
      await h.call(
        "chain.sign",
        {
          request: approveRequest(walletId, agent, `bot-1 valid_until ${validUntil}`),
          verify: PASSKEY(),
        },
        session,
      ),
    );
    /* Reseal under a scheme this build does not know — address, owner, scope, name and expiry all
       still match the approval, so only the scheme check can refuse it. */
    await resealSession(h, agent, {
      scheme: "future-scheme",
      walletId,
      groupIndex: 0,
      owner: EVM_ADDRESS,
      scope: "Mainnet",
      name: "bot-1",
      validUntil,
      createdAt: T0,
    });
    await h.settle();
    expect(
      errCode(
        await h.call(
          "chain.sign",
          {
            request: approveRequest(walletId, agent, `bot-1 valid_until ${validUntil}`),
            verify: PASSKEY(),
          },
          session,
        ),
      ),
    ).toBe("invalid-input");
  });
});
