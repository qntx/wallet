import { base58, base64 } from "@scure/base";
/**
 * Once bytes may have left the device the request never resolves as failed: a store write that
 * fails after the broadcast — the `submitted` bookkeeping row, an `included` receipt row — is
 * retried by the next poll, not thrown into the send. The durable pre-broadcast record written by
 * `submitSigned` stays the source of truth and keeps throwing.
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bombedStore, fakeSignedEvm, idleNetworkDeps, requestsFor, send } from "./send-helpers.ts";
import { persistedTx as persistedBtcTx, world as btcWorld } from "./support/btc-world.ts";
import { manualTimers } from "./support/timers.ts";

const POLL_MS = 4000;
const GATEWAY = "https://gateway.test";
const HOST = "http://host.local";
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const VERIFY_EVM = { kind: "password" as const, password: "pw" };
const SEND = {
  account: ACCOUNT,
  network: "eip155:1",
  to: "0x00000000000000000000000000000000deadbeef",
  amount: 1n,
  fee: "normal" as const,
  verify: VERIFY_EVM,
};

const hex = (n: number): string => `0x${n.toString(16)}`;
const HASH_B = `0x${"bb".repeat(32)}`;

/** A `put` bomb matching the transactions row of the given state — armed once per call. */
const rowBomb = (
  bomb: { fail: ((collection: string, key: string, bytes: Uint8Array) => boolean) | undefined },
  state: string,
): void => {
  bomb.fail = (collection, _key, bytes) =>
    collection === "transactions" && new TextDecoder().decode(bytes).includes(`"state":"${state}"`);
};

type EvmNode = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  blockHashes: Map<number, string>;
  finalized: number;
  sent: string[];
};

const newEvmNode = (): EvmNode => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  blockHashes: new Map(),
  finalized: 0,
  sent: [],
});

const evmAnswer = (node: EvmNode, method: string, params: unknown[]): unknown => {
  switch (method) {
    case "eth_getTransactionCount":
      return hex(String(params[1]) === "pending" ? node.pending : node.latest);
    case "eth_estimateGas":
      return "0x5208";
    case "eth_feeHistory":
      return {
        baseFeePerGas: ["0x1", "0x1"],
        reward: [
          ["0x1", "0x2", "0x3"],
          ["0x1", "0x2", "0x3"],
        ],
      };
    case "eth_blockNumber":
      return "0x2";
    case "eth_getBlockByNumber": {
      const [tag] = params;
      if (tag === "finalized") {
        return { number: hex(node.finalized), hash: HASH_B };
      }
      const height = Number(BigInt(String(tag)));
      const hash = node.blockHashes.get(height);
      return hash === undefined ? null : { number: hex(height), hash };
    }
    case "eth_getBalance":
      return "0x0";
    case "eth_sendRawTransaction": {
      const raw = String(params[0]);
      node.sent.push(raw);
      const hash = keccak256(raw as Hex);
      node.known.add(hash);
      node.pending += 1;
      return hash;
    }
    case "eth_getTransactionByHash":
      return node.known.has(String(params[0])) ? { hash: params[0] } : null;
    case "eth_getTransactionReceipt":
      return node.receipts.get(String(params[0])) ?? null;
    default:
      throw new Error(`unmocked ${method}`);
  }
};

