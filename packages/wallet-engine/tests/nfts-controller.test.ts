/**
 * NftController against a contract-checked fake gateway: every request it sends is validated (POST
 * to the right /v1/nfts/* path, a schema-valid body), and every violation fails the test. Chain
 * reads come from fakes — the gateway is never asked to verify ownership. Timers are hand-driven.
 */
// oxlint-disable vitest/no-conditional-in-test -- mocked responder dispatch is inherently conditional
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { BitcoinUtxoView } from "../src/assets/bitcoin.ts";
import type { AccountBalances } from "../src/assets/controller.ts";
import { gatewaySession } from "../src/gateway/client.ts";
import type { GatewayConfig } from "../src/gateway/session.ts";
import type { HistoryEntry } from "../src/history/types.ts";
import { NFT_POLL_MS, NftController } from "../src/nfts/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { manualTimers } from "./support/timers.ts";

const GATEWAY = "https://gw.test";
const NOW = 1_700_000_000_000;
const EVM = "eip155:1";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC = "bip122:000000000019d6689c085ae165831e93";
const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OWNER_LC = OWNER.toLowerCase();
const CONTRACT = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";
const ASSET = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";
const KEY = `${EVM}:${OWNER_LC}`;

const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

const evmItem = (
  contract: string,
  tokenId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  contract,
  tokenId,
  standard: "erc721",
  balance: "1",
  name: null,
  image: null,
  animation: null,
  collection: null,
  spam: false,
  ...extra,
});

const page = (items: ReadonlyArray<Record<string, unknown>>, cursor: string | null = null) =>
  Response.json({ items, cursor });

type Responder = (path: string, body: Record<string, unknown>) => Response | Promise<Response>;

const violations: string[] = [];

afterEach(() => {
  const found = violations.splice(0);
  if (found.length > 0) {
    throw new Error(`gateway contract violations:\n${found.join("\n")}`);
  }
});

const PATHS = new Set(["/v1/nfts/items", "/v1/nfts/item", "/v1/nfts/collection", "/v1/nfts/floor"]);

function rig(
  options: {
    readonly gateway?: GatewayConfig | undefined;
    readonly answer?: Responder;
    readonly store?: EngineStore;
    readonly entries?: ReadonlyArray<HistoryEntry>;
    readonly txs?: ReadonlyArray<TrackedTransaction>;
    readonly balances?: Readonly<Record<string, AccountBalances>>;
    readonly evmClient?: unknown;
    readonly solanaReject?: boolean;
    readonly solanaGate?: Promise<unknown>;
  } = {},
) {
  const session = "gateway" in options ? options.gateway : gatewaySession(GATEWAY, random);
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const timers = manualTimers();
  const activityListeners = new Set<() => void>();
  const confirmedListeners = new Set<(tx: TrackedTransaction) => void>();
  const warnings: string[] = [];
  let entries = [...(options.entries ?? [])];
  let txs = [...(options.txs ?? [])];
  const responder = { answer: options.answer ?? ((): Response => page([])) };

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const [prefix, network] =
      url.pathname.slice(0, url.pathname.lastIndexOf("/")) === ""
        ? [url.pathname, ""]
        : [
            url.pathname.slice(0, url.pathname.lastIndexOf("/")),
            url.pathname.slice(url.pathname.lastIndexOf("/") + 1),
          ];
    if (url.origin !== GATEWAY || !PATHS.has(prefix) || init?.method !== "POST") {
      violations.push(`${init?.method ?? "GET"} ${url.href}: not an NFT route POST`);
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(init?.body));
      if (!isObj(parsed)) {
        throw new Error("not an object");
      }
      body = parsed;
    } catch {
      violations.push(`${url.pathname}: non-JSON body`);
      return new Response("{}", { status: 400 });
    }
    calls.push({ path: `${prefix}/${network}`, body });
    return responder.answer(`${prefix}/${network}`, body);
  };

  const family = (network: string): string =>
    network === EVM ? "evm" : network === SOL ? "solana" : network === BTC ? "bitcoin" : "unknown";

  const controller = new NftController({
    gateway: session,
    fetch: fetchImpl,
    openStore: async () => Promise.resolve(options.store ?? createMemoryEngineStore()),
    setTimer: timers.setTimer,
    now: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
    networks: {
      info: (network: string) => {
        const f = family(network);
        if (f === "unknown") {
          throw new Error(`unknown network ${network}`);
        }
        return { family: f } as never;
      },
      client: () => (options.evmClient ?? "evm-client") as never,
      solanaRpc: () => ({
        call: async () => {
          if (options.solanaReject === true) {
            throw new Error("rpc down");
          }
          if (options.solanaGate !== undefined) {
            await options.solanaGate;
          }
          return undefined;
        },
      }),
    },
    balances: () => options.balances ?? {},
    activity: () => ({ entries, txs }),
    onActivityChange: (listener) => {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },
    onConfirmed: (listener) => {
      confirmedListeners.add(listener);
      return () => {
        confirmedListeners.delete(listener);
      };
    },
  });

  return {
    controller,
    calls,
    timers,
    warnings,
    setActivity(next: { entries?: HistoryEntry[]; txs?: TrackedTransaction[] }) {
      entries = next.entries ?? entries;
      txs = next.txs ?? txs;
      for (const listener of activityListeners) {
        listener();
      }
    },
    confirm(tx: TrackedTransaction) {
      for (const listener of confirmedListeners) {
        listener(tx);
      }
    },
  };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve));
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Narrow a result to its value — the alternative already failed the test by throwing. */
const okValue = <A>(result: { readonly ok: boolean; readonly value?: A }): A => {
  if (!result.ok || result.value === undefined) {
    throw new Error("expected an ok result");
  }
  return result.value;
};

