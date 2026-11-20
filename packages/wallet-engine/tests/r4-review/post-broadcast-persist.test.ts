/**
 * R4 PoC — finding: "a post-broadcast persistence failure strands a sent transaction, and the
 * batch error calls any post-first failure a network refusal". In `submitSigned` the durable
 * `signed` write lands before broadcast, but `submitTx`'s `submitted` write is non-durable and
 * runs after the bytes left: if it throws, the send reports failed and `ctx.track` never runs —
 * in this session nothing polls a transaction the node accepted; only a restart resumes it.
 * Expected-correct behaviour: once bytes are out, the transaction is tracked regardless of a
 * local write failure. In `submitInOrder`, any error past index 0 becomes `refused` —
 * `broadcastRefused` then tells the dApp "the network refused" a transaction that was actually
 * broadcast (its id is not in the do-not-resubmit list), or one that never went out (vault lock).
 * The `world` rig is a copy of tests/evm-broadcast.test.ts's with a bomb on the submitted write.
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { broadcastRefused } from "../../src/connect/errors.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { submitInOrder, submitSigned } from "../../src/transactions/broadcast.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import type { RouteContext, TrackedTransaction } from "../../src/transactions/route.ts";
import { fakeSignedEvm, idleNetworkDeps, requestsFor, send } from "../send-helpers.ts";
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
  acceptThen502: boolean;
  dropSend: boolean;
  hangSend: boolean;
  refuse: { code: number; message: string; record: boolean } | undefined;
  reportOther: boolean;
};

const newNode = (): Node => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  sent: [],
  attempts: [],
  acceptThen502: false,
  dropSend: false,
  hangSend: false,
  refuse: undefined,
  reportOther: false,
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
      const { refuse } = node;
      if (refuse !== undefined) {
        node.refuse = undefined;
        if (refuse.record) {
          const hash = keccak256(raw as Hex);
          node.known.add(hash);
          node.pending += 1;
        }
        throw Object.assign(new Error(refuse.message), { code: refuse.code });
      }
      return node.reportOther ? `0x${"ff".repeat(32)}` : accept(node, raw);
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
  const clock = { t: 1_000_000 };
  const backing: Backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const signed: SignRequest[] = [];
  const warnings: string[] = [];
  let tag = 0;
  /** Makes the transactions-store put of the `"submitted"` row throw once. */
  let submittedBomb = false;

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
      if (node.hangSend) {
        return new Promise<Response>(() => {});
      }
      if (node.dropSend) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      if (node.acceptThen502) {
        node.acceptThen502 = false;
        answer(node, body.method, body.params ?? []);
        return Promise.resolve(new Response("Bad Gateway", { status: 502 }));
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
      openStore: async () => {
        const store = createMemoryEngineStore(backing);
        return Promise.resolve({
          collection: (name: string) => {
            const col = store.collection(name);
            return name === "transactions"
              ? {
                  get: col.get,
                  list: col.list,
                  delete: col.delete,
                  put: async (key: string, bytes: Uint8Array) => {
                    const row = new TextDecoder().decode(bytes);
                    if (submittedBomb && row.includes('"state":"submitted"')) {
                      submittedBomb = false;
                      throw new Error("engine store is on fire");
                    }
                    await col.put(key, bytes);
                  },
                }
              : col;
          },
          close: store.close,
        });
      },
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

  const persistedTx = async (id: string): Promise<Record<string, unknown> | undefined> => {
    const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
    return raw === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>);
  };

  return {
    primary,
    clock,
    backing,
    signed,
    warnings,
    boot,
    persistedTx,
    bombSubmitted: () => {
      submittedBomb = true;
    },
  };
};

/** A minimal `RouteContext` driving `submitSigned`/`submitInOrder` directly. */
const fakeCtx = (failTransition: (txId: string, next: Partial<TrackedTransaction>) => boolean) => {
  const rows = new Map<string, TrackedTransaction>();
  const tracked: string[] = [];
  const ctx: RouteContext = {
    options: {
      wallet: {} as Wallet,
      networks: {} as RouteContext["options"]["networks"],
      openStore: async () => {
        await Promise.resolve();
        throw new Error("no store in this rig");
      },
      random: (n) => new Uint8Array(n).fill(7),
      setTimer: () => () => undefined,
      now: () => 0,
      logger: { warn: () => undefined },
    },
    transition: async (tx, next, _durable) => {
      await Promise.resolve();
      if (failTransition(tx.id, next)) {
        throw new Error(
          next.state === "signed" || next.raw !== undefined
            ? "transactions require an unlocked vault"
            : "engine store is on fire",
        );
      }
      const updated: TrackedTransaction = { ...tx, ...next };
      rows.set(tx.id, updated);
      return updated;
    },
    track: (id) => {
      tracked.push(id);
    },
    txs: () => Object.fromEntries(rows),
    newId: () => "tx-new",
  };
  return { ctx, rows, tracked };
};