const evmWorld = () => {
  const primary = newEvmNode();
  const clock = { t: 1_000_000 };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const bomb: { fail: Parameters<typeof bombedStore>[1]["fail"] } = { fail: undefined };
  const warnings: string[] = [];
  let tag = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Promise.resolve(Response.json({ networks: ["eip155:1"] }));
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: evmAnswer(primary, body.method, body.params ?? []) };
      } catch (error) {
        const e = error as Error;
        return {
          error: { code: e.message.startsWith("unmocked") ? -32601 : -1, message: e.message },
        };
      }
    })();
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, ...reply }));
  };

  const apis = {
    account: async () =>
      Promise.resolve({ template: "evm.bip44", network: "eip155:1", address: ADDR }),
    sign: async ({ request }: { request: SignRequest }) => Promise.resolve(fakeSignedEvm(request)),
  } as unknown as ReturnType<typeof chains>;

  const boot = async () => {
    const timers = manualTimers();
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: fetchImpl,
        rpc: { "eip155:1": [HOST] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      }),
      openStore: async () => Promise.resolve(bombedStore(createMemoryEngineStore(backing), bomb)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => clock.t,
      logger: { warn: (msg) => warnings.push(msg) },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  const persistedTx = async (id: string): Promise<Record<string, unknown> | undefined> => {
    const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
    return raw === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>);
  };

  return { primary, backing, warnings, bomb, boot, persistedTx };
};

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PAYER = "11111111111111111111111111111112";
const SOL_SEND = {
  account: {
    kind: "hd" as const,
    walletId: "w",
    groupIndex: 0,
    template: "solana.bip44-change" as const,
  },
  network: SOL_NET,
  to: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: 1000n,
  fee: "normal" as const,
  verify: VERIFY_EVM,
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const solWorld = () => {
  const statuses = new Map<string, unknown>();
  const wires: string[] = [];
  const env = { blockHeight: 1, slot: 500, statusSlot: 500 };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const bomb: { fail: Parameters<typeof bombedStore>[1]["fail"] } = { fail: undefined };
  const warnings: string[] = [];
  let tag = 0;

  const answerMethod = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "getLatestBlockhash":
        return {
          value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100_000 },
        };
      case "getRecentPrioritizationFees":
        return [];
      case "getMultipleAccounts":
        return { value: (Array.isArray(params[0]) ? params[0] : []).map(() => null) };
      case "simulateTransaction": {
        const cfg = isObject(params[1]) ? params[1] : undefined;
        const accounts = isObject(cfg?.["accounts"]) ? cfg["accounts"] : undefined;
        const watch = Array.isArray(accounts?.["addresses"]) ? accounts["addresses"] : [];
        return {
          value: { err: null, logs: [], unitsConsumed: 6000, accounts: watch.map(() => null) },
        };
      }
      case "getBlockHeight":
        return env.blockHeight;
      case "getEpochInfo":
        return { absoluteSlot: env.slot, blockHeight: env.blockHeight };
      case "sendTransaction": {
        const wire = String(params[0]);
        wires.push(wire);
        return base58.encode(base64.decode(wire).slice(1, 65));
      }
      case "getSignatureStatuses": {
        const sigs = Array.isArray(params[0]) ? params[0] : [];
        return {
          context: { slot: env.statusSlot },
          value: sigs.map((s) => statuses.get(String(s)) ?? null),
        };
      }
      default:
        throw new Error(`unmocked ${method}`);
    }
  };

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: answerMethod(body.method, body.params ?? []) };
      } catch (error) {
        const e = error as Error & { code?: number };
        const code = e.code ?? (e.message.startsWith("unmocked") ? -32601 : -1);
        return { error: { code, message: e.message } };
      }
    })();
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, ...reply }));
  };

  const apis = {
    account: async () =>
      Promise.resolve({ template: "solana.bip44-change", network: SOL_NET, address: PAYER }),
    sign: async ({ request }: { request: { kind: string } }) => {
      await Promise.resolve();
      if (request.kind !== "solana.transaction") {
        throw new Error("unexpected request kind");
      }
      return { kind: "solana.transaction" as const, signature: new Uint8Array(64).fill(7) };
    },
  } as unknown as ReturnType<typeof chains>;

  const boot = async () => {
    const timers = manualTimers();
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: fetchImpl,
        rpc: { [SOL_NET]: [HOST] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      }),
      openStore: async () => Promise.resolve(bombedStore(createMemoryEngineStore(backing), bomb)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => 1_000_000,
      logger: { warn: (msg) => warnings.push(msg) },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  const persistedTx = async (id: string): Promise<Record<string, unknown> | undefined> => {
    const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
    return raw === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>);
  };

  return { statuses, wires, env, backing, warnings, bomb, boot, persistedTx };
};