const init = async (r: ReturnType<typeof rig>) => {
  await r.controller.init();
};

const twoPages: Responder = (_p, body) =>
  body["cursor"] === "c2"
    ? page([evmItem(CONTRACT, "7"), evmItem(CONTRACT, "9")])
    : page([evmItem(CONTRACT, "7"), evmItem(CONTRACT, "8")], "c2");

const firstThenFail = (): Responder => {
  let round = 0;
  return (_p, _b) => {
    round += 1;
    return round === 1 ? page([evmItem(CONTRACT, "7")]) : new Response("x", { status: 500 });
  };
};

describe("load and loadMore", () => {
  it("loads page 1, lowercases an EVM owner, and marks items hidden when spam reasons exist", async () => {
    const r = rig({
      answer: (_p, _b) =>
        page([
          evmItem(CONTRACT, "7", { name: "Cool Ape" }),
          evmItem(CONTRACT, "8", { spam: true }),
        ]),
    });
    await init(r);
    const inventory = await r.controller.load(OWNER, EVM);
    expect(inventory.items).toHaveLength(2);
    expect(inventory.pages).toBe(1);
    expect(inventory.cursor).toBeNull();
    expect(inventory.failure).toBeNull();
    expect(inventory.items[0]?.hidden).toBe(false);
    expect(inventory.items[1]?.hidden).toBe(true);
    expect(inventory.items[1]?.spam).toStrictEqual(["gateway"]);
    expect(r.calls[0]?.body).toStrictEqual({ owner: OWNER_LC });
  });

  it("appends the next page, dedupes ids across pages (first wins)", async () => {
    const r = rig({ answer: twoPages });
    await init(r);
    await r.controller.load(OWNER, EVM);
    const inventory = await r.controller.loadMore(OWNER, EVM);
    expect(inventory.items.map((i) => i.tokenId)).toStrictEqual(["7", "8", "9"]);
    expect(inventory.pages).toBe(2);
    expect(r.calls[1]?.body).toStrictEqual({ owner: OWNER_LC, cursor: "c2" });
  });

  it("marks the inventory truncated after 20 pages and clears the cursor", async () => {
    let fetched = 0;
    const r = rig({
      answer: () => {
        fetched += 1;
        return page([evmItem(CONTRACT, String(fetched))], `c${fetched + 1}`);
      },
    });
    await init(r);
    await r.controller.load(OWNER, EVM);
    let inventory = await r.controller.loadMore(OWNER, EVM);
    for (let i = 2; i < 20; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- pagination is sequential by design
      inventory = await r.controller.loadMore(OWNER, EVM);
    }
    expect(inventory.pages).toBe(20);
    expect(inventory.truncated).toBe(true);
    expect(inventory.cursor).toBeNull();
    expect(fetched).toBe(20);
  });

  it("fetches the second request of a single-flight load once", async () => {
    let gate: Promise<void> = Promise.resolve();
    const r = rig({
      answer: async () => {
        await gate;
        return page([evmItem(CONTRACT, "7")]);
      },
    });
    await init(r);
    let release!: () => void;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const one = r.controller.load(OWNER, EVM);
    const two = r.controller.load(OWNER, EVM);
    release();
    const [a, b] = await Promise.all([one, two]);
    expect(a).toBe(b);
    expect(r.calls).toHaveLength(1);
  });
});

