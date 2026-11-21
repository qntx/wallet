/**
 * A transaction the endpoint never learns of is rebroadcast on backoff for UNKNOWN_DROP_MS and
 * then ends `dropped`: untracked, settled, its nonce freed — and never polled again. If the
 * bytes had in fact landed (the answer was only lost in transit) nothing ever looks at the row
 * again: it displays dropped while a later send at the freed or the next nonce goes out.
 */
import { hexToBytes, isHex, keccak256, serializeTransaction } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { UNKNOWN_DROP_MS } from "../../src/transactions/broadcast.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { DROP_CONFIRMATIONS } from "../../src/transactions/evm.ts";
import type { TrackedTransaction } from "../../src/transactions/route.ts";
import { idleNetworkDeps, send, simulateV1Result } from "../send-helpers.ts";
import { manualTimers } from "../support/timers.ts";
import type { ManualTimers } from "../support/timers.ts";

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
const RECEIPT = { status: "0x1", blockNumber: "0x1", blockHash: `0x${"11".repeat(32)}` };

type Node = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  /** Every raw the node's eth_sendRawTransaction actually saw. */
  sent: string[];
  /** Every eth_getTransactionReceipt lookup, by hash — "was this transaction re-checked". */
  receiptReads: string[];
  /** sendRawTransaction's fetch rejects: the bytes never reach the node. */
  dropSend: boolean;
};

const newNode = (): Node => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  sent: [],
  receiptReads: [],
  dropSend: false,
});

const hexOf = (value: string | undefined): Hex => {
  if (value === undefined || !isHex(value)) {
    throw new Error("malformed hex field");
  }
  return value;
};

/**
 * `fakeSignedEvm` with `r` filled by `variant`: each signing of the same payment yields distinct
 * bytes — and a distinct hash — like any re-signed send at the freed nonce.
 */
