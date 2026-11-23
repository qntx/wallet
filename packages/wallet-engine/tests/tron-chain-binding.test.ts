/**
 * The reference block id is the chain binding of a TRON transaction: when the gateway serves the
 * network a host endpoint must confirm it, and the answering node — pinned for the whole build —
 * must report the configured network's genesis block. Gateway-only builds are refused, host read
 * failures are refused, and a primary on a different chain is refused before anything is signed. A
 * host-only primary is trusted configuration and builds without a genesis read.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vite-plus/test";

import {
  tronAddressFromPublicKey,
  tronAddressToHex,
  tronRawDataFromJson,
} from "@qntx/wallet-chains/tron";

import { TronThrottledError, pinnedTronCaller } from "../src/chains/tron.ts";
import type { TronApi } from "../src/chains/tron.ts";
import type { Independent } from "../src/networks/controller.ts";
import type {
  AccountRef,
  ChainRequestInput,
  RouteContext,
  TrackedTransaction,
  PrepareParams,
  SendParams,
} from "../src/transactions/route.ts";
import {
  prepareDappTron,
  prepareTron,
  prepareTronApprove,
  prepareTronStake,
} from "../src/transactions/tron.ts";

const NET = "tron:3448148188";
const GENESIS = "0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc";
/** Tron:728126428 mainnet's genesis — the id a provider on the wrong chain would answer. */
const MAINNET_GENESIS = "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc";
const PRIV = new Uint8Array(32).fill(0x11);
const FROM = tronAddressFromPublicKey(secp256k1.getPublicKey(PRIV, false));
const FROM_HEX = tronAddressToHex(FROM);
const TO = tronAddressFromPublicKey(secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), false));
const TO_HEX = tronAddressToHex(TO);
const SOLID_ID = "ab".repeat(32);
const ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "tron.bip44",
};
const VERIFY = { kind: "password", password: "pw" } as SendParams["verify"];

const PARAMS = {
  getTransactionFee: 1000,
  getEnergyFee: 210,
  getCreateAccountFee: 100_000,
  getCreateNewAccountFeeInSystemContract: 1_000_000,
  getMaxFeeLimit: 5_000_000_000,
  getCreateNewAccountBandwidthRate: 4,
  getMaxCreateAccountTxSize: 5000,
  getMemoFee: 1_000_000,
};

const params = (over: Partial<PrepareParams> = {}): PrepareParams => ({
  account: ACCOUNT,
  network: NET,
  to: TO,
  amount: 1_000_000n,
  fee: "normal",
  ...over,
});

type World = {
  /** Num → blockID for the getblockbynum paths; block 0 is the answering node's chain. */
  blockIds: Map<number, string>;
  accounts: Map<string, Record<string, unknown>>;
  params: unknown;
  failing: Set<string>;
  independent: Independent<TronApi>;
  posts: Array<{ path: string; body: unknown }>;
  /** The host endpoint's reads — `hostApi` records them separately from the primary's. */
  hostPosts: Array<{ path: string; body: unknown }>;
  signCalls: number;
};

const world = (
  over: Partial<World> = {},
): World & { api: TronApi; answerNode: (path: string, body: unknown) => Promise<unknown> } => {
  const w: World = {
    blockIds: new Map([
      [0, GENESIS],
      [100, SOLID_ID],
    ]),
    accounts: new Map([
      [FROM, { address: FROM, balance: 100_000_000 }],
      [TO, { address: TO, balance: 0 }],
    ]),
    params: {
      chainParameter: Object.entries(PARAMS).map(([key, value]) => ({ key, value })),
    },
    failing: new Set(),
    independent: { kind: "not-needed" },
    posts: [],
    hostPosts: [],
    signCalls: 0,
    ...over,
  };
  const answerNode = async (path: string, body: unknown): Promise<unknown> => {
    await Promise.resolve();
    const b = body as Record<string, unknown>;
    if (w.failing.has(path)) {
      throw new TypeError("fetch failed");
    }
    switch (path) {
      case "/walletsolidity/getnowblock":
        return {
          blockID: SOLID_ID,
          block_header: { raw_data: { number: 100, timestamp: 900_000 } },
        };
      case "/wallet/getnowblock":
        return {
          blockID: "cd".repeat(32),
          block_header: { raw_data: { number: 105, timestamp: 910_000 } },
        };
      case "/wallet/getblockbynum":
      case "/walletsolidity/getblockbynum": {
        const id = w.blockIds.get(Number(b["num"]));
        return id === undefined
          ? {}
          : { blockID: id, block_header: { raw_data: { number: b["num"], timestamp: 900_000 } } };
      }
      case "/wallet/getchainparameters":
        return w.params;
      case "/wallet/getaccount":
        return w.accounts.get(String(b["address"])) ?? {};
      case "/wallet/getaccountresource":
        return { freeNetLimit: 600, freeNetUsed: 0 };
      case "/wallet/triggerconstantcontract":
        return {
          result: { result: true },
          energy_used: 14_630,
          energy_penalty: 0,
          constant_result: [],
        };
      default:
        throw new Error(`unmocked ${path}`);
    }
  };
  const api: TronApi = {
    post: async (path, body) => {
      await Promise.resolve();
      w.posts.push({ path, body });
      return answerNode(path, body);
    },
  };
  return { ...w, api, answerNode };
};

