/**
 * HistoryController: first-page load merges every source's streams, folds tracked sends in,
 * persists a bounded cache, isolates groups, survives a source error, pages with loadMore and
 * clears on lock.
 */
import { describe, expect, it } from "vite-plus/test";

import { HistoryController } from "../src/history/controller.ts";
import type { HistoryState } from "../src/history/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OWNER2 = "0x70A65731F328d3e24Be8abc0dBd0bDa2e46bDf8B";
const OTHER = "0xfa5180956e87bff2d1fce8423d2e755846ac3b24";
// Same first/last four characters as OTHER — the address-poisoning lookalike shape.
const LOOKALIKE = `0xfa51${"0".repeat(32)}3b24`;
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const GROUP = { walletId: "w", groupIndex: 0 } as const;
const GROUP2 = { walletId: "w", groupIndex: 1 } as const;

const hash = (byte: string) => `0x${byte.repeat(32)}`;

const item = (h: string, block: number, timestamp: number, amount = "700") => ({
  hash: h,
  block: String(block),
  timestamp,
  transfers: [
    {
      kind: "internal",
      from: OTHER,
      to: OWNER,
      contract: null,
      tokenId: null,
      amount,
      decimals: null,
      symbol: null,
      logIndex: null,
    },
  ],
});

const receipt = (block: number) => ({
  blockNumber: `0x${block.toString(16)}`,
  status: "0x1",
  from: OTHER,
  to: OWNER,
  gasUsed: "0x1",
  effectiveGasPrice: "0x1",
  logs: [],
});

type Rig = {
  readonly controller: HistoryController;
  readonly store: EngineStore;
  readonly requests: Array<Record<string, unknown>>;
  readonly setTxs: (txs: Record<string, unknown>) => void;
  /** Resolves every gateway response currently deferred for `deferredAddresses`. */
  readonly respond: () => void;
  /** Resolves once a deferred gateway request is actually in flight. */
  readonly waitForPending: () => Promise<void>;
  readonly getTxs: () => unknown;
  readonly getBook: () => unknown;
};

const make = (options: {
  readonly page?: unknown;
  readonly pages?: ReadonlyArray<unknown>;
  readonly txs?: Record<string, unknown>;
  readonly book?: Record<string, unknown>;
  readonly solana?: boolean;
  readonly solanaRpc?: { readonly call: (method: string, params: unknown[]) => Promise<unknown> };
  readonly solanaIndependent?: unknown;
  readonly evmIndependent?: "available" | "unavailable" | "not-needed";
  readonly store?: EngineStore;
  readonly failAccounts?: boolean;
  /** Gateway requests carrying one of these `address`es hang until `respond()`. */
  readonly deferredAddresses?: ReadonlyArray<string>;
}): Rig => {
  const pages = [...(options.pages ?? [options.page ?? { items: [], cursor: null }])];
  const requests: Array<Record<string, unknown>> = [];
  const pending: Array<() => void> = [];
  const waiters: Array<() => void> = [];
  let txs = options.txs ?? {};
  const bookEntries = options.book ?? {};
  const txStore = {
    getState: () => ({ txs }),
    setState: (next: { txs: Record<string, unknown> }) => {
      ({ txs } = next);
      for (const fn of subscribers) {
        fn();
      }
    },
    subscribe: (fn: () => void) => {
      subscribers.push(fn);
      return () => {};
    },
  };
  const subscribers: Array<() => void> = [];
  const bookStore = {
    getState: () => ({ entries: bookEntries }),
    subscribe: () => () => {},
  };
  const store = options.store ?? createMemoryEngineStore();
  const blockOf = new Map<string, number>(
    pages.flatMap((p) =>
      ((p as { items?: Array<{ hash: string; block: string }> }).items ?? []).map(
        (i) => [i.hash, Number(i.block)] as const,
      ),
    ),
  );
  const client = {
    transport: {
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        if (method === "eth_getTransactionByHash") {
          const block = blockOf.get(params[0] as string);
          return Promise.resolve(
            block === undefined ? null : { from: OTHER, to: OWNER, value: "0x0" },
          );
        }
        const block = blockOf.get(params[0] as string);
        return Promise.resolve(block === undefined ? null : receipt(block));
      },
    },
  };
  const solanaRpc = options.solanaRpc ?? {
    call: async () => Promise.reject(new Error("solana node down")),
  };
  const controller = new HistoryController({
    networks: {
      enabled: (family: string) =>
        family === "evm"
          ? ["eip155:1"]
          : family === "solana" && options.solana === true
            ? [SOL_NET]
            : [],
      client: () => client,
      independentClient: () =>
        options.evmIndependent === "available"
          ? { kind: "available", client }
          : { kind: options.evmIndependent ?? "unavailable" },
      independentSolanaRpc: () => options.solanaIndependent ?? { kind: "unavailable" },
      independentEsplora: () => ({ kind: "unavailable" }),
      solanaRpc: () => solanaRpc,
      esplora: () => ({ get: async () => Promise.reject(new Error("unmocked")) }),
    },
    chains: {
      account: async (params: { template: string; groupIndex: number }) =>
        options.failAccounts === true
          ? Promise.reject(new Error("chains.account down"))
          : Promise.resolve(
              params.template === "evm.bip44"
                ? { address: params.groupIndex === 0 ? OWNER : OWNER2 }
                : params.template === "solana.bip44-change"
                  ? { address: "SolOwner111111111111111111111111111111111" }
                  : { xpub: "xpub" },
            ),
    },
    spark: {
      history: async () => Promise.resolve({ items: [], nextOffset: undefined }),
      store: { getState: () => ({ accounts: {} }), subscribe: () => () => {} },
    },
    sparkNetwork: "regtest",
    transactions: { store: txStore },
    addressBook: { store: bookStore },
    gateway: {
      url: "https://gateway.test",
      fetch: (async (_input: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        const page = pages.shift() ?? { items: [], cursor: null };
        if (options.deferredAddresses?.includes(String(body["address"])) === true) {
          return new Promise<Response>((resolve) => {
            pending.push(() => {
              resolve(Response.json(page));
            });
            for (const waiter of waiters.splice(0)) {
              waiter();
            }
          });
        }
        return Promise.resolve(Response.json(page));
      }) as typeof globalThis.fetch,
    },
    openStore: async () => Promise.resolve(store),
    setTimer: () => () => {},
    now: () => 1700000000000,
    logger: { warn: () => {} },
  } as never);
  return {
    controller,
    store,
    requests,
    setTxs: (next) => {
      txStore.setState({ txs: next });
    },
    respond: () => {
      for (const release of pending.splice(0)) {
        release();
      }
    },
    waitForPending: async () =>
      pending.length > 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push(resolve);
          }),
    getTxs: () => txStore.getState(),
    getBook: () => bookStore.getState(),
  };
};

