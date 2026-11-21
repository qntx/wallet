import { readFileSync } from "node:fs";

/**
 * The engine-side credential store and L2 client: `l2Headers` is checked byte-for-byte against
 * every case of vectors/chains/polymarket-l2.json (the @polymarket/clob-client-v2 oracle), field
 * validation refuses out-of-bounds records before anything is written, a malformed stored row
 * reads as absent with a content-free warning, a closed session maps to `unlock-required`, and a
 * hostile server that echoes the credentials back inside an error sees them scrubbed.
 */
import { describe, expect, it } from "vite-plus/test";
import * as z from "zod/mini";

import { createPolymarketCredentials } from "../src/apps/polymarket/credentials.ts";
import type { PolymarketCredentials } from "../src/apps/polymarket/credentials.ts";
import { PolymarketError } from "../src/apps/polymarket/errors.ts";
import type { PolymarketHttp } from "../src/apps/polymarket/http.ts";
import { createPolymarketL2, l2Headers } from "../src/apps/polymarket/l2.ts";
import { createAppStorage } from "../src/apps/storage.ts";
import type { AppGroup } from "../src/apps/types.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";

const OWNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as const;
const API = {
  apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2",
  secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=",
  passphrase: "test-passphrase-1",
} as const;
const GROUP: AppGroup = { walletId: "wallet-a", groupIndex: 0 };

const VECTORS = JSON.parse(
  readFileSync(new URL("../../../vectors/chains/polymarket-l2.json", import.meta.url), "utf8"),
) as {
  account: `0x${string}`;
  cases: ReadonlyArray<{
    name: string;
    apiKey: string;
    secret: string;
    passphrase: string;
    timestamp: number;
    method: string;
    path: string;
    body?: string;
    headers: Record<string, string>;
  }>;
};

const warns: string[] = [];
const logger = { warn: (message: string) => warns.push(message) };

const store = (session: () => EngineStore | undefined) =>
  createPolymarketCredentials({ storage: createAppStorage("polymarket", session), logger });

/** A fetch-counting http stub — `time` answers zero skew, `request` records the headers sent. */
const http = (
  respond: (req: {
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
  }) => unknown,
): { http: PolymarketHttp; seen: Array<Readonly<Record<string, string>>> } => {
  const seen: Array<Readonly<Record<string, string>>> = [];
  const stub: PolymarketHttp = {
    request: async (input, schema) => {
      await Promise.resolve();
      seen.push(input.headers ?? {});
      return schema.parse(
        respond({
          method: input.method,
          path: input.path,
          headers: input.headers ?? {},
          ...(input.body === undefined ? {} : { body: input.body }),
        }),
      );
    },
    time: async () => {
      await Promise.resolve();
      return { serverSeconds: Math.floor(Date.now() / 1000), skewMs: 0 };
    },
  };
  return { http: stub, seen };
};

describe("polymarket l2Headers — fixed vectors", () => {
  for (const c of VECTORS.cases) {
    it(`matches the oracle — ${c.name}`, () => {
      const headers = l2Headers(
        { owner: VECTORS.account, apiKey: c.apiKey, secret: c.secret, passphrase: c.passphrase },
        {
          method: c.method,
          path: c.path,
          ...(c.body === undefined ? {} : { body: c.body }),
          timestamp: c.timestamp,
        },
      );
      expect({ ...headers }).toStrictEqual(c.headers);
    });
  }
});

