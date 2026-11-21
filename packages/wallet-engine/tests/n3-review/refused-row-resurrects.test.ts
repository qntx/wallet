/**
 * A refused broadcast ends the send as `failed` for the caller — but the transition that records
 * the failure is not durable. When it cannot land — the vault locked while the answer was still in
 * flight, or the store write threw — the durable record keeps its pre-broadcast `signed` row with
 * hash and raw, and the next session reads that as a broadcast whose outcome never settled:
 * `submitted` again, tracked, and the very bytes the node refused are reposted.
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { EsploraError } from "../../src/chains/bitcoin.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import type { TrackedTransaction } from "../../src/transactions/route.ts";
import {
  bombedStore,
  fakeSignedEvm,
  idleNetworkDeps,
  send,
  simulateV1Result,
  txRowPut,
} from "../send-helpers.ts";
import {
  flush,
  inputTxidsOf,
  persistedTx as persistedBtcTx,
  persistedUtxos,
  world as btcWorld,
  POLL_MS as BTC_POLL_MS,
} from "../support/btc-world.ts";
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
const REFUSAL = { code: -32000, message: "insufficient funds for gas * price + value" };

type Node = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  /** Every raw the node's eth_sendRawTransaction processed — refused ones included. */
  sent: string[];
  /** Every sendRawTransaction fetch, including ones still waiting at the gate. */
  attempts: string[];
  /** Armed per test: the next sendRawTransaction answers with this JSON-RPC error. */
  refuse: { code: number; message: string } | undefined;
};

const newNode = (): Node => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  sent: [],
  attempts: [],
  refuse: undefined,
});

const accept = (node: Node, raw: string): string => {
  const hash = keccak256(raw as Hex);
  node.known.add(hash);
  node.pending += 1;
  return hash;
};

const evmWorld = () => {
  const primary = newNode();
  const clock = { t: 1_000_000 };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const bomb: { fail: Parameters<typeof bombedStore>[1]["fail"] } = { fail: undefined };
  const warnings: string[] = [];
  let tag = 0;
  /** Armed per test: the first `hold` sendRawTransaction calls wait on this gate. */
  let sendGate: { promise: Promise<void>; open: () => void; hold: number } | undefined;

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
                  ["0x1", "0x2"],
                  ["0x1", "0x2"],
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
            return { result: "0x" };
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

  return {
    primary,
    backing,
    warnings,
    bomb,
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
  };
};

/** Polls `cond` on the real clock — `vi.waitFor` never fires under this runner. */
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

/** Probe for `until`: the Nth appended attempt, once the list is exactly that long. */
const attemptAt =
  <T>(attempts: ReadonlyArray<T>, n: number) =>
  (): T | undefined =>
    attempts.length === n + 1 ? attempts[n] : undefined;

const mustTx = (tx: TrackedTransaction | undefined): TrackedTransaction => {
  if (tx === undefined) {
    throw new Error("expected a tracked transaction");
  }
  return tx;
};

describe("a refusal answered while the vault is locked", () => {
  it("fails the caller but never persists the failure: the row resurrects and is reposted", async () => {
    const w = evmWorld();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    w.armSendGate();
    const sendA = send(ctl, SEND);
    void sendA.catch(() => undefined);
    await until(attemptAt(node.attempts, 0), "the broadcast attempt");
    const a = mustTx(Object.values(ctl.getState().txs)[0]);
    const { hash, raw } = a;

    // The vault locks while the node still holds the broadcast answer.
    ctl.lock();

    // The refusal lands inside the locked window: the caller is failed, the nonce released and
    // the in-memory row marked failed — but the bookkeeping write has no store to reach, so the
    // durable record stays `signed` with the bytes the node refused.
    node.refuse = REFUSAL;
    w.releaseSendGate();
    await expect(sendA).rejects.toThrow(/insufficient funds/);
    expect(ctl.getState().txs[a.id]?.state).toBe("failed");
    expect(ctl.getState().txs[a.id]?.hash).toBeUndefined();
    await expect(w.persistedTx(a.id)).resolves.toMatchObject({ state: "signed", hash, raw });
    expect(w.warnings.some((m) => m.includes("not persisted: vault locked"))).toBe(true);

    // Unlock over the same store reads `signed` as a broadcast that never settled: the row
    // comes back submitted with its hash, re-tracks and re-holds its nonce.
    await ctl.init();
    const resurrected = mustTx(ctl.getState().txs[a.id]);
    expect(resurrected.state).toBe("submitted");
    expect(resurrected.hash).toBe(hash);
    await expect(w.persistedTx(a.id)).resolves.toMatchObject({ state: "submitted", hash });
    expect(timers.armed(POLL_MS)).toBe(1);

    // The node never accepted the bytes it refused, so the next poll reposts them — the same
    // raw the user was told had failed.
    await timers.fire(POLL_MS);
    expect(node.sent).toStrictEqual([raw, raw]);
    expect(ctl.getState().txs[a.id]?.state).toBe("submitted");
  });
});

