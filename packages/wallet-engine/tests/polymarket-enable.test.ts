// oxlint-disable vitest/no-conditional-in-test -- narrowing JSON payloads is inherent to
// asserting on them (same convention as polymarket-trade.test.ts).

import { createHmac } from "node:crypto";

/**
 * The `polymarket` AppProvider end to end on the real Node kernel and a real `RequestController`:
 * locate → deploy → credentials → approvals → verify as one resumable state machine. The ClobAuth
 * and `DepositWallet` Batch requests are kernel-described (never blind), relayer submissions are
 * HMAC'd by the injected builder over the exact sent body, the L1 headers match clob-client-v2's
 * `createL1Headers` oracle, every step failure leaves a resumable state, and the credential
 * `secret` lands only in the encrypted apps collection — never controller state, logs or a later
 * request.
 */
import { createL1Headers } from "@polymarket/clob-client-v2";
import type { WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import type { DisplayIntent, PolymarketContent } from "@qntx/wallet-chains";

import {
  CLOB_HOST,
  CONDITIONAL_TOKENS,
  CTF_EXCHANGE_V2,
  CTF_EXCHANGE_V3,
  DATA_HOST,
  DEPOSIT_WALLET_FACTORY,
  GAMMA_HOST,
  NEG_RISK_ADAPTER,
  NEG_RISK_EXCHANGE_V2,
  POSITION_MANAGER,
  PUSD,
  RELAYER_HOST,
} from "../src/apps/polymarket/constants.ts";
import { PolymarketError } from "../src/apps/polymarket/errors.ts";
import type { PolymarketBuilder } from "../src/apps/polymarket/provider.ts";
import { derivePolymarketWallets } from "../src/apps/polymarket/wallets.ts";
import type { AppGroup } from "../src/apps/types.ts";
import type { EligibilityResponse } from "../src/gateway/contract/eligibility.ts";
import type { EngineStore } from "../src/store/port.ts";
import {
  MNEMONIC,
  VERIFY,
  manualTimer,
  pumpUntil,
  restartableStore,
  swallow,
  tick,
  until,
  world,
} from "./apps-helpers.ts";

const API = {
  apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2",
  secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=",
  passphrase: "test-passphrase-1",
} as const;

const OWNER = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const SIGNER = OWNER.address;
const WALLETS = derivePolymarketWallets(SIGNER);
const BUILDER_SECRET = "builder-test-secret";

const signerAt = (index: number): WalletClient => {
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: index });
  /* The wallet-client `ClobSigner` shape createL1Headers expects (the account.ts shim). */
  return {
    account,
    signTypedData: account.signTypedData.bind(account),
  } as unknown as WalletClient;
};

/** The eight-row approval table, in batch order (docs trading/wallets-auth.md §Set Up Approvals). */
const TABLE: ReadonlyArray<readonly [`0x${string}`, `0x${string}`]> = [
  [PUSD, CTF_EXCHANGE_V3],
  [PUSD, CTF_EXCHANGE_V2],
  [PUSD, NEG_RISK_EXCHANGE_V2],
  [PUSD, NEG_RISK_ADAPTER],
  [POSITION_MANAGER, CTF_EXCHANGE_V3],
  [CONDITIONAL_TOKENS, CTF_EXCHANGE_V2],
  [CONDITIONAL_TOKENS, NEG_RISK_EXCHANGE_V2],
  [CONDITIONAL_TOKENS, NEG_RISK_ADAPTER],
];

const approvalRow = (token: string, spender: string, approved = true) => ({
  id: `${token}-${spender}`,
  feature: "allowance",
  token,
  spender,
  standard: token === PUSD ? "ERC20" : "ERC1155",
  amount: approved ? "max" : "0",
  approved,
});

const FULL_APPROVALS = TABLE.map(([token, spender]) => approvalRow(token, spender));

type ApprovalRow = ReturnType<typeof approvalRow>;
type Tx = {
  state: string;
  proxyAddress?: string;
  /** A per-poll sequence — each `/transaction` read shifts until the last state. */
  states?: string[] | undefined;
};

/** The scripted Polymarket world — tests mutate fields between polls and resumes. */
type PmFeed = {
  /** `/v1/eligibility` — defaults to polymarket "available"; may throw for `error`. */
  eligibility?: () => EligibilityResponse;
  /** `/deployed` — the chain truth per (address, WALLET|SAFE); nothing deployed by default. */
  deployed?: (address: string, type: string) => boolean;
  /** What `/transaction` serves, indexed by submit order. */
  transactions: Tx[];
  /** `/submit` short-circuit — return a Response (400 nonce mismatch, 500) or throw (lost). */
  submit?: ((body: Record<string, unknown>) => Response | undefined) | undefined;
  nonce: string;
  /** `/v2/approvals` contracts — the batch's missing list is derived from this. */
  approvals: ApprovalRow[];
  /** What approvals serves after a confirmed WALLET batch (default: the full table). */
  postApprovals?: ApprovalRow[];
  apiKey?: { status: number; body: unknown };
  deriveApiKey?: { status: number; body: unknown };
  apiKeyDelete?: { status: number; body: unknown };
  /** `/book` answer — a resting one-sided book by default (trade tests script their own). */
  book?: Record<string, unknown>;
  /** `POST /order` answer — `orderId` is echoed back as the accepted id when unset. */
  postOrder?: { status: number; body: unknown };
  /** The id the `POST /order` answer echoes — set from `place()`'s returned `orderId`. */
  orderId?: string;
  /** `DELETE /order` answer — a clean cancel by default. */
  orderDelete?: { status: number; body: unknown };
};

