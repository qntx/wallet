import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { describe, expect, it, vi } from "vite-plus/test";
import { createStore } from "zustand/vanilla";

import type { Event } from "@qntx/nostr";
import { encodeSparkAddress } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { RequestController } from "../src/requests/controller.ts";
import type { RequestInput } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { DepositClaimer } from "../src/spark/deposit-claim.ts";
import { SPARK_L1_NETWORK } from "../src/spark/l1.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type {
  AccountRef,
  PrepareParams,
  PreparedRequest,
  SparkDepositTag,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { bookDeps, simulateSolanaStub, tokensStub, realTimer } from "./send-helpers.ts";

const MAINNET_L1 = "bip122:000000000019d6689c085ae165831e93";
const REGTEST_L1 = "bip122:0f9188f13cb7b2c71f2a335e3a4fc328";
const SPARK: SparkAccountRef = { walletId: "w", groupIndex: 1, network: "mainnet" };
const FROM: AccountRef = { kind: "hd", walletId: "w", groupIndex: 1, template: "btc.bip84" };
const DEPOSIT_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const RECEIVE_ADDRESS = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
const VERIFY = { kind: "password", password: "pw" } as const;
const SPARK_ADDRESS = encodeSparkAddress({
  network: "mainnet",
  identityPublicKey: secp256k1.getPublicKey(new Uint8Array(32).fill(9), true),
});

const intentOf = (to: string) =>
  ({
    family: "bitcoin",
    network: MAINNET_L1,
    summary: "transfer",
    outflows: [{ to, amount: { asset: "btc", amount: "1000", decimals: 8 }, verified: true }],
    approvals: [],
    fee: undefined,
    warnings: [],
    verifiability: "full",
  }) as unknown as PreparedRequest["intent"];

function rig() {
  const sends: Array<{ params: PrepareParams; tag: SparkDepositTag | undefined }> = [];
  const calls: string[] = [];
  const transactions = {
    getState: () => ({ txs: {} }),
    prepareSend: async (
      params: PrepareParams,
      requestId: string,
      tag?: SparkDepositTag,
    ): Promise<PreparedRequest> => {
      sends.push({ params, tag });
      return Promise.resolve({
        txId: `tx-${requestId}`,
        account: params.account,
        network: params.network,
        intent: intentOf(params.to),
        checks: [],
        staleReason: () => undefined,
        submit: async () =>
          Promise.resolve({
            id: `tx-${requestId}`,
            family: "bitcoin",
            network: params.network,
            account: "w",
            hash: "ab".repeat(32),
            state: "submitted",
            intent: undefined,
            nonce: 0,
            ...(tag === undefined ? {} : { sparkDeposit: tag }),
            submittedAt: 0,
            error: undefined,
          } satisfies TrackedTransaction),
        release: () => {
          calls.push(`release ${requestId}`);
        },
      });
    },
    nextReceiveAddress: async (walletId: string, groupIndex: number, network: string) => {
      calls.push(`receive ${walletId}/${groupIndex}/${network}`);
      return Promise.resolve(RECEIVE_ADDRESS);
    },
  } as unknown as TransactionController;
  const spark = {
    newDepositAddress: async (ref: SparkAccountRef) => {
      calls.push(`deposit-address ${ref.groupIndex}`);
      return Promise.resolve(DEPOSIT_ADDRESS);
    },
    withdraw: async (_ref: SparkAccountRef, params: { address: string }) => {
      calls.push(`withdraw ${params.address}`);
      return Promise.resolve({ id: "exit-1" });
    },
  } as unknown as SparkController;
  let counter = 0;
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark,
    nostrSign: async (_ref, _event): Promise<Event> => {
      await Promise.resolve();
      throw new Error("nostr-sign is not wired in this test");
    },
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => {
      await Promise.resolve();
      throw new Error("solana-sign is not wired in this test");
    },
    fetch: globalThis.fetch,
    random: (n) => {
      counter += 1;
      return new Uint8Array(n).fill(counter);
    },
    now: () => 1000,
    setTimer: realTimer,
    logger: { warn: () => undefined },
  });
  return { requests, sends, calls };
}

const deposit = (over: Partial<Extract<RequestInput, { method: "spark-deposit" }>> = {}) =>
  ({
    method: "spark-deposit",
    account: SPARK,
    from: FROM,
    amountSats: 50_000,
    fee: "normal",
    ...over,
  }) as const;

