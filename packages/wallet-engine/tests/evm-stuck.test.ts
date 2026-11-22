/**
 * An EVM send whose outcome is unknown is never ended by a timer. Thirty minutes after the last
 * endpoint saw it, the row turns `stuck` — still `submitted`, still holding its nonce, polled at
 * the finality interval, speed-up and cancel the offered remedies. `dropped` on EVM comes only from
 * the nonce passing without its receipt (cross-checked against the host endpoint), an on-chain
 * failure, or a replacement.
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { STUCK_AFTER_MS } from "../src/transactions/broadcast.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { DROP_CONFIRMATIONS } from "../src/transactions/evm.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import {
  fakeSignedEvm,
  idleNetworkDeps,
  replaceVia,
  send,
  simulateV1Result,
} from "./send-helpers.ts";
import { manualTimers } from "./support/timers.ts";
import type { ManualTimers } from "./support/timers.ts";

const POLL_MS = 4000;
const FINALITY_MS = 15 * POLL_MS;
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
const RECEIPT = { status: "0x1", blockNumber: "0x1", blockHash: `0x${"11".repeat(32)}` };
const STUCK_NOTE =
  "the network has not seen this transaction for 30 minutes — speed up or cancel it";

type Node = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  /** Every raw the node's eth_sendRawTransaction processed, rebroadcasts included. */
  sent: string[];
  /** Every sendRawTransaction fetch, including ones rejected before the node saw them. */
  attempts: string[];
  /** Every eth_getTransactionReceipt lookup, by hash — "was this transaction re-checked". */
  receiptReads: string[];
  /** The next sendRawTransaction answers with this JSON-RPC error; `record` records it too. */
  refuse: { code: number; message: string; record: boolean } | undefined;
  /** SendRawTransaction's fetch rejects: the bytes never reach the node. */
  dropSend: boolean;
};

const newNode = (): Node => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  sent: [],
  attempts: [],
  receiptReads: [],
  refuse: undefined,
  dropSend: false,
});

const answer = (node: Node, method: string, params: unknown[]): unknown => {
  switch (method) {
    case "eth_getTransactionCount":
      return `0x${(params[1] === "latest" ? node.latest : node.pending).toString(16)}`;
    case "eth_gasPrice":
      return "0x1";
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
    case "eth_simulateV1":
      return { result: simulateV1Result(params) };
    case "eth_sendRawTransaction": {
      const raw = String(params[0]);
      node.sent.push(raw);
      const { refuse } = node;
      if (refuse !== undefined) {
        node.refuse = undefined;
        if (refuse.record) {
          node.known.add(keccak256(raw as Hex));
          node.pending += 1;
        }
        throw Object.assign(new Error(refuse.message), { code: refuse.code });
      }
      const hash = keccak256(raw as Hex);
      node.known.add(hash);
      node.pending += 1;
      return hash;
    }
    case "eth_getTransactionByHash":
      return node.known.has(String(params[0])) ? { hash: params[0] } : null;
    case "eth_getTransactionReceipt":
      node.receiptReads.push(String(params[0]));
      return node.receipts.get(String(params[0])) ?? null;
    default:
      throw new Error(`unmocked ${method}`);
  }
};

type Backing = { collections: Map<string, Map<string, Uint8Array>> };