/** An independent endpoint answering the world's blocks, params, and accounts. */
const hostApi = (
  w: World & { answerNode: (path: string, body: unknown) => Promise<unknown> },
  failing: ReadonlyArray<string> = [],
): TronApi => ({
  post: async (path, body) => {
    await Promise.resolve();
    w.hostPosts.push({ path, body });
    if (failing.includes(path)) {
      throw new TypeError("fetch failed");
    }
    return w.answerNode(path, body);
  },
});

/** A host api that answers everything except `getblockbynum` for one block number. */
const hostApiFailingNum = (
  w: World & { answerNode: (path: string, body: unknown) => Promise<unknown> },
  num: number,
): TronApi => ({
  post: async (path, body) => {
    await Promise.resolve();
    w.hostPosts.push({ path, body });
    if (
      path.endsWith("getblockbynum") &&
      Number((body as Record<string, unknown>)["num"]) === num
    ) {
      throw new TypeError("fetch failed");
    }
    return w.answerNode(path, body);
  },
});

const NILE = { id: NET, genesisHash: GENESIS, testnet: true } as const;
const MAINNET_NET = {
  id: "tron:728126428",
  genesisHash: MAINNET_GENESIS,
  testnet: false,
} as const;

const ctx = (
  w: World & { api: TronApi },
  now: () => number = () => 1_000_000,
  net:
    | typeof NILE
    | { readonly id: string; readonly genesisHash: string; readonly testnet: boolean } = NILE,
  pinned?: (network: string, until?: () => number) => TronApi,
): { ctx: RouteContext; transitions: TrackedTransaction[] } => {
  const transitions: TrackedTransaction[] = [];
  return {
    transitions,
    ctx: {
      options: {
        networks: {
          tronApi: () => w.api,
          pinnedTronApi: pinned ?? (() => w.api),
          independentTronApi: () => w.independent,
          independentPinnedTronApi: () => w.independent,
          info: () => net,
        } as never,
        wallet: {} as never,
        openStore: async () => Promise.resolve({} as never),
        random: (n: number) => new Uint8Array(n).fill(0x55),
        setTimer: () => () => {},
        now,
        logger: { warn: () => {} },
        chains: {
          account: async () =>
            Promise.resolve({ template: "tron.bip44", network: NET, address: FROM }),
          sign: async (p: { request: { kind: string; rawData?: Uint8Array } }) => {
            await Promise.resolve();
            w.signCalls += 1;
            const { request } = p;
            if (request.kind !== "tron.transaction" || !(request.rawData instanceof Uint8Array)) {
              throw new Error("unexpected request");
            }
            const sig = secp256k1.sign(request.rawData, PRIV, { lowS: true, format: "recovered" });
            const out = new Uint8Array(65);
            out.set(sig.subarray(1), 0);
            out[64] = 27 + (sig[0] ?? 0);
            return { kind: "tron.transaction" as const, signature: out };
          },
        } as never,
      },
      transition: async (tx, next) => {
        const updated = { ...tx, ...next };
        transitions.push(updated);
        return Promise.resolve(updated);
      },
      track: () => {},
      txs: () => ({}),
      newId: () => "tx-test",
    },
  };
};

const dappRaw = (): Uint8Array =>
  tronRawDataFromJson(
    {
      ref_block_bytes: "0064",
      ref_block_hash: SOLID_ID.slice(16, 32),
      expiration: 1_100_000,
      timestamp: 1_040_000,
      contract: [
        {
          parameter: {
            value: { amount: 1_000_000, owner_address: FROM_HEX, to_address: TO_HEX },
            type_url: "type.googleapis.com/protocol.TransferContract",
          },
          type: "TransferContract",
        },
      ],
    },
    false,
  );

