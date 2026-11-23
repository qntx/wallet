/**
 * The Fiat24 resumable flows over the app's SPI: state starts through the SDK, persists as
 * `flow/<id>` (`encodeFlowState` text — untrusted on the way back in, re-decoded per advance), and
 * advances one-at-a-time per group through the layer-1 client and the request-pipeline signer.
 * Payout drafts hold payee PII so they stay in a memory-only map until the first `advancePayout`
 * verifies them into a persisted `verified` state. Sessions and the public api are optional
 * `FlowDeps` — the SDK refuses with its own codes when a flow needs one the host never wired.
 * Reconcile never sends: it enqueues advances only for records whose last phase is
 * `sending`/`submitted`/`unknown`, the three phases where the SDK's `advanceTx` polls and never
 * reaches `readyPhase` (flows/tx.ts gates the signer behind `phase === "ready"` or no record).
 */
import { bytesToHex } from "viem";
import type { Client } from "viem";

import type { Fiat24Api } from "@qntx/fiat24/api";
import type { PayoutSettlement } from "@qntx/fiat24/chain";
import type { Currency, PayoutCurrency, Recipient } from "@qntx/fiat24/core";
import { isFiat24Error } from "@qntx/fiat24/core";
import {
  advanceCard,
  advanceExchange,
  advanceOnboarding,
  advancePayout,
  advanceTopUp,
  advanceTransfer,
  decodeFlowState,
  encodeFlowState,
  loadPayoutSettlement,
  startCardOperation,
  startCardSetup,
  startExchange,
  startOnboarding,
  startPayout,
  startTopUp,
  startTransfer,
} from "@qntx/fiat24/flows";
import type {
  CardOperation,
  FlowDeps,
  FlowState,
  PayoutDraft,
  PayoutTarget,
  TxPhase,
} from "@qntx/fiat24/flows";
import type { Wallet } from "@qntx/wallet";

import type {
  AppAvailability,
  AppGroup,
  AppGroupState,
  AppRequests,
  AppStorage,
  EngineLogger,
  SetTimer,
} from "../spi.ts";
import type { Fiat24AccountRead } from "./account.ts";
import { Fiat24AppError, fromSdk } from "./errors.ts";
import type { Fiat24Owner } from "./owner.ts";
import type { createFiat24Sessions } from "./sessions.ts";
import type { Fiat24Refusal } from "./signer.ts";

/**
 * The record name the enable provider writes — a flow reads it to gate reconcile before
 * `groupState` is derived (the unlock hook runs before `init`).
 */
const ENABLED = "enabled";
const FLOW_PREFIX = "flow/";
/** The reconcile cadence — the same 15 s the account live view polls at. */
const FIAT24_RECONCILE_MS = 15_000;
/** Reconcile-only phases — `advanceTx` in these polls receipts/nonces and can never sign. */
const UNRESOLVED: ReadonlySet<TxPhase> = new Set(["sending", "submitted", "unknown"]);

/**
 * Whether the state's next move must reach api.fiat24.com — read off the SDK's own dispatch: a
 * payout `draft` with a `bank`/`swiss-qr` target (`verifyTarget` → `checkedSession`,
 * flows/payout.ts:313 — contact targets skip the session); a card `ready` with no chain leg
 * (`advanceApiWrite` → `checkedSession`, flows/card.ts:438,256) or a `tx`/`confirmed` whose last
 * record is a `main` write; onboarding `tourist`/`kyc` (`api.kycStatus`, flows/onboarding.ts:313).
 * The one reach it cannot see statically — a card `ready` with a chain leg (cap or set-cap), where
 * the write follows only when the allowance already matches — throws `session-required` in the SDK
 * and the advance catch maps it to the same `api-unavailable`.
 */
const needsApi = (state: FlowState | PayoutDraft): boolean => {
  switch (state.flow) {
    case "payout":
      return state.step === "draft" && state.target.kind !== "contact";
    case "card":
      if (state.step === "tx" || state.step === "confirmed") {
        return state.txs.at(-1)?.purpose === "main";
      }
      return (
        state.step === "ready" && state.cap === undefined && state.operation.kind !== "set-cap"
      );
    case "onboarding":
      return state.step === "tourist" || state.step === "kyc";
    default:
      return false;
  }
};

