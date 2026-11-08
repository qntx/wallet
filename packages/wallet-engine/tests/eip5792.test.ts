import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import { EVM_DELEGATOR } from "@qntx/wallet-chains/evm";
import type { chains } from "@qntx/wallet/chains";

import { ConnectionController } from "../src/connect/controller.ts";
import { Eip1193Handler } from "../src/connect/eip1193.ts";
import { ProviderError } from "../src/connect/errors.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import {
  bookDeps,
  idleNetworkDeps,
  simulateSolanaStub,
  simulateV1Result,
  tokensStub,
} from "./send-helpers.ts";

const DELEGATOR = EVM_DELEGATOR.address;
const CODE = readFileSync(
  new URL("fixtures/eip7702-stateless-delegator-1.3.0.hex", import.meta.url).pathname,
  "utf8",
).trim();
const N1 = "eip155:1";
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const HOST = "https://host.test/evm";
const GATEWAY = "https://gw.test";
const SITE = "https://app.example";
const OTHER = "https://other.example";
const TARGET = "0x00000000000000000000000000000000c0ffee00";
const TARGET2 = "0x0000000000000000000000000000000000000fee";
const logger = { warn: () => undefined };

type Rpc = Record<string, unknown>;
type CodeOf = (address: string) => string;
const designator = (address: string) => `0xef0100${address.slice(2)}`;
const none: CodeOf = (a) => (a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : "0x");
const ours: CodeOf = (a) =>
  a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : designator(DELEGATOR);
const other: CodeOf = (a) =>
  a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : designator(ADDR);

const CALL = { to: TARGET, data: "0x", value: "0x0" };
const BATCH = [CALL, { to: TARGET2, data: "0x", value: "0x1" }];
const SEND_PARAMS = {
  version: "2.0.0",
  chainId: "0x1",
  atomicRequired: false,
  calls: BATCH,
};

const txOf = (state: TrackedTransaction["state"], hash?: string): TrackedTransaction =>
  ({
    id: `tx-${hash ?? state}`,
    family: "evm",
    network: N1,
    account: ADDR,
    hash,
    state,
    intent: undefined,
    nonce: 0,
  }) as TrackedTransaction;