const genesisReads = (w: World): number =>
  w.posts.filter(
    (p) => p.path.endsWith("getblockbynum") && (p.body as Record<string, unknown>)["num"] === 0,
  ).length;

describe("the reference block must be confirmed by a host endpoint", () => {
  it("refuses a gateway-only send before anything is signed", async () => {
    const w = world({ independent: { kind: "unavailable" } });
    const c = ctx(w).ctx;
    await expect(prepareTron(c, params())).rejects.toThrow(
      /only the gateway vouches for the reference block on tron:3448148188/,
    );
    expect(w.signCalls).toBe(0);
  });

  it("refuses a gateway-only stake, approve, and dApp prepare the same way", async () => {
    const w = world({ independent: { kind: "unavailable" } });
    const c = ctx(w).ctx;
    const stake: Extract<ChainRequestInput, { method: "tron-stake" }> = {
      method: "tron-stake",
      account: ACCOUNT,
      network: NET,
      action: { kind: "freeze", amount: 5_000_000n, resource: "bandwidth" },
    };
    await expect(prepareTronStake(c, stake)).rejects.toThrow(/only the gateway vouches/);
    const approve: Extract<ChainRequestInput, { method: "tron-approve" }> = {
      method: "tron-approve",
      account: ACCOUNT,
      network: NET,
      token: TO,
      spender: TO,
      amount: 1_000_000n,
    };
    await expect(prepareTronApprove(c, approve)).rejects.toThrow(/only the gateway vouches/);
    await expect(prepareDappTron(c, ACCOUNT, NET, dappRaw())).rejects.toThrow(
      /only the gateway vouches/,
    );
    expect(w.signCalls).toBe(0);
  });

  it("answers the same refusal when a rebuild would be gateway-only", async () => {
    const wv = world();
    wv.independent = { kind: "available", source: "host", client: hostApi(wv) };
    const c = ctx(wv).ctx;
    const prepared = await prepareTron(c, params());
    // The reference block falls out of the node's view → staleReason goes through rebuild.
    wv.blockIds.delete(100);
    wv.independent = { kind: "unavailable" }; // the host endpoint is now gone
    await expect(prepared.staleReason()).resolves.toBe(
      'only the gateway vouches for the reference block on tron:3448148188; on a testnet a signature over another network\'s reference block could be valid there — configure a host endpoint in EngineOptions.rpc["tron:3448148188"]',
    );
  });

  it("builds when a host endpoint confirms the reference block", async () => {
    const wv = world();
    wv.independent = { kind: "available", source: "host", client: hostApi(wv) };
    const { ctx: c } = ctx(wv);
    const prepared = await prepareTron(c, params());
    expect(prepared.checks).toStrictEqual([]);
    expect(genesisReads(wv)).toBe(1); // the answering node's block 0 was read once
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.state).toBe("submitted");
  });

  it("refuses when the host endpoint's reference-block read fails", async () => {
    const wv = world();
    wv.independent = {
      kind: "available",
      source: "host",
      client: hostApi(wv, ["/wallet/getblockbynum", "/walletsolidity/getblockbynum"]),
    };
    await expect(prepareTron(ctx(wv).ctx, params())).rejects.toThrow(
      /could not confirm the reference block/,
    );
  });

  it("refuses when only the host endpoint's reference-block read fails", async () => {
    const wv = world();
    /* The host answers the genesis check but cannot read block 100 — a failed read is not a
       confirmation, and flagging the build unverifiable must not let it sign. */
    wv.independent = { kind: "available", source: "host", client: hostApiFailingNum(wv, 100) };
    await expect(prepareTron(ctx(wv).ctx, params())).rejects.toThrow(
      /could not confirm the reference block/,
    );
  });

  it("refuses when the host endpoint disagrees on the reference block", async () => {
    const wv = world();
    const hv = world();
    hv.blockIds.set(100, "ff".repeat(32)); // the host proves a different block 100
    wv.independent = { kind: "available", source: "host", client: hostApi(hv) };
    await expect(prepareTron(ctx(wv).ctx, params())).rejects.toThrow(
      /disagree on the reference block/,
    );
  });

  it("answers the same refusal when a rebuild's host read fails", async () => {
    const wv = world();
    wv.independent = { kind: "available", source: "host", client: hostApi(wv) };
    const c = ctx(wv).ctx;
    const prepared = await prepareTron(c, params());
    wv.blockIds.delete(100);
    wv.independent = {
      kind: "available",
      source: "host",
      client: hostApi(wv, ["/wallet/getblockbynum", "/walletsolidity/getblockbynum"]),
    };
    await expect(prepared.staleReason()).resolves.toBe(
      "the host endpoint could not confirm the reference block",
    );
  });
});

