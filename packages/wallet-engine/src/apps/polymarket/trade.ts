/**
 * Polymarket trading: quotes, order placement through a kernel-described `TypedDataSign` approval,
 * and cancels (design.md §订单数学, research.md §3).
 *
 * `place` returns before the user approves: the order id is the order's EIP-712 hash — known before
 * the signature exists — and `outcome` resolves once the approval resolved and the POST's answer
 * was classified. The answer split:
 *
 * - `success: true` with our `orderID` → `resting`/`matched`/`delayed`/`unmatched` by status;
 * - `success: false`, or a definitive 4xx carrying a JSON error body → `rejected` with a reason
 *   classified from the message (docs resources/error-codes.md);
 * - Anything that can have committed without telling us — timeout, network, 5xx, a malformed or
 *   id-mismatched 2xx — is reconciled by `GET /data/order/{id}` at 0/+2 s/+5 s, never re-posted: V2
 *   orders sign no expiry, so a lost order stays submittable by whoever holds it. Found → its
 *   status. Never seen (every read absent or failed) → `unknown` after a best-effort `DELETE
 *   /order` by id — its result rides the outcome as `cancel`. An unproven absence is never proof
 *   the POST did not land, so `unknown` MUST NOT be blindly retried: re-placing creates a second
 *   order if the first one surfaces. Every `unknown` keeps reconciling for ten minutes and reports
 *   its eventual status through `trade.corrections`.
 *
 * The close-only gate is provider-level (invariant): any BUY — `place` or `quote` — requires
 * gateway availability `"available"` AND `closedOnly(group)` false; an unknown eligibility or a
 * failed read refuses closed. SELL, cancels and reads are never gated.
 */
import type * as z from "zod/mini";

import type { Wallet } from "@qntx/wallet";

import { RequestEndedError } from "../spi.ts";
import type { AppAvailability, AppGroup, AppRequests, SetTimer } from "../spi.ts";
import type { PolymarketAccountReads } from "./account.ts";
import { PolymarketError } from "./errors.ts";
import type { PolymarketL2 } from "./l2.ts";
import type { PolymarketMarkets } from "./markets.ts";
import {
  buildPolymarketOrder,
  exchangeDomain,
  orderBody,
  polymarketOrderId,
  quoteLimit,
  quoteMarket,
  typedDataSignDocument,
  wireSignature,
} from "./orders.ts";
import type {
  PolymarketExchangeDomain,
  PolymarketLimitParams,
  PolymarketMarketParams,
  PolymarketOrderDraft,
  PolymarketQuote,
} from "./orders.ts";
import { clobCancelResponse, clobPostOrderResponse } from "./schemas.ts";

const ORDER_ID = /^0x[0-9a-fA-F]{64}$/;
const GTD_MIN_SECONDS = 180;
const CANCEL_MANY_LIMIT = 500;
const SALT_MOD = 2n ** 53n;
/** Reconcile reads after an unknown POST answer — offsets from the answer. */
const RECONCILE_MS = [0, 2000, 5000] as const;
/* The late reconcile mirrors Hyperliquid's window in apps/hyperliquid/exchange.ts: pending
   outcomes are re-asked every 10 s for 10 minutes, bounded to 64 entries. */
const RECONCILE_LATE_POLL_MS = 10_000;
const RECONCILE_LATE_WINDOW_MS = 600_000;
const MAX_UNRESOLVED = 64;
const NETWORK = "eip155:137";

const reconcileStatus = (
  orderId: string,
  status: string,
  row: { readonly sizeMatched: string },
): PolymarketOrderOutcome => {
  switch (status) {
    case "LIVE":
      return { kind: "resting", orderId };
    case "MATCHED":
      return { kind: "matched", orderId, making: row.sizeMatched };
    case "CANCELED":
      return { kind: "canceled", orderId, making: row.sizeMatched };
    case "DELAYED":
      return { kind: "delayed", orderId };
    case "UNMATCHED":
      return { kind: "unmatched", orderId };
    default:
      return { kind: "unknown", orderId };
  }
};

