/**
 * A broadcast whose answer is lost or ambiguous must never fail the transaction: the signed bytes
 * and their locally computed hash are persisted and held (nonce) before anything leaves, an unknown
 * outcome is tracked and rebroadcast by hash, and only a node's own refusal fails it. Polls run on
 * `manualTimers` — faithful one-shot `setTimeout` semantics.
 */
import { keccak256, parseTransaction } from "viem";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { RESUBMIT_BASE_MS } from "../src/transactions/broadcast.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { fakeSignedEvm, idleNetworkDeps, replaceVia, send } from "./send-helpers.ts";
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
const VERIFY = { kind: "password" as const, password: "pw" };
const SEND = {
  account: ACCOUNT,
  network: "eip155:1",
  to: "0x00000000000000000000000000000000deadbeef",
  amount: 1n,
  fee: "normal" as const,
  verify: VERIFY,
};
const RECEIPT = { status: "0x1", blockNumber: "0x1" };

type Node = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  /** Every raw the node's eth_sendRawTransaction was asked about, in order. */
  sent: string[];
  /** Every sendRawTransaction fetch, including ones rejected before the node saw them. */
  attempts: string[];
  /** Answer the next sendRawTransaction with HTTP 502 after accepting it. */
  acceptThen502: boolean;
  /** Reject sendRawTransaction's fetch outright — the node never sees it. */
  dropSend: boolean;
  /** SendRawTransaction never answers. */
  hangSend: boolean;
  /** Answer a JSON-RPC refusal; `record` models a tx that landed before the refusal. */
  refuse: { code: number; message: string; record: boolean } | undefined;
  /** Accept but report a hash that is not keccak256(raw). */
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
    // geth/reth answer a duplicate submission with -32000 "already known".
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
  // Transaction ids draw on `random` — keep the counter in world scope so a restarted controller
  // never reissues an id a persisted transaction already has.
  let tag = 0;
  /** Makes the next transaction-store put carrying a hash throw once. */
  let persistBomb = false;
  /** Armed per test: makes apis.sign throw instead of returning a signature. */
  let failSign = false;
  /** Gate each sign call can wait on — armed per test via signBarrier. */
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
      await beforeSign();
      if (failSign) {
        return Promise.reject(new Error("user rejected the signature"));
      }
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
            return name !== "transactions"
              ? col
              : {
                  get: col.get,
                  list: col.list,
                  delete: col.delete,
                  put: async (key: string, bytes: Uint8Array) => {
                    if (persistBomb && new TextDecoder().decode(bytes).includes('"hash":"0x')) {
                      persistBomb = false;
                      throw new Error("engine store is on fire");
                    }
                    await col.put(key, bytes);
                  },
                };
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
    bombPersist: () => {
      persistBomb = true;
    },
    failSignatures: () => {
      failSign = true;
    },
    allowSignatures: () => {
      failSign = false;
    },
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

/** The persisted `signed` row — the state a send is in while its broadcast is unsettled. */
const signedRow = (backing: Backing): { id: string; hash: string; raw: string } | undefined => {
  const col = backing.collections.get("transactions");
  const entries = col === undefined ? [] : [...col.values()];
  const found = entries
    .map((raw) => JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>)
    .find((r) => r["state"] === "signed");
  if (found === undefined) {
    return undefined;
  }
  const { id, hash, raw } = found;
  if (typeof id !== "string" || typeof hash !== "string" || typeof raw !== "string") {
    return undefined;
  }
  return { id, hash, raw };
};

/** Resolves once the in-flight send has persisted its signed bytes and hash. */
const waitForSignedRow = async (
  backing: Backing,
): Promise<{ id: string; hash: string; raw: string }> =>
  vi.waitFor(() => {
    const found = signedRow(backing);
    if (found === undefined) {
      throw new Error("signed row not persisted yet");
    }
    return found;
  });