function world(options: { code?: CodeOf; independent?: CodeOf } = {}) {
  const code = options.code ?? none;
  const independent = options.independent ?? code;
  const base: Rpc = {
    eth_chainId: 1,
    eth_blockNumber: "0x1",
    eth_getTransactionCount: "0x0",
    eth_estimateGas: "0x5208",
    eth_call: `0x${"00".repeat(32)}`,
    eth_feeHistory: { baseFeePerGas: ["0x64", "0x64"], reward: [["0x1", "0x2", "0x3"]] },
    eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
    eth_getTransactionReceipt: {
      status: "0x1",
      blockNumber: "0x1",
      blockHash: `0x${"cc".repeat(32)}`,
      gasUsed: "0x5208",
      logs: [{ address: TARGET, data: "0x", topics: [`0x${"11".repeat(32)}`] }],
    },
    eth_getBlockByNumber: { number: "0x2" },
  };
  const signedRequests: SignRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Response.json({ networks: [N1] });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown;
    };
    if (body.method === "eth_getCode") {
      const table = url.startsWith(GATEWAY) ? independent : code;
      const p = (body.params as unknown[] | undefined)?.[0];
      const result = typeof p === "string" ? table(p) : "0x";
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    }
    if (body.method === "eth_simulateV1") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: simulateV1Result(body.params) });
    }
    return body.method in base
      ? Response.json({ jsonrpc: "2.0", id: 1, result: base[body.method] })
      : Response.json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: body.method } });
  };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const openStore = async () => Promise.resolve(createMemoryEngineStore(backing));
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [N1]: [HOST] },
    openStore,
    logger,
    gateway: { url: GATEWAY, installId: "a".repeat(32) },
  });
  const apis = {
    account: async () => Promise.resolve({ template: "evm.bip44", network: N1, address: ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      signedRequests.push(request);
      return Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array(1) });
    },
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    wallet: {} as Wallet,
    networks,
    openStore,
    random: (n) => new Uint8Array(n).fill(3),
    setTimer: () => () => undefined,
    now: () => 1000,
    logger,
    pollMs: 1,
    chains: apis,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: {} as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: fetchImpl,
    random: (n) => new Uint8Array(n).fill(4),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  let counter = 0;
  const fresh = (n: number) => {
    counter += 1;
    return new Uint8Array(n).fill(counter % 251);
  };
  const connections = new ConnectionController({
    phishing: { check: () => "clear" },
    setTimer: () => () => undefined,
    openStore,
    random: fresh,
    now: () => 0,
    logger,
    allowLocalhost: false,
    selectedGroup: () => ({ walletId: "0a".repeat(8), groupIndex: 0 }),
    evmAddress: async () => Promise.resolve(ADDR),
    enabledNetworks: () => [N1],
    bitcoinAddress: async () => Promise.resolve("bc1qunused"),
    solanaAddress: async () => Promise.resolve("SoLaNaAdd0"),
    nostrPubkey: async () => Promise.resolve(`npub${"0".repeat(62)}`),
    invalidate: () => undefined,
  });
  const shown: Array<{ origin: string; txIds: ReadonlyArray<string> }> = [];
  const txMap = new Map<string, TrackedTransaction>();
  const handler = new Eip1193Handler({
    connections,
    requests,
    networks,
    defaultNetwork: () => N1,
    isTracked: () => false,
    delegationState: async (account, network) => transactions.delegationState(account, network),
    batches: {
      record: async (record) => transactions.recordBatch(record),
      get: (origin, id) => transactions.batchById(origin, id),
    },
    txById: (id) => txMap.get(id) ?? transactions.txById(id),
    showCallsStatus: (req) => shown.push(req),
    now: () => 0,
    random: fresh,
  });
  const start = async () => {
    await networks.init();
    await transactions.init();
    await connections.init();
    await requests.init();
  };
  const connect = async (origin = SITE) => {
    const accounts = handler.handle(origin, { method: "eth_requestAccounts" });
    await vi.waitFor(() => {
      expect(connections.pending().some((p) => p.origin.origin === origin)).toBe(true);
    });
    const pending = connections.pending().find((p) => p.origin.origin === origin);
    await connections.approveConnection(pending?.id ?? "", { accounts: [ADDR], network: N1 });
    return (await accounts) as ReadonlyArray<string>;
  };
  const approveNext = async () => {
    await vi.waitFor(() => {
      expect(
        Object.values(requests.getState().requests).some((r) => r.stage === "awaiting-approval"),
      ).toBe(true);
    });
    const request = Object.values(requests.getState().requests).find(
      (r) => r.stage === "awaiting-approval",
    );
    // oxlint-disable-next-line unicorn/prefer-ternary -- dispatch on the pending method
    if (request?.method === "evm-batch") {
      await requests.approve(request.id, "evm-batch", { kind: "password", password: "pw" });
    } else {
      await requests.approve(request?.id ?? "", "evm-sign", { kind: "password", password: "pw" });
    }
  };
  return {
    transactions,
    requests,
    connections,
    handler,
    signedRequests,
    shown,
    txMap,
    backing,
    start,
    connect,
    approveNext,
  };
}

const code = (error: unknown): number => (error instanceof ProviderError ? error.code : -1);

