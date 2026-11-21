import type { IRequestTransport } from "@nktkas/hyperliquid";

import { WalletError } from "@qntx/wallet";
import type { Wallet } from "@qntx/wallet";
import { hyperliquid } from "@qntx/wallet/hyperliquid";
import type { HyperliquidL1Action } from "@qntx/wallet/protocol";

import type { SetTimer } from "../../timer.ts";
import type { HyperliquidAccount } from "./account.ts";
import type { HyperliquidAgent, HyperliquidAgentRegistry, HyperliquidGroup } from "./agents.ts";
import { MAX_SKEW_MS } from "./clock.ts";
import type { HyperliquidClock } from "./clock.ts";
import { HyperliquidError } from "./errors.ts";
import type { HyperliquidMarkets } from "./markets.ts";

/** Why Hyperliquid refused an order — the docs error table plus the wire status names. */
export type HyperliquidRejectReason =
  | "tick"
  | "min-notional"
  | "margin"
  | "reduce-only"
  | "post-only-would-match"
  | "ioc-no-match"
  | "bad-trigger"
  | "no-liquidity"
  | "open-interest-cap"
  | "insufficient-spot-balance"
  | "oracle"
  | "max-position"
  | "other";

/** What happened to one order of an order action, on the wire or after reconciliation. */
export type HyperliquidOrderOutcome =
  | {
      readonly kind: "resting";
      /** Absent for `waitingForFill`/`waitingForTrigger` statuses, which carry no oid. */
      readonly oid?: number | undefined;
      readonly cloid?: string | undefined;
    }
  | {
      readonly kind: "filled";
      readonly oid?: number | undefined;
      readonly cloid?: string | undefined;
      readonly totalSz: string;
      readonly avgPx: string;
    }
  | {
      readonly kind: "rejected";
      readonly cloid?: string | undefined;
      readonly reason: HyperliquidRejectReason;
      readonly message: string;
    }
  | { readonly kind: "not-placed"; readonly cloid?: string | undefined }
  | { readonly kind: "unknown"; readonly cloid?: string | undefined };

/** What happened to one entry of a cancel action. */
export type HyperliquidCancelOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "unknown" };

/** What happened to an action without per-element statuses; `twapId` when a TWAP started. */
export type HyperliquidActionOutcome =
  | { readonly kind: "ok"; readonly twapId?: number }
  | { readonly kind: "unknown" };

/** The official app's action horizon: 15 s (research §Endpoints). */
const EXPIRES_AFTER_MS = 15_000;

/** Poll cadence for cloid reconciliation — orderStatus is weight 2, the deadline is seconds away. */
const RECONCILE_POLL_MS = 1000;

/** After `expiresAfter` plus the skew bound the action can no longer commit; +2 s of slack. */
const reconcileDeadline = (expiresAfter: number): number => expiresAfter + MAX_SKEW_MS + 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Order statuses the docs list as `*Rejected` — mapped to reasons by name. */
const statusReason = (status: string): HyperliquidRejectReason => {
  if (status.includes("OpenInterest")) {
    return "open-interest-cap";
  }
  switch (status) {
    case "tickRejected":
      return "tick";
    case "minTradeNtlRejected":
      return "min-notional";
    case "perpMarginRejected":
      return "margin";
    case "reduceOnlyRejected":
      return "reduce-only";
    case "badAloPxRejected":
      return "post-only-would-match";
    case "iocCancelRejected":
      return "ioc-no-match";
    case "badTriggerPxRejected":
      return "bad-trigger";
    case "marketOrderNoLiquidityRejected":
      return "no-liquidity";
    case "insufficientSpotBalanceRejected":
      return "insufficient-spot-balance";
    case "oracleRejected":
      return "oracle";
    case "perpMaxPositionRejected":
      return "max-position";
    default:
      return "other";
  }
};

