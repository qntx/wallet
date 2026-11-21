// oxlint-disable vitest/no-conditional-in-test -- narrowing the union/JSON payloads is inherent to
// asserting on them (same convention as lido-fork.test.ts).

import { readFileSync } from "node:fs";

/**
 * `trade.*` end to end on the real Node kernel and a real `RequestController`: the order is quoted
 * from a fresh book, the TypedDataSign document the approval carries is compared byte-for-byte
 * against clob-client-v2 `ExchangeOrderBuilderV2`/`V3` (deep-imported from `dist/` — the package
 * exports map hides the builder), the posted wire signature/orderId/body/L2 headers the same, and
 * the inner signature recovers to the owner. Unknown POST answers reconcile by order id at 0/+2
 * s/+5 s on the manual timer and never re-post.
 */
import { createL2Headers } from "@polymarket/clob-client-v2";
import * as fc from "fast-check";
import { getAddress, recoverTypedDataAddress } from "viem";
import type { WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import type { DisplayIntent, PolymarketContent } from "@qntx/wallet-chains";
import { polymarket } from "@qntx/wallet/polymarket";

/* The SDK's exports map hides its builders; tests deep-import dist/ by relative path (test-only).
   The dist .d.ts for this module declares no members — the names resolve at runtime only. */
import {
  // @ts-expect-error — runtime-only export (empty .d.ts)
  ExchangeOrderBuilderV2,
  // @ts-expect-error — runtime-only export (empty .d.ts)
  ExchangeOrderBuilderV3,
} from "../../../node_modules/@polymarket/clob-client-v2/dist/order-utils/exchangeOrderBuilderV2.js";
import { SignatureTypeV2 } from "../../../node_modules/@polymarket/clob-client-v2/dist/order-utils/model/signatureTypeV2.js";
import {
  CLOB_HOST,
  CTF_EXCHANGE_V2,
  CTF_EXCHANGE_V3,
  NEG_RISK_EXCHANGE_V2,
  RELAYER_HOST,
} from "../src/apps/polymarket/constants.ts";
import { createPolymarketProvider } from "../src/apps/polymarket/provider.ts";
import type { PolymarketProvider } from "../src/apps/polymarket/provider.ts";
import { clobCancelResponse, clobPostOrderResponse } from "../src/apps/polymarket/schemas.ts";
import type { PolymarketTrading } from "../src/apps/polymarket/trade.ts";
import { derivePolymarketWallets } from "../src/apps/polymarket/wallets.ts";
import type { AppGroup } from "../src/apps/types.ts";
import type { AppAvailability } from "../src/gateway/contract/eligibility.ts";
import { MNEMONIC, VERIFY, manualTimer, until, world } from "./apps-helpers.ts";

const API = {
  apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2",
  secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=",
  passphrase: "test-passphrase-1",
} as const;

const ASSET = "21742633143463906290569050155826241533067272736897614950488156847949938836455";
const CONDITION = `0x${"ab".repeat(32)}`;
const ZERO32 = `0x${"0".repeat(64)}`;

const accountAt = (groupIndex: number) => mnemonicToAccount(MNEMONIC, { addressIndex: groupIndex });
const signerAt = (groupIndex: number): WalletClient => {
  const account = accountAt(groupIndex);
  return {
    account,
    signTypedData: account.signTypedData.bind(account),
  } as unknown as WalletClient;
};

const fixture = (name: string): { response: unknown } =>
  JSON.parse(
    readFileSync(new URL(`fixtures/polymarket/${name}.json`, import.meta.url), "utf8"),
  ) as { response: unknown };

/* The book the tests quote against — wire shape, sorted levels (asks asc, bids desc). */
const wireBook = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  market: CONDITION,
  asset_id: ASSET,
  timestamp: "1700000000",
  hash: "0x00",
  bids: [
    { price: "0.5", size: "100" },
    { price: "0.48", size: "100" },
  ],
  asks: [
    { price: "0.55", size: "100" },
    { price: "0.6", size: "100" },
  ],
  min_order_size: "1",
  tick_size: "0.01",
  neg_risk: false,
  ...over,
});

type Captured = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
};

