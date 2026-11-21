import { readFileSync } from "node:fs";

import { hexToBytes, keccak256, serializeTransaction } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import { EVM_DELEGATOR } from "@qntx/wallet-chains/evm";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { UNKNOWN_DROP_MS } from "../src/transactions/broadcast.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { approval } from "./approval.ts";
import {
  fakeSignedEvm,
  idleNetworkDeps,
  requestsFor,
  send,
  simulateV1Result,
} from "./send-helpers.ts";
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
const DELEGATOR_CODE = readFileSync(
  new URL("fixtures/eip7702-stateless-delegator-1.3.0.hex", import.meta.url).pathname,
  "utf8",
).trim();

type Node = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  /** Every raw the node's eth_sendRawTransaction was asked about, in order. */
  sent: string[];
  /** Every sendRawTransaction fetch, including ones rejected before the node saw them. */
  attempts: string[];
  dropSend: boolean;
  refuse: { code: number; message: string; record: boolean } | undefined;
};

const newNode = (): Node => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  sent: [],
  attempts: [],
  dropSend: false,
  refuse: undefined,
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

const SIG = { r: `0x${"11".repeat(32)}` as Hex, s: `0x${"22".repeat(32)}` as Hex, yParity: 0 as const };

/** A real serialized envelope — the 7702 variant carries the authorization `rebuild` inspects. */
const evmRaw = (request: SignRequest): Uint8Array => {
  if (request.kind !== "evm.transaction") {
    throw new Error("not an evm transaction request");
  }
  const { tx } = request;
  const common = {
    chainId: tx.chainId,
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    to: tx.to as Hex,
    value: BigInt(tx.value ?? "0x0"),
    data: (tx.data ?? "0x") as Hex,
  };
  if (tx.type !== "eip7702") {
    return hexToBytes(
      serializeTransaction(
        {
          ...common,
          type: "eip1559",
          maxFeePerGas: BigInt("maxFeePerGas" in tx ? tx.maxFeePerGas : "0x0"),
          maxPriorityFeePerGas: BigInt(
            "maxPriorityFeePerGas" in tx ? tx.maxPriorityFeePerGas : "0x0",
          ),
        },
        SIG,
      ),
    );
  }
  const auth = tx.authorization as { address: string };
  return hexToBytes(
    serializeTransaction(
      {
        ...common,
        type: "eip7702",
        maxFeePerGas: BigInt(tx.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
        authorizationList: [
          { chainId: tx.chainId, address: auth.address as Hex, nonce: tx.nonce + 1, ...SIG },
        ],
      },
      SIG,
    ),
  );
};

const world = (options: { code?: (address: string) => string; realRaw?: boolean } = {}) => {
  const primary = newNode();
  const clock = { t: 1_000_000 };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const signed: SignRequest[] = [];
  let tag = 0;
  /** Armed per test: the first `hold` sendRawTransaction calls wait on this gate. */
  let sendGate: { promise: Promise<void>; open: () => void; hold: number } | undefined;
  /** Armed per test: the poll's eth_getTransactionReceipt read waits on this gate. */
  let pollGate: { promise: Promise<void>; open: () => void; awaited: boolean } | undefined;

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
      if (gate !== undefined && node.attempts.length <= gate.hold) {
        await gate.promise;
      }
      if (node.dropSend) {
        return Promise.reject(new TypeError("fetch failed"));
      }
    }
    if (body.method === "eth_getTransactionReceipt" && pollGate !== undefined) {
      pollGate.awaited = true;
      await pollGate.promise;
    }
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        const params = body.params ?? [];
        switch (body.method) {
          case "eth_getTransactionCount":
            return {
              result: `0x${(params[1] === "latest" ? node.latest : node.pending).toString(16)}`,
            };
          case "eth_estimateGas":
            return { result: "0x5208" };
          case "eth_feeHistory":
            return {
              result: {
                baseFeePerGas: ["0x1", "0x1"],
                reward: [
                  ["0x1", "0x2", "0x3"],
                  ["0x1", "0x2", "0x3"],
                ],
              },
            };
          case "eth_blockNumber":
            return { result: "0x2" };
          case "eth_getBlockByNumber":
            return { result: { number: "0x2" } };
          case "eth_getBalance":
            return { result: "0x0" };
          case "eth_getCode":
            return { result: options.code?.(String(params[0])) ?? "0x" };
          case "eth_call":
            return { result: `0x${"00".repeat(32)}` };
          case "eth_simulateV1":
            return { result: simulateV1Result(params) };
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
            return { result: accept(node, raw) };
          }
          case "eth_getTransactionByHash":
            return { result: node.known.has(String(params[0])) ? { hash: params[0] } : null };
          case "eth_getTransactionReceipt":
            return { result: node.receipts.get(String(params[0])) ?? null };
          default:
            throw new Error(`unmocked ${body.method}`);
        }
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
      return Promise.resolve(
        options.realRaw === true
          ? { kind: "evm.transaction" as const, signedTransaction: evmRaw(request) }
          : fakeSignedEvm(request),
      );
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
        return Promise.resolve(store);
      },
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => clock.t,
      logger: { warn: () => {} },
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
    boot,
    persistedTx,
    /** The first `hold` sendRawTransaction calls wait at the gate until `releaseSendGate`. */
    armSendGate: (hold = Number.POSITIVE_INFINITY) => {
      let open!: () => void;
      sendGate = {
        promise: new Promise<void>((resolve) => {
          open = resolve;
        }),
        open,
        hold,
      };
    },
    releaseSendGate: () => {
      sendGate?.open();
    },
    /** The poll's next eth_getTransactionReceipt read waits until `releasePollGate`. */
    armPollGate: () => {
      let open!: () => void;
      pollGate = {
        promise: new Promise<void>((resolve) => {
          open = resolve;
        }),
        open,
        awaited: false,
      };
    },
    releasePollGate: () => {
      pollGate?.open();
      pollGate = undefined;
    },
    pollGateAwaited: () => pollGate?.awaited === true,
    /** Removes a row from the shared backing — the in-memory copy then has no durable twin. */
    forgetTx: (id: string) => {
      backing.collections.get("transactions")?.delete(id);
    },
  };
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