const signedEvm = (
  request: SignRequest,
  variant: number,
): { kind: "evm.transaction"; signedTransaction: Uint8Array } => {
  if (request.kind !== "evm.transaction") {
    throw new Error("not an evm transaction request");
  }
  const { tx } = request;
  const common = {
    chainId: tx.chainId,
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    to: hexOf(tx.to),
    value: BigInt(tx.value ?? "0x0"),
    data: hexOf(tx.data ?? "0x"),
  };
  const r: Hex = `0x${variant.toString(16).padStart(2, "0").repeat(32)}`;
  const sigS: Hex = `0x${"22".repeat(32)}`;
  const signature = { r, s: sigS, yParity: 0 };
  const raw =
    tx.type === "eip1559"
      ? serializeTransaction(
          {
            ...common,
            type: "eip1559",
            maxFeePerGas: BigInt(tx.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
          },
          signature,
        )
      : serializeTransaction(
          { ...common, type: "legacy", gasPrice: BigInt("gasPrice" in tx ? tx.gasPrice : "0x0") },
          { r, s: sigS, v: BigInt(tx.chainId) * 2n + 35n },
        );
  return { kind: "evm.transaction", signedTransaction: hexToBytes(raw) };
};

const world = () => {
  const primary = newNode();
  const clock = { t: 1_000_000 };
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
    if (body.method === "eth_sendRawTransaction" && node.dropSend) {
      // A transport failure — the outcome of this send is unknown to both sides.
      return Promise.reject(new TypeError("fetch failed"));
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
          case "eth_simulateV1":
            return { result: simulateV1Result(params) };
          case "eth_sendRawTransaction": {
            const raw = String(params[0]);
            node.sent.push(raw);
            const hash = keccak256(raw as Hex);
            node.known.add(hash);
            node.pending += 1;
            return { result: hash };
          }
          case "eth_getTransactionByHash":
            return { result: node.known.has(String(params[0])) ? { hash: params[0] } : null };
          case "eth_getTransactionReceipt":
            node.receiptReads.push(String(params[0]));
            return { result: node.receipts.get(String(params[0])) ?? null };
          default:
            throw new Error(`unmocked ${body.method}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        return { error: { code: message.startsWith("unmocked") ? -32601 : -1, message } };
      }
    })();
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, ...reply }));
  };

  let signedCalls = 0;
  const apis = {
    account: async () =>
      Promise.resolve({ template: "evm.bip44", network: "eip155:1", address: ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      signedCalls += 1;
      return Promise.resolve(signedEvm(request, signedCalls));
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
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
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

  return { primary, clock, boot };
};

/** `count` poll turns: every live poll timer fires once per turn, like the real loop schedule. */
const polls = async (timers: ManualTimers, count = 1): Promise<void> => {
  for (let i = 0; i < count; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each poll re-arms the next
    await timers.fire(POLL_MS);
  }
};

const hashOf = (tx: TrackedTransaction): string => {
  if (tx.hash === undefined) {
    throw new Error("transaction has no hash");
  }
  return tx.hash;
};

const stateOf = (ctl: TransactionController, tx: TrackedTransaction) =>
  ctl.getState().txs[tx.id]?.state;

/** Sends A with its broadcast answer lost in transit and polls it into `dropped`. */
const sendThenDrop = async (
  w: ReturnType<typeof world>,
  ctl: TransactionController,
  timers: ManualTimers,
) => {
  const node = w.primary;
  node.dropSend = true;
  const a = await send(ctl, SEND);
  expect(a.state).toBe("submitted");
  expect(a.nonce).toBe(0);
  await timers.fire(POLL_MS); // the first unknown sighting starts the 30-minute window
  w.clock.t += UNKNOWN_DROP_MS + 1;
  await timers.fire(POLL_MS);
  expect(stateOf(ctl, a)).toBe("dropped");
  expect(timers.armed(POLL_MS)).toBe(0);
  return a;
};

describe("a transaction dropped as never-seen after its broadcast answer was lost", () => {
  it("stays dropped after it lands, and the re-send pays the recipient again", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    const a = await sendThenDrop(w, ctl, timers);
    const hashA = hashOf(a);

    // The bytes had in fact landed — through an endpoint the tracker never asked. The row is
    // untracked: it stays dropped and no receipt read for its hash ever runs again.
    const readsAtDrop = node.receiptReads.filter((h) => h === hashA).length;
    node.receipts.set(hashA, RECEIPT);
    node.latest = 1;
    node.pending = 1;
    await polls(timers, 3);
    expect(stateOf(ctl, a)).toBe("dropped");
    expect(node.receiptReads.filter((h) => h === hashA)).toHaveLength(readsAtDrop);

    // The chain count has moved past A's nonce, so the user's re-send is built at the next
    // nonce and broadcast as a second payment — while the first still displays dropped.
    node.dropSend = false;
    const b = await send(ctl, SEND);
    expect(b.nonce).toBe(1);
    expect(b.state).toBe("submitted");
    expect(node.known.has(hashOf(b))).toBe(true);
    expect(stateOf(ctl, a)).toBe("dropped");

    // Both payments are on chain: the one the wallet shows dropped, and its re-send.
    node.receipts.set(hashOf(b), RECEIPT);
    node.latest = 2;
    await polls(timers);
    expect(stateOf(ctl, b)).toBe("confirmed");
    expect(stateOf(ctl, a)).toBe("dropped");
  });

  it("loses the re-sent payment at the freed nonce to the landed original that still shows dropped", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const node = w.primary;

    const a = await sendThenDrop(w, ctl, timers);
    const hashA = hashOf(a);

    // The released nonce is re-issued before anything lands: the re-send signs nonce 0 and the
    // node takes it.
    node.dropSend = false;
    const b = await send(ctl, SEND);
    expect(b.nonce).toBe(0);
    expect(b.state).toBe("submitted");
    expect(node.known.has(hashOf(b))).toBe(true);

    // The dropped transaction was the one that landed: once the chain's count passes the
    // shared nonce, the drop-confirmation polls end the re-send as replaced — and the payment
    // that really went through is the one still displayed dropped.
    node.receipts.set(hashA, RECEIPT);
    node.latest = 1;
    await polls(timers, DROP_CONFIRMATIONS);
    expect(stateOf(ctl, a)).toBe("dropped");
    expect(stateOf(ctl, b)).toBe("replaced");
  });
});
