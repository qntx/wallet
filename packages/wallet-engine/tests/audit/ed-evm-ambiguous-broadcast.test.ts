/**
 * ED-PoC-1 — an ambiguous broadcast leaves a failed, hashless tracked tx while the node accepted
 * it, and the next send is handed a fresh nonce on top of the "failed" one.
 *
 * Exercises src/transactions/evm.ts `signSubmit` (≈139-172): the `catch` around `broadcast` marks
 * the record `failed` and returns, so `commitNonce` (≈905-908, called only after a successful
 * broadcast) never runs and the signed raw is discarded — but the node may already have the tx. The
 * EVM client is viem's `fallback([http(url)])` (src/networks/controller.ts:85) and broadcasts via
 * `client.transport.request` directly (src/chains/evm.ts:152-153 `evmRpc`); observed in this
 * configuration: the 502 surfaces after exactly one submission, so a single lost response is the
 * whole ambiguity.
 *
 * Scenario: the node ACCEPTS the first eth_sendRawTransaction (records the hash, bumps the pending
 * nonce) but answers HTTP 502. The send rejects, the tracked tx ends `failed` with `hash ===
 * undefined`, and the very next send is assigned nonce 1 — the wallet believes the first attempt
 * died while the node holds both transactions: a silent double send.
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { fakeSignedEvm, idleNetworkDeps, send } from "../send-helpers.ts";

const POLL_MS = 1;
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
  /** When true the next sendRawTransaction is accepted internally but answered with HTTP 502. */
  sendFails502: boolean;
};

const newNode = (): Node => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  sent: [],
  sendFails502: false,
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
      const hash = keccak256(raw as Hex);
      if (node.known.has(hash)) {
        // geth/reth answer a duplicate submission with -32000 "already known".
        throw Object.assign(new Error("already known"), { code: -32000 });
      }
      node.known.add(hash);
      // The tx entered the mempool, so the pending nonce moved up.
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

type Sign = ReturnType<typeof chains>["sign"];

const world = () => {
  const primary = newNode();
  const clock = { t: 1_000_000 };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const signed: SignRequest[] = [];

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
    // The ambiguous broadcast: the node keeps the tx, the response is lost in transit.
    if (body.method === "eth_sendRawTransaction" && node.sendFails502) {
      node.sendFails502 = false;
      answer(node, body.method, body.params ?? []);
      return Promise.resolve(new Response("Bad Gateway", { status: 502 }));
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

  const sign: Sign = async ({ request }) => {
    signed.push(request);
    return Promise.resolve(fakeSignedEvm(request));
  };
  const apis = {
    account: async () =>
      Promise.resolve({ template: "evm.bip44", network: "eip155:1", address: ADDR }),
    sign,
  } as unknown as ReturnType<typeof chains>;

  const boot = async () => {
    const timers: Array<() => unknown> = [];
    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: fetchImpl,
      rpc: { "eip155:1": [HOST] },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger: { warn: () => {} },
    });
    let tag = 0;
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: (ms, fn) => {
        if (ms === POLL_MS) {
          timers.push(fn);
        }
        return () => {};
      },
      now: () => clock.t,
      logger: { warn: () => {} },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  return { primary, clock, backing, signed, boot };
};

describe("ED-PoC-1 ambiguous EVM broadcast", () => {
  it("ED-PoC-1: a 502 on an accepted sendRawTransaction fails the tracked tx but the node keeps it; the next send gets nonce 1 and both can be mined", async () => {
    const w = world();
    const { ctl } = await w.boot();
    const node = w.primary;

    // The node accepts the raw tx but the HTTP reply is a 502. Observed for this client
    // configuration (`transport.request` on fallback([http])): the 502 surfaces after exactly
    // one submission — a single lost response is the whole ambiguity.
    node.sendFails502 = true;
    await expect(send(ctl, SEND)).rejects.toThrow("HTTP request failed");

    const txs = Object.values(ctl.getState().txs);
    expect(txs).toHaveLength(1);
    const failed = txs[0]!;
    // The wallet believes the send failed and has no hash…
    expect(failed.state).toBe("failed");
    expect(failed.hash).toBeUndefined();
    // …while the node really got the raw transaction and holds it in its mempool.
    expect(node.sent).toHaveLength(1); // exactly one submission — no retry happens
    expect(node.known.size).toBe(1); // the "failed" tx is known to the node
    expect(node.pending).toBe(1); // pending nonce moved on

    // The node itself would confirm a resubmit is "already known" — the tx is alive.
    expect(() => answer(node, "eth_sendRawTransaction", [node.sent[0]!])).toThrow(/already known/);

    // A subsequent identical send is assigned nonce 1 — the slot the wallet still thinks is
    // free at `latest` is occupied in the mempool, so both transactions can be mined.
    const second = await send(ctl, SEND);
    expect(second.state).toBe("submitted");
    expect(second.nonce).toBe(1);
    expect(node.known.size).toBe(2); // two DIFFERENT live transactions for the same funds
  });
});
