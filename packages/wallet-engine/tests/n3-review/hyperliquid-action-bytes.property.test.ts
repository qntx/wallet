/**
 * Every action body the provider signs and POSTs — across the whole public trade surface — must
 * carry a signature that recovers to the enabled agent under the nktkas L1 action hash. Generated
 * calls go through the real Node kernel; the POSTed JSON itself is hashed and recovered, so any
 * drift between the bytes that were signed and the bytes that were sent fails here.
 */
import { readFileSync } from "node:fs";

import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import * as fc from "fast-check";
import { recoverTypedDataAddress } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { hyperliquid } from "@qntx/wallet/hyperliquid";

import type { HyperliquidGroup } from "../../src/apps/hyperliquid/agents.ts";
import { createHyperliquidProvider } from "../../src/apps/hyperliquid/provider.ts";
import type {
  HyperliquidProvider,
  HyperliquidProviderInternals,
} from "../../src/apps/hyperliquid/provider.ts";
import type { HyperliquidTrade } from "../../src/apps/hyperliquid/trade.ts";

const KERNEL_URL = new URL("../../../wallet-worker/dist/kernel.node.js", import.meta.url);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const NOW = Date.now();
const DAY = 86_400_000;

const fixture = (name: string): { response: unknown } =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/hyperliquid/testnet/${name}.json`, import.meta.url), "utf8"),
  ) as { response: unknown };

const MIDS = { BTC: "57957.5", ETH: "4000", "PURR/USDC": "0.5" };

const STATE = {
  assetPositions: [
    {
      type: "oneWay",
      position: { coin: "BTC", szi: "-0.5", leverage: { type: "cross", value: 5 } },
    },
  ],
  marginSummary: { accountValue: "1" },
  crossMarginSummary: { accountValue: "1" },
  withdrawable: "1",
};

const OPEN_ORDERS = [
  { oid: 5, coin: "BTC" },
  { oid: 6, coin: "ETH" },
];

type Posted = { readonly endpoint: "info" | "exchange"; readonly body: Record<string, unknown> };

const serve = (posted: Posted[]) => {
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const endpoint = String(url).endsWith("/exchange") ? "exchange" : "info";
    posted.push({ endpoint, body });
    if (endpoint === "exchange") {
      const action = body["action"] as { type?: string; orders?: unknown[]; modifies?: unknown[] };
      const count =
        action.type === "order"
          ? (action.orders?.length ?? 1)
          : action.type === "batchModify"
            ? (action.modifies?.length ?? 1)
            : 1;
      const statuses = Array.from({ length: Math.max(count, 1) }, () => ({
        resting: { oid: 7 },
      }));
      const data =
        action.type === "cancel" || action.type === "cancelByCloid"
          ? { statuses: statuses.map(() => "success") }
          : { statuses };
      return Response.json({ status: "ok", response: { type: "order", data } });
    }
    const response =
      body["type"] === "metaAndAssetCtxs"
        ? fixture("metaAndAssetCtxs").response
        : body["type"] === "spotMetaAndAssetCtxs"
          ? fixture("spotMetaAndAssetCtxs").response
          : body["type"] === "allMids"
            ? MIDS
            : body["type"] === "frontendOpenOrders"
              ? OPEN_ORDERS
              : body["type"] === "clearinghouseState"
                ? STATE
                : body["type"] === "orderStatus"
                  ? { status: "unknownOid" }
                  : {};
    return Response.json(response);
  };
  return fetch;
};

let shared: { wallet: Wallet; walletId: string } | undefined;

const nodeWallet = async (): Promise<{ wallet: Wallet; walletId: string }> => {
  if (shared === undefined) {
    const wallet = await createNodeWallet({
      verifyEvent,
      passkey: {
        rpId: "qntx.test",
        rpName: "qntx",
        walletSalt: "qntx/wallet",
        backupSalt: "qntx/backup",
        vaultSalt: "qntx/vault",
      },
      autoLock: { platform: "web", idleMinutes: 15 },
      authenticator: createSoftwarePasskey(new Uint8Array(32).fill(11)),
      kernelUrl: KERNEL_URL,
    });
    const { walletId } = await wallet.wallets.importMnemonic({
      mnemonic: MNEMONIC,
      factor: { kind: "password", password: PASSWORD },
    });
    shared = { wallet, walletId };
  }
  return shared;
};

const AGENT_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

/** The posted body re-parsed, re-hashed, recovered — must be the agent, proving posted == signed. */
const verifyPosted = async (posted: Posted, agent: string): Promise<void> => {
  const { body } = posted;
  const signature = body["signature"] as { r: string; s: string; v: number };
  expect(signature).toMatchObject({ v: expect.any(Number) });
  expect([27, 28]).toContain(signature.v);
  expect(body["vaultAddress"]).toBeUndefined();
  const hash = createL1ActionHash({
    action: body["action"] as Parameters<typeof createL1ActionHash>[0]["action"],
    nonce: body["nonce"] as number,
    expiresAfter: body["expiresAfter"] as number,
  });
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337n,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: AGENT_TYPES,
    primaryType: "Agent",
    message: { source: "b", connectionId: hash },
    signature: `0x${signature.r.slice(2)}${signature.s.slice(2)}${signature.v.toString(16)}`,
  });
  expect(recovered.toLowerCase()).toBe(agent.toLowerCase());
};

const coinArb = fc.constantFrom("BTC", "ETH");
const sideArb = fc.constantFrom("buy" as const, "sell" as const);
const priceArb = fc.constantFrom(
  "58000",
  "57957.5",
  "60000",
  "4000",
  "100",
  "50",
  "123.456",
  "0.999",
  "99999.9999",
);
const sizeArb = fc.constantFrom("0.1", "0.5", "1", "2.5", "0.25");
const cloidArb = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((b) => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`);
const slippageArb = fc.integer({ min: 1, max: 1000 });