type Call = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const makeFetch = (feed: PmFeed, calls: Call[], now: () => number): typeof globalThis.fetch => {
  let submits = 0;
  const txById = new Map<string, Tx>();
  return async (input, init) => {
    await Promise.resolve();
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (url.pathname === "/v1/eligibility") {
      return Response.json(
        feed.eligibility?.() ?? {
          country: "US",
          region: null,
          apps: { hyperliquid: "available", polymarket: "available" },
        },
      );
    }
    if (url.origin === RELAYER_HOST) {
      if (url.pathname === "/deployed") {
        return Response.json({
          deployed:
            feed.deployed?.(
              url.searchParams.get("address") ?? "",
              url.searchParams.get("type") ?? "SAFE",
            ) ?? false,
        });
      }
      if (url.pathname === "/nonce") {
        return Response.json({ nonce: feed.nonce });
      }
      if (url.pathname === "/submit" && init?.method === "POST") {
        const parsed: unknown = JSON.parse(init.body as string);
        const override = feed.submit?.(isRecord(parsed) ? parsed : {});
        if (override !== undefined) {
          return override;
        }
        const id = `tx-${submits}`;
        submits += 1;
        const tx = feed.transactions[submits - 1] ?? {
          state: "STATE_CONFIRMED",
          proxyAddress: WALLETS.beacon,
        };
        txById.set(id, tx);
        /* A confirmed WALLET batch lands its approvals on-chain — the Data API serves them. */
        const txFinal = tx.states?.at(-1) ?? tx.state;
        if (isRecord(parsed) && parsed["type"] === "WALLET" && txFinal === "STATE_CONFIRMED") {
          feed.approvals = feed.postApprovals ?? FULL_APPROVALS;
        }
        return Response.json({ transactionID: id, state: "STATE_NEW" });
      }
      if (url.pathname === "/transaction") {
        const id = url.searchParams.get("id") ?? "";
        const tx = txById.get(id);
        let txState: string | undefined;
        if (tx !== undefined) {
          txState =
            tx.states === undefined
              ? tx.state
              : tx.states.length > 1
                ? tx.states.shift()
                : tx.states[0];
        }
        return Response.json(
          tx === undefined || txState === undefined
            ? []
            : [
                {
                  transactionID: id,
                  transactionHash: `0x${"aa".repeat(32)}`,
                  state: txState,
                  proxyAddress: tx.proxyAddress,
                },
              ],
        );
      }
    }
    if (url.origin === CLOB_HOST) {
      if (url.pathname === "/time") {
        return Response.json(Math.floor(now() / 1000));
      }
      if (url.pathname === "/auth/api-key" && init?.method === "DELETE") {
        const answer = feed.apiKeyDelete ?? { status: 200, body: "OK" };
        return Response.json(answer.body, { status: answer.status });
      }
      if (url.pathname === "/auth/api-key") {
        const answer = feed.apiKey ?? { status: 200, body: API };
        return Response.json(answer.body, { status: answer.status });
      }
      if (url.pathname === "/auth/derive-api-key") {
        const answer = feed.deriveApiKey ?? { status: 200, body: API };
        return Response.json(answer.body, { status: answer.status });
      }
      if (url.pathname.startsWith("/balance-allowance")) {
        return Response.json({ balance: "1000000", allowances: {} });
      }
      if (url.pathname === "/auth/ban-status/closed-only") {
        return new Response("no record", { status: 404 });
      }
      if (url.pathname === "/book") {
        return Response.json(
          feed.book ?? {
            market: `0x${"ab".repeat(32)}`,
            asset_id: url.searchParams.get("token_id") ?? "1",
            timestamp: "1700000000",
            hash: "0x00",
            bids: [{ price: "0.5", size: "100" }],
            asks: [{ price: "0.55", size: "100" }],
            min_order_size: "1",
            tick_size: "0.01",
            neg_risk: false,
          },
        );
      }
      if (url.pathname === "/order" && init?.method === "POST") {
        const answer = feed.postOrder ?? {
          status: 200,
          body: {
            success: true,
            errorMsg: null,
            orderID: feed.orderId ?? `0x${"cd".repeat(32)}`,
            status: "live",
          },
        };
        return Response.json(answer.body, { status: answer.status });
      }
      if (url.pathname === "/order" && init?.method === "DELETE") {
        const answer = feed.orderDelete ?? {
          status: 200,
          body: { canceled: [feed.orderId ?? `0x${"cd".repeat(32)}`], not_canceled: null },
        };
        return Response.json(answer.body, { status: answer.status });
      }
    }
    if (url.origin === DATA_HOST && url.pathname === "/v2/approvals") {
      return Response.json({
        data: {
          address: url.searchParams.get("user"),
          chain_id: 137,
          checked_at: "2026-11-21T00:00:00Z",
          contracts: feed.approvals,
        },
      });
    }
    if (url.origin === GAMMA_HOST || url.origin === DATA_HOST) {
      return Response.json({ data: [], pagination: {} });
    }
    throw new Error(`unrecorded request: ${url.toString()}`);
  };
};

