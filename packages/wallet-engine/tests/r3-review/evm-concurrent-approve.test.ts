/**
 * PoC for r3-review: the EVM nonce is checked at approval (`staleReason` → `nonceConsumed`) but
 * only reserved in `submitSigned`'s `hold()` (`commitNonce`), after signing and a persist. Two
 * approvals that overlap therefore both pass the stale check and sign the SAME nonce. Worse,
 * when the second send is refused, its `release()` (`releaseNonce`) rolls the local nonce
 * record back below the still-live first transaction, so the next send reuses nonce 0 while a
 * live submitted tx already has nonce 0.
 * Correct behaviour: reserve the nonce at approval time (or make the hold atomic with the
 * approval), and never release a nonce another live transaction holds.
 * These tests ASSERT THE CURRENT (BUGGY) BEHAVIOUR.
 */
import { keccak256, parseTransaction } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import type { TrackedTransaction } from "../../src/transactions/route.ts";
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
  /** Every raw the node's eth_sendRawTransaction was asked about, in order. */
  sent: string[];
  /** Every sendRawTransaction fetch, including ones rejected before the node saw them. */
  attempts: string[];
};

const newNode = (): Node => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  sent: [],
  attempts: [],
});

const accept = (node: Node, raw: string): string => {
  const hash = keccak256(raw as Hex);
  if (node.known.has(hash)) {
    throw new Error("already known");
  }
  node.known.add(hash);
  node.pending += 1;
  return hash;
};

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
      return accept(node, raw);
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

type SendPlan = "drop" | { code: number; message: string };

const world = () => {
  const primary = newNode();
  const clock = { t: 1_000_000 };
  const backing: Backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const signed: SignRequest[] = [];
  const warnings: string[] = [];
  let tag = 0;
  /** Per-eth_sendRawTransaction-call behaviour: "drop" kills the fetch, an object is an RPC refusal. */
  const sendPlan: SendPlan[] = [];
  let sendCalls = 0;
  /** Gate each sign call can wait on — armed per test. */
  let beforeSign: () => Promise<void> = async () => Promise.resolve();

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
      const raw = String((body.params ?? [])[0]);
      node.attempts.push(raw);
      const plan = sendCalls < sendPlan.length ? sendPlan[sendCalls] : undefined;
      sendCalls += 1;
      if (plan === "drop") {
        return Promise.reject(new TypeError("fetch failed"));
      }
      if (plan !== undefined) {
        return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, error: plan }));
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
      await beforeSign();
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
      now: () => clock.t,
      logger: { warn: (msg, err) => warnings.push(`${msg} ${String(err)}`) },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  return {
    primary,
    clock,
    backing,
    signed,
    warnings,
    sendPlan,
    boot,
    /** Waits until `n` sign calls are pending before letting any of them resolve. */
    signBarrier: (n: number) => {
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeSign = async () => {
        arrived += 1;
        if (arrived >= n) {
          release();
        }
        await gate;
      };
    },
  };
};

const hashOf = (tx: TrackedTransaction): string => {
  const { hash } = tx;
  if (hash === undefined) {
    throw new Error("tracked transaction has no hash");
  }
  return hash;
};

const nonceOf = (raw: string): number | undefined => parseTransaction(raw as Hex).nonce;

const valueOf = (raw: string): bigint | undefined => parseTransaction(raw as Hex).value;

describe("PoC: overlapping EVM approvals race the nonce reservation", () => {
  it("PoC: two concurrent approvals both sign nonce 0 — the stale check ran before the hold", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.signBarrier(2);

    const [a, b] = await Promise.all([
      send(ctl, { ...SEND, amount: 1n }),
      send(ctl, { ...SEND, amount: 2n }),
    ]);
    // Both sends were approved while neither had reserved the nonce: both signed nonce 0.
    expect(a.state).toBe("submitted");
    expect(b.state).toBe("submitted");
    expect(a.nonce).toBe(0);
    expect(b.nonce).toBe(0);
    expect(hashOf(a)).not.toBe(hashOf(b));
    expect(w.primary.sent).toHaveLength(2);
    // The wires on the node confirm it: two different transactions, both nonce 0.
    expect(w.primary.sent.map((raw) => nonceOf(raw))).toStrictEqual([0, 0]);
    console.log("sent nonces:", w.primary.sent.map((raw) => nonceOf(raw)));
  });

  it("PoC: the refused send's release rolls the nonce record below a still-live nonce-0 tx", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.signBarrier(2);
    // The first broadcast dies in transit (the node never sees it → unknown → stays submitted);
    // the second gets a JSON-RPC refusal → failed → release() rolls back the nonce record.
    w.sendPlan.push("drop", { code: -32000, message: "replacement transaction underpriced" });

    const [a, b] = await Promise.allSettled([
      send(ctl, { ...SEND, amount: 1n }),
      send(ctl, { ...SEND, amount: 2n }),
    ]);
    // The first broadcast call carried amount 1 and was dropped in transit.
    expect(valueOf(w.primary.attempts[0] ?? "0x")).toBe(1n);
    expect(valueOf(w.primary.attempts[1] ?? "0x")).toBe(2n);

    expect(a.status).toBe("fulfilled");
    const first = a.status === "fulfilled" ? a.value : undefined;
    expect(first?.state).toBe("submitted");
    expect(first?.nonce).toBe(0);

    expect(b.status).toBe("rejected");
    if (b.status === "rejected") {
      expect(String(b.reason)).toMatch(/underpriced/);
    }
    const failed = Object.values(ctl.getState().txs).find(
      (t) => t.id !== first?.id && t.state === "failed",
    );
    expect(failed?.nonce).toBe(0);

    // The nonce record was rolled back below the live first tx: the next send reuses nonce 0
    // even though the node reports pending=0 AND tx #1 is still submitted at nonce 0.
    const third = await send(ctl, SEND);
    expect(third.nonce).toBe(0);
    expect(ctl.getState().txs[first?.id ?? ""]?.state).toBe("submitted");
    expect(ctl.getState().txs[first?.id ?? ""]?.nonce).toBe(0);
    console.log(
      "nonces: first=0 (submitted, node never saw it), second=0 (refused), third=" +
        String(third.nonce),
    );
  });
});
