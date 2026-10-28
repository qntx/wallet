import type { SparkNetwork } from "@qntx/spark";
import type { Wallet } from "@qntx/wallet";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { SparkController } from "../spark/controller.ts";
import type { EngineCollection, EngineStore } from "../store/port.ts";
import { AccountTreeError } from "./errors.ts";

export type AccountGroup = {
  readonly walletId: string;
  readonly index: number;
  readonly name?: string;
  readonly hidden: boolean;
};

export type AccountTreeState = {
  readonly status: "locked" | "ready";
  readonly wallets: ReadonlyArray<{ readonly walletId: string; readonly name?: string }>;
  readonly groups: Readonly<Record<string, ReadonlyArray<AccountGroup>>>;
  // oxlint-disable-next-line typescript/no-restricted-types -- spec shape: no wallets → null
  readonly selected: { readonly walletId: string; readonly groupIndex: number } | null;
  readonly totals: Readonly<Record<string, number>>;
};

export type AccountTreeControllerOptions = {
  readonly wallet: Wallet;
  readonly spark: SparkController;
  readonly sparkNetwork: SparkNetwork;
  readonly logger: EngineLogger;
  readonly now: () => number;
};

type PersistedTree = {
  readonly wallets: Readonly<Record<string, { readonly name?: string }>>;
  readonly groups: Readonly<Record<string, ReadonlyArray<AccountGroup>>>;
  // oxlint-disable-next-line typescript/no-restricted-types -- wire contract: selected may be null
  readonly selected: { readonly walletId: string; readonly groupIndex: number } | null;
  readonly totals: Readonly<Record<string, number>>;
};

const EMPTY_TREE: PersistedTree = { wallets: {}, groups: {}, selected: null, totals: {} };

const TOTAL_KEY = (walletId: string, index: number): string => `${walletId}:${index}`;

const NAME_MAX = 24;
const TOTALS_DEBOUNCE_MS = 1000;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const own = (o: Record<string, unknown>, k: string): boolean => Object.hasOwn(o, k);

const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function validateName(v: unknown): string | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== "string") {
    return undefined;
  }
  const name = v.trim();
  return name.length > 0 && name.length <= NAME_MAX ? name : undefined;
}

const KNOWN_GROUP_KEYS = new Set(["walletId", "index", "name", "hidden"]);
const KNOWN_TOP_KEYS = new Set(["wallets", "groups", "selected", "totals"]);
const KNOWN_WALLET_KEYS = new Set(["name"]);
const KNOWN_SELECTED_KEYS = new Set(["walletId", "groupIndex"]);

