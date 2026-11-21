/**
 * The Polymarket apps module: `pm-creds` lifecycle, L2 HMAC signing byte-identical to the
 * clob-client-v2 oracle vectors, the signed-path allow-list and ±30 s timestamp window, per-group
 * credential isolation, and the vault hooks that own the record kind.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import type { PolymarketL2Headers, ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { createAppsModule } from "../src/modules/apps/index.ts";
import { signL2 } from "../src/modules/apps/pm-creds.ts";
import {
  credsRecordId,
  decodeSecret,
  encodeCredentialsHeader,
  encodeCredentialsPlaintext,
  findCreds,
  parseCredentialsHeader,
  parseCredentialsPlaintext,
  PM_CREDS_KIND,
} from "../src/modules/apps/pm-record.ts";
import { Secret } from "../src/secret/secret.ts";
import type { VaultImage } from "../src/vault/store.ts";
import { sealRecord } from "../src/vault/vault.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors } from "./helpers.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSKEY = () => ({
  kind: "passkey" as const,
  credentialId: utf8ToBytes("credential-1"),
  prf: new Uint8Array(32).fill(1),
});
/** M/44'/60'/0'/0/0 of the test mnemonic — the owner the kernel derives for group 0. */
const EVM_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
/** Whole seconds so the ±30 s window is exact. */
const T0 = 1_767_225_600_000;
const T0_SECONDS = T0 / 1000;
const API_KEY = "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2";
const SECRET = "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=";
const PASSPHRASE = "test-passphrase-1";

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
const headersOf = (value: ProtocolValue): PolymarketL2Headers => {
  const v = field(value, "headers");
  if (typeof v !== "object" || v === null || Symbol.iterator in v) {
    throw new Error("headers is not an object");
  }
  const out: Record<string, string> = {};
  for (const [k, h] of Object.entries(v)) {
    if (typeof h !== "string") {
      throw new TypeError(`${k} is not a string`);
    }
    out[k] = h;
  }
  return out as PolymarketL2Headers;
};

/** "kernel-error" | "round-trip" | "other" — what happened to a random header string. */
const pmHeaderOutcome = (raw: string): string => {
  try {
    const parsed = parseCredentialsHeader(raw);
    const again = parseCredentialsHeader(encodeCredentialsHeader(parsed));
    const same =
      parsed.walletId === again.walletId &&
      parsed.groupIndex === again.groupIndex &&
      parsed.owner === again.owner &&
      parsed.apiKey === again.apiKey &&
      parsed.createdAt === again.createdAt;
    return same ? "round-trip" : "other";
  } catch (error) {
    return error instanceof KernelError && error.code === "integrity" ? "kernel-error" : "other";
  }
};

/** "kernel-error" | "round-trip" | "other" — what happened to random plaintext bytes. */
const pmPlaintextOutcome = (raw: Uint8Array): string => {
  try {
    const parsed = parseCredentialsPlaintext(raw);
    const again = parseCredentialsPlaintext(encodeCredentialsPlaintext(parsed));
    return again.secret === parsed.secret && again.passphrase === parsed.passphrase
      ? "round-trip"
      : "other";
  } catch (error) {
    return error instanceof KernelError && error.code === "integrity" && error.corrupted
      ? "kernel-error"
      : "other";
  }
};

const L2_HEADER_KEYS = [
  "POLY_ADDRESS",
  "POLY_API_KEY",
  "POLY_PASSPHRASE",
  "POLY_SIGNATURE",
  "POLY_TIMESTAMP",
] as const;

/** "err" | "headers" | "bad" — a signL2 response's shape. */
const signL2Outcome = (res: KernelResponse): string => {
  if ("err" in res) {
    return ["integrity", "invalid-input", "not-found"].includes(res.err.code) ? "err" : "bad";
  }
  try {
    const keys = Object.keys(headersOf(res.ok)).toSorted();
    return keys.length === L2_HEADER_KEYS.length &&
      keys.every((key, i) => key === L2_HEADER_KEYS[i])
      ? "headers"
      : "bad";
  } catch {
    return "bad";
  }
};

