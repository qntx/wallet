import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vite-plus/test";

import { tronAddressFromPublicKey, tronAddressToHex } from "@qntx/wallet-chains/tron";

import type { TronApi } from "../src/chains/tron.ts";
import type { Independent } from "../src/networks/controller.ts";
import type {
  AccountRef,
  ChainRequestInput,
  RouteContext,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { pollTron, prepareTronStake } from "../src/transactions/tron.ts";

/**
 * TRON stake operations: every pre-signing rule is served by a fake `TronApi`; the transaction is
 * built locally, decode-asserted, signed by the test key and tracked through the shared poller.
 */
const NET = "tron:3448148188";
const PRIV = new Uint8Array(32).fill(0x11);
const FROM = tronAddressFromPublicKey(secp256k1.getPublicKey(PRIV, false));
const RECEIVER = tronAddressFromPublicKey(
  secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), false),
);
const WITNESS = tronAddressFromPublicKey(
  secp256k1.getPublicKey(new Uint8Array(32).fill(0x33), false),
);
const CONTRACT = tronAddressFromPublicKey(
  secp256k1.getPublicKey(new Uint8Array(32).fill(0x44), false),
);
const SOLID_ID = "ab".repeat(32);
const ACCOUNT: AccountRef = { kind: "hd", walletId: "w", groupIndex: 0, template: "tron.bip44" };
const VERIFY = { kind: "password", password: "pw" } as never;

const CHAIN_PARAMETERS = {
  chainParameter: [
    { key: "getTransactionFee", value: 1000 },
    { key: "getEnergyFee", value: 210 },
    { key: "getCreateAccountFee", value: 100_000 },
    { key: "getCreateNewAccountFeeInSystemContract", value: 1_000_000 },
    { key: "getMaxFeeLimit", value: 5_000_000_000 },
    { key: "getCreateNewAccountBandwidthRate", value: 4 },
    { key: "getMaxCreateAccountTxSize", value: 5000 },
    { key: "getMaxDelegateLockPeriod", value: 86400 },
    { key: "getWitnessAllowanceFrozenTime", value: 1 },
  ],
};

type World = {
  account: Record<string, unknown>;
  accounts: Map<string, Record<string, unknown>>;
  resourceRow: Record<string, unknown>;
  unfreeze: Record<string, unknown>;
  maxSize: Record<string, unknown>;
  delegated: Record<string, unknown>;
  rewardBody: Record<string, unknown>;
  witnessList: ReadonlyArray<Record<string, unknown>>;
  broadcastBody: Record<string, unknown>;
  known: Set<string>;
  blockIds: Map<number, string>;
  solidInfo: Map<string, Record<string, unknown>>;
  fullInfo: Map<string, Record<string, unknown>>;
  headNumber: number;
  independent: Independent<TronApi>;
  signCalls: Uint8Array[];
};