/** The injected Remote Builder Signing oracle — HMAC-SHA256 over `ts+method+path+body`. */
const builderFor = (
  signs: Array<{ method: string; path: string; body: string }>,
): PolymarketBuilder => ({
  code: `0x${"bb".repeat(32)}`,
  sign: async (request: { method: string; path: string; body: string }) => {
    await Promise.resolve();
    signs.push(request);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      POLY_BUILDER_API_KEY: "builder-key",
      POLY_BUILDER_PASSPHRASE: "builder-pass",
      POLY_BUILDER_SIGNATURE: createHmac("sha256", BUILDER_SECRET)
        .update(`${timestamp}${request.method}${request.path}${request.body}`)
        .digest("base64"),
      POLY_BUILDER_TIMESTAMP: timestamp,
    };
  },
});

const builderHmac = (request: { method: string; path: string; body: string }, ts: string): string =>
  createHmac("sha256", BUILDER_SECRET)
    .update(`${ts}${request.method}${request.path}${request.body}`)
    .digest("base64");

const pmWorld = async (
  feed: PmFeed,
  options: {
    builder?: boolean;
    openStore?: () => Promise<EngineStore>;
  } = {},
) => {
  const calls: Call[] = [];
  const builderSigns: Array<{ method: string; path: string; body: string }> = [];
  const typedData: string[] = [];
  const timers = manualTimer(Date.now());
  const w = await world(0, {
    hyperliquid: false,
    timers,
    fetch: makeFetch(feed, calls, () => timers.time),
    wrapRequests: (requests) => ({
      prepare: async (input) => {
        if (input.method === "evm-sign" && input.request.kind === "evm.typed-data") {
          typedData.push(input.request.typedData);
        }
        return requests.prepare(input);
      },
      outcome: async (id) => requests.outcome(id),
      reject: (id) => requests.reject(id),
    }),
    polymarket: options.builder === false ? {} : { builder: builderFor(builderSigns) },
    ...(options.openStore === undefined ? {} : { openStore: options.openStore }),
  });
  /* No `{...w}` — the world's `provider` getter throws for hyperliquid-less worlds. */
  return {
    wallet: w.wallet,
    walletId: w.walletId,
    pm: w.pm,
    apps: w.apps,
    destroy: w.destroy,
    requests: w.requests,
    posted: w.posted,
    timers: w.timers,
    hl: w.hl,
    store: w.store,
    session: w.session,
    credentials: w.credentials,
    group: w.group,
    warns: w.warns,
    state: w.state,
    pmState: w.pmState,
    approve: w.approve,
    calls,
    typedData,
    builderSigns,
    feed,
  };
};

type PmWorld = Awaited<ReturnType<typeof pmWorld>>;

const deployBeacon = (w: PmWorld): void => {
  w.feed.deployed = (address, type) =>
    type === "WALLET" && address.toLowerCase() === WALLETS.beacon.toLowerCase();
};

const importCreds = async (w: PmWorld): Promise<void> => {
  await w.credentials.put(w.group, { owner: SIGNER, ...API });
};

const deleteCreds = async (w: PmWorld): Promise<void> => {
  await w.credentials.delete(w.group).catch(() => undefined);
};

/** The display of a pending request — the kernel's described content, never a blind payload. */
const contentOf = (w: PmWorld, id: string): PolymarketContent => {
  const pending = w.requests.getState().requests[id];
  expect(pending).toBeDefined();
  const intent = pending?.display as DisplayIntent | undefined;
  expect(intent?.blind).toBeUndefined();
  const content = (intent?.message as { readonly polymarket?: PolymarketContent } | undefined)
    ?.polymarket;
  expect(content).toBeDefined();
  if (content === undefined) {
    throw new Error("the request was not kernel-described as polymarket");
  }
  return content;
};

/** Wait for the flow to publish a pending request and return its id. */
const pendingId = async (w: PmWorld): Promise<string> => {
  await until(() => w.pmState()?.requestId !== undefined);
  return w.pmState()?.requestId ?? "";
};

const submits = (w: PmWorld): ReadonlyArray<Call> =>
  w.calls.filter((c) => c.url.origin === RELAYER_HOST && c.url.pathname === "/submit");

const clobCalls = (w: PmWorld, prefix: string): ReadonlyArray<Call> =>
  w.calls.filter((c) => c.url.origin === CLOB_HOST && c.url.pathname.startsWith(prefix));