describe("wallet_getCapabilities", () => {
  it("reports supported on a delegated account, ready on a supported none, unsupported on other", async () => {
    const w = world({ code: ours });
    await w.start();
    await w.connect();
    const caps = (await w.handler.handle(SITE, {
      method: "wallet_getCapabilities",
      params: [ADDR],
    })) as Record<string, { atomic: { status: string } }>;
    expect(caps["0x1"]?.atomic.status).toBe("supported");

    const ready = world({ code: none });
    await ready.start();
    await ready.connect();
    const caps2 = (await ready.handler.handle(SITE, {
      method: "wallet_getCapabilities",
      params: [ADDR],
    })) as Record<string, { atomic: { status: string } }>;
    expect(caps2["0x1"]?.atomic.status).toBe("ready");

    const foreign = world({ code: other });
    await foreign.start();
    await foreign.connect();
    const caps3 = (await foreign.handler.handle(SITE, {
      method: "wallet_getCapabilities",
      params: [ADDR],
    })) as Record<string, { atomic: { status: string } }>;
    expect(caps3["0x1"]?.atomic.status).toBe("unsupported");
  });

  it("unconnected address rejects with 4100; explicit chain ids are honoured", async () => {
    const w = world({ code: none });
    await w.start();
    await w.connect();
    const error = await w.handler
      .handle(SITE, {
        method: "wallet_getCapabilities",
        params: ["0x0000000000000000000000000000000000000001"],
      })
      .then(
        () => -1,
        (error_: unknown) => code(error_),
      );
    expect(error).toBe(4100);
    const caps = (await w.handler.handle(SITE, {
      method: "wallet_getCapabilities",
      params: [ADDR, ["0x1", "0xaa36a7"]],
    })) as Record<string, unknown>;
    expect(new Set(Object.keys(caps))).toStrictEqual(new Set(["0x1", "0xaa36a7"]));
    expect((caps["0xaa36a7"] as { atomic: { status: string } }).atomic.status).toBe("unsupported");
  });
});