export type Fiat24FlowEntry = {
  readonly id: string;
  readonly state: FlowState | PayoutDraft;
  /** What the signer reported during this `advance` — memory only, never persisted. */
  readonly refusal?: Fiat24Refusal;
};

/**
 * A `list` entry: a decodable flow state, or `{ invalid: true }` for a persisted record that no
 * longer decodes — it can never be reconciled, `start` stays `flow-unresolved` while one exists (it
 * cannot be proven not to be `sending`), `discard` removes it, and `advance`/`reconcile` on it is a
 * `protocol` `invalid-state`.
 */
export type Fiat24Flow = Fiat24FlowEntry | { readonly id: string; readonly invalid: true };

export type Fiat24FlowInput =
  | {
      readonly flow: "transfer";
      readonly currency: Currency;
      readonly amount: bigint;
      readonly to: Recipient;
    }
  | {
      readonly flow: "exchange";
      readonly side: "exact-in" | "exact-out";
      readonly from: Currency;
      readonly to: Currency;
      readonly amount: bigint;
    }
  | {
      readonly flow: "payout";
      readonly currency: PayoutCurrency;
      readonly amount: bigint;
      readonly target: PayoutTarget;
    }
  | { readonly flow: "top-up"; readonly output: Currency; readonly usdcAmount: bigint }
  | { readonly flow: "onboarding"; readonly tokenId: bigint; readonly payment: "f24" | "eth" }
  | {
      readonly flow: "card-setup";
      readonly cap: { readonly currency: Currency; readonly amount: bigint };
    }
  | { readonly flow: "card"; readonly operation: CardOperation };

export type Fiat24Flows = {
  /** The group's persisted flows plus its in-memory payout drafts. */
  readonly list: (group: AppGroup) => Promise<ReadonlyArray<Fiat24Flow>>;
  readonly start: (group: AppGroup, input: Fiat24FlowInput) => Promise<Fiat24FlowEntry>;
  /** One advance at a time per group — concurrent calls queue behind the running one. */
  readonly advance: (group: AppGroup, id: string) => Promise<Fiat24FlowEntry>;
  readonly discard: (group: AppGroup, id: string) => Promise<void>;
  readonly payoutSettlement: (
    group: AppGroup,
    id: string,
  ) => Promise<PayoutSettlement & { readonly txid: string }>;
};

type Sessions = ReturnType<typeof createFiat24Sessions>;

const groupKey = (group: AppGroup): string => `${group.walletId}/${group.groupIndex}`;

const text = new TextEncoder();
const read = new TextDecoder();

const lastPhase = (state: FlowState): TxPhase | undefined => state.txs.at(-1)?.phase;