/** The persisted apps record — writes are fire-and-forget, so poll until it lands. */
const record = async (w: PmWorld): Promise<Record<string, unknown>> => {
  const key = `${w.walletId}/${w.group.groupIndex}/polymarket`;
  for (let i = 0; i < 100; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- persistence is asynchronous.
    const raw = await w.store.collection("apps").get(key);
    if (raw !== undefined) {
      return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- persistence is asynchronous.
    await tick();
  }
  return {};
};

describe("polymarket enable — happy path", () => {
  it("deploys, derives credentials, batches approvals and verifies — all described", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: [] });
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");

    /* The credentials request is a described ClobAuth — the kernel recognized it. */
    const authId = await pendingId(w);
    expect(contentOf(w, authId)).toMatchObject({ kind: "auth", address: SIGNER });
    await w.approve(authId);

    /* The approvals request is a described Batch over the deposit wallet. */
    await until(() => w.pmState()?.step === "approvals" && w.pmState()?.requestId !== undefined);
    const batchId = w.pmState()?.requestId ?? "";
    const batch = contentOf(w, batchId);
    expect(batch).toMatchObject({ kind: "batch", wallet: WALLETS.beacon });
    if (batch.kind !== "batch") {
      throw new Error("expected a batch");
    }
    expect(batch.calls).toHaveLength(8);
    await w.approve(batchId);

    await pumpUntil(w.timers, () => w.pmState()?.status === "enabled", 200);
    await flow;
    expect(w.pmState()).toMatchObject({
      status: "enabled",
      account: { wallet: WALLETS.beacon, kind: "deposit-wallet", deployed: true },
    });

    /* The two documents the requests carried. */
    const docs = w.typedData.map(
      (d) =>
        JSON.parse(d) as {
          primaryType: string;
          domain: Record<string, unknown>;
          message: Record<string, unknown>;
        },
    );
    expect(docs.map((d) => d.primaryType)).toStrictEqual(["ClobAuth", "Batch"]);
    const [authDoc, batchDoc] = docs;
    expect(authDoc?.domain).toMatchObject({ name: "ClobAuthDomain", version: "1", chainId: 137 });
    expect(authDoc?.message).toMatchObject({ address: SIGNER, nonce: 0 });
    expect(batchDoc?.domain).toMatchObject({
      name: "DepositWallet",
      version: "1",
      chainId: 137,
      verifyingContract: WALLETS.beacon,
    });
    /* The decoded calls are exactly the fixed table — token target, spender, calldata. */
    const calls = (batchDoc?.message["calls"] ?? []) as Array<{
      target: string;
      value: number;
      data: string;
    }>;
    expect(calls).toHaveLength(TABLE.length);
    for (const [i, call] of calls.entries()) {
      const [token, spender] = TABLE[i] as [`0x${string}`, `0x${string}`];
      expect(call.target.toLowerCase()).toBe(token.toLowerCase());
      expect(call.value).toBe(0);
      const selector = call.data.slice(0, 10);
      const arg1 = `0x${call.data.slice(34, 74)}`;
      expect(selector).toBe(token === PUSD ? "0x095ea7b3" : "0xa22cb465");
      expect(arg1.toLowerCase()).toBe(spender.toLowerCase());
      expect(call.data.slice(74)).toBe(token === PUSD ? "f".repeat(64) : "1".padStart(64, "0"));
    }

    /* Deploy and batch submits were HMAC'd by the builder oracle over the exact bytes sent. */
    const posts = submits(w);
    expect(posts).toHaveLength(2);
    const [deployPost, batchPost] = posts;
    expect(JSON.parse(deployPost?.body ?? "{}")).toStrictEqual({
      type: "WALLET-CREATE",
      from: SIGNER,
      to: DEPOSIT_WALLET_FACTORY,
      metadata: "Deploy Deposit Wallet",
    });
    const batchBody = JSON.parse(batchPost?.body ?? "{}") as Record<string, unknown>;
    expect(batchBody["type"]).toBe("WALLET");
    expect(batchBody["from"]).toBe(SIGNER);
    expect(batchBody["nonce"]).toBe("0");
    expect((batchBody["depositWalletParams"] as Record<string, unknown>)["depositWallet"]).toBe(
      WALLETS.beacon,
    );
    for (const [i, post] of posts.entries()) {
      /* The builder signed the exact serialized body that was sent — the sent signature is the
         recomputed HMAC over it under the timestamp the headers carry. */
      expect(w.builderSigns[i]?.body).toBe(post?.body);
      expect(post?.headers["POLY_BUILDER_SIGNATURE"]).toBe(
        builderHmac(
          { method: "POST", path: "/submit", body: post?.body ?? "" },
          post?.headers["POLY_BUILDER_TIMESTAMP"] ?? "",
        ),
      );
    }

    /* The L1 headers match clob-client-v2's createL1Headers over the same inputs. */
    const [create] = clobCalls(w, "/auth/api-key");
    const oracle = await createL1Headers(
      signerAt(0),
      137,
      0,
      Number(create?.headers["POLY_TIMESTAMP"]),
      SIGNER,
    );
    expect(create?.method).toBe("POST");
    expect(create?.headers["POLY_SIGNATURE"]).toBe(oracle.POLY_SIGNATURE);
    expect(create?.headers["POLY_ADDRESS"]).toBe(SIGNER);
    expect(create?.headers["POLY_NONCE"]).toBe("0");

    /* The verify step refreshed the allowance exactly once. */
    expect(clobCalls(w, "/balance-allowance/update")).toHaveLength(1);

    /* The apps store sealed exactly the API answer + owner; the controller record stays the
       terms flag alone. */
    const creds = await w.credentials.get(w.group);
    expect(creds).toStrictEqual({ owner: SIGNER, ...API });
    const raw = await w
      .session()
      ?.collection("apps.polymarket")
      .get(`${w.walletId}/${w.group.groupIndex}/eip155:137`);
    expect(raw).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(raw))).toStrictEqual({ owner: SIGNER, ...API });
    await expect(record(w)).resolves.toStrictEqual({ termsAcknowledged: true });
    await deleteCreds(w);
  });

  it("derives when create fails — one user signature serves both L1 requests", async () => {
    const w = await pmWorld({
      transactions: [],
      nonce: "0",
      approvals: FULL_APPROVALS,
      apiKey: { status: 400, body: { error: "Could not create api key" } },
    });
    deployBeacon(w);
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    await w.approve(await pendingId(w));
    await pumpUntil(w.timers, () => w.pmState()?.status === "enabled", 200);
    await flow;
    const auth = w.calls.filter(
      (c) => c.url.origin === CLOB_HOST && c.url.pathname.startsWith("/auth/"),
    );
    expect(auth.map((c) => `${c.method} ${c.url.pathname}`)).toStrictEqual([
      "POST /auth/api-key",
      "GET /auth/derive-api-key",
    ]);
    /* The derive request reuses the same signature — the user signed once. */
    expect(auth[0]?.headers["POLY_SIGNATURE"]).toBe(auth[1]?.headers["POLY_SIGNATURE"]);
    expect(submits(w)).toHaveLength(0);
    await deleteCreds(w);
  });

  it("skips every finished step — no deploy submit, no request, no auth call", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(w);
    await importCreds(w);
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    await pumpUntil(w.timers, () => w.pmState()?.status === "enabled", 200);
    await flow;
    expect(w.typedData).toHaveLength(0);
    expect(submits(w)).toHaveLength(0);
    expect(clobCalls(w, "/auth/api-key")).toHaveLength(0);
    await deleteCreds(w);
  });
});

