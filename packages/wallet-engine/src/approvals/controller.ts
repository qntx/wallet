/**
 * The approvals inventory: which spenders, delegates and keys hold authority over each loaded
 * account. Discovery sources (the gateway's event scan, this session's tracked sends, the persisted
 * candidate set) yield keys only; every row comes from a chain read at the stated height through
 * the corroborate rule, so a hostile or stale discovery source can hide rows but never invent
 * them.
 *
 * A view loads through `load(account, network)` and refreshes single-flight per view — a refresh
 * asked for while one runs reruns once after it. Views poll every {@link APPROVALS_POLL_MS} while
 * the host is visible, and a tracked send confirming on a loaded network refreshes its views.
 * `lock` drops every view, cancels timers and aborts in-flight fetches; the epoch makes late
 * answers write nothing.
 */
import { ChainError } from "@qntx/wallet-chains";
import { evmTokenTable, lookupEvmToken } from "@qntx/wallet-chains/evm";
import { lookupTronToken, tronTokenTable } from "@qntx/wallet-chains/tron";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import { gatewayFetch } from "../gateway/client.ts";
import type { GatewayConfig } from "../gateway/client.ts";
import type { NetworkController } from "../networks/controller.ts";
import { networkById } from "../networks/registry.ts";
import type { PendingRequest } from "../requests/controller.ts";
import type { EngineStore } from "../store/port.ts";
import { repeat } from "../timer.ts";
import type { SetTimer } from "../timer.ts";
import type { TransactionController } from "../transactions/controller.ts";
import { EVM_BATCH_LIMIT } from "../transactions/route.ts";
import type {
  AccountRef,
  ChainRequestInput,
  EvmRevokeTarget,
  PrepareParams,
  TrackedTransaction,
} from "../transactions/route.ts";
import { SOLANA_REVOKE_MAX } from "../transactions/solana-revoke.ts";
import type { ChainResult } from "./evm.ts";
import { evmApprovals } from "./evm.ts";
import { solanaApprovals } from "./solana.ts";
import {
  candidateKey,
  encodeCandidates,
  evmGatewayCandidates,
  gatherCandidates,
  localCandidates,
  parseStoredCandidates,
  tronGatewayCandidates,
} from "./sources.ts";
import type { Candidate } from "./sources.ts";
import { tronApprovals } from "./tron.ts";
import type {
  TokenRef,
  ApprovalRow,
  ApprovalSourceState,
  ApprovalsState,
  ApprovalsView,
  SessionLink,
} from "./types.ts";

export const APPROVALS_POLL_MS = 600_000;
const COLLECTION = "approvals";

export type ApprovalsControllerOptions = {
  readonly networks: Pick<
    NetworkController,
    | "client"
    | "independentClient"
    | "solanaRpc"
    | "independentSolanaRpc"
    | "tronApi"
    | "independentTronApi"
    | "gatewayFirst"
  >;
  readonly transactions: Pick<TransactionController, "getState" | "store">;
  readonly gateway: GatewayConfig | undefined;
  readonly fetch: typeof globalThis.fetch;
  /** The session EngineStore — opened once per unlock, closed on lock. */
  readonly openStore: () => Promise<EngineStore>;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  readonly logger: EngineLogger;
  /** Resolves a send-account ref to its address on `network` (HD or imported; family-checked). */
  readonly addressOf: (account: AccountRef, network: string) => Promise<string>;
  /** The engine's known addresses per family — address book + paid recipients. */
  readonly known: (family: "evm" | "solana" | "tron") => ReadonlyArray<string>;
  /** Token display metadata for one contract/mint — host read, may throw. */
  readonly tokenMetadata: (
    network: string,
    address: string,
  ) => Promise<{ readonly symbol: string; readonly decimals: number }>;
  /** Kernel session keys signing for `owner` — engine root filters; [] + warn on failure. */
  readonly sessions: (owner: string) => Promise<ReadonlyArray<SessionLink>>;
  /** Prepares a wallet-internal chain request — the engine root passes `requests.prepare`. */
  readonly prepare: (input: ChainRequestInput) => Promise<PendingRequest>;
};

const emptyView = (key: string, network: string, owner: string): ApprovalsView => ({
  key,
  network,
  owner,
  status: "loading",
  rows: [],
  exhaustive: [],
  sources: [],
  dropped: 0,
  disputed: 0,
  unread: 0,
  unverified: 0,
  sessions: [],
});