/** The same classes for the `error` strings in order-statuses (docs error-responses table). */
const messageReason = (message: string): HyperliquidRejectReason => {
  if (message.includes("divisible by tick size")) {
    return "tick";
  }
  if (message.includes("minimum value")) {
    return "min-notional";
  }
  if (message.includes("Insufficient margin")) {
    return "margin";
  }
  if (message.includes("Reduce only order")) {
    return "reduce-only";
  }
  if (message.includes("Post only order")) {
    return "post-only-would-match";
  }
  if (message.includes("could not immediately match")) {
    return "ioc-no-match";
  }
  if (message.includes("Invalid TP/SL price")) {
    return "bad-trigger";
  }
  if (message.includes("No liquidity available for market order")) {
    return "no-liquidity";
  }
  if (message.includes("open interest")) {
    return "open-interest-cap";
  }
  if (message.includes("insufficient spot balance")) {
    return "insufficient-spot-balance";
  }
  if (message.includes("too far from oracle")) {
    return "oracle";
  }
  if (message.includes("margin tier limit")) {
    return "max-position";
  }
  return "other";
};

/** `status: "err"` strings that mean the agent is unusable — never retried with another key. */
const AGENT_REJECTION =
  /User or API Wallet 0x[0-9a-fA-F]+ does not exist|Must deposit before performing actions/;

const cloidOf = (entry: Record<string, unknown>): string | undefined => stringOf(entry["cloid"]);

const orderStatusOutcome = (entry: unknown, cloid?: string): HyperliquidOrderOutcome => {
  if (entry === "waitingForFill" || entry === "waitingForTrigger") {
    // Accepted without an oid yet — resting without one.
    return { kind: "resting", cloid };
  }
  if (isRecord(entry) && isRecord(entry["resting"])) {
    return {
      kind: "resting",
      oid: numberOf(entry["resting"]["oid"]),
      cloid: cloidOf(entry["resting"]) ?? cloid,
    };
  }
  if (isRecord(entry) && isRecord(entry["filled"])) {
    return {
      kind: "filled",
      oid: numberOf(entry["filled"]["oid"]),
      cloid: cloidOf(entry["filled"]) ?? cloid,
      totalSz: stringOf(entry["filled"]["totalSz"]) ?? "0",
      avgPx: stringOf(entry["filled"]["avgPx"]) ?? "0",
    };
  }
  const message = isRecord(entry) ? stringOf(entry["error"]) : undefined;
  return {
    kind: "rejected",
    cloid,
    reason: message === undefined ? "other" : messageReason(message),
    message: message ?? "unrecognized order status",
  };
};

const cancelStatusOutcome = (entry: unknown): HyperliquidCancelOutcome => {
  if (entry === "success") {
    return { kind: "cancelled" };
  }
  const message = isRecord(entry) ? stringOf(entry["error"]) : undefined;
  return { kind: "rejected", message: message ?? "unrecognized cancel status" };
};

/**
 * The docs warn that a pre-validation failure returns ONE error for the whole batch; a single
 * `{error}` status among n orders applies to every entry (error-responses doc).
 */
const broadcast = (statuses: ReadonlyArray<unknown>, count: number): ReadonlyArray<unknown> => {
  const [only] = statuses;
  if (statuses.length === 1 && count > 1 && isRecord(only) && typeof only["error"] === "string") {
    return Array.from({ length: count }, () => only);
  }
  return statuses;
};

const statusesOf = (body: unknown): ReadonlyArray<unknown> | undefined => {
  if (!isRecord(body) || body["status"] !== "ok" || !isRecord(body["response"])) {
    return undefined;
  }
  const { data } = body["response"];
  if (!isRecord(data) || !Array.isArray(data["statuses"])) {
    return undefined;
  }
  return data["statuses"] as ReadonlyArray<unknown>;
};

/** `orderStatus` → the outcome for one cloid, or `undefined` to keep polling. */
const statusOutcome = (result: unknown, cloid?: string): HyperliquidOrderOutcome | undefined => {
  if (!isRecord(result) || result["status"] !== "order" || !isRecord(result["order"])) {
    return undefined; // unknownOid or malformed — keep polling
  }
  const detail = result["order"];
  const order = isRecord(detail["order"]) ? detail["order"] : {};
  const status = stringOf(detail["status"]) ?? "";
  const oid = numberOf(order["oid"]);
  if (status === "open" || status === "triggered") {
    return { kind: "resting", oid, cloid };
  }
  if (status === "filled") {
    return {
      kind: "filled",
      oid,
      cloid,
      // orderStatus carries no fill price — origSz is the total, limitPx the worst bound.
      totalSz: stringOf(order["origSz"]) ?? "0",
      avgPx: stringOf(order["limitPx"]) ?? "0",
    };
  }
  // Every *Rejected/*Canceled terminal status — reasoned where the table names it.
  return { kind: "rejected", cloid, reason: statusReason(status), message: status };
};