describe("polymarket enable — failures leave a resumable state", () => {
  it("refuses a proxyAddress that is not our derivation", async () => {
    const w = await pmWorld({
      transactions: [{ state: "STATE_CONFIRMED", proxyAddress: WALLETS.uups }],
      nonce: "0",
      approvals: [],
    });
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    await expect(flow).rejects.toMatchObject({ category: "unavailable" });
    expect(w.pmState()).toMatchObject({ status: "enabling", step: "deploy-wallet" });
  });

  it.each([["STATE_FAILED"], ["STATE_INVALID"]] as const)(
    "a terminal relayer %s is rejected and stays resumable",
    async (state) => {
      const w = await pmWorld({ transactions: [{ state }], nonce: "0", approvals: [] });
      await w.apps.acknowledgeTerms(w.group, "polymarket");
      const flow = w.apps.enable(w.group, "polymarket");
      await expect(flow).rejects.toMatchObject({ category: "rejected" });
      expect(w.pmState()).toMatchObject({ status: "enabling", step: "deploy-wallet" });
    },
  );

  it("a refused credentials request is approval-rejected; the resume skips deploy", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(w);
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    w.requests.reject(await pendingId(w));
    await expect(flow).rejects.toMatchObject({ category: "approval-rejected" });
    expect(w.pmState()).toMatchObject({ status: "enabling", step: "credentials" });

    const resumed = w.apps.enable(w.group, "polymarket");
    await w.approve(await pendingId(w));
    await pumpUntil(w.timers, () => w.pmState()?.status === "enabled", 200);
    await resumed;
    expect(submits(w)).toHaveLength(0);
    await deleteCreds(w);
  });

  it("an expired credentials request is approval-rejected and resumable", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(w);
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    const settled = swallow(flow);
    await pendingId(w);
    /* The request's 10-minute expiry timer is on the manual clock — pump past it. */
    await pumpUntil(w.timers, () => w.pmState()?.error !== undefined, 700);
    await settled;
    await expect(flow).rejects.toMatchObject({ category: "approval-rejected" });
    expect(w.pmState()).toMatchObject({ status: "enabling", step: "credentials" });
  });

  it("a refused approvals request is approval-rejected; resume submits the batch once", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: [] });
    deployBeacon(w);
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    await w.approve(await pendingId(w));
    await until(() => w.pmState()?.step === "approvals" && w.pmState()?.requestId !== undefined);
    w.requests.reject(w.pmState()?.requestId ?? "");
    await expect(flow).rejects.toMatchObject({ category: "approval-rejected" });
    expect(w.pmState()).toMatchObject({ status: "enabling", step: "approvals" });
    expect(submits(w)).toHaveLength(0);

    const resumed = w.apps.enable(w.group, "polymarket");
    await w.approve(await pendingId(w));
    await pumpUntil(w.timers, () => w.pmState()?.status === "enabled", 200);
    await resumed;
    expect(submits(w)).toHaveLength(1);
    await deleteCreds(w);
  });

  it("a 400 batch-nonce mismatch is rejected — never re-signed or re-posted in one flow", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: [] });
    deployBeacon(w);
    w.feed.submit = (body) =>
      body["type"] === "WALLET"
        ? Response.json({ error: "batch nonce 0 does not match on-chain nonce 3" }, { status: 400 })
        : undefined;
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    await w.approve(await pendingId(w));
    /* `step === "approvals"` is written after the auth request id clears — the id seen here is
       the batch request, never the ended auth one. */
    await until(() => w.pmState()?.step === "approvals" && w.pmState()?.requestId !== undefined);
    await w.approve(w.pmState()?.requestId ?? "");
    await expect(flow).rejects.toMatchObject({ category: "rejected" });
    expect(w.pmState()).toMatchObject({ status: "enabling", step: "approvals" });
    expect(submits(w)).toHaveLength(1);

    /* The resume re-reads the on-chain nonce and finishes with a fresh signature. */
    w.feed.nonce = "3";
    w.feed.submit = undefined;
    const resumed = w.apps.enable(w.group, "polymarket");
    await w.approve(await pendingId(w));
    await pumpUntil(w.timers, () => w.pmState()?.status === "enabled", 200);
    await resumed;
    expect(submits(w)).toHaveLength(2);
    const batchBody = JSON.parse(submits(w)[1]?.body ?? "{}") as Record<string, unknown>;
    expect(batchBody["nonce"]).toBe("3");
    await deleteCreds(w);
  });

  it("keeps polling past STATE_MINED until CONFIRMED", async () => {
    const w = await pmWorld({
      transactions: [
        {
          state: "STATE_MINED",
          states: ["STATE_MINED", "STATE_CONFIRMED"],
          proxyAddress: WALLETS.beacon,
        },
      ],
      nonce: "0",
      approvals: FULL_APPROVALS,
    });
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    /* The deploy poll sleeps 2 s between reads — pump the clock while the request arrives. */
    await pumpUntil(w.timers, () => w.pmState()?.requestId !== undefined, 200);
    await w.approve(w.pmState()?.requestId ?? "");
    await pumpUntil(w.timers, () => w.pmState()?.status === "enabled", 200);
    await flow;
    /* The MINED answer was not terminal — the poll ran again and saw CONFIRMED. */
    expect(
      w.calls.filter((c) => c.url.origin === RELAYER_HOST && c.url.pathname === "/transaction"),
    ).toHaveLength(2);
    await deleteCreds(w);
  });

  it("a poll timeout is unavailable and resumable — reconcile re-reads /deployed", async () => {
    const w = await pmWorld({
      transactions: [{ state: "STATE_MINED" }],
      nonce: "0",
      approvals: [],
    });
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    const settled = swallow(flow);
    /* 60 polls × 2 s on the manual clock reaches the 120 s deadline. */
    await pumpUntil(w.timers, () => w.pmState()?.error !== undefined, 400);
    await settled;
    await expect(flow).rejects.toMatchObject({ category: "unavailable" });
    expect(w.pmState()).toMatchObject({ status: "enabling", step: "deploy-wallet" });
    expect(submits(w)).toHaveLength(1);
  });

  it("a lost submit (network failure) is never re-sent — the step stays resumable", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: [] });
    w.feed.submit = () => {
      throw new Error("connection reset");
    };
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    await expect(flow).rejects.toMatchObject({ category: "network" });
    expect(submits(w)).toHaveLength(1);
    expect(w.pmState()).toMatchObject({ status: "enabling" });
  });

  it("create and derive both failing is unavailable and resumable at credentials", async () => {
    const w = await pmWorld({
      transactions: [],
      nonce: "0",
      approvals: FULL_APPROVALS,
      apiKey: { status: 500, body: { error: "exploded" } },
      deriveApiKey: { status: 500, body: { error: "exploded" } },
    });
    deployBeacon(w);
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    await w.approve(await pendingId(w));
    await expect(flow).rejects.toMatchObject({ category: "unavailable" });
    expect(w.pmState()).toMatchObject({ status: "enabling", step: "credentials" });
  });

  it("refuses unacknowledged terms before any relayer request", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: [] });
    await expect(w.apps.enable(w.group, "polymarket")).rejects.toMatchObject({
      category: "invalid-input",
    });
    expect(w.calls.filter((c) => c.url.origin === RELAYER_HOST)).toHaveLength(0);
  });

  it("requires the builder at deploy and at approvals — before any submission", async () => {
    const atDeploy = await pmWorld(
      { transactions: [], nonce: "0", approvals: [] },
      { builder: false },
    );
    await atDeploy.apps.acknowledgeTerms(atDeploy.group, "polymarket");
    await expect(atDeploy.apps.enable(atDeploy.group, "polymarket")).rejects.toMatchObject({
      category: "builder-required",
    });
    expect(submits(atDeploy)).toHaveLength(0);

    const atApprovals = await pmWorld(
      { transactions: [], nonce: "0", approvals: [] },
      { builder: false },
    );
    deployBeacon(atApprovals);
    await importCreds(atApprovals);
    await atApprovals.apps.acknowledgeTerms(atApprovals.group, "polymarket");
    const flow = atApprovals.apps.enable(atApprovals.group, "polymarket");
    await expect(flow).rejects.toMatchObject({ category: "builder-required" });
    /* No nonce read, no /submit, no approval request was opened for the batch. */
    expect(
      atApprovals.calls.filter((c) => c.url.pathname === "/nonce" || c.url.pathname === "/submit"),
    ).toHaveLength(0);
    expect(Object.keys(atApprovals.requests.getState().requests)).toHaveLength(0);
    await deleteCreds(atApprovals);
  });
});

