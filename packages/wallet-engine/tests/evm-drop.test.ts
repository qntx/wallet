import { keccak256 } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import {
  DROP_CONFIRMATIONS,
  RESUBMIT_BASE_MS,
  RESUBMIT_MAX_MS,
  UNKNOWN_DROP_MS,
} from "../src/transactions/evm.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { fakeSignedEvm, idleNetworkDeps, replaceVia, send } from "./send-helpers.ts";

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
const RECEIPT = { status: "0x1", blockNumber: "0x1" };
const REVERTED = { status: "0x0", blockNumber: "0x1" };

type Node = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  sent: string[];
  accepting: boolean;
  onLatestCount: (() => void) | undefined;
};

const newNode = (): Node => ({
  latest: 0,
  pending: 0,
  known: new Set(),
  receipts: new Map(),
  sent: [],
  accepting: true,
  onLatestCount: undefined,
});

const answer = (node: Node, method: string, params: unknown[]): unknown => {
  switch (method) {
    case "eth_getTransactionCount":
      if (params[1] === "latest") {
        node.onLatestCount?.();
        return `0x${node.latest.toString(16)}`;
      }
      return `0x${node.pending.toString(16)}`;
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
    case "eth_getBlockByNumber":
      return { number: "0x2" };
    case "eth_sendRawTransaction": {
      const raw = String(params[0]);
      node.sent.push(raw);
      const hash = keccak256(raw as Hex);
      if (node.accepting) {
        node.known.add(hash);
      }
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

const world = (options: { gateway?: boolean } = {}) => {
  const primary = newNode();
  const independent = newNode();
  const clock = { t: 1_000_000 };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const signed: SignRequest[] = [];
  const logger = { warn: () => {} };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Promise.resolve(Response.json({ networks: ["eip155:1"] }));
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    const node = options.gateway === true && !url.startsWith(GATEWAY) ? independent : primary;
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: answer(node, body.method, body.params ?? []) };
      } catch (error) {
        return { error: { code: -1, message: error instanceof Error ? error.message : "failed" } };
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
      logger,
      ...(options.gateway === true ? { gateway: { url: GATEWAY, installId: "a".repeat(32) } } : {}),
    });
    if (options.gateway === true) {
      await networks.init();
    }
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
      logger,
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  return { primary, independent, clock, backing, signed, boot };
};

const tick = async (timers: Array<() => unknown>, index = 0): Promise<void> => {
  await timers[index]?.();
};

const ticks = async (timers: Array<() => unknown>, count: number, index = 0): Promise<void> => {
  if (count > 0) {
    await tick(timers, index);
    await ticks(timers, count - 1, index);
  }
};

const attemptTimes = (): number[] => {
  const times: number[] = [];
  let at = 0;
  for (let attempt = 0; at < UNKNOWN_DROP_MS; attempt += 1) {
    times.push(at);
    at += Math.min(RESUBMIT_BASE_MS * 2 ** attempt, RESUBMIT_MAX_MS);
  }
  return times;
};

/**
 * Per scheduled attempt: rebroadcasts seen at its time, then rebroadcasts seen just before the
 * next.
 */
const walkBackoff = async (
  w: ReturnType<typeof world>,
  timers: Array<() => unknown>,
  start: number,
  attempt = 0,
  at = 0,
): Promise<number[]> => {
  if (at >= UNKNOWN_DROP_MS) {
    return [];
  }
  const delay = Math.min(RESUBMIT_BASE_MS * 2 ** attempt, RESUBMIT_MAX_MS);
  const before = w.primary.sent.length;
  w.clock.t = start + at;
  await tick(timers);
  const hit = w.primary.sent.length - before;
  w.clock.t = start + Math.min(at + delay, UNKNOWN_DROP_MS) - 1;
  await tick(timers);
  const early = w.primary.sent.length - before - hit;
  return [hit, early, ...(await walkBackoff(w, timers, start, attempt + 1, at + delay))];
};

const evmTx = (request: SignRequest | undefined) => {
  if (request?.kind !== "evm.transaction") {
    throw new Error("expected an evm request");
  }
  return request.tx;
};

const eip1559Tx = (request: SignRequest | undefined) => {
  const tx = evmTx(request);
  if (tx.type !== "eip1559") {
    throw new Error("expected an eip1559 request");
  }
  return tx;
};

const hashOf = (tx: TrackedTransaction): string => {
  if (tx.hash === undefined) {
    throw new Error("transaction has no hash");
  }
  return tx.hash;
};

const stateOf = (ctl: TransactionController, tx: TrackedTransaction) =>
  ctl.getState().txs[tx.id]?.state;