describe("a refused send whose failed row never reaches the store", () => {
  it("resurrects as submitted on restart, is reposted and re-holds its nonce", async () => {
    const w = evmWorld();
    const first = await w.boot();
    const node = w.primary;

    // The node refuses the bytes and the `failed` bookkeeping write is bombed: the durable
    // record stays `signed`, and with the transaction never tracked nothing retries the write.
    w.bomb.fail = txRowPut(['"state":"failed"']);
    node.refuse = REFUSAL;
    const sendA = send(first.ctl, SEND);
    await expect(sendA).rejects.toThrow(/insufficient funds/);
    const a = mustTx(Object.values(first.ctl.getState().txs)[0]);
    // The failed row's hash and raw were cleared in memory — the store keeps them.
    const [raw] = node.sent;
    const hash = keccak256(raw as Hex);
    expect(a.state).toBe("failed");
    await expect(w.persistedTx(a.id)).resolves.toMatchObject({ state: "signed", hash, raw });
    expect(w.warnings.some((m) => m.includes("not persisted; the next poll retries"))).toBe(true);
    expect(first.timers.armed(POLL_MS)).toBe(0);
    // No poll ever runs for it — the promised retry never happens.
    await first.timers.fire(POLL_MS);
    await expect(w.persistedTx(a.id)).resolves.toMatchObject({ state: "signed", hash });
    w.bomb.fail = undefined;

    // Restart over the same store: the signed row is read as an unsettled broadcast — submitted
    // again, tracked, its nonce held.
    const second = await w.boot();
    const resurrected = mustTx(second.ctl.getState().txs[a.id]);
    expect(resurrected.state).toBe("submitted");
    expect(resurrected.hash).toBe(hash);
    expect(second.timers.armed(POLL_MS)).toBe(1);

    // The node still does not know the hash it refused, so the poll reposts the same bytes.
    await second.timers.fire(POLL_MS);
    expect(node.sent).toStrictEqual([raw, raw]);
    expect(second.ctl.getState().txs[a.id]?.state).toBe("submitted");

    // The refusal had freed nonce 0 for the rest of session one, but the resurrected
    // transaction holds it again — the next send is built one above.
    expect(a.nonce).toBe(0);
    const b = await send(second.ctl, SEND);
    expect(b.nonce).toBe(1);
  });
});

describe("a refused bitcoin send whose failed row never reaches the store", () => {
  it("resurrects and is reposted on restart while its inputs stay unlocked", async () => {
    const w = btcWorld();
    const utxo = w.fund(1, 50_000);
    w.bomb.fail = txRowPut(['"state":"failed"']);
    // A 4xx relay rejection — not transient, so the send fails for the caller.
    w.setPost({
      kind: "throw",
      error: new EsploraError(
        'esplora /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}',
        false,
      ),
    });
    const first = await w.boot();

    await expect(w.send(first, 10_000n, "req-1")).rejects.toThrow("min relay fee not met");
    const a = mustTx(Object.values(first.ctl.getState().txs)[0]);
    expect(a.state).toBe("failed");
    const stored = await persistedBtcTx(first.backing, a.id);
    const txid = stored?.["hash"];
    expect(stored).toMatchObject({ state: "signed" });
    expect(txid).toBeTypeOf("string");
    // Refused and untracked: no poll ever retries the bombed `failed` write.
    expect(first.timers.armed(BTC_POLL_MS)).toBe(0);
    await flush();
    w.bomb.fail = undefined;

    // Restart over the same store: signed resurrects as submitted and is tracked.
    const second = await w.boot(first.backing);
    const resurrected = mustTx(second.ctl.getState().txs[a.id]);
    expect(resurrected.state).toBe("submitted");
    expect(resurrected.hash).toBe(txid);
    expect(second.timers.armed(BTC_POLL_MS)).toBe(1);

    // The endpoint still does not know the txid it refused, so the poll posts the same bytes.
    await second.polls(1);
    expect(w.posts).toHaveLength(2);
    expect(w.posts[1]).toBe(w.posts[0]);
    expect(w.posts[1]).toBe(resurrected.raw);

    // The refusal's release persisted the inputs as spendable again, and no reload re-locks
    // them for the resurrected transaction — a new send picks the very same coin while the
    // refused bytes are still being reposted.
    const locked = await persistedUtxos(second.backing);
    expect(locked[`${utxo.txid}:${String(utxo.vout)}`]?.status).toBe("confirmed");
    w.setPost({ kind: "ok" });
    const b = await w.send(second, 10_000n, "req-2");
    expect(inputTxidsOf(b)).toContain(utxo.txid);
    expect(inputTxidsOf(resurrected)).toContain(utxo.txid);
    expect(second.ctl.getState().txs[a.id]?.state).toBe("submitted");
  });
});