describe("polymarket credential store", () => {
  it("round-trips a valid record and lowercases the api key", async () => {
    const memory = createMemoryEngineStore();
    const credentials = store(() => memory);
    await credentials.put(GROUP, { owner: OWNER, ...API, apiKey: API.apiKey.toUpperCase() });
    await expect(credentials.get(GROUP)).resolves.toStrictEqual({ owner: OWNER, ...API });
  });

  it.each([
    ["api key", { ...API, apiKey: "not-a-uuid" }],
    ["secret alphabet", { ...API, secret: "!!!not-base64!!!" }],
    ["secret too short", { ...API, secret: "aGk=" }],
    ["secret too long", { ...API, secret: Buffer.alloc(65).toString("base64") }],
    ["passphrase empty", { ...API, passphrase: "" }],
    ["passphrase non-ascii", { ...API, passphrase: "päss" }],
    ["owner", { ...API, owner: "0x1234" }],
  ])("put refuses a malformed %s without writing", async (_label, value) => {
    const memory = createMemoryEngineStore();
    const credentials = store(() => memory);
    /* The table widens `owner` to string — the rows exist precisely to be refused at runtime. */
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const record = { owner: OWNER, ...value } as PolymarketCredentials;
    await expect(credentials.put(GROUP, record)).rejects.toMatchObject({
      category: "malformed",
    });
    await expect(credentials.get(GROUP)).resolves.toBeUndefined();
  });

  it("a malformed stored row reads as absent and warns without its content", async () => {
    const memory = createMemoryEngineStore();
    await memory
      .collection("apps.polymarket")
      .put(
        `${GROUP.walletId}/${GROUP.groupIndex}/eip155:137`,
        new TextEncoder().encode(JSON.stringify({ owner: OWNER, apiKey: "x", extra: true })),
      );
    const credentials = store(() => memory);
    const before = warns.length;
    await expect(credentials.get(GROUP)).resolves.toBeUndefined();
    expect(warns.length).toBe(before + 1);
    expect(warns.at(-1)).not.toContain("x");
    expect(warns.at(-1)).not.toContain(OWNER);
  });

  it("a stored row with an extra key reads as absent even when every field is valid", async () => {
    const memory = createMemoryEngineStore();
    await memory
      .collection("apps.polymarket")
      .put(
        `${GROUP.walletId}/${GROUP.groupIndex}/eip155:137`,
        new TextEncoder().encode(JSON.stringify({ owner: OWNER, ...API, extra: true })),
      );
    const credentials = store(() => memory);
    const before = warns.length;
    await expect(credentials.get(GROUP)).resolves.toBeUndefined();
    expect(warns.length).toBe(before + 1);
  });

  it("a closed session maps every method to unlock-required", async () => {
    const credentials = store(() => undefined);
    await expect(credentials.get(GROUP)).rejects.toMatchObject({
      category: "unlock-required",
    });
    await expect(
      credentials.put(GROUP, { owner: OWNER, ...API }),
    ).rejects.toMatchObject({ category: "unlock-required" });
    await expect(credentials.delete(GROUP)).rejects.toMatchObject({
      category: "unlock-required",
    });
    await expect(credentials.groups()).rejects.toMatchObject({ category: "unlock-required" });
  });

  it("groups lists each seeded group once", async () => {
    const memory = createMemoryEngineStore();
    const credentials = store(() => memory);
    await credentials.put(GROUP, { owner: OWNER, ...API });
    await credentials.put({ walletId: "wallet-a", groupIndex: 3 }, { owner: OWNER, ...API });
    await credentials.put({ walletId: "wallet-b", groupIndex: 0 }, { owner: OWNER, ...API });
    await expect(credentials.groups()).resolves.toStrictEqual([
      GROUP,
      { walletId: "wallet-a", groupIndex: 3 },
      { walletId: "wallet-b", groupIndex: 0 },
    ]);
  });
});

