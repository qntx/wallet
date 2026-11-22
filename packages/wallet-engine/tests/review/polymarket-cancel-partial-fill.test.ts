// oxlint-disable vitest/no-conditional-in-test -- union narrowing and mocked fetches are inherent
// `reconcileStatus` maps a CLOB "CANCELED" order row to plain `{kind:"canceled"}` and drops the
// row's `size_matched`: when the wallet's own defensive DELETE canceled a partially filled order,
// the outcome and the correction say nothing filled — a host that trusts that re-places the full
// size on top of the fill the server already recorded.

import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import type { PolymarketAccountReads, PolymarketOrder } from "../../src/apps/polymarket/account.ts";
import { PolymarketError } from "../../src/apps/polymarket/errors.ts";
import type { PolymarketL2 } from "../../src/apps/polymarket/l2.ts";
import type { PolymarketBook, PolymarketMarkets } from "../../src/apps/polymarket/markets.ts";
import { createPolymarketTrade } from "../../src/apps/polymarket/trade.ts";
import type { PolymarketOutcomeCorrection } from "../../src/apps/polymarket/trade.ts";
import type { AppGroup, AppRequests } from "../../src/apps/types.ts";
import { manualTimer } from "../apps-helpers.ts";

const GROUP: AppGroup = { walletId: "w", groupIndex: 0 };
const SIGNER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const ASSET = "21742633143463906290569050155826241533067272736897614950488156847949938836455";
const CONDITION = `0x${"ab".repeat(32)}`;
const LIMIT_BUY = {
  kind: "limit" as const,
  assetId: ASSET,
  side: "BUY" as const,
  price: "0.52",
  size: "10",
  orderType: "GTC" as const,
};

const BOOK: PolymarketBook = {
  assetId: ASSET,
  conditionId: CONDITION,
  version: "v1",
  bids: [{ price: "0.5", size: "100" }],
  asks: [
    { price: "0.55", size: "100" },
    { price: "0.6", size: "100" },
  ],
  tickSize: "0.01",
  minOrderSize: "1",
  negRisk: false,
  timestamp: "1700000000",
  hash: "0x00",
};

const orderRow = (status: string, sizeMatched: string): PolymarketOrder => ({
  id: `0x${"12".repeat(32)}`,
  status,
  conditionId: CONDITION,
  assetId: ASSET,
  side: "BUY",
  price: "0.52",
  originalSize: "10",
  sizeMatched,
  orderType: "GTC",
  expiration: "0",
  createdAt: 1700000000,
  makerAddress: WALLET,
});

const realDelay = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 10);
  });

/** Pump the manual timer until `promise` settles — the reconcile reads are deliberately spaced. */
const settled = async <T>(
  timers: ReturnType<typeof manualTimer>,
  promise: Promise<T>,
): Promise<T> => {
  let done = false;
  void promise.finally(() => {
    done = true;
  });
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `done` flips on settlement
  for (let i = 0; !done && i < 400; i += 1) {
    timers.pump();
    // oxlint-disable-next-line eslint/no-await-in-loop -- the async probe settles between pumps
    await realDelay();
  }
  return promise;
};

/**
 * `orderReads` is the scripted sequence for `account.order` — the in-call reconcile consumes three
 * (0/+2 s/+5 s), the late probe the next ones. `postBehavior` is what `POST /order` does.
 */