describe("an ambiguous EVM broadcast is tracked, not failed", () => {
  it("the node accepting but answering 502 keeps the send submitted until the receipt", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    node.acceptThen502 = true;
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(hashOf(tx)).toBe(keccak256(node.sent[0] as Hex));
    expect(tx.raw).toBe(node.sent[0]);
    expect(node.known.size).toBe(1);
    expect(node.sent).toHaveLength(1); // one submission — no silent retry

    node.receipts.set(hashOf(tx), RECEIPT);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
    expect(node.sent).toHaveLength(1); // known to the node — never rebroadcast
  });

  it("a transport failure is rebroadcast byte-identically once the node is reachable", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    node.dropSend = true;
    const first = await send(ctl, SEND);
    expect(first.state).toBe("submitted");
    expect(node.sent).toHaveLength(0); // the node never saw it

    // The unknown window: nonce 0 is still held, so the next send builds on top of it.
    node.dropSend = false;
    const second = await send(ctl, SEND);
    expect(second.state).toBe("submitted");
    expect(second.nonce).toBe(1);

    // The tracker rebroadcasts the exact persisted bytes once the poll sees the gap.
    await timers.fire(POLL_MS);
    expect(node.sent).toContain(first.raw);
    expect(node.known.has(hashOf(first))).toBe(true);

    node.receipts.set(hashOf(first), RECEIPT);
    node.receipts.set(hashOf(second), RECEIPT);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[first.id]?.state).toBe("confirmed");
    expect(ctl.getState().txs[second.id]?.state).toBe("confirmed");
  });

  it("a definitive refusal fails the send and frees the nonce", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.primary.refuse = {
      code: -32000,
      message: "insufficient funds for gas * price + value",
      record: false,
    };

    await expect(send(ctl, SEND)).rejects.toThrow(/insufficient funds/);
    const [tx] = Object.values(ctl.getState().txs);
    expect(tx?.state).toBe("failed");
    expect(tx?.hash).toBeUndefined();
    expect(tx?.raw).toBeUndefined();

    const next = await send(ctl, SEND);
    expect(next.nonce).toBe(0);
  });

  it("a refusal for bytes the node already holds is still an accepted send", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.primary.refuse = { code: -32000, message: "nonce too low", record: true };

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(hashOf(tx)).toBe(keccak256(w.primary.sent[0] as Hex));
  });

  it("an already-known answer is an accepted send", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.primary.refuse = { code: -32000, message: "already known", record: false };

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
  });

  it("an endpoint reporting a different hash is tracked by the local hash, with a warning", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.primary.reportOther = true;

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(hashOf(tx)).toBe(keccak256(w.primary.sent[0] as Hex));
    expect(w.warnings.some((m) => m.includes("broadcast outcome unknown"))).toBe(true);

    w.primary.receipts.set(hashOf(tx), RECEIPT);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
  });

  it("a restart in the unknown window keeps the nonce held and rebroadcasts the persisted raw", async () => {
    const w = world();
    const first = await w.boot();
    const node = w.primary;

    node.dropSend = true;
    const tx = await send(first.ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(node.pending).toBe(0); // the node never saw it

    const second = await w.boot();
    const reloaded = second.ctl.getState().txs[tx.id];
    expect(reloaded?.state).toBe("submitted");
    expect(reloaded?.raw).toBe(tx.raw);

    // The resumed hold survives the restart: node pending is still 0 but the send gets nonce 1.
    node.dropSend = false;
    const next = await send(second.ctl, SEND);
    expect(next.nonce).toBe(1);

    await second.timers.fire(POLL_MS);
    expect(node.sent).toContain(tx.raw);
    node.receipts.set(hashOf(tx), RECEIPT);
    await second.timers.fire(POLL_MS);
    expect(second.ctl.getState().txs[tx.id]?.state).toBe("confirmed");
  });

  it("a restart during the broadcast itself tracks the signed bytes and settles them", async () => {
    const w = world();
    const first = await w.boot();
    const node = w.primary;

    node.hangSend = true;
    const pending = send(first.ctl, SEND);
    void pending.catch(() => undefined); // never settles — the broadcast hangs forever

    // Wait until the signed bytes and their hash are persisted — the point of no return.
    const row = await waitForSignedRow(w.backing);

    const second = await w.boot();
    const reloaded = second.ctl.getState().txs[row.id];
    expect(reloaded?.state).toBe("submitted");
    expect(reloaded?.raw).toBe(row.raw);

    node.hangSend = false;
    node.receipts.set(row.hash, RECEIPT);
    await second.timers.fire(POLL_MS);
    expect(second.ctl.getState().txs[row.id]?.state).toBe("confirmed");
  });

  it("a failed rebroadcast is swallowed and retried after the backoff", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    node.dropSend = true;
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(node.attempts).toHaveLength(1);
    expect(node.sent).toHaveLength(0); // the node never saw it

    // The tracker's rebroadcast dies in transit too — swallowed, the loop goes on.
    await timers.fire(POLL_MS);
    expect(node.attempts).toHaveLength(2);
    expect(node.sent).toHaveLength(0);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
    expect(w.warnings.some((m) => m.includes("tx status poll failed"))).toBe(false);

    // Inside the backoff window the poll does not retry…
    await timers.fire(POLL_MS);
    expect(node.attempts).toHaveLength(2);

    // …once it has passed, the next poll rebroadcasts the same bytes again.
    w.clock.t += RESUBMIT_BASE_MS;
    node.dropSend = false;
    await timers.fire(POLL_MS);
    expect(node.attempts).toHaveLength(3);
    expect(node.sent).toStrictEqual([tx.raw]);

    node.receipts.set(hashOf(tx), RECEIPT);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
  });

  it("a speed-up lost to a 502 stays submitted beside the original", async () => {
    const w = world();
    const { ctl } = await w.boot();
    const original = await send(ctl, SEND);

    w.primary.acceptThen502 = true;
    const bumped = await replaceVia(ctl, original.id, "speed-up", VERIFY);
    expect(bumped.state).toBe("submitted");
    expect(bumped.replaces).toBe(original.id);
    expect(ctl.getState().txs[original.id]?.state).toBe("submitted");
    expect(w.primary.known.size).toBe(2);
  });

  it("a refused speed-up fails without releasing the original's nonce", async () => {
    const w = world();
    const { ctl } = await w.boot();
    const original = await send(ctl, SEND);

    w.primary.refuse = {
      code: -32000,
      message: "replacement transaction underpriced",
      record: false,
    };
    await expect(replaceVia(ctl, original.id, "speed-up", VERIFY)).rejects.toThrow(/underpriced/);
    const bumped = Object.values(ctl.getState().txs).find((t) => t.replaces === original.id);
    expect(bumped?.state).toBe("failed");
    expect(ctl.getState().txs[original.id]?.state).toBe("submitted");

    // A lagging pending count leaves the local hold as the only record of the original's nonce.
    w.primary.pending = 0;
    const next = await send(ctl, SEND);
    expect(next.nonce).toBe(1);
  });
});