describe("spark deposit request", () => {
  it("sends to a fresh deposit address and the transaction carries the tag", async () => {
    const r = rig();
    await r.requests.init();
    const request = await r.requests.prepare(deposit());
    expect(request.method).toBe("spark-deposit");
    expect(request.target).toBeUndefined();
    expect(request.network).toBe(MAINNET_L1);
    expect(r.sends).toStrictEqual([
      {
        params: {
          account: FROM,
          network: MAINNET_L1,
          to: DEPOSIT_ADDRESS,
          amount: 50_000n,
          fee: "normal",
        },
        tag: { walletId: "w", groupIndex: 1, network: "mainnet" },
      },
    ]);
    const tx = await r.requests.approve(request.id, "spark-deposit", VERIFY);
    expect(tx.sparkDeposit).toStrictEqual({ walletId: "w", groupIndex: 1, network: "mainnet" });
  });

  it("is not assessed for recipient risk", async () => {
    const r = rig();
    await r.requests.init();
    const request = await r.requests.prepare(deposit());
    expect(request.risk).toStrictEqual([]);
  });

  it("rejects a Spark network with no bitcoin counterpart", async () => {
    const r = rig();
    await r.requests.init();
    await expect(
      r.requests.prepare(deposit({ account: { ...SPARK, network: "testnet" as never } })),
    ).rejects.toThrow("unknown Spark network");
    expect(r.sends).toHaveLength(0);
  });

  it("rejects a bitcoin account from another wallet", async () => {
    const r = rig();
    await r.requests.init();
    await expect(
      r.requests.prepare(deposit({ from: { ...FROM, walletId: "other" } })),
    ).rejects.toThrow("same wallet");
    expect(r.sends).toHaveLength(0);
  });
});

describe("spark exit request", () => {
  const exit = (over: Partial<Extract<RequestInput, { method: "spark-exit" }>> = {}) =>
    ({
      method: "spark-exit",
      account: SPARK,
      amountSats: 100_000,
      maxFeeSats: 500,
      ...over,
    }) as const;

  it("exits to the group's next unused receive address and shows an exit", async () => {
    const r = rig();
    await r.requests.init();
    const request = await r.requests.prepare(exit());
    expect(r.calls).toContain(`receive w/1/${MAINNET_L1}`);
    expect(request.display).toMatchObject({
      family: "spark",
      kind: "exit",
      amountSats: 100_000,
      maxFeeSats: 500,
      receiver: RECEIVE_ADDRESS,
    });
    expect(request.risk).toStrictEqual([]);
    expect(request.checks).toStrictEqual([]);
    await r.requests.approve(request.id, "spark-exit", VERIFY);
    expect(r.calls).toContain(`withdraw ${RECEIVE_ADDRESS}`);
  });

  it("records fee-exceeds-amount when the fee ceiling reaches the amount", async () => {
    const r = rig();
    await r.requests.init();
    const request = await r.requests.prepare(exit({ amountSats: 1000, maxFeeSats: 1000 }));
    expect(request.checks).toStrictEqual(["fee-exceeds-amount"]);
  });

  it("an unrelated Spark transfer still gets the recipient check", async () => {
    const r = rig();
    await r.requests.init();
    const request = await r.requests.prepare({
      method: "pay",
      account: SPARK,
      option: { kind: "spark", address: SPARK_ADDRESS },
      amountSats: 5,
    });
    expect(request.risk).toStrictEqual([{ code: "first-recipient", level: "warning" }]);
  });
});

describe("network table", () => {
  it("maps each Spark network to its bitcoin network", () => {
    expect(SPARK_L1_NETWORK).toStrictEqual({ mainnet: MAINNET_L1, regtest: REGTEST_L1 });
  });
});

const TX_HEX = "02000000000101aa";

function claimerRig(txs: Record<string, TrackedTransaction>) {
  const store = createStore<{ txs: Record<string, TrackedTransaction> }>(() => ({ txs }));
  const marked: string[] = [];
  const transactions = {
    store,
    getState: () => store.getState(),
    markDepositClaimed: async (id: string) => {
      marked.push(id);
      const tx = store.getState().txs[id];
      if (tx?.sparkDeposit !== undefined) {
        store.setState({
          txs: {
            ...store.getState().txs,
            [id]: { ...tx, sparkDeposit: { ...tx.sparkDeposit, claimed: true } },
          },
        });
      }
      return Promise.resolve();
    },
  } as unknown as TransactionController;
  const claims: Array<{ ref: SparkAccountRef; bytes: string }> = [];
  const state = { failures: 0 };
  const spark = {
    claimDeposit: async (ref: SparkAccountRef, bytes: Uint8Array) => {
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error("not enough confirmations");
      }
      claims.push({ ref, bytes: hex.encode(bytes) });
      return Promise.resolve();
    },
  } as unknown as SparkController;
  const fetched: string[] = [];
  const networks = {
    esplora: () => ({
      get: async (path: string) => {
        fetched.push(path);
        return Promise.resolve(TX_HEX);
      },
    }),
  } as never;
  const claimer = new DepositClaimer({
    setTimer: realTimer,
    transactions,
    spark,
    networks,
    logger: { warn: () => undefined },
  });
  return { store, marked, claims, fetched, claimer, state, transactions, spark, networks };
}

