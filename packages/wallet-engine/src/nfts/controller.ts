/**
 * NFT inventory — display-only gateway data; transfers go through requests.
 *
 * The gateway's page is never trusted: every answer passes the contract schema, the network-fit
 * checks (contract/tokenId shape, unique ids, family-appropriate standard) and the metadata
 * sanitisers before one item reaches state. Ownership a view shows comes back to chain only on the
 * post-inclusion re-read, which asks the wallet's own RPC — never the gateway — for the items a
 * confirmed send named. Media URLs are never fetched. What the user hides or shows survives the
 * lock as a plain record under the `nfts` collection.
 */
import { z } from "zod/mini";

import type { BitcoinUtxoView } from "../assets/bitcoin.ts";
import type { AccountBalances } from "../assets/controller.ts";
import { evmNftBalance, solanaNftBalance } from "../chains/nfts.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import { gatewayFetch } from "../gateway/client.ts";
import { parseWith } from "../gateway/contract/endpoint.ts";
import {
  nftAddressFits,
  nftCollectionFits,
  nftDetail,
  nftFloorResponse,
  nftCollectionPath,
  nftCollectionResponse,
  nftFloorPath,
  nftItemFits,
  nftItemPath,
  nftItemsPath,
  nftPage,
  nftPageFits,
} from "../gateway/contract/nfts.ts";
import type { NftCollection, NftDetail, NftItem, NftPage } from "../gateway/contract/nfts.ts";
import type { GatewayConfig } from "../gateway/session.ts";
import type { HistoryEntry } from "../history/types.ts";
import type { NetworkController } from "../networks/controller.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import type { SetTimer } from "../timer.ts";
import { repeat, timeoutSignal } from "../timer.ts";
import type { TrackedTransaction } from "../transactions/route.ts";
import { sanitizeCollection, sanitizeDetail, sanitizeItem } from "./metadata.ts";
import type { NftCollectionView, NftItemFacts } from "./metadata.ts";
import { nftAcquisition, nftSpam } from "./spam.ts";
import type { NftSpamReason } from "./spam.ts";

/** Poll cadence while the inventory is on screen — a refresh can walk 20 pages of 100 CU each. */
export const NFT_POLL_MS = 300_000;

/** The most pages `loadMore` walks before calling the inventory truncated. */
export const NFT_INVENTORY_MAX_PAGES = 20;

const COLLECTION = "nfts";
const VISIBILITY_KEY = "visibility";
const FETCH_TIMEOUT_MS = 30_000;

/** Why a gateway answer did not produce data. */
export type NftFailure =
  | "no-gateway"
  | "unavailable"
  | "rate-limited"
  | "unsupported"
  | "not-found"
  | "invalid-response";

/** An item as displayed: sanitised facts plus the controller's spam verdict and visibility. */
export type NftView = Omit<NftItemFacts, "gatewaySpam" | "deceptive"> & {
  readonly spam: ReadonlyArray<NftSpamReason>;
  readonly hidden: boolean;
};

/** A detail answer: the item's display view plus its long-form fields. */
export type NftDetailView = {
  readonly item: NftView;
  readonly description?: ReturnType<typeof sanitizeDetail>["description"];
  readonly attributes: ReadonlyArray<{ readonly trait: string; readonly value: string }>;
  readonly externalUrl?: string;
};

/** One marketplace's floor as displayed. */
export type NftFloorView = {
  readonly marketplace: "opensea" | "looksrare";
  readonly amount: string;
  readonly currency: string;
  // oxlint-disable-next-line typescript/no-restricted-types -- wire shape: null when unknown
  readonly retrievedAt: number | null;
};