type FetchState = {
  /** `GET /time` answer in server seconds. */
  serverSeconds?: () => number;
  /** `/book` answer — defaults to the CTF book. */
  book?: Record<string, unknown>;
  /** `POST /order` — status + body or a thrown Error (network failure). */
  post?: { status: number; body: unknown } | (() => never);
  /** The `orderID` the POST answer echoes — set from `placed.orderId` after place(). */
  orderID?: string;
  /** `GET /data/order/{id}` per attempt — `"absent"` 404s, `"error"` throws. */
  orderLookup?: ReadonlyArray<{ status: number; body: unknown } | "absent" | "error">;
  /** `GET /auth/ban-status/closed-only` — default: no record (404 → false). */
  closedOnly?: { status: number; body: unknown } | "error";
  /** DELETE answers, keyed by pathname. */
  cancel?: { status: number; body: unknown };
};

const makeFetch = (
  state: FetchState,
  requests: Captured[],
  now: () => number,
): typeof globalThis.fetch => {
  let lookups = 0;
  return async (input, init) => {
    await Promise.resolve();
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (url.origin === RELAYER_HOST && url.pathname === "/deployed") {
      const address = (url.searchParams.get("address") ?? "").toLowerCase();
      const type = url.searchParams.get("type") ?? "SAFE";
      return Response.json({
        deployed:
          type === "WALLET" &&
          address === derivePolymarketWallets(accountAt(0).address).beacon.toLowerCase(),
      });
    }
    if (url.origin !== CLOB_HOST) {
      throw new Error(`unrecorded request: ${url.toString()}`);
    }
    if (url.pathname === "/time") {
      return Response.json(state.serverSeconds?.() ?? Math.floor(now() / 1000));
    }
    if (url.pathname === "/book") {
      return Response.json(state.book ?? wireBook());
    }
    if (url.pathname === "/auth/ban-status/closed-only") {
      const answer = state.closedOnly;
      if (answer === "error") {
        throw new Error("connection reset");
      }
      if (answer === undefined) {
        return new Response("no record", { status: 404 });
      }
      return Response.json(answer.body, { status: answer.status });
    }
    if (url.pathname.startsWith("/data/order/")) {
      const attempt = state.orderLookup?.[lookups] ?? { status: 404, body: {} };
      lookups += 1;
      if (attempt === "error") {
        throw new Error("connection reset");
      }
      if (attempt === "absent") {
        return new Response("not found", { status: 404 });
      }
      return Response.json(attempt.body, { status: attempt.status });
    }
    if (url.pathname === "/order" && init?.method === "POST") {
      const post = state.post ?? {
        status: 200,
        body: { success: true, orderID: state.orderID ?? "", status: "live" },
      };
      if (typeof post === "function") {
        return post();
      }
      /* `"auto"` echoes the id the test learned from place() — any other value stands. */
      const body =
        post.body !== null &&
        typeof post.body === "object" &&
        (post.body as Record<string, unknown>)["orderID"] === "auto"
          ? { ...(post.body as Record<string, unknown>), orderID: state.orderID ?? "" }
          : post.body;
      return Response.json(body, { status: post.status });
    }
    if (init?.method === "DELETE") {
      const answer = state.cancel ?? { status: 200, body: { canceled: [], not_canceled: {} } };
      return Response.json(answer.body, { status: answer.status });
    }
    throw new Error(`unrecorded request: ${url.toString()}`);
  };
};

type Env = {
  readonly provider: PolymarketProvider;
  readonly requests: Captured[];
  readonly timers: ReturnType<typeof manualTimer>;
  /** The typed-data document string the prepared request carried. */
  typedData: () => string;
  readonly posts: () => ReadonlyArray<Captured>;
  approve: (id: string) => Promise<void>;
  /** Mutable — set `orderID` after place() so the POST answer can echo it. */
  readonly state: FetchState;
};

/** Deterministic salt — `0x11`-filled bytes masked to 53 bits. */
const FIXED_SALT = (BigInt("0x1111111111111111") % 2n ** 53n).toString(10);

let w: Awaited<ReturnType<typeof world>>;
let group: AppGroup;
const depositWallet = derivePolymarketWallets(accountAt(0).address).beacon;

