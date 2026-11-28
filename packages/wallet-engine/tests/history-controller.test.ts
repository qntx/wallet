/**
 * HistoryController: first-page load merges every source's streams, folds tracked sends in,
 * persists a bounded cache, isolates groups, survives a source error, pages with loadMore and
 * clears on lock.
 */
import { HDKey } from "@scure/bip32";
import { NETWORK, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import { tronAddressFromHex, tronAddressToHex } from "@qntx/wallet-chains/tron";

import { scripthash } from "../src/chains/bitcoin-scan.ts";
import { HistoryController } from "../src/history/controller.ts";
import type { HistoryState } from "../src/history/controller.ts";
import type { SignersState } from "../src/signers/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OWNER2 = "0x70A65731F328d3e24Be8abc0dBd0bDa2e46bDf8B";
const OTHER = "0xfa5180956e87bff2d1fce8423d2e755846ac3b24";
// Same first/last four characters as OTHER — the address-poisoning lookalike shape.
const LOOKALIKE = `0xfa51${"0".repeat(32)}3b24`;
// Same first/last four characters as OWNER2 — a lookalike of the second group's address.
const LOOKALIKE2 = `0x70a6${"0".repeat(32)}df8b`;
// Same first/last four hex characters as OWNER — a book contact the own address imitates.
const LOOKALIKE_OWNER = `0xd8da${"0".repeat(32)}6045`;
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON_NET = "tron:728126428";
const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
const TRON_OWNER = tronAddressFromHex(`41${"2".repeat(40)}`);
const GROUP = { walletId: "w", groupIndex: 0 } as const;
const GROUP2 = { walletId: "w", groupIndex: 1 } as const;

const hash = (byte: string) => `0x${byte.repeat(32)}`;

/** The first/last four characters of `address` kept, middle zeroed — the lookalike shape. */
const lookalikeOf = (address: string): string => {
  const prefix = address.toLowerCase().startsWith("0x") ? 2 : 0;
  const middle = Math.max(0, address.length - prefix - 8);
  return `${address.slice(0, prefix + 4)}${"0".repeat(middle)}${address.slice(-4)}`;
};

const BTC_ROOT = HDKey.fromMasterSeed(new Uint8Array(64).fill(3));
const BTC_ACCOUNTS: Record<BitcoinAccountTemplate, HDKey> = {
  "btc.bip44": BTC_ROOT.derive("m/44'/0'/0'"),
  "btc.bip49": BTC_ROOT.derive("m/49'/0'/0'"),
  "btc.bip84": BTC_ROOT.derive("m/84'/0'/0'"),
  "btc.bip86": BTC_ROOT.derive("m/86'/0'/0'"),
};

const btcAddress = (template: BitcoinAccountTemplate, chain: 0 | 1, index: number): string => {
  const pub = BTC_ACCOUNTS[template].derive(`m/${chain}/${index}`).publicKey;
  if (pub === null) {
    throw new Error("no public key");
  }
  const address =
    template === "btc.bip44"
      ? p2pkh(pub, NETWORK).address
      : template === "btc.bip49"
        ? p2sh(p2wpkh(pub, NETWORK), NETWORK).address
        : template === "btc.bip84"
          ? p2wpkh(pub, NETWORK).address
          : p2tr(pub.subarray(1), undefined, NETWORK).address;
  if (address === undefined) {
    throw new Error("could not encode the derived address");
  }
  return address;
};

/**
 * Esplora fake: every derived address scans empty except `funded` scripthashes, which answer the
 * given `/txs` page. Same shape as the history-bitcoin rig's fake.
 */
const esploraOf = (funded: ReadonlyMap<string, ReadonlyArray<unknown>>) => ({
  get: async (path: string): Promise<unknown> => {
    const txs = /^\/scripthash\/([0-9a-f]+)\/txs$/.exec(path);
    if (txs !== null) {
      return Promise.resolve(funded.get(txs[1] ?? "") ?? []);
    }
    const utxo = /^\/scripthash\/([0-9a-f]+)\/utxo$/.exec(path);
    if (utxo !== null) {
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unmocked ${path}`));
  },
});

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
  readonly signersStore: StoreApi<SignersState>;
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
  /** The value the `eth_getTransactionByHash` answer carries; "0x0" when unset. */
  readonly txValue?: string;
  readonly store?: EngineStore;
  readonly failAccounts?: boolean;
  /** Groups whose `chains.account` entry reports `confirmed: false` — a key never device-shown. */
  readonly unconfirmedGroups?: ReadonlyArray<number>;
  /** Templates whose `chains.account` entry reports `confirmed: false` — same, per family. */
  readonly unconfirmedTemplates?: ReadonlyArray<string>;
  /** Mutable `confirmed` — read on every `chains.account` call; a verification flips it. */
  readonly confirmed?: { current: boolean };
  /** Enables the tron indexer feed; `transactions`/`trc20` rows answer the matching feed path. */
  readonly tronData?: {
    readonly transactions?: ReadonlyArray<unknown>;
    readonly trc20?: ReadonlyArray<unknown>;
  };
  /** Enables the bitcoin stream: account answers real xpubs, esplora serves the scripted pages. */
  readonly bitcoin?: {
    readonly account?: (params: {
      template: string;
      groupIndex: number;
      network: string;
    }) => Promise<unknown>;
    readonly esplora?: { readonly get: (path: string) => Promise<unknown> };
  };
  /** Gateway requests carrying one of these `address`es hang until `respond()`. */
  readonly deferredAddresses?: ReadonlyArray<string>;
}): Rig => {
  const pages = [...(options.pages ?? [options.page ?? { items: [], cursor: null }])];
  const requests: Array<Record<string, unknown>> = [];
  const pending: Array<() => void> = [];
  const waiters: Array<() => void> = [];
  let txs = options.txs ?? {};
  const bookEntries = options.book ?? {};
  const signersStore = createStore<SignersState>(() => ({ active: null, confirmations: 0 }));
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
        if (method === "eth_getCode") {
          return Promise.resolve("0x");
        }
        if (method === "eth_getTransactionByHash") {
          const block = blockOf.get(params[0] as string);
          return Promise.resolve(
            block === undefined
              ? null
              : { from: OTHER, to: OWNER, value: options.txValue ?? "0x0" },
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
            : family === "tron" && options.tronData !== undefined
              ? [TRON_NET]
              : family === "bitcoin" && options.bitcoin !== undefined
                ? [BTC_NET]
                : [],
      client: () => client,
      gatewayFirst: () => options.evmIndependent !== "not-needed",
      independentClient: () =>
        options.evmIndependent === "available"
          ? { kind: "available", source: "host", client }
          : { kind: options.evmIndependent ?? "unavailable" },
      independentSolanaRpc: () => options.solanaIndependent ?? { kind: "unavailable" },
      independentEsplora: () => ({ kind: "unavailable" }),
      solanaRpc: () => solanaRpc,
      tronApi: () => ({ post: async () => Promise.reject(new Error("tron node down")) }),
      independentTronApi: () => ({ kind: "unavailable" }),
      esplora: () =>
        options.bitcoin?.esplora ?? { get: async () => Promise.reject(new Error("unmocked")) },
    },
    chains: {
      account: async (params: { template: string; groupIndex: number; network: string }) => {
        if (options.failAccounts === true) {
          return Promise.reject(new Error("chains.account down"));
        }
        if (params.template.startsWith("btc.") && options.bitcoin?.account !== undefined) {
          return options.bitcoin.account(params);
        }
        const confirmed =
          options.confirmed?.current ??
          !(
            options.unconfirmedGroups?.includes(params.groupIndex) === true ||
            options.unconfirmedTemplates?.includes(params.template) === true
          );
        return Promise.resolve(
          params.template === "evm.bip44"
            ? {
                address: params.groupIndex === 0 ? OWNER : OWNER2,
                confirmed,
              }
            : params.template === "solana.bip44-change"
              ? { address: "SolOwner111111111111111111111111111111111", confirmed }
              : params.template === "tron.bip44"
                ? { address: TRON_OWNER, confirmed }
                : { xpub: "xpub", changeMark: 0, confirmed },
        );
      },
    },
    spark: {
      history: async () => Promise.resolve({ items: [], nextOffset: undefined }),
      store: { getState: () => ({ accounts: {} }), subscribe: () => () => {} },
    },
    sparkNetwork: "regtest",
    signers: { store: signersStore },
    transactions: { store: txStore },
    addressBook: { store: bookStore },
    gateway: {
      url: "https://gateway.test",
      fetch: (async (input: unknown, init?: { body?: string }) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/v1/tron/")) {
          const data = url.endsWith("/v1/accounts/transactions")
            ? (options.tronData?.transactions ?? [])
            : (options.tronData?.trc20 ?? []);
          return Promise.resolve(Response.json({ success: true, data, meta: {} }));
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        const page: Record<string, unknown> = {
          truncated: false,
          ...(pages.shift() ?? { items: [], cursor: null }),
        };
        const { status } = page;
        if (typeof status === "number") {
          return Promise.resolve(Response.json({ error: page["error"] }, { status }));
        }
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
    signersStore,
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

const flagsOf = (controller: HistoryController, key = "w:0", index = 0): ReadonlyArray<string> =>
  controller.getState().groups[key]?.entries[index]?.flags ?? [];

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
    warnings: [],
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
              amount: "5",
              decimals: null,
              symbol: null,
              logIndex: null,
            },
          ],
        },
      ],
      cursor: null,
    };
    const trusted = make({ page: nativePage, evmIndependent: "available", txValue: "0x5" });
    await trusted.controller.init();
    await trusted.controller.load(GROUP);
    expect(trusted.controller.getState().groups["w:0"]?.entries[0]?.verified).toBe(true);
    trusted.controller.lock();

    const untrusted = make({ page: nativePage, txValue: "0x5" });
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
      solanaIndependent: { kind: "available", source: "host", client: rpc },
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

  it("surfaces a truncated provider page as a gap on the group", async () => {
    const firstItems = Array.from({ length: 30 }, (_, i) =>
      item(hash((i + 1).toString(16).padStart(2, "0")), 130 - i, 1_000_000 - i * 1000),
    );
    const secondItems = [item(hash("ef"), 90, 500_000)];
    const { controller, requests } = make({
      pages: [
        { items: firstItems, cursor: "99", truncated: true },
        { items: secondItems, cursor: null, truncated: false },
      ],
    });
    await controller.init();
    await controller.load(GROUP);
    let group = controller.getState().groups["w:0"];
    expect(group?.truncated).toStrictEqual(["eip155:1"]);
    expect(group?.entries).toHaveLength(25);
    expect(group?.hasMore).toBe(true);

    await controller.loadMore(GROUP);
    // The older page was paged with the first page's cursor, exactly once.
    const second = requests.filter((r) => r["cursor"] === "99");
    expect(second).toHaveLength(1);
    group = controller.getState().groups["w:0"];
    const ids = entriesOf(controller).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(group?.entries).toHaveLength(31);
    expect(group?.hasMore).toBe(false);
    expect(group?.truncated).toStrictEqual(["eip155:1"]);

    // A fresh load whose pages carry no gaps clears the marker.
    await controller.load(GROUP);
    expect(controller.getState().groups["w:0"]?.truncated).toStrictEqual([]);
    controller.lock();
  });

  it("lists networks the gateway has no history for as unsupported — a clean load clears it", async () => {
    const { controller } = make({
      pages: [{ status: 404, error: "unsupported" }],
    });
    await controller.init();
    await controller.load(GROUP);
    const group = controller.getState().groups["w:0"];
    expect(group?.unsupported).toStrictEqual(["eip155:1"]);
    expect(group?.entries).toStrictEqual([]);
    expect(group?.hasMore).toBe(false);
    // It is coverage, not a failure: nothing lands in errors.
    expect(group?.errors).toStrictEqual({});

    // The pages queue is empty: a fresh load gets a 200 empty page and clears the marker.
    await controller.load(GROUP);
    expect(controller.getState().groups["w:0"]?.unsupported).toStrictEqual([]);
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

  it("flags a lookalike of an unconfirmed group's address — unconfirmed own stays a reference", async () => {
    const { controller } = make({
      unconfirmedGroups: [1],
      page: {
        items: [
          {
            hash: hash("bb"),
            block: "100",
            timestamp: 5_000_000,
            transfers: [
              {
                kind: "erc20",
                from: LOOKALIKE2,
                to: OWNER2,
                contract: "0x9999999999999999999999999999999999999999",
                tokenId: null,
                amount: "700",
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
    await controller.load(GROUP2);
    // The group's own key was never confirmed on the device: it never vouches for itself, but it
    // still anchors the lookalike check — the impersonating counterparty keeps its poisoning flag.
    const flags = controller.getState().groups["w:1"]?.entries[0]?.flags;
    expect(flags).toContain("lookalike-counterparty");
    controller.lock();
  });
});

describe("device-unconfirmed own addresses — the known set's two roles", () => {
  /**
   * A persisted-cache row carrying the given counterparty. On a single-address family the only way
   * an own address can sit in an entry's counterparty list is verbatim through a cache hit the
   * re-listed transaction re-emits.
   */
  const seedEntry = async (
    store: EngineStore,
    key: string,
    entry: Record<string, unknown>,
  ): Promise<void> => {
    await store.collection("history").put(
      key,
      new TextEncoder().encode(
        JSON.stringify({
          entries: [
            {
              direction: "in",
              changes: [],
              status: "confirmed",
              timestamp: 5_000_000,
              verified: true,
              origin: "provider",
              flags: [],
              ...entry,
            },
          ],
        }),
      ),
    );
  };

  it("evm: an unconfirmed own address as counterparty is flagged until confirmation reloads", async () => {
    const h = hash("bb");
    const page = { items: [item(h, 100, 5_000_000)], cursor: null };
    const store = createMemoryEngineStore();
    // The counterparty is the group's OWN evm address U — re-emitted verbatim via the cache hit.
    await seedEntry(store, "w:0", {
      id: `eip155:1:${h}`,
      family: "evm",
      network: "eip155:1",
      hash: h,
      block: 100,
      counterparties: [OWNER],
    });
    const confirmed = { current: false };
    const { controller, signersStore } = make({
      store,
      confirmed,
      book: {
        e1: {
          id: "e1",
          name: "mate",
          family: "evm",
          address: LOOKALIKE_OWNER,
          createdAt: 0,
          updatedAt: 0,
        },
      },
      pages: [page, page, page],
    });
    await controller.init();
    await controller.load(GROUP);
    // U was never confirmed on the device: it vouches for nothing — it imitates the book
    // contact, so the entry keeps the poisoning flag.
    expect(flagsOf(controller)).toContain("lookalike-counterparty");

    confirmed.current = true;
    signersStore.setState((s) => ({ confirmations: s.confirmations + 1 }));
    // The bump reloads the loaded group without an explicit load(): the fresh own exempts U.
    await until(controller, "w:0", "ready");
    expect(flagsOf(controller)).not.toContain("lookalike-counterparty");

    // An explicit reload recomputes against the fresh own the same way.
    await controller.load(GROUP);
    expect(flagsOf(controller)).not.toContain("lookalike-counterparty");
    controller.lock();
  });

  const SOLANA_OWNER = "SolOwner111111111111111111111111111111111";
  const solanaAnswers: Record<string, unknown> = {
    getTokenAccountsByOwner: { value: [] },
    getSignaturesForAddress: [
      { signature: "solsig", slot: 1, blockTime: 1_700_000_000, err: null },
    ],
    getTransaction: {
      slot: 1,
      blockTime: 1_700_000_000,
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
          accountKeys: [{ pubkey: lookalikeOf(SOLANA_OWNER) }, { pubkey: SOLANA_OWNER }],
          instructions: [
            {
              program: "system",
              programId: "11111111111111111111111111111111",
              parsed: {
                type: "transfer",
                info: {
                  source: lookalikeOf(SOLANA_OWNER),
                  destination: SOLANA_OWNER,
                  lamports: 100,
                },
              },
            },
          ],
        },
      },
    },
  };
  const solanaRpc = {
    call: async (method: string): Promise<unknown> =>
      method in solanaAnswers
        ? Promise.resolve(solanaAnswers[method])
        : Promise.reject(new Error(`unmocked ${method}`)),
  };
  const solanaLookalikeFlags = async (unconfirmed: boolean): Promise<ReadonlyArray<string>> => {
    const { controller } = make({
      solana: true,
      solanaRpc,
      unconfirmedTemplates: unconfirmed ? ["solana.bip44-change"] : [],
    });
    await controller.init();
    await controller.load(GROUP);
    const flags = entriesOf(controller).find((e) => e.family === "solana")?.flags ?? [];
    controller.lock();
    return flags;
  };

  it("solana: a lookalike of the own address is flagged both unconfirmed and confirmed", async () => {
    await expect(solanaLookalikeFlags(true)).resolves.toContain("lookalike-counterparty");
    await expect(solanaLookalikeFlags(false)).resolves.toContain("lookalike-counterparty");
  });

  const tronRow = (txid: string) => ({
    txID: txid,
    block_timestamp: 5_000_000,
    raw_data: {
      contract: [
        {
          type: "TransferContract",
          parameter: {
            value: {
              owner_address: `41${"3".repeat(40)}`,
              to_address: tronAddressToHex(TRON_OWNER),
              amount: 5,
            },
          },
        },
      ],
    },
  });
  const tronFlags = async (
    txid: string,
    counterparty: string,
    unconfirmed: boolean,
    book?: Record<string, unknown>,
  ): Promise<ReadonlyArray<string>> => {
    const store = createMemoryEngineStore();
    await seedEntry(store, "w:0", {
      id: `${TRON_NET}:${txid}`,
      family: "tron",
      network: TRON_NET,
      hash: txid,
      counterparties: [counterparty],
    });
    const { controller } = make({
      store,
      tronData: { transactions: [tronRow(txid)] },
      unconfirmedTemplates: unconfirmed ? ["tron.bip44"] : [],
      ...(book === undefined ? {} : { book }),
    });
    await controller.init();
    await controller.load(GROUP);
    const flags = flagsOf(controller);
    controller.lock();
    return flags;
  };

  it("tron: a lookalike of the own address is flagged both unconfirmed and confirmed", async () => {
    const txid = "ab".repeat(32);
    const lookalike = lookalikeOf(TRON_OWNER);
    await expect(tronFlags(txid, lookalike, true)).resolves.toContain("lookalike-counterparty");
    await expect(tronFlags(txid, lookalike, false)).resolves.toContain("lookalike-counterparty");
  });

  it("tron: the unconfirmed own address as counterparty is flagged until confirmed", async () => {
    const txid = "cd".repeat(32);
    const book = {
      e1: {
        id: "e1",
        name: "mate",
        family: "tron",
        address: lookalikeOf(TRON_OWNER),
        createdAt: 0,
        updatedAt: 0,
      },
    };
    await expect(tronFlags(txid, TRON_OWNER, true, book)).resolves.toContain(
      "lookalike-counterparty",
    );
    await expect(tronFlags(txid, TRON_OWNER, false, book)).resolves.toStrictEqual([]);
  });

  const btcTx = (txid: string, from: string, to: string) => ({
    txid,
    fee: 1000,
    vin: [{ prevout: { scriptpubkey_address: from, scriptpubkey: "", value: 10_000 } }],
    vout: [{ scriptpubkey_address: to, scriptpubkey: "", value: 9000 }],
    status: { confirmed: true, block_height: 800_000, block_time: 1_700_000_000 },
  });
  const btcAccountFor =
    (confirmed: Map<BitcoinAccountTemplate, boolean>) =>
    async (params: { template: string; groupIndex: number; network: string }): Promise<unknown> =>
      Promise.resolve({
        xpub: BTC_ACCOUNTS[params.template as BitcoinAccountTemplate].publicExtendedKey,
        changeMark: 0,
        confirmed: confirmed.get(params.template as BitcoinAccountTemplate) ?? true,
      });

  it("bitcoin: a lookalike of an unconfirmed template's address is flagged either way", async () => {
    const U = btcAddress("btc.bip86", 0, 0);
    const confirmed = new Map<BitcoinAccountTemplate, boolean>([["btc.bip86", false]]);
    const { controller } = make({
      bitcoin: {
        account: btcAccountFor(confirmed),
        esplora: esploraOf(
          new Map([[scripthash(U, NETWORK), [btcTx("cc".repeat(32), lookalikeOf(U), U)]]]),
        ),
      },
    });
    await controller.init();
    await controller.load(GROUP);
    const entry = entriesOf(controller).find((e) => e.family === "bitcoin");
    expect(entry?.counterparties).toStrictEqual([lookalikeOf(U)]);
    expect(entry?.flags).toContain("lookalike-counterparty");

    // The template confirmed: the same address is still a lookalike reference.
    confirmed.set("btc.bip86", true);
    await controller.load(GROUP);
    expect(flagsOf(controller)).toContain("lookalike-counterparty");
    controller.lock();
  });

  it("bitcoin: the unconfirmed template's address as counterparty is flagged until confirmed", async () => {
    const U = btcAddress("btc.bip86", 0, 0);
    const C = btcAddress("btc.bip84", 0, 0);
    // The flow runs unconfirmed party → confirmed party: the confirmed side owns the entry and
    // the unconfirmed address lands in its counterparties.
    const tx = btcTx("dd".repeat(32), U, C);
    const confirmed = new Map<BitcoinAccountTemplate, boolean>([["btc.bip86", false]]);
    const { controller } = make({
      bitcoin: {
        account: btcAccountFor(confirmed),
        esplora: esploraOf(
          new Map([
            [scripthash(U, NETWORK), [tx]],
            [scripthash(C, NETWORK), [tx]],
          ]),
        ),
      },
      book: {
        e1: {
          id: "e1",
          name: "mate",
          family: "bitcoin",
          address: lookalikeOf(U),
          createdAt: 0,
          updatedAt: 0,
        },
      },
    });
    await controller.init();
    await controller.load(GROUP);
    const entry = entriesOf(controller).find((e) => e.family === "bitcoin");
    expect(entry?.counterparties).toStrictEqual([U]);
    expect(entry?.flags).toContain("lookalike-counterparty");

    // Confirmed, the address vouches for itself — the flow reads self and flags nothing.
    confirmed.set("btc.bip86", true);
    await controller.load(GROUP);
    expect(entriesOf(controller).find((e) => e.family === "bitcoin")?.flags).toStrictEqual([]);
    controller.lock();
  });

  it("bitcoin: a tracked send's unconfirmed-signer outflow feeds references, never exempt", async () => {
    /* The outflow a device-unconfirmed entry serves is a plain `to` in the tracked intent — but
       its `unconfirmed-signer-output` warning names it, so it lands in the lookalike corpus
       while never vouching for itself: it as counterparty keeps its flag, and so does a
       counterparty imitating it. */
    const U = btcAddress("btc.bip86", 0, 5);
    const C = btcAddress("btc.bip84", 0, 0);
    // The book contact U imitates, and a different address wearing U's edge characters.
    const contact = lookalikeOf(U);
    const imitator = `${U.slice(0, 4)}${"1".repeat(U.length - 8)}${U.slice(-4)}`;
    const paid = btcTx("ee".repeat(32), U, C);
    const copycat = btcTx("ef".repeat(32), imitator, C);
    const { controller } = make({
      bitcoin: {
        account: btcAccountFor(new Map([["btc.bip86", false]])),
        esplora: esploraOf(new Map([[scripthash(C, NETWORK), [paid, copycat]]])),
      },
      book: {
        e1: {
          id: "e1",
          name: "mate",
          family: "bitcoin",
          address: contact,
          createdAt: 0,
          updatedAt: 0,
        },
      },
      txs: {
        sent: {
          id: "sent",
          family: "bitcoin",
          network: BTC_NET,
          account: GROUP.walletId,
          hash: "aa".repeat(32),
          state: "submitted",
          intent: {
            outflows: [{ to: U, amount: { asset: "native", amount: "5" }, verified: true }],
            warnings: [{ kind: "unconfirmed-signer-output", message: U, level: "danger" }],
          },
          nonce: 0,
          submittedAt: 0,
          error: undefined,
        },
      },
    });
    await controller.init();
    await controller.load(GROUP);
    const entries = entriesOf(controller).filter((e) => e.family === "bitcoin");
    // U sits in references — every outflow's `to` is a lookalike anchor — so the counterparty
    // imitating it keeps the flag…
    expect(entries.find((e) => e.counterparties[0] === imitator)?.flags).toContain(
      "lookalike-counterparty",
    );
    // …and U itself never vouches: as a counterparty it imitates the book contact and is flagged.
    expect(entries.find((e) => e.counterparties[0] === U)?.flags).toContain(
      "lookalike-counterparty",
    );
    controller.lock();
  });

  it("a confirmed tracked send's recipient vouches for itself — an equal counterparty flags nothing", async () => {
    /* The tracked send paid OTHER, so OTHER sits in the exempt set: as a counterparty it is
       skipped before the lookalike check — even wearing a book contact's first and last four,
       it raises no flag. */
    const { controller } = make({
      txs: { local1: tracked({ id: "local1", hash: hash("cd"), state: "confirmed" }) },
      book: {
        e1: {
          id: "e1",
          name: "mate",
          family: "evm",
          address: lookalikeOf(OTHER),
          createdAt: 0,
          updatedAt: 0,
        },
      },
      page: {
        items: [
          {
            hash: hash("ee"),
            block: "100",
            timestamp: 5_000_000,
            transfers: [
              {
                kind: "erc20",
                from: OTHER,
                to: OWNER,
                contract: "0x9999999999999999999999999999999999999999",
                tokenId: null,
                amount: "700",
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
    await controller.load(GROUP);
    expect(entriesOf(controller).every((e) => !e.flags.includes("lookalike-counterparty"))).toBe(
      true,
    );
    controller.lock();
  });

  it("a reload whose first page fails on a stream still adopts the fresh own set", async () => {
    /* `OrderedMerge.take` reports a stream failure into `errors` and resolves — a failed source
       cannot pin the previous own in place: the runtime still adopts the freshly resolved set
       once the page settles, so the recompose reads U confirmed. */
    const U = btcAddress("btc.bip86", 0, 0);
    const C = btcAddress("btc.bip84", 0, 0);
    const tx = btcTx("dd".repeat(32), U, C);
    const confirmed = new Map<BitcoinAccountTemplate, boolean>([["btc.bip86", false]]);
    const { controller } = make({
      bitcoin: {
        account: btcAccountFor(confirmed),
        esplora: esploraOf(new Map([[scripthash(C, NETWORK), [tx]]])),
      },
      book: {
        e1: {
          id: "e1",
          name: "mate",
          family: "bitcoin",
          address: lookalikeOf(U),
          createdAt: 0,
          updatedAt: 0,
        },
      },
      // The reload's evm fetch dies — the bitcoin stream still serves the entry.
      pages: [
        { items: [], cursor: null },
        { status: 500, error: "gateway down" },
      ],
    });
    await controller.init();
    await controller.load(GROUP);
    expect(entriesOf(controller).find((e) => e.family === "bitcoin")?.flags).toContain(
      "lookalike-counterparty",
    );

    confirmed.set("btc.bip86", true);
    await controller.load(GROUP);
    const group = controller.getState().groups["w:0"];
    expect(group?.status).toBe("ready");
    expect(group?.errors["eip155:1"]).toBeDefined();
    // The fresh own was adopted across the failure: U vouches for itself — no flag.
    expect(entriesOf(controller).find((e) => e.family === "bitcoin")?.flags).toStrictEqual([]);
    controller.lock();
  });
});