const LIVE_STATES = new Set(["signed", "submitted", "pending"]);

describe("a released lower nonce is filled by the next send", () => {
  it("a refused send frees its nonce: the next send signs it, not one above", async () => {
    const w = world();
    const { ctl } = await w.boot();
    const node = w.primary;

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

    // B is sent while A still holds nonce 0: it reserves 1 and waits at the same gate.
    const sendB = send(ctl, SEND);
    await until(
      () => (node.attempts.length === 2 ? node.attempts[1] : undefined),
      "B's broadcast attempt",
    );

    // The node refuses A's exact bytes for good: A fails and nonce 0 is freed.
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
    expect(ctl.getState().txs[a?.id ?? ""]?.state).toBe("failed");

    // Geth semantics: a gapped account's pending nonce equals the state nonce — still 0.
    node.pending = 0;
    const c = await send(ctl, SEND);
    expect(c.state).toBe("submitted");
    expect(c.nonce).toBe(0); // the freed nonce is re-issued, never left as a hole
    expect(node.known.has(c.hash ?? "")).toBe(true);
  });

  it("an unknown lower nonce dropped after 30 min is re-filled the same way", async () => {
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
    expect(node.known.has(b.hash ?? "")).toBe(true);
    // A's bytes still never propagate, however often the tracker rebroadcasts them.
    node.dropSend = true;

    await timers.fire(POLL_MS); // first unknown sighting starts the drop window
    w.clock.t += UNKNOWN_DROP_MS + 1;
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[a.id]?.state).toBe("dropped");
    expect(ctl.getState().txs[b.id]?.state).toBe("submitted");

    node.dropSend = false;
    node.pending = 0;
    const c = await send(ctl, SEND);
    expect(c.state).toBe("submitted");
    expect(c.nonce).toBe(0); // the dropped nonce is re-issued
  });

  it("a build prepared above a since-freed nonce goes stale before it can sign", async () => {
    const w = world();
    const { ctl } = await w.boot();
    const node = w.primary;
    const requests = await requestsFor(ctl);

    w.armSendGate();
    const sendA = send(ctl, SEND);
    void sendA.catch(() => undefined);
    await until(
      () => (node.attempts.length === 1 ? node.attempts[0] : undefined),
      "A's broadcast attempt",
    );

    // B is prepared while A still holds nonce 0: the build takes nonce 1.
    const { verify: _verify, ...sendParams } = SEND;
    const bRequest = await requests.prepare({ method: "send", ...sendParams });

    // The node refuses A's exact bytes before B is approved: nonce 0 is free again and the
    // prepared build would sign above the hole.
    node.refuse = {
      code: -32000,
      message: "insufficient funds for gas * price + value",
      record: false,
    };
    w.releaseSendGate();
    await expect(sendA).rejects.toThrow(/insufficient funds/);

    await expect(
      requests.approve(bRequest.id, "send", approval(bRequest, VERIFY)),
    ).rejects.toThrow(
      "nonce 0 is free again — an earlier transaction was not sent; start over",
    );
    // B was retired before the signer ran — only A's request was ever signed, so only A's
    // refused raw ever reached the node.
    expect(w.signed).toHaveLength(1);
    expect(node.sent).toHaveLength(1);
    const live = Object.values(ctl.getState().txs).filter((t) => LIVE_STATES.has(t.state));
    expect(live).toHaveLength(0);
  });

  it("a transaction stuck above a gap carries the note until a send fills the gap", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;
    const NOTE =
      "nonce 0 below this transaction was never sent — the next send from this account fills it";

    w.armSendGate();
    const sendA = send(ctl, SEND);
    void sendA.catch(() => undefined);
    await until(
      () => (node.attempts.length === 1 ? node.attempts[0] : undefined),
      "A's broadcast attempt",
    );
    const sendB = send(ctl, SEND);
    await until(
      () => (node.attempts.length === 2 ? node.attempts[1] : undefined),
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

    // The chain still shows account nonce 0 (geth pending excludes the gapped pool tx): B's
    // next poll surfaces why it cannot land yet.
    node.pending = 0;
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[b.id]?.state).toBe("submitted");
    expect(ctl.getState().txs[b.id]?.error).toBe(NOTE);

    // C fills the gap; B's next poll clears the note.
    const c = await send(ctl, SEND);
    expect(c.nonce).toBe(0);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[b.id]?.error).toBeUndefined();
  });
});