describe("the answering node must report the configured chain", () => {
  it("refuses a primary whose block 0 is another chain's genesis", async () => {
    const wv = world();
    wv.blockIds.set(0, MAINNET_GENESIS); // the gateway's provider answers for mainnet on Nile
    wv.independent = { kind: "available", source: "host", client: hostApi(wv) };
    await expect(prepareTron(ctx(wv).ctx, params())).rejects.toThrow(
      /serves another chain than tron:3448148188/,
    );
    expect(wv.signCalls).toBe(0);
  });

  it("refuses a host endpoint whose block 0 is another chain's genesis", async () => {
    const wv = world();
    const hv = world();
    hv.blockIds.set(0, MAINNET_GENESIS); // the host node is on mainnet, not Nile
    wv.independent = { kind: "available", source: "host", client: hostApi(hv) };
    await expect(prepareTron(ctx(wv).ctx, params())).rejects.toThrow(/serves another chain/);
  });

  it("a host-only primary builds without a genesis read", async () => {
    const wv = world(); // independent stays not-needed — trusted host configuration
    const { ctx: c } = ctx(wv);
    const prepared = await prepareTron(c, params());
    expect(prepared.checks).toStrictEqual([]);
    expect(genesisReads(wv)).toBe(0); // no block-0 read — nothing to corroborate it against
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.state).toBe("submitted");
  });

  it("anchors the dApp prepare path: genesis checked once, then the reference block", async () => {
    const wv = world();
    wv.independent = { kind: "available", source: "host", client: hostApi(wv) };
    const { ctx: c } = ctx(wv);
    const prepared = await prepareDappTron(c, ACCOUNT, NET, dappRaw());
    expect(prepared.checks).toStrictEqual([]);
    expect(genesisReads(wv)).toBe(1);
  });
});

describe("a gateway-only mainnet build goes ahead flagged reads-unverified", () => {
  const MAINNET = "tron:728126428";
  const mainNet = { id: MAINNET, genesisHash: MAINNET_GENESIS, testnet: false } as const;
  const mainCtx = (
    w: World & { api: TronApi },
  ): { ctx: RouteContext; transitions: TrackedTransaction[] } => ctx(w, () => 1_000_000, mainNet);
  const mainWorld = (over: Partial<World> = {}): ReturnType<typeof world> =>
    world({
      blockIds: new Map([
        [0, MAINNET_GENESIS],
        [100, SOLID_ID],
      ]),
      ...over,
    });

  it("prepares and submits a send on mainnet", async () => {
    const w = mainWorld({ independent: { kind: "unavailable" } });
    const prepared = await prepareTron(mainCtx(w).ctx, params({ network: MAINNET }));
    expect(prepared.checks).toStrictEqual(["reads-unverified"]);
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.state).toBe("submitted");
    expect(w.signCalls).toBe(1);
  });

  it("flags a mainnet stake, approve, and dApp prepare the same way", async () => {
    const w = mainWorld({ independent: { kind: "unavailable" } });
    const c = mainCtx(w).ctx;
    const stake: Extract<ChainRequestInput, { method: "tron-stake" }> = {
      method: "tron-stake",
      account: ACCOUNT,
      network: MAINNET,
      action: { kind: "freeze", amount: 5_000_000n, resource: "bandwidth" },
    };
    const stakePrepared = await prepareTronStake(c, stake);
    expect(stakePrepared.checks).toContain("reads-unverified");
    const approve: Extract<ChainRequestInput, { method: "tron-approve" }> = {
      method: "tron-approve",
      account: ACCOUNT,
      network: MAINNET,
      token: TO,
      spender: TO,
      amount: 1_000_000n,
    };
    const approvePrepared = await prepareTronApprove(c, approve);
    expect(approvePrepared.checks).toContain("reads-unverified");
    const dappPrepared = await prepareDappTron(c, ACCOUNT, MAINNET, dappRaw());
    expect(dappPrepared.checks).toContain("reads-unverified");
    expect(w.signCalls).toBe(0);
  });

  it("still refuses a mainnet send whose answering node serves Nile's genesis", async () => {
    const w = mainWorld({
      blockIds: new Map([
        [0, GENESIS], // the node answers Nile's block 0
        [100, SOLID_ID],
      ]),
      independent: { kind: "unavailable" },
    });
    await expect(prepareTron(mainCtx(w).ctx, params({ network: MAINNET }))).rejects.toThrow(
      /serves another chain than tron:728126428/,
    );
    expect(w.signCalls).toBe(0);
  });

  it("rebuilds a stale mainnet transaction without a host endpoint", async () => {
    const wv = mainWorld();
    wv.independent = { kind: "available", source: "host", client: hostApi(wv) };
    const c = mainCtx(wv).ctx;
    const prepared = await prepareTron(c, params({ network: MAINNET }));
    // The reference block falls out of the node's view → staleReason goes through rebuild.
    wv.blockIds.delete(100);
    wv.independent = { kind: "unavailable" }; // the host endpoint is now gone
    await expect(prepared.staleReason()).resolves.toBeUndefined();
  });
});