const entriesOf = (controller: HistoryController, key = "w:0") =>
  controller.getState().groups[key]?.entries ?? [];

const idsOf = (state: HistoryState, key: string): ReadonlyArray<string> =>
  state.groups[key]?.entries.map((e) => e.id) ?? [];

/** `count` pages of `size` distinct items, newest first — the last cursor null. */
const paged = (count: number, size: number) =>
  Array.from({ length: count }, (_, p) => ({
    items: Array.from({ length: size }, (_, i) => {
      const n = p * size + i;
      return item(hash(n.toString(16).padStart(2, "0")), 1_000_000 - n, 10_000_000 - n * 1000);
    }),
    cursor: p < count - 1 ? String(1_000_000 - p) : null,
  }));

const staleOf = (groups: HistoryState["groups"], key = "w:0") => groups[key]?.stale === true;

/** Resolves when `key`'s group reaches `status` — for asserting mid-flight state. */
const until = async (controller: HistoryController, key: string, status: "loading" | "ready") =>
  new Promise<void>((resolve) => {
    const unsubscribe = controller.store.subscribe((state) => {
      if (state.groups[key]?.status === status) {
        unsubscribe();
        resolve();
      }
    });
  });

const tracked = (over: {
  readonly id: string;
  readonly hash?: string;
  readonly state?: string;
  readonly submittedAt?: number;
  readonly account?: string;
}): Record<string, unknown> => ({
  id: over.id,
  family: "evm",
  network: "eip155:1",
  account: over.account ?? GROUP.walletId,
  hash: over.hash,
  state: over.state ?? "submitted",
  intent: {
    outflows: [{ to: OTHER, amount: { asset: "native", amount: "5" }, verified: true }],
  },
  nonce: 0,
  evm: { from: OWNER, account: { kind: "hd", walletId: GROUP.walletId, groupIndex: 0 } },
  submittedAt: over.submittedAt ?? 0,
  error: undefined,
});

const CHAIN_HASH = hash("ab");

const CHAIN_PAGE = {
  items: [item(CHAIN_HASH, 100, 5_000_000)],
  cursor: null,
};