export function createFiat24Flows(options: {
  readonly wallet: Wallet;
  readonly requests: AppRequests;
  readonly storage: AppStorage;
  readonly random: (bytes: number) => Uint8Array;
  readonly setTimer: SetTimer;
  readonly logger: EngineLogger;
  readonly availability: () => AppAvailability | undefined;
  readonly groupState: (group: AppGroup) => AppGroupState | undefined;
  readonly client: Client;
  readonly owner: Fiat24Owner;
  readonly account: Fiat24AccountRead;
  readonly api: Fiat24Api | undefined;
  readonly sessions: Sessions;
}): {
  readonly flows: Fiat24Flows;
  /** Re-arms the 15 s poll when the host's visibility flag is set — the flag survives a lock. */
  readonly unlock: () => void;
  /** Starts/stops the 15 s reconcile poll; `setVisible(false)` stops it. */
  readonly setVisible: (visible: boolean) => void;
  /** The provider-reconcile hook: one reconcile pass for this group, never sends. */
  readonly reconcileGroup: (group: AppGroup) => Promise<void>;
  /** Vault lock — drafts are PII and sessions are bearer grants; both die here. */
  readonly lock: () => void;
  /** Ends the group's session, drops its drafts and rejects its still-open requests. */
  readonly dropGroup: (group: AppGroup) => void;
  /** `dropGroup` for every tracked group whose walletId is no longer in the snapshot. */
  readonly dropMissing: (wallets: ReadonlySet<string>) => void;
  readonly close: () => void;
} {
  const { storage, requests } = options;
  /** Per-group serial advance queue — the SDK forbids concurrent advances of one group. */
  const queue = new Map<string, Promise<unknown>>();
  /** Payout drafts by group — payee PII never touches storage. */
  const drafts = new Map<string, Map<string, PayoutDraft>>();
  /** Every group the flows module has touched — the wallet-removal sweep's candidates. */
  const known = new Map<string, AppGroup>();
  let visible = false;
  let timer: (() => void) | undefined;
  let polling = false;

  const unlocked = (): boolean => options.wallet.getSnapshot().vault === "unlocked";

  const requireUnlocked = (): void => {
    if (!unlocked()) {
      throw new Fiat24AppError("unlock-required", "unlock the vault to use the Fiat24 app");
    }
  };

  const requireEnabled = (group: AppGroup): void => {
    requireUnlocked();
    if (options.groupState(group)?.status !== "enabled") {
      throw new Fiat24AppError("not-enabled", "enable the Fiat24 app for this group first");
    }
  };

  const enabledRecord = async (group: AppGroup): Promise<boolean> => {
    try {
      return (await storage.get(group, ENABLED)) !== undefined;
    } catch {
      return false;
    }
  };

  const draftsOf = (group: AppGroup): Map<string, PayoutDraft> => {
    const key = groupKey(group);
    known.set(key, group);
    let groupDrafts = drafts.get(key);
    if (groupDrafts === undefined) {
      groupDrafts = new Map();
      drafts.set(key, groupDrafts);
    }
    return groupDrafts;
  };

  const persisted = async (
    group: AppGroup,
  ): Promise<ReadonlyArray<{ id: string; state: FlowState } | { id: string; invalid: true }>> => {
    known.set(groupKey(group), group);
    const listed = await storage.list(group);
    const names = listed.filter((name) => name.startsWith(FLOW_PREFIX));
    const records = await Promise.all(names.map(async (name) => storage.get(group, name)));
    const out: Array<{ id: string; state: FlowState } | { id: string; invalid: true }> = [];
    for (const [index, bytes] of records.entries()) {
      const id = (names[index] ?? "").slice(FLOW_PREFIX.length);
      if (bytes === undefined) {
        continue;
      }
      try {
        out.push({ id, state: decodeFlowState(read.decode(bytes)) });
      } catch {
        /* Persisted bytes are untrusted — an undecodable record is reported, not fatal. */
        out.push({ id, invalid: true });
      }
    }
    return out;
  };

  /**
   * A sending/unknown last record blocks a replacement start — the SDK never resends it. An
   * undecodable record blocks too: it cannot be proven not to be sending, so it fails closed.
   */
  const requireResolved = async (group: AppGroup): Promise<void> => {
    for (const record of await persisted(group)) {
      if (
        "invalid" in record ||
        lastPhase(record.state) === "sending" ||
        lastPhase(record.state) === "unknown"
      ) {
        throw new Fiat24AppError(
          "flow-unresolved",
          "a Fiat24 transaction is still sending — reconcile it before starting another",
        );
      }
    }
  };

  /** The group's owned live tokenId — payout and card flows cannot run without it. */
  const tokenIdOf = async (group: AppGroup): Promise<bigint> => {
    const account = await options.account(group);
    if (account.status !== "live" || !account.view.account.ownsToken) {
      throw new Fiat24AppError("no-account", "the group owns no live Fiat24 account");
    }
    return account.view.account.tokenId;
  };

  const requireAvailable = (): void => {
    const availability = options.availability();
    if (availability === "close-only") {
      throw new Fiat24AppError("close-only", "Fiat24 is close-only in this jurisdiction");
    }
    if (availability !== "available") {
      throw new Fiat24AppError("unavailable", "Fiat24 availability is unknown");
    }
  };

  const persist = async (group: AppGroup, id: string, state: FlowState): Promise<void> => {
    await storage.put(group, `${FLOW_PREFIX}${id}`, text.encode(encodeFlowState(state)));
  };

  const persistFromSdk = async (group: AppGroup, id: string, state: FlowState): Promise<void> => {
    try {
      await persist(group, id, state);
    } catch (error) {
      throw fromSdk(error);
    }
  };

  const start = async (group: AppGroup, input: Fiat24FlowInput): Promise<Fiat24FlowEntry> => {
    requireEnabled(group);
    const owner = await options.owner(group);
    if (input.flow === "onboarding" || input.flow === "top-up") {
      requireAvailable();
    }
    await requireResolved(group);
    let state: FlowState | PayoutDraft;
    try {
      switch (input.flow) {
        case "transfer":
          state = startTransfer({
            owner,
            currency: input.currency,
            amount: input.amount,
            to: input.to,
          });
          break;
        case "exchange":
          state = startExchange({
            owner,
            side: input.side,
            from: input.from,
            to: input.to,
            amount: input.amount,
          });
          break;
        case "payout":
          state = startPayout({
            owner,
            tokenId: await tokenIdOf(group),
            currency: input.currency,
            amount: input.amount,
            target: input.target,
          });
          break;
        case "top-up":
          state = startTopUp({ owner, output: input.output, usdcAmount: input.usdcAmount });
          break;
        case "onboarding":
          state = startOnboarding({ owner, tokenId: input.tokenId, payment: input.payment });
          break;
        case "card-setup":
          state = startCardSetup({ owner, tokenId: await tokenIdOf(group), cap: input.cap });
          break;
        case "card":
          state = startCardOperation({
            owner,
            tokenId: await tokenIdOf(group),
            operation: input.operation,
          });
          break;
      }
    } catch (error) {
      throw fromSdk(error);
    }
    const id = bytesToHex(options.random(8)).slice(2);
    if (state.flow === "payout" && state.step === "draft") {
      draftsOf(group).set(id, state);
    } else {
      await persist(group, id, state);
    }
    return { id, state };
  };

  /** The advance deps for one state — signer, persistence, and the optional session/api. */
  const depsFor = async (
    group: AppGroup,
    id: string,
    state: FlowState | PayoutDraft,
    capture: { refusal?: Fiat24Refusal },
  ): Promise<FlowDeps> => {
    const owner = await options.owner(group);
    const tokenId = "tokenId" in state ? state.tokenId : undefined;
    const signer = options.sessions.signer({
      group,
      owner,
      ...(tokenId === undefined ? {} : { tokenId }),
      refused: (reason) => {
        capture.refusal = reason;
      },
    });
    const deps: {
      client: FlowDeps["client"];
      signer: FlowDeps["signer"];
      persist: FlowDeps["persist"];
      session?: NonNullable<FlowDeps["session"]>;
      api?: NonNullable<FlowDeps["api"]>;
    } = {
      client: options.client,
      signer,
      persist: async (next) => persistFromSdk(group, id, next),
    };
    if ((state.flow === "payout" || state.flow === "card") && tokenId !== undefined) {
      const session = await options.sessions.sdk(group, tokenId);
      if (session !== undefined) {
        deps.session = session;
      }
    }
    if (state.flow === "onboarding" && options.api !== undefined) {
      deps.api = options.api;
    }
    return deps;
  };

  const advanceOnce = async (group: AppGroup, id: string): Promise<Fiat24FlowEntry> => {
    const draft = draftsOf(group).get(id);
    let state: FlowState | PayoutDraft;
    let persistedId = false;
    if (draft === undefined) {
      const bytes = await storage.get(group, `${FLOW_PREFIX}${id}`);
      if (bytes === undefined) {
        throw new Fiat24AppError("unknown-flow", "unknown Fiat24 flow");
      }
      try {
        state = decodeFlowState(read.decode(bytes));
      } catch (error) {
        throw fromSdk(error);
      }
      persistedId = true;
    } else {
      state = draft;
    }
    /* Refused before any SDK call: the state's next move reaches api.fiat24.com and none is
       wired. An in-flight chain record (approve `sending`, mint `submitted`) is never in this
       table — its advance polls the chain, not the API. */
    if (options.api === undefined && needsApi(state)) {
      throw new Fiat24AppError("api-unavailable", "the fiat24 api is not configured");
    }
    const capture: { refusal?: Fiat24Refusal } = {};
    let next: FlowState;
    try {
      const deps = await depsFor(group, id, state, capture);
      switch (state.flow) {
        case "transfer":
          next = await advanceTransfer(deps, state);
          break;
        case "exchange":
          next = await advanceExchange(deps, state);
          break;
        case "payout":
          next = await advancePayout(deps, state);
          break;
        case "card":
          next = await advanceCard(deps, state);
          break;
        case "onboarding":
          next = await advanceOnboarding(deps, state);
          break;
        case "top-up":
          next = await advanceTopUp(deps, state);
          break;
      }
    } catch (error) {
      /* The one API reach `needsApi` cannot see: a card `ready` whose chain leg reads satisfied
         falls into `advanceApiWrite` mid-advance. `session-required` can only mean no session was
         wired (depsFor opens one whenever `options.api` exists) — it is `api-unavailable`. */
      if (isFiat24Error(error) && error.code === "session-required") {
        throw new Fiat24AppError("api-unavailable", "the fiat24 api is not configured");
      }
      throw fromSdk(error);
    }
    if (!persistedId) {
      /* A draft's first advance produced the verified state — persist it and drop the PII. */
      draftsOf(group).delete(id);
    }
    return {
      id,
      state: next,
      ...(capture.refusal === undefined ? {} : { refusal: capture.refusal }),
    };
  };

  /** Serialises the group's advances; `enabledBy` is the gate at run time, not enqueue time. */
  const enqueue = async (
    group: AppGroup,
    run: () => Promise<Fiat24FlowEntry>,
  ): Promise<Fiat24FlowEntry> => {
    const key = groupKey(group);
    const tail = queue.get(key) ?? Promise.resolve();
    // oxlint-disable-next-line promise/prefer-await-to-then -- the tail chain is the serialisation, not an await site
    const next = tail.then(run, run);
    queue.set(
      key,
      // oxlint-disable-next-line promise/prefer-await-to-then -- the stored tail swallows so one failure frees the queue
      next.catch(() => undefined),
    );
    return next;
  };

  const advance = async (group: AppGroup, id: string): Promise<Fiat24FlowEntry> =>
    enqueue(group, async () => {
      requireEnabled(group);
      return advanceOnce(group, id);
    });

  /** Reconcile advance — gated on the storage record, safe before `init` derives groupState. */
  const reconcileAdvance = async (group: AppGroup, id: string): Promise<Fiat24FlowEntry> =>
    enqueue(group, async () => {
      requireUnlocked();
      if (!(await enabledRecord(group))) {
        throw new Fiat24AppError("not-enabled", "enable the Fiat24 app for this group first");
      }
      return advanceOnce(group, id);
    });

  const discard = async (group: AppGroup, id: string): Promise<void> => {
    requireEnabled(group);
    const draft = draftsOf(group).get(id);
    if (draft !== undefined) {
      draftsOf(group).delete(id);
      return;
    }
    const bytes = await storage.get(group, `${FLOW_PREFIX}${id}`);
    if (bytes === undefined) {
      throw new Fiat24AppError("unknown-flow", "unknown Fiat24 flow");
    }
    let state: FlowState;
    try {
      state = decodeFlowState(read.decode(bytes));
    } catch {
      /* An undecodable record can never reconcile — drop it; the host should have the user check
         the account's activity first. */
      await storage.delete(group, `${FLOW_PREFIX}${id}`);
      return;
    }
    const phase = lastPhase(state);
    if (phase !== undefined && UNRESOLVED.has(phase)) {
      throw new Fiat24AppError(
        "flow-unresolved",
        "a Fiat24 transaction is still sending — reconcile it before discarding",
      );
    }
    await storage.delete(group, `${FLOW_PREFIX}${id}`);
  };

  const payoutSettlement = async (
    group: AppGroup,
    id: string,
  ): Promise<PayoutSettlement & { readonly txid: string }> => {
    requireEnabled(group);
    const bytes = await storage.get(group, `${FLOW_PREFIX}${id}`);
    if (bytes === undefined) {
      throw new Fiat24AppError("unknown-flow", "unknown Fiat24 flow");
    }
    let state: FlowState;
    try {
      state = decodeFlowState(read.decode(bytes));
    } catch (error) {
      throw fromSdk(error);
    }
    if (state.flow !== "payout") {
      throw new Fiat24AppError("invalid-input", "the flow is not a payout");
    }
    try {
      return await loadPayoutSettlement({ client: options.client }, state);
    } catch (error) {
      throw fromSdk(error);
    }
  };

  /** (group, id) pairs with a reconcile advance already queued or running — never enqueued twice. */
  const inflight = new Set<string>();

  /**
   * One reconcile pass over the group's persisted flows — never sends. Driven by the provider's
   * `reconcile` (which runs per group once the store is open at init) and by the 15 s poll.
   */
  const reconcileGroup = async (group: AppGroup): Promise<void> => {
    if (!unlocked()) {
      return;
    }
    try {
      if (!(await enabledRecord(group))) {
        return;
      }
    } catch {
      return;
    }
    let records: ReadonlyArray<{ id: string; state: FlowState } | { id: string; invalid: true }>;
    try {
      records = await persisted(group);
    } catch (error) {
      warn(group, error);
      return;
    }
    for (const record of records) {
      if ("invalid" in record) {
        options.logger.warn("fiat24 reconcile skipped an undecodable flow", {
          category: "protocol",
          code: "invalid-state",
        });
        continue;
      }
      const phase = lastPhase(record.state);
      if (phase === undefined || !UNRESOLVED.has(phase)) {
        continue;
      }
      const inflightKey = `${groupKey(group)}:${record.id}`;
      if (inflight.has(inflightKey)) {
        continue;
      }
      inflight.add(inflightKey);
      /* oxlint-disable promise/prefer-await-to-then -- reconcile is fire-and-forget behind the
         serial queue; settle and cleanup run detached */
      void reconcileAdvance(group, record.id)
        .catch((error: unknown) => warn(group, error))
        .finally(() => {
          inflight.delete(inflightKey);
        });
      /* oxlint-enable promise/prefer-await-to-then */
    }
  };

  /** One reconcile pass over every group's persisted flows — never sends. */
  const reconcilePass = async (): Promise<void> => {
    if (!unlocked()) {
      return;
    }
    let groups: ReadonlyArray<AppGroup>;
    try {
      groups = await storage.groups();
    } catch {
      return;
    }
    await Promise.all(groups.map(async (group) => reconcileGroup(group)));
  };

  const warn = (group: AppGroup, error: unknown): void => {
    const category = error instanceof Fiat24AppError ? error.category : "protocol";
    const code = error instanceof Fiat24AppError ? error.code : undefined;
    options.logger.warn(`fiat24 reconcile ${groupKey(group)} failed`, { category, code });
  };

  const poll = async (): Promise<void> => {
    polling = true;
    try {
      await reconcilePass();
    } finally {
      polling = false;
      timer =
        visible && unlocked()
          ? options.setTimer(FIAT24_RECONCILE_MS, () => void poll())
          : undefined;
    }
  };

  const dropGroup = (group: AppGroup): void => {
    options.sessions.end(group);
    drafts.delete(groupKey(group));
    for (const id of options.sessions.openedIds(group)) {
      try {
        requests.reject(id);
      } catch {
        /* the request already settled — nothing left to reject */
      }
    }
  };

  return {
    flows: {
      list: async (group) => {
        requireEnabled(group);
        const out: Fiat24Flow[] = [];
        for (const record of await persisted(group)) {
          out.push(record);
        }
        for (const [id, state] of draftsOf(group)) {
          out.push({ id, state });
        }
        return out;
      },
      start,
      advance,
      discard,
      payoutSettlement,
    },
    reconcileGroup,
    unlock: () => {
      /* The pre-init reconcile pass lives in the provider's `reconcile` — it runs once the store
         is open. This hook only re-arms the poll; `visible` is the host's flag, kept across lock. */
      if (visible && timer === undefined && !polling) {
        timer = options.setTimer(FIAT24_RECONCILE_MS, () => void poll());
      }
    },
    setVisible: (next) => {
      visible = next;
      if (visible && unlocked() && timer === undefined && !polling) {
        // oxlint-disable-next-line promise/prefer-await-to-then -- the visibility hook is synchronous
        void poll().catch(() => undefined);
      } else if (!visible && timer !== undefined) {
        timer();
        timer = undefined;
      }
    },
    lock: () => {
      /* The host's visibility flag is kept — unlock re-arms the poll without another setVisible. */
      if (timer !== undefined) {
        timer();
        timer = undefined;
      }
      drafts.clear();
      options.sessions.endAll();
    },
    dropGroup,
    dropMissing: (wallets) => {
      const groups = new Map<string, AppGroup>(known);
      for (const group of options.sessions.tracked()) {
        groups.set(groupKey(group), group);
      }
      for (const group of groups.values()) {
        if (!wallets.has(group.walletId)) {
          dropGroup(group);
        }
      }
    },
    close: () => {
      visible = false;
      if (timer !== undefined) {
        timer();
        timer = undefined;
      }
      drafts.clear();
      options.sessions.endAll();
    },
  };
}