/** Strict decode — any malformed shape or unknown key returns `undefined`. */
function decodeTree(bytes: Uint8Array): PersistedTree | undefined {
  try {
    const text = new TextDecoder().decode(bytes);
    const raw: unknown = JSON.parse(text);
    if (!isPlainObject(raw)) {
      return undefined;
    }
    for (const k of Object.keys(raw)) {
      if (!KNOWN_TOP_KEYS.has(k)) {
        return undefined;
      }
    }
    const rawWallets = raw["wallets"];
    const rawGroups = raw["groups"];
    const rawSelected = raw["selected"];
    const rawTotals = raw["totals"];
    if (!isPlainObject(rawWallets) || !isPlainObject(rawGroups) || !isPlainObject(rawTotals)) {
      return undefined;
    }
    const wallets: Record<string, { name?: string }> = {};
    for (const [walletId, w] of Object.entries(rawWallets)) {
      if (!isPlainObject(w) || walletId.length === 0) {
        return undefined;
      }
      for (const k of Object.keys(w)) {
        if (!KNOWN_WALLET_KEYS.has(k)) {
          return undefined;
        }
      }
      const name = validateName(w["name"]);
      if (w["name"] !== undefined && name === undefined) {
        return undefined;
      }
      wallets[walletId] = name === undefined ? {} : { name };
    }
    const groups: Record<string, AccountGroup[]> = {};
    for (const [walletId, arr] of Object.entries(rawGroups)) {
      if (!Array.isArray(arr)) {
        return undefined;
      }
      const seen = new Set<number>();
      const list: AccountGroup[] = [];
      for (const item of arr) {
        if (!isPlainObject(item)) {
          return undefined;
        }
        for (const k of Object.keys(item)) {
          if (!KNOWN_GROUP_KEYS.has(k)) {
            return undefined;
          }
        }
        if (item["walletId"] !== walletId || !isNonNegativeInt(item["index"])) {
          return undefined;
        }
        const { index } = item;
        if (seen.has(index) || (item["hidden"] !== true && item["hidden"] !== false)) {
          return undefined;
        }
        seen.add(index);
        const name = validateName(item["name"]);
        if (item["name"] !== undefined && name === undefined) {
          return undefined;
        }
        list.push({
          walletId,
          index,
          hidden: item["hidden"],
          ...(name === undefined ? {} : { name }),
        });
      }
      list.sort((a, b) => a.index - b.index);
      groups[walletId] = list;
    }
    let selected: PersistedTree["selected"] = null;
    if (rawSelected !== undefined && rawSelected !== null) {
      if (!isPlainObject(rawSelected)) {
        return undefined;
      }
      for (const k of Object.keys(rawSelected)) {
        if (!KNOWN_SELECTED_KEYS.has(k)) {
          return undefined;
        }
      }
      const { walletId } = rawSelected;
      const { groupIndex } = rawSelected;
      if (typeof walletId !== "string" || walletId.length === 0 || !isNonNegativeInt(groupIndex)) {
        return undefined;
      }
      selected = { walletId, groupIndex };
    }
    const totals: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawTotals)) {
      if (!own(rawTotals, k) || !isNonNegativeInt(v)) {
        return undefined;
      }
      totals[k] = v;
    }
    return { wallets, groups, selected, totals };
  } catch {
    return undefined;
  }
}

function encodeTree(tree: PersistedTree): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(tree));
}

/**
 * Declarative account tree: wallets come from the Wallet snapshot (reconciled on unlock and on
 * every snapshot change while unlocked), groups/names/hidden/selected/totals persist to the engine
 * store under `accounts/tree`. The controller drives `spark.setAccounts` with the selected group
 * only — an unselected group needs no live client (incoming transfers are claimed whenever it is
 * selected again). The active account's `balanceSats` feeds `totals`, debounced 1 s before
 * persist.
 */