const cloids = (action: HyperliquidL1Action): ReadonlyArray<string | undefined> =>
  action.type === "order" || action.type === "batchModify"
    ? action.type === "order"
      ? action.orders.map((order) => order.c)
      : action.modifies.map((item) => item.order.c)
    : [];

/** `data.status` of single-status responses like twapOrder: `{running:{twapId}} | {error}`. */
const singleStatus = (body: unknown): HyperliquidActionOutcome | undefined => {
  const data =
    isRecord(body) && isRecord(body["response"]) && isRecord(body["response"]["data"])
      ? body["response"]["data"]
      : undefined;
  const status = isRecord(data?.["status"]) ? data?.["status"] : undefined;
  if (status === undefined) {
    return undefined;
  }
  const message = stringOf(status["error"]);
  if (message !== undefined) {
    throw new HyperliquidError("rejected", message);
  }
  if (isRecord(status["running"])) {
    const twapId = numberOf(status["running"]["twapId"]);
    return twapId === undefined ? { kind: "ok" } : { kind: "ok", twapId };
  }
  return undefined;
};

export type HyperliquidExchange = {
  /** Sign and post an order action; reconcile each cloid if the POST's outcome is unknown. */
  readonly order: (
    group: HyperliquidGroup,
    action: HyperliquidL1Action,
  ) => Promise<ReadonlyArray<HyperliquidOrderOutcome>>;
  /** Sign and post a cancel/cancelByCloid action. */
  readonly cancel: (
    group: HyperliquidGroup,
    action: HyperliquidL1Action,
  ) => Promise<ReadonlyArray<HyperliquidCancelOutcome>>;
  /** Sign and post any other action — `{kind:"ok"}` or `{kind:"unknown"}` on a lost POST. */
  readonly action: (
    group: HyperliquidGroup,
    action: HyperliquidL1Action,
  ) => Promise<HyperliquidActionOutcome>;
};