describe("a signed 7702 holds both its nonces across lock and unlock", () => {
  it("a self-sponsored 7702 reloaded at unlock still owns its authorization nonce", async () => {
    // The account carries no code (delegation state "none") and the delegator contract verifies.
    const w = world({
      code: (address) =>
        address.toLowerCase() === EVM_DELEGATOR.address.toLowerCase() ? DELEGATOR_CODE : "0x",
      realRaw: true,
    });
    const { ctl } = await w.boot();
    const requests = await requestsFor(ctl);

    const request = await requests.prepare({
      method: "evm-delegation",
      account: ACCOUNT,
      network: "eip155:1",
      action: "upgrade",
      fee: "normal",
    });
    await requests.approve(request.id, "evm-delegation", approval(request, VERIFY));
    const submitted = Object.values(ctl.getState().txs).find((t) => t.state === "submitted");
    expect(submitted?.nonce).toBe(0);
    // The persisted raw is a real eip7702 envelope: its authorization spends nonce 1.
    expect(submitted?.raw).toBeDefined();

    // Lock, then unlock over the same store: the row reloads and its holds are re-anchored.
    ctl.lock();
    await ctl.init();
    const reloaded = ctl.getState().txs[submitted?.id ?? ""];
    expect(reloaded?.state).toBe("submitted");

    const c = await send(ctl, SEND);
    expect(c.state).toBe("submitted");
    expect(c.nonce).toBe(2); // nonce 1 — the authorization's — is still held, never re-issued
  });
});