describe("wallet_sendCalls", () => {
  it("rejects a bad version, a mismatched chain, a non-connected from, a non-optional capability", async () => {
    const w = world();
    await w.start();
    await w.connect();
    const err = async (params: unknown[]) =>
      w.handler.handle(SITE, { method: "wallet_sendCalls", params }).then(
        () => -1,
        (error: unknown) => code(error),
      );
    await expect(err([{ ...SEND_PARAMS, version: "1.0.0" }])).resolves.toBe(-32602);
    await expect(err([{ ...SEND_PARAMS, chainId: "0xa" }])).resolves.toBe(5710);
    await expect(
      err([{ ...SEND_PARAMS, from: "0x0000000000000000000000000000000000000001" }]),
    ).resolves.toBe(4100);
    await expect(err([{ ...SEND_PARAMS, atomicRequired: "yes" }])).resolves.toBe(-32602);
    await expect(
      err([{ ...SEND_PARAMS, capabilities: { paymasterService: { url: "x" } } }]),
    ).resolves.toBe(5700);
    await expect(err([{ calls: [] }])).resolves.toBe(-32602);
    await expect(
      err([{ ...SEND_PARAMS, calls: Array.from({ length: 11 }, () => CALL) }]),
    ).resolves.toBe(5740);
  });

  it("a dApp-supplied id must be unique per origin: the second use is 5720", async () => {
    const w = world({ code: ours });
    await w.start();
    await w.connect();
    const first = w.handler.handle(SITE, {
      method: "wallet_sendCalls",
      params: [{ ...SEND_PARAMS, id: "bundle-1" }],
    });
    await w.approveNext();
    await expect(first).resolves.toStrictEqual({ id: "bundle-1" });
    const error = await w.handler
      .handle(SITE, {
        method: "wallet_sendCalls",
        params: [{ ...SEND_PARAMS, id: "bundle-1" }],
      })
      .then(
        () => -1,
        (error_: unknown) => code(error_),
      );
    expect(error).toBe(5720);
  });

  it("one call routes through evm-sign; a batch on ours sends one eip7702 batch", async () => {
    const single = world();
    await single.start();
    await single.connect();
    const one = single.handler.handle(SITE, {
      method: "wallet_sendCalls",
      params: [{ ...SEND_PARAMS, calls: [CALL] }],
    });
    await single.approveNext();
    const result = (await one) as { id: string };
    expect(result.id).toBeTypeOf("string");
    expect(single.signedRequests).toHaveLength(1);

    const batched = world({ code: ours });
    await batched.start();
    await batched.connect();
    const batch = batched.handler.handle(SITE, {
      method: "wallet_sendCalls",
      params: [SEND_PARAMS],
    });
    await batched.approveNext();
    const record = (await batch) as { id: string };
    expect(record.id).toBeTypeOf("string");
    const intent = batched.signedRequests[0] as { tx?: { type?: string } };
    expect(intent.tx?.type).toBe("eip1559");
    expect(batched.shown).toHaveLength(0);
  });

  it("a batch on none upgrades with the delegation authorization", async () => {
    const w = world({ code: none });
    await w.start();
    await w.connect();
    const batch = w.handler.handle(SITE, {
      method: "wallet_sendCalls",
      params: [SEND_PARAMS],
    });
    await w.approveNext();
    await batch;
    const { tx } = w.signedRequests[0] as {
      tx?: { type?: string; authorization?: { address: string } };
    };
    expect(tx?.type).toBe("eip7702");
    expect(tx?.authorization?.address).toBe(DELEGATOR);
  });

  it("an other-delegated page falls back to sequential; atomicRequired gets 5760", async () => {
    const w = world({ code: other });
    await w.start();
    await w.connect();
    const error = await w.handler
      .handle(SITE, {
        method: "wallet_sendCalls",
        params: [{ ...SEND_PARAMS, atomicRequired: true }],
      })
      .then(
        () => -1,
        (error_: unknown) => code(error_),
      );
    expect(error).toBe(5760);

    const sequential = w.handler.handle(SITE, {
      method: "wallet_sendCalls",
      params: [SEND_PARAMS],
    });
    await w.approveNext();
    await w.approveNext();
    const record = (await sequential) as { id: string };
    expect(record.id).toBeTypeOf("string");
    expect(w.signedRequests).toHaveLength(2);
    /* The sequential fallback is not atomic — two independent evm-sign transactions. */
    const status = (await w.handler.handle(SITE, {
      method: "wallet_getCallsStatus",
      params: [record.id],
    })) as { atomic: boolean };
    expect(status.atomic).toBe(false);
  });

  it("a mid-way sequential rejection still returns the id with the submitted prefix", async () => {
    const w = world({ code: other });
    await w.start();
    await w.connect();
    const sequential = w.handler.handle(SITE, {
      method: "wallet_sendCalls",
      params: [{ ...SEND_PARAMS, calls: [...BATCH, CALL] }],
    });
    await w.approveNext();
    await vi.waitFor(() => {
      expect(
        Object.values(w.requests.getState().requests).some((r) => r.stage === "awaiting-approval"),
      ).toBe(true);
    });
    const pending = Object.values(w.requests.getState().requests).find(
      (r) => r.stage === "awaiting-approval",
    );
    // oxlint-disable-next-line vitest/no-conditional-in-test -- narrowing find
    w.requests.reject(pending?.id ?? "");
    const result = (await sequential) as { id: string };
    expect(result.id).toBeTypeOf("string");
    expect(w.signedRequests).toHaveLength(1);
  });
});