describe("refresh", () => {
  it("replaces items only when every page answers; a failed page keeps the old items", async () => {
    const r = rig({ answer: firstThenFail() });
    await init(r);
    await r.controller.load(OWNER, EVM);
    const inventory = await r.controller.refresh(OWNER, EVM);
    expect(inventory.items.map((i) => i.tokenId)).toStrictEqual(["7"]);
    expect(inventory.failure).toBe("unavailable");
  });

  it("keeps pagination when a refresh page fails — loadMore still resumes", async () => {
    const answers: Responder = (_p, body) => {
      const { cursor } = body;
      if (cursor === undefined) {
        // page 1: full answer while loading, a failure while refreshing (3rd call)
        return calls < 3
          ? page([evmItem(CONTRACT, "1")], "c2")
          : new Response("x", { status: 500 });
      }
      return page([evmItem(CONTRACT, cursor === "c2" ? "2" : "3")], cursor === "c2" ? "c3" : null);
    };
    let calls = 0;
    const r = rig({
      answer: async (path, body) => {
        calls += 1;
        return answers(path, body);
      },
    });
    await init(r);
    await r.controller.load(OWNER, EVM);
    const two = await r.controller.loadMore(OWNER, EVM);
    expect(two.pages).toBe(2);
    expect(two.cursor).toBe("c3");

    const failed = await r.controller.refresh(OWNER, EVM);
    expect(failed.failure).toBe("unavailable");
    expect(failed.cursor).toBe("c3");
    expect(failed.pages).toBe(2);
    expect(failed.items.map((i) => i.tokenId)).toStrictEqual(["1", "2"]);

    const three = await r.controller.loadMore(OWNER, EVM);
    expect(three.pages).toBe(3);
    expect(three.items.map((i) => i.tokenId)).toStrictEqual(["1", "2", "3"]);
    expect(r.calls[3]?.body).toStrictEqual({ owner: OWNER_LC, cursor: "c3" });
  });

  it("keeps the cursor when a repeated load fails", async () => {
    const answers: Responder = (_p, body) => {
      const { cursor } = body;
      if (cursor === undefined) {
        return first ? page([evmItem(CONTRACT, "1")], "c2") : new Response("x", { status: 500 });
      }
      return page([evmItem(CONTRACT, "2")]);
    };
    let first = true;
    const r = rig({
      answer: async (path, body) => {
        const response = answers(path, body);
        first = false;
        return response;
      },
    });
    await init(r);
    await r.controller.load(OWNER, EVM);
    const failed = await r.controller.load(OWNER, EVM);
    expect(failed.failure).toBe("unavailable");
    expect(failed.cursor).toBe("c2");
    expect(failed.pages).toBe(1);
    expect(failed.items.map((i) => i.tokenId)).toStrictEqual(["1"]);
  });

  it("polls every NFT_POLL_MS while visible and stops when hidden", async () => {
    const r = rig({ answer: () => page([evmItem(CONTRACT, "7")]) });
    await init(r);
    await r.controller.load(OWNER, EVM);
    r.controller.setVisible(true);
    await flush();
    expect(r.calls).toHaveLength(2);
    await r.timers.fire(NFT_POLL_MS);
    await flush();
    expect(r.calls).toHaveLength(3);
    r.controller.setVisible(false);
    expect(r.timers.armed(NFT_POLL_MS)).toBe(0);
  });
});