const world = (over: Partial<World> = {}): World & { api: TronApi } => {
  const w: World = {
    account: { address: FROM, balance: 200_000_000 },
    accounts: new Map([[RECEIVER, { address: RECEIVER, balance: 0 }]]),
    resourceRow: { freeNetLimit: 600, tronPowerLimit: 10 },
    unfreeze: { count: 2 },
    maxSize: { max_size: 50_000_000 },
    delegated: {},
    rewardBody: { reward: 5_000_000 },
    // `listwitnesses` has no visible flag — the node answers `41…` hex.
    witnessList: [{ address: tronAddressToHex(WITNESS) }],
    broadcastBody: { result: true },
    known: new Set(),
    blockIds: new Map([[100, SOLID_ID]]),
    solidInfo: new Map(),
    fullInfo: new Map(),
    headNumber: 105,
    independent: { kind: "not-needed" },
    signCalls: [],
    ...over,
  };
  const api: TronApi = {
    post: async (path, body) => {
      await Promise.resolve();
      const b = body as Record<string, unknown>;
      switch (path) {
        case "/walletsolidity/getnowblock":
          return {
            blockID: SOLID_ID,
            block_header: { raw_data: { number: 100, timestamp: 900_000 } },
          };
        case "/wallet/getnowblock":
          return {
            blockID: "cd".repeat(32),
            block_header: { raw_data: { number: w.headNumber, timestamp: 910_000 } },
          };
        case "/wallet/getblockbynum":
        case "/walletsolidity/getblockbynum": {
          const id = w.blockIds.get(Number(b["num"]));
          return id === undefined
            ? {}
            : { blockID: id, block_header: { raw_data: { number: b["num"], timestamp: 900_000 } } };
        }
        case "/wallet/getchainparameters":
          return CHAIN_PARAMETERS;
        case "/wallet/getaccount":
          return b["address"] === FROM ? w.account : (w.accounts.get(String(b["address"])) ?? {});
        case "/wallet/getaccountresource":
          return w.resourceRow;
        case "/wallet/getavailableunfreezecount":
          return w.unfreeze;
        case "/wallet/getcandelegatedmaxsize":
          return w.maxSize;
        case "/wallet/getdelegatedresourcev2":
          return w.delegated;
        case "/wallet/getReward":
          return w.rewardBody;
        case "/wallet/listwitnesses":
          return { witnesses: w.witnessList };
        case "/wallet/broadcasthex":
          return { txid: "ee".repeat(32), ...w.broadcastBody };
        case "/wallet/gettransactionbyid":
          return w.known.has(String(b["value"])) ? { txID: String(b["value"]) } : {};
        case "/wallet/gettransactioninfobyid":
          return w.fullInfo.get(String(b["value"])) ?? {};
        case "/walletsolidity/gettransactioninfobyid":
          return w.solidInfo.get(String(b["value"])) ?? {};
        default:
          throw new Error(`unmocked ${path}`);
      }
    },
  };
  return { ...w, api };
};

const ctx = (
  w: World & { api: TronApi },
  now: () => number = () => 1_000_000,
): { ctx: RouteContext; transitions: TrackedTransaction[] } => {
  const transitions: TrackedTransaction[] = [];
  return {
    ctx: {
      options: {
        networks: {
          tronApi: () => w.api,
          independentTronApi: () => w.independent,
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
            const { request } = p;
            if (request.kind !== "tron.transaction" || !(request.rawData instanceof Uint8Array)) {
              throw new Error("wrong kind");
            }
            w.signCalls.push(request.rawData);
            const sig = secp256k1.sign(request.rawData, PRIV, {
              lowS: true,
              format: "recovered",
            });
            const out = new Uint8Array(65);
            out.set(sig.subarray(1), 0);
            out[64] = 27 + (sig[0] ?? 0);
            return { kind: "tron.transaction" as const, signature: out };
          },
        } as never,
      },
      transition: async (tx, next) => {
        const merged = { ...tx, ...next };
        transitions.push(merged);
        return Promise.resolve(merged);
      },
      track: () => {},
      txs: () => ({}),
      newId: () => "tx-stake",
    },
    transitions,
  };
};

type StakeAction = Extract<ChainRequestInput, { method: "tron-stake" }>["action"];
const hashOf = (tx: TrackedTransaction): string => {
  if (tx.hash === undefined) {
    throw new Error("no hash");
  }
  return tx.hash;
};
const input = (action: StakeAction): Extract<ChainRequestInput, { method: "tron-stake" }> => ({
  method: "tron-stake",
  account: ACCOUNT,
  network: NET,
  action,
});

const prepare = (action: StakeAction, over: Partial<World> = {}, now?: () => number) => {
  const w = world(over);
  return { w, prepared: prepareTronStake(ctx(w, now).ctx, input(action)) };
};