const world = (options: { gateway?: boolean } = {}) => {
  const primary = newNode();
  const independent = newNode();
  const clock = { t: 1_000_000 };
  const backing: Backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const signed: SignRequest[] = [];
  let tag = 0;
  /** Armed per test: every sendRawTransaction waits on this gate. */
  let sendGate: { promise: Promise<void>; open: () => void } | undefined;
  /** Armed per test: every non-gateway fetch rejects — a dead host endpoint. */
  let failIndependent = false;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Promise.resolve(Response.json({ networks: ["eip155:1"] }));
    }
    if (options.gateway === true && !url.startsWith(GATEWAY) && failIndependent) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const body = isObject(parsed) ? parsed : {};
    const method = typeof body["method"] === "string" ? body["method"] : "";
    const params: unknown[] = Array.isArray(body["params"]) ? body["params"] : [];
    const node = options.gateway === true && !url.startsWith(GATEWAY) ? independent : primary;
    if (method === "eth_sendRawTransaction") {
      node.attempts.push(String(params[0]));
      const gate = sendGate;
      if (gate !== undefined) {
        await gate.promise;
      }
      if (node.dropSend) {
        return Promise.reject(new TypeError("fetch failed"));
      }
    }
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: answer(node, method, params) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const thrown =
          isObject(error) && typeof error["code"] === "number" ? error["code"] : undefined;
        const code = thrown ?? (message.startsWith("unmocked") ? -32601 : -1);
        return { error: { code, message } };
      }
    })();
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, ...reply }));
  };

  const apis = {
    // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
    account: async () => ({ template: "evm.bip44", network: "eip155:1", address: ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      signed.push(request);
      await Promise.resolve();
      return fakeSignedEvm(request);
    },
  } as unknown as ReturnType<typeof chains>;

  const boot = async () => {
    const timers = manualTimers();
    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: fetchImpl,
      rpc: { "eip155:1": [HOST] },
      // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
      openStore: async () => createMemoryEngineStore(),
      logger: { warn: () => undefined },
      ...(options.gateway === true
        ? {
            gateway: {
              url: GATEWAY,
              clientIds: {
                evm: "a".repeat(32),
                solana: "a".repeat(32),
                bitcoin: "a".repeat(32),
                tron: "a".repeat(32),
                service: "a".repeat(32),
              },
            },
          }
        : {}),
    });
    if (options.gateway === true) {
      await networks.init();
    }
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks,
      // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
      openStore: async () => createMemoryEngineStore(backing),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => clock.t,
      logger: { warn: () => undefined },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  return {
    primary,
    independent,
    clock,
    backing,
    signed,
    boot,
    armSendGate: () => {
      let open!: () => void;
      sendGate = {
        promise: new Promise<void>((resolve) => {
          open = resolve;
        }),
        open,
      };
    },
    releaseSendGate: () => {
      sendGate?.open();
      sendGate = undefined;
    },
    failIndependent: (on: boolean) => {
      failIndependent = on;
    },
  };
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hashOf = (tx: TrackedTransaction): string => {
  if (tx.hash === undefined) {
    throw new Error("transaction has no hash");
  }
  return tx.hash;
};

const rowOf = (ctl: TransactionController, id: string): TrackedTransaction => {
  const row = ctl.getState().txs[id];
  if (row === undefined) {
    throw new Error(`transaction ${id} is gone`);
  }
  return row;
};

const receiptReadsOf = (node: Node, hash: string): number =>
  node.receiptReads.filter((h) => h === hash).length;

const persistedTx = async (
  backing: Backing,
  id: string,
): Promise<Record<string, unknown> | undefined> => {
  const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
  if (raw === undefined) {
    return undefined;
  }
  const decoded: unknown = JSON.parse(new TextDecoder().decode(raw));
  return isObject(decoded) ? decoded : undefined;
};

/** Probe for `until`: true once the flag's predicate holds. */
const raised = (probe: () => boolean) => (): true | undefined => (probe() ? true : undefined);

/** `count` poll turns: every live poll timer fires once per turn, like the real loop schedule. */
const polls = async (timers: ManualTimers, count = 1): Promise<void> => {
  for (let i = 0; i < count; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each poll re-arms the next
    await timers.fire(POLL_MS);
  }
};