describe("polymarket reconcile — facts only, never a request", () => {
  it("maps locate/credentials/approvals facts to the right status", async () => {
    /* Safe only → needs-migration with the Safe account. */
    const safe = await pmWorld({ transactions: [], nonce: "0", approvals: [] });
    safe.feed.deployed = (address, type) =>
      type === "SAFE" && address.toLowerCase() === WALLETS.safe.toLowerCase();
    await safe.apps.reconcile(safe.group);
    await until(() => safe.pmState()?.status === "needs-migration");
    expect(safe.pmState()).toMatchObject({
      status: "needs-migration",
      account: { wallet: WALLETS.safe, kind: "safe", deployed: true },
    });

    /* Deployed beacon, no creds → disabled with the located account. */
    const noCreds = await pmWorld({ transactions: [], nonce: "0", approvals: [] });
    deployBeacon(noCreds);
    await noCreds.apps.reconcile(noCreds.group);
    await until(() => noCreds.pmState()?.status === "disabled");
    expect(noCreds.pmState()?.account).toMatchObject({
      wallet: WALLETS.beacon,
      kind: "deposit-wallet",
      deployed: true,
    });

    /* Creds + deployed + partial approvals → enabling at approvals, no request opened. */
    const partial = await pmWorld({
      transactions: [],
      nonce: "0",
      approvals: FULL_APPROVALS.slice(0, 5),
    });
    deployBeacon(partial);
    await importCreds(partial);
    await partial.apps.reconcile(partial.group);
    await until(() => partial.pmState()?.status === "enabling");
    expect(partial.pmState()).toMatchObject({ status: "enabling", step: "approvals" });
    expect(partial.pmState()?.requestId).toBeUndefined();
    expect(Object.keys(partial.requests.getState().requests)).toHaveLength(0);

    /* All facts complete → enabled. */
    const done = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(done);
    await importCreds(done);
    await done.apps.reconcile(done.group);
    await until(() => done.pmState()?.status === "enabled");
    await Promise.all([partial, done].map(async (w) => deleteCreds(w)));
  });

  it("a deployed deposit wallet alongside a Safe records legacySafe", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    w.feed.deployed = (address, type) =>
      address.toLowerCase() === (type === "SAFE" ? WALLETS.safe : WALLETS.beacon).toLowerCase();
    await importCreds(w);
    await w.apps.reconcile(w.group);
    await until(() => w.pmState()?.status === "enabled");
    expect(w.pmState()?.account).toMatchObject({
      wallet: WALLETS.beacon,
      kind: "deposit-wallet",
      legacySafe: WALLETS.safe,
    });
    await deleteCreds(w);
  });
});