describe("EVM poll — receipts", () => {
  it("a confirmed receipt confirms the transaction", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    w.primary.receipts.set(hashOf(tx), RECEIPT);
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("confirmed");
  });

  it("a status-0 receipt fails the transaction", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    w.primary.receipts.set(hashOf(tx), REVERTED);
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("failed");
  });
});

describe("EVM poll — nonce consumed without our receipt", () => {
  it("stays pending for the first polls and is dropped on the third", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    w.primary.latest = tx.nonce + 1;
    await ticks(timers, DROP_CONFIRMATIONS - 1);
    expect(stateOf(ctl, tx)).toBe("submitted");
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("dropped");
  });

  it("resets the counter when the confirmed count goes back", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    w.primary.latest = tx.nonce + 1;
    await tick(timers);
    await tick(timers);
    w.primary.latest = tx.nonce;
    await tick(timers);
    w.primary.latest = tx.nonce + 1;
    await tick(timers);
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("submitted");
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("dropped");
  });

  it("is replaced when a tracked transaction at the same nonce has a receipt", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const original = await send(ctl, SEND);
    const bumped = await replaceVia(ctl, original.id, "speed-up", VERIFY);
    w.primary.latest = original.nonce + 1;
    w.primary.receipts.set(hashOf(bumped), RECEIPT);
    await ticks(timers, DROP_CONFIRMATIONS);
    expect(stateOf(ctl, original)).toBe("replaced");
  });

  it("confirms when the receipt appears on the re-read after the count says consumed", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    w.primary.latest = tx.nonce + 1;
    w.primary.onLatestCount = () => {
      w.primary.receipts.set(hashOf(tx), RECEIPT);
    };
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("confirmed");
  });
});

describe("EVM poll — unknown to the node", () => {
  it("rebroadcasts the raw transaction on the backoff schedule", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const raw = tx.evm?.raw;
    w.primary.known.delete(hashOf(tx));
    w.primary.accepting = false;
    w.primary.sent.length = 0;
    const seen = await walkBackoff(w, timers, w.clock.t);
    expect(seen).toStrictEqual(attemptTimes().flatMap(() => [1, 0]));
    expect(new Set(w.primary.sent)).toStrictEqual(new Set([raw]));
    expect(stateOf(ctl, tx)).toBe("submitted");
  });

  it("stops rebroadcasting once the node knows the transaction again", async () => {
    const w = world();
    const { timers, ctl } = await w.boot();
    const tx = await send(ctl, SEND);
    w.primary.known.delete(hashOf(tx));
    w.primary.sent.length = 0;
    await tick(timers);
    expect(w.primary.sent).toHaveLength(1);
    w.clock.t += RESUBMIT_BASE_MS;
    await tick(timers);
    expect(w.primary.sent).toHaveLength(1);
  });

  it("is dropped after 30 minutes and its nonce is released", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    w.primary.known.delete(hashOf(tx));
    w.primary.accepting = false;
    await tick(timers);
    w.clock.t += UNKNOWN_DROP_MS - 1;
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("submitted");
    w.clock.t += 1;
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("dropped");
    w.primary.accepting = true;
    const next = await send(ctl, SEND);
    expect(next.nonce).toBe(tx.nonce);
  });

  it("is not dropped while an independent endpoint still knows it", async () => {
    const w = world({ gateway: true });
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    w.primary.known.delete(hashOf(tx));
    w.primary.accepting = false;
    w.independent.known.add(hashOf(tx));
    await tick(timers);
    w.clock.t += UNKNOWN_DROP_MS;
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("submitted");
    w.independent.known.delete(hashOf(tx));
    await tick(timers);
    expect(stateOf(ctl, tx)).toBe("dropped");
  });

  it("an original evicted by its live replacement is neither rebroadcast nor dropped", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const original = await send(ctl, SEND);
    const bumped = await replaceVia(ctl, original.id, "speed-up", VERIFY);
    w.primary.known.delete(hashOf(original));
    w.primary.accepting = false;
    w.primary.sent.length = 0;
    await tick(timers, 0);
    w.clock.t += UNKNOWN_DROP_MS + 1;
    await ticks(timers, 2, 0);
    expect(w.primary.sent).toHaveLength(0);
    expect(stateOf(ctl, original)).toBe("submitted");
    w.primary.accepting = true;
    const next = await send(ctl, SEND);
    expect(next.nonce).toBe(bumped.nonce + 1);
  });

  it("resumes the original's unknown handling once its replacement is gone", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const original = await send(ctl, SEND);
    const bumped = await replaceVia(ctl, original.id, "speed-up", VERIFY);
    w.primary.known.delete(hashOf(original));
    w.primary.known.delete(hashOf(bumped));
    w.primary.accepting = false;
    await tick(timers, 0);
    await tick(timers, 1);
    w.clock.t += UNKNOWN_DROP_MS;
    await tick(timers, 1);
    expect(stateOf(ctl, bumped)).toBe("dropped");
    w.primary.sent.length = 0;
    await tick(timers, 0);
    expect(w.primary.sent).toHaveLength(1);
    w.clock.t += UNKNOWN_DROP_MS;
    await tick(timers, 0);
    expect(stateOf(ctl, original)).toBe("dropped");
  });

  it("a dropped original does not mark its replacement replaced", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const original = await send(ctl, SEND);
    const bumped = await replaceVia(ctl, original.id, "speed-up", VERIFY);
    w.primary.latest = original.nonce + 1;
    await ticks(timers, DROP_CONFIRMATIONS, 0);
    expect(stateOf(ctl, original)).toBe("dropped");
    expect(stateOf(ctl, bumped)).toBe("submitted");
  });
});