export function createHyperliquidExchange(options: {
  readonly wallet: Wallet;
  readonly transport: IRequestTransport;
  readonly clock: HyperliquidClock;
  readonly markets: HyperliquidMarkets;
  readonly account: HyperliquidAccount;
  readonly registry: HyperliquidAgentRegistry;
  readonly now: () => number;
  readonly setTimer: SetTimer;
}): HyperliquidExchange {
  const sleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
      options.setTimer(ms, resolve);
    });

  /** One cheap info call when no skew estimate exists yet — any Date-bearing response works. */
  const assertClock = async (): Promise<void> => {
    if (options.clock.skew() === undefined) {
      await options.markets.mids();
    }
    options.clock.assertSkew();
  };

  /**
   * The POST's outcome is unknown — the action may have committed. Poll orderStatus by cloid every
   * second; never re-POST. Deadline: `expiresAfter + MAX_SKEW + 2 s` — past it the action cannot be
   * accepted anymore.
   */
  const reconcile = async (
    master: string,
    cloid: string | undefined,
    expiresAfter: number,
  ): Promise<HyperliquidOrderOutcome> => {
    if (cloid === undefined) {
      return { kind: "unknown" };
    }
    const deadline = reconcileDeadline(expiresAfter);
    let lastPollFailed = false;
    while (options.now() <= deadline) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls are the protocol.
        const result = await options.account.orderStatus({ user: master, oid: cloid });
        const outcome = statusOutcome(result, cloid);
        if (outcome !== undefined) {
          return outcome;
        }
        lastPollFailed = false;
      } catch {
        lastPollFailed = true;
      }
      if (options.now() <= deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls are the protocol.
        await sleep(RECONCILE_POLL_MS);
      }
    }
    // Every answer was unknownOid → never placed; an unanswered last poll → unknown.
    return lastPollFailed ? { kind: "unknown", cloid } : { kind: "not-placed", cloid };
  };

  const sign = async (
    agent: HyperliquidAgent,
    action: HyperliquidL1Action,
    nonce: number,
    expiresAfter: number,
  ): Promise<{ readonly r: string; readonly s: string; readonly v: number }> => {
    let signature: Uint8Array;
    try {
      signature = await hyperliquid(options.wallet).signL1({
        agent: agent.address,
        action,
        nonce,
        expiresAfter,
      });
    } catch (error) {
      if (error instanceof WalletError) {
        if (error.code === "locked") {
          throw new HyperliquidError("unlock-required", "the vault is locked", error);
        }
        if (
          error.code === "not-found" ||
          (error.code === "invalid-input" && options.now() >= agent.validUntil)
        ) {
          options.registry.markRejected(agent.address);
          throw new HyperliquidError(
            "reauthorization-required",
            "the agent is gone or expired",
            error,
          );
        }
        /* `invalid-input` while the agent still looks valid is a nonce-window or malformed-action
           rejection — a clock fault or a builder bug, never an agent fault worth latching. */
        if (error.code === "invalid-input") {
          throw new HyperliquidError("invalid-input", "the kernel rejected the request", error);
        }
      }
      throw new HyperliquidError("unavailable", "the wallet failed to sign", error);
    }
    if (signature.length !== 65) {
      throw new HyperliquidError("unavailable", "the kernel returned a malformed signature");
    }
    const hex = Array.from(signature, (b) => b.toString(16).padStart(2, "0")).join("");
    // r‖s‖v with v already 27/28 — Signature.toBytes emits 27 + yParity (evm/sign.ts:40).
    return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v: signature[64] ?? 27 };
  };

  /**
   * Gate → require → nonce → sign → POST the exact frozen action. A transport failure after signing
   * means the action may have committed: the caller maps that to a reconciliation, never a retry.
   */
  const execute = async <T>(
    group: HyperliquidGroup,
    action: HyperliquidL1Action,
    onOk: (body: unknown) => T,
    onLost: (master: string, expiresAfter: number) => T | Promise<T>,
  ): Promise<T> => {
    const agent = options.registry.require(group);
    await assertClock();
    const nonce = options.clock.nextNonce(agent.address);
    const expiresAfter = options.now() + EXPIRES_AFTER_MS;
    const signature = await sign(agent, action, nonce, expiresAfter);
    const body = { action, nonce, signature, expiresAfter };
    let response: unknown;
    try {
      response = await options.transport.request("exchange", body);
    } catch (error) {
      // The transport throws only network/timeout/unavailable HyperliquidErrors — each means
      // the POST may have landed.
      if (error instanceof HyperliquidError) {
        return onLost(agent.owner, expiresAfter);
      }
      throw error;
    }
    if (isRecord(response) && response["status"] === "err") {
      const message = stringOf(response["response"]) ?? "rejected";
      if (AGENT_REJECTION.test(message)) {
        options.registry.markRejected(agent.address);
        throw new HyperliquidError("reauthorization-required", message);
      }
      throw new HyperliquidError("rejected", message);
    }
    return onOk(response);
  };

  return {
    order: async (group, action) =>
      execute(
        group,
        action,
        (body) => {
          const count =
            action.type === "order"
              ? action.orders.length
              : action.type === "batchModify"
                ? action.modifies.length
                : 1;
          const known = cloids(action);
          return broadcast(statusesOf(body) ?? [], count).map((entry, index) =>
            orderStatusOutcome(entry, known[index]),
          );
        },
        async (master, expiresAfter) => {
          const known = cloids(action);
          if (known.length === 0) {
            return [{ kind: "unknown" }];
          }
          return Promise.all(known.map(async (cloid) => reconcile(master, cloid, expiresAfter)));
        },
      ),
    cancel: async (group, action) => {
      const count =
        action.type === "cancel" || action.type === "cancelByCloid" ? action.cancels.length : 1;
      return execute(
        group,
        action,
        (body) => broadcast(statusesOf(body) ?? [], count).map(cancelStatusOutcome),
        () => Array.from({ length: count }, () => ({ kind: "unknown" as const })),
      );
    },
    action: async (group, action) =>
      execute(
        group,
        action,
        (body) => singleStatus(body) ?? { kind: "ok" },
        () => ({ kind: "unknown" }),
      ),
  };
}
