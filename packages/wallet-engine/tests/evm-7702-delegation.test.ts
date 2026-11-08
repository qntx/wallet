import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { DisplayIntent, SignRequest } from "@qntx/wallet-chains";
import { EVM_DELEGATOR, encodeBatchExecute } from "@qntx/wallet-chains/evm";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import {
  bookDeps,
  idleNetworkDeps,
  simulateSolanaStub,
  simulateV1Result,
  tokensStub,
} from "./send-helpers.ts";

const DELEGATOR = EVM_DELEGATOR.address;
const ZERO = "0x0000000000000000000000000000000000000000";
const CODE = readFileSync(
  new URL("fixtures/eip7702-stateless-delegator-1.3.0.hex", import.meta.url).pathname,
  "utf8",
).trim();
const N1 = "eip155:1";
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const HOST = "https://host.test/evm";
const GATEWAY = "https://gw.test";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "0a".repeat(8),
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const VERIFY = { kind: "password" as const, password: "pw" };
const logger = { warn: () => undefined };
const TARGET = "0x00000000000000000000000000000000C0FFEE00";

type Rpc = Record<string, unknown>;
type CodeOf = (address: string) => string;

const designator = (address: string) => `0xef0100${address.slice(2)}`;

const none = (a: string) => (a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : "0x");
const ours = (a: string) =>
  a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : designator(DELEGATOR);
const other = (a: string) =>
  a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : designator(ADDR);

/** The EIP-7702 tx the unsigned closure hands to `sign`; the request's `tx` carries it. */
const signTx = (request: SignRequest) =>
  (request as { tx: { type?: string; to: string; data: string; authorization?: unknown } }).tx;