describe("throttled pinned reads retry inside the validity window", () => {
  /* The world's answering node behind a real pinnedTronCaller: `reads` counts leading 503
     answers, `broadcast` answers the broadcast path with 429. The injected clock starts where
     the ctx's `now` puts the build window, and the `until` the flow hands down is the
     transaction's remaining validity — exactly what the controller builds in production. */
  const callerWorld = (
    net: { readonly id: string; readonly genesisHash: string; readonly testnet: boolean },
    throttle: { reads: number; broadcast: number },
  ): {
    w: ReturnType<typeof world>;
    c: { ctx: RouteContext; transitions: TrackedTransaction[] };
    sleeps: number[];
    broadcastCalls: number[];
  } => {
    const w = world({
      blockIds: new Map([
        [0, net.genesisHash],
        [100, SOLID_ID],
      ]),
      independent: { kind: "unavailable" },
    });
    const sleeps: number[] = [];
    const broadcastCalls: number[] = [];
    const clock = { v: 1_000_000 };
    const fetchFn: typeof globalThis.fetch = async (input, init) => {
      await Promise.resolve();
      const url = String(input);
      const path = url.slice(url.indexOf("/wallet"));
      if (path.includes("broadcast")) {
        broadcastCalls.push(1);
      }
      if (path.includes("broadcast") && throttle.broadcast > 0) {
        throttle.broadcast -= 1;
        return new Response("busy", { status: 429, headers: { "retry-after": "1" } });
      }
      if (throttle.reads > 0) {
        throttle.reads -= 1;
        return new Response("busy", { status: 503, headers: { "retry-after": "1" } });
      }
      const parsed = await w.answerNode(path, JSON.parse(String(init?.body ?? "{}")));
      return Response.json(parsed ?? {});
    };
    const pinned = (_network: string, until?: () => number): TronApi =>
      pinnedTronCaller(
        ["https://pin.test"],
        fetchFn,
        until === undefined
          ? undefined
          : {
              until,
              now: () => clock.v,
              sleep: async (ms) => {
                await Promise.resolve();
                sleeps.push(ms);
                clock.v += ms;
              },
            },
      );
    return { w, c: ctx(w, () => 1_000_000, net, pinned), sleeps, broadcastCalls };
  };

  it("a mainnet send whose pinned reads get 503 twice signs, waiting ≤ the stale bound", async () => {
    const { w, c, sleeps } = callerWorld(MAINNET_NET, { reads: 2, broadcast: 0 });
    const prepared = await prepareTron(c.ctx, params({ network: MAINNET_NET.id }));
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.state).toBe("submitted");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(40_000);
    expect(w.signCalls).toBe(1);
  });

  it("a persistently throttled read ends in TronThrottledError, still unsigned", async () => {
    const { w, c } = callerWorld(MAINNET_NET, { reads: Number.MAX_SAFE_INTEGER, broadcast: 0 });
    await expect(prepareTron(c.ctx, params({ network: MAINNET_NET.id }))).rejects.toThrow(
      TronThrottledError,
    );
    expect(w.signCalls).toBe(0);
  });

  it("a broadcast 429 at submit is not retried — the bytes may already be out", async () => {
    const { c, sleeps, broadcastCalls } = callerWorld(MAINNET_NET, { reads: 0, broadcast: 1 });
    const prepared = await prepareTron(c.ctx, params({ network: MAINNET_NET.id }));
    await prepared.submit(VERIFY, () => undefined);
    expect(sleeps).toStrictEqual([]);
    expect(broadcastCalls).toHaveLength(1);
  });
});
