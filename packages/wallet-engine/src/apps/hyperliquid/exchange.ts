import type { IRequestTransport } from "@nktkas/hyperliquid";

import { WalletError } from "@qntx/wallet";
import type { Wallet } from "@qntx/wallet";
import type { HyperliquidL1Action } from "@qntx/wallet/protocol";
import { sessions } from "@qntx/wallet/sessions";

import { formatDecimal, parseDecimal } from "../../decimal.ts";
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
      /** Size already filled while still resting — only from `orderStatus` reconciliation. */
      readonly filledSz?: string | undefined;
    }
  | {
      readonly kind: "filled";
      readonly oid?: number | undefined;
      readonly cloid?: string | undefined;
      readonly totalSz: string;
      /** `orderStatus` carries no fill price — absent on reconciled fills, never fabricated. */
      readonly avgPx?: string | undefined;
    }
  | {
      readonly kind: "rejected";
      readonly cloid?: string | undefined;
      readonly reason: HyperliquidRejectReason;
      readonly message: string;
    }
  | { readonly kind: "unknown"; readonly cloid?: string | undefined };

/**
 * An `unknown` order outcome proven later — by the late reconciler or by a live user-view frame
 * that saw the cloid. `unknown` can never be proven "not placed": Hyperliquid documents no
 * consistency between an info read and L1 state, so only a definite later answer counts.
 */
export type HyperliquidOutcomeCorrection = {
  readonly group: HyperliquidGroup;
  readonly cloid: string;
  readonly outcome: HyperliquidOrderOutcome;
};

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

/**
 * Late reconciliation cadence for `unknown` cloids — orderStatus is weight 2, so a 10 s cadence
 * over {@link MAX_UNRESOLVED} entries stays far under the 1200 weight/min limit.
 */
const RECONCILE_LATE_POLL_MS = 10_000;

/**
 * Endpoint catch-up budget: past ten minutes a pending cloid is dropped from the set silently — its
 * outcome stays `unknown`, it is simply no longer re-asked.
 */
const RECONCILE_LATE_WINDOW_MS = 600_000;

/** Outstanding cloids cannot grow without bound — past the cap the oldest entry is evicted. */
const MAX_UNRESOLVED = 64;

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

/* Pending keys normalize case: a checksummed owner or an upper-case cloid in a WebSocket frame
   is the same pending order — the map must still match it. */
const pendingKey = (master: string, cloid: string): string => `${master}|${cloid}`.toLowerCase();

/**
 * An answered order status — strict on the documented shapes: anything else means the response was
 * misread, and a misread "rejected" is how duplicate orders happen. `undefined` → reconcile.
 */
const orderStatusOutcome = (
  entry: unknown,
  cloid?: string,
): HyperliquidOrderOutcome | undefined => {
  if (entry === "waitingForFill" || entry === "waitingForTrigger") {
    // Accepted without an oid yet — resting without one.
    return { kind: "resting", cloid };
  }
  if (isRecord(entry) && isRecord(entry["resting"])) {
    const oid = numberOf(entry["resting"]["oid"]);
    return oid === undefined
      ? undefined
      : { kind: "resting", oid, cloid: cloidOf(entry["resting"]) ?? cloid };
  }
  if (isRecord(entry) && isRecord(entry["filled"])) {
    const totalSz = stringOf(entry["filled"]["totalSz"]);
    const avgPx = stringOf(entry["filled"]["avgPx"]);
    return totalSz === undefined || avgPx === undefined
      ? undefined
      : {
          kind: "filled",
          oid: numberOf(entry["filled"]["oid"]),
          cloid: cloidOf(entry["filled"]) ?? cloid,
          totalSz,
          avgPx,
        };
  }
  const message = isRecord(entry) ? stringOf(entry["error"]) : undefined;
  return message === undefined
    ? undefined
    : { kind: "rejected", cloid, reason: messageReason(message), message };
};