const limitOrder = fc
  .record({
    kind: fc.constant("limit" as const),
    price: priceArb,
    tif: fc.option(fc.constantFrom("Gtc" as const, "Ioc" as const, "Alo" as const), {
      nil: undefined,
    }),
  })
  .map((o) =>
    o.tif === undefined
      ? { kind: "limit" as const, price: o.price }
      : { kind: "limit" as const, price: o.price, tif: o.tif },
  );
const marketOrder = fc.record({
  kind: fc.constant("market" as const),
  slippageBps: slippageArb,
});
const triggerSpec = fc.oneof(
  fc.record({ triggerPx: priceArb, slippageBps: slippageArb }),
  fc.record({ triggerPx: priceArb, price: priceArb }),
  fc.record({ triggerPx: priceArb, market: fc.constant(false), price: priceArb }),
);
const triggerOrder = fc
  .tuple(fc.constantFrom("tp" as const, "sl" as const), triggerSpec)
  .map(([tpsl, spec]) => ({ kind: "trigger" as const, tpsl, ...spec }));
const orderArb = fc.oneof(limitOrder, marketOrder, triggerOrder);

type TriggerSpec = {
  readonly triggerPx: string;
  readonly market?: boolean;
  readonly price?: string;
  readonly slippageBps?: number;
};
type Order =
  | { readonly kind: "limit"; readonly price: string; readonly tif?: "Gtc" | "Ioc" | "Alo" }
  | { readonly kind: "market"; readonly slippageBps: number }
  | ({ readonly kind: "trigger"; readonly tpsl: "tp" | "sl" } & TriggerSpec);

/**
 * Notional must clear the venue's 10-quote minimum or the order is refused before signing; a market
 * trigger wires ~0.9x its triggerPx, so price-ish fields are kept at 11.2x headroom.
 */
const legClears = (spec: Order | TriggerSpec, size: string): boolean =>
  ["price" in spec ? spec.price : undefined, "triggerPx" in spec ? spec.triggerPx : undefined]
    .filter((p): p is string => p !== undefined)
    .every((p) => Number(p) * Number(size) >= 11.2);

const modifyItem = fc.record({
  oid: fc.oneof(fc.integer({ min: 1, max: 999_999 }), cloidArb),
  coin: coinArb,
  side: sideArb,
  size: sizeArb,
  reduceOnly: fc.option(fc.boolean(), { nil: undefined }),
  order: orderArb,
});