export type PolymarketPlaceParams =
  | ({ readonly kind: "limit" } & PolymarketLimitParams & {
        readonly orderType: "GTC" | "GTD";
        /** GTD only — unix seconds ≥ now + 180 (unsigned on the wire; the CLOB enforces it). */
        readonly expiration?: number;
        /** The order must rest on the book, never match immediately. */
        readonly postOnly?: boolean;
      })
  | ({ readonly kind: "market" } & PolymarketMarketParams);

/** Why the CLOB refused an order — classified from its `errorMsg`/`error` text. */
export type PolymarketRejectReason =
  | "balance-or-allowance"
  | "tick"
  | "min-size"
  | "market-closed"
  | "post-only-cross"
  | "fok-unfilled"
  | "invalid-signature"
  | "rate-limited"
  | "close-only"
  | "other";

/**
 * What the defensive `DELETE /order` after an unproven absence did — present on `unknown` outcomes
 * only when the order was never seen by any reconcile read.
 */
export type PolymarketCancelAttempt =
  /**
   * The CLOB listed our order id under `canceled` — only the remaining size was canceled; the order
   * may still have partially filled first (the outcome/correction carries the fill).
   */
  | { readonly kind: "canceled" }
  /** The CLOB refused — `reason` is its `not_canceled[id]` text, or that it listed neither. */
  | { readonly kind: "not-canceled"; readonly reason: string }
  /** The DELETE itself never produced an answer. */
  | { readonly kind: "failed"; readonly message: string };

export type PolymarketOrderOutcome =
  /** `live` — resting on the book. */
  | { readonly kind: "resting"; readonly orderId: string }
  | {
      readonly kind: "matched";
      readonly orderId: string;
      readonly making?: string;
      readonly taking?: string;
      readonly tradeIds?: ReadonlyArray<string>;
    }
  /** `delayed` — accepted, matching delayed by market conditions. */
  | { readonly kind: "delayed"; readonly orderId: string }
  | { readonly kind: "unmatched"; readonly orderId: string }
  /** The CLOB definitively refused — nothing was posted. */
  | {
      readonly kind: "rejected";
      readonly reason: PolymarketRejectReason;
      readonly message: string;
    }
  /**
   * Reconcile found the order canceled. `making` is the row's `size_matched` — > "0" means the
   * order partially filled before it was canceled; re-place only the unfilled remainder.
   */
  | { readonly kind: "canceled"; readonly orderId: string; readonly making: string }
  /**
   * The POST's fate is unknowable — the order may or may not exist; never blindly re-place (a
   * later-landing first order plus the retry is a duplicate position). `cancel` — present iff the
   * order was never seen — records the defensive `DELETE /order` attempt; `trade.corrections`
   * reports the eventual status for up to ten minutes.
   */
  | {
      readonly kind: "unknown";
      readonly orderId: string;
      readonly cancel?: PolymarketCancelAttempt;
    };

/** The eventual status of an outcome that resolved `unknown` — emitted by `trade.corrections`. */
export type PolymarketOutcomeCorrection = {
  readonly group: AppGroup;
  readonly orderId: string;
  readonly outcome: PolymarketOrderOutcome;
};

export type PolymarketPlacedOrder = {
  /** The approval request the host shows — the kernel describes the deposit-wallet order. */
  readonly requestId: string;
  /** The order's EIP-712 hash — known before approval, asserted against the answer's `orderID`. */
  readonly orderId: string;
  readonly quote: PolymarketQuote;
  /** Resolves to the classified outcome; rejects with `approval-rejected`/`unlock-required`. */
  readonly outcome: Promise<PolymarketOrderOutcome>;
};

export type PolymarketCancelResult = {
  readonly canceled: ReadonlyArray<string>;
  /** Id → the server's reason it stayed. */
  readonly notCanceled: Readonly<Record<string, string>>;
};