const depositTx = (state: TrackedTransaction["state"], claimed?: boolean): TrackedTransaction => ({
  id: "t1",
  family: "bitcoin",
  network: MAINNET_L1,
  account: "w",
  hash: "cd".repeat(32),
  state,
  intent: undefined,
  nonce: 0,
  sparkDeposit: {
    walletId: "w",
    groupIndex: 1,
    network: "mainnet",
    ...(claimed === undefined ? {} : { claimed }),
  },
  submittedAt: 0,
  error: undefined,
});

const plainTx = (id: string): TrackedTransaction => {
  const { sparkDeposit: _tag, ...rest } = depositTx("confirmed");
  return { ...rest, id };
};

describe("deposit persistence", () => {
  it("keeps the tag and the claimed flag across a restart", async () => {
    const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
    const open = () => {
      const store = createMemoryEngineStore(backing);
      return new TransactionController({
        wallet: {} as never,
        networks: {} as never,
        openStore: async () => Promise.resolve(store),
        random: (n) => new Uint8Array(n),
        setTimer: realTimer,
        now: () => 0,
        logger: { warn: () => undefined },
      });
    };
    const first = open();
    await first.init();
    const tx = depositTx("confirmed");
    backing.collections.set(
      "transactions",
      new Map([[tx.id, new TextEncoder().encode(JSON.stringify(tx))]]),
    );
    first.lock();
    const second = open();
    await second.init();
    expect(second.getState().txs["t1"]?.sparkDeposit).toStrictEqual(tx.sparkDeposit);
    await second.markDepositClaimed("t1");
    second.lock();
    const third = open();
    await third.init();
    expect(third.getState().txs["t1"]?.sparkDeposit?.claimed).toBe(true);
    await expect(third.markDepositClaimed("nope")).rejects.toThrow("not a Spark deposit");
  });
});

describe("deposit claiming", () => {
  it("claims once the transaction confirms, exactly once", async () => {
    const c = claimerRig({ t1: depositTx("submitted") });
    c.claimer.start();
    await Promise.resolve();
    expect(c.claims).toHaveLength(0);
    c.store.setState({ txs: { t1: depositTx("pending") } });
    expect(c.claims).toHaveLength(0);
    c.store.setState({ txs: { t1: depositTx("confirmed") } });
    await vi.waitFor(() => {
      expect(c.marked).toStrictEqual(["t1"]);
    });
    expect(c.claims).toStrictEqual([
      { ref: { walletId: "w", groupIndex: 1, network: "mainnet" }, bytes: TX_HEX },
    ]);
    expect(c.fetched).toStrictEqual([`/tx/${"cd".repeat(32)}/hex`]);
    c.store.setState({ txs: { t1: depositTx("confirmed", true) } });
    await Promise.resolve();
    expect(c.claims).toHaveLength(1);
    c.claimer.stop();
  });

  it("retries a failed claim with backoff", async () => {
    vi.useFakeTimers();
    const c = claimerRig({ t1: depositTx("confirmed") });
    c.state.failures = 2;
    c.claimer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.claims).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.claims).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.claims).toHaveLength(1);
    expect(c.marked).toStrictEqual(["t1"]);
    c.claimer.stop();
    vi.useRealTimers();
  });

  it("resumes confirmed, unclaimed deposits after a restart and skips claimed ones", async () => {
    const c = claimerRig({
      t1: depositTx("confirmed"),
      t2: { ...depositTx("confirmed", true), id: "t2" },
      t3: plainTx("t3"),
    });
    c.claimer.start();
    await vi.waitFor(() => {
      expect(c.marked).toStrictEqual(["t1"]);
    });
    expect(c.claims).toHaveLength(1);
    c.claimer.stop();
  });

  it("stops retrying when stopped", async () => {
    vi.useFakeTimers();
    const c = claimerRig({ t1: depositTx("confirmed") });
    c.state.failures = 100;
    c.claimer.start();
    await vi.advanceTimersByTimeAsync(0);
    c.claimer.stop();
    c.state.failures = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.claims).toHaveLength(0);
    vi.useRealTimers();
  });
});