type Call =
  | {
      readonly m: "place";
      readonly coin: string;
      readonly side: "buy" | "sell";
      readonly size: string;
      readonly reduceOnly?: boolean;
      readonly order: Order;
      readonly takeProfit?: TriggerSpec;
      readonly stopLoss?: TriggerSpec;
      readonly positionTpsl?: boolean;
    }
  | { readonly m: "modify" | "batchModify"; readonly items: ReadonlyArray<ModifyItem> }
  | {
      readonly m: "cancel";
      readonly items: ReadonlyArray<{ readonly coin: string; readonly oid: number }>;
    }
  | {
      readonly m: "cancelByCloid";
      readonly items: ReadonlyArray<{ readonly coin: string; readonly cloid: string }>;
    }
  | { readonly m: "cancelAll" }
  | { readonly m: "scheduleCancel"; readonly time?: number }
  | {
      readonly m: "twap";
      readonly coin: string;
      readonly side: "buy" | "sell";
      readonly size: string;
      readonly minutes: number;
      readonly randomize: boolean;
      readonly reduceOnly?: boolean;
    }
  | { readonly m: "twapCancel"; readonly coin: string; readonly twapId: number }
  | {
      readonly m: "setLeverage";
      readonly coin: string;
      readonly leverage: number;
      readonly marginMode: "cross" | "isolated";
    }
  | { readonly m: "adjustMargin"; readonly coin: string; readonly amount: string }
  | { readonly m: "close"; readonly coin: string; readonly slippageBps: number };

type ModifyItem = {
  readonly oid: number | string;
  readonly coin: string;
  readonly side: "buy" | "sell";
  readonly size: string;
  readonly reduceOnly?: boolean;
  readonly order: Order;
};

const callArb = fc.oneof(
  fc
    .record({
      m: fc.constant("place" as const),
      coin: coinArb,
      side: sideArb,
      size: sizeArb,
      reduceOnly: fc.option(fc.boolean(), { nil: undefined }),
      order: fc.oneof(limitOrder, marketOrder),
      takeProfit: fc.option(triggerSpec, { nil: undefined }),
      stopLoss: fc.option(triggerSpec, { nil: undefined }),
    })
    .filter(
      (r) =>
        legClears(r.order, r.size) &&
        (r.takeProfit === undefined || legClears(r.takeProfit, r.size)) &&
        (r.stopLoss === undefined || legClears(r.stopLoss, r.size)),
    ),
  fc
    .record({
      m: fc.constant("place" as const),
      coin: coinArb,
      side: sideArb,
      size: sizeArb,
      reduceOnly: fc.option(fc.boolean(), { nil: undefined }),
      order: triggerOrder,
      positionTpsl: fc.option(fc.constant(true), { nil: undefined }),
    })
    .filter((r) => legClears(r.order, r.size)),
  fc
    .record({
      m: fc.constant("modify" as const),
      items: fc.tuple(modifyItem).map((items) => [...items]),
    })
    .filter((r) => r.items.every((i) => legClears(i.order, i.size))),
  fc
    .record({
      m: fc.constant("batchModify" as const),
      items: fc.array(modifyItem, { minLength: 2, maxLength: 4 }),
    })
    .filter((r) => r.items.every((i) => legClears(i.order, i.size))),
  fc.record({
    m: fc.constant("cancel" as const),
    items: fc.array(fc.record({ coin: coinArb, oid: fc.integer({ min: 1, max: 999_999 }) }), {
      minLength: 1,
      maxLength: 3,
    }),
  }),
  fc.record({
    m: fc.constant("cancelByCloid" as const),
    items: fc.array(fc.record({ coin: coinArb, cloid: cloidArb }), {
      minLength: 1,
      maxLength: 3,
    }),
  }),
  fc.record({ m: fc.constant("cancelAll" as const) }),
  fc.record({
    m: fc.constant("scheduleCancel" as const),
    time: fc.option(fc.integer({ min: NOW + 10_000, max: NOW + 300_000 }), { nil: undefined }),
  }),
  fc.record({
    m: fc.constant("twap" as const),
    coin: coinArb,
    side: sideArb,
    size: sizeArb,
    minutes: fc.integer({ min: 5, max: 1440 }),
    randomize: fc.boolean(),
    reduceOnly: fc.option(fc.boolean(), { nil: undefined }),
  }),
  fc.record({
    m: fc.constant("twapCancel" as const),
    coin: coinArb,
    twapId: fc.integer({ min: 1, max: 9999 }),
  }),
  fc.record({
    m: fc.constant("setLeverage" as const),
    coin: coinArb,
    leverage: fc.integer({ min: 1, max: 20 }),
    marginMode: fc.constantFrom("cross" as const, "isolated" as const),
  }),
  fc.record({
    m: fc.constant("adjustMargin" as const),
    coin: coinArb,
    amount: fc
      .tuple(fc.constantFrom("", "-"), fc.integer({ min: 1, max: 999 }))
      .map(([sign, n]) => `${sign}${n}`),
  }),
  fc.record({
    m: fc.constant("close" as const),
    coin: fc.constant("BTC"),
    slippageBps: fc.integer({ min: 1, max: 500 }),
  }),
);