describe("EVM replacement after restart", () => {
  const replaced = async (mode: "speed-up" | "cancel") => {
    const w = world();
    const first = await w.boot();
    const original = await send(first.ctl, SEND);
    const second = await w.boot();
    const reloaded = second.ctl.getState().txs[original.id];
    expect(reloaded?.evm?.raw).toBe(original.evm?.raw);
    const replacement = await replaceVia(second.ctl, original.id, mode, VERIFY);
    return { w, original, replacement };
  };

  it("speed-up rebuilds from the persisted raw at the same nonce with a bumped fee", async () => {
    const { w, original, replacement } = await replaced("speed-up");
    expect(replacement.replaces).toBe(original.id);
    expect(replacement.nonce).toBe(original.nonce);
    const before = eip1559Tx(w.signed[0]);
    const after = eip1559Tx(w.signed[1]);
    expect(after.nonce).toBe(before.nonce);
    expect(after.to).toBe(before.to);
    expect(after.value).toBe(before.value);
    expect(after.gas).toBe(before.gas);
    expect(BigInt(after.maxFeePerGas)).toBeGreaterThan(BigInt(before.maxFeePerGas));
    expect(replacement.evm?.account).toStrictEqual(ACCOUNT);
  });

  it("cancel rebuilds as a 0-value self-transfer", async () => {
    const { w, replacement, original } = await replaced("cancel");
    expect(replacement.replaces).toBe(original.id);
    const last = evmTx(w.signed.at(-1));
    expect(last.to).toBe(ADDR);
    expect(last.value).toBe("0x0");
    expect(BigInt(last.gas)).toBe(21000n);
  });

  it("a transaction without a build record cannot be replaced", async () => {
    const w = world();
    const first = await w.boot();
    const original = await send(first.ctl, SEND);
    const collection = createMemoryEngineStore(w.backing).collection("transactions");
    const stored = await collection.get(original.id);
    const record = JSON.parse(new TextDecoder().decode(stored)) as Record<string, unknown>;
    delete record["evm"];
    await collection.put(original.id, new TextEncoder().encode(JSON.stringify(record)));
    const second = await w.boot();
    await expect(replaceVia(second.ctl, original.id, "speed-up", VERIFY)).rejects.toThrow(
      "transaction has no build record — cannot replace",
    );
  });
});

describe("EVM build record persistence", () => {
  it("round-trips through the store", async () => {
    const w = world();
    const first = await w.boot();
    const tx = await send(first.ctl, SEND);
    expect(tx.evm).toStrictEqual({
      from: ADDR,
      account: ACCOUNT,
      raw: expect.stringMatching(/^0x/),
    });
    const second = await w.boot();
    expect(second.ctl.getState().txs[tx.id]?.evm).toStrictEqual(tx.evm);
  });

  it("drops a malformed record on load", async () => {
    const w = world();
    const first = await w.boot();
    const tx = await send(first.ctl, SEND);
    const collection = createMemoryEngineStore(w.backing).collection("transactions");
    const stored = await collection.get(tx.id);
    const record = JSON.parse(new TextDecoder().decode(stored)) as {
      evm: Record<string, unknown>;
    };
    record.evm["raw"] = "not hex";
    await collection.put(tx.id, new TextEncoder().encode(JSON.stringify(record)));
    const second = await w.boot();
    expect(second.ctl.getState().txs[tx.id]).toBeDefined();
    expect(second.ctl.getState().txs[tx.id]?.evm).toBeUndefined();
  });
});