describe("failure mapping", () => {
  it.each([
    ["no gateway", () => rig({ gateway: undefined }), "no-gateway"],
    ["a 429", () => rig({ answer: () => new Response("x", { status: 429 }) }), "rate-limited"],
    [
      "a 404 unsupported",
      () => rig({ answer: () => Response.json({ error: "unsupported" }, { status: 404 }) }),
      "unsupported",
    ],
    [
      "a 404 not-found",
      () => rig({ answer: () => Response.json({ error: "not-found" }, { status: 404 }) }),
      "not-found",
    ],
    ["a non-JSON body", () => rig({ answer: () => new Response("not json") }), "invalid-response"],
    [
      "an item of the wrong network shape",
      () =>
        rig({ answer: () => page([evmItem("0xBC4CA0EDA7647A8AB7C2061C2E118A18A936F13D", "7")]) }),
      "invalid-response",
    ],
    [
      "duplicate ids on one page",
      () => rig({ answer: () => page([evmItem(CONTRACT, "7"), evmItem(CONTRACT, "7")]) }),
      "invalid-response",
    ],
    [
      "a page larger than 100 items",
      () =>
        rig({
          answer: () => page(Array.from({ length: 101 }, (_, i) => evmItem(CONTRACT, String(i)))),
        }),
      "invalid-response",
    ],
    [
      "a malformed response shape",
      () => rig({ answer: () => Response.json({ items: "nope" }) }),
      "invalid-response",
    ],
  ])("stores no invalid data on %s", async (_label, make, failure) => {
    const r = make();
    await init(r);
    const inventory = await r.controller.load(OWNER, EVM);
    expect(inventory.failure).toBe(failure);
    expect(inventory.items).toStrictEqual([]);
  });

  it("drops the answer when a lock lands between request and response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({
      answer: async () => {
        await gate;
        return page([evmItem(CONTRACT, "7")]);
      },
    });
    await init(r);
    const pending = r.controller.load(OWNER, EVM);
    r.controller.lock();
    release();
    const inventory = await pending;
    expect(inventory.items).toStrictEqual([]);
    expect(r.controller.getState().inventories[KEY]).toBeUndefined();
  });
});

describe("detail, collection, floor", () => {
  const detailBody = {
    item: evmItem(CONTRACT, "7", {
      name: "Cool Ape",
      // oxlint-disable-next-line eslint/no-script-url -- a hostile javascript: URL is the point
      image: { url: "javascript:alert(1)", mime: "image/png" },
      animation: { url: "https://x.test/a.svg", mime: "image/svg+xml" },
    }),
    description: "a description",
    attributes: [{ trait: "fur", value: "gold" }],
    externalUrl: "https://x.test/item",
  };

  it("sanitises a detail: javascript image dropped, svg animation active", async () => {
    const r = rig({ answer: () => Response.json(detailBody) });
    await init(r);
    const value = okValue(await r.controller.detail(EVM, CONTRACT, "7"));
    expect(value.item.image).toBeUndefined();
    expect(value.item.animation?.active).toBe(true);
    expect(value.description?.lines).toStrictEqual(["a description"]);
    expect(value.attributes).toStrictEqual([{ trait: "fur", value: "gold" }]);
    expect(value.externalUrl).toBe("https://x.test/item");
    expect(r.calls[0]?.body).toStrictEqual({ contract: CONTRACT, tokenId: "7" });
  });

  it("invalid-response when the detail's item names a different token", async () => {
    const r = rig({
      answer: () => Response.json({ ...detailBody, item: evmItem(CONTRACT, "9") }),
    });
    await init(r);
    await expect(r.controller.detail(EVM, CONTRACT, "7")).resolves.toStrictEqual({
      ok: false,
      failure: "invalid-response",
    });
  });

  it("throws TypeError for a Solana detail with a tokenId, or an EVM one without", async () => {
    const r = rig();
    await init(r);
    await expect(r.controller.detail(SOL, ASSET, "1")).rejects.toBeInstanceOf(TypeError);
    await expect(r.controller.detail(EVM, CONTRACT)).rejects.toBeInstanceOf(TypeError);
  });

  it("returns a sanitised collection view", async () => {
    const r = rig({
      answer: () =>
        Response.json({
          id: CONTRACT,
          name: "Cool Apes",
          symbol: "APE",
          description: null,
          image: null,
          totalSupply: "10000",
          standard: "erc721",
          spam: false,
          verified: true,
        }),
    });
    await init(r);
    const value = okValue(await r.controller.collection(EVM, CONTRACT));
    expect(value.name).toBe("Cool Apes");
    expect(value.verified).toBe(true);
    expect(value.standard).toBe("erc721");
  });

  it("returns floor rows and maps a 404 unsupported", async () => {
    const r = rig({ answer: floorAnswer });
    await init(r);
    const answer = await r.controller.floor(EVM, CONTRACT);
    expect(answer).toStrictEqual({
      ok: true,
      value: [{ marketplace: "opensea", amount: "1.5", currency: "ETH", retrievedAt: NOW }],
    });
    await expect(r.controller.floor(SOL, ASSET)).resolves.toStrictEqual({
      ok: false,
      failure: "unsupported",
    });
  });
});