const draftTx = (id: string): TrackedTransaction => ({
  id,
  family: "evm",
  network: "eip155:1",
  account: "w",
  hash: undefined,
  state: "signed",
  intent: undefined,
  nonce: 0,
  submittedAt: 0,
  error: undefined,
});

describe("a persistence failure after the broadcast", () => {
  it("strands an accepted transaction: send fails, no poll is armed, the row stays `signed`", async () => {
    const w = world();
    w.bombSubmitted();
    const { ctl, timers } = await w.boot();
    const node = w.primary;
    const requests = await requestsFor(ctl);

    // The post-broadcast `submitted` write throws — after the node already accepted the raw.
    await expect(send(ctl, SEND)).rejects.toThrow(/engine store is on fire/);
    const hash = keccak256(node.sent[0] as Hex);
    expect(node.sent).toHaveLength(1); // the node received and accepted the bytes
    expect(node.known.has(hash)).toBe(true);

    // The request reports failure even though the transaction is on the network.
    const request = Object.values(requests.getState().requests).find((r) => r.method === "send");
    expect(request?.stage).toBe("failed");

    // `ctx.track` never ran: this session never polls for the accepted transaction.
    expect(timers.armed(POLL_MS)).toBe(0);

    const [tx] = Object.values(ctl.getState().txs);
    expect(tx?.state).toBe("submitted"); // in memory it sits mid-transition…
    const row = await w.persistedTx(tx?.id ?? "");
    expect(row?.["state"]).toBe("signed"); // …but durable only up to `signed`
    expect(row?.["hash"]).toBe(hash);
    expect(row?.["raw"]).toBe(node.sent[0]);
  });
});

describe("submitInOrder error vocabulary", () => {
  const rig = () => {
    const sends: string[] = [];
    const released: string[] = [];
    const tracked: string[] = [];
    const make = (ctx: RouteContext) => {
      const submitOne = (index: number): Promise<string> => {
        const id = `hash${String(index)}`;
        return submitSigned(ctx, draftTx(`tx-${String(index)}`), {
          id,
          raw: `raw${String(index)}`,
          hold: () => undefined,
          release: () => {
            released.push(id);
          },
          send: async () => {
            sends.push(`raw${String(index)}`);
            return Promise.resolve(id);
          },
          verdict: () => undefined,
          known: async () => Promise.resolve(false),
        }).then((tracked_) => tracked_.hash ?? id);
      };
      return submitOne;
    };
    return { sends, released, tracked, make };
  };

  it("a post-broadcast write failure is reported to the dApp as a network refusal", async () => {
    // Item 1's non-durable `submitted` write throws — AFTER its send() already went out.
    const { ctx } = fakeCtx((txId, next) => txId === "tx-1" && next.state === "submitted");
    const { sends, make } = rig();

    const batch = await submitInOrder(2, make(ctx));
    expect(sends).toStrictEqual(["raw0", "raw1"]); // both transactions were broadcast
    expect(batch.ids).toStrictEqual(["hash0"]);
    expect(batch.refused?.index).toBe(1);

    const error = broadcastRefused(batch.refused ?? { index: -1, error: "" }, batch.ids);
    // The message claims the network refused transaction 1 and lists only hash0 as sent —
    // transaction 1's bytes went out and the dApp is told they did not.
    expect(error.message).toContain("the network refused transaction 1");
    expect(error.message).toContain("engine store is on fire");
    expect(error.message).toContain("do not resubmit: hash0");
    expect(error.message).not.toContain("hash1");
  });

  it("a locked vault on the durable write is still reported as a network refusal", async () => {
    // Item 1's durable write throws "transactions require an unlocked vault" — nothing was
    // sent for it, yet the dApp hears "the network refused".
    const { ctx } = fakeCtx((txId, next) => txId === "tx-1" && next.hash !== undefined);
    const { sends, released, make } = rig();

    const batch = await submitInOrder(2, make(ctx));
    expect(sends).toStrictEqual(["raw0"]); // item 1 never left — the vault locked first
    expect(released).toStrictEqual(["hash1"]); // its hold was freed
    expect(batch.ids).toStrictEqual(["hash0"]);
    const error = broadcastRefused(batch.refused ?? { index: -1, error: "" }, batch.ids);
    expect(error.message).toContain("the network refused transaction 1");
    expect(error.message).toContain("transactions require an unlocked vault");
    expect(error.message).toContain("do not resubmit: hash0");
  });
});