function world(options: {
  code: CodeOf;
  independent?: CodeOf | undefined;
  estimate?: { params?: unknown };
}) {
  const base: Rpc = {
    eth_chainId: 1,
    eth_blockNumber: "0x1",
    eth_getTransactionCount: "0x0",
    eth_estimateGas: "0x5208",
    eth_call: `0x${"00".repeat(32)}`,
    eth_feeHistory: { baseFeePerGas: ["0x64", "0x64"], reward: [["0x1", "0x2", "0x3"]] },
    eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
    eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x1", blockHash: "0x1" },
    eth_getBlockByNumber: { number: "0x2" },
  };
  const calls: Array<{ url: string; method: string }> = [];
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
    calls.push({ url, method: body.method });
    if (body.method === "eth_getCode") {
      const table = url.startsWith(GATEWAY) ? options.independent : options.code;
      const p = (body.params as unknown[] | undefined)?.[0];
      const result = table === undefined || typeof p !== "string" ? "0x" : table(p);
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    }
    if (body.method === "eth_estimateGas" && options.estimate !== undefined) {
      options.estimate.params = body.params;
    }
    if (body.method === "eth_simulateV1") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: simulateV1Result(body.params) });
    }
    return body.method in base
      ? Response.json({ jsonrpc: "2.0", id: 1, result: base[body.method] })
      : Response.json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: body.method } });
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [N1]: [HOST] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway:
      options.independent === undefined ? undefined : { url: GATEWAY, installId: "a".repeat(32) },
  });
  const apis = {
    account: async () => Promise.resolve({ template: "evm.bip44", network: N1, address: ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      signedRequests.push(request);
      /* fakeSignedEvm cannot serialize eip7702; the raw blob only feeds broadcast. */
      return Promise.resolve({
        kind: "evm.transaction",
        signedTransaction: new Uint8Array([2, 3, 4]),
      });
    },
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    wallet: {} as Wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: (n) => new Uint8Array(n).fill(3),
    setTimer: () => () => undefined,
    now: () => 0,
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
  const start = async () => {
    await networks.init();
    await transactions.init();
    await requests.init();
  };
  return { requests, transactions, calls, signedRequests, start };
}

describe("eip7702 request pipeline", () => {
  it("upgrade builds eip7702 with the delegator authorization, to=from, data 0x", async () => {
    const w = world({ code: none, independent: none });
    await w.start();
    const request = await w.requests.prepare({
      method: "evm-delegation",
      account: ACCOUNT,
      network: N1,
      action: "upgrade",
      fee: "normal",
    });
    await w.requests.approve(request.id, "evm-delegation", VERIFY);
    const tx = signTx(w.signedRequests[0]!);
    expect(tx.type).toBe("eip7702");
    expect(tx.authorization).toMatchObject({ address: DELEGATOR });
    expect(tx.to.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(tx.data).toBe("0x");
    expect((request.display as DisplayIntent).delegation).toMatchObject({ kind: "set" });
  });

  it("upgrade when ours refuses; revoke from ours sends the zero address", async () => {
    const w = world({ code: ours, independent: ours });
    await w.start();
    await expect(
      w.requests.prepare({
        method: "evm-delegation",
        account: ACCOUNT,
        network: N1,
        action: "upgrade",
        fee: "normal",
      }),
    ).rejects.toThrow("account is already delegated");
    const request = await w.requests.prepare({
      method: "evm-delegation",
      account: ACCOUNT,
      network: N1,
      action: "revoke",
      fee: "normal",
    });
    await w.requests.approve(request.id, "evm-delegation", VERIFY);
    expect(signTx(w.signedRequests[0]!).authorization).toMatchObject({ address: ZERO });
    expect((request.display as DisplayIntent).delegation).toMatchObject({ kind: "revoke" });
  });

  it("revoke when none refuses; the override reaches estimateGas only for the delegator", async () => {
    const estimate: { params?: unknown } = {};
    const w = world({ code: none, independent: none, estimate });
    await w.start();
    await expect(
      w.requests.prepare({
        method: "evm-delegation",
        account: ACCOUNT,
        network: N1,
        action: "revoke",
        fee: "normal",
      }),
    ).rejects.toThrow("account has no delegation to revoke");
    await w.requests.prepare({
      method: "evm-delegation",
      account: ACCOUNT,
      network: N1,
      action: "upgrade",
      fee: "normal",
    });
    const params = estimate.params as unknown[];
    const override = params[2] as Record<string, { code: string }>;
    const key = Object.keys(override).find((k) => k.toLowerCase() === ADDR.toLowerCase());
    expect(key).toBeDefined();
    expect(override[key!]?.code.toLowerCase()).toBe(designator(DELEGATOR).toLowerCase());
  });

  it("a primary/independent disagreement refuses", async () => {
    const w = world({ code: none, independent: other });
    await w.start();
    await expect(
      w.requests.prepare({
        method: "evm-delegation",
        account: ACCOUNT,
        network: N1,
        action: "upgrade",
        fee: "normal",
      }),
    ).rejects.toThrow("delegation state differs between endpoints");
  });

  it("batch on an ours account: eip1559 self-call with the batch intent and outflows", async () => {
    const w = world({ code: ours, independent: ours });
    await w.start();
    const request = await w.requests.prepare({
      method: "evm-batch",
      account: ACCOUNT,
      network: N1,
      calls: [
        { to: TARGET, value: 1n, data: "0x" },
        { to: ADDR, value: 2n, data: "0x" },
      ],
      fee: "normal",
    });
    await w.requests.approve(request.id, "evm-batch", VERIFY);
    const tx = signTx(w.signedRequests[0]!);
    expect(tx.type).not.toBe("eip7702");
    expect(tx.authorization).toBeUndefined();
    expect(tx.to.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(tx.data).toBe(
      encodeBatchExecute([
        { to: TARGET, value: 1n, data: "0x" },
        { to: ADDR, value: 2n, data: "0x" },
      ]),
    );
    expect((request.display as DisplayIntent).summary).toBe("batch");
    expect((request.display as DisplayIntent).outflows).toHaveLength(2);
  });

  it("batch on a none account: eip7702 with the delegator authorization; one call refuses", async () => {
    const w = world({ code: none, independent: none });
    await w.start();
    await expect(
      w.requests.prepare({
        method: "evm-batch",
        account: ACCOUNT,
        network: N1,
        calls: [{ to: TARGET, value: 1n, data: "0x" }],
        fee: "normal",
      }),
    ).rejects.toThrow("a batch needs at least two calls");
    const request = await w.requests.prepare({
      method: "evm-batch",
      account: ACCOUNT,
      network: N1,
      calls: [
        { to: TARGET, value: 1n, data: "0x" },
        { to: ADDR, value: 2n, data: "0x" },
      ],
      fee: "normal",
    });
    await w.requests.approve(request.id, "evm-batch", VERIFY);
    expect(signTx(w.signedRequests[0]!).authorization).toMatchObject({ address: DELEGATOR });
    expect((request.display as DisplayIntent).summary).toBe("batch");
  });

  it("batch on an other account: eip7702 and a delegation-replaced warning", async () => {
    const w = world({ code: other, independent: other });
    await w.start();
    const request = await w.requests.prepare({
      method: "evm-batch",
      account: ACCOUNT,
      network: N1,
      calls: [
        { to: TARGET, value: 1n, data: "0x" },
        { to: ADDR, value: 2n, data: "0x" },
      ],
      fee: "normal",
    });
    expect(
      (request.display as DisplayIntent).warnings.some(
        (w: { kind: string }) => w.kind === "delegation-replaced",
      ),
    ).toBe(true);
  });

  it("a dApp self-call with data is refused; 0x data is allowed", async () => {
    const w = world({ code: none, independent: none });
    await w.start();
    const origin = { kind: "browser" as const, origin: "https://app.test" };
    await expect(
      w.requests.prepare({
        method: "evm-sign",
        origin,
        account: ACCOUNT,
        network: N1,
        request: {
          kind: "evm.transaction",
          network: N1,
          account: ACCOUNT,
          tx: {
            type: "eip1559",
            chainId: 1,
            nonce: 0,
            to: ADDR,
            value: "0x0",
            data: "0x12345678",
            gas: "0x5208",
            maxFeePerGas: "0x1",
            maxPriorityFeePerGas: "0x1",
            accessList: [],
          },
        },
      }),
    ).rejects.toThrow("dApp transactions calling your own account are refused");
    const request = await w.requests.prepare({
      method: "evm-sign",
      origin,
      account: ACCOUNT,
      network: N1,
      request: {
        kind: "evm.transaction",
        network: N1,
        account: ACCOUNT,
        tx: {
          type: "eip1559",
          chainId: 1,
          nonce: 0,
          to: ADDR,
          value: "0x1",
          data: "0x",
          gas: "0x5208",
          maxFeePerGas: "0x1",
          maxPriorityFeePerGas: "0x1",
          accessList: [],
        },
      },
    });
    expect(request.id.length).toBeGreaterThan(0);
  });

  it("delegationState facade: unsupported network and an other designator", async () => {
    const w = world({ code: other, independent: other });
    await w.start();
    await expect(w.transactions.delegationState(ACCOUNT, "eip155:43114")).resolves.toStrictEqual({
      supported: false,
      state: "none",
    });
    await expect(w.transactions.delegationState(ACCOUNT, N1)).resolves.toMatchObject({
      supported: true,
      state: "other",
      address: ADDR,
    });
  });
});