describe("wallet_getCallsStatus and wallet_showCallsStatus", () => {
  const recordBatch = async (
    w: ReturnType<typeof world>,
    txIds: string[],
    atomic = true,
    id = "b-1",
    expected?: number,
  ) =>
    w.transactions.recordBatch({
      origin: SITE,
      id,
      network: N1,
      atomic,
      txIds,
      expected: expected ?? txIds.length,
      createdAt: 0,
    });

  it.each([
    [["submitted"], undefined, 100],
    [["confirmed"], "0xab", 200],
    [["dropped"], undefined, 400],
    [["dropped"], "0xab", 400],
    [["replaced"], "0xab", 400],
    [["failed"], undefined, 400],
    [["failed"], "0xab", 500],
    [["confirmed", "failed"], "0xab", 600],
  ] as const)("state %s gives status %d", async (states, hash, status) => {
    const w = world();
    await w.start();
    await w.connect();
    const txIds = states.map((_s, i) => `t${i}`);
    for (const [i, s] of states.entries()) {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- spread hash suffix
      w.txMap.set(`t${i}`, txOf(s, hash === undefined ? undefined : `${hash}${i}`));
    }
    await recordBatch(w, txIds);
    const reply = (await w.handler.handle(SITE, {
      method: "wallet_getCallsStatus",
      params: ["b-1"],
    })) as { status: number; atomic: boolean; receipts?: unknown[] };
    expect(reply.status).toBe(status);
    expect(reply.atomic).toBe(true);
  });

  it("an unknown or foreign bundle id is 5730; show passes the tx ids to the host", async () => {
    const w = world();
    await w.start();
    await w.connect();
    await w.connect(OTHER);

    await recordBatch(w, ["a"], true, "mine");
    const error = await w.handler
      .handle(OTHER, { method: "wallet_getCallsStatus", params: ["mine"] })
      .then(
        () => -1,
        (error_: unknown) => code(error_),
      );
    expect(error).toBe(5730);
    const unknown = await w.handler
      .handle(SITE, { method: "wallet_getCallsStatus", params: ["nope"] })
      .then(
        () => -1,
        (error_: unknown) => code(error_),
      );
    expect(unknown).toBe(5730);
    const reply = await w.handler.handle(SITE, {
      method: "wallet_showCallsStatus",
      params: ["mine"],
    });
    expect(reply).toBeNull();
    expect(w.shown).toStrictEqual([{ origin: SITE, txIds: ["a"] }]);
  });

  it("the record survives a store reload", async () => {
    const w = world();
    await w.start();
    await w.connect();
    await recordBatch(w, ["gone"], true, "kept");
    w.txMap.set("gone", txOf("confirmed", "0x1"));
    const reload = world();
    const transactions2 = new TransactionController({
      wallet: {} as Wallet,
      networks: reload.transactions["options" as never],
      openStore: async () => Promise.resolve(createMemoryEngineStore(w.backing)),
      random: (n) => new Uint8Array(n).fill(3),
      setTimer: () => () => undefined,
      now: () => 1000,
      logger,
      pollMs: 1,
      chains: {} as ReturnType<typeof chains>,
    });
    await transactions2.init();
    expect(transactions2.batchById(SITE, "kept")?.id).toBe("kept");
  });

  it("two origins using the same id each keep their own record", async () => {
    const w = world();
    await w.start();
    await w.connect();
    await w.connect(OTHER);
    await recordBatch(w, ["a"], true, "shared");
    await w.transactions.recordBatch({
      origin: OTHER,
      id: "shared",
      network: N1,
      atomic: false,
      txIds: ["b"],
      expected: 1,
      createdAt: 0,
    });
    expect(w.transactions.batchById(SITE, "shared")?.txIds).toStrictEqual(["a"]);
    expect(w.transactions.batchById(OTHER, "shared")?.txIds).toStrictEqual(["b"]);
    w.txMap.set("a", txOf("confirmed", "0x1"));
    const reply2 = (await w.handler.handle(SITE, {
      method: "wallet_getCallsStatus",
      params: ["shared"],
    })) as { status: number };
    expect(reply2.status).toBe(200);
    const other = (await w.handler.handle(OTHER, {
      method: "wallet_getCallsStatus",
      params: ["shared"],
    })) as { status: number; atomic: boolean };
    expect(other.atomic).toBe(false);
    expect(other.status).toBe(600);
  });
});