describe("a stale session's late answer cannot write", () => {
  it("the old session's refusal lands after unlock: nothing reaches the new session", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    w.armSendGate();
    const sendA = send(ctl, SEND);
    void sendA.catch(() => undefined);
    await until(
      () => (node.attempts.length === 1 ? node.attempts[0] : undefined),
      "A's broadcast attempt",
    );
    const [a] = Object.values(ctl.getState().txs);
    const { hash } = a ?? {};

    // Lock then re-unlock on the same backing: A reloads, re-holds nonce 0 and is tracked again.
    ctl.lock();
    await ctl.init();
    expect(ctl.getState().txs[a?.id ?? ""]?.state).toBe("submitted");
    expect(ctl.getState().txs[a?.id ?? ""]?.hash).toBe(hash);

    // The stale session's submit now settles with a definite refusal: its transitions and nonce
    // release reach the dead session's route — nothing lands in the new one.
    node.refuse = {
      code: -32000,
      message: "insufficient funds for gas * price + value",
      record: false,
    };
    w.releaseSendGate();
    await expect(sendA).rejects.toThrow(/insufficient funds/);
    // The new session's own rebroadcasts never propagate either — A stays unknown to it.
    node.dropSend = true;

    const after = ctl.getState().txs[a?.id ?? ""];
    expect(after?.state).toBe("submitted");
    expect(after?.hash).toBe(hash);
    expect(after?.raw).toBeDefined();
    expect((await w.persistedTx(a?.id ?? ""))?.["state"]).toBe("submitted");

    // Still live and holding nonce 0, so the next send takes 1 — not 0 without a hash behind it.
    const b = await send(ctl, SEND);
    expect(b.nonce).toBe(1);

    // Only when the new session itself drops A past the unknown window is nonce 0 free again.
    await timers.fire(POLL_MS);
    w.clock.t += UNKNOWN_DROP_MS + 1;
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[a?.id ?? ""]?.state).toBe("dropped");
    const c = await send(ctl, SEND);
    expect(c.nonce).toBe(0);
  });

  it("the old session's acceptance lands after unlock: no second poll timer, no re-write", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    w.armSendGate(1);
    const sendA = send(ctl, SEND);
    void sendA.catch(() => undefined);
    await until(
      () => (node.attempts.length === 1 ? node.attempts[0] : undefined),
      "A's broadcast attempt",
    );
    const [a] = Object.values(ctl.getState().txs);

    ctl.lock();
    await ctl.init();
    expect(timers.armed(POLL_MS)).toBe(1);

    // The new session settles A as dropped first — then the stale acceptance arrives.
    node.dropSend = true;
    await timers.fire(POLL_MS);
    w.clock.t += UNKNOWN_DROP_MS + 1;
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[a?.id ?? ""]?.state).toBe("dropped");
    expect(timers.armed(POLL_MS)).toBe(0);

    node.dropSend = false;
    w.releaseSendGate();
    const late = await sendA;
    expect(late.state).toBe("submitted"); // the old request reports what it saw…
    // …but the dead session rewrites nothing: the row stays dropped and no poll re-arms.
    expect(ctl.getState().txs[a?.id ?? ""]?.state).toBe("dropped");
    expect((await w.persistedTx(a?.id ?? ""))?.["state"]).toBe("dropped");
    expect(timers.armed(POLL_MS)).toBe(0);
  });

  it("an in-flight poll answered after unlock writes nothing into the new session", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    const a = await send(ctl, SEND);
    const hash = a.hash ?? "";
    expect(timers.armed(POLL_MS)).toBe(1);

    // The poll's receipt read is in flight when the session ends.
    w.armPollGate();
    const fired = timers.fire(POLL_MS);
    await until(() => (w.pollGateAwaited() ? true : undefined), "the poll's receipt read");

    ctl.lock();
    /* With no store row to reload, the in-memory row keeps its identity across init — the case
       a failed bookkeeping write (`unsaved`) leaves behind. The row-identity check alone would
       not drop the answer that lands next; the session generation does. */
    w.forgetTx(a.id);
    await ctl.init();
    expect(ctl.getState().txs[a.id]).toBe(a);

    node.receipts.set(hash, {
      status: "0x1",
      blockNumber: "0x1",
      blockHash: `0x${"11".repeat(32)}`,
    });
    w.releasePollGate();
    await fired;

    // The old session's `included` applies nowhere: state, store and timers are untouched.
    expect(ctl.getState().txs[a.id]?.state).toBe("submitted");
    expect(await w.persistedTx(a.id)).toBeUndefined();
    expect(timers.armed(POLL_MS)).toBe(0);
  });
});
