/**
 * The Hyperliquid apps module: `hl-agent` lifecycle, deterministic msgpack, L1 phantom-agent
 * signing against the oracle vectors, agent key isolation, and the ApproveAgent binding.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { evmAddressFromPublicKey, normalizeEvm } from "@qntx/wallet-chains/evm";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { signL1 } from "../src/modules/apps/agents.ts";
import { createAppsModule } from "../src/modules/apps/index.ts";
import { l1ConnectionId } from "../src/modules/apps/l1.ts";
import { packArray, packBool, packInt, packMap, packStr } from "../src/modules/apps/msgpack.ts";
import { encodeAgentHeader, findAgent, HL_AGENT_KIND } from "../src/modules/apps/record.ts";
import { Secret } from "../src/secret/secret.ts";
import type { VaultImage } from "../src/vault/store.ts";
import { sealRecord } from "../src/vault/vault.ts";
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
  owner: { walletId, groupIndex: 0 },
  network: "Mainnet",
  name: "bot-1",
  validUntil: T0 + DAY,
  ...extra,
});

async function createAgent(
  h: Harness,
  session: string,
  walletId: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const res = ok(await h.call("hyperliquid.createAgent", createParams(walletId, extra), session));
  return strField(res, "address");
}

const agentRecord = (image: {
  records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: Uint8Array }>;
}) => image.records.find((r) => r.kind === HL_AGENT_KIND);

const mustAgentRecord = (image: {
  records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: Uint8Array }>;
}) => {
  const record = agentRecord(image);
  if (record === undefined) {
    throw new Error("missing agent record");
  }
  return record;
};

const flipByte = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(bytes);
  out[0] = (out[0] ?? 0) ^ 0xff;
  return out;
};

/**
 * Every `key` record id is 16-hex — the structural proof a kind+id lookup can never reach an
 * agent's `0x`-prefixed 40-hex id.
 */
const keyIdsAre16Hex = (image: { records: ReadonlyArray<{ kind: string; id: string }> }) =>
  image.records.every((r) => r.kind !== "key" || /^[0-9a-f]{16}$/.test(r.id));

/**
 * A Random that serves `key` for 32-byte draws made while armed and deterministic bytes otherwise —
 * platform.random is also the seal-nonce source, so the oracle key goes only to the draw inside
 * createAgent.
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

/** L1ConnectionId args for a vector: optional fields appear only when the vector carries them. */
const l1IdArgs = (vector: L1Case) => ({
  action: vector.action as never,
  nonce: vector.nonce,
  ...(vector.vaultAddress === undefined ? {} : { vaultAddress: vector.vaultAddress }),
  ...(vector.expiresAfter === undefined ? {} : { expiresAfter: vector.expiresAfter }),
});

/** SignL1 params for a vector. */
const l1SignParams = (agent: string, vector: L1Case) => ({ agent, ...l1IdArgs(vector) });

const l1Cases = (loadVectors("chains/hyperliquid.json") as { l1: L1Case[] }).l1;
const allowListed = l1Cases.filter((c) => c.action["type"] !== "dummy");
const dummies = l1Cases.filter((c) => c.action["type"] === "dummy");