export type PolymarketTrading = {
  /**
   * Quote an order against the current book — BUY quotes are gated like `place` (availability +
   * closed-only).
   */
  readonly quote: (group: AppGroup, params: PolymarketPlaceParams) => Promise<PolymarketQuote>;
  /** Build, get approval for and post an order — see the module doc for the outcome contract. */
  readonly place: (
    group: AppGroup,
    params: PolymarketPlaceParams,
  ) => Promise<PolymarketPlacedOrder>;
  readonly cancel: (group: AppGroup, orderId: string) => Promise<PolymarketCancelResult>;
  /** 1..500 ids per call. */
  readonly cancelMany: (
    group: AppGroup,
    orderIds: ReadonlyArray<string>,
  ) => Promise<PolymarketCancelResult>;
  readonly cancelAll: (group: AppGroup) => Promise<PolymarketCancelResult>;
  readonly cancelMarket: (
    group: AppGroup,
    params: { readonly market?: string; readonly assetId?: string },
  ) => Promise<PolymarketCancelResult>;
  /**
   * Late reconcile of `unknown` outcomes: the order id is re-asked every 10 s for 10 minutes and
   * the found status is emitted once — a correction is never re-posted and a lock drops every
   * pending entry.
   */
  readonly corrections: {
    readonly subscribe: (listener: (correction: PolymarketOutcomeCorrection) => void) => () => void;
  };
};

export type PolymarketTradeOptions = {
  readonly l2: PolymarketL2;
  readonly account: PolymarketAccountReads;
  readonly markets: PolymarketMarkets;
  readonly requests: Pick<AppRequests, "prepare" | "outcome">;
  /** Vault lock/unlock — a lock drops every pending `unknown` outcome. */
  readonly wallet: Wallet;
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly setTimer: SetTimer;
  /** The gateway availability for `polymarket` — `undefined` means unverified (BUY refuses). */
  readonly availability: () => AppAvailability | undefined;
  /** Only the bytes32 `code` reaches the signed order — the host's `sign` is provider config. */
  readonly builder?: { readonly code?: `0x${string}` };
};

const accountRef = (group: AppGroup) => ({
  kind: "hd" as const,
  walletId: group.walletId,
  groupIndex: group.groupIndex,
  template: "evm.bip44" as const,
});

const pendingKey = (group: AppGroup, orderId: string) =>
  `${group.walletId}|${group.groupIndex}|${orderId}`;

/** A 53-bit salt — `Number(draft.salt)` must serialize exactly (salt rides the wire as a number). */
const saltOf = (random: (length: number) => Uint8Array): string => {
  let salt = 0n;
  for (const byte of random(8)) {
    salt = salt * 256n + BigInt(byte);
  }
  return (salt % SALT_MOD).toString(10);
};

/** The errorMsg/error text → the refusal class (docs resources/error-codes.md). */
const classify = (message: string | undefined, status?: number): PolymarketRejectReason => {
  const m = (message ?? "").toLowerCase();
  if (status === 429 || m.includes("too many requests") || m.includes("rate limit")) {
    return "rate-limited";
  }
  if (m.includes("signature") || m.includes("signer address")) {
    return "invalid-signature";
  }
  if (m.includes("balance") || m.includes("allowance")) {
    return "balance-or-allowance";
  }
  if (m.includes("tick")) {
    return "tick";
  }
  if (m.includes("minimum") || m.includes("min size")) {
    return "min-size";
  }
  if (m.includes("closed only")) {
    return "close-only";
  }
  if (m.includes("post-only") || m.includes("crosses book") || m.includes("crosses the book")) {
    return "post-only-cross";
  }
  if (m.includes("fok") || m.includes("fully filled") || m.includes("filled or killed")) {
    return "fok-unfilled";
  }
  if (
    m.includes("not yet ready") ||
    m.includes("not accepting") ||
    m.includes("market is closed") ||
    m.includes("cancel-only") ||
    m.includes("trading is currently")
  ) {
    return "market-closed";
  }
  return "other";
};

/** The message a non-2xx body carries — `{error}` or `{errorMsg}` strings only. */
const bodyMessage = (body: Readonly<Record<string, unknown>>): string | undefined => {
  const error = body["error"] ?? body["errorMsg"];
  return typeof error === "string" ? error.slice(0, 500) : undefined;
};