export class AccountTreeController extends Controller<AccountTreeState> {
  private readonly options: AccountTreeControllerOptions;
  private col: EngineCollection | undefined;
  private sparkUnsubscribe: (() => void) | undefined;
  private totalsTimer: ReturnType<typeof setTimeout> | undefined;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: AccountTreeControllerOptions) {
    super({
      name: "accounts",
      defaultState: () => ({
        status: "locked",
        wallets: [],
        groups: {},
        selected: null,
        totals: {},
      }),
    });
    this.options = options;
  }

  setStore(store: EngineStore | undefined): void {
    this.col = store === undefined ? undefined : store.collection("accounts");
  }

  /** Load persisted state, reconcile with the snapshot, start driving Spark. */
  async init(): Promise<void> {
    const persisted = await this.load();
    this.update(() => ({ status: "ready", ...persistedToState(persisted) }));
    this.reconcile();
    // First drive: the reconciled selection always starts a client for it.
    this.driveSpark(this.getState().selected);
    this.sparkUnsubscribe = this.options.spark.store.subscribe((state) => {
      this.onSparkState(state.accounts);
    });
  }

  async destroy(): Promise<void> {
    this.sparkUnsubscribe?.();
    this.sparkUnsubscribe = undefined;
    await this.lock();
  }

  /** Locked: stop every Spark client, flush pending persists, then drop to the empty state. */
  async lock(): Promise<void> {
    this.sparkUnsubscribe?.();
    this.sparkUnsubscribe = undefined;
    this.options.spark.setAccounts([]);
    // Flush while the real state is still visible — updating first would persist empties over
    // names, groups, hidden flags and the selection.
    await this.flushTotals();
    this.col = undefined;
    this.update(() => ({
      status: "locked",
      wallets: [],
      groups: {},
      selected: null,
      totals: {},
    }));
    await Promise.resolve();
  }

  /** Reconcile groups/names/selected with `wallet.getSnapshot().wallets`; persists on change. */
  reconcile(): void {
    if (this.getState().status !== "ready") {
      return;
    }
    const snapshot = this.options.wallet.getSnapshot();
    const live = snapshot.wallets.map((w) => w.walletId);
    const liveSet = new Set(live);
    const state = this.getState();
    const namesById = new Map(state.wallets.map((w) => [w.walletId, w.name]));
    const wallets = live.map((walletId) => {
      const name = namesById.get(walletId);
      return name === undefined ? { walletId } : { walletId, name };
    });
    const groups: Record<string, ReadonlyArray<AccountGroup>> = {};
    for (const walletId of live) {
      const existing = state.groups[walletId] ?? [];
      groups[walletId] = existing.length > 0 ? existing : [{ walletId, index: 0, hidden: false }];
    }
    const totals: Record<string, number> = {};
    for (const [k, v] of Object.entries(state.totals)) {
      const walletId = k.slice(0, Math.max(0, k.lastIndexOf(":")));
      if (liveSet.has(walletId)) {
        totals[k] = v;
      }
    }
    const selected = this.validSelection(groups, live, state.selected);
    const changed =
      JSON.stringify(wallets) !== JSON.stringify(state.wallets) ||
      JSON.stringify(groups) !== JSON.stringify(state.groups) ||
      JSON.stringify(totals) !== JSON.stringify(state.totals) ||
      JSON.stringify(selected) !== JSON.stringify(state.selected);
    if (changed) {
      this.update((s) => ({ ...s, wallets, groups, totals, selected }));
      this.persist();
      // Drive only on effective change — an unchanged reconcile must not stomp a caller-set
      // setAccounts (e.g. tests running two accounts at once).
      this.driveSpark(selected);
    }
  }

  addGroup(walletId: string): number {
    this.mustWallet(walletId);
    const groups = this.getState().groups[walletId] ?? [];
    let index = 0;
    for (const g of groups) {
      index = Math.max(index, g.index + 1);
    }
    this.mutateGroups(walletId, (list) => [...list, { walletId, index, hidden: false }]);
    return index;
  }

  addGroups(walletId: string, indices: ReadonlyArray<number>): void {
    this.mustWallet(walletId);
    this.mutateGroups(walletId, (list) => {
      const have = new Set(list.map((g) => g.index));
      const added: AccountGroup[] = [];
      for (const i of indices) {
        if (Number.isSafeInteger(i) && i >= 0 && !have.has(i)) {
          have.add(i);
          added.push({ walletId, index: i, hidden: false });
        }
      }
      return [...list, ...added].sort((a, b) => a.index - b.index);
    });
  }

  renameWallet(walletId: string, name: string): void {
    this.mustWallet(walletId);
    const trimmed = this.checkedName(name);
    this.update((s) => ({
      ...s,
      wallets: s.wallets.map((w) => (w.walletId === walletId ? { walletId, name: trimmed } : w)),
    }));
    this.persist();
  }

  renameGroup(walletId: string, index: number, name: string): void {
    this.mustGroup(walletId, index);
    const trimmed = this.checkedName(name);
    this.mutateGroups(walletId, (list) =>
      list.map((g) => (g.index === index ? { ...g, name: trimmed } : g)),
    );
  }

  setHidden(walletId: string, index: number, hidden: boolean): void {
    const state = this.getState();
    this.mustGroup(walletId, index);
    const visible = this.visibleGroups(state).filter(
      (g) => !(g.walletId === walletId && g.index === index),
    );
    if (hidden && visible.length === 0) {
      throw new AccountTreeError("rejected", "cannot hide every account group");
    }
    this.mutateGroups(walletId, (list) =>
      list.map((g) => (g.index === index ? { ...g, hidden } : g)),
    );
    const sel = state.selected;
    if (sel !== null && sel.walletId === walletId && sel.groupIndex === index && hidden) {
      this.selectFallback();
    }
  }

  select(walletId: string, index: number): void {
    const state = this.getState();
    const group = (state.groups[walletId] ?? []).find((g) => g.index === index);
    if (group === undefined) {
      throw new AccountTreeError("not-found", "account group does not exist");
    }
    if (group.hidden) {
      throw new AccountTreeError("rejected", "cannot select a hidden account group");
    }
    if (state.selected?.walletId === walletId && state.selected.groupIndex === index) {
      return;
    }
    this.update((s) => ({ ...s, selected: { walletId, groupIndex: index } }));
    this.persist();
    this.driveSpark(this.getState().selected);
  }

  /** Sequential inspect from 0 upward; index 0 always included; stop after 2 consecutive unused. */
  async discoverSpark(walletId: string): Promise<number[]> {
    this.mustWallet(walletId);
    const found: number[] = [0];
    let index = 0;
    let unused = 0;
    while (found.length < 65) {
      const ref = { walletId, groupIndex: index, network: this.options.sparkNetwork } as const;
      // oxlint-disable-next-line eslint/no-await-in-loop -- discovery is sequential per spec
      const { used } = await this.options.spark.inspect(ref);
      if (used) {
        if (index !== 0) {
          found.push(index);
        }
        unused = 0;
      } else {
        unused += 1;
        if (index !== 0 && unused >= 2) {
          break;
        }
      }
      index += 1;
    }
    return found;
  }

  /** Refresh `totals` for every other visible group; per-group failures are logged and skipped. */
  async refreshTotals(): Promise<void> {
    const state = this.getState();
    const sel = state.selected;
    const targets = this.visibleGroups(state).filter(
      (g) => !(sel !== null && g.walletId === sel.walletId && g.index === sel.groupIndex),
    );
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const group = targets[cursor];
        cursor += 1;
        if (group === undefined) {
          return;
        }
        try {
          const ref = {
            walletId: group.walletId,
            groupIndex: group.index,
            network: this.options.sparkNetwork,
          } as const;
          // oxlint-disable-next-line eslint/no-await-in-loop -- workers drain a shared cursor
          const { balanceSats } = await this.options.spark.inspect(ref);
          this.setTotal(group.walletId, group.index, balanceSats);
        } catch (error) {
          this.options.logger.warn(
            `refreshTotals failed for ${group.walletId}:${group.index}`,
            error,
          );
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  private onSparkState(
    accounts: Readonly<Record<string, { readonly balanceSats?: number }>>,
  ): void {
    const sel = this.getState().selected;
    if (sel === null) {
      return;
    }
    const accountKey = `${sel.walletId}:${sel.groupIndex}:${this.options.sparkNetwork}`;
    const balance = accounts[accountKey]?.balanceSats;
    if (balance !== undefined) {
      this.setTotal(sel.walletId, sel.groupIndex, balance);
    }
  }

  private setTotal(walletId: string, index: number, balanceSats: number): void {
    const k = TOTAL_KEY(walletId, index);
    if (this.getState().totals[k] === balanceSats) {
      return;
    }
    this.update((s) => ({ ...s, totals: { ...s.totals, [k]: balanceSats } }));
    this.scheduleTotalsPersist();
  }

  private driveSpark(selected: AccountTreeState["selected"]): void {
    this.options.spark.setAccounts(
      selected === null ? [] : [{ ...selected, network: this.options.sparkNetwork }],
    );
  }

  private visibleGroups(state: AccountTreeState): AccountGroup[] {
    const out: AccountGroup[] = [];
    for (const w of state.wallets) {
      for (const g of state.groups[w.walletId] ?? []) {
        if (!g.hidden) {
          out.push(g);
        }
      }
    }
    return out;
  }

  private validSelection(
    groups: Record<string, ReadonlyArray<AccountGroup>>,
    walletOrder: ReadonlyArray<string>,
    current: AccountTreeState["selected"],
  ): AccountTreeState["selected"] {
    if (current !== null) {
      const g = (groups[current.walletId] ?? []).find((x) => x.index === current.groupIndex);
      if (g !== undefined && !g.hidden) {
        return current;
      }
    }
    for (const walletId of walletOrder) {
      for (const g of groups[walletId] ?? []) {
        if (!g.hidden) {
          return { walletId, groupIndex: g.index };
        }
      }
    }
    return null;
  }

  private selectFallback(): void {
    const state = this.getState();
    const next = this.validSelection(
      state.groups,
      state.wallets.map((w) => w.walletId),
      null,
    );
    this.update((s) => ({ ...s, selected: next }));
    this.persist();
    this.driveSpark(next);
  }

  private mutateGroups(
    walletId: string,
    fn: (list: ReadonlyArray<AccountGroup>) => ReadonlyArray<AccountGroup>,
  ): void {
    this.update((s) => ({
      ...s,
      groups: { ...s.groups, [walletId]: fn(s.groups[walletId] ?? []) },
    }));
    this.persist();
  }

  private mustWallet(walletId: string): void {
    if (this.getState().status !== "ready") {
      throw new AccountTreeError("locked", "account tree is locked");
    }
    if (!this.getState().wallets.some((w) => w.walletId === walletId)) {
      throw new AccountTreeError("not-found", "wallet does not exist");
    }
  }

  private mustGroup(walletId: string, index: number): void {
    this.mustWallet(walletId);
    if (!(this.getState().groups[walletId] ?? []).some((g) => g.index === index)) {
      throw new AccountTreeError("not-found", "account group does not exist");
    }
  }

  private checkedName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
      throw new AccountTreeError("invalid-input", "name must be 1-24 characters");
    }
    return trimmed;
  }

  private async load(): Promise<PersistedTree> {
    if (this.col === undefined) {
      return EMPTY_TREE;
    }
    const bytes = await this.col.get("tree");
    if (bytes === undefined) {
      return EMPTY_TREE;
    }
    const tree = decodeTree(bytes);
    if (tree === undefined) {
      this.options.logger.warn("invalid persisted account tree — starting empty");
      return EMPTY_TREE;
    }
    return tree;
  }

  /** Queues a store write behind the previous one — the last queued write always lands last. */
  private persist(): void {
    const { col } = this;
    if (col === undefined) {
      return;
    }
    const previous = this.persistChain;
    this.persistChain = (async () => {
      try {
        await previous;
        const s = this.getState();
        const tree: PersistedTree = {
          wallets: Object.fromEntries(
            s.wallets.map((w) => [w.walletId, w.name === undefined ? {} : { name: w.name }]),
          ),
          groups: s.groups,
          selected: s.selected,
          totals: s.totals,
        };
        await col.put("tree", encodeTree(tree));
      } catch (error) {
        this.options.logger.warn("account tree persist failed", error);
      }
    })();
  }

  private scheduleTotalsPersist(): void {
    if (this.totalsTimer !== undefined) {
      return;
    }
    this.totalsTimer = setTimeout(() => {
      this.totalsTimer = undefined;
      this.persist();
    }, TOTALS_DEBOUNCE_MS);
  }

  private async flushTotals(): Promise<void> {
    if (this.totalsTimer !== undefined) {
      clearTimeout(this.totalsTimer);
      this.totalsTimer = undefined;
      this.persist();
    }
    await this.persistChain;
  }
}

function persistedToState(tree: PersistedTree): Omit<AccountTreeState, "status"> {
  const wallets: Array<{ readonly walletId: string; readonly name?: string }> = [];
  for (const [walletId, w] of Object.entries(tree.wallets)) {
    if (w.name === undefined) {
      wallets.push({ walletId });
    } else {
      wallets.push({ walletId, name: w.name });
    }
  }
  return {
    wallets,
    groups: tree.groups,
    selected: tree.selected,
    totals: tree.totals,
  };
}