const cancelStatusOutcome = (entry: unknown): HyperliquidCancelOutcome => {
  if (entry === "success") {
    return { kind: "cancelled" };
  }
  const message = isRecord(entry) ? stringOf(entry["error"]) : undefined;
  return message === undefined ? { kind: "unknown" } : { kind: "rejected", message };
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

/** `origSz − sz` exactly — the filled part of an order, canonical, or undefined when unreadable. */
const filledSize = (order: Record<string, unknown>): string | undefined => {
  const orig = stringOf(order["origSz"]);
  const open = stringOf(order["sz"]);
  if (orig === undefined || open === undefined) {
    return undefined;
  }
  const a = parseDecimal(orig);
  const b = parseDecimal(open);
  const scale = Math.max(a.scale, b.scale);
  const diff = a.units * 10n ** BigInt(scale - a.scale) - b.units * 10n ** BigInt(scale - b.scale);
  return formatDecimal({ units: diff < 0n ? 0n : diff, scale });
};

const positive = (size: string | undefined): size is string =>
  size !== undefined && parseDecimal(size).units > 0n;

/**
 * `orderStatus` → the outcome for one cloid, or `undefined` to keep polling (unknownOid and
 * malformed answers both keep polling — a misread is never a verdict).
 */
const statusOutcome = (result: unknown, cloid?: string): HyperliquidOrderOutcome | undefined => {
  if (!isRecord(result) || result["status"] !== "order" || !isRecord(result["order"])) {
    return undefined;
  }
  const detail = result["order"];
  const order = isRecord(detail["order"]) ? detail["order"] : {};
  const status = stringOf(detail["status"]) ?? "";
  const oid = numberOf(order["oid"]);
  const filled = filledSize(order);
  if (status === "open" || status === "triggered") {
    return positive(filled)
      ? { kind: "resting", oid, cloid, filledSz: filled }
      : { kind: "resting", oid, cloid };
  }
  if (status === "filled") {
    return {
      kind: "filled",
      oid,
      cloid,
      // orderStatus carries no fill price — avgPx stays absent, never fabricated.
      totalSz: filled ?? stringOf(order["origSz"]) ?? "0",
    };
  }
  if (status === "") {
    return undefined;
  }
  // Every *Rejected/*Canceled terminal status — a partial IOC fill still committed its filled part.
  return positive(filled)
    ? { kind: "filled", oid, cloid, totalSz: filled }
    : { kind: "rejected", cloid, reason: statusReason(status), message: status };
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
  /**
   * Corrections for outcomes returned `unknown`: the late reconciler re-asks pending cloids for
   * {@link RECONCILE_LATE_WINDOW_MS} and live user-view frames prove or re-ask them too. Nothing is
   * ever re-sent.
   */
  readonly corrections: {
    readonly subscribe: (
      listener: (correction: HyperliquidOutcomeCorrection) => void,
    ) => () => void;
  };
  /** A live user-view frame for `user` — proves or re-asks pending cloids it carries. */
  readonly sighted: (user: string, entry: unknown) => void;
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

  const listeners = new Set<(correction: HyperliquidOutcomeCorrection) => void>();
  const emit = (correction: HyperliquidOutcomeCorrection): void => {
    for (const listener of listeners) {
      listener(correction);
    }
  };

  type Pending = {
    readonly group: HyperliquidGroup;
    readonly master: string;
    readonly cloid: string;
    readonly since: number;
  };
  /* C-loids returned `unknown`, awaiting a provable outcome — keyed `master|cloid`, insertion
     order is eviction order. */
  const pending = new Map<string, Pending>();
  let pollCancel: (() => void) | undefined;
  let lockWatch: (() => void) | undefined;

  /** One orderStatus read for a pending cloid — a definite answer corrects and drops it. */
  const probe = async (entry: Pending): Promise<void> => {
    let outcome: HyperliquidOrderOutcome | undefined;
    try {
      outcome = statusOutcome(
        await options.account.orderStatus({ user: entry.master, oid: entry.cloid }),
        entry.cloid,
      );
    } catch {
      return; // a failed late read stays pending — the timer re-asks
    }
    if (outcome !== undefined && pending.get(pendingKey(entry.master, entry.cloid)) === entry) {
      pending.delete(pendingKey(entry.master, entry.cloid));
      emit({ group: entry.group, cloid: entry.cloid, outcome });
    }
  };

  const schedulePoll = (): void => {
    if (pollCancel === undefined && pending.size > 0) {
      pollCancel = options.setTimer(RECONCILE_LATE_POLL_MS, () => {
        pollCancel = undefined;
        void (async (): Promise<void> => {
          for (const entry of pending.values()) {
            if (options.now() - entry.since >= RECONCILE_LATE_WINDOW_MS) {
              pending.delete(pendingKey(entry.master, entry.cloid)); // expired: stays unknown
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

  const registerPending = (group: HyperliquidGroup, master: string, cloid: string): void => {
    if (options.wallet.getSnapshot().vault !== "unlocked") {
      return; // a locked session drops its pending cloids — nothing account-bound survives it
    }
    /* The vault is the boundary: a lock drops every pending cloid and stops the poll — the
       corrections a new session earns are its own. Subscribed lazily so a reads-only provider
       never needs the wallet's subscription channel. */
    lockWatch ??= options.wallet.subscribe(() => {
      if (options.wallet.getSnapshot().vault !== "unlocked") {
        pending.clear();
        pollCancel?.();
        pollCancel = undefined;
      }
    });
    const key = pendingKey(master, cloid);
    if (!pending.has(key) && pending.size >= MAX_UNRESOLVED) {
      const [oldest] = pending.keys();
      if (oldest !== undefined) {
        pending.delete(oldest);
      }
    }
    pending.set(key, { group, master, cloid, since: options.now() });
    schedulePoll();
  };

  /* A live user-view frame is a second proof channel: `openOrders` carrying a pending cloid is
     the order resting; `userFills` carrying it only means a fill exists — re-ask orderStatus. */
  const sighted = (user: string, entry: unknown): void => {
    if (!isRecord(entry) || pending.size === 0) {
      return;
    }
    const { orders } = entry;
    if (Array.isArray(orders)) {
      for (const order of orders) {
        const cloid = isRecord(order) ? stringOf(order["cloid"]) : undefined;
        const oid = isRecord(order) ? numberOf(order["oid"]) : undefined;
        if (cloid === undefined || oid === undefined) {
          continue;
        }
        const hit = pending.get(pendingKey(user, cloid));
        if (hit !== undefined) {
          pending.delete(pendingKey(user, cloid));
          emit({ group: hit.group, cloid, outcome: { kind: "resting", oid, cloid } });
        }
      }
    }
    const { fills } = entry;
    if (Array.isArray(fills)) {
      for (const fill of fills) {
        const cloid = isRecord(fill) ? stringOf(fill["cloid"]) : undefined;
        const hit = cloid === undefined ? undefined : pending.get(pendingKey(user, cloid));
        if (hit !== undefined) {
          void probe(hit);
        }
      }
    }
  };

  /**
   * The POST's outcome is unknown — the action may have committed. Poll orderStatus by cloid every
   * second; never re-POST. Deadline: `expiresAfter + MAX_SKEW + 2 s` — past it the action cannot be
   * accepted anymore.
   */
  const reconcile = async (
    group: HyperliquidGroup,
    master: string,
    cloid: string | undefined,
    expiresAfter: number,
  ): Promise<HyperliquidOrderOutcome> => {
    if (cloid === undefined) {
      return { kind: "unknown" };
    }
    const deadline = reconcileDeadline(expiresAfter);
    while (options.now() <= deadline) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls are the protocol.
        const result = await options.account.orderStatus({ user: master, oid: cloid });
        const outcome = statusOutcome(result, cloid);
        if (outcome !== undefined) {
          return outcome;
        }
      } catch {
        // A failed read is not an answer — keep polling until the deadline.
      }
      if (options.now() <= deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls are the protocol.
        await sleep(RECONCILE_POLL_MS);
      }
    }
    /* Every answer was unknownOid or a failed read — "not placed" cannot be proven: no
       documented consistency between an info read and L1 state, nor which server answered the
       polls. The cloid stays pending for late reconciliation instead. */
    registerPending(group, master, cloid);
    return { kind: "unknown", cloid };
  };

  const sign = async (
    agent: HyperliquidAgent,
    action: HyperliquidL1Action,
    nonce: number,
    expiresAfter: number,
  ): Promise<{ readonly r: string; readonly s: string; readonly v: number }> => {
    let signature: Uint8Array;
    try {
      signature = await sessions(options.wallet).sign({
        scheme: "hyperliquid-l1-agent",
        address: agent.address,
        params: { action, nonce, expiresAfter },
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
    onOk: (body: unknown, master: string, expiresAfter: number) => T | Promise<T>,
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
    return onOk(response, agent.owner, expiresAfter);
  };

  return {
    order: async (group, action) =>
      execute(
        group,
        action,
        async (body, master, expiresAfter) => {
          const count =
            action.type === "order"
              ? action.orders.length
              : action.type === "batchModify"
                ? action.modifies.length
                : 1;
          const known = cloids(action);
          const raw = statusesOf(body);
          const entries = raw === undefined ? undefined : broadcast(raw, count);
          /* A malformed/short answered response is as unknown as a lost POST — reconcile the
             cloids it could not account for instead of fabricating rejections. */
          if (entries === undefined || entries.length !== count) {
            return Promise.all(
              known.map(async (cloid) => reconcile(group, master, cloid, expiresAfter)),
            );
          }
          return Promise.all(
            entries.map(async (entry, index) => {
              const outcome = orderStatusOutcome(entry, known[index]);
              return outcome ?? reconcile(group, master, known[index], expiresAfter);
            }),
          );
        },
        async (master, expiresAfter) => {
          const known = cloids(action);
          if (known.length === 0) {
            return [{ kind: "unknown" }];
          }
          return Promise.all(
            known.map(async (cloid) => reconcile(group, master, cloid, expiresAfter)),
          );
        },
      ),
    cancel: async (group, action) => {
      const count =
        action.type === "cancel" || action.type === "cancelByCloid" ? action.cancels.length : 1;
      return execute(
        group,
        action,
        (body) => {
          const raw = statusesOf(body);
          const entries = raw === undefined ? undefined : broadcast(raw, count);
          return entries === undefined || entries.length !== count
            ? Array.from({ length: count }, () => ({ kind: "unknown" as const }))
            : entries.map(cancelStatusOutcome);
        },
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
    corrections: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    sighted,
  };
}