/** The `evm-revoke` target for one EVM row, `undefined` for other families. */
const evmTarget = (row: ApprovalRow): EvmRevokeTarget | undefined =>
  row.kind === "erc20" || row.kind === "permit2"
    ? { kind: row.kind, token: row.token.address, spender: row.spender }
    : row.kind === "operator"
      ? { kind: "operator", contract: row.contract, operator: row.operator }
      : row.kind === "nft"
        ? { kind: "nft", contract: row.contract, tokenId: BigInt(row.tokenId) }
        : undefined;

/** The chain request removing `row`'s authority — every `single`/`batchable` kind maps to one. */
export const revokeInput = (
  account: AccountRef,
  network: string,
  row: ApprovalRow,
  fee: PrepareParams["fee"],
): ChainRequestInput => {
  const target = evmTarget(row);
  if (target !== undefined) {
    return { method: "evm-revoke", account, network, targets: [target], fee };
  }
  if (row.kind === "delegation") {
    return { method: "evm-delegation", account, network, action: "revoke", fee };
  }
  if (row.kind === "spl-delegate") {
    return {
      method: "solana-revoke",
      account,
      network,
      tokenAccounts: [row.tokenAccount],
      fee,
    };
  }
  if (row.kind === "trc20") {
    return {
      method: "tron-approve",
      account,
      network,
      token: row.token.address,
      spender: row.spender,
      amount: 0n,
    };
  }
  throw new ChainError(
    "invalid-request",
    `a ${row.kind} approval cannot be revoked from this wallet`,
  );
};

/** Whether an intent grants anything — approvals or a 7702 authorization, batch calls included. */
const intentHasApprovals = (intent: TrackedTransaction["intent"]): boolean => {
  if (intent === undefined) {
    return false;
  }
  if (intent.delegation !== undefined || intent.approvals.length > 0) {
    return true;
  }
  if ((intent.staking ?? []).some((action) => action.kind === "create")) {
    return true;
  }
  return (intent.calls ?? []).some((call) => intentHasApprovals(call));
};

export class ApprovalsController extends Controller<ApprovalsState> {
  private readonly options: ApprovalsControllerOptions;
  private readonly fetchGateway: typeof globalThis.fetch;
  private engineStore: EngineStore | undefined;
  private active = false;
  private visible = false;
  private epoch = 0;
  private cancelPoll: (() => void) | undefined;
  private unsubscribeTxs: (() => void) | undefined;
  private readonly inflight = new Map<string, Promise<void>>();
  /** The account each loaded view was opened with — feeds `revoke`/`revokeBatch`. */
  private readonly accounts = new Map<string, AccountRef>();
  private readonly rerun = new Set<string>();
  /** Lowest chain height the next refresh of a key may read at — set by confirmed sends. */
  private readonly floors = new Map<string, bigint>();
  private readonly aborts = new Set<() => void>();
  /** Token metadata cached per session — a failed read is cached too (never retried in-session). */
  private readonly tokens = new Map<
    string,
    Promise<{ readonly symbol?: string; readonly decimals?: number }>
  >();

  constructor(options: ApprovalsControllerOptions) {
    super({ name: "approvals", defaultState: () => ({ views: {} }) });
    this.options = options;
    this.fetchGateway = gatewayFetch(options.fetch, options.gateway);
  }

  async init(): Promise<void> {
    this.engineStore = await this.options.openStore();
    this.active = true;
    let previous: Readonly<Record<string, TrackedTransaction>> =
      this.options.transactions.getState().txs;
    this.unsubscribeTxs = this.options.transactions.store.subscribe((state) => {
      const confirmed = Object.values(state.txs).filter(
        (tx) =>
          tx.state === "confirmed" &&
          previous[tx.id]?.state !== "confirmed" &&
          intentHasApprovals(tx.intent),
      );
      previous = state.txs;
      if (confirmed.length === 0) {
        return;
      }
      /* A head polled right after inclusion can still lag the confirming block — read at least at
       * the confirmed height or the just-mined change is invisible to the refresh. */
      const floors = new Map<string, bigint>();
      for (const tx of confirmed) {
        if (tx.block === undefined) {
          continue;
        }
        const height = BigInt(tx.block.height);
        const floor = floors.get(tx.network);
        if (floor === undefined || floor < height) {
          floors.set(tx.network, height);
        }
      }
      for (const view of Object.values(this.getState().views)) {
        const floor = floors.get(view.network);
        if (floor !== undefined) {
          void this.refreshAt(view.key, floor);
        }
      }
    });
    if (this.visible) {
      this.armPoll();
    }
  }