beforeAll(async () => {
  w = await world();
  await polymarket(w.wallet)
    .importCredentials({ owner: { walletId: w.walletId, groupIndex: 0 }, ...API })
    .catch(() => undefined);
  group = { walletId: w.walletId, groupIndex: 0 };
}, 60_000);

const env = (
  state: FetchState = {},
  availability: () => AppAvailability | undefined = () => "available",
): Env => {
  const requests: Captured[] = [];
  let typedData = "";
  /* A per-env clock anchored to the real time — the kernel's ±30 s signing window compares the
     L2 timestamp to the device clock, so a shared manual timer pumped past request TTLs would
     invalidate every later signature. The request pipeline's own timers (w.timers) stay unpumped. */
  const timers = manualTimer(Date.now());
  const provider = createPolymarketProvider({
    fetch: makeFetch(state, requests, () => timers.time),
    setTimer: timers.setTimer,
    now: () => timers.time,
    wallet: w.wallet,
    requests: {
      prepare: async (input) => {
        if (input.method === "evm-sign" && input.request.kind === "evm.typed-data") {
          ({ typedData } = input.request);
        }
        return w.requests.prepare(input);
      },
      outcome: async (id) => w.requests.outcome(id),
    },
    random: () => new Uint8Array(8).fill(0x11),
    availability,
  });
  return {
    provider,
    requests,
    timers,
    typedData: () => typedData,
    posts: () => requests.filter((r) => r.method === "POST" && r.url.pathname === "/order"),
    approve: w.approve,
    state,
  };
};

/**
 * Pump this env's timers until `promise` settles — each reconcile wait schedules the next read only
 * after the kernel roundtrip of the previous one (real IPC, real time), so a fixed pump count can
 * stop early. Requests' own TTL timers live on w.timers and stay unpumped.
 */
const realDelay = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 10);
  });

const settled = async <T>(e: Pick<Env, "timers">, promise: Promise<T>): Promise<T> => {
  let done = false;
  void promise.finally(() => {
    done = true;
  });
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `done` flips on settlement
  for (let i = 0; !done && i < 400; i += 1) {
    e.timers.pump();
    // oxlint-disable-next-line eslint/no-await-in-loop -- the kernel roundtrip is real IPC
    await realDelay();
  }
  return promise;
};

const orderRow = (status: string, over: Record<string, unknown> = {}) => ({
  id: `0x${"12".repeat(32)}`,
  status,
  owner: "f4f247b7-4ac7-ff29-a152-04fda0a8755a",
  maker_address: depositWallet,
  market: CONDITION,
  asset_id: ASSET,
  side: "BUY",
  original_size: "10",
  size_matched: "4",
  price: "0.52",
  expiration: "0",
  order_type: "GTC",
  created_at: 1700000000,
  ...over,
});

const LIMIT_BUY = {
  kind: "limit" as const,
  assetId: ASSET,
  side: "BUY" as const,
  price: "0.52",
  size: "10",
  orderType: "GTC" as const,
};