describe("msgpack writer: branch boundaries", () => {
  const hex = (bytes: Uint8Array): string => bytesToHex(bytes);
  const ints: ReadonlyArray<[number, string]> = [
    [0, "00"],
    [127, "7f"],
    [128, "cc80"],
    [255, "ccff"],
    [256, "cd0100"],
    [65535, "cdffff"],
    [65536, "ce00010000"],
    [4294967295, "ceffffffff"],
    [4294967296, "cf0000000100000000"],
    [-1, "ff"],
    [-32, "e0"],
    [-33, "d0df"],
    [-128, "d080"],
    [-129, "d1ff7f"],
    [-32768, "d18000"],
    [-32769, "d2ffff7fff"],
    [-2147483648, "d280000000"],
    [-2147483649, "d3ffffffff7fffffff"],
  ];

  it.each(ints)("packInt(%i) uses the smallest encoding", (value, expected) => {
    expect(hex(packInt(value))).toBe(expected);
  });

  it("packInt rejects non-integers and unsafe values", () => {
    for (const value of [0.5, Number.NaN, 2 ** 53, -(2 ** 53)]) {
      expect(() => packInt(value)).toThrow("unreachable: non-integer msgpack field");
    }
  });

  it("packStr uses fixstr under 32 bytes and str 8/16 above", () => {
    const s = (n: number) => "a".repeat(n);
    expect(hex(packStr(s(31)))).toBe(`bf${"61".repeat(31)}`);
    expect(hex(packStr(s(32)))).toBe(`d920${"61".repeat(32)}`);
    expect(hex(packStr(s(255)))).toBe(`d9ff${"61".repeat(255)}`);
    expect(hex(packStr(s(256)))).toBe(`da0100${"61".repeat(256)}`);
  });

  it("packBool is the two literal bytes", () => {
    expect(hex(packBool(false))).toBe("c2");
    expect(hex(packBool(true))).toBe("c3");
  });

  it("packArray uses fixarray under 16 entries and array 16 above", () => {
    const items = (n: number) => Array.from({ length: n }, () => packInt(0));
    expect(hex(packArray(items(15)))).toBe(`9f${"00".repeat(15)}`);
    expect(hex(packArray(items(16)))).toBe(`dc0010${"00".repeat(16)}`);
  });

  it("packMap uses fixmap under 16 entries and map 16 above", () => {
    expect(hex(packMap([["k", packInt(1)]]))).toBe("81a16b01");
    const entries = (n: number) =>
      Array.from({ length: n }, (_, i) => [`k${i}`, packInt(i)] as const);
    expect(hex(packMap(entries(15)))).toBe(
      `8f${entries(15)
        .map(([k, v]) => `${hex(packStr(k))}${hex(v)}`)
        .join("")}`,
    );
    expect(hex(packMap(entries(16)))).toBe(
      `de0010${entries(16)
        .map(([k, v]) => `${hex(packStr(k))}${hex(v)}`)
        .join("")}`,
    );
  });
});

describe("L1 connectionId against the oracle vectors", () => {
  it.each(allowListed)("$name", (vector) => {
    expect(bytesToHex(l1ConnectionId(l1IdArgs(vector)))).toBe(vector.connectionId.slice(2));
  });
});