export function createPolymarketTrade(options: PolymarketTradeOptions): PolymarketTrading {
  const wait = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
      options.setTimer(ms, resolve);
    });

  /** BUY refuses closed: unverified eligibility or a failed close-only read is a refusal. */
  const assertOpenable = async (group: AppGroup): Promise<void> => {
    const availability = options.availability();
    if (availability !== "available") {
      throw new PolymarketError(
        "close-only",
        availability === "close-only"
          ? "Polymarket is close-only in this jurisdiction"
          : "Polymarket availability is unverified — refusing to open a position",
      );
    }
    let closed: boolean;
    try {
      closed = await options.account.closedOnly(group);
    } catch (error) {
      throw new PolymarketError(
        "close-only",
        "the account's close-only status could not be read — refusing to open a position",
        { cause: error },
      );
    }
    if (closed) {
      throw new PolymarketError("close-only", "the account is in close-only mode");
    }
  };

  const listeners = new Set<(correction: PolymarketOutcomeCorrection) => void>();
  const emit = (correction: PolymarketOutcomeCorrection): void => {
    for (const listener of listeners) {
      listener(correction);
    }
  };

  type Pending = {
    readonly group: AppGroup;
    readonly orderId: string;
    readonly since: number;
  };
  /* Outcomes that resolved `unknown`, awaiting a provable status — keyed `group|orderId`,
     insertion order is eviction order. */
  const pending = new Map<string, Pending>();
  let pollCancel: (() => void) | undefined;
  let lockWatch: (() => void) | undefined;
  /* Bumped by every lock — an outcome signed in one unlocked session is never registered in a
     later one, even when its in-call reconcile outlives a lock and an unlock. */
  let session = 0;

  /* The vault is the boundary: a lock drops every pending order id and stops the poll — the
     corrections a new session earns are its own. Subscribed lazily, on the first signed action, so
     a reads-only provider never needs the wallet's subscription channel. */
  const watchLock = (): void => {
    lockWatch ??= options.wallet.subscribe(() => {
      if (options.wallet.getSnapshot().vault.status !== "unlocked") {
        session += 1;
        pending.clear();
        pollCancel?.();
        pollCancel = undefined;
      }
    });
  };

  /** One `order` read for a pending id — a found row corrects and drops it. */
  const probe = async (entry: Pending): Promise<void> => {
    let outcome: PolymarketOrderOutcome;
    try {
      const found = await options.account.order(entry.group, entry.orderId);
      if (found === undefined) {
        return; // still absent — the timer re-asks until the window closes
      }
      outcome = reconcileStatus(entry.orderId, found.status, found);
    } catch {
      return; // a failed late read stays pending — the timer re-asks
    }
    if (outcome.kind === "unknown") {
      return; // an unrecognised status proves nothing — a correction must be provable; re-ask
    }
    const key = pendingKey(entry.group, entry.orderId);
    if (pending.get(key) === entry) {
      pending.delete(key);
      emit({ group: entry.group, orderId: entry.orderId, outcome });
    }
  };

  const schedulePoll = (): void => {
    if (pollCancel === undefined && pending.size > 0) {
      pollCancel = options.setTimer(RECONCILE_LATE_POLL_MS, () => {
        pollCancel = undefined;
        void (async (): Promise<void> => {
          for (const entry of pending.values()) {
            if (options.now() - entry.since >= RECONCILE_LATE_WINDOW_MS) {
              pending.delete(pendingKey(entry.group, entry.orderId)); // expired: stays unknown
            } else {
              // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls keep the weight bounded.
              await probe(entry);
            }
          }
          schedulePoll();
        })();
      });
    }
  };

  const registerPending = (group: AppGroup, orderId: string, signedIn: number): void => {
    if (signedIn !== session || options.wallet.getSnapshot().vault.status !== "unlocked") {
      return; // a locked session drops its pending ids — nothing account-bound survives it
    }
    const key = pendingKey(group, orderId);
    if (!pending.has(key) && pending.size >= MAX_UNRESOLVED) {
      const [oldest] = pending.keys();
      if (oldest !== undefined) {
        pending.delete(oldest);
      }
    }
    pending.set(key, { group, orderId, since: options.now() });
    schedulePoll();
  };

  /**
   * The best-effort `DELETE /order` for an order no read ever saw — same authenticated request the
   * explicit `cancel` sends. Never throws: the attempt's fate rides the `unknown` outcome.
   */
  const cancelAttempt = async (
    group: AppGroup,
    orderId: string,
  ): Promise<PolymarketCancelAttempt> => {
    try {
      const answer = await options.l2.request(
        group,
        {
          method: "DELETE",
          path: "/order",
          body: JSON.stringify({ orderID: orderId }),
        },
        clobCancelResponse,
      );
      if ((answer.canceled ?? []).includes(orderId)) {
        return { kind: "canceled" };
      }
      const reason = (answer.not_canceled ?? {})[orderId];
      return {
        kind: "not-canceled",
        reason: reason ?? "the cancel answer lists the order in neither canceled nor not_canceled",
      };
    } catch (error) {
      return {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  /**
   * Ask the CLOB for the order at 0/+2 s/+5 s — never re-post: a V2 order signs no expiry, so a
   * lost order could still be submitted by whoever holds the signed body. An order no read saw is
   * NOT proven absent, so the answer is `unknown` after a best-effort cancel attempt; every
   * `unknown` registers for the late reconcile.
   */
  const reconcile = async (
    group: AppGroup,
    orderId: string,
    signedIn: number,
  ): Promise<PolymarketOrderOutcome> => {
    let waited = 0;
    for (const at of RECONCILE_MS) {
      if (at > waited) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the reads are deliberately spaced
        await wait(at - waited);
        waited = at;
      }
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each read waits for the previous
        const found = await options.account.order(group, orderId);
        if (found !== undefined) {
          const outcome = reconcileStatus(orderId, found.status, found);
          if (outcome.kind === "unknown") {
            registerPending(group, orderId, signedIn);
          }
          return outcome;
        }
      } catch {
        /* A failed read proves nothing either way. */
      }
    }
    const cancel = await cancelAttempt(group, orderId);
    registerPending(group, orderId, signedIn);
    return { kind: "unknown", orderId, cancel };
  };

  const settleAnswer = async (
    answer: z.output<typeof clobPostOrderResponse>,
    group: AppGroup,
    orderId: string,
    signedIn: number,
  ): Promise<PolymarketOrderOutcome> => {
    if (!answer.success) {
      return {
        kind: "rejected",
        reason: classify(answer.errorMsg ?? undefined),
        message: answer.errorMsg ?? "the CLOB rejected the order",
      };
    }
    /* A mismatched or missing order id is never trusted — reconcile like a malformed answer. */
    if (answer.orderID !== orderId) {
      return reconcile(group, orderId, signedIn);
    }
    switch (answer.status) {
      case "live":
        return { kind: "resting", orderId };
      case "matched":
        return {
          kind: "matched",
          orderId,
          ...(answer.makingAmount === undefined || answer.makingAmount === null
            ? {}
            : { making: answer.makingAmount }),
          ...(answer.takingAmount === undefined || answer.takingAmount === null
            ? {}
            : { taking: answer.takingAmount }),
          ...(answer.tradeIDs === undefined || answer.tradeIDs === null
            ? {}
            : { tradeIds: answer.tradeIDs }),
        };
      case "delayed":
        return { kind: "delayed", orderId };
      case "unmatched":
        return { kind: "unmatched", orderId };
      default:
        return reconcile(group, orderId, signedIn);
    }
  };

  const settleError = async (
    error: unknown,
    group: AppGroup,
    orderId: string,
    signedIn: number,
  ): Promise<PolymarketOrderOutcome> => {
    if (error instanceof PolymarketError) {
      /* A definitive 4xx carrying a JSON error body: the server refused before matching. */
      if (
        error.category === "unavailable" &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.body !== undefined
      ) {
        const message = bodyMessage(error.body);
        return {
          kind: "rejected",
          reason: classify(message, error.status),
          message: message ?? `the CLOB answered ${error.status}`,
        };
      }
      /* The POST may have committed — timeout, network, 5xx, malformed 2xx: reconcile. */
      if (
        error.category === "network" ||
        error.category === "timeout" ||
        error.category === "unavailable" ||
        error.category === "malformed"
      ) {
        return reconcile(group, orderId, signedIn);
      }
    }
    /* unlock-required/not-enabled/clock-skew/invalid-input: definitive pre-post failures. */
    throw error;
  };

  const runOutcome = async (
    group: AppGroup,
    requestId: string,
    draft: PolymarketOrderDraft,
    domain: PolymarketExchangeDomain,
    orderId: string,
    params: PolymarketPlaceParams,
    apiKey: string,
    signedIn: number,
  ): Promise<PolymarketOrderOutcome> => {
    let inner: Uint8Array;
    try {
      const result = await options.requests.outcome(requestId);
      if (
        !("kind" in result) ||
        result.kind !== "evm.typed-data" ||
        result.signature.length !== 65
      ) {
        throw new PolymarketError(
          "unavailable",
          "the request resolved without a typed-data signature",
        );
      }
      inner = result.signature;
    } catch (error) {
      if (error instanceof RequestEndedError) {
        throw new PolymarketError("approval-rejected", `the request was ${error.stage}`, {
          cause: error,
        });
      }
      throw error;
    }
    const signature = wireSignature(inner, draft, domain);
    const body = orderBody(
      draft,
      signature,
      apiKey,
      params.orderType,
      params.kind === "limit" && params.postOnly === true,
    );
    try {
      const answer = await options.l2.request(
        group,
        { method: "POST", path: "/order", body },
        clobPostOrderResponse,
      );
      return await settleAnswer(answer, group, orderId, signedIn);
    } catch (error) {
      return settleError(error, group, orderId, signedIn);
    }
  };

  const validatePlace = (params: PolymarketPlaceParams): void => {
    if (params.kind === "limit") {
      if (params.orderType !== "GTC" && params.orderType !== "GTD") {
        throw new PolymarketError("invalid-input", "limit orders are GTC or GTD");
      }
      if (params.orderType === "GTC" && params.expiration !== undefined) {
        throw new PolymarketError("invalid-input", "expiration applies to GTD orders only");
      }
      if (params.orderType === "GTD") {
        if (params.expiration === undefined) {
          throw new PolymarketError("invalid-input", "GTD orders need an expiration");
        }
        if (
          !Number.isInteger(params.expiration) ||
          params.expiration < Math.floor(options.now() / 1000) + GTD_MIN_SECONDS
        ) {
          throw new PolymarketError(
            "invalid-input",
            "GTD expiration must be a unix time at least 3 minutes out",
          );
        }
      }
    } else if ("postOnly" in params || "expiration" in params) {
      /* postOnly is structurally absent on market params — refuse it reaching the wire anyway. */
      throw new PolymarketError("invalid-input", "postOnly/expiration apply to limit orders only");
    }
  };

  return {
    quote: async (group, params) => {
      validatePlace(params);
      if (params.side === "BUY") {
        await assertOpenable(group);
      }
      const book = await options.markets.book(params.assetId);
      return params.kind === "limit" ? quoteLimit(params, book) : quoteMarket(params, book);
    },

    place: async (group, params) => {
      validatePlace(params);
      /* Credentials first: a locked vault fails `unlock-required` before locate derives anything. */
      const creds = await options.l2.credentials(group);
      if (creds === undefined) {
        throw new PolymarketError("not-enabled", "the group has no Polymarket credentials");
      }
      const located = await options.account.locate(group);
      if (located.kind === "safe") {
        throw new PolymarketError(
          "needs-migration",
          "the account resolves to a legacy Safe — migrate to a deposit wallet to trade",
        );
      }
      if (!located.deployed) {
        throw new PolymarketError("not-enabled", "the account wallet is not deployed yet");
      }
      /* A record written for another signer must never reach the approval — the L2 POST would
         refuse it anyway, but the user would already have signed the order. */
      if (creds.owner.toLowerCase() !== located.signer.toLowerCase()) {
        throw new PolymarketError(
          "not-enabled",
          "the stored credentials belong to another signer — re-enable the account",
        );
      }
      if (params.side === "BUY") {
        await assertOpenable(group);
      }
      /* The domain comes from the live book — tick/neg-risk/version can change between reads. */
      const book = await options.markets.book(params.assetId);
      const quote = params.kind === "limit" ? quoteLimit(params, book) : quoteMarket(params, book);
      const domain = exchangeDomain(book);
      const draft = buildPolymarketOrder({
        wallet: located.wallet,
        assetId: params.assetId,
        side: params.side,
        makerAmount: quote.makerAmount,
        takerAmount: quote.takerAmount,
        salt: saltOf(options.random),
        timestampMs: options.now(),
        ...(options.builder?.code === undefined ? {} : { builderCode: options.builder.code }),
        ...(params.kind === "limit" && params.orderType === "GTD"
          ? { expiration: String(params.expiration) }
          : {}),
      });
      const orderId = polymarketOrderId(draft, domain);
      /* Lock-watching and the session stamp start at the signed action — an outcome that resolves
         after the vault locked is never registered for late reconcile. */
      watchLock();
      const signedIn = session;
      const pending = await options.requests.prepare({
        method: "evm-sign",
        account: accountRef(group),
        network: NETWORK,
        request: {
          kind: "evm.typed-data",
          network: NETWORK,
          account: accountRef(group),
          typedData: typedDataSignDocument(draft, domain),
        },
      });
      const outcome = runOutcome(
        group,
        pending.id,
        draft,
        domain,
        orderId,
        params,
        creds.apiKey,
        signedIn,
      );
      /* The consumer's own await still sees a rejection — this only marks it handled. */
      void (async () => {
        try {
          await outcome;
        } catch {
          /* marked handled */
        }
      })();
      return { requestId: pending.id, orderId, quote, outcome };
    },

    cancel: async (group, orderId) => {
      if (!ORDER_ID.test(orderId)) {
        throw new PolymarketError("invalid-input", `bad order id ${orderId}`);
      }
      const answer = await options.l2.request(
        group,
        { method: "DELETE", path: "/order", body: JSON.stringify({ orderID: orderId }) },
        clobCancelResponse,
      );
      return {
        canceled: answer.canceled ?? [],
        notCanceled: answer.not_canceled ?? {},
      };
    },

    cancelMany: async (group, orderIds) => {
      if (orderIds.length === 0 || orderIds.length > CANCEL_MANY_LIMIT) {
        throw new PolymarketError("invalid-input", "cancelMany takes 1..500 order ids");
      }
      for (const orderId of orderIds) {
        if (!ORDER_ID.test(orderId)) {
          throw new PolymarketError("invalid-input", `bad order id ${orderId}`);
        }
      }
      const answer = await options.l2.request(
        group,
        { method: "DELETE", path: "/orders", body: JSON.stringify([...orderIds]) },
        clobCancelResponse,
      );
      return {
        canceled: answer.canceled ?? [],
        notCanceled: answer.not_canceled ?? {},
      };
    },

    cancelAll: async (group) => {
      const answer = await options.l2.request(
        group,
        { method: "DELETE", path: "/cancel-all" },
        clobCancelResponse,
      );
      return {
        canceled: answer.canceled ?? [],
        notCanceled: answer.not_canceled ?? {},
      };
    },

    cancelMarket: async (group, params) => {
      if (params.market === undefined && params.assetId === undefined) {
        throw new PolymarketError("invalid-input", "cancelMarket needs a market or an assetId");
      }
      const answer = await options.l2.request(
        group,
        {
          method: "DELETE",
          path: "/cancel-market-orders",
          body: JSON.stringify({
            ...(params.market === undefined ? {} : { market: params.market }),
            ...(params.assetId === undefined ? {} : { asset_id: params.assetId }),
          }),
        },
        clobCancelResponse,
      );
      return {
        canceled: answer.canceled ?? [],
        notCanceled: answer.not_canceled ?? {},
      };
    },

    corrections: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}