describe("an EVM send whose post-broadcast write fails", () => {
  it("the send resolves submitted and tracked; the next poll retries the write", async () => {
    const w = evmWorld();
    const { ctl, timers } = await w.boot();
    const node = w.primary;
    const requests = await requestsFor(ctl);

    rowBomb(w.bomb, "submitted");
    const tx = await send(ctl, SEND);
    const hash = keccak256(node.sent[0] as Hex);
    expect(tx.state).toBe("submitted");
    expect(tx.hash).toBe(hash);
    const request = Object.values(requests.getState().requests).find((r) => r.method === "send");
    expect(request?.stage).toBe("submitted");
    // The tracker is armed even though the row never reached the store — and so is the
    // bookkeeping retry that lands it.
    expect(timers.armed(POLL_MS)).toBe(2);
    await expect(w.persistedTx(tx.id)).resolves.toMatchObject({ state: "signed", hash });

    // The failed write is retried by the bookkeeping loop — once the bomb is spent it lands.
    w.bomb.fail = undefined;
    await timers.fire(POLL_MS);
    await expect(w.persistedTx(tx.id)).resolves.toMatchObject({ state: "submitted", hash });
    expect(w.warnings.some((m) => m.includes("not persisted; the retry loop stores it"))).toBe(
      true,
    );
  });

  it("a failed included write keeps the memory row confirmed until the retry lands", async () => {
    const w = evmWorld();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    const tx = await send(ctl, SEND);
    const hash = keccak256(node.sent[0] as Hex);
    node.receipts.set(hash, { status: "0x1", blockNumber: "0x1", blockHash: HASH_B });
    node.blockHashes.set(1, HASH_B);

    rowBomb(w.bomb, "confirmed");
    await timers.fire(POLL_MS);
    const memory = ctl.getState().txs[tx.id];
    expect(memory?.state).toBe("confirmed");
    expect(memory?.block?.height).toBe(1);
    // The durable trail still says submitted; the poll loop retries it.
    await expect(w.persistedTx(tx.id)).resolves.toMatchObject({ state: "submitted", hash });
    // Confirmed-not-final rows poll at the finality interval.
    expect(timers.armed(POLL_MS * 15)).toBe(1);

    w.bomb.fail = undefined;
    await timers.fire();
    await expect(w.persistedTx(tx.id)).resolves.toMatchObject({ state: "confirmed", hash });
  });
});

describe("a Solana send whose post-broadcast write fails", () => {
  it("the send resolves submitted and tracked; the next poll retries the write", async () => {
    const w = solWorld();
    const { ctl, timers } = await w.boot();
    rowBomb(w.bomb, "submitted");

    const tx = await send(ctl, SOL_SEND);
    expect(tx.state).toBe("submitted");
    expect(tx.hash).not.toBe("");
    expect(w.wires).toHaveLength(1);
    expect(timers.armed(POLL_MS)).toBe(2); // the poll and the bookkeeping retry
    await expect(w.persistedTx(tx.id)).resolves.toMatchObject({ state: "signed" });

    w.bomb.fail = undefined;
    await timers.fire(POLL_MS);
    await expect(w.persistedTx(tx.id)).resolves.toMatchObject({
      state: "submitted",
      hash: tx.hash,
    });
  });
});

describe("a Bitcoin send whose post-broadcast write fails", () => {
  it("the send resolves submitted and tracked; the next poll retries the write", async () => {
    const w = btcWorld();
    w.fund(1, 50_000);
    rowBomb(w.bomb, "submitted");
    const booted = await w.boot();

    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).toBe("submitted");
    expect(w.broadcasts).toHaveLength(1);
    expect(booted.timers.armed(POLL_MS)).toBe(2); // the poll and the bookkeeping retry

    w.bomb.fail = undefined;
    await booted.polls(1);
    await expect(persistedBtcTx(booted.backing, tx.id)).resolves.toMatchObject({
      state: "submitted",
      hash: tx.hash,
    });
  });
});