describe("hyperliquid.signL1 against the oracle vectors", () => {
  it.each(allowListed)("$name signs byte-identically", async (vector) => {
    const keyBytes = hexToBytes(vector.privateKey.slice(2));
    const expectedAgent = evmAddressFromPublicKey(
      secp256k1.getPublicKey(keyBytes, true),
    ).toLowerCase();
    const injected = injectingRandom(keyBytes);
    const h = createHarness({ start: vector.nonce, random: injected.random });
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
        "hyperliquid.createAgent",
        {
          owner: { walletId, groupIndex: 0 },
          network: vector.network,
          name: "bot-1",
          validUntil: vector.nonce + DAY,
        },
        session,
      ),
    );
    injected.arm(false);
    const agent = strField(created, "address").toLowerCase();
    expect(agent).toBe(expectedAgent);
    const signed = ok(await h.call("hyperliquid.signL1", l1SignParams(agent, vector), session));
    expect(bytesToHex(bytesField(signed, "signature"))).toBe(vector.signature.slice(2));
  });

  it.each(dummies)("$name is rejected as invalid-input", async (vector) => {
    const { h, session, walletId } = await setup(vector.nonce);
    const agent = await createAgent(h, session, walletId, {
      validUntil: vector.nonce + DAY,
    });
    expect(
      errCode(
        await h.call(
          "hyperliquid.signL1",
          { agent, action: vector.action, nonce: vector.nonce },
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
    agent: string,
    action: unknown,
  ): Promise<string | undefined> =>
    errCode(await h.call("hyperliquid.signL1", { agent, action, nonce: T0 }, session));

  async function withAgent(
    run: (h: Harness, session: string, agent: string) => Promise<void>,
  ): Promise<void> {
    const { h, session, walletId } = await setup(T0);
    const agent = await createAgent(h, session, walletId);
    await run(h, session, agent);
  }

  it.each([
    { type: "order", orders: [order], grouping: "na" },
    { type: "cancel", cancels: [{ a: 0, o: 1 }] },
    { type: "cancel", cancels: [{ a: 0, o: 1 }], f: true },
    { type: "cancelByCloid", cancels: [{ asset: 0, cloid: `0x${"00".repeat(16)}` }] },
    { type: "modify", oid: 1, order },
    { type: "modify", oid: `0x${"00".repeat(16)}`, order, a: true },
    { type: "batchModify", modifies: [{ oid: 1, order }] },
    { type: "scheduleCancel" },
    { type: "scheduleCancel", time: 1 },
    { type: "updateLeverage", asset: 0, isCross: true, leverage: 5 },
    { type: "updateIsolatedMargin", asset: 0, isBuy: true, ntli: -100 },
    { type: "twapOrder", twap: { a: 0, b: true, s: "1", r: false, m: 30, t: false } },
    { type: "twapCancel", a: 0, t: 1 },
  ])("allow-listed action %j is accepted", async (action) => {
    await withAgent(async (h, session, agent) => {
      await expect(sign(h, session, agent, action)).resolves.toBeUndefined();
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
    await withAgent(async (h, session, agent) => {
      await expect(sign(h, session, agent, action)).resolves.toBe("invalid-input");
    });
  });

  it.each([
    ["{p} grouping", { type: "order", orders: [order], grouping: { p: 1 } }],
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
    await withAgent(async (h, session, agent) => {
      await expect(sign(h, session, agent, action)).resolves.toBe("invalid-input");
    });
  });
});

describe("hl-agent lifecycle", () => {
  it("create/list/delete round trip with header fields and derived owner", async () => {
    const { h, session, walletId } = await setup(T0);
    const address = await createAgent(h, session, walletId, {
      network: "Testnet",
      name: "bot-2",
      validUntil: T0 + 30 * DAY,
    });
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(address).not.toBe(address.toLowerCase());

    const image = await h.store.load();
    const record = agentRecord(image);
    expect(record?.id).toBe(address.toLowerCase());
    expect(record?.header).toBe(
      `{"walletId":"${walletId}","groupIndex":0,"owner":"${EVM_ADDRESS}","network":"Testnet","name":"bot-2","validUntil":${T0 + 30 * DAY},"createdAt":${T0}}`,
    );

    const list = ok(await h.call("hyperliquid.listAgents", null, session)) as unknown as Array<
      Record<string, unknown>
    >;
    expect(list).toStrictEqual([
      {
        address,
        owner: EVM_ADDRESS,
        walletId,
        groupIndex: 0,
        network: "Testnet",
        name: "bot-2",
        validUntil: T0 + 30 * DAY,
        createdAt: T0,
      },
    ]);

    ok(await h.call("hyperliquid.deleteAgent", { address }, session));
    const after = ok(await h.call("hyperliquid.listAgents", null, session)) as unknown as unknown[];
    expect(after).toHaveLength(0);
    expect(errCode(await h.call("hyperliquid.deleteAgent", { address }, session))).toBe(
      "not-found",
    );
  });

  it.each([
    ["now", T0, "invalid-input"],
    ["past", T0 - 1, "invalid-input"],
    ["now + 180d", T0 + 180 * DAY, undefined],
    ["now + 180d + 1", T0 + 180 * DAY + 1, "invalid-input"],
  ])("validUntil %s → %s", async (_label, validUntil, code) => {
    const { h, session, walletId } = await setup(T0);
    expect(
      errCode(
        await h.call("hyperliquid.createAgent", createParams(walletId, { validUntil }), session),
      ),
    ).toBe(code);
  });

  it("caps live agents at 16", async () => {
    const { h, session, walletId } = await setup(T0);
    for (let i = 0; i < 16; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- creates run serially on the session
      await createAgent(h, session, walletId, { name: `bot-${i}` });
    }
    expect(
      errCode(
        await h.call(
          "hyperliquid.createAgent",
          createParams(walletId, { name: "bot-16" }),
          session,
        ),
      ),
    ).toBe("conflict");
    const list = ok(await h.call("hyperliquid.listAgents", null, session)) as unknown as unknown[];
    expect(list).toHaveLength(16);
  });

  it("createAgent needs a live session and a real wallet", async () => {
    const { h, session, walletId } = await setup(T0);
    expect(
      errCode(await h.call("hyperliquid.createAgent", createParams(walletId), "00".repeat(16))),
    ).toBe("locked");
    expect(
      errCode(await h.call("hyperliquid.createAgent", createParams("ff".repeat(8)), session)),
    ).toBe("not-found");
  });
});

describe("hyperliquid.signL1 checks", () => {
  const orderAction = {
    type: "order",
    orders: [{ a: 0, b: true, p: "30000", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } }],
    grouping: "na",
  };

  it("a foreign session cannot sign", async () => {
    const { h, session, walletId } = await setup(T0);
    const agent = await createAgent(h, session, walletId);
    expect(
      errCode(
        await h.call(
          "hyperliquid.signL1",
          { agent, action: orderAction, nonce: T0 },
          "00".repeat(16),
        ),
      ),
    ).toBe("locked");
  });

  it("a session that idled out cannot sign with a previously valid agent", async () => {
    const { h, session, walletId } = await setup(T0);
    const agent = await createAgent(h, session, walletId);
    h.advance(15 * 60_000 + 1);
    await h.settle();
    expect(
      errCode(
        await h.call("hyperliquid.signL1", { agent, action: orderAction, nonce: T0 }, session),
      ),
    ).toBe("locked");
  });

  it("an expired agent cannot sign", async () => {
    const { h, session, walletId } = await setup(T0);
    const agent = await createAgent(h, session, walletId, { validUntil: T0 + 1000 });
    h.advanceWall(1000); // now == validUntil ⇒ expired
    expect(
      errCode(
        await h.call(
          "hyperliquid.signL1",
          { agent, action: orderAction, nonce: h.wallNow() },
          session,
        ),
      ),
    ).toBe("invalid-input");
    h.advanceWall(1000);
    expect(
      errCode(
        await h.call(
          "hyperliquid.signL1",
          { agent, action: orderAction, nonce: h.wallNow() },
          session,
        ),
      ),
    ).toBe("invalid-input");
  });

  it.each([
    ["+300_000", 300_000, undefined],
    ["+300_001", 300_001, "invalid-input"],
    ["-300_000", -300_000, undefined],
    ["-300_001", -300_001, "invalid-input"],
  ])("nonce %s of now → %s", async (_label, delta, code) => {
    const { h, session, walletId } = await setup(T0);
    const agent = await createAgent(h, session, walletId, { validUntil: T0 + 400_000 });
    expect(
      errCode(
        await h.call(
          "hyperliquid.signL1",
          { agent, action: orderAction, nonce: T0 + delta },
          session,
        ),
      ),
    ).toBe(code);
  });

  it("an imported key's address and the HD account's address are not agents", async () => {
    const { h, session } = await setup(T0);
    const imported = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session),
    );
    const importedAddress = strField(imported, "address").toLowerCase();
    for (const agent of [importedAddress, EVM_ADDRESS.toLowerCase()]) {
      expect(
        errCode(
          // oxlint-disable-next-line eslint/no-await-in-loop -- agent lookups are sequential
          await h.call("hyperliquid.signL1", { agent, action: orderAction, nonce: T0 }, session),
        ),
      ).toBe("not-found");
    }
  });
});

describe("agent defense-in-depth checks", () => {
  const imageOf = (
    ...records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: Uint8Array }>
  ): VaultImage => ({ meta: undefined, records: [...records], factors: [] });

  it("findAgent only matches hl-agent records — a `key` record is never an agent", () => {
    const image = imageOf(
      { kind: "key", id: `0x${"ab".repeat(20)}`, header: "{}", sealed: new Uint8Array(1) },
      {
        kind: HL_AGENT_KIND,
        id: `0x${"cd".repeat(20)}`,
        header: "{}",
        sealed: new Uint8Array(1),
      },
    );
    expect(findAgent(image, `0x${"ab".repeat(20)}`)).toBeUndefined();
    expect(findAgent(image, `0x${"cd".repeat(20)}`)).toBeDefined();
  });

  it("claimUnlocked latches corrupted when the sealed key is not the record id", () => {
    const { vault } = createAppsModule();
    const key = new Uint8Array(32).fill(9); // a valid secret whose address is not 0x00…
    expect(() =>
      vault.claimUnlocked([{ kind: HL_AGENT_KIND, id: `0x${"00".repeat(20)}`, plaintext: key }]),
    ).toThrow("agent key does not match its record");
  });

  it("claimUnlocked claims a well-formed agent and returns the rest", () => {
    const { vault } = createAppsModule();
    const key = new Uint8Array(EVM_SECRET);
    const id = evmAddressFromPublicKey(secp256k1.getPublicKey(key, true)).toLowerCase();
    const other = { kind: "key", id: "0123456789abcdef", plaintext: new Uint8Array(32) };
    const rest = vault.claimUnlocked([{ kind: HL_AGENT_KIND, id, plaintext: key }, other]);
    expect(rest).toStrictEqual([other]);
  });

  it("signL1 refuses a record whose sealed key is not the record id", () => {
    const dek = Secret.take(new Uint8Array(32).fill(7));
    const platform = {
      now: () => T0,
      random: (n: number) => new Uint8Array(n),
    };
    const wrongId = `0x${"00".repeat(20)}`;
    const record = sealRecord(
      platform as never,
      dek,
      HL_AGENT_KIND,
      wrongId,
      encodeAgentHeader({
        walletId: "aa".repeat(8),
        groupIndex: 0,
        owner: EVM_ADDRESS,
        network: "Mainnet",
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
    } as unknown as Parameters<typeof signL1>[0];
    expect((): unknown =>
      signL1(
        ctx,
        {
          agent: wrongId,
          action: {
            type: "order",
            orders: [{ a: 0, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Gtc" } } }],
            grouping: "na",
          },
          nonce: T0,
        },
        "00".repeat(16),
      ),
    ).toThrow("agent key does not match its record");
  });
});

describe("agent key isolation", () => {
  it("keys.list/export/remove never see agents", async () => {
    const { h, session, walletId } = await setup(T0);
    const agent = await createAgent(h, session, walletId);
    const list = ok(await h.call("keys.list", null, session)) as unknown as unknown[];
    expect(list).toHaveLength(0);
    // The `0x`-prefixed address fails the 16-hex keyId envelope shape.
    expect(errCode(await h.call("keys.export", { verify: PASSKEY(), keyId: agent }, session))).toBe(
      "integrity",
    );
    expect(errCode(await h.call("keys.remove", { verify: PASSKEY(), keyId: agent }, session))).toBe(
      "integrity",
    );
    // And a well-formed id colliding with nothing answers not-found.
    expect(
      errCode(
        await h.call(
          "keys.export",
          { verify: PASSKEY(), keyId: agent.toLowerCase().slice(2, 18) },
          session,
        ),
      ),
    ).toBe("not-found");
  });

  it("chain.sign imported lookup cannot reach an agent record", async () => {
    const { h, session, walletId } = await setup(T0);
    const agent = await createAgent(h, session, walletId);
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "m", type: "string" }],
      },
      domain: { name: "X" },
      primaryType: "Mail",
      message: { m: "hi" },
    });
    // The agent record id is a `0x`-prefixed 40-hex address; the imported keyId validator accepts
    // only 16-hex, so the address form is rejected at the envelope — before any record lookup.
    const requests = [
      normalizeEvm({
        kind: "evm.typed-data",
        network: "eip155:1",
        account: { kind: "imported", keyId: agent, family: "evm" },
        typedData,
      }),
      normalizeEvm({
        kind: "evm.personal-message",
        network: "eip155:1",
        account: { kind: "imported", keyId: agent, family: "evm" },
        message: utf8ToBytes("hi"),
      }),
      normalizeEvm({
        kind: "evm.transaction",
        network: "eip155:1",
        account: { kind: "imported", keyId: agent, family: "evm" },
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
    // …and every `key` record id is 16-hex, so kind+id lookup can never land on an agent id.
    const image = await h.store.load();
    expect(keyIdsAre16Hex(image)).toBe(true);
  });

  it("backups never contain agents", async () => {
    const { h, session, walletId } = await setup(T0);
    await createAgent(h, session, walletId);
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
    const list = ok(
      await restored.call("hyperliquid.listAgents", null, session2),
    ) as unknown as unknown[];
    expect(list).toHaveLength(0);
    const image = await restored.store.load();
    expect(image.records.every((r) => r.kind !== HL_AGENT_KIND)).toBe(true);
  });

  it("wallet.delete removes that wallet's agents only", async () => {
    const { h, session, walletId } = await setup(T0);
    await createAgent(h, session, walletId);
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
    await createAgent(h, session, walletId2);
    const before = ok(
      await h.call("hyperliquid.listAgents", null, session),
    ) as unknown as unknown[];
    expect(before).toHaveLength(2);

    ok(await h.call("wallet.delete", { walletId, verify: PASSKEY() }, session));
    const list = ok(await h.call("hyperliquid.listAgents", null, session)) as unknown as Array<{
      walletId: string;
    }>;
    expect(list.map((a) => a.walletId)).toStrictEqual([walletId2]);
  });

  it("tampered agent plaintext corrupts the vault on reconcile", async () => {
    const { h, session, walletId } = await setup(T0);
    await createAgent(h, session, walletId);
    const image = await h.store.load();
    const record = mustAgentRecord(image);
    await h.store.commit([
      { op: "put-record", record: { ...record, sealed: flipByte(record.sealed) } },
    ]);
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
    expect(errCode(await h.call("session.touch", null, session))).toBe("integrity");
  });

  it("a malformed hl-agent header corrupts status", async () => {
    const { h, session, walletId } = await setup(T0);
    await createAgent(h, session, walletId);
    const image = await h.store.load();
    const record = mustAgentRecord(image);
    await h.store.commit([{ op: "put-record", record: { ...record, header: '{"walletId":1}' } }]);
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
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
    const agent = await createAgent(h, session, walletId, { validUntil });
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
    const agent = await createAgent(h, session, walletId, { validUntil });
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
});