describe("EVM nonce ownership", () => {
  it("two overlapping approvals at one nonce: the second fails before its wire is sent", async () => {
    const w = world();
    const { ctl } = await w.boot();
    // Hold both sign calls until both are pending: each approval's stale check ran while neither
    // side had reserved anything — the reservation itself must be the arbiter.
    w.signBarrier(2);

    const [a, b] = await Promise.allSettled([
      send(ctl, { ...SEND, amount: 1n }),
      send(ctl, { ...SEND, amount: 2n }),
    ]);
    const [sent, rejected] = [a, b].sort((x) => (x.status === "fulfilled" ? -1 : 1));
    expect(sent?.status).toBe("fulfilled");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(String(rejected.reason)).toMatch(/already used by another transaction/);
    }
    const out = sent?.status === "fulfilled" ? sent.value : undefined;
    expect(out?.state).toBe("submitted");
    expect(out?.nonce).toBe(0);
    expect(w.primary.attempts).toHaveLength(1);
    expect(w.primary.sent.map((raw) => parseTransaction(raw as Hex).nonce)).toStrictEqual([0]);
    // The failed reservation left nothing behind: the next send queues behind the live tx.
    const next = await send(ctl, SEND);
    expect(next.nonce).toBe(1);
  });

  it("an unknown first send keeps nonce 0; a refused send frees only its own", async () => {
    const w = world();
    const { ctl } = await w.boot();
    const node = w.primary;
    // The first broadcast dies in transit: unknown outcome, stays submitted holding nonce 0.
    node.dropSend = true;
    const first = await send(ctl, SEND);
    expect(first.state).toBe("submitted");
    expect(first.nonce).toBe(0);
    node.dropSend = false;

    node.refuse = { code: -32000, message: "underpriced", record: false };
    await expect(send(ctl, SEND)).rejects.toThrow(/underpriced/);
    // The refused send held nonce 1 and freed it; nonce 0 still belongs to the live first tx.
    const third = await send(ctl, SEND);
    expect(third.nonce).toBe(1);
    expect(ctl.getState().txs[first.id]?.state).toBe("submitted");
  });

  it("a refused signature holds no nonce — the next send reuses it", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.failSignatures();
    await expect(send(ctl, SEND)).rejects.toThrow(/user rejected/);
    expect(w.primary.attempts).toHaveLength(0);
    w.allowSignatures();
    const next = await send(ctl, SEND);
    expect(next.nonce).toBe(0);
    expect(next.state).toBe("submitted");
  });

  it("a persist failure after signing frees the reservation", async () => {
    const w = world();
    w.bombPersist();
    const { ctl } = await w.boot();
    await expect(send(ctl, SEND)).rejects.toThrow(/engine store is on fire/);
    expect(w.primary.attempts).toHaveLength(0);
    const next = await send(ctl, SEND);
    expect(next.nonce).toBe(0);
    expect(next.state).toBe("submitted");
  });

  it("a confirmed send keeps its nonce spent while the node's pending count lags", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    expect(tx.nonce).toBe(0);
    w.primary.receipts.set(hashOf(tx), RECEIPT);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
    // The endpoint's pending count still reports nothing spent; the consumed floor holds nonce 0.
    w.primary.pending = 0;
    const next = await send(ctl, SEND);
    expect(next.nonce).toBe(1);
  });

  it("a confirmed replacement frees the pair and keeps the consumed floor", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const original = await send(ctl, SEND);
    const bumped = await replaceVia(ctl, original.id, "speed-up", VERIFY);
    expect(bumped.nonce).toBe(0);
    w.primary.receipts.set(hashOf(bumped), RECEIPT);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[bumped.id]?.state).toBe("confirmed");
    expect(ctl.getState().txs[original.id]?.state).toBe("replaced");
    w.primary.pending = 0;
    const next = await send(ctl, SEND);
    expect(next.nonce).toBe(1);
  });

  it("a restart with a live replace pair re-holds both — the next send gets one past", async () => {
    const w = world();
    const first = await w.boot();
    const original = await send(first.ctl, SEND);
    const bumped = await replaceVia(first.ctl, original.id, "speed-up", VERIFY);
    expect(bumped.nonce).toBe(0);
    const second = await w.boot();
    expect(second.ctl.getState().txs[original.id]?.state).toBe("submitted");
    expect(second.ctl.getState().txs[bumped.id]?.state).toBe("submitted");
    // The mock counts accepted submissions; a real endpoint reports the account nonce (1).
    w.primary.pending = 1;
    const next = await send(second.ctl, SEND);
    expect(next.nonce).toBe(1);
  });
});