describe("freeze", () => {
  it("builds and decodes", async () => {
    const { prepared } = prepare(
      { kind: "freeze", amount: 5_000_000n, resource: "energy" },
      { account: { address: FROM, balance: 200_000_000 } },
    );
    const p = await prepared;
    expect(p.intent.summary).toBe("stake");
    expect(p.intent.staking).toStrictEqual([
      expect.objectContaining({ kind: "tron-freeze", resource: "energy" }),
    ]);
  });

  it("refuses below 1 TRX", async () => {
    await expect(
      prepare({ kind: "freeze", amount: 999_999n, resource: "bandwidth" }).prepared,
    ).rejects.toThrow(/at least 1 TRX/);
  });

  it("refuses when freeze plus the expected fee exceeds the balance", async () => {
    await expect(
      prepare(
        { kind: "freeze", amount: 200_000_000n, resource: "bandwidth" },
        // No free/staked bandwidth → the expected bandwidth burn (~300k sun) busts the balance.
        { account: { address: FROM, balance: 200_000_100 }, resourceRow: {} },
      ).prepared,
    ).rejects.toThrow(/does not cover/);
  });
});

describe("unfreeze", () => {
  const staked = {
    account: {
      address: FROM,
      balance: 200_000_000,
      frozenV2: [{ type: "ENERGY", amount: 10_000_000 }],
    },
  };

  it("builds and decodes", async () => {
    const p = await prepare({ kind: "unfreeze", amount: 4_000_000n, resource: "energy" }, staked)
      .prepared;
    expect(p.intent.staking).toStrictEqual([
      expect.objectContaining({ kind: "tron-unfreeze", resource: "energy" }),
    ]);
  });

  it("refuses more than the frozen amount", async () => {
    await expect(
      prepare({ kind: "unfreeze", amount: 10_000_001n, resource: "energy" }, staked).prepared,
    ).rejects.toThrow(/cannot unfreeze/);
  });

  it("refuses when no unfreeze slot is available", async () => {
    await expect(
      prepare(
        { kind: "unfreeze", amount: 1_000_000n, resource: "energy" },
        { ...staked, unfreeze: {} },
      ).prepared,
    ).rejects.toThrow(/no unfreeze slot/);
  });
});

describe("withdraw-expired and cancel-unfreeze", () => {
  const pending = (expire: number) => ({
    account: {
      address: FROM,
      balance: 200_000_000,
      unfrozenV2: [{ unfreeze_amount: 3_000_000, unfreeze_expire_time: expire }],
    },
  });

  it("withdraw builds when an entry expired", async () => {
    const p = await prepare({ kind: "withdraw-expired" }, pending(999_999)).prepared;
    expect(p.intent.staking).toStrictEqual([
      expect.objectContaining({ kind: "tron-withdraw-unfrozen" }),
    ]);
  });

  it("withdraw refuses while nothing expired", async () => {
    await expect(
      prepare({ kind: "withdraw-expired" }, pending(2_000_000)).prepared,
    ).rejects.toThrow(/no expired unfreeze/);
  });

  it("cancel builds on a non-empty queue and refuses an empty one", async () => {
    const p = await prepare({ kind: "cancel-unfreeze" }, pending(9_000_000)).prepared;
    expect(p.intent.staking).toStrictEqual([
      expect.objectContaining({ kind: "tron-cancel-unfreeze" }),
    ]);
    await expect(prepare({ kind: "cancel-unfreeze" }).prepared).rejects.toThrow(
      /no unfreeze entries/,
    );
  });
});