/** Polls `probe` on the real clock — the fake runners' waitFor never fires under these timers. */
const until = async <T>(probe: () => T | undefined, what: string): Promise<T> => {
  for (let i = 0; i < 500; i += 1) {
    const found = probe();
    if (found !== undefined) {
      return found;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- a fixed-interval probe stays sequential
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A send whose broadcast answer never comes back (transport failure): `submitted`, the outcome
 * unknown, and the node never learns the hash — as close to "lost in transit" as a node gets.
 */
const sendUnseen = async (
  w: ReturnType<typeof world>,
  ctl: TransactionController,
): Promise<TrackedTransaction> => {
  w.primary.dropSend = true;
  const tx = await send(ctl, SEND);
  expect(tx.state).toBe("submitted");
  expect(w.primary.sent).toHaveLength(0);
  return tx;
};

/** Sends `tx` unseen, then drives its unknown window past `STUCK_AFTER_MS`. */
const stuckSend = async (
  w: ReturnType<typeof world>,
  ctl: TransactionController,
  timers: ManualTimers,
): Promise<TrackedTransaction> => {
  const tx = await sendUnseen(w, ctl);
  await timers.fire(POLL_MS); // the first unknown sighting starts the window
  w.clock.t += STUCK_AFTER_MS + 1;
  await timers.fire(POLL_MS);
  return tx;
};

describe("an EVM transaction the network never sees", () => {
  it("turns stuck instead of dropped, keeps its nonce, and confirms when it lands", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const a = await stuckSend(w, ctl, timers);
    const hashA = hashOf(a);

    // Stuck, not dropped: still submitted, still tracked — at the finality interval now —
    // still holding nonce 0, and the row says why.
    const row = rowOf(ctl, a.id);
    expect(row.state).toBe("submitted");
    expect(row.stuck).toBe(true);
    expect(row.error).toBe(STUCK_NOTE);
    expect(timers.armed(POLL_MS)).toBe(0);
    expect(timers.armed(FINALITY_MS)).toBe(1);

    // The nonce is never freed: the next send signs nonce 1 — a re-send at 0 cannot exist.
    w.primary.dropSend = false;
    const b = await send(ctl, SEND);
    expect(b.nonce).toBe(1);
    expect(b.state).toBe("submitted");

    // The bytes had in fact landed elsewhere: the receipt surfaces at the next finality poll
    // and the row confirms — it could never have displayed dropped while mined.
    w.primary.receipts.set(hashA, RECEIPT);
    w.primary.latest = 1;
    await timers.fire(FINALITY_MS);
    expect(rowOf(ctl, a.id).state).toBe("confirmed");
    const b2 = rowOf(ctl, b.id);
    expect(b2.state).toBe("submitted");
    expect(b2.nonce).toBe(1);
  });

  it("a landed original confirms while its tracked re-send stays live at the next nonce", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const a = await stuckSend(w, ctl, timers);
    const hashA = hashOf(a);

    // The re-send is built while A is stuck: it gets nonce 1 — the held nonce is never re-issued.
    w.primary.dropSend = false;
    const b = await send(ctl, SEND);
    expect(b.nonce).toBe(1);
    expect(w.primary.known.has(hashOf(b))).toBe(true);

    // A lands: the original confirms; the re-send keeps its own poll and nonce.
    w.primary.receipts.set(hashA, RECEIPT);
    w.primary.latest = 1;
    await timers.fire(FINALITY_MS);
    expect(rowOf(ctl, a.id).state).toBe("confirmed");
    expect(rowOf(ctl, b.id).state).toBe("submitted");

    // B lands too: both rows confirm — nothing was ever double-paid by the tracker.
    w.primary.receipts.set(hashOf(b), RECEIPT);
    w.primary.latest = 2;
    await timers.fire(POLL_MS);
    await timers.fire(POLL_MS);
    expect(rowOf(ctl, b.id).state).toBe("confirmed");
  });

  it("stays stuck across a restart without flapping — persisted, re-tracked, re-marked", async () => {
    const w = world();
    const first = await w.boot();
    const a = await stuckSend(w, first.ctl, first.timers);
    expect(rowOf(first.ctl, a.id).stuck).toBe(true);
    const persisted = await persistedTx(w.backing, a.id);
    expect(persisted?.["stuck"]).toBe(true);

    first.ctl.lock();
    const second = await w.boot();
    const row = rowOf(second.ctl, a.id);
    expect(row.state).toBe("submitted");
    expect(row.stuck).toBe(true);
    expect(row.error).toBe(STUCK_NOTE);
    // Tracked at the finality interval from the start — never re-polling at pollMs.
    expect(second.timers.armed(POLL_MS)).toBe(0);
    expect(second.timers.armed(FINALITY_MS)).toBe(1);
    const readsBefore = receiptReadsOf(w.primary, hashOf(a));
    await second.timers.fire(FINALITY_MS);
    // Still stuck after the poll — the watch started already-stuck, it did not un-stick first.
    expect(rowOf(second.ctl, a.id).stuck).toBe(true);
    expect(receiptReadsOf(w.primary, hashOf(a))).toBeGreaterThan(readsBefore);
  });

  it("clears the stuck flag and note once an endpoint knows it again", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const a = await stuckSend(w, ctl, timers);
    expect(rowOf(ctl, a.id).stuck).toBe(true);

    // The mempool finally admits it (a rebroadcast landed, or the answer was only lost).
    w.primary.known.add(hashOf(a));
    await timers.fire(FINALITY_MS);
    const row = rowOf(ctl, a.id);
    expect(row.state).toBe("submitted");
    expect(row.stuck).toBeUndefined();
    expect(row.error).toBeUndefined();
    expect(timers.armed(POLL_MS)).toBe(1);
    expect(timers.armed(FINALITY_MS)).toBe(0);
  });
});

describe("the nonce-passed drop rule asks the independent endpoint first", () => {
  const consumedSend = async (
    w: ReturnType<typeof world>,
    ctl: TransactionController,
  ): Promise<TrackedTransaction> => {
    const tx = await send(ctl, SEND);
    // The confirmed count has passed the nonce, and the primary has no receipt.
    w.primary.latest = tx.nonce + 1;
    return tx;
  };

  it("does not end when the host endpoint has our receipt", async () => {
    const w = world({ gateway: true });
    const { ctl, timers } = await w.boot();
    const tx = await consumedSend(w, ctl);
    w.independent.receipts.set(hashOf(tx), RECEIPT);
    await polls(timers, DROP_CONFIRMATIONS);
    expect(rowOf(ctl, tx.id).state).toBe("submitted");
  });

  it("does not end while the host endpoint cannot answer", async () => {
    const w = world({ gateway: true });
    const { ctl, timers } = await w.boot();
    const tx = await consumedSend(w, ctl);
    w.failIndependent(true);
    await polls(timers, DROP_CONFIRMATIONS);
    expect(rowOf(ctl, tx.id).state).toBe("submitted");
  });

  it("ends dropped when neither endpoint has a receipt", async () => {
    const w = world({ gateway: true });
    const { ctl, timers } = await w.boot();
    const tx = await consumedSend(w, ctl);
    await polls(timers, DROP_CONFIRMATIONS);
    expect(rowOf(ctl, tx.id).state).toBe("dropped");
  });
});