const floorAnswer: Responder = (path) =>
  path === `/v1/nfts/floor/${EVM}`
    ? Response.json({
        floors: [{ marketplace: "opensea", amount: "1.5", currency: "ETH", retrievedAt: NOW }],
      })
    : Response.json({ error: "unsupported" }, { status: 404 });

const deadEvmClient = {
  request: async (args: { method: string; params?: ReadonlyArray<unknown> }) => {
    const data = (args.params?.[0] as { data?: string } | undefined)?.data?.toLowerCase() ?? "";
    return Promise.resolve(
      data.startsWith("0x01ffc9a7")
        ? `0x${"0".repeat(63)}1`
        : `0x${"0".repeat(24)}000000000000000000000000000000000000dead`,
    );
  },
};

describe("visibility", () => {
  const store = () => createMemoryEngineStore();
  const spamPage = () => page([evmItem(CONTRACT, "7", { spam: true })]);

  it("persists hidden/shown rows and survives lock → init", async () => {
    const shared = store();
    const r = rig({ answer: spamPage, store: shared });
    await init(r);
    await r.controller.load(OWNER, EVM);
    const id = `${CONTRACT}:7`;
    expect(r.controller.getState().inventories[KEY]?.items[0]?.id).toBe(id);
    await r.controller.setHidden(EVM, id, "shown");
    expect(r.controller.getState().inventories[KEY]?.items[0]?.hidden).toBe(false);
    r.controller.lock();

    const r2 = rig({ answer: spamPage, store: shared });
    await init(r2);
    await r2.controller.load(OWNER, EVM);
    expect(r2.controller.getState().inventories[KEY]?.items[0]?.hidden).toBe(false);
  });

  it("clears an override back to the computed verdict", async () => {
    const r = rig({ answer: spamPage });
    await init(r);
    await r.controller.load(OWNER, EVM);
    await r.controller.setHidden(EVM, `${CONTRACT}:7`, "shown");
    expect(r.controller.getState().inventories[KEY]?.items[0]?.hidden).toBe(false);
    await r.controller.setHidden(EVM, `${CONTRACT}:7`, undefined);
    expect(r.controller.getState().inventories[KEY]?.items[0]?.hidden).toBe(true);
  });

  it("rebuilds on activity change — an airdrop item flips hidden once history shows it", async () => {
    const airdrop: HistoryEntry = {
      id: `${EVM}:0x1`,
      family: "evm",
      network: EVM,
      direction: "in",
      changes: [{ direction: "in", asset: CONTRACT, amount: "1", tokenId: "7", listed: false }],
      status: "confirmed",
      origin: { kind: "gateway" },
      verified: true,
    } as unknown as HistoryEntry;
    const r = rig({ answer: () => page([evmItem(CONTRACT, "7")]), entries: [] });
    await init(r);
    await r.controller.load(OWNER, EVM);
    expect(r.controller.getState().inventories[KEY]?.items[0]?.hidden).toBe(false);

    r.setActivity({ entries: [airdrop] });
    const after = r.controller.getState().inventories[KEY]?.items[0];
    expect(after?.spam).toStrictEqual(["airdrop"]);
    expect(after?.hidden).toBe(true);
  });
});

describe("inscriptions", () => {
  const utxo = (over: Partial<BitcoinUtxoView> = {}): BitcoinUtxoView => ({
    txid: "ab".repeat(32),
    vout: 0,
    value: 546,
    address: "bc1px",
    height: 100,
    source: "btc.bip86",
    protected: true,
    ...over,
  });

  it("returns only already-protected UTXOs and throws on a non-bitcoin network", () => {
    const group = { walletId: "w1", groupIndex: 0 };
    const r = rig({
      balances: {
        [`${BTC}:w1:0`]: {
          native: "0",
          tokens: [],
          utxos: [utxo(), utxo({ vout: 1, protected: false })],
        },
      },
    });
    const found = r.controller.inscriptions(group, BTC);
    expect(found).toHaveLength(1);
    expect(found[0]?.vout).toBe(0);
    expect(() => r.controller.inscriptions(group, EVM)).toThrow(TypeError);
  });
});