/** One inventory's worth of gateway state for `${network}:${owner}`. */
export type NftInventory = {
  readonly network: string;
  readonly owner: string;
  readonly items: ReadonlyArray<NftView>;
  /** The cursor of the next page; `null` at the last page or when truncated. */
  // oxlint-disable-next-line typescript/no-restricted-types -- wire shape: null ends pagination
  readonly cursor: string | null;
  /** The number of pages fetched so far. */
  readonly pages: number;
  /** True when 20 pages were fetched and the cursor still names a next page. */
  readonly truncated: boolean;
  readonly loading: boolean;
  // oxlint-disable-next-line typescript/no-restricted-types -- state shape: null after a success
  readonly failure: NftFailure | null;
  // oxlint-disable-next-line typescript/no-restricted-types -- state shape: null until a fetch succeeds
  readonly updatedAt: number | null;
};

export type NftState = {
  readonly inventories: Readonly<Record<string, NftInventory>>;
};

export type NftResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: NftFailure };

export type NftControllerOptions = {
  readonly gateway: GatewayConfig | undefined;
  readonly fetch: typeof globalThis.fetch;
  readonly openStore: () => Promise<EngineStore>;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  readonly logger: EngineLogger;
  readonly networks: Pick<NetworkController, "info" | "client" | "solanaRpc">;
  readonly balances: () => Readonly<Record<string, AccountBalances>>;
  readonly activity: () => {
    readonly entries: ReadonlyArray<HistoryEntry>;
    readonly txs: ReadonlyArray<TrackedTransaction>;
  };
  readonly onActivityChange: (listener: () => void) => () => void;
  readonly onConfirmed: (listener: (tx: TrackedTransaction) => void) => () => void;
};

const storedVisibility = z.record(z.string(), z.record(z.string(), z.enum(["hidden", "shown"])));

const emptyInventory = (network: string, owner: string): NftInventory => ({
  network,
  owner,
  items: [],
  cursor: null,
  pages: 0,
  truncated: false,
  loading: false,
  failure: null,
  updatedAt: null,
});

export class NftController extends Controller<NftState> {
  private readonly options: NftControllerOptions;
  private readonly fetchGateway: typeof globalThis.fetch;
  private engineStore: EngineStore | undefined;
  private active = false;
  private visible = false;
  private epoch = 0;
  private cancelPoll: (() => void) | undefined;
  private unsubscribes: Array<() => void> = [];
  private readonly inflight = new Map<string, Promise<NftInventory>>();
  private readonly aborts = new Set<() => void>();
  /** Sanitised facts behind every view — the inventory keeps views, the controller keeps these. */
  private readonly facts = new Map<string, NftItemFacts[]>();
  private visibility = new Map<string, Map<string, "hidden" | "shown">>();

  constructor(options: NftControllerOptions) {
    super({ name: "nfts", defaultState: () => ({ inventories: {} }) });
    this.options = options;
    this.fetchGateway = gatewayFetch(options.fetch, options.gateway);
  }

  async init(): Promise<void> {
    this.engineStore = await this.options.openStore();
    const raw = await this.engineStore.collection(COLLECTION).get(VISIBILITY_KEY);
    const stored = raw === undefined ? undefined : parseWith(storedVisibility, readJson(raw));
    if (raw !== undefined && stored === undefined) {
      this.options.logger.warn("ignoring a malformed stored NFT visibility row");
    }
    this.visibility = new Map(
      Object.entries(stored ?? {}).map(([network, rows]) => [
        network,
        new Map(Object.entries(rows)),
      ]),
    );
    this.active = true;
    this.unsubscribes = [
      this.options.onActivityChange(() => {
        this.rebuild();
      }),
      this.options.onConfirmed((tx) => {
        // oxlint-disable-next-line promise/prefer-await-to-then -- listeners are synchronous
        void this.reRead(tx).catch((error: unknown) => {
          this.options.logger.warn("NFT post-inclusion re-read failed", error);
        });
      }),
    ];
    if (this.visible) {
      this.armPoll();
      this.refreshAll();
    }
  }