describe("a gap note outranks the stuck note", () => {
  it("shows the gap note while stuck, then the stuck note once the gap is filled", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    // A's send is refused — nonce 0 is free again; B signs nonce 1 above the gap.
    w.armSendGate();
    const sendA = send(ctl, SEND);
    void sendA.catch(() => undefined);
    await until(
      raised(() => node.attempts.length === 1),
      "A's broadcast attempt",
    );
    const sendB = send(ctl, SEND);
    await until(
      raised(() => node.attempts.length === 2),
      "B's broadcast attempt",
    );
    node.refuse = {
      code: -32000,
      message: "insufficient funds for gas * price + value",
      record: false,
    };
    w.releaseSendGate();
    await expect(sendA).rejects.toThrow(/insufficient funds/);
    const b = await sendB;
    expect(b.state).toBe("submitted");
    expect(b.nonce).toBe(1);

    // B becomes unreachable: the gap note wins as the error text — stuck stays true. geth's
    // pending count excludes the queued gapped transaction, so the gap's base is still 0.
    node.known.delete(hashOf(b));
    node.dropSend = true;
    node.pending = 0;
    await timers.fire(POLL_MS);
    w.clock.t += STUCK_AFTER_MS + 1;
    await timers.fire(POLL_MS);
    const row = rowOf(ctl, b.id);
    expect(row.stuck).toBe(true);
    expect(row.error).toBe(
      "nonce 0 below this transaction was never sent — the next send from this account fills it",
    );
  });

  it("an external pool transaction at the gap nonce silences the note", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    w.armSendGate();
    const sendA = send(ctl, SEND);
    void sendA.catch(() => undefined);
    await until(
      raised(() => node.attempts.length === 1),
      "A's broadcast attempt",
    );
    const sendB = send(ctl, SEND);
    await until(
      raised(() => node.attempts.length === 2),
      "B's broadcast attempt",
    );
    node.refuse = {
      code: -32000,
      message: "insufficient funds for gas * price + value",
      record: false,
    };
    w.releaseSendGate();
    await expect(sendA).rejects.toThrow(/insufficient funds/);
    const b = await sendB;
    expect(b.state).toBe("submitted");
    expect(b.nonce).toBe(1);

    // geth's pending count excludes queued gapped transactions but counts executable ones —
    // an external tx at nonce 0 is a base of 1, so nonce 0 is no gap.
    node.pending = 1;
    await timers.fire(POLL_MS);
    expect(rowOf(ctl, b.id).error).toBeUndefined();
  });
});

/** A stuck row accepts `mode`, the node takes the replacement, it lands and replaces the row. */
const exerciseRemedy = async (
  mode: "speed-up" | "cancel",
): Promise<{ ctl: TransactionController; a: TrackedTransaction }> => {
  const w = world();
  const { ctl, timers } = await w.boot();
  const a = await stuckSend(w, ctl, timers);
  expect(rowOf(ctl, a.id).stuck).toBe(true);

  w.primary.dropSend = false;
  const replacement = await replaceVia(ctl, a.id, mode, VERIFY);
  expect(replacement.replaces).toBe(a.id);
  expect(replacement.nonce).toBe(a.nonce);
  expect(replacement.state).toBe("submitted");
  // The node knows the replacement — the original's pool eviction is explained, not stuck.
  expect(w.primary.known.has(hashOf(replacement))).toBe(true);
  // The original's next poll sees the live replacement and clears the mark.
  await timers.fire(FINALITY_MS);
  const originalRow = rowOf(ctl, a.id);
  expect(originalRow.state).toBe("submitted");
  expect(originalRow.stuck).toBeUndefined();

  w.primary.receipts.set(hashOf(replacement), RECEIPT);
  w.primary.latest = 1;
  await timers.fire(POLL_MS);
  return { ctl, a };
};

describe("a stuck transaction's remedies", () => {
  it("speeds up — the replacement confirms and the original is replaced", async () => {
    const { ctl, a } = await exerciseRemedy("speed-up");
    expect(rowOf(ctl, a.id).state).toBe("replaced");
  });

  it("cancels — the replacement confirms and the original is replaced", async () => {
    const { ctl, a } = await exerciseRemedy("cancel");
    expect(rowOf(ctl, a.id).state).toBe("replaced");
  });
});