describe("polymarket enable — gates and controller integration", () => {
  it.each(["available", "close-only"] as const)(
    "eligibility %s can enable — close-only users need credentials to sell",
    async (availability) => {
      const w = await pmWorld({
        transactions: [],
        nonce: "0",
        approvals: FULL_APPROVALS,
        eligibility: () => ({
          country: "CU",
          region: null,
          apps: { hyperliquid: "blocked", polymarket: availability },
        }),
      });
      deployBeacon(w);
      await w.apps.acknowledgeTerms(w.group, "polymarket");
      const flow = w.apps.enable(w.group, "polymarket");
      await w.approve(await pendingId(w));
      await pumpUntil(w.timers, () => w.pmState()?.status === "enabled", 200);
      await flow;
      expect(w.pmState()?.status).toBe("enabled");
      await deleteCreds(w);
    },
  );

  it("a blocked jurisdiction cannot enable — PolymarketError('blocked')", async () => {
    const w = await pmWorld({
      transactions: [],
      nonce: "0",
      approvals: [],
      eligibility: () => ({
        country: "KP",
        region: null,
        apps: { hyperliquid: "blocked", polymarket: "blocked" },
      }),
    });
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    await expect(w.apps.enable(w.group, "polymarket")).rejects.toMatchObject({
      category: "blocked",
    });
  });

  it("an eligibility error fails closed — PolymarketError('blocked')", async () => {
    const w = await pmWorld({
      transactions: [],
      nonce: "0",
      approvals: [],
      eligibility: () => {
        throw new Error("gateway down");
      },
    });
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    await expect(w.apps.enable(w.group, "polymarket")).rejects.toMatchObject({
      category: "blocked",
    });
  });

  it("controller failures are the app's own error type", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: [] });
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const first = w.apps.enable(w.group, "polymarket");
    const authId = await pendingId(w);
    const busy = w.apps.enable(w.group, "polymarket");
    await expect(busy).rejects.toBeInstanceOf(PolymarketError);
    await expect(busy).rejects.toMatchObject({ category: "busy" });
    w.requests.reject(authId);
    await swallow(first);
  });

  it("the persisted record reloads under its own app key after a restart", async () => {
    const openStore = restartableStore();
    const w1 = await pmWorld({ transactions: [], nonce: "0", approvals: [] }, { openStore });
    await w1.apps.acknowledgeTerms(w1.group, "polymarket");
    await until(() => w1.pmState()?.termsAcknowledged === true);
    /* A fresh controller over the same store must find the polymarket record — the record key
       is parsed with isAppId, not a hard-coded app name. */
    const w2 = await pmWorld({ transactions: [], nonce: "0", approvals: [] }, { openStore });
    await until(() => w2.pmState()?.termsAcknowledged === true);
    expect(w2.pmState()?.termsAcknowledged).toBe(true);
  });

  it("renew is refused — Polymarket credentials do not expire", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: [] });
    await expect(w.apps.renew(w.group, "polymarket")).rejects.toMatchObject({
      category: "invalid-input",
    });
  });

  it("cancel rejects the open request and lands on the reconciled state", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(w);
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    const settled = swallow(flow);
    await pendingId(w);
    await w.apps.cancel(w.group, "polymarket");
    await settled;
    await expect(flow).rejects.toMatchObject({ category: "approval-rejected" });
    /* No credentials were imported — reconcile's answer is disabled. */
    await until(() => w.pmState()?.status === "disabled");
    expect(w.pmState()?.status).toBe("disabled");
  });
});