  lock(): void {
    this.active = false;
    this.epoch += 1;
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes = [];
    for (const abort of this.aborts) {
      abort();
    }
    this.aborts.clear();
    this.inflight.clear();
    this.facts.clear();
    this.visibility = new Map();
    this.engineStore = undefined;
    this.update(() => ({ inventories: {} }));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  /** Visible: refresh every loaded inventory now, then every {@link NFT_POLL_MS}. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.cancelPoll?.();
      this.cancelPoll = undefined;
      return;
    }
    if (this.active && this.cancelPoll === undefined) {
      this.armPoll();
      this.refreshAll();
    }
  }

  /** Fetches page 1 of `owner`'s inventory on `network`, replacing it. */
  async load(owner: string, network: string): Promise<NftInventory> {
    const address = this.address(network, owner);
    return this.singleFlight(network, address, async (key) => {
      const { epoch } = this;
      const page = await this.requestPage(network, address, undefined);
      if (epoch !== this.epoch) {
        return this.getState().inventories[key] ?? emptyInventory(network, address);
      }
      if (!page.ok) {
        this.fail(key, page.failure);
        return this.must(key, network, address);
      }
      this.apply({
        key,
        network,
        owner: address,
        list: this.sanitised(network, page.value.items),
        cursor: page.value.cursor,
        pages: 1,
        truncated: false,
      });
      return this.must(key, network, address);
    });
  }

  /** Fetches the inventory's next page and appends its new items. */
  async loadMore(owner: string, network: string): Promise<NftInventory> {
    const address = this.address(network, owner);
    const key = `${network}:${address}`;
    const current = this.getState().inventories[key];
    if (current === undefined) {
      return this.load(owner, network);
    }
    if (current.cursor === null || current.pages >= NFT_INVENTORY_MAX_PAGES) {
      return current;
    }
    return this.singleFlight(network, address, async () => {
      const { cursor, pages } = this.getState().inventories[key] ?? current;
      if (cursor === null || pages >= NFT_INVENTORY_MAX_PAGES) {
        return this.getState().inventories[key] ?? current;
      }
      const { epoch } = this;
      const page = await this.requestPage(network, address, cursor);
      if (epoch !== this.epoch) {
        return this.getState().inventories[key] ?? emptyInventory(network, address);
      }
      const prior = this.facts.get(key) ?? [];
      if (!page.ok) {
        this.fail(key, page.failure);
        return this.must(key, network, address);
      }
      const seen = new Set(prior.map((item) => item.id));
      const next = this.sanitised(network, page.value.items).filter((item) => {
        if (seen.has(item.id)) {
          return false;
        }
        seen.add(item.id);
        return true;
      });
      const grown = pages + 1;
      const nextCursor = grown >= NFT_INVENTORY_MAX_PAGES ? null : page.value.cursor;
      this.apply({
        key,
        network,
        owner: address,
        list: [...prior, ...next],
        cursor: nextCursor,
        pages: grown,
        truncated: grown >= NFT_INVENTORY_MAX_PAGES && page.value.cursor !== null,
      });
      return this.must(key, network, address);
    });
  }

  /**
   * Refetches pages 1..`pages` of every inventory `owner` has on `network`, replacing its items
   * only when every page answers. A failed page keeps the items already shown.
   */
  async refresh(owner: string, network: string): Promise<NftInventory> {
    const address = this.address(network, owner);
    return this.singleFlight(network, address, async (key) => {
      const wanted = Math.max(1, this.getState().inventories[key]?.pages ?? 1);
      const { epoch } = this;
      const items: NftItem[] = [];
      // oxlint-disable-next-line typescript/no-restricted-types -- a page answer's cursor is null
      let cursor: string | null = null;
      for (let page = 0; page < wanted; page += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a page's cursor reads the previous page
        const answer = await this.requestPage(network, address, cursor ?? undefined);
        if (epoch !== this.epoch) {
          return this.getState().inventories[key] ?? emptyInventory(network, address);
        }
        if (!answer.ok) {
          this.fail(key, answer.failure);
          return this.must(key, network, address);
        }
        const { items: pageItems, cursor: nextCursor } = answer.value;
        items.push(...pageItems);
        cursor = nextCursor;
      }
      if (epoch !== this.epoch) {
        return this.getState().inventories[key] ?? emptyInventory(network, address);
      }
      this.apply({
        key,
        network,
        owner: address,
        list: this.sanitised(network, items),
        cursor,
        pages: wanted,
        truncated: wanted >= NFT_INVENTORY_MAX_PAGES && cursor !== null,
      });
      return this.must(key, network, address);
    });
  }

  /**
   * The item's full gateway record — description, attributes, external URL — sanitised the same way
   * inventory items are. The answer must name the asked contract and tokenId.
   */
  async detail(
    network: string,
    contract: string,
    tokenId?: string,
  ): Promise<NftResult<NftDetailView>> {
    const { family } = this.options.networks.info(network);
    if (family === "evm" && (tokenId === undefined || !/^(0|[1-9][0-9]*)$/.test(tokenId))) {
      throw new TypeError("an EVM NFT detail needs a decimal tokenId");
    }
    if (family !== "evm" && tokenId !== undefined) {
      throw new TypeError(`network ${network} NFTs have no tokenId`);
    }
    const address = this.address(network, contract);
    const answer = await this.request(
      nftItemPath(network),
      tokenId === undefined ? { contract: address } : { contract: address, tokenId },
    );
    if (!answer.ok) {
      return answer;
    }
    const parsed = parseWith(nftDetail, answer.value);
    const item = parsed?.item;
    if (
      parsed === undefined ||
      item === undefined ||
      !nftItemFits(network, item) ||
      item.contract !== address ||
      (family === "evm" && item.tokenId !== tokenId)
    ) {
      return { ok: false, failure: "invalid-response" };
    }
    const detail: NftDetail = parsed;
    const { facts, description, attributes, externalUrl } = sanitizeDetail(network, detail);
    return {
      ok: true,
      value: {
        item: this.viewOf(facts),
        ...(description === undefined ? {} : { description }),
        attributes,
        ...(externalUrl === undefined ? {} : { externalUrl }),
      },
    };
  }

  /** The collection's gateway descriptor, sanitised. */
  async collection(network: string, id: string): Promise<NftResult<NftCollectionView>> {
    const address = this.address(network, id);
    const answer = await this.request(nftCollectionPath(network), { collection: address });
    if (!answer.ok) {
      return answer;
    }
    const parsed = parseWith(nftCollectionResponse, answer.value);
    const collection: NftCollection | undefined =
      parsed === undefined || !nftCollectionFits(network, parsed) || parsed.id !== address
        ? undefined
        : parsed;
    if (collection === undefined) {
      return { ok: false, failure: "invalid-response" };
    }
    return { ok: true, value: sanitizeCollection(collection) };
  }

  /** Marketplace floor quotes for a collection — schema only, no fit rule exists for floors. */
  async floor(network: string, id: string): Promise<NftResult<ReadonlyArray<NftFloorView>>> {
    const address = this.address(network, id);
    const answer = await this.request(nftFloorPath(network), { collection: address });
    if (!answer.ok) {
      return answer;
    }
    const parsed = parseWith(nftFloorResponse, answer.value);
    if (parsed === undefined) {
      return { ok: false, failure: "invalid-response" };
    }
    return {
      ok: true,
      value: parsed.floors.map((floor): NftFloorView => ({
        marketplace: floor.marketplace,
        amount: floor.amount,
        currency: floor.currency,
        retrievedAt: floor.retrievedAt,
      })),
    };
  }

  /**
   * `hidden` hides the item, `shown` pins it over its spam verdicts, `undefined` clears the
   * override. The whole override map persists under one row per unlock.
   */
  async setHidden(
    network: string,
    id: string,
    verdict: "hidden" | "shown" | undefined,
  ): Promise<void> {
    const rows = this.visibility.get(network) ?? new Map<string, "hidden" | "shown">();
    if (verdict === undefined) {
      rows.delete(id);
    } else {
      rows.set(id, verdict);
    }
    if (rows.size === 0) {
      this.visibility.delete(network);
    } else {
      this.visibility.set(network, rows);
    }
    await this.persist();
    this.rebuild();
  }

  /**
   * Read-only view of the UTXOs the spend path already protects; no new read. `network` must be a
   * Bitcoin network — inscription-bearing UTXOs exist only there.
   */
  inscriptions(
    group: { readonly walletId: string; readonly groupIndex: number },
    network: string,
  ): ReadonlyArray<BitcoinUtxoView> {
    if (this.options.networks.info(network).family !== "bitcoin") {
      throw new TypeError(`inscriptions exist only on Bitcoin networks, not ${network}`);
    }
    const balances = this.options.balances()[`${network}:${group.walletId}:${group.groupIndex}`];
    return (balances?.utxos ?? []).filter((utxo) => utxo.protected);
  }

  private address(network: string, value: string): string {
    const { family } = this.options.networks.info(network);
    if (family === "evm") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new TypeError(`invalid EVM address ${value}`);
      }
      return value.toLowerCase();
    }
    if (family === "solana") {
      if (!nftAddressFits(network, value)) {
        throw new TypeError(`invalid Solana address ${value}`);
      }
      return value;
    }
    throw new TypeError(`network ${network} has no NFT inventory`);
  }

  private async request(path: string, body: Record<string, string>): Promise<NftResult<unknown>> {
    const { gateway } = this.options;
    if (gateway === undefined) {
      return { ok: false, failure: "no-gateway" };
    }
    const bound = timeoutSignal(FETCH_TIMEOUT_MS, this.options.setTimer);
    this.aborts.add(bound.abort);
    try {
      const response = await this.fetchGateway(`${gateway.url.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: bound.signal,
      });
      if (response.status === 429) {
        return { ok: false, failure: "rate-limited" };
      }
      if (response.status === 404) {
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = obj(await response.json());
        } catch {
          parsed = undefined;
        }
        return {
          ok: false,
          failure:
            parsed?.["error"] === "unsupported"
              ? "unsupported"
              : parsed?.["error"] === "not-found"
                ? "not-found"
                : "unavailable",
        };
      }
      if (!response.ok) {
        return { ok: false, failure: "unavailable" };
      }
      try {
        return { ok: true, value: await response.json() };
      } catch {
        return { ok: false, failure: "invalid-response" };
      }
    } catch {
      return { ok: false, failure: "unavailable" };
    } finally {
      bound.cancel();
      this.aborts.delete(bound.abort);
    }
  }

  private async requestPage(
    network: string,
    owner: string,
    cursor: string | undefined,
  ): Promise<NftResult<NftPage>> {
    const answer = await this.request(
      nftItemsPath(network),
      cursor === undefined ? { owner } : { owner, cursor },
    );
    if (!answer.ok) {
      return answer;
    }
    const parsed = parseWith(nftPage, answer.value);
    if (parsed === undefined || !nftPageFits(network, parsed)) {
      return { ok: false, failure: "invalid-response" };
    }
    return { ok: true, value: parsed };
  }

  /** One in-flight fetch per inventory key — a second caller joins the same answer. */
  private async singleFlight(
    network: string,
    owner: string,
    run: (key: string) => Promise<NftInventory>,
  ): Promise<NftInventory> {
    const key = `${network}:${owner}`;
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      return existing;
    }
    this.update((state) => ({
      inventories: {
        ...state.inventories,
        [key]: {
          ...(state.inventories[key] ?? emptyInventory(network, owner)),
          loading: true,
          failure: null,
        },
      },
    }));
    const flying = (async (): Promise<NftInventory> => {
      try {
        return await run(key);
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, flying);
    return flying;
  }

  private sanitised(network: string, items: ReadonlyArray<NftItem>): NftItemFacts[] {
    const seen = new Set<string>();
    const out: NftItemFacts[] = [];
    for (const item of items) {
      const facts = sanitizeItem(network, item);
      if (!seen.has(facts.id)) {
        seen.add(facts.id);
        out.push(facts);
      }
    }
    return out;
  }

  private viewOf(facts: NftItemFacts): NftView {
    const [view] = this.views([facts]);
    if (view === undefined) {
      throw new Error("views map one-to-one");
    }
    return view;
  }

  private views(list: ReadonlyArray<NftItemFacts>): NftView[] {
    const { entries, txs } = this.options.activity();
    const spam = nftSpam(list, {
      acquisition: (item) =>
        nftAcquisition(item.network, item.contract, item.tokenId, entries, txs),
      shown: (item) => this.visibility.get(item.network)?.get(item.id) === "shown",
    });
    return list.map((facts) => {
      const { gatewaySpam: _, deceptive: __, ...rest } = facts;
      const reasons = spam.get(facts.id) ?? [];
      const verdict = this.visibility.get(facts.network)?.get(facts.id);
      return {
        ...rest,
        spam: reasons,
        hidden: verdict === "hidden" || (verdict !== "shown" && reasons.length > 0),
      };
    });
  }

  private apply(args: {
    readonly key: string;
    readonly network: string;
    readonly owner: string;
    readonly list: NftItemFacts[];
    // oxlint-disable-next-line typescript/no-restricted-types -- a page answer's cursor is null
    readonly cursor: string | null;
    readonly pages: number;
    readonly truncated: boolean;
  }): void {
    this.facts.set(args.key, args.list);
    const items = this.views(args.list);
    this.update((state) => ({
      inventories: {
        ...state.inventories,
        [args.key]: {
          ...emptyInventory(args.network, args.owner),
          items,
          cursor: args.cursor,
          pages: args.pages,
          truncated: args.truncated,
          failure: null,
          updatedAt: this.options.now(),
        },
      },
    }));
  }

  /**
   * A failed read keeps the whole inventory as it was — items, cursor, pages, truncated, updatedAt
   * — and only records the failure and clears `loading`, so `loadMore` still resumes.
   */
  private fail(key: string, failure: NftFailure): void {
    this.update((state) => {
      const existing = state.inventories[key];
      if (existing === undefined) {
        return state;
      }
      return {
        inventories: {
          ...state.inventories,
          [key]: { ...existing, loading: false, failure },
        },
      };
    });
  }

  /** Rebuilds every view from its facts — activity and visibility verdicts change outside fetch. */
  private rebuild(): void {
    this.update((state) => ({
      inventories: Object.fromEntries(
        Object.entries(state.inventories).map(([key, inventory]) => {
          const list = this.facts.get(key) ?? [];
          return [key, { ...inventory, items: this.views(list) }];
        }),
      ),
    }));
  }

  private must(key: string, network: string, owner: string): NftInventory {
    return this.getState().inventories[key] ?? emptyInventory(network, owner);
  }

  private refreshAll(): void {
    for (const inventory of Object.values(this.getState().inventories)) {
      // oxlint-disable-next-line promise/prefer-await-to-then -- inventories refresh concurrently
      this.refresh(inventory.owner, inventory.network).catch((error: unknown) => {
        this.options.logger.warn("NFT refresh failed", error);
      });
    }
  }

  private armPoll(): void {
    this.cancelPoll = repeat(
      this.options.setTimer,
      NFT_POLL_MS,
      () => {
        this.refreshAll();
      },
      (error) => {
        this.options.logger.warn("NFT refresh failed", error);
      },
    );
  }

  /**
   * The post-inclusion re-read: a confirmed send's named items are re-read on chain and a zero
   * balance drops the item. A failed read keeps it — a display-only item is cheaper than a lost
   * record — and logs. The gateway is never consulted here.
   */
  private async reRead(tx: TrackedTransaction): Promise<void> {
    const { intent } = tx;
    if (intent === undefined) {
      return;
    }
    const { family } = this.options.networks.info(tx.network);
    const norm = (asset: string): string => (family === "evm" ? asset.toLowerCase() : asset);
    const named = new Map<string, Set<string | undefined>>();
    for (const flow of intent.outflows) {
      const ids = named.get(norm(flow.amount.asset)) ?? new Set<string | undefined>();
      ids.add(flow.amount.tokenId);
      named.set(norm(flow.amount.asset), ids);
    }
    if (named.size === 0) {
      return;
    }
    const { epoch } = this;
    const results = new Map<string, Map<string, bigint | "keep">>();
    for (const [key, list] of this.facts) {
      const inventory = this.getState().inventories[key];
      if (inventory === undefined || inventory.network !== tx.network) {
        continue;
      }
      const outcomes = new Map<string, bigint | "keep">();
      for (const item of list) {
        const tokenIds = named.get(norm(item.contract));
        const match =
          tokenIds !== undefined &&
          (family !== "evm" || [...tokenIds].some((id) => id === item.tokenId));
        if (!match) {
          continue;
        }
        let outcome: bigint | "keep" = "keep";
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- each read waits on the last, one RPC's pacing
          outcome = await this.chainBalance(family, tx.network, item, inventory.owner);
        } catch (error) {
          this.options.logger.warn("NFT chain balance read failed", error);
        }
        outcomes.set(item.id, outcome);
      }
      if (outcomes.size > 0) {
        results.set(key, outcomes);
      }
    }
    // The reads took time; a lock or a state turnover since the collect invalidates them.
    if (epoch !== this.epoch) {
      return;
    }
    this.applyReRead(results);
  }

  private applyReRead(results: ReadonlyMap<string, ReadonlyMap<string, bigint | "keep">>): void {
    for (const [key, outcomes] of results) {
      const inventory = this.getState().inventories[key];
      if (inventory === undefined) {
        continue;
      }
      const list = this.facts.get(key) ?? [];
      const kept = list.flatMap((item) => {
        const outcome = outcomes.get(item.id);
        if (outcome === undefined || outcome === "keep") {
          return [item];
        }
        return outcome > 0n ? [{ ...item, balance: outcome.toString(10) }] : [];
      });
      this.facts.set(key, kept);
      this.update((state) => ({
        inventories: {
          ...state.inventories,
          [key]: { ...inventory, items: this.views(kept) },
        },
      }));
    }
  }

  /** One item's balance on chain: ERC-721's ownerOf / ERC-1155's balanceOf, or the Solana read. */
  private async chainBalance(
    family: string,
    network: string,
    item: NftItemFacts,
    owner: string,
  ): Promise<bigint> {
    if (family === "evm" && item.tokenId !== undefined) {
      return evmNftBalance(
        this.options.networks.client(network),
        item.contract,
        BigInt(item.tokenId),
        owner,
      );
    }
    if (family === "solana") {
      return solanaNftBalance(this.options.networks.solanaRpc(network), item.contract, owner);
    }
    return 0n;
  }

  private async persist(): Promise<void> {
    const store = this.engineStore;
    if (store === undefined) {
      return;
    }
    const record = Object.fromEntries(
      [...this.visibility].map(([network, rows]) => [network, Object.fromEntries(rows)]),
    );
    try {
      await store
        .collection(COLLECTION)
        .put(VISIBILITY_KEY, new TextEncoder().encode(JSON.stringify(record)));
    } catch (error) {
      this.options.logger.warn("NFT visibility could not be saved", error);
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);