describe("delegate", () => {
  it("builds and decodes, with and without a lock", async () => {
    const unlocked = await prepare({
      kind: "delegate",
      receiver: RECEIVER,
      amount: 4_000_000n,
      resource: "bandwidth",
    }).prepared;
    expect(unlocked.intent.staking).toStrictEqual([
      expect.objectContaining({ kind: "tron-delegate", receiver: RECEIVER, resource: "bandwidth" }),
    ]);
    const locked = await prepare({
      kind: "delegate",
      receiver: RECEIVER,
      amount: 4_000_000n,
      resource: "energy",
      lockBlocks: 7200,
    }).prepared;
    expect(locked.intent.staking).toStrictEqual([
      expect.objectContaining({ kind: "tron-delegate", lock: { blocks: "7200" } }),
    ]);
  });

  it.each([999_999n, 0n])("refuses amount %s", async (amount) => {
    await expect(
      prepare({ kind: "delegate", receiver: RECEIVER, amount, resource: "bandwidth" }).prepared,
    ).rejects.toThrow(/at least 1 TRX/);
  });

  it.each([
    ["T1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxz", /not a TRON address/],
    [FROM, /cannot delegate to the sender/],
  ])("refuses receiver %s", async (receiver, pattern) => {
    await expect(
      prepare({ kind: "delegate", receiver, amount: 2_000_000n, resource: "bandwidth" }).prepared,
    ).rejects.toThrow(pattern);
  });

  it("refuses a missing or contract receiver", async () => {
    await expect(
      prepare({
        kind: "delegate",
        receiver: CONTRACT,
        amount: 2_000_000n,
        resource: "bandwidth",
      }).prepared,
    ).rejects.toThrow(/does not exist/);
    await expect(
      prepare(
        { kind: "delegate", receiver: CONTRACT, amount: 2_000_000n, resource: "bandwidth" },
        { accounts: new Map([[CONTRACT, { address: CONTRACT, type: "Contract" }]]) },
      ).prepared,
    ).rejects.toThrow(/contract/);
  });

  it("refuses above getcandelegatedmaxsize and past the lock bound", async () => {
    await expect(
      prepare(
        { kind: "delegate", receiver: RECEIVER, amount: 50_000_001n, resource: "bandwidth" },
        { account: { address: FROM, balance: 300_000_000 } },
      ).prepared,
    ).rejects.toThrow(/exceeds the available/);
    await expect(
      prepare({
        kind: "delegate",
        receiver: RECEIVER,
        amount: 2_000_000n,
        resource: "bandwidth",
        lockBlocks: 86_401,
      }).prepared,
    ).rejects.toThrow(/lock period/);
  });
});

describe("undelegate", () => {
  const delegated = {
    delegatedResource: [
      {
        from: "41".concat("00".repeat(20)),
        to: "41".concat("11".repeat(20)),
        frozen_balance_for_bandwidth: 6_000_000,
        expire_time_for_bandwidth: 0,
        frozen_balance_for_energy: 8_000_000,
        expire_time_for_energy: 9_000_000,
      },
    ],
  };

  it("builds and decodes within the unlocked amount", async () => {
    const p = await prepare(
      { kind: "undelegate", receiver: RECEIVER, amount: 5_000_000n, resource: "bandwidth" },
      { delegated },
    ).prepared;
    expect(p.intent.staking).toStrictEqual([
      expect.objectContaining({ kind: "tron-undelegate", receiver: RECEIVER }),
    ]);
  });

  it("refuses zero, more than unlocked, and still-locked energy", async () => {
    await expect(
      prepare(
        { kind: "undelegate", receiver: RECEIVER, amount: 0n, resource: "bandwidth" },
        { delegated },
      ).prepared,
    ).rejects.toThrow(/positive/);
    await expect(
      prepare(
        { kind: "undelegate", receiver: RECEIVER, amount: 6_000_001n, resource: "bandwidth" },
        { delegated },
      ).prepared,
    ).rejects.toThrow(/exceeds the unlocked/);
    // The energy delegation is locked until 9_000_000 (now = 1_000_000) — nothing is unlocked.
    await expect(
      prepare(
        { kind: "undelegate", receiver: RECEIVER, amount: 1n, resource: "energy" },
        { delegated },
      ).prepared,
    ).rejects.toThrow(/exceeds the unlocked/);
  });
});