describe("polymarket l2 — request order", () => {
  const l2 = (session: () => EngineStore | undefined, seen: PolymarketHttp) =>
    createPolymarketL2({
      http: seen,
      credentials: store(session),
      signerOf: async () => {
        await Promise.resolve();
        return OWNER;
      },
      now: () => Date.now(),
    });

  it("missing credentials refuse not-enabled before any request", async () => {
    const memory = createMemoryEngineStore();
    const { http: stub, seen } = http(() => ({}));
    const client = l2(() => memory, stub);
    await expect(
      client.request(GROUP, { method: "GET", path: "/data/orders" }, z.looseObject({})),
    ).rejects.toMatchObject({ category: "not-enabled" });
    expect(seen).toHaveLength(0);
  });

  it("a stored owner that is not the group's signer refuses not-enabled", async () => {
    const memory = createMemoryEngineStore();
    const credentials = store(() => memory);
    await credentials.put(GROUP, {
      owner: "0x0000000000000000000000000000000000000001",
      ...API,
    });
    const { http: stub, seen } = http(() => ({}));
    const client = createPolymarketL2({
      http: stub,
      credentials,
      signerOf: async () => {
        await Promise.resolve();
        return OWNER;
      },
      now: () => Date.now(),
    });
    await expect(
      client.request(GROUP, { method: "GET", path: "/data/orders" }, z.looseObject({})),
    ).rejects.toMatchObject({ category: "not-enabled" });
    expect(seen).toHaveLength(0);
  });

  it("a locked vault refuses unlock-required before any request", async () => {
    const { http: stub, seen } = http(() => ({}));
    const client = l2(() => undefined, stub);
    await expect(
      client.request(GROUP, { method: "GET", path: "/data/orders" }, z.looseObject({})),
    ).rejects.toMatchObject({ category: "unlock-required" });
    expect(seen).toHaveLength(0);
  });

  it("a hostile error echoing the credentials is scrubbed of all three values", async () => {
    const memory = createMemoryEngineStore();
    const credentials = store(() => memory);
    await credentials.put(GROUP, { owner: OWNER, ...API });
    const echo = { error: API.apiKey, detail: API.secret, hint: API.passphrase };
    const stub: PolymarketHttp = {
      request: async () => {
        await Promise.resolve();
        throw new PolymarketError("unavailable", `the CLOB answered 500: ${API.secret}`, {
          status: 500,
          body: echo,
          cause: new Error(`transport said ${API.passphrase}`),
        });
      },
      time: async () => {
        await Promise.resolve();
        return { serverSeconds: Math.floor(Date.now() / 1000), skewMs: 0 };
      },
    };
    const client = createPolymarketL2({
      http: stub,
      credentials,
      signerOf: async () => {
        await Promise.resolve();
        return OWNER;
      },
      now: () => Date.now(),
    });
    const thrown = await client
      .request(GROUP, { method: "GET", path: "/data/orders" }, z.looseObject({}))
      .then(
        () => {
          throw new Error("expected a throw");
        },
        (error: unknown) => error,
      );
    if (!(thrown instanceof PolymarketError)) {
      throw new Error("expected a PolymarketError");
    }
    expect(thrown.category).toBe("unavailable");
    expect(thrown.status).toBe(500);
    expect(thrown.body).toBeUndefined();
    expect(thrown.cause).toBeUndefined();
    const haystack = `${thrown.message} ${String(thrown)}`;
    for (const secret of [API.apiKey, API.secret, API.passphrase]) {
      expect(haystack).not.toContain(secret);
    }
    expect(thrown.message).toContain("[redacted]");
  });

  it.each([
    [
      "body",
      new PolymarketError("unavailable", "the CLOB answered 500", {
        status: 500,
        body: { error: API.apiKey, detail: API.secret, hint: API.passphrase },
      }),
    ],
    [
      "cause chain",
      new PolymarketError("unavailable", "the CLOB answered 502", {
        status: 502,
        cause: new Error(`reflected ${API.secret}`),
      }),
    ],
  ])(
    "a hostile error leaking the credentials only through its %s is still scrubbed",
    async (_label, error) => {
      const memory = createMemoryEngineStore();
      const credentials = store(() => memory);
      await credentials.put(GROUP, { owner: OWNER, ...API });
      const stub: PolymarketHttp = {
        request: async () => {
          await Promise.resolve();
          throw error;
        },
        time: async () => {
          await Promise.resolve();
          return { serverSeconds: Math.floor(Date.now() / 1000), skewMs: 0 };
        },
      };
      const client = createPolymarketL2({
        http: stub,
        credentials,
        signerOf: async () => {
          await Promise.resolve();
          return OWNER;
        },
        now: () => Date.now(),
      });
      const thrown = await client
        .request(GROUP, { method: "GET", path: "/data/orders" }, z.looseObject({}))
        .then(
          () => {
            throw new Error("expected a throw");
          },
          (thrownError: unknown) => thrownError,
        );
      if (!(thrown instanceof PolymarketError)) {
        throw new Error("expected a PolymarketError");
      }
      expect(thrown.body).toBeUndefined();
      expect(thrown.cause).toBeUndefined();
      const haystack = `${thrown.message} ${String(thrown)}`;
      for (const secret of [API.apiKey, API.secret, API.passphrase]) {
        expect(haystack).not.toContain(secret);
      }
    },
  );

  it("a clean error passes through untouched", async () => {
    const memory = createMemoryEngineStore();
    const credentials = store(() => memory);
    await credentials.put(GROUP, { owner: OWNER, ...API });
    const clean = new PolymarketError("unavailable", "the CLOB answered 502", { status: 502 });
    const stub: PolymarketHttp = {
      request: async () => {
        await Promise.resolve();
        throw clean;
      },
      time: async () => {
        await Promise.resolve();
        return { serverSeconds: Math.floor(Date.now() / 1000), skewMs: 0 };
      },
    };
    const client = createPolymarketL2({
      http: stub,
      credentials,
      signerOf: async () => {
        await Promise.resolve();
        return OWNER;
      },
      now: () => Date.now(),
    });
    await expect(
      client.request(GROUP, { method: "GET", path: "/data/orders" }, z.looseObject({})),
    ).rejects.toBe(clean);
  });
});