/** Executes one generated call through the public trade API. */
const runCall = async (
  trade: HyperliquidTrade,
  group: HyperliquidGroup,
  call: Call,
): Promise<void> => {
  switch (call.m) {
    case "place":
      await trade.place(group, {
        coin: call.coin,
        side: call.side,
        size: call.size,
        ...(call.reduceOnly === undefined ? {} : { reduceOnly: call.reduceOnly }),
        order: call.order,
        ...(call.takeProfit === undefined ? {} : { takeProfit: call.takeProfit }),
        ...(call.stopLoss === undefined ? {} : { stopLoss: call.stopLoss }),
        ...(call.positionTpsl === undefined ? {} : { positionTpsl: call.positionTpsl }),
      });
      return;
    case "modify":
    case "batchModify": {
      const items: ModifyItem[] = call.items.map((i) => ({
        oid: i.oid,
        coin: i.coin,
        side: i.side,
        size: i.size,
        ...(i.reduceOnly === undefined ? {} : { reduceOnly: i.reduceOnly }),
        order: i.order,
      }));
      if (call.m === "modify") {
        const [item] = items;
        if (item === undefined) {
          return;
        }
        await trade.modify(group, item);
      } else {
        await trade.batchModify(group, items);
      }
      return;
    }
    case "cancel":
      await trade.cancel(group, [...call.items]);
      return;
    case "cancelByCloid":
      await trade.cancelByCloid(group, [...call.items]);
      return;
    case "cancelAll":
      await trade.cancelAll(group);
      return;
    case "scheduleCancel":
      await trade.scheduleCancel(group, call.time);
      return;
    case "twap":
      await trade.twap(group, {
        coin: call.coin,
        side: call.side,
        size: call.size,
        minutes: call.minutes,
        randomize: call.randomize,
        ...(call.reduceOnly === undefined ? {} : { reduceOnly: call.reduceOnly }),
      });
      return;
    case "twapCancel":
      await trade.twapCancel(group, { coin: call.coin, twapId: call.twapId });
      return;
    case "setLeverage":
      await trade.setLeverage(group, {
        coin: call.coin,
        leverage: call.leverage,
        marginMode: call.marginMode,
      });
      return;
    case "adjustMargin":
      await trade.adjustMargin(group, { coin: call.coin, amount: call.amount });
      return;
    case "close":
      await trade.close(group, { coin: call.coin, slippageBps: call.slippageBps });
  }
};

describe("every signed action body recovers to the agent", () => {
  it(
    "generated trade calls post bodies whose signatures verify against the L1 hash",
    { timeout: 120_000 },
    async () => {
      const posted: Posted[] = [];
      const { wallet, walletId } = await nodeWallet();
      const provider: HyperliquidProvider & HyperliquidProviderInternals =
        createHyperliquidProvider({
          network: "Testnet",
          fetch: serve(posted),
          now: () => NOW,
          setTimer: () => () => {},
          wallet,
          random: (length) => new Uint8Array(length).fill(7),
          logger: { warn: () => undefined },
        });
      const agent = await hyperliquid(wallet).createAgent({
        owner: { walletId, groupIndex: 0 },
        network: "Testnet",
        name: "property",
        validUntil: NOW + DAY,
      });
      await provider.agents.refresh();
      provider.agents.markEnabled(agent);
      const group = { walletId, groupIndex: 0 };

      await fc.assert(
        fc.asyncProperty(callArb as fc.Arbitrary<Call>, async (call) => {
          const before = posted.length;
          await runCall(provider.trade, group, call);
          const posts = posted.slice(before).filter((p) => p.endpoint === "exchange");
          expect(posts.length).toBeGreaterThan(0);
          for (const post of posts) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential recovery checks.
            await verifyPosted(post, agent);
          }
        }),
        { numRuns: 60 },
      );
    },
  );
});