describe("polymarket disable", () => {
  const enabled = async (): Promise<PmWorld> => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(w);
    await importCreds(w);
    return w;
  };

  it("revoke calls L2 DELETE /auth/api-key first, then deletes the vault record", async () => {
    const w = await enabled();
    await w.apps.disable(w.group, "polymarket", { revoke: true });
    await until(() => w.pmState()?.status === "disabled");
    const revoked = w.calls.find(
      (c) => c.method === "DELETE" && c.url.pathname === "/auth/api-key",
    );
    /* An L2 request — the engine-signed headers identify the group's api key. */
    expect(revoked?.headers["POLY_API_KEY"]).toBe(API.apiKey);
    expect(revoked?.headers["POLY_SIGNATURE"]).toBeDefined();
    await expect(w.credentials.get(w.group)).resolves.toBeUndefined();
  });

  it("a failed revoke still disables — the error is recorded, not fatal", async () => {
    const w = await enabled();
    w.feed.apiKeyDelete = { status: 500, body: { error: "exploded" } };
    await w.apps.disable(w.group, "polymarket", { revoke: true });
    await until(() => w.pmState()?.status === "disabled");
    expect(w.pmState()?.error?.category).toBe("unavailable");
    await expect(w.credentials.get(w.group)).resolves.toBeUndefined();
  });

  it("revoke: false deletes only the apps record", async () => {
    const w = await enabled();
    await w.apps.disable(w.group, "polymarket", { revoke: false });
    await until(() => w.pmState()?.status === "disabled");
    expect(w.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await expect(w.credentials.get(w.group)).resolves.toBeUndefined();
  });
});

describe("credential records", () => {
  it("a locked vault fails every L2 read, place and cancel unlock-required with zero calls", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(w);
    await importCreds(w);
    const pm = w.pm;
    if (pm === undefined) {
      throw new Error("the world has no polymarket provider");
    }
    await w.wallet.vault.lock();
    /* The lock event closes the session store — the apps state reports locked first. */
    await until(() => w.apps.getState().locked);
    const calls = w.calls.length;
    await expect(pm.account.openOrders(w.group, {})).rejects.toMatchObject({
      category: "unlock-required",
    });
    await expect(
      pm.trade.place(w.group, {
        kind: "limit",
        assetId: "1",
        side: "BUY",
        price: "0.5",
        size: "1",
        orderType: "GTC",
      }),
    ).rejects.toMatchObject({ category: "unlock-required" });
    await expect(pm.trade.cancel(w.group, `0x${"cd".repeat(32)}`)).rejects.toMatchObject({
      category: "unlock-required",
    });
    expect(w.calls).toHaveLength(calls);
    await w.wallet.vault.unlock(VERIFY);
  });

  it("a deleted wallet's credential records are pruned on the wallet event", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(w);
    await importCreds(w);
    /* A second wallet joins, gets a record, and is deleted — the wallet event prunes its row. */
    const second = await w.wallet.wallets.importMnemonic({
      mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
    });
    const foreign: AppGroup = { walletId: second.walletId, groupIndex: 0 };
    await w.credentials.put(foreign, { owner: SIGNER, ...API });
    await w.wallet.wallets.delete(second.walletId, VERIFY);
    for (let i = 0; i < 100; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the prune runs on the wallet event.
      if ((await w.credentials.get(foreign)) === undefined) {
        break;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- the prune runs on the wallet event.
      await tick();
    }
    await expect(w.credentials.get(foreign)).resolves.toBeUndefined();
    /* The live wallet's record survives. */
    await expect(w.credentials.get(w.group)).resolves.toStrictEqual({ owner: SIGNER, ...API });
    await deleteCreds(w);
  });
});

describe("secret hygiene", () => {
  it("credentials stay out of state, logs and errors across enable, place, cancel and disable", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(w);
    const pm = w.pm;
    if (pm === undefined) {
      throw new Error("the world has no polymarket provider");
    }
    await w.apps.acknowledgeTerms(w.group, "polymarket");
    const flow = w.apps.enable(w.group, "polymarket");
    /* FULL_APPROVALS leaves no batch — the ClobAuth is the flow's only request. */
    await w.approve(await pendingId(w));
    await pumpUntil(w.timers, () => w.pmState()?.status === "enabled", 200);
    await flow;

    const placed = await pm.trade.place(w.group, {
      kind: "limit",
      assetId: "1",
      side: "SELL",
      price: "0.55",
      size: "10",
      orderType: "GTC",
    });
    w.feed.orderId = placed.orderId;
    await w.approve(placed.requestId);
    await placed.outcome;
    await pm.trade.cancel(w.group, placed.orderId);
    await w.apps.disable(w.group, "polymarket", { revoke: true });
    await until(() => w.pmState()?.status === "disabled");

    /* The apiKey and passphrase ride L2 headers legitimately — the secret never does. */
    const haystack = JSON.stringify(w.apps.getState()) + w.warns.join("\n");
    expect(haystack).not.toContain(API.secret);
    expect(haystack).not.toContain(API.passphrase);
    for (const call of w.calls) {
      expect(call.body ?? "").not.toContain(API.secret);
      expect(JSON.stringify(call.headers)).not.toContain(API.secret);
    }
  });

  it("a hostile error body echoing the credentials is scrubbed from error, state and logs", async () => {
    const w = await pmWorld({ transactions: [], nonce: "0", approvals: FULL_APPROVALS });
    deployBeacon(w);
    await importCreds(w);
    /* The revoke answer reflects all three credential fields back inside its error body. */
    w.feed.apiKeyDelete = {
      status: 500,
      body: { error: API.apiKey, detail: API.secret, hint: API.passphrase },
    };
    await w.apps.disable(w.group, "polymarket", { revoke: true });
    await until(() => w.pmState()?.status === "disabled");
    const haystack =
      JSON.stringify(w.pmState()?.error ?? {}) +
      JSON.stringify(w.apps.getState()) +
      w.warns.join("\n");
    for (const value of [API.apiKey, API.secret, API.passphrase]) {
      expect(haystack).not.toContain(value);
    }
    await expect(w.credentials.get(w.group)).resolves.toBeUndefined();
  });
});
