/**
 * R4 PoC — finding: "the host facade hands out the controllers' live mutable state". A
 * `HostController`'s `getState()` returns the same state object the controller mutates, and its
 * record fields (`txs`, `requests`, `balances`) are typed `Record<…>` — assignable and deletable
 * without any cast. Deleting a tracked transaction out from under the tracker makes its poll
 * silently stop — `pollOnce` sees the missing row and untracks — while the transaction's durable
 * row stays live and its poll is never re-armed. Expected-correct behaviour: state handed to
 * hosts is immutable (deeply readonly or copied), so tracking cannot be silently lost. The
 * `world` rig is a copy of tests/evm-broadcast.test.ts's.
 */
import { keccak256 } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import type { WalletEngine } from "../../src/engine.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { fakeSignedEvm, idleNetworkDeps, send } from "../send-helpers.ts";
import { manualTimers } from "../support/timers.ts";

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
const VERIFY = { kind: "password" as const, password: "pw" };
const SEND = {
  account: ACCOUNT,
  network: "eip155:1",
  to: "0x00000000000000000000000000000000deadbeef",
  amount: 1n,
  fee: "normal" as const,
  verify: VERIFY,
};

type Node = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  sent: string[];
  attempts: string[];
  dropSend: boolean;
};

const newNode = (): Node => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  sent: [],
  attempts: [],
  dropSend: false,
});

const answer = (node: Node, method: string, params: unknown[]): unknown => {
  switch (method) {
    case "eth_getTransactionCount":
      return `0x${(params[1] === "latest" ? node.latest : node.pending).toString(16)}`;
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
    case "eth_getBlockByNumber":
      return { number: "0x2" };
    case "eth_getBalance":
      return "0x0";
    case "eth_sendRawTransaction": {
      const raw = String(params[0]);
      node.sent.push(raw);
      const hash = keccak256(raw as `0x${string}`);
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

type Backing = { collections: Map<string, Map<string, Uint8Array>> };

const world = () => {
  const primary = newNode();
  const backing: Backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const signed: SignRequest[] = [];
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
    const node = primary;
    if (body.method === "eth_sendRawTransaction") {
      node.attempts.push(String((body.params ?? [])[0]));
      if (node.dropSend) {
        return Promise.reject(new TypeError("fetch failed"));
      }
    }
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: answer(node, body.method, body.params ?? []) };
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
      Promise.resolve({ template: "evm.bip44", network: "eip155:1", address: ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      signed.push(request);
      await Promise.resolve();
      return Promise.resolve(fakeSignedEvm(request));
    },
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
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => 1_000_000,
      logger: { warn: () => undefined },
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

  return { primary, boot, persistedTx };
};

/**
 * Type-level evidence — never invoked. The facade's `getState()` yields records a host can
 * write to: every line below typechecks without a cast.
 */
const hostCanMutate = (engine: WalletEngine): void => {
  const txs = engine.transactions.getState().txs;
  const held = txs["some-tx"];
  if (held !== undefined) {
    txs["other-tx"] = held;
  }
  delete txs["some-tx"];

  const requests = engine.requests.getState().requests;
  const pending = requests["some-req"];
  if (pending !== undefined) {
    requests["other-req"] = pending;
  }
  delete requests["some-req"];

  const balances = engine.assets.getState().balances;
  const bal = balances["some-account"];
  if (bal !== undefined) {
    balances["other-account"] = bal;
  }
  delete balances["some-account"];
};
void hostCanMutate;

describe("the host facade exposes the controllers' live mutable state", () => {
  it("deleting a transaction out of facade state silently ends its polling", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    // No cast: the controller instance satisfies the facade type it is handed to hosts as.
    const host: WalletEngine["transactions"] = ctl;

    // An unknown-outcome send stays `submitted` and is polled until the chain answers.
    node.dropSend = true;
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(timers.armed(POLL_MS)).toBe(1);

    // `getState()` returns the live state object: a host delete reaches inside the controller.
    delete host.getState().txs[tx.id];
    expect(host.getState().txs[tx.id]).toBeUndefined();

    // The next poll finds the row gone and untracks — the transaction is never polled again.
    await timers.fire(POLL_MS);
    expect(timers.armed(POLL_MS)).toBe(0);

    // …while the durable row the restart would resume from is still live on disk.
    const row = await w.persistedTx(tx.id);
    expect(row?.["state"]).toBe("submitted");
    expect(typeof row?.["hash"]).toBe("string");
    expect(typeof row?.["raw"]).toBe("string");
  });
});
