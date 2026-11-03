import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { decodeEvm } from "@qntx/wallet-chains/evm";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { REQUEST_TTL_MS, RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type {
  DisplayIntent,
  PrepareParams,
  PreparedRequest,
  SendParams,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { bookDeps } from "./send-helpers.ts";

const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const SEPOLIA = "eip155:11155111";
const GATEWAY = "https://gw.test";
const HOST = "https://host.test/evm";
const VERIFY = { kind: "password" as const, password: "pw" };
const ONE_ETH = 10n ** 18n;
const PARAMS = {
  method: "send" as const,
  account: ACCOUNT,
  network: SEPOLIA,
  to: "0x00000000000000000000000000000000deadbeef",
  amount: ONE_ETH,
  fee: "normal" as const,
};

const intent = (verifiability: DisplayIntent["verifiability"]): DisplayIntent => ({
  ...decodeEvm({
    kind: "evm.transaction",
    network: SEPOLIA,
    account: ACCOUNT,
    tx: {
      type: "legacy",
      chainId: 11155111,
      nonce: 0,
      gas: "0x5208",
      to: PARAMS.to,
      value: "0x1",
      data: "0x",
      gasPrice: "0x1",
    },
  }),
  verifiability,
});

const logger = { warn: () => undefined };

/** A transactions stand-in whose prepared builds expose spies for the pipeline's own rules. */
function fake(options: { verifiability?: DisplayIntent["verifiability"]; checks?: string[] } = {}) {
  const events: string[] = [];
  let submitError: Error | undefined;
  let stale: string | undefined;
  const txs: Record<string, TrackedTransaction> = {};
  const transactions = {
    getState: () => ({ txs }),
    prepareSend: async (_p: PrepareParams, requestId: string): Promise<PreparedRequest> => {
      events.push(`prepare ${requestId}`);
      return Promise.resolve({
        txId: `tx-${requestId}`,
        account: ACCOUNT,
        network: SEPOLIA,
        intent: intent(options.verifiability ?? "full"),
        checks: (options.checks ?? []) as PreparedRequest["checks"],
        staleReason: async () => Promise.resolve(stale),
        submit: async (verify: SendParams["verify"]) => {
          events.push(`sign ${verify.kind}`);
          if (submitError !== undefined) {
            throw submitError;
          }
          return Promise.resolve({
            id: `tx-${requestId}`,
            family: "evm",
            network: SEPOLIA,
            account: "w",
            hash: "0x1",
            state: "submitted",
            intent: undefined,
            nonce: 0,
            submittedAt: 0,
            error: undefined,
          } satisfies TrackedTransaction);
        },
        release: () => {
          events.push(`release ${requestId}`);
        },
      });
    },
  } as unknown as TransactionController;
  let now = 1000;
  const nostrSignCalls: string[] = [];
  const nostrSigned = {
    id: "e".repeat(64),
    sig: "f".repeat(128),
    pubkey: "a".repeat(64),
    kind: 1,
    content: "",
    created_at: 0,
    tags: [],
  };
  const timers: Array<{ ms: number; fn: () => unknown; stopped: boolean }> = [];
  let counter = 0;
  const nextCounter = (): number => {
    counter += 1;
    return counter;
  };
  const controller = new RequestController({
    transactions,
    ...bookDeps(),
    spark: {
      createInvoice: async () =>
        Promise.resolve({
          id: "inv-1",
          invoice: "lnbc1fake",
          paymentHash: new Uint8Array(32),
          amountSats: 100,
          expiresAtMs: 999,
        }),
    } as unknown as SparkController,
    nostrSign: async () => {
      nostrSignCalls.push("sign");
      return Promise.resolve(nostrSigned);
    },
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(nextCounter()),
    now: () => now,
    setTimer: (ms, fn) => {
      const timer = { ms, fn, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
    logger,
  });
  return {
    controller,
    events,
    txs,
    timers,
    nostrSignCalls,
    nostrSigned,
    advance: (ms: number) => {
      now += ms;
    },
    failSubmit: (error: Error | undefined) => {
      submitError = error;
    },
    makeStale: (reason: string | undefined) => {
      stale = reason;
    },
  };
}

describe("RequestController lifecycle", () => {
  it("prepare → approve → submitted, with the tracked transaction id", async () => {
    const f = fake();
    await f.controller.init();
    const request = await f.controller.prepare(PARAMS);
    expect(request).toMatchObject({
      method: "send",
      origin: { kind: "internal" },
      stage: "awaiting-approval",
      verification: "verified",
      checks: [],
      createdAt: 1000,
      expiresAt: 1000 + REQUEST_TTL_MS,
    });
    const tx = await f.controller.approve(request.id, "send", VERIFY);
    expect(tx.state).toBe("submitted");
    expect(f.controller.getState().requests[request.id]).toMatchObject({
      stage: "submitted",
      txId: tx.id,
    });
    expect(f.events).toStrictEqual([`prepare ${request.id}`, "sign password"]);
  });

  it("a partial decode and any recorded check make the request unverifiable", async () => {
    const partial = fake({ verifiability: "partial" });
    await partial.controller.init();
    const a = await partial.controller.prepare(PARAMS);
    expect(a).toMatchObject({ verification: "unverifiable", checks: ["decode-partial"] });

    const checked = fake({ checks: ["fee-mismatch"] });
    await checked.controller.init();
    const b = await checked.controller.prepare(PARAMS);
    expect(b).toMatchObject({ verification: "unverifiable", checks: ["fee-mismatch"] });
  });

  it("rejects an unknown id, a wrong method, a repeat approval and an expired request without signing", async () => {
    const f = fake();
    await f.controller.init();
    const request = await f.controller.prepare(PARAMS);

    await expect(f.controller.approve("req-nope", "send", VERIFY)).rejects.toThrow("unknown");
    await expect(
      f.controller.approve(request.id, "swap" as unknown as "send", VERIFY),
    ).rejects.toThrow("not swap");
    expect(f.events.some((e) => e.startsWith("sign"))).toBe(false);

    await f.controller.approve(request.id, "send", VERIFY);
    await expect(f.controller.approve(request.id, "send", VERIFY)).rejects.toThrow("not awaiting");
    expect(f.events.filter((e) => e.startsWith("sign"))).toHaveLength(1);

    const late = await f.controller.prepare(PARAMS);
    f.advance(REQUEST_TTL_MS);
    await expect(f.controller.approve(late.id, "send", VERIFY)).rejects.toThrow("expired");
    expect(f.controller.getState().requests[late.id]?.stage).toBe("expired");
    expect(f.events.filter((e) => e.startsWith("sign"))).toHaveLength(1);
    expect(f.events).toContain(`release ${late.id}`);
  });

  it("reject → rejected and released; approving afterwards fails", async () => {
    const f = fake();
    await f.controller.init();
    const request = await f.controller.prepare(PARAMS);
    f.controller.reject(request.id);
    expect(f.controller.getState().requests[request.id]?.stage).toBe("rejected");
    expect(f.events).toContain(`release ${request.id}`);
    await expect(f.controller.approve(request.id, "send", VERIFY)).rejects.toThrow("rejected");
    expect(() => {
      f.controller.reject("req-nope");
    }).toThrow("unknown");
  });

  it("the injected timer expires an unanswered request and releases it", async () => {
    const f = fake();
    await f.controller.init();
    const request = await f.controller.prepare(PARAMS);
    const [timer] = f.timers;
    expect(timer?.ms).toBe(REQUEST_TTL_MS);
    await timer?.fn();
    expect(f.controller.getState().requests[request.id]?.stage).toBe("expired");
    expect(f.events).toContain(`release ${request.id}`);
  });

  it("lock invalidates unfinished requests and releases them; unlock clears the queue", async () => {
    const f = fake();
    await f.controller.init();
    const waiting = await f.controller.prepare(PARAMS);
    const done = await f.controller.prepare(PARAMS);
    await f.controller.approve(done.id, "send", VERIFY);

    f.controller.lock();
    const { requests } = f.controller.getState();
    expect(requests[waiting.id]?.stage).toBe("invalidated");
    expect(requests[done.id]?.stage).toBe("submitted");
    expect(f.events).toContain(`release ${waiting.id}`);
    expect(f.timers.every((t) => t.stopped)).toBe(true);
    await expect(f.controller.approve(waiting.id, "send", VERIFY)).rejects.toThrow("invalidated");
    await expect(f.controller.prepare(PARAMS)).rejects.toThrow("unlocked");

    await f.controller.init();
    expect(f.controller.getState().requests).toStrictEqual({});
  });

  it("a stale build fails without signing and is released", async () => {
    const f = fake();
    await f.controller.init();
    const request = await f.controller.prepare(PARAMS);
    f.makeStale("nonce already used");
    await expect(f.controller.approve(request.id, "send", VERIFY)).rejects.toThrow(
      "nonce already used",
    );
    expect(f.controller.getState().requests[request.id]).toMatchObject({
      stage: "failed",
      error: "nonce already used",
    });
    expect(f.events.some((e) => e.startsWith("sign"))).toBe(false);
    expect(f.events).toContain(`release ${request.id}`);
  });

  it("a failed signature or broadcast releases the request", async () => {
    const f = fake();
    await f.controller.init();
    const request = await f.controller.prepare(PARAMS);
    f.failSubmit(new Error("broadcast failed"));
    await expect(f.controller.approve(request.id, "send", VERIFY)).rejects.toThrow(
      "broadcast failed",
    );
    expect(f.controller.getState().requests[request.id]?.stage).toBe("failed");
    expect(f.events).toContain(`release ${request.id}`);
  });

  it("a prepare that finishes after a lock is released and refused", async () => {
    const f = fake();
    await f.controller.init();
    const pending = f.controller.prepare(PARAMS);
    f.controller.lock();
    await expect(pending).rejects.toThrow("locked");
    expect(f.events.filter((e) => e.startsWith("release"))).toHaveLength(1);
  });
});

// ---- real EVM pipeline against a fake gateway + host endpoint ----

type Rpc = Record<string, unknown>;

const feeHistory = (priorityNormal: string, baseFee = "0x64") => ({
  baseFeePerGas: [baseFee, baseFee],
  reward: [
    ["0x1", priorityNormal, "0x3"],
    ["0x1", priorityNormal, "0x3"],
  ],
});

function evmWorld(options: {
  lockDuringSign?: boolean;
  gateway?: Rpc | undefined;
  host?: Rpc | undefined;
  hostEndpoints?: boolean;
  custom?: boolean;
}) {
  const base: Rpc = {
    eth_chainId: "0xaa36a7",
    eth_getTransactionCount: "0x0",
    eth_estimateGas: "0x5208",
    eth_feeHistory: feeHistory("0x2"),
    eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
    eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x1", blockHash: "0x1" },
    eth_getBlockByNumber: { number: "0x2" },
  };
  const calls: Array<{ url: string; method: string }> = [];
  const gatewayTable: Rpc = options.gateway ?? {};
  const hostTable: Rpc = options.host ?? {};
  const timers: Array<() => unknown> = [];
  const signedRequests: unknown[] = [];
  let txCounter = 100;
  const nextTx = (): number => {
    txCounter += 1;
    return txCounter;
  };
  const answer = (table: Rpc, body: { method: string }): Response =>
    body.method in table
      ? Response.json({ jsonrpc: "2.0", id: 1, result: table[body.method] })
      : Response.json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: body.method } });
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Promise.resolve(Response.json({ networks: [SEPOLIA] }));
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
    };
    calls.push({ url, method: body.method });
    const table = url.startsWith(GATEWAY)
      ? { ...base, ...gatewayTable }
      : { ...base, ...hostTable };
    return Promise.resolve(answer(table, body));
  };
  const warnings: string[] = [];
  const warn = { warn: (message: string) => warnings.push(message) };
  const networks = new NetworkController({
    fetch: fetchImpl,
    rpc: options.hostEndpoints === false ? {} : { [SEPOLIA]: [HOST] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway:
      options.gateway === undefined ? undefined : { url: GATEWAY, installId: "a".repeat(32) },
  });
  let signed = 0;
  let rejectSign = false;
  let lockTransactions: () => void = () => undefined;
  const apis = {
    account: async () =>
      Promise.resolve({ template: "evm.bip44", network: SEPOLIA, address: ADDR }),
    sign: async ({ request }: { request: unknown }) => {
      signed += 1;
      signedRequests.push(request);
      if (options.lockDuringSign === true) {
        lockTransactions();
      }
      return rejectSign
        ? Promise.reject(new Error("cancelled"))
        : Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array([1, 2]) });
    },
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    wallet: {} as Wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: (n) => new Uint8Array(n).fill(nextTx()),
    setTimer: (_ms, fn) => {
      timers.push(fn);
      return () => undefined;
    },
    now: () => 0,
    logger: warn,
    pollMs: 1,
    chains: apis,
  });
  lockTransactions = () => {
    transactions.lock();
  };
  let counter = 0;
  const nextCounter = (): number => {
    counter += 1;
    return counter;
  };
  const requests = new RequestController({
    transactions,
    ...bookDeps(),
    spark: {
      createInvoice: async () =>
        Promise.resolve({
          id: "inv-1",
          invoice: "lnbc1fake",
          paymentHash: new Uint8Array(32),
          amountSats: 100,
          expiresAtMs: 999,
        }),
    } as unknown as SparkController,
    nostrSign: async () => {
      await Promise.resolve();
      throw new Error("nostr-sign is not wired in this test");
    },
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(nextCounter()),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  const start = async () => {
    await networks.init();
    if (options.custom === true) {
      await networks.addRpc(SEPOLIA, "https://custom.test/rpc");
    }
    await transactions.init();
    await requests.init();
  };
  return {
    networks,
    requests,
    transactions,
    calls,
    start,
    signCount: () => signed,
    gatewayTable,
    hostTable,
    timers,
    signedRequests,
    warnings,
    rejectSigning: () => {
      rejectSign = true;
    },
  };
}

describe("EVM pipeline", () => {
  it("two concurrent prepares: the second approval is stale and never signs", async () => {
    const w = evmWorld({});
    await w.start();
    const [a, b] = await Promise.all([w.requests.prepare(PARAMS), w.requests.prepare(PARAMS)]);
    await w.requests.approve(a.id, "send", VERIFY);
    await expect(w.requests.approve(b.id, "send", VERIFY)).rejects.toThrow("start over");
    expect(w.requests.getState().requests[b.id]?.stage).toBe("failed");
    expect(w.signCount()).toBe(1);

    const c = await w.requests.prepare(PARAMS);
    const tx = await w.requests.approve(c.id, "send", VERIFY);
    expect(tx.nonce).toBe(1);
  });

  it("a broadcast that completes after the vault locked is logged, not silently lost", async () => {
    const w = evmWorld({ lockDuringSign: true });
    await w.start();
    const r = await w.requests.prepare(PARAMS);
    const tx = await w.requests.approve(r.id, "send", VERIFY);
    expect(tx.state).toBe("submitted");
    expect(w.warnings.some((m) => m.includes("after the vault locked"))).toBe(true);
    expect(w.warnings.some((m) => m.includes("not persisted: vault locked"))).toBe(true);
  });

  it("a cancelled signature is `rejected` and does not consume the nonce", async () => {
    const w = evmWorld({});
    await w.start();
    w.rejectSigning();
    const a = await w.requests.prepare(PARAMS);
    await expect(w.requests.approve(a.id, "send", VERIFY)).rejects.toThrow("cancelled");
    expect(w.requests.getState().requests[a.id]?.stage).toBe("rejected");
    const b = await w.requests.prepare(PARAMS);
    const tracked = Object.values(w.transactions.getState().txs);
    expect(tracked.every((t) => t.state === "rejected")).toBe(true);
    expect(b.display).toMatchObject({ summary: "transfer" });
    expect(w.requests.getState().requests[b.id]?.stage).toBe("awaiting-approval");
  });

  it("without a gateway nothing is cross-checked and the request is verified", async () => {
    const w = evmWorld({ gateway: undefined });
    await w.start();
    const r = await w.requests.prepare(PARAMS);
    expect(r).toMatchObject({ verification: "verified", checks: [] });
    expect(w.calls.every((c) => c.url === HOST)).toBe(true);
  });

  it("with a gateway and agreeing hosts: verified, both endpoints were read", async () => {
    const w = evmWorld({ gateway: {} });
    await w.start();
    const r = await w.requests.prepare(PARAMS);
    expect(r).toMatchObject({ verification: "verified", checks: [] });
    expect(w.calls.some((c) => c.url.startsWith(GATEWAY))).toBe(true);
    expect(w.calls.map((c) => `${c.url} ${c.method}`)).toContain(`${HOST} eth_feeHistory`);
  });

  it("a gateway inflating the priority fee: the host's lower value is used and fee-mismatch is recorded", async () => {
    const w = evmWorld({ gateway: { eth_feeHistory: feeHistory("0x3e8") }, host: {} });
    await w.start();
    const r = await w.requests.prepare(PARAMS);
    expect(r.checks).toContain("fee-mismatch");
    expect(r.verification).toBe("unverifiable");
    const tx = await w.requests.approve(r.id, "send", VERIFY);
    expect(tx.state).toBe("submitted");
  });

  it("a nonce mismatch takes the larger nonce and is recorded", async () => {
    const w = evmWorld({
      gateway: { eth_getTransactionCount: "0x1" },
      host: { eth_getTransactionCount: "0x5" },
    });
    await w.start();
    const r = await w.requests.prepare(PARAMS);
    expect(r.checks).toContain("nonce-mismatch");
    const tx = await w.requests.approve(r.id, "send", VERIFY);
    expect(tx.nonce).toBe(5);
  });

  it("an unreachable independent endpoint records reads-unverified", async () => {
    const w = evmWorld({
      gateway: {},
      host: {
        eth_getTransactionCount: undefined,
        eth_feeHistory: undefined,
        eth_gasPrice: undefined,
      },
    });
    await w.start();
    const r = await w.requests.prepare(PARAMS);
    expect(r.checks).toContain("reads-unverified");
    expect(r.verification).toBe("unverifiable");
  });

  it("a network with no host endpoint cannot be cross-checked: reads-unverified", async () => {
    const w = evmWorld({ gateway: {}, hostEndpoints: false });
    await w.start();
    const r = await w.requests.prepare(PARAMS);
    expect(r.checks).toStrictEqual(["reads-unverified"]);
  });

  it("a custom endpoint means the reads never touched the gateway: no cross-check", async () => {
    const w = evmWorld({ gateway: { eth_feeHistory: feeHistory("0x3e8") }, custom: true });
    await w.start();
    const before = w.calls.length;
    const r = await w.requests.prepare(PARAMS);
    expect(r).toMatchObject({ verification: "verified", checks: [] });
    expect(w.calls.slice(before).some((c) => c.url.startsWith(GATEWAY))).toBe(false);
  });

  it("fee-exceeds-amount: the worst-case fee is not below the amount sent", async () => {
    const w = evmWorld({});
    await w.start();
    const r = await w.requests.prepare({ ...PARAMS, amount: 1n });
    expect(r.checks).toContain("fee-exceeds-amount");
    const big = await w.requests.prepare({ ...PARAMS, amount: ONE_ETH });
    expect(big.checks).not.toContain("fee-exceeds-amount");
  });

  it("fee-above-network: a gateway far above the host raises the ceiling past 2x", async () => {
    const w = evmWorld({ gateway: { eth_feeHistory: feeHistory("0x2", "0x2710") }, host: {} });
    await w.start();
    const r = await w.requests.prepare(PARAMS);
    expect(r.checks).toStrictEqual(expect.arrayContaining(["fee-mismatch", "fee-above-network"]));
  });
});

describe("EVM speed-up and cancel through the pipeline", () => {
  const sendAndPrepare = async (w: ReturnType<typeof evmWorld>) => {
    await w.start();
    const first = await w.requests.prepare(PARAMS);
    const original = await w.requests.approve(first.id, "send", VERIFY);
    return original;
  };

  it("speed-up: target recorded, original untouched until the replacement lands", async () => {
    const w = evmWorld({});
    const original = await sendAndPrepare(w);
    const r = await w.requests.prepare({ method: "speed-up", txId: original.id });
    expect(r).toMatchObject({
      method: "speed-up",
      target: original.id,
      stage: "awaiting-approval",
    });
    const tx = await w.requests.approve(r.id, "speed-up", VERIFY);
    expect(tx).toMatchObject({ replaces: original.id, nonce: original.nonce });
  });

  it("approving with the wrong method never signs", async () => {
    const w = evmWorld({});
    const original = await sendAndPrepare(w);
    const r = await w.requests.prepare({ method: "cancel", txId: original.id });
    const before = w.signCount();
    await expect(w.requests.approve(r.id, "speed-up", VERIFY)).rejects.toThrow("not speed-up");
    expect(w.signCount()).toBe(before);
  });

  it("the original confirming before approval fails the request without signing", async () => {
    const w = evmWorld({});
    const original = await sendAndPrepare(w);
    const r = await w.requests.prepare({ method: "speed-up", txId: original.id });
    await w.timers[0]?.();
    expect(w.transactions.getState().txs[original.id]?.state).toBe("confirmed");
    const before = w.signCount();
    await expect(w.requests.approve(r.id, "speed-up", VERIFY)).rejects.toThrow("already finished");
    expect(w.requests.getState().requests[r.id]).toMatchObject({ stage: "failed" });
    expect(w.signCount()).toBe(before);
  });

  it("a second unfinished replacement of the same transaction is refused", async () => {
    const w = evmWorld({});
    const original = await sendAndPrepare(w);
    const first = await w.requests.prepare({ method: "speed-up", txId: original.id });
    await expect(w.requests.prepare({ method: "cancel", txId: original.id })).rejects.toThrow(
      "unfinished replacement",
    );
    await expect(
      Promise.all([
        w.requests.prepare({ method: "speed-up", txId: original.id }),
        w.requests.prepare({ method: "speed-up", txId: original.id }),
      ]),
    ).rejects.toThrow("unfinished replacement");
    w.requests.reject(first.id);
    await expect(
      w.requests.prepare({ method: "cancel", txId: original.id }),
    ).resolves.toMatchObject({ method: "cancel" });
  });

  it("an original already replaced by an earlier request cannot be replaced again", async () => {
    const w = evmWorld({});
    const original = await sendAndPrepare(w);
    const a = await w.requests.prepare({ method: "speed-up", txId: original.id });
    await w.requests.approve(a.id, "speed-up", VERIFY);
    const b = await w.requests.prepare({ method: "cancel", txId: original.id });
    const before = w.signCount();
    await expect(w.requests.approve(b.id, "cancel", VERIFY)).rejects.toThrow("already replaced");
    expect(w.signCount()).toBe(before);
  });

  it("cancel never records fee-exceeds-amount, although the send did", async () => {
    const w = evmWorld({});
    await w.start();
    const first = await w.requests.prepare({ ...PARAMS, amount: 1n });
    expect(first.checks).toContain("fee-exceeds-amount");
    const original = await w.requests.approve(first.id, "send", VERIFY);
    const cancel = await w.requests.prepare({ method: "cancel", txId: original.id });
    expect(cancel.checks).not.toContain("fee-exceeds-amount");
  });

  it("only submitted or pending transactions can be replaced", async () => {
    const w = evmWorld({});
    await w.start();
    await expect(w.requests.prepare({ method: "speed-up", txId: "tx-missing" })).rejects.toThrow(
      "unknown transaction",
    );
    w.rejectSigning();
    const first = await w.requests.prepare(PARAMS);
    await expect(w.requests.approve(first.id, "send", VERIFY)).rejects.toThrow("cancelled");
    const rejected = Object.values(w.transactions.getState().txs).map((t) => t.id);
    await expect(
      w.requests.prepare({ method: "speed-up", txId: String(rejected[0]) }),
    ).rejects.toThrow("cannot speed-up a rejected");
  });

  it("the replacement floor holds when the gateway reports a low fee", async () => {
    const w = evmWorld({
      gateway: { eth_feeHistory: feeHistory("0x3e8", "0x3e8") },
      host: { eth_feeHistory: feeHistory("0x3e8", "0x3e8") },
    });
    await w.start();
    const first = await w.requests.prepare(PARAMS);
    const original = await w.requests.approve(first.id, "send", VERIFY);
    const oldRequest = w.signedRequests[0] as {
      tx: { maxFeePerGas: string; maxPriorityFeePerGas: string };
    };
    const oldMax = BigInt(oldRequest.tx.maxFeePerGas);
    const oldPriority = BigInt(oldRequest.tx.maxPriorityFeePerGas);

    w.gatewayTable["eth_feeHistory"] = feeHistory("0x1", "0x1");
    w.hostTable["eth_feeHistory"] = feeHistory("0x3e8", "0x3e8");
    const r = await w.requests.prepare({ method: "speed-up", txId: original.id });
    expect(r.checks).toContain("fee-mismatch");
    await w.requests.approve(r.id, "speed-up", VERIFY);
    const bumped = w.signedRequests[1] as {
      tx: { maxFeePerGas: string; maxPriorityFeePerGas: string };
    };
    const newMax = BigInt(bumped.tx.maxFeePerGas);
    const newPriority = BigInt(bumped.tx.maxPriorityFeePerGas);
    expect(newMax * 10n).toBeGreaterThanOrEqual(oldMax * 11n);
    expect(newPriority * 10n).toBeGreaterThanOrEqual(oldPriority * 11n);
  });
});

describe("nostr-sign approval", () => {
  it("approve(id, nostr-sign) submits with no factor and resolves the signed event", async () => {
    const f = fake();
    await f.controller.init();
    const ref = { kind: "derived", walletId: "w", index: 0 } as const;
    const event = {
      kind: 1,
      content: "hi",
      created_at: 1,
      tags: [],
      pubkey: f.nostrSigned.pubkey,
    };
    const pending = await f.controller.prepare({
      method: "nostr-sign",
      origin: { kind: "browser", origin: "https://dapp.example" },
      ref,
      event,
    });
    const result = await f.controller.approve(pending.id, "nostr-sign");
    expect(result).toMatchObject({
      kind: "nostr.event",
      event: { id: f.nostrSigned.id },
    });
    expect(f.nostrSignCalls).toHaveLength(1);
  });

  it("a factor-required run approved without a factor is rejected invalid-input", async () => {
    const f = fake();
    await f.controller.init();
    const request = await f.controller.prepare(PARAMS);
    await expect(f.controller.approve(request.id, "send")).rejects.toMatchObject({
      code: "invalid-input",
    });
  });
});

describe("webln-invoice and browser-origin pay", () => {
  it("approve(id, webln-invoice) creates the invoice and returns the payment request", async () => {
    const f = fake();
    await f.controller.init();
    const pending = await f.controller.prepare({
      method: "webln-invoice",
      origin: { kind: "browser", origin: "https://dapp.example" },
      ref: { walletId: "w", groupIndex: 0, network: "mainnet" },
      amountSats: 100,
      memo: "test",
    });
    const result = await f.controller.approve(pending.id, "webln-invoice");
    expect(result).toMatchObject({
      kind: "lightning.invoice",
      paymentRequest: expect.any(String),
    });
    expect(result.paymentRequest).not.toBe("");
    expect(f.nostrSignCalls).toHaveLength(0);
  });

  it("a pay request carrying a browser origin lands it on the pending request", async () => {
    const f = fake();
    await f.controller.init();
    const origin = { kind: "browser", origin: "https://dapp.example" } as const;
    const pending = await f.controller.prepare({
      method: "pay",
      origin,
      account: { walletId: "w", groupIndex: 0, network: "mainnet" },
      option: { kind: "bitcoin", address: "bc1qexampleaddress0000" },
      amountSats: 100,
    });
    expect(pending.origin).toStrictEqual(origin);
  });
});