describe("vote", () => {
  const vote = (votes: Array<{ witness: string; count: bigint }>) =>
    prepare({ kind: "vote", votes });

  it("builds and decodes", async () => {
    const p = await vote([{ witness: WITNESS, count: 4n }]).prepared;
    expect(p.intent.staking).toStrictEqual([
      expect.objectContaining({
        kind: "tron-vote",
        votes: [{ witness: WITNESS, count: "4" }],
      }),
    ]);
  });

  it.each([0, 31])("refuses %s entries", async (n) => {
    const votes = Array.from({ length: n }, () => ({ witness: WITNESS, count: 1n }));
    await expect(vote(votes).prepared).rejects.toThrow(/1\.\.30/);
  });

  it("refuses a zero count, an unlisted witness and a total above tron power", async () => {
    await expect(vote([{ witness: WITNESS, count: 0n }]).prepared).rejects.toThrow(/positive/);
    await expect(vote([{ witness: RECEIVER, count: 1n }]).prepared).rejects.toThrow(
      /not a witness/,
    );
    await expect(vote([{ witness: WITNESS, count: 11n }]).prepared).rejects.toThrow(/tron power/);
  });
});

describe("claim-rewards", () => {
  it("builds and decodes past the claim period", async () => {
    const p = await prepare({ kind: "claim-rewards" }, {}, () => 200_000_000_000).prepared;
    expect(p.intent.staking).toStrictEqual([
      expect.objectContaining({ kind: "tron-claim-rewards" }),
    ]);
  });

  it("refuses without reward or inside the claim period", async () => {
    await expect(prepare({ kind: "claim-rewards" }, { rewardBody: {} }).prepared).rejects.toThrow(
      /no reward/,
    );
    await expect(
      prepare(
        { kind: "claim-rewards" },
        { account: { address: FROM, balance: 200_000_000, latest_withdraw_time: 999_000 } },
        () => 1_000_000,
      ).prepared,
    ).rejects.toThrow(/claim period/);
  });
});

const otherBlock = (w: World & { api: TronApi }): TronApi => ({
  post: async (path, body) => {
    if (path === "/walletsolidity/getblockbynum" || path === "/wallet/getblockbynum") {
      return {
        blockID: "ff".repeat(32),
        block_header: { raw_data: { number: 100, timestamp: 900_000 } },
      };
    }
    await Promise.resolve();
    return w.api.post(path, body);
  },
});

describe("cross-check and tracking", () => {
  it("refuses when the endpoints disagree on the reference block", async () => {
    const w = world();
    w.independent = { kind: "available", client: otherBlock(w) };
    await expect(
      prepareTronStake(
        ctx(w).ctx,
        input({ kind: "freeze", amount: 5_000_000n, resource: "bandwidth" }),
      ),
    ).rejects.toThrow(/disagree on the reference block/);
  });

  it("submits a freeze and polls it to final", async () => {
    const w = world();
    const { ctx: c, transitions } = ctx(w);
    const prepared = await prepareTronStake(
      c,
      input({ kind: "freeze", amount: 5_000_000n, resource: "bandwidth" }),
    );
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.state).toBe("submitted");
    const txid = hashOf(tx);
    // Included on the full node at 104, solid head at 100 → confirmed, not final.
    w.fullInfo.set(txid, {
      id: txid,
      blockNumber: 104,
      blockTimeStamp: 910_000,
      fee: 0,
      receipt: { result: "SUCCESS" },
    });
    const first = await pollTron(c, tx);
    expect(first).toMatchObject({ kind: "included", state: "confirmed", final: false });
    // The solidity node confirms → final.
    w.blockIds.set(104, "dd".repeat(32));
    w.solidInfo.set(txid, {
      id: txid,
      blockNumber: 104,
      blockTimeStamp: 910_000,
      fee: 0,
      receipt: { result: "SUCCESS" },
    });
    w.headNumber = 104;
    const second = await pollTron(c, tx);
    expect(second).toMatchObject({ kind: "included", final: true });
    expect(transitions.at(-1)?.tron?.expiration).toBeDefined();
  });
});
