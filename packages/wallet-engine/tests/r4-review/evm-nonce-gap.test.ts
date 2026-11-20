/**
 * R4 PoC — finding: "nonce holds are released but never back-filled". `EvmNonces.next` is one past
 * the highest held nonce, so once a lower-nonce transaction dies (refused broadcast, 30-minute
 * unknown drop, or a failed row settled across lock/unlock) every later send signs above the hole:
 * the freed nonce is never re-issued and the queued transactions can never mine while it stays
 * empty. Expected-correct behaviour: a nonce released without being consumed is reused before any
 * higher nonce is signed. The `world` rig is a copy of tests/evm-broadcast.test.ts's, extended
 * with a gate that holds the first `eth_sendRawTransaction` open.
 */
import { keccak256, parseTransaction } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { UNKNOWN_DROP_MS } from "../../src/transactions/broadcast.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import type { TrackedTransaction } from "../../src/transactions/route.ts";
import { approval } from "../approval.ts";
import {
  fakeSignedEvm,
  idleNetworkDeps,
  requestsFor,
  send,
} from "../send-helpers.ts";
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
const LIVE_STATES = new Set(["signed", "submitted", "pending"]);

type Node = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  /** Every raw the node's eth_sendRawTransaction was asked about, in order. */
  sent: string[];
  /** Every sendRawTransaction fetch, including ones rejected before the node saw them. */
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
  let persistBomb = false;
  /** Armed per test: the next sendRawTransaction waits on this gate before the node answers. */
  let sendGate: { promise: Promise<void>; open: () => void } | undefined;

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
      // An armed gate holds the send until released; a released one passes through.
      const gate = sendGate;
      if (gate !== undefined) {
        await gate.promise;
      }
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
                    if (persistBomb && new TextDecoder().decode(bytes).includes('"hash":"0x')) {
                      persistBomb = false;
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
    bombPersist: () => {
      persistBomb = true;
    },
    /** The next sendRawTransaction is held at the gate until `releaseSendGate` runs. */
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

/** Polls `cond` on the real clock — `vi.waitFor` never fires under this runner. */
const until = async <T>(probe: () => T | undefined, what: string): Promise<T> => {
  for (let i = 0; i < 500; i += 1) {
    const found = probe();
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Resolves once the in-flight send has persisted its signed bytes and hash. */
const waitForSignedRow = async (
  backing: Backing,
): Promise<{ id: string; hash: string; raw: string }> =>
  until(() => signedRow(backing), "the durable signed row");

describe("a dead lower nonce is never re-issued — every later send signs above the gap", () => {
  it("a refused lower nonce leaves a gap every later send signs above", async () => {
    const w = world();
    const { ctl } = await w.boot();
    const node = w.primary;
    const requests = await requestsFor(ctl);

    // A's broadcast hangs at the node: nonce 0 is already reserved and its signed row persisted.
    w.armSendGate();
    const sendA = send(ctl, SEND);
    void sendA.catch(() => undefined);
    await until(
      () => (node.attempts.length === 1 ? node.attempts[0] : undefined),
      "A's broadcast attempt",
    );
    const [a] = Object.values(ctl.getState().txs);
    expect(a?.nonce).toBe(0);
    expect(a?.state).toBe("signed");

    // B is prepared while A still holds nonce 0: the build takes the next nonce, 1.
    const { verify: _verify, ...sendParams } = SEND;
    const bRequest = await requests.prepare({ method: "send", ...sendParams });

    // The node refuses A's exact bytes for good: A fails and nonce 0 is freed — but stays empty.
    node.refuse = {
      code: -32000,
      message: "insufficient funds for gas * price + value",
      record: false,
    };
    w.releaseSendGate();
    await expect(sendA).rejects.toThrow(/insufficient funds/);
    expect(ctl.getState().txs[a?.id ?? ""]?.state).toBe("failed");

    const b = await requests.approve(bRequest.id, "send", approval(bRequest, VERIFY));
    expect(b.state).toBe("submitted");
    expect(b.nonce).toBe(1);
    expect(node.known.has(hashOf(b))).toBe(true);

    // Geth semantics: a gapped account's pending nonce equals the state nonce — still 0.
    node.pending = 0;
    const c = await send(ctl, SEND);
    expect(c.state).toBe("submitted");
    expect(c.nonce).toBe(2); // nonce 0 was never re-issued

    const live = Object.values(ctl.getState().txs).filter((t) => LIVE_STATES.has(t.state));
    expect(live.some((t) => t.nonce === 0)).toBe(false);
    expect(node.sent.map((raw) => parseTransaction(raw as Hex).nonce)).toStrictEqual([0, 1, 2]);
    // B and C sit above an unfilled nonce 0: neither can ever mine until something fills it.
  });

  it("an unknown lower nonce dropped after 30 min leaves the same gap", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    // A's broadcast dies in transit: unknown outcome, submitted, holding nonce 0.
    node.dropSend = true;
    const a = await send(ctl, SEND);
    expect(a.state).toBe("submitted");
    expect(a.nonce).toBe(0);
    expect(node.sent).toHaveLength(0);

    node.dropSend = false;
    const b = await send(ctl, SEND);
    expect(b.nonce).toBe(1);
    expect(node.known.has(hashOf(b))).toBe(true);
    // A's bytes still never propagate, however often the tracker rebroadcasts them.
    node.dropSend = true;

    await timers.fire(POLL_MS); // first unknown sighting starts the drop window
    w.clock.t += UNKNOWN_DROP_MS + 1;
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[a.id]?.state).toBe("dropped");
    expect(ctl.getState().txs[b.id]?.state).toBe("submitted");

    node.pending = 0;
    const c = await send(ctl, SEND);
    expect(c.nonce).toBe(2); // nonce 0 freed by the drop, never re-issued
    const live = Object.values(ctl.getState().txs).filter((t) => LIVE_STATES.has(t.state));
    expect(live.some((t) => t.nonce === 0)).toBe(false);
  });

  it("lock+unlock across an in-flight broadcast: the old submit's refusal makes the new session consume a nonce that was never mined", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    w.armSendGate();
    const sendA = send(ctl, SEND);
    void sendA.catch(() => undefined);
    const row = await waitForSignedRow(w.backing); // hash + raw are durable — point of no return

    // Lock then re-unlock on the same backing: A reloads, re-holds nonce 0 and is tracked again.
    ctl.lock();
    await ctl.init();
    expect(ctl.getState().txs[row.id]?.state).toBe("submitted");
    expect(ctl.getState().txs[row.id]?.hash).toBe(row.hash);

    // The stale session's submit now settles against the new session's store.
    node.refuse = {
      code: -32000,
      message: "insufficient funds for gas * price + value",
      record: false,
    };
    w.releaseSendGate();
    await expect(sendA).rejects.toThrow(/insufficient funds/);

    const after = ctl.getState().txs[row.id];
    expect(after?.state).toBe("failed");
    expect(after?.hash).toBeUndefined();
    expect(after?.raw).toBeUndefined();

    // The poll armed at unlock sees a hash-less transaction, settles it failed — and `settle`
    // consumes the nonce, raising the account floor past a nonce nothing ever mined.
    await timers.fire(POLL_MS);
    node.pending = 0; // the chain still shows the account nonce at 0
    const c = await send(ctl, SEND);
    expect(c.state).toBe("submitted");
    expect(c.nonce).toBe(1); // nonce 0 burned by a refusal, never re-issued
  });
});