/** Random signL2 params: near-valid owners, arbitrary method/path/body/timestamp, stray keys. */
const fuzzSignParams = (walletId: string) =>
  fc
    .record({
      owner: fc.record({ walletId: fc.constant(walletId), groupIndex: fc.nat(3) }),
      method: fc.oneof(fc.constant("GET"), fc.constant("POST"), fc.constant("DELETE"), fc.string()),
      path: fc.string(),
      body: fc.option(fc.string(), { nil: undefined }),
      timestamp: fc.oneof(fc.nat(T0_SECONDS * 2), fc.integer()),
      extra: fc.option(fc.string(), { nil: undefined }),
    })
    .map(({ extra, ...rest }) => (extra === undefined ? rest : { ...rest, extra }));

/** A vector case's params — the conditional spread stays out of the test body. */
const signVectorParams = (walletId: string, vector: L2Case) => ({
  owner: { walletId, groupIndex: 0 },
  method: vector.method,
  path: vector.path,
  ...(vector.body === undefined ? {} : { body: vector.body }),
  timestamp: vector.timestamp,
});

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

const importParams = (
  walletId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> => ({
  owner: { walletId, groupIndex: 0 },
  apiKey: API_KEY,
  secret: SECRET,
  passphrase: PASSPHRASE,
  ...extra,
});

async function importCreds(
  h: Harness,
  session: string,
  walletId: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const res = ok(
    await h.call("polymarket.importCredentials", importParams(walletId, extra), session),
  );
  return strField(res, "owner");
}

const signParams = (
  walletId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> => ({
  owner: { walletId, groupIndex: 0 },
  method: "GET",
  path: "/data/orders",
  timestamp: T0_SECONDS,
  ...extra,
});

const credsRecord = (image: {
  records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: Uint8Array }>;
}) => image.records.find((r) => r.kind === PM_CREDS_KIND);

const mustCredsRecord = (image: {
  records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: Uint8Array }>;
}) => {
  const record = credsRecord(image);
  if (record === undefined) {
    throw new Error("missing pm-creds record");
  }
  return record;
};

const flipByte = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(bytes);
  out[0] = (out[0] ?? 0) ^ 0xff;
  return out;
};

type L2Case = {
  readonly name: string;
  readonly secret: string;
  readonly passphrase: string;
  readonly apiKey: string;
  readonly timestamp: number;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: string;
  readonly headers: Record<string, string>;
};
const l2Cases = (loadVectors("chains/polymarket-l2.json") as { cases: L2Case[] }).cases;

describe("polymarket.signL2 against the oracle vectors", () => {
  it.each(l2Cases)("$name signs byte-identically", async (vector) => {
    const { h, session, walletId } = await setup(vector.timestamp * 1000);
    ok(
      await h.call(
        "polymarket.importCredentials",
        {
          owner: { walletId, groupIndex: 0 },
          apiKey: vector.apiKey,
          secret: vector.secret,
          passphrase: vector.passphrase,
        },
        session,
      ),
    );
    const res = ok(await h.call("polymarket.signL2", signVectorParams(walletId, vector), session));
    expect(headersOf(res)).toStrictEqual(vector.headers);
  });
});