const rig = (over: {
  readonly orderReads: ReadonlyArray<PolymarketOrder | undefined>;
  readonly post?: "live" | "explode";
}) => {
  const timers = manualTimer(Date.now());
  const corrections: PolymarketOutcomeCorrection[] = [];
  let reads = 0;
  const l2 = {
    credentials: async () =>
      Promise.resolve({
        apiKey: "key",
        secret: "c2VjcmV0",
        passphrase: "pass",
        owner: SIGNER,
      }),
    request: async (
      _group: AppGroup,
      req: { method: string; path: string; body?: string },
      _schema: unknown,
    ) => {
      if (req.method === "POST" && req.path === "/order") {
        if (over.post === "explode") {
          /* A 5xx may have committed — the POST's fate is unknown by design. */
          return Promise.reject(
            new PolymarketError("unavailable", "upstream exploded", { status: 503 }),
          );
        }
        return Promise.resolve({ success: true, orderID: "auto", status: "live" });
      }
      if (req.method === "DELETE" && req.path === "/order") {
        /* The defensive cancel answers as the CLOB would when it did cancel the order. */
        const body = JSON.parse(req.body ?? "{}") as { orderID?: string };
        return Promise.resolve({ canceled: [body.orderID], not_canceled: {} });
      }
      return Promise.reject(new Error(`unmocked ${req.method} ${req.path}`));
    },
  } as unknown as PolymarketL2;
  const account = {
    locate: async () =>
      Promise.resolve({ signer: SIGNER, wallet: WALLET, kind: "deposit-wallet", deployed: true }),
    closedOnly: async () => Promise.resolve(false),
    order: async (_group: AppGroup, _orderId: string) => {
      const row = over.orderReads[reads];
      reads += 1;
      return Promise.resolve(row);
    },
  } as unknown as PolymarketAccountReads;
  const markets = {
    book: async () => Promise.resolve(BOOK),
  } as unknown as PolymarketMarkets;
  const requests = {
    prepare: async () => Promise.resolve({ id: "req-1" }),
    outcome: async () =>
      Promise.resolve({ kind: "evm.typed-data", signature: new Uint8Array(65).fill(7) }),
  } as unknown as Pick<AppRequests, "prepare" | "outcome">;
  const wallet = {
    getSnapshot: () => ({ vault: "unlocked" }),
    subscribe: () => () => undefined,
  } as unknown as Wallet;
  const trade = createPolymarketTrade({
    l2,
    account,
    markets,
    requests,
    wallet,
    random: (n) => new Uint8Array(n).fill(0x11),
    now: timers.now,
    setTimer: timers.setTimer,
    availability: () => "available",
  });
  trade.corrections.subscribe((correction) => {
    corrections.push(correction);
  });
  return { trade, timers, corrections };
};

describe("a canceled order's partial fill never reaches the outcome", () => {
  it("the late correction reports plain canceled though the row carried size_matched", async () => {
    const { trade, timers, corrections } = rig({
      post: "explode",
      /* Three absent reconcile reads, then the late probe sees the order — canceled by the
         wallet's own DELETE, but not before it had filled 4.5 of the 10. */
      orderReads: [undefined, undefined, undefined, orderRow("CANCELED", "4.5")],
    });
    const placed = await trade.place(GROUP, LIMIT_BUY);
    const outcome = await settled(timers, placed.outcome);
    expect(outcome).toStrictEqual({
      kind: "unknown",
      orderId: placed.orderId,
      cancel: { kind: "canceled" },
    });
    /* Pump until the late probe emits its correction. */
    for (let i = 0; corrections.length === 0 && i < 400; i += 1) {
      timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- the probe is async
      await realDelay();
    }
    expect(corrections).toHaveLength(1);
    const corrected = corrections[0]?.outcome;
    /* The fill is silently lost: canceled carries no making/size field at all. */
    expect(corrected).toStrictEqual({ kind: "canceled", orderId: placed.orderId });
    expect(corrected !== undefined && "making" in corrected).toBe(false);
  });

  it("an in-call CANCELED row with a partial fill resolves to plain canceled", async () => {
    const { trade, timers } = rig({
      post: "explode",
      orderReads: [orderRow("CANCELED", "4.5")],
    });
    const placed = await trade.place(GROUP, LIMIT_BUY);
    const outcome = await settled(timers, placed.outcome);
    expect(outcome).toStrictEqual({ kind: "canceled", orderId: placed.orderId });
    expect("making" in outcome).toBe(false);
  });
});