/** A Solana RPC answering one owner's single confirmed transfer. */
const SOLANA_ANSWERS: Readonly<Record<string, unknown>> = {
  getTokenAccountsByOwner: { value: [] },
  getSignaturesForAddress: [{ signature: "solsig", slot: 1, blockTime: 1700000000, err: null }],
  getTransaction: {
    slot: 1,
    blockTime: 1700000000,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000, 0],
      postBalances: [995_000, 100],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: "PayerAcct11111111111111111111111111111111" },
          { pubkey: "SolOwner111111111111111111111111111111111" },
        ],
        instructions: [],
      },
    },
  },
};

const solanaRpcOf = () => ({
  call: async (method: string): Promise<unknown> =>
    method in SOLANA_ANSWERS
      ? Promise.resolve(SOLANA_ANSWERS[method])
      : Promise.reject(new Error(`unmocked ${method}`)),
});

describe("HistoryController", () => {
  it("loads the first page, sorted, verified state from the chain", async () => {
    const { controller } = make({ page: CHAIN_PAGE });
    await controller.init();
    await controller.load(GROUP);
    const group = controller.getState().groups["w:0"];
    expect(group?.status).toBe("ready");
    expect(group?.entries.map((e) => e.id)).toStrictEqual([`eip155:1:${CHAIN_HASH}`]);
    expect(group?.entries[0]?.verified).toBe(false);
    expect(group?.entries[0]?.origin).toBe("provider");
    expect(group?.hasMore).toBe(false);
    expect(group?.stale).toBe(false);
    controller.lock();
  });

  it("places a pending tracked send ahead of chain rows", async () => {
    const pendingHash = hash("cd");
    const { controller } = make({
      page: CHAIN_PAGE,
      txs: {
        local1: tracked({ id: "local1", hash: pendingHash, submittedAt: 9_000_000 }),
      },
    });
    await controller.init();
    await controller.load(GROUP);
    const entries = controller.getState().groups["w:0"]?.entries;
    expect(entries?.[0]?.id).toBe(`eip155:1:${pendingHash}`);
    expect(entries?.[0]?.origin).toBe("local");
    expect(entries?.[0]?.status).toBe("pending");
    expect(entries?.[0]?.localTxId).toBe("local1");
    controller.lock();
  });

  it("folds a tracked send into the matching chain entry with its localTxId", async () => {
    const { controller } = make({
      page: CHAIN_PAGE,
      txs: {
        local2: tracked({ id: "local2", hash: CHAIN_HASH, state: "confirmed" }),
      },
    });
    await controller.init();
    await controller.load(GROUP);
    const entries = controller.getState().groups["w:0"]?.entries;
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.localTxId).toBe("local2");
    expect(entries?.[0]?.origin).toBe("provider");
    controller.lock();
  });

  it("keeps two groups of one wallet isolated", async () => {
    const aHash = hash("aa");
    const bHash = hash("bb");
    const { controller } = make({
      pages: [
        { items: [item(aHash, 100, 5_000_000)], cursor: null },
        { items: [item(bHash, 200, 6_000_000)], cursor: null },
      ],
    });
    await controller.init();
    await controller.load(GROUP);
    await controller.load(GROUP2);
    const state = controller.getState();
    expect(state.groups["w:0"]?.entries.map((e) => e.id)).toStrictEqual([`eip155:1:${aHash}`]);
    expect(state.groups["w:1"]?.entries.map((e) => e.id)).toStrictEqual([`eip155:1:${bHash}`]);
    controller.lock();
  });

  it("clears groups on lock", async () => {
    const { controller } = make({ page: CHAIN_PAGE });
    await controller.init();
    await controller.load(GROUP);
    controller.lock();
    expect(controller.getState().groups).toStrictEqual({});
  });

  it("throws while locked, without touching state or any source", async () => {
    const { controller, requests } = make({});
    await expect(controller.load(GROUP)).rejects.toThrow("history requires an unlocked vault");
    await expect(controller.loadMore(GROUP)).rejects.toThrow("history requires an unlocked vault");
    expect(controller.getState().groups).toStrictEqual({});
    expect(requests).toHaveLength(0);
  });

  it("discards a page that lands after lock — no group, no persisted row", async () => {
    const { controller, store, respond, waitForPending } = make({
      deferredAddresses: [OWNER],
    });
    await controller.init();
    const loading = controller.load(GROUP);
    await waitForPending();
    controller.lock();
    respond();
    await loading;
    expect(controller.getState().groups).toStrictEqual({});
    const raw = await store.collection("history").get("w:0");
    expect(raw).toBeUndefined();
  });

  it("keeps a slow group's late page out of a fast group's view", async () => {
    const aHash = hash("aa");
    const bHash = hash("bb");
    const { controller, respond, waitForPending } = make({
      pages: [
        { items: [item(aHash, 100, 5_000_000)], cursor: null },
        { items: [item(bHash, 200, 6_000_000)], cursor: null },
      ],
      deferredAddresses: [OWNER],
    });
    await controller.init();
    const seen: Array<ReadonlyArray<string>> = [];
    controller.store.subscribe((state) => {
      seen.push(idsOf(state, "w:1"));
    });
    const slow = controller.load(GROUP);
    await waitForPending();
    await controller.load(GROUP2);
    respond();
    await slow;
    const aId = `eip155:1:${aHash}`;
    for (const ids of seen) {
      expect(ids).not.toContain(aId);
    }
    expect(controller.getState().groups["w:0"]?.entries.map((e) => e.id)).toStrictEqual([aId]);
    expect(controller.getState().groups["w:1"]?.entries.map((e) => e.id)).toStrictEqual([
      `eip155:1:${bHash}`,
    ]);
    controller.lock();
  });

  it("reports a failing source in errors while the rest still load", async () => {
    const { controller } = make({ page: CHAIN_PAGE, solana: true });
    await controller.init();
    await controller.load(GROUP);
    const group = controller.getState().groups["w:0"];
    expect(group?.entries).toHaveLength(1);
    expect(group?.errors[SOL_NET]).toContain("solana node down");
    controller.lock();
  });

  it("verifies a fully checkable claim only when the check ran on a host endpoint", async () => {
    const nativePage = {
      items: [
        {
          hash: hash("ab"),
          block: "100",
          timestamp: 1700000000000,
          transfers: [
            {
              kind: "native",
              from: OTHER,
              to: OWNER,
              contract: null,
              tokenId: null,
              amount: "0",
              decimals: null,
              symbol: null,
              logIndex: null,
            },
          ],
        },
      ],
      cursor: null,
    };
    const trusted = make({ page: nativePage, evmIndependent: "available" });
    await trusted.controller.init();
    await trusted.controller.load(GROUP);
    expect(trusted.controller.getState().groups["w:0"]?.entries[0]?.verified).toBe(true);
    trusted.controller.lock();

    const untrusted = make({ page: nativePage });
    await untrusted.controller.init();
    await untrusted.controller.load(GROUP);
    expect(untrusted.controller.getState().groups["w:0"]?.entries[0]?.verified).toBe(false);
    untrusted.controller.lock();
  });

  it("verifies a solana entry only when the read went to a host endpoint", async () => {
    const untrusted = make({ solana: true, solanaRpc: solanaRpcOf() });
    await untrusted.controller.init();
    await untrusted.controller.load(GROUP);
    const viaGateway = untrusted.controller
      .getState()
      .groups["w:0"]?.entries.find((e) => e.family === "solana");
    expect(viaGateway?.verified).toBe(false);
    untrusted.controller.lock();

    const rpc = solanaRpcOf();
    const trusted = make({
      solana: true,
      solanaRpc: rpc,
      solanaIndependent: { kind: "available", client: rpc },
    });
    await trusted.controller.init();
    await trusted.controller.load(GROUP);
    const viaHost = trusted.controller
      .getState()
      .groups["w:0"]?.entries.find((e) => e.family === "solana");
    expect(viaHost?.verified).toBe(true);
    trusted.controller.lock();
  });

  it("loadMore appends older entries, preserving the first-page prefix", async () => {
    const firstItems = Array.from({ length: 30 }, (_, i) =>
      item(`0x${(i + 1).toString(16).padStart(64, "0")}`, 1000 - i, 1_000_000 - i * 1000),
    );
    const secondItems = [item(hash("ef"), 5, 100)];
    const { controller, requests } = make({
      pages: [
        { items: firstItems, cursor: "900" },
        { items: secondItems, cursor: null },
      ],
    });
    await controller.init();
    await controller.load(GROUP);
    const before = entriesOf(controller);
    expect(before).toHaveLength(25);
    await controller.loadMore(GROUP);
    const after = entriesOf(controller);
    expect(after.length).toBeGreaterThan(25);
    expect(after.slice(0, 25).map((e) => e.id)).toStrictEqual(before.map((e) => e.id));
    expect(requests.some((r) => r["cursor"] === "900")).toBe(true);
    controller.lock();
  });

  it("persists a bounded non-local cache and shows it stale on the next load", async () => {
    const store = createMemoryEngineStore();
    const first = make({ page: CHAIN_PAGE, store });
    await first.controller.init();
    await first.controller.load(GROUP);
    const raw = await store.collection("history").get("w:0");
    expect(raw).toBeDefined();
    const persisted = JSON.parse(new TextDecoder().decode(raw)) as {
      entries: Array<{ id: string; origin: string }>;
    };
    expect(persisted.entries.map((e) => e.id)).toStrictEqual([`eip155:1:${CHAIN_HASH}`]);
    expect(persisted.entries.every((e) => e.origin !== "local")).toBe(true);

    const second = make({ page: CHAIN_PAGE, store });
    await second.controller.init();
    const seen: Array<HistoryState["groups"]> = [];
    second.controller.store.subscribe((state) => {
      seen.push(state.groups);
    });
    await second.controller.load(GROUP);
    expect(seen.some((groups) => staleOf(groups))).toBe(true);
    expect(second.controller.getState().groups["w:0"]?.stale).toBe(false);
    second.controller.lock();
  });

  it("persists only the newest 200 entries, in emission order", async () => {
    const { controller, store } = make({ pages: paged(10, 25) });
    await controller.init();
    await controller.load(GROUP);
    for (let page = 0; page < 9; page += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- pages must land in order.
      await controller.loadMore(GROUP);
    }
    expect(entriesOf(controller)).toHaveLength(250);
    const raw = await store.collection("history").get("w:0");
    expect(raw).toBeDefined();
    const persisted = JSON.parse(new TextDecoder().decode(raw)) as {
      entries: Array<{ id: string }>;
    };
    expect(persisted.entries.map((e) => e.id)).toStrictEqual(
      Array.from({ length: 200 }, (_, n) => `eip155:1:${hash(n.toString(16).padStart(2, "0"))}`),
    );
    controller.lock();
  });

  it("keeps the persisted view while a fresh page is in flight and locals move", async () => {
    const store = createMemoryEngineStore();
    const persistedEntry = {
      id: `eip155:1:${hash("ee")}`,
      family: "evm",
      network: "eip155:1",
      hash: hash("ee"),
      direction: "in",
      counterparties: [OTHER],
      changes: [],
      status: "confirmed",
      timestamp: 1_000_000,
      verified: false,
      origin: "provider",
      flags: [],
    };
    await store
      .collection("history")
      .put("w:0", new TextEncoder().encode(JSON.stringify({ entries: [persistedEntry] })));
    const { controller, setTxs, respond, waitForPending } = make({
      deferredAddresses: [OWNER],
      store,
    });
    await controller.init();
    const loading = controller.load(GROUP);
    await until(controller, "w:0", "loading");
    await waitForPending();
    // A transactions-store emission mid-load recomposes the group — the cached row must stay.
    setTxs({ local1: tracked({ id: "local1", hash: hash("cd"), submittedAt: 9_000_000 }) });
    expect(entriesOf(controller).map((e) => e.id)).toContain(`eip155:1:${hash("ee")}`);
    respond();
    await loading;
    expect(controller.getState().groups["w:0"]?.status).toBe("ready");
    controller.lock();
  });

  it("ends a load ready with errors.accounts when chains.account fails", async () => {
    const { controller } = make({ page: CHAIN_PAGE, failAccounts: true });
    await controller.init();
    await controller.load(GROUP);
    const group = controller.getState().groups["w:0"];
    expect(group?.status).toBe("ready");
    expect(group?.errors["accounts"]).toBeDefined();
    controller.lock();
  });

  it("flags a lookalike counterparty and a zero-value transfer without touching the source stores", async () => {
    const { controller, getTxs, getBook } = make({
      book: {
        e1: {
          id: "e1",
          name: "mate",
          family: "evm",
          address: OTHER,
          createdAt: 0,
          updatedAt: 0,
        },
      },
      page: {
        items: [
          {
            hash: hash("aa"),
            block: "100",
            timestamp: 5_000_000,
            transfers: [
              {
                kind: "erc20",
                from: LOOKALIKE,
                to: OWNER,
                contract: "0x9999999999999999999999999999999999999999",
                tokenId: null,
                amount: "0",
                decimals: 6,
                symbol: null,
                logIndex: null,
              },
            ],
          },
        ],
        cursor: null,
      },
    });
    await controller.init();
    const txsBefore = getTxs();
    const bookBefore = getBook();
    await controller.load(GROUP);
    const flags = controller.getState().groups["w:0"]?.entries[0]?.flags;
    expect(flags).toContain("lookalike-counterparty");
    expect(flags).toContain("zero-value-transfer");
    expect(getTxs()).toStrictEqual(txsBefore);
    expect(getBook()).toStrictEqual(bookBefore);
    controller.lock();
  });
});