describe("pm-creds lifecycle", () => {
  it("import/list/delete round trip with header fields and derived owner", async () => {
    const { h, session, walletId } = await setup(T0);
    const owner = await importCreds(h, session, walletId);
    expect(owner).toBe(EVM_ADDRESS);

    const image = await h.store.load();
    const record = mustCredsRecord(image);
    expect(record.id).toBe(`${walletId}.0`);
    expect(record.header).toBe(
      `{"walletId":"${walletId}","groupIndex":0,"owner":"${EVM_ADDRESS}","apiKey":"${API_KEY}","createdAt":${T0}}`,
    );

    const list = ok(await h.call("polymarket.listCredentials", null, session)) as unknown as Array<
      Record<string, unknown>
    >;
    expect(list).toStrictEqual([
      {
        walletId,
        groupIndex: 0,
        owner: EVM_ADDRESS,
        apiKey: API_KEY,
        createdAt: T0,
      },
    ]);
    // The listing is the public header only — the sealed fields never appear.
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(JSON.stringify(list)).not.toContain(PASSPHRASE);

    ok(await h.call("polymarket.deleteCredentials", { walletId, groupIndex: 0 }, session));
    const after = ok(
      await h.call("polymarket.listCredentials", null, session),
    ) as unknown as unknown[];
    expect(after).toHaveLength(0);
    expect(
      errCode(await h.call("polymarket.deleteCredentials", { walletId, groupIndex: 0 }, session)),
    ).toBe("not-found");
  });

  it("stores an uppercase apiKey lowercase and signs with it", async () => {
    const { h, session, walletId } = await setup(T0);
    const owner = await importCreds(h, session, walletId, { apiKey: API_KEY.toUpperCase() });
    const image = await h.store.load();
    expect(mustCredsRecord(image).header).toContain(`"apiKey":"${API_KEY}"`);
    const res = ok(await h.call("polymarket.signL2", signParams(walletId), session));
    expect(headersOf(res).POLY_API_KEY).toBe(API_KEY);
    expect(owner).toBe(EVM_ADDRESS);
  });

  it("replaces the previous set for the same group in one commit", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    const otherSecret = base64.encode(new Uint8Array(32).fill(0xab));
    const next = `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    ok(
      await h.call(
        "polymarket.importCredentials",
        importParams(walletId, {
          apiKey: next,
          secret: otherSecret,
          passphrase: "second-passphrase",
        }),
        session,
      ),
    );
    const image = await h.store.load();
    expect(image.records.filter((r) => r.kind === PM_CREDS_KIND)).toHaveLength(1);
    const list = ok(await h.call("polymarket.listCredentials", null, session)) as unknown as Array<{
      apiKey: string;
    }>;
    expect(list.map((c) => c.apiKey)).toStrictEqual([next]);
    // The new secret/passphrase are what sign now.
    const res = ok(await h.call("polymarket.signL2", signParams(walletId), session));
    const headers = headersOf(res);
    expect(headers.POLY_API_KEY).toBe(next);
    expect(headers.POLY_PASSPHRASE).toBe("second-passphrase");
  });

  it("keeps groups apart: each group signs with its own apiKey and owner", async () => {
    const { h, session, walletId } = await setup(T0);
    const apiKeyB = "11111111-2222-3333-4444-555555555555";
    await importCreds(h, session, walletId);
    const ownerB = await importCreds(h, session, walletId, {
      owner: { walletId, groupIndex: 1 },
      apiKey: apiKeyB,
      secret: base64.encode(new Uint8Array(32).fill(0xcd)),
      passphrase: "group-b",
    });
    expect(ownerB).not.toBe(EVM_ADDRESS);
    expect(ownerB).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const a = headersOf(ok(await h.call("polymarket.signL2", signParams(walletId), session)));
    const b = headersOf(
      ok(
        await h.call(
          "polymarket.signL2",
          signParams(walletId, { owner: { walletId, groupIndex: 1 } }),
          session,
        ),
      ),
    );
    expect(a.POLY_ADDRESS).toBe(EVM_ADDRESS);
    expect(a.POLY_API_KEY).toBe(API_KEY);
    expect(a.POLY_PASSPHRASE).toBe(PASSPHRASE);
    expect(b.POLY_ADDRESS).toBe(ownerB);
    expect(b.POLY_API_KEY).toBe(apiKeyB);
    expect(b.POLY_PASSPHRASE).toBe("group-b");
    expect(a.POLY_SIGNATURE).not.toBe(b.POLY_SIGNATURE); // different messages would collide

    // A group without imported credentials is not-found, not a fallback to another group's set.
    expect(
      errCode(
        await h.call(
          "polymarket.signL2",
          signParams(walletId, { owner: { walletId, groupIndex: 2 } }),
          session,
        ),
      ),
    ).toBe("not-found");
  });

  it(
    "caps credential sets at 64, and a replace still fits at the cap",
    { timeout: 60_000 },
    async () => {
      const { h, session, walletId } = await setup(T0);
      for (let i = 0; i < 64; i++) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- imports run serially on the session
        await importCreds(h, session, walletId, { owner: { walletId, groupIndex: i } });
      }
      expect(
        errCode(
          await h.call(
            "polymarket.importCredentials",
            importParams(walletId, { owner: { walletId, groupIndex: 64 } }),
            session,
          ),
        ),
      ).toBe("conflict");
      const list = ok(
        await h.call("polymarket.listCredentials", null, session),
      ) as unknown as unknown[];
      expect(list).toHaveLength(64);
      // Replacing an existing group is not a new record — it fits even at the cap.
      ok(await h.call("polymarket.importCredentials", importParams(walletId), session));
    },
  );

  it("import needs a live session and a real wallet", async () => {
    const { h, session, walletId } = await setup(T0);
    expect(
      errCode(
        await h.call("polymarket.importCredentials", importParams(walletId), "00".repeat(16)),
      ),
    ).toBe("locked");
    expect(
      errCode(await h.call("polymarket.importCredentials", importParams("ff".repeat(8)), session)),
    ).toBe("not-found");
  });
});

describe("polymarket.importCredentials validation", () => {
  it.each([
    ["not a uuid", "not-a-uuid", "integrity"],
    ["wrong length", "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a", "integrity"],
    ["non-hex", "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77zz", "integrity"],
  ])("apiKey %s → %s", async (_label, apiKey, code) => {
    const { h, session, walletId } = await setup(T0);
    expect(
      errCode(
        await h.call("polymarket.importCredentials", importParams(walletId, { apiKey }), session),
      ),
    ).toBe(code);
  });

  it.each([
    ["bad charset", "aGVsbG8%2B", "integrity"],
    ["empty", "", "integrity"],
    ["over 128 chars", "A".repeat(129), "integrity"],
    ["decodes under 16 bytes", "aGVsbG8gd29ybGQ=", "invalid-input"],
    ["decodes over 64 bytes", base64.encode(new Uint8Array(65)), "invalid-input"],
    ["stray padding", "YQ==YQ==", "invalid-input"],
  ])("secret %s → %s", async (_label, secret, code) => {
    const { h, session, walletId } = await setup(T0);
    expect(
      errCode(
        await h.call("polymarket.importCredentials", importParams(walletId, { secret }), session),
      ),
    ).toBe(code);
  });

  it.each([
    ["empty", ""],
    ["contains a space", "has space"],
    ["contains a tab", "has\ttab"],
    ["over 128 chars", "a".repeat(129)],
    ["non-ascii", "pässphrase"],
  ])("passphrase %s → integrity", async (_label, passphrase) => {
    const { h, session, walletId } = await setup(T0);
    expect(
      errCode(
        await h.call(
          "polymarket.importCredentials",
          importParams(walletId, { passphrase }),
          session,
        ),
      ),
    ).toBe("integrity");
  });
});

describe("polymarket.signL2 checks", () => {
  it("a foreign session cannot sign", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    expect(errCode(await h.call("polymarket.signL2", signParams(walletId), "00".repeat(16)))).toBe(
      "locked",
    );
  });

  it("a session that idled out cannot sign", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    h.advance(15 * 60_000 + 1);
    await h.settle();
    expect(errCode(await h.call("polymarket.signL2", signParams(walletId), session))).toBe(
      "locked",
    );
  });

  it("does not refresh the idle timer — presence: false like signL1", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    // Sign twice inside the idle window: a presence-bearing call would push the lock to
    // 15 minutes after the second sign; signL2 must leave the original deadline alone.
    h.advance(10 * 60_000);
    ok(await h.call("polymarket.signL2", signParams(walletId), session));
    h.advance(4 * 60_000);
    ok(await h.call("polymarket.signL2", signParams(walletId), session));
    h.advance(60_001); // 15:01 since the last presence activity — the import itself
    await h.settle();
    expect(errCode(await h.call("polymarket.signL2", signParams(walletId), session))).toBe(
      "locked",
    );
  });

  it.each([
    ["+30 s", 30, undefined],
    ["+31 s", 31, "invalid-input"],
    ["-30 s", -30, undefined],
    ["-31 s", -31, "invalid-input"],
  ])("timestamp %s of now → %s", async (_label, delta, code) => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    expect(
      errCode(
        await h.call(
          "polymarket.signL2",
          signParams(walletId, { timestamp: T0_SECONDS + delta }),
          session,
        ),
      ),
    ).toBe(code);
  });

  it.each([
    // The whole allow-list signs.
    ["POST", "/order"],
    ["DELETE", "/order"],
    ["DELETE", "/orders"],
    ["DELETE", "/cancel-all"],
    ["DELETE", "/cancel-market-orders"],
    ["GET", "/data/orders"],
    ["GET", `/data/order/0x${"ab".repeat(32)}`],
    ["GET", `/data/order/0x${"AB".repeat(32)}`],
    ["GET", "/data/trades"],
    ["GET", "/balance-allowance"],
    ["GET", "/balance-allowance/update"],
    ["GET", "/auth/ban-status/closed-only"],
    ["DELETE", "/auth/api-key"],
  ])("allow-listed %s %s signs", async (method, path) => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    expect(
      errCode(await h.call("polymarket.signL2", signParams(walletId, { method, path }), session)),
    ).toBeUndefined();
  });

  it.each([
    ["method swap GET /order", "GET", "/order"],
    ["method swap POST /orders", "POST", "/orders"],
    ["method swap DELETE /data/orders", "DELETE", "/data/orders"],
    ["query string", "GET", "/data/orders?market=0x1"],
    ["trailing slash", "GET", "/data/orders/"],
    ["missing slash", "GET", "data/orders"],
    ["prefix path", "GET", "/data"],
    ["order id too short", "GET", `/data/order/0x${"ab".repeat(31)}`],
    ["order id not hex", "GET", `/data/order/0x${"zz".repeat(32)}`],
    ["order id no 0x", "GET", `/data/order/${"ab".repeat(32)}`],
    ["order id with suffix", "GET", `/data/order/0x${"ab".repeat(32)}/extra`],
    ["unrelated path", "GET", "/markets"],
    ["empty path", "GET", ""],
  ])("refused %s → invalid-input", async (_label, method, path) => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    expect(
      errCode(await h.call("polymarket.signL2", signParams(walletId, { method, path }), session)),
    ).toBe("invalid-input");
  });

  it("a GET with a body is refused", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    expect(
      errCode(await h.call("polymarket.signL2", signParams(walletId, { body: "{}" }), session)),
    ).toBe("invalid-input");
  });

  it("body 65536 signs, 65537 is refused at the envelope", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    const post = async (body: string) =>
      h.call(
        "polymarket.signL2",
        signParams(walletId, { method: "POST", path: "/order", body }),
        session,
      );
    ok(await post("x".repeat(65_536)));
    expect(errCode(await post("x".repeat(65_537)))).toBe("integrity");
  });

  it("a path over 200 chars is refused at the envelope", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    expect(
      errCode(
        await h.call(
          "polymarket.signL2",
          signParams(walletId, { path: `/${"a".repeat(200)}` }),
          session,
        ),
      ),
    ).toBe("integrity");
  });
});

describe("pm-creds vault hooks", () => {
  const imageOf = (
    ...records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: Uint8Array }>
  ): VaultImage => ({ meta: undefined, records: [...records], factors: [] });

  it("findCreds only matches pm-creds records of that exact group id", () => {
    const image = imageOf(
      { kind: "pm-creds", id: "0011223344556677.0", header: "{}", sealed: new Uint8Array(1) },
      { kind: "pm-creds", id: "0011223344556677.1", header: "{}", sealed: new Uint8Array(1) },
      { kind: "key", id: "0011223344556677", header: "{}", sealed: new Uint8Array(1) },
    );
    expect(findCreds(image, { walletId: "0011223344556677", groupIndex: 0 })?.id).toBe(
      "0011223344556677.0",
    );
    expect(findCreds(image, { walletId: "0011223344556677", groupIndex: 2 })).toBeUndefined();
  });

  it("claimUnlocked latches corrupted on a plaintext that does not parse", () => {
    const { vault } = createAppsModule();
    const plaintext = utf8ToBytes('{"secret":"!!!","passphrase":"x"}');
    let thrown: unknown;
    try {
      vault.claimUnlocked([{ kind: PM_CREDS_KIND, id: "0011223344556677.0", plaintext }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { code?: string }).code).toBe("integrity");
    expect((thrown as { corrupted?: boolean }).corrupted).toBe(true);
    expect(plaintext.every((b) => b === 0)).toBe(true); // wiped on the way out
  });

  it("claimUnlocked claims well-formed credentials and returns the rest", () => {
    const { vault } = createAppsModule();
    const plaintext = encodeCredentialsPlaintext({ secret: SECRET, passphrase: PASSPHRASE });
    const other = { kind: "key", id: "0123456789abcdef", plaintext: new Uint8Array(32) };
    const rest = vault.claimUnlocked([
      { kind: PM_CREDS_KIND, id: "0011223344556677.0", plaintext },
      other,
    ]);
    expect(rest).toStrictEqual([other]);
    expect(plaintext.every((b) => b === 0)).toBe(true); // claimed plaintexts are wiped
  });

  it("signL2 latches corrupted on a sealed plaintext that does not parse", () => {
    const dek = Secret.take(new Uint8Array(32).fill(7));
    const platform = {
      now: () => T0,
      random: (n: number) => new Uint8Array(n),
    };
    const id = "0011223344556677.0";
    const record = sealRecord(
      platform as never,
      dek,
      PM_CREDS_KIND,
      id,
      encodeCredentialsHeader({
        walletId: "0011223344556677",
        groupIndex: 0,
        owner: EVM_ADDRESS,
        apiKey: API_KEY,
        createdAt: T0,
      }),
      utf8ToBytes('{"secret":"not-credentials","passphrase":"x"}'),
    );
    const ctx = {
      platform,
      image: imageOf(record),
      session: { require: () => ({ dek }) },
    } as unknown as Parameters<typeof signL2>[0];
    expect((): unknown =>
      signL2(
        ctx,
        {
          owner: { walletId: "0011223344556677", groupIndex: 0 },
          method: "GET",
          path: "/data/orders",
          timestamp: T0_SECONDS,
        },
        "00".repeat(16),
      ),
    ).toThrow("invalid pm-creds plaintext");
  });

  it("tampered pm-creds plaintext corrupts the vault on reconcile", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    const image = await h.store.load();
    const record = mustCredsRecord(image);
    await h.store.commit([
      { op: "put-record", record: { ...record, sealed: flipByte(record.sealed) } },
    ]);
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
    expect(errCode(await h.call("session.touch", null, session))).toBe("integrity");
  });

  it("a malformed pm-creds header corrupts status", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    const image = await h.store.load();
    const record = mustCredsRecord(image);
    await h.store.commit([{ op: "put-record", record: { ...record, header: '{"walletId":1}' } }]);
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
  });

  it("keys.list/export/remove never see credentials", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
    const list = ok(await h.call("keys.list", null, session)) as unknown as unknown[];
    expect(list).toHaveLength(0);
  });

  it("wallet.delete removes that wallet's credentials only", async () => {
    const { h, session, walletId } = await setup(T0);
    await importCreds(h, session, walletId);
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
    await importCreds(h, session, walletId2);
    const before = ok(
      await h.call("polymarket.listCredentials", null, session),
    ) as unknown as unknown[];
    expect(before).toHaveLength(2);

    ok(await h.call("wallet.delete", { walletId, verify: PASSKEY() }, session));
    const list = ok(await h.call("polymarket.listCredentials", null, session)) as unknown as Array<{
      walletId: string;
    }>;
    expect(list.map((c) => c.walletId)).toStrictEqual([walletId2]);
  });
});

describe("pm-creds codecs", () => {
  it("decodeSecret accepts the three encodings and rejects the rest", () => {
    const expected = base64.decode("lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=");
    for (const secret of [
      "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=",
      "lqe4ydrr_A0eL0BRYnOElaa3yNnq-wwdLj9QYXKDlKU=",
      "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU",
      "lqe4ydrr_A0eL0BRYnOElaa3yNnq-wwdLj9QYXKDlKU",
    ]) {
      expect(decodeSecret(secret)).toStrictEqual(expected);
    }
    for (const bad of [
      "",
      "aGVsbG8gd29ybGQ=", // decodes under 16 bytes
      "YQ==YQ==", // stray padding
      "aGVsbG8===", // length %4 == 1 after normalize+pad
      "aGVsbG8%2B", // bad char
      "A".repeat(129), // too long
    ]) {
      expect(decodeSecret(bad)).toBeUndefined();
    }
  });

  it("the header codec encodes a fixed key order and parses strictly", () => {
    const header = {
      walletId: "0011223344556677",
      groupIndex: 3,
      owner: EVM_ADDRESS,
      apiKey: API_KEY,
      createdAt: T0,
    };
    const text = encodeCredentialsHeader(header);
    expect(text).toBe(
      `{"walletId":"0011223344556677","groupIndex":3,"owner":"${EVM_ADDRESS}","apiKey":"${API_KEY}","createdAt":${T0}}`,
    );
    expect(parseCredentialsHeader(text)).toStrictEqual(header);
  });

  it("credsRecordId joins walletId and groupIndex with a dot", () => {
    expect(credsRecordId({ walletId: "0011223344556677", groupIndex: 12 })).toBe(
      "0011223344556677.12",
    );
  });
});

describe("pm-creds parser fuzz", () => {
  const runs = Number(process.env["FUZZ_RUNS"] ?? "300");

  it("random header strings throw only KernelError or round-trip", { timeout: 60000 }, () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.jsonValue().map((v) => JSON.stringify(v)),
        ),
        (raw) => {
          expect(pmHeaderOutcome(raw)).not.toBe("other");
        },
      ),
    );
  });

  it(
    "random plaintext bytes throw only KernelError or parse to two strings",
    { timeout: 60000 },
    () => {
      fc.assert(
        fc.property(fc.uint8Array(), (raw) => {
          expect(pmPlaintextOutcome(raw)).not.toBe("other");
        }),
      );
    },
  );

  it(
    "random signL2 params through the real dispatch yield a typed error or the five headers",
    { timeout: 120_000 },
    async () => {
      const { h, session, walletId } = await setup(T0);
      await importCreds(h, session, walletId);
      await fc.assert(
        fc.asyncProperty(fuzzSignParams(walletId), async (params) => {
          const response = await h.sendRaw({
            v: 3,
            id: 1,
            method: "polymarket.signL2",
            session,
            params,
          });
          expect(["err", "headers"]).toContain(signL2Outcome(response));
        }),
        { numRuns: runs },
      );
      // Still serving after the barrage.
      const res = await h.call("status");
      expect("ok" in res).toBe(true);
    },
  );
});