describe("polymarket trade — place", () => {
  it("builds, describes, signs and posts a limit BUY identical to the SDK oracle", async () => {
    const e = env();
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    /* The approval's kernel display is the deposit-wallet order, not a blind payload. */
    await until(() => w.requests.getState().requests[placed.requestId] !== undefined);
    const pending = w.requests.getState().requests[placed.requestId];
    const intent = pending?.display as DisplayIntent | undefined;
    const message = intent?.message;
    expect(message?.kind).toBe("typed-data");
    const content = (message as { readonly polymarket?: PolymarketContent } | undefined)
      ?.polymarket;
    expect(content).toMatchObject({ kind: "order", wallet: "deposit-wallet" });
    expect(intent?.blind).toBeUndefined();

    e.state.orderID = placed.orderId;
    await e.approve(placed.requestId);
    const outcome = await placed.outcome;
    expect(outcome).toStrictEqual({ kind: "resting", orderId: placed.orderId });
    const posts = e.posts();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]?.body ?? "{}") as {
      order: {
        maker: `0x${string}`;
        signer: `0x${string}`;
        side: string;
        salt: number;
        signatureType: number;
        makerAmount: string;
        takerAmount: string;
        signature: `0x${string}`;
        tokenId: string;
        timestamp: string;
        metadata: `0x${string}`;
        builder: `0x${string}`;
        expiration: string;
      };
      orderType: string;
      owner: string;
      postOnly: boolean;
    };
    expect(body.owner).toBe(API.apiKey);
    expect(body.orderType).toBe("GTC");
    expect(body.order.maker).toBe(depositWallet);
    expect(body.order.signer).toBe(depositWallet);
    expect(body.order.side).toBe("BUY");
    expect(body.order.salt).toBe(Number(FIXED_SALT));
    expect(body.order.signatureType).toBe(3);
    expect(body.order.makerAmount).toBe("5200000"); // 10 × 0.52
    expect(body.order.takerAmount).toBe("10000000");

    /* Oracle: the SDK builds the same order, typed data, signature and hash. */
    const sdk = new ExchangeOrderBuilderV2(getAddress(CTF_EXCHANGE_V2), 137, signerAt(0), () =>
      Number(FIXED_SALT),
    );
    const order = await sdk.buildOrder({
      maker: depositWallet,
      signer: depositWallet,
      tokenId: ASSET,
      makerAmount: "5200000",
      takerAmount: "10000000",
      side: "BUY",
      signatureType: SignatureTypeV2.POLY_1271,
      timestamp: String(Math.floor(e.timers.time)),
      metadata: ZERO32,
      builder: ZERO32,
      expiration: "0",
    });
    const typed = sdk.buildOrderTypedData(order);
    expect(placed.orderId).toBe(sdk.buildOrderHash(structuredClone(typed)));

    /* The request's TypedDataSign document equals the SDK's envelope around the same Order. */
    const sentDoc = JSON.parse(e.typedData()) as {
      types: Record<string, unknown>;
      primaryType: string;
      domain: Record<string, unknown>;
      message: { contents: Record<string, unknown>; name: string; salt: string };
    };
    expect(sentDoc.primaryType).toBe("TypedDataSign");
    expect(sentDoc.domain).toStrictEqual(typed.domain);
    expect(sentDoc.message.name).toBe("DepositWallet");
    expect(sentDoc.message.salt).toBe(ZERO32);
    for (const [key, value] of Object.entries(typed.message)) {
      expect(String(sentDoc.message.contents[key])).toBe(String(value));
    }

    /* The wire signature is the SDK's byte-for-byte, and the inner signature recovers the owner. */
    const sdkSignature = await sdk.buildOrderSignature(structuredClone(typed));
    expect(body.order.signature).toBe(sdkSignature);
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "Polymarket CTF Exchange",
        version: "2",
        chainId: 137,
        verifyingContract: CTF_EXCHANGE_V2,
      },
      types: {
        TypedDataSign: [
          { name: "contents", type: "Order" },
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
          { name: "salt", type: "bytes32" },
        ],
        Order: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "address" },
          { name: "signer", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "makerAmount", type: "uint256" },
          { name: "takerAmount", type: "uint256" },
          { name: "side", type: "uint8" },
          { name: "signatureType", type: "uint8" },
          { name: "timestamp", type: "uint256" },
          { name: "metadata", type: "bytes32" },
          { name: "builder", type: "bytes32" },
        ],
      },
      primaryType: "TypedDataSign",
      message: {
        contents: {
          salt: BigInt(body.order.salt),
          maker: body.order.maker,
          signer: body.order.signer,
          tokenId: BigInt(body.order.tokenId),
          makerAmount: BigInt(body.order.makerAmount),
          takerAmount: BigInt(body.order.takerAmount),
          side: 0,
          signatureType: 3,
          timestamp: BigInt(body.order.timestamp),
          metadata: body.order.metadata,
          builder: body.order.builder,
        },
        name: "DepositWallet",
        version: "1",
        chainId: 137n,
        verifyingContract: body.order.signer,
        salt: ZERO32 as `0x${string}`,
      },
      signature: (body.order.signature as string).slice(0, 132) as `0x${string}`,
    });
    expect(recovered).toBe(accountAt(0).address);

    /* The L2 header is exactly what the SDK produces over the same method/path/body. */
    const oracle = await createL2Headers(
      signerAt(0),
      { key: API.apiKey, secret: API.secret, passphrase: API.passphrase },
      {
        method: "POST",
        requestPath: "/order",
        body: posts[0]?.body ?? "",
      },
      Number(posts[0]?.headers["POLY_TIMESTAMP"]),
    );
    expect(posts[0]?.headers["POLY_SIGNATURE"]).toBe(oracle.POLY_SIGNATURE);
    expect(posts[0]?.headers["POLY_API_KEY"]).toBe(API.apiKey);
    expect(posts[0]?.headers["POLY_PASSPHRASE"]).toBe(API.passphrase);
  });

  it.each([
    [wireBook({ neg_risk: true }), NEG_RISK_EXCHANGE_V2, "2", ExchangeOrderBuilderV2],
    [wireBook({ version: "v2" }), CTF_EXCHANGE_V3, "3", ExchangeOrderBuilderV3],
  ] as const)(
    "selects the exchange domain from the book — %s",
    async (book, contract, version, Builder) => {
      const e = env({ book });
      const placed = await e.provider.trade.place(group, LIMIT_BUY);
      const doc = JSON.parse(e.typedData()) as {
        domain: { verifyingContract: string; version: string };
      };
      expect(doc.domain.verifyingContract).toBe(contract);
      expect(doc.domain.version).toBe(version);
      /* The order id hashes under that same domain — V3 uses its own builder class. */
      const sdk = new Builder(contract, 137, signerAt(0), () => Number(FIXED_SALT));
      const order = await sdk.buildOrder({
        maker: depositWallet,
        signer: depositWallet,
        tokenId: ASSET,
        makerAmount: "5200000",
        takerAmount: "10000000",
        side: "BUY",
        signatureType: SignatureTypeV2.POLY_1271,
        timestamp: String(Math.floor(e.timers.time)),
        metadata: ZERO32,
        builder: ZERO32,
        expiration: "0",
      });
      expect(placed.orderId).toBe(
        sdk.buildOrderHash(structuredClone(sdk.buildOrderTypedData(order))),
      );
      w.requests.reject(placed.requestId);
      await placed.outcome.catch(() => undefined);
    },
  );

  it("refuses a locked vault after approval with zero posts", async () => {
    const e = env();
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    await w.wallet.vault.lock();
    try {
      await expect(placed.outcome).rejects.toMatchObject({ category: "unlock-required" });
      expect(e.posts()).toHaveLength(0);
    } finally {
      await w.wallet.vault.unlock(VERIFY);
    }
  });

  it.each<[{ status: number; body: unknown }, unknown]>([
    [
      {
        status: 200,
        body: {
          success: true,
          orderID: "auto",
          status: "matched",
          makingAmount: "4",
          takingAmount: "2.08",
          tradeIDs: ["t1"],
        },
      },
      { kind: "matched", making: "4", taking: "2.08", tradeIds: ["t1"] },
    ],
    [
      { status: 200, body: { success: true, orderID: "auto", status: "delayed" } },
      { kind: "delayed" },
    ],
    [
      { status: 200, body: { success: true, orderID: "auto", status: "unmatched" } },
      { kind: "unmatched" },
    ],
    [
      { status: 200, body: { success: false, errorMsg: "not enough balance / allowance" } },
      { kind: "rejected", reason: "balance-or-allowance" },
    ],
    [
      {
        status: 400,
        body: { error: "invalid price, price must be a multiple of the tick size" },
      },
      { kind: "rejected", reason: "tick" },
    ],
    [
      { status: 429, body: { error: "you are being rate-limited" } },
      { kind: "rejected", reason: "rate-limited" },
    ],
  ])("maps the POST outcome %j", { timeout: 30_000 }, async (post, want) => {
    const e = env({ post });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    e.state.orderID = placed.orderId;
    await e.approve(placed.requestId);
    await expect(placed.outcome).resolves.toMatchObject(want as object);
    expect(e.posts()).toHaveLength(1);
  });

  it("a 2xx echoing a different orderID is never trusted — it reconciles", async () => {
    const e = env({
      post: {
        status: 200,
        body: { success: true, orderID: `0x${"ff".repeat(32)}`, status: "live" },
      },
      orderLookup: [{ status: 200, body: orderRow("LIVE") }],
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    const outcomePromise = placed.outcome;
    await expect(settled(e, outcomePromise)).resolves.toStrictEqual({
      kind: "resting",
      orderId: placed.orderId,
    });
    /* The untrusted answer must have gone through the reconcile read, not the status switch. */
    expect(e.requests.filter((r) => r.url.pathname.startsWith("/data/order"))).toHaveLength(1);
    expect(e.posts()).toHaveLength(1);
  });

  it("reconciles an unknown POST outcome once each at 0/+2 s/+5 s — three reads, one post", async () => {
    const e = env({
      post: { status: 500, body: { error: "upstream exploded" } },
      orderLookup: ["absent", "absent", { status: 200, body: orderRow("LIVE") }],
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    await expect(settled(e, placed.outcome)).resolves.toStrictEqual({
      kind: "resting",
      orderId: placed.orderId,
    });
    expect(e.requests.filter((r) => r.url.pathname.startsWith("/data/order"))).toHaveLength(3);
    expect(e.posts()).toHaveLength(1);
  });

  it.each([
    [["absent", "absent", "absent"], "not-found"],
    [["error", "error", "error"], "unknown"],
    [["error", "absent"], "not-found"],
  ] as const)(
    "reconcile reads %j settle %s — never a re-post",
    { timeout: 20_000 },
    async (lookup, want) => {
      const e = env({ post: { status: 503, body: {} }, orderLookup: [...lookup] });
      const placed = await e.provider.trade.place(group, LIMIT_BUY);
      await e.approve(placed.requestId);
      await expect(settled(e, placed.outcome)).resolves.toStrictEqual({
        kind: want,
        orderId: placed.orderId,
      });
      expect(e.posts()).toHaveLength(1);
    },
  );

  it("a network error on POST reconciles without a re-post", async () => {
    const e = env({
      post: () => {
        throw new Error("connection reset");
      },
      orderLookup: [{ status: 200, body: orderRow("MATCHED") }],
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    const outcome = await placed.outcome;
    expect(outcome).toMatchObject({ kind: "matched", orderId: placed.orderId });
    expect(e.posts()).toHaveLength(1);
  });

  it("refuses a market order's postOnly and validates GTD", async () => {
    const e = env();
    await expect(
      e.provider.trade.place(group, {
        kind: "market",
        assetId: ASSET,
        side: "BUY",
        amount: "10",
        slippageBps: 100,
        orderType: "FOK",
        postOnly: true,
      } as never),
    ).rejects.toMatchObject({ category: "invalid-input" });
    await expect(
      e.provider.trade.place(group, { ...LIMIT_BUY, orderType: "GTD" }),
    ).rejects.toMatchObject({ category: "invalid-input" });
    await expect(
      e.provider.trade.place(group, {
        ...LIMIT_BUY,
        orderType: "GTD",
        expiration: Math.floor(Date.now() / 1000) + 60,
      }),
    ).rejects.toMatchObject({ category: "invalid-input" });
    await expect(
      e.provider.trade.place(group, { ...LIMIT_BUY, expiration: 1e10 }),
    ).rejects.toMatchObject({ category: "invalid-input" });
    /* Nothing reached the network or the request pipeline. */
    expect(e.posts()).toHaveLength(0);
    const pending = Object.values(w.requests.getState().requests).filter(
      (r) => r.stage === "awaiting-approval",
    );
    expect(pending).toHaveLength(0);
  });

  it("a GTD carries its expiration on the wire (unsigned — the CLOB enforces it)", async () => {
    const e = env();
    const expiration = Math.floor(e.timers.time / 1000) + 600;
    const placed = await e.provider.trade.place(group, {
      ...LIMIT_BUY,
      orderType: "GTD",
      expiration,
    });
    e.state.orderID = placed.orderId;
    await e.approve(placed.requestId);
    await placed.outcome;
    const posts = e.posts();
    const body = JSON.parse(posts[0]?.body ?? "{}") as { order: { expiration: string } };
    expect(body.order.expiration).toBe(String(expiration));
    /* The signed document has no expiration field — the struct is exact. */
    const doc = JSON.parse(e.typedData()) as { message: { contents: Record<string, unknown> } };
    expect("expiration" in doc.message.contents).toBe(false);
  });
});

it("masks the salt to 53 bits — it always serializes as an exact JSON number", async () => {
  const requests: Captured[] = [];
  const timers = manualTimer(Date.now());
  let saltSeen: string | undefined;
  const provider = createPolymarketProvider({
    fetch: makeFetch({}, requests, () => timers.time),
    setTimer: timers.setTimer,
    now: () => timers.time,
    wallet: w.wallet,
    requests: {
      prepare: async (input) => {
        saltSeen =
          input.method === "evm-sign" && input.request.kind === "evm.typed-data"
            ? (
                JSON.parse(input.request.typedData) as {
                  message: { contents: { salt: string } };
                }
              ).message.contents.salt
            : undefined;
        return w.requests.prepare(input);
      },
      outcome: async (id) => w.requests.outcome(id),
    },
    random: () => new Uint8Array(8).fill(0xff),
    availability: () => "available",
  });
  const placed = await provider.trade.place(group, LIMIT_BUY);
  await w.approve(placed.requestId);
  await settled({ timers }, placed.outcome);
  const post = requests.find((r) => r.method === "POST" && r.url.pathname === "/order");
  const body = JSON.parse(post?.body ?? "{}") as { order: { salt: number } };
  expect(body.order.salt).toBe(Number.MAX_SAFE_INTEGER);
  expect(saltSeen).toBe((2n ** 53n - 1n).toString(10));
});

describe("polymarket trade — close-only gate", () => {
  const MARKET_BUY = {
    kind: "market" as const,
    assetId: ASSET,
    side: "BUY" as const,
    amount: "10",
    slippageBps: 100,
    orderType: "FOK" as const,
  };
  const BUY_ENTRIES: ReadonlyArray<
    readonly [string, (trade: PolymarketTrading) => Promise<unknown>]
  > = [
    ["place-limit", async (trade) => trade.place(group, LIMIT_BUY)],
    ["place-market", async (trade) => trade.place(group, MARKET_BUY)],
    ["quote-limit", async (trade) => trade.quote(group, LIMIT_BUY)],
    ["quote-market", async (trade) => trade.quote(group, MARKET_BUY)],
  ];

  it.each(
    (["close-only", "blocked", undefined] as const).flatMap((availability) =>
      BUY_ENTRIES.map(([name, buy]) => [availability, name, buy] as const),
    ),
  )("%s BUY %s refuses", async (availability, _name, buy) => {
    const e = env({}, () => availability);
    await expect(buy(e.provider.trade)).rejects.toMatchObject({ category: "close-only" });
  });

  it("account closed_only refuses BUY; a failed read fails closed; SELL passes", async () => {
    const banned = env({ closedOnly: { status: 200, body: { closed_only: true } } });
    await expect(banned.provider.trade.place(group, LIMIT_BUY)).rejects.toMatchObject({
      category: "close-only",
    });

    const failing = env({ closedOnly: "error" });
    await expect(failing.provider.trade.place(group, LIMIT_BUY)).rejects.toMatchObject({
      category: "close-only",
    });

    /* SELL is never gated — even under a banned account it reaches approval. */
    const sell = env({ closedOnly: { status: 200, body: { closed_only: true } } });
    const placed = await sell.provider.trade.place(group, {
      ...LIMIT_BUY,
      side: "SELL",
    });
    sell.state.orderID = placed.orderId;
    await sell.approve(placed.requestId);
    await expect(placed.outcome).resolves.toMatchObject({ kind: "resting" });
  });
});

describe("polymarket trade — cancels", () => {
  const ORDER_ID = `0x${"12".repeat(32)}`;

  it("DELETE /order cancels one id and maps the answer", async () => {
    const e = env({
      cancel: {
        status: 200,
        body: { canceled: [ORDER_ID], not_canceled: { "0xdead": "not found" } },
      },
    });
    const result = await e.provider.trade.cancel(group, ORDER_ID);
    expect(result.canceled).toStrictEqual([ORDER_ID]);
    expect(result.notCanceled).toStrictEqual({ "0xdead": "not found" });
    const delete_ = e.requests
      .filter((r) => r.method === "DELETE")
      .find((r) => r.url.pathname === "/order");
    expect(JSON.parse(delete_?.body ?? "{}")).toStrictEqual({ orderID: ORDER_ID });
  });

  it("cancelMany enforces the 1..500 bounds before any request", async () => {
    const e = env();
    await expect(e.provider.trade.cancelMany(group, [])).rejects.toMatchObject({
      category: "invalid-input",
    });
    await expect(
      e.provider.trade.cancelMany(
        group,
        Array.from({ length: 501 }, () => ORDER_ID),
      ),
    ).rejects.toMatchObject({ category: "invalid-input" });
    await e.provider.trade.cancelMany(group, [ORDER_ID, `0x${"34".repeat(32)}`]);
    const many = e.requests
      .filter((r) => r.method === "DELETE")
      .find((r) => r.url.pathname === "/orders");
    expect(JSON.parse(many?.body ?? "[]")).toStrictEqual([ORDER_ID, `0x${"34".repeat(32)}`]);
  });

  it("cancelAll and cancelMarket hit their endpoints", async () => {
    const e = env({
      cancel: { status: 200, body: { canceled: [ORDER_ID], not_canceled: {} } },
    });
    await e.provider.trade.cancelAll(group);
    await e.provider.trade.cancelMarket(group, { assetId: ASSET });
    const paths = e.requests.filter((r) => r.method === "DELETE").map((r) => r.url.pathname);
    expect(paths).toContain("/cancel-all");
    expect(paths).toContain("/cancel-market-orders");
    await expect(e.provider.trade.cancelMarket(group, {})).rejects.toMatchObject({
      category: "invalid-input",
    });
  });

  it("cancels are never gated by availability", async () => {
    const e = env({}, () => "blocked");
    await e.provider.trade.cancel(group, ORDER_ID);
    expect(e.requests.some((r) => r.method === "DELETE")).toBe(true);
  });
});

const MUTATIONS: Record<string, (base: Record<string, unknown>) => unknown> = {
  drop: (base) => {
    const rest = { ...base };
    delete rest["success"];
    delete rest["canceled"];
    return rest;
  },
  wrong: (base) => Object.fromEntries(Object.keys(base).map((key) => [key, [1, 2, 3]])),
  oversize: (base) => ({
    ...base,
    errorMsg: "x".repeat(1e5),
    status: "y".repeat(1e5),
    canceled: ["x".repeat(1e5)],
  }),
  junk: () => [[["not json object"], { a: 1 }], 42, "s"][0],
};

const HOSTILE_CASES: Record<
  string,
  {
    base: Record<string, unknown>;
    schema: typeof clobPostOrderResponse | typeof clobCancelResponse;
  }
> = {
  post: {
    base: fixture("post-order-live").response as Record<string, unknown>,
    schema: clobPostOrderResponse,
  },
  cancel: {
    base: fixture("cancel-response").response as Record<string, unknown>,
    schema: clobCancelResponse,
  },
};

describe("polymarket trade — hostile answers", () => {
  it("post/cancel responses never parse a wrong shape", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(
        fc.constantFrom("drop", "wrong", "oversize", "junk"),
        fc.constantFrom("post", "cancel"),
        (mutation, which) => {
          const entry = HOSTILE_CASES[which];
          const mutate = MUTATIONS[mutation];
          if (entry === undefined || mutate === undefined) {
            throw new Error("bad table");
          }
          /* Whatever the answer: a typed result or undefined, never an untyped throw. `drop`
             parses only when every dropped key was optional — true for the cancel schema alone. */
          const result = entry.schema.safeParse(mutate(entry.base));
          expect(result.success).toBe(mutation === "drop" && which === "cancel");
        },
      ),
      { numRuns: 60 },
    );
  });
});