  lock(): void {
    this.active = false;
    this.epoch += 1;
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    this.unsubscribeTxs?.();
    this.unsubscribeTxs = undefined;
    for (const abort of this.aborts) {
      abort();
    }
    this.aborts.clear();
    this.tokens.clear();
    this.accounts.clear();
    this.inflight.clear();
    this.rerun.clear();
    this.floors.clear();
    this.engineStore = undefined;
    this.update(() => ({ views: {} }));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  /** Visible: poll every {@link APPROVALS_POLL_MS}. Hidden: stop. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.cancelPoll?.();
      this.cancelPoll = undefined;
      return;
    }
    if (this.active && this.cancelPoll === undefined) {
      this.armPoll();
    }
  }

  /**
   * Loads (or returns) the view for `account` on `network`, then refreshes it. The key is
   * `${network}|${owner}` — the address the view's rows grant over.
   */
  async load(account: AccountRef, network: string): Promise<string> {
    const info = networkById(network);
    if (
      info === undefined ||
      (info.family !== "evm" && info.family !== "solana" && info.family !== "tron")
    ) {
      throw new ChainError("unsupported", `no approvals inventory on ${network}`);
    }
    const owner = await this.options.addressOf(account, network);
    const key = `${network}|${owner}`;
    this.accounts.set(key, account);
    const existing = this.getState().views[key];
    if (existing !== undefined) {
      return key;
    }
    this.update((s) => ({ views: { ...s.views, [key]: emptyView(key, network, owner) } }));
    void this.refresh(key);
    return key;
  }

  /** Removes a view; an in-flight refresh's answer is discarded via the state check. */
  unload(key: string): void {
    this.accounts.delete(key);
    this.update((s) => {
      if (s.views[key] === undefined) {
        return s;
      }
      return {
        views: Object.fromEntries(Object.entries(s.views).filter(([k]) => k !== key)),
      };
    });
  }

  /**
   * Builds one wallet-internal revocation request for a row — `none` rows and unknown ids throw
   * `invalid-request`. The row is never removed optimistically: the confirmed-transaction
   * subscription re-reads the view after inclusion, so it stays while the chain still shows the
   * approval. One request per call — nonces are reserved at commit, so several prepared at once
   * would make all but the first stale.
   */
  async revoke(
    key: string,
    rowId: string,
    fee: PrepareParams["fee"] = "normal",
  ): Promise<PendingRequest> {
    const { view, row, account } = this.rowFor(key, rowId);
    return this.options.prepare(revokeInput(account, view.network, row, fee));
  }

  /**
   * Builds one wallet-internal revocation request covering several rows — at least two distinct,
   * all `batchable`, all one family: EVM approvals (≤ {@link EVM_BATCH_LIMIT}) become one
   * `evm-revoke`, SPL delegates (≤ {@link SOLANA_REVOKE_MAX}) one `solana-revoke`. Same nonce
   * caveat as {@link revoke}: one request per call.
   */
  async revokeBatch(
    key: string,
    rowIds: ReadonlyArray<string>,
    fee: PrepareParams["fee"] = "normal",
  ): Promise<PendingRequest> {
    const view = this.getState().views[key];
    const account = this.accounts.get(key);
    if (view === undefined || account === undefined) {
      throw new ChainError("invalid-request", `unknown approvals view ${key}`);
    }
    if (rowIds.length < 2 || new Set(rowIds).size !== rowIds.length) {
      throw new ChainError(
        "invalid-request",
        "a revocation batch needs at least two distinct rows",
      );
    }
    const rows = rowIds.map((id) => {
      const { row } = this.rowFor(key, id);
      if (row.revoke !== "batchable") {
        throw new ChainError("invalid-request", `${id} cannot be revoked in a batch`);
      }
      return row;
    });
    const targets = rows.map(evmTarget);
    if (targets.every((t): t is EvmRevokeTarget => t !== undefined)) {
      if (targets.length > EVM_BATCH_LIMIT) {
        throw new ChainError(
          "invalid-request",
          `an EVM revocation batch allows at most ${EVM_BATCH_LIMIT.toString(10)} rows`,
        );
      }
      return this.options.prepare({
        method: "evm-revoke",
        account,
        network: view.network,
        targets,
        fee,
      });
    }
    const tokenAccounts: string[] = [];
    for (const row of rows) {
      if (row.kind === "spl-delegate") {
        tokenAccounts.push(row.tokenAccount);
      }
    }
    if (tokenAccounts.length === rows.length) {
      if (tokenAccounts.length > SOLANA_REVOKE_MAX) {
        throw new ChainError(
          "invalid-request",
          `a Solana revocation batch allows at most ${SOLANA_REVOKE_MAX.toString(10)} rows`,
        );
      }
      return this.options.prepare({
        method: "solana-revoke",
        account,
        network: view.network,
        tokenAccounts,
        fee,
      });
    }
    throw new ChainError(
      "invalid-request",
      "a revocation batch takes rows of one family — EVM approvals or SPL delegates",
    );
  }

  /** The loaded view, its row and the account it was opened with — all three or a throw. */
  private rowFor(
    key: string,
    rowId: string,
  ): { view: ApprovalsView; row: ApprovalRow; account: AccountRef } {
    const view = this.getState().views[key];
    const account = this.accounts.get(key);
    const row = view?.rows.find((r) => r.id === rowId);
    if (view === undefined || account === undefined || row === undefined) {
      throw new ChainError("invalid-request", `unknown approvals row ${rowId} in ${key}`);
    }
    return { view, row, account };
  }

  /** Re-reads a view: single-flight per key, a concurrent ask reruns once after. */
  async refresh(key: string): Promise<void> {
    await this.refreshAt(key, undefined);
  }

  /**
   * `refresh` with a lowest chain height the next read may answer at — the confirmed-transaction
   * subscription sets it to the send's block so a lagging head cannot hide what the send changed.
   */
  private async refreshAt(key: string, floor: bigint | undefined): Promise<void> {
    if (!this.active) {
      return;
    }
    if (floor !== undefined) {
      const current = this.floors.get(key);
      if (current === undefined || current < floor) {
        this.floors.set(key, floor);
      }
    }
    const running = this.inflight.get(key);
    if (running !== undefined) {
      this.rerun.add(key);
      await running;
      return;
    }
    const run = async (): Promise<void> => {
      try {
        do {
          this.rerun.delete(key);
          // oxlint-disable-next-line eslint/no-await-in-loop -- a rerun must follow the run it waited on
          await this.refreshOnce(key);
        } while (this.rerun.has(key) && this.active);
      } finally {
        this.inflight.delete(key);
      }
    };
    const promise = run();
    this.inflight.set(key, promise);
    await promise;
  }

  private armPoll(): void {
    this.cancelPoll = repeat(
      this.options.setTimer,
      APPROVALS_POLL_MS,
      async () => {
        await Promise.all(Object.keys(this.getState().views).map(async (key) => this.refresh(key)));
      },
      (error) => {
        this.options.logger.warn("approvals poll failed", error);
      },
    );
  }

  private async token(network: string, family: string, address: string) {
    const key = `${network}:${address.toLowerCase()}`;
    let cached = this.tokens.get(key);
    if (cached === undefined) {
      const info = networkById(network);
      const listed =
        family === "evm" && info !== undefined
          ? lookupEvmToken(evmTokenTable, info.chainId, address)
          : family === "tron"
            ? lookupTronToken(tronTokenTable, network, address)
            : undefined;
      cached =
        listed === undefined
          ? this.tryTokenMetadata(network, address)
          : Promise.resolve({ symbol: listed.symbol, decimals: listed.decimals });
      this.tokens.set(key, cached);
    }
    return cached;
  }

  /* A metadata failure must never fail a row. */
  private async tryTokenMetadata(
    network: string,
    address: string,
  ): Promise<Pick<TokenRef, "symbol" | "decimals">> {
    try {
      return await this.options.tokenMetadata(network, address);
    } catch {
      return {};
    }
  }

  /** The persisted candidate keys for one view; a malformed record is ignored with a warning. */
  private async stored(key: string): Promise<ReadonlyArray<Candidate>> {
    const raw = await this.engineStore?.collection(COLLECTION).get(key);
    if (raw === undefined) {
      return [];
    }
    const candidates = parseStoredCandidates(raw);
    if (candidates === undefined) {
      this.options.logger.warn(`ignoring malformed stored approvals for ${key}`);
      return [];
    }
    return [...candidates];
  }

  /** Persists the candidates the refresh proved live or could not rule out. */
  private async persist(key: string, keep: ReadonlyArray<Candidate>): Promise<void> {
    try {
      await this.engineStore?.collection(COLLECTION).put(key, encodeCandidates(keep));
    } catch (error) {
      this.options.logger.warn("storing approvals candidates failed", error);
    }
  }

  private async refreshOnce(key: string): Promise<void> {
    const view = this.getState().views[key];
    if (view === undefined) {
      return;
    }
    const { epoch } = this;
    const { network, owner } = view;
    const info = networkById(network);
    if (
      info === undefined ||
      (info.family !== "evm" && info.family !== "solana" && info.family !== "tron")
    ) {
      return;
    }
    try {
      const [sessions, storedCandidates] = await Promise.all([
        this.options.sessions(owner),
        this.stored(key),
      ]);
      const local = [
        ...localCandidates(this.options.transactions.getState().txs, info.family, network, owner),
        ...storedCandidates,
      ];
      const floor = this.floors.get(key);
      this.floors.delete(key);

      let sources: ReadonlyArray<ApprovalSourceState>;
      let result: ChainResult;
      let gatewayClaims: ReadonlyArray<{ candidate: Candidate; seen?: bigint }> = [];
      if (info.family === "evm") {
        const gateway =
          this.options.gateway === undefined
            ? { status: "unavailable" as const, candidates: [] }
            : await evmGatewayCandidates(
                {
                  gateway: { url: this.options.gateway.url, fetch: this.fetchGateway },
                  setTimer: this.options.setTimer,
                  now: this.options.now,
                  aborts: this.aborts,
                },
                network,
                owner,
              );
        gatewayClaims = gateway.candidates;
        sources = [
          {
            source: "gateway",
            status: gateway.status,
            ...(gateway.at === undefined ? {} : { at: gateway.at }),
            ...(gateway.toBlock === undefined ? {} : { toBlock: gateway.toBlock }),
          },
          { source: "local", status: "ok" },
        ];
        result = await evmApprovals(
          {
            networks: this.options.networks,
            token: async (address) => this.token(network, "evm", address),
            known: () => this.options.known("evm"),
          },
          network,
          owner,
          gatherCandidates([
            ...gatewayClaims.map((c) => ({
              candidate: c.candidate,
              seen: c.seen,
              source: "gateway" as const,
            })),
            ...local.map((candidate) => ({ candidate, source: "local" as const })),
          ]),
          floor,
        );
      } else if (info.family === "solana") {
        sources = [{ source: "local", status: "ok" }];
        result = await solanaApprovals(
          { networks: this.options.networks, known: () => this.options.known("solana") },
          network,
          owner,
          gatherCandidates(local.map((candidate) => ({ candidate, source: "local" as const }))),
        );
      } else {
        const gateway = await tronGatewayCandidates(
          { networks: this.options.networks, now: this.options.now },
          network,
          owner,
        );
        gatewayClaims = gateway.candidates;
        sources = [
          {
            source: "gateway",
            status: gateway.status,
            ...(gateway.at === undefined ? {} : { at: gateway.at }),
          },
          { source: "local", status: "ok" },
        ];
        result = await tronApprovals(
          {
            networks: this.options.networks,
            token: async (address) => this.token(network, "tron", address),
            known: () => this.options.known("tron"),
          },
          network,
          owner,
          gatherCandidates([
            ...gatewayClaims.map((c) => ({
              candidate: c.candidate,
              seen: c.seen,
              source: "gateway" as const,
            })),
            ...local.map((candidate) => ({ candidate, source: "local" as const })),
          ]),
        );
      }
      if (epoch !== this.epoch) {
        return;
      }
      const rows: ReadonlyArray<ApprovalRow> = result.rows;
      this.update((s) => {
        const current = s.views[key];
        if (current === undefined) {
          return s;
        }
        const next: ApprovalsView = {
          key,
          network,
          owner,
          status: "ready",
          at: result.at,
          rows,
          exhaustive: result.exhaustive,
          sources,
          dropped: result.dropped,
          disputed: result.disputed,
          unread: result.unread,
          unverified: result.unverified,
          sessions,
          updatedAt: this.options.now(),
        };
        return { views: { ...s.views, [key]: next } };
      });
      const kept = new Set(result.keep);
      const gathered = gatherCandidates([
        ...gatewayClaims.map((c) => ({
          candidate: c.candidate,
          seen: c.seen,
          source: "gateway" as const,
        })),
        ...local.map((candidate) => ({ candidate, source: "local" as const })),
      ]);
      await this.persist(
        key,
        gathered.filter((g) => kept.has(candidateKey(g.candidate))).map((g) => g.candidate),
      );
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.update((s) => {
        const current = s.views[key];
        if (current === undefined) {
          return s;
        }
        return {
          views: {
            ...s.views,
            [key]: {
              ...current,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      });
    }
  }
}
