import { readFileSync } from "node:fs";

import { hexToBytes, serializeTransaction } from "viem";
import type { Hex } from "viem";
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
const TARGET = "0x00000000000000000000000000000000c0ffee00";
const TARGET2 = "0x0000000000000000000000000000000000000fee";

type Rpc = Record<string, unknown>;
type CodeOf = (address: string) => string;

const designator = (address: string) => `0xef0100${address.slice(2)}`;

const r: Hex = `0x${"11".repeat(32)}`;
const s: Hex = `0x${"22".repeat(32)}`;
const SIG = { r, s, yParity: 0 as const };

/**
 * A persisted raw the store can parse on replacement — the real serialized envelope for the
 * request's tx, with `rawAuth` controlling the authorization tuples `rebuild` must inspect.
 */
const evmRaw = (tx: unknown, mode: RawAuth): Uint8Array => {
  const t = tx as {
    type: string;
    chainId: number;
    nonce: number;
    to: string;
    value: bigint | string | number;
    data: string;
    gas: bigint | string | number;
    maxFeePerGas: bigint | string | number;
    maxPriorityFeePerGas: bigint | string | number;
    authorization?: { address: string };
  };
  const one = (address: string, nonce: number) => ({
    chainId: 1,
    address: address as Hex,
    nonce,
    ...SIG,
  });
  const auths: Record<RawAuth, Array<ReturnType<typeof one>>> = {
    default: t.authorization === undefined ? [] : [one(t.authorization.address, t.nonce + 1)],
    double:
      t.authorization === undefined
        ? []
        : [one(t.authorization.address, t.nonce + 1), one(t.authorization.address, t.nonce + 1)],
    wrongNonce: t.authorization === undefined ? [] : [one(t.authorization.address, t.nonce + 7)],
    foreign: t.authorization === undefined ? [] : [one(TARGET, t.nonce + 1)],
  };
  const common = {
    chainId: t.chainId,
    nonce: t.nonce,
    to: t.to as Hex,
    value: BigInt(t.value ?? 0),
    data: (t.data ?? "0x") as Hex,
    gas: BigInt(t.gas),
    maxFeePerGas: BigInt(t.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
  };
  const raw =
    auths[mode].length === 0
      ? serializeTransaction({ ...common, type: "eip1559" }, SIG)
      : serializeTransaction({ ...common, type: "eip7702", authorizationList: auths[mode] }, SIG);
  return hexToBytes(raw);
};

const badDelegator = (a: string) => (a.toLowerCase() === DELEGATOR.toLowerCase() ? "0x1234" : "0x");
const contract = (a: string) =>
  a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : "0x6080604052348015600e575f";
const shortDesignator = (a: string) =>
  a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : "0xef0100aa";

const none = (a: string) => (a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : "0x");
const ours = (a: string) =>
  a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : designator(DELEGATOR);
const other = (a: string) =>
  a.toLowerCase() === DELEGATOR.toLowerCase() ? CODE : designator(ADDR);

/** The EIP-7702 tx the unsigned closure hands to `sign`; the request's `tx` carries it. */
const signTx = (request: SignRequest) =>
  (
    request as {
      tx: {
        type?: string;
        nonce: number;
        to: string;
        data: string;
        gas: string;
        authorization?: unknown;
      };
    }
  ).tx;

type RawAuth = "default" | "double" | "wrongNonce" | "foreign";

function world(options: {
  code: CodeOf;
  independent?: CodeOf | undefined;
  estimate?: { params?: unknown };
  rawAuth?: RawAuth;
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
      /* fakeSignedEvm cannot serialize eip7702; persist a real envelope for rebuild. */
      const { tx } = request as { tx: unknown };
      return Promise.resolve({
        kind: "evm.transaction",
        signedTransaction: evmRaw(tx, options.rawAuth ?? "default"),
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
        { to: TARGET2, value: 2n, data: "0x" },
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
        { to: TARGET2, value: 2n, data: "0x" },
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
        { to: TARGET2, value: 2n, data: "0x" },
      ],
      fee: "normal",
    });
    await w.requests.approve(request.id, "evm-batch", VERIFY);
    expect(signTx(w.signedRequests[0]!).authorization).toMatchObject({ address: DELEGATOR });
    expect((request.display as DisplayIntent).summary).toBe("batch");
  });

  it("a batch call to the account itself is refused — the delegator's admin surface", async () => {
    const w = world({ code: none, independent: none });
    await w.start();
    await expect(
      w.requests.prepare({
        method: "evm-batch",
        account: ACCOUNT,
        network: N1,
        calls: [
          { to: TARGET, value: 1n, data: "0x" },
          { to: ADDR, value: 2n, data: "0x" },
        ],
        fee: "normal",
      }),
    ).rejects.toThrow("a batch call to your own account is refused");
  });

  it("a batch over 10 calls is refused", async () => {
    const w = world({ code: none, independent: none });
    await w.start();
    await expect(
      w.requests.prepare({
        method: "evm-batch",
        account: ACCOUNT,
        network: N1,
        calls: Array.from({ length: 11 }, () => ({ to: TARGET, value: 1n, data: "0x" })),
        fee: "normal",
      }),
    ).rejects.toThrow("a batch allows at most 10 calls");
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
        { to: TARGET2, value: 2n, data: "0x" },
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

  it("refuses a delegator hash mismatch on the primary and on the independent endpoint", async () => {
    const upgrade = {
      method: "evm-delegation" as const,
      account: ACCOUNT,
      network: N1,
      action: "upgrade" as const,
      fee: "normal" as const,
    };
    const primary = world({ code: badDelegator, independent: none });
    const independent = world({ code: none, independent: badDelegator });
    await Promise.all([primary.start(), independent.start()]);
    await Promise.all([
      expect(primary.requests.prepare(upgrade)).rejects.toThrow(
        "delegator contract is not what the network expects",
      ),
      expect(independent.requests.prepare(upgrade)).rejects.toThrow(
        "delegator contract is not what the network expects",
      ),
    ]);
  });

  it("an unavailable independent endpoint still builds with the reads-unverified check", async () => {
    const w = world({ code: none });
    await w.start();
    const request = await w.requests.prepare({
      method: "evm-delegation",
      account: ACCOUNT,
      network: N1,
      action: "upgrade",
      fee: "normal",
    });
    expect(request.checks).toContain("reads-unverified");
  });

  it("a network without a delegator entry refuses delegation and batch", async () => {
    const w = world({ code: none, independent: none });
    await w.start();
    await expect(
      w.requests.prepare({
        method: "evm-delegation",
        account: ACCOUNT,
        network: "eip155:43114",
        action: "upgrade",
        fee: "normal",
      }),
    ).rejects.toThrow("network does not support EIP-7702");
    await expect(
      w.requests.prepare({
        method: "evm-batch",
        account: ACCOUNT,
        network: "eip155:43114",
        calls: [
          { to: TARGET, value: 1n, data: "0x" },
          { to: TARGET2, value: 2n, data: "0x" },
        ],
        fee: "normal",
      }),
    ).rejects.toThrow("network does not support EIP-7702");
  });

  it("contract code and a wrong-length designator are refused", async () => {
    const revoke = {
      method: "evm-delegation" as const,
      account: ACCOUNT,
      network: N1,
      action: "revoke" as const,
      fee: "normal" as const,
    };
    const contractWorld = world({ code: contract, independent: contract });
    const shortWorld = world({ code: shortDesignator, independent: shortDesignator });
    await Promise.all([contractWorld.start(), shortWorld.start()]);
    await Promise.all([
      expect(contractWorld.requests.prepare(revoke)).rejects.toThrow("account is not an EOA"),
      expect(shortWorld.requests.prepare(revoke)).rejects.toThrow("account is not an EOA"),
    ]);
  });

  it("revoke sends no state override; gas is estimate + 25,000 then buffered", async () => {
    const estimate: { params?: unknown } = {};
    const w = world({ code: ours, independent: ours, estimate });
    await w.start();
    const request = await w.requests.prepare({
      method: "evm-delegation",
      account: ACCOUNT,
      network: N1,
      action: "revoke",
      fee: "normal",
    });
    await w.requests.approve(request.id, "evm-delegation", VERIFY);
    const params = estimate.params as unknown[];
    expect(params[2]).toBeUndefined();
    const tx = signTx(w.signedRequests[0]!);
    expect(BigInt(tx.gas)).toBe(BigInt(Math.floor((0x5208 + 25_000) * 1.2)));
  });

  it("speed-up keeps the authorization at nonce+1; cancel drops it to a plain self-transfer", async () => {
    const w = world({ code: none, independent: none });
    await w.start();
    const request = await w.requests.prepare({
      method: "evm-batch",
      account: ACCOUNT,
      network: N1,
      calls: [
        { to: TARGET, value: 1n, data: "0x" },
        { to: TARGET2, value: 2n, data: "0x" },
      ],
      fee: "normal",
    });
    const tracked = await w.requests.approve(request.id, "evm-batch", VERIFY);
    const sped = await w.requests.prepare({ method: "speed-up", txId: tracked.id });
    await w.requests.approve(sped.id, "speed-up", VERIFY);
    const spedTx = signTx(w.signedRequests[1]!);
    expect(spedTx.type).toBe("eip7702");
    expect(spedTx.authorization).toMatchObject({ address: DELEGATOR });
    /* A speed-up replaces the original; the cancel needs its own tracked batch. */
    const second = await w.requests.prepare({
      method: "evm-batch",
      account: ACCOUNT,
      network: N1,
      calls: [
        { to: TARGET, value: 1n, data: "0x" },
        { to: TARGET2, value: 2n, data: "0x" },
      ],
      fee: "normal",
    });
    const tracked2 = await w.requests.approve(second.id, "evm-batch", VERIFY);
    const cancel = await w.requests.prepare({ method: "cancel", txId: tracked2.id });
    await w.requests.approve(cancel.id, "cancel", VERIFY);
    const cancelTx = signTx(w.signedRequests[3]!);
    expect(cancelTx.authorization).toBeUndefined();
    expect(cancelTx.to.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(cancelTx.data).toBe("0x");
  });

  it.each(["double", "wrongNonce", "foreign"] as const)(
    "a persisted raw with a %s authorization is rejected by replacement",
    async (rawAuth) => {
      const w = world({ code: none, independent: none, rawAuth });
      await w.start();
      const request = await w.requests.prepare({
        method: "evm-batch",
        account: ACCOUNT,
        network: N1,
        calls: [
          { to: TARGET, value: 1n, data: "0x" },
          { to: TARGET2, value: 2n, data: "0x" },
        ],
        fee: "normal",
      });
      const tracked = await w.requests.approve(request.id, "evm-batch", VERIFY);
      await expect(w.requests.prepare({ method: "speed-up", txId: tracked.id })).rejects.toThrow(
        "build record authorization is unexpected",
      );
    },
  );
});