describe("post-inclusion re-read", () => {
  const tx = (over: Record<string, unknown> = {}): TrackedTransaction =>
    ({
      id: "tx1",
      network: EVM,
      state: "confirmed",
      intent: {
        outflows: [{ to: "0x1", amount: { asset: CONTRACT, tokenId: "7", amount: "1" } }],
      },
      ...over,
    }) as unknown as TrackedTransaction;

  const ASSET2 = "9xyz9xyz9xyz9xyz9xyz9xyz9xyz9xyz9xyz9xyz9xyz";
  const solItemRecord = (contract: string): Record<string, unknown> => ({
    contract,
    tokenId: null,
    standard: "metaplex",
    balance: "1",
    name: null,
    image: null,
    animation: null,
    collection: null,
    spam: false,
  });

  const solPage = () =>
    page([
      {
        contract: ASSET,
        tokenId: null,
        standard: "metaplex",
        balance: "1",
        name: null,
        image: null,
        animation: null,
        collection: null,
        spam: false,
      },
    ]);

  it("drops a Solana item whose chain balance reads zero — the gateway is never asked", async () => {
    const r = rig({ answer: () => solPage() });
    await init(r);
    const owner = "2RtGg6fsFiiF1EQzHqbd66AhW7R5bWeQGpTbv2UMkCdW";
    await r.controller.load(owner, SOL);
    const before = r.calls.length;
    r.confirm(
      tx({
        network: SOL,
        intent: { outflows: [{ to: "x", amount: { asset: ASSET, amount: "1" } }] },
      }),
    );
    await flush();
    expect(r.controller.getState().inventories[`${SOL}:${owner}`]?.items).toStrictEqual([]);
    expect(r.calls).toHaveLength(before);
  });

  it("keeps an item whose chain read fails and logs a warning", async () => {
    const r = rig({ answer: () => solPage(), solanaReject: true });
    await init(r);
    const owner = "2RtGg6fsFiiF1EQzHqbd66AhW7R5bWeQGpTbv2UMkCdW";
    await r.controller.load(owner, SOL);
    r.confirm(
      tx({
        network: SOL,
        intent: { outflows: [{ to: "x", amount: { asset: ASSET, amount: "1" } }] },
      }),
    );
    await flush();
    expect(r.controller.getState().inventories[`${SOL}:${owner}`]?.items).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes("balance read"))).toBe(true);
  });

  it("drops an EVM item the chain reports for another owner", async () => {
    const r = rig({ answer: () => page([evmItem(CONTRACT, "7")]), evmClient: deadEvmClient });
    await init(r);
    await r.controller.load(OWNER, EVM);
    r.confirm(tx());
    await flush();
    expect(r.controller.getState().inventories[KEY]?.items).toStrictEqual([]);
  });

  it("a lock while a re-read is pending writes nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({ answer: () => solPage(), solanaGate: gate });
    await init(r);
    const owner = "2RtGg6fsFiiF1EQzHqbd66AhW7R5bWeQGpTbv2UMkCdW";
    await r.controller.load(owner, SOL);
    r.confirm(
      tx({
        network: SOL,
        intent: { outflows: [{ to: "x", amount: { asset: ASSET, amount: "1" } }] },
      }),
    );
    r.controller.lock();
    release();
    await flush();
    expect(r.controller.getState().inventories[`${SOL}:${owner}`]).toBeUndefined();
  });

  it("a refresh landing during a re-read is not lost", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fresh = false;
    const r = rig({
      answer: () => (fresh ? page([solItemRecord(ASSET), solItemRecord(ASSET2)]) : solPage()),
      solanaGate: gate,
    });
    await init(r);
    const owner = "2RtGg6fsFiiF1EQzHqbd66AhW7R5bWeQGpTbv2UMkCdW";
    await r.controller.load(owner, SOL);
    r.confirm(
      tx({
        network: SOL,
        intent: { outflows: [{ to: "x", amount: { asset: ASSET, amount: "1" } }] },
      }),
    );
    fresh = true;
    await r.controller.refresh(owner, SOL);
    release();
    await flush();
    const items = r.controller.getState().inventories[`${SOL}:${owner}`]?.items ?? [];
    // The re-read dropped the named item (0n); the item the refresh added stays.
    expect(items.map((i) => i.id)).toStrictEqual([ASSET2]);
  });

  it("leaves an item no outflow names untouched", async () => {
    const r = rig({ answer: () => page([evmItem(CONTRACT, "7")]) });
    await init(r);
    await r.controller.load(OWNER, EVM);
    r.confirm(
      tx({
        intent: {
          outflows: [{ to: "0x1", amount: { asset: CONTRACT, tokenId: "99", amount: "1" } }],
        },
      }),
    );
    await flush();
    const item = r.controller.getState().inventories[KEY]?.items[0];
    expect(item?.id).toBe(`${CONTRACT}:7`);
    expect(r.warnings).toStrictEqual([]);
  });
});
