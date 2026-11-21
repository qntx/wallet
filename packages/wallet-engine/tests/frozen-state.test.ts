import { keccak256 } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { Controller } from "../src/controller.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { fakeSignedEvm, idleNetworkDeps, send } from "./send-helpers.ts";
import { manualTimers } from "./support/timers.ts";

type State = {
  readonly count: number;
  readonly record: Readonly<Record<string, number>>;
  readonly list: ReadonlyArray<{ readonly v: number }>;
  readonly bytes: Uint8Array;
};

class Snapshot extends Controller<State> {
  constructor() {
    super({
      name: "snapshot",
      defaultState: () => ({
        count: 0,
        record: { a: 1 },
        list: [{ v: 1 }],
        bytes: new Uint8Array([7]),
      }),
    });
  }
  bump(): void {
    this.update((s) => ({ ...s, count: s.count + 1 }));
  }
  replace(): void {
    this.update((s) => ({ ...s, record: { b: 2 }, list: [{ v: 9 }] }));
  }
  async init(): Promise<void> {}
  async destroy(): Promise<void> {}
}

describe("controller state is deeply frozen at the boundary", () => {
  it("the default state and every update come out frozen — object, record and array", () => {
    const c = new Snapshot();
    const first = c.getState();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.record)).toBe(true);
    expect(Object.isFrozen(first.list)).toBe(true);
    expect(Object.isFrozen(first.list[0])).toBe(true);

    c.replace();
    const next = c.getState();
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.record)).toBe(true);
    expect(next.record).toStrictEqual({ b: 2 });
    // An unchanged subtree keeps its identity — re-freezing it cost nothing.
    expect(next.bytes).toBe(first.bytes);
  });

  it("writes and deletes into a snapshot throw TypeError and change nothing", () => {
    const c = new Snapshot();
    const state = c.getState();
    expect(() => {
      (state.record as Record<string, number>)["a"] = 99;
    }).toThrow(TypeError);
    expect(() => {
      delete (state.record as Record<string, number>)["a"];
    }).toThrow(TypeError);
    expect(() => {
      (state.list as Array<{ v: number }>).push({ v: 3 });
    }).toThrow(TypeError);
    expect(state.record["a"]).toBe(1);
    expect(state.list).toHaveLength(1);
  });

  it("non-plain values pass through: typed arrays, Map, Set, class instances are never frozen", () => {
    class Box {
      v = 0;
    }
    type Mixed = {
      readonly bytes: Uint8Array;
      readonly map: Map<string, number>;
      readonly set: Set<number>;
      readonly box: Box;
    };
    class MixedCtl extends Controller<Mixed> {
      constructor() {
        super({
          name: "mixed",
          defaultState: () => ({
            bytes: new Uint8Array([1, 2]),
            map: new Map([["k", 1]]),
            set: new Set([1]),
            box: new Box(),
          }),
        });
      }
      async init(): Promise<void> {}
      async destroy(): Promise<void> {}
    }
    const c = new MixedCtl();
    const state = c.getState();
    expect(Object.isFrozen(state)).toBe(true);
    // Freezing a non-empty typed array throws — so the boundary must leave it alone.
    expect(Object.isFrozen(state.bytes)).toBe(false);
    expect(Object.isFrozen(state.map)).toBe(false);
    expect(Object.isFrozen(state.set)).toBe(false);
    expect(Object.isFrozen(state.box)).toBe(false);
    state.bytes[0] = 9; // does not throw
    state.map.set("k", 2);
    state.box.v = 5;
    expect(state.bytes[0]).toBe(9);
  });
});

describe("the facade's frozen snapshot cannot edit the engine's ledger", () => {
  const GATEWAY = "https://gateway.test";
  const HOST = "http://host.local";
  const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
  const ACCOUNT = {
    kind: "hd" as const,
    walletId: "w",
    groupIndex: 0,
    template: "evm.bip44" as const,
  };
  const SEND = {
    account: ACCOUNT,
    network: "eip155:1",
    to: "0x00000000000000000000000000000000deadbeef",
    amount: 1n,
    fee: "normal" as const,
    verify: { kind: "password" as const, password: "pw" },
  };
  const POLL_MS = 4000;
  const hex = (n: number): string => `0x${n.toString(16)}`;

  const boot = async () => {
    const node = { known: new Set<string>(), sent: [] as string[], pending: 0 };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${GATEWAY}/v1/networks`) {
        return Promise.resolve(Response.json({ networks: ["eip155:1"] }));
      }
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        method: string;
        params?: unknown[];
      };
      const p = body.params ?? [];
      const result = (() => {
        switch (body.method) {
          case "eth_getTransactionCount":
            return hex(node.pending);
          case "eth_estimateGas":
            return "0x5208";
          case "eth_feeHistory":
            return { baseFeePerGas: ["0x1"], reward: [["0x1", "0x2"]] };
          case "eth_blockNumber":
            return "0x2";
          case "eth_sendRawTransaction": {
            const raw = String(p[0]);
            node.sent.push(raw);
            const hash = keccak256(raw as Hex);
            node.known.add(hash);
            node.pending += 1;
            return hash;
          }
          case "eth_getTransactionByHash":
            return node.known.has(String(p[0])) ? { hash: p[0] } : null;
          case "eth_getTransactionReceipt":
            return null;
          default:
            return null;
        }
      })();
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result }));
    };
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
      random: (n) => new Uint8Array(n).fill(1),
      setTimer: timers.setTimer,
      now: () => 1_000_000,
      logger: { warn: () => {} },
      pollMs: POLL_MS,
      chains: {
        account: async () =>
          Promise.resolve({ template: "evm.bip44", network: "eip155:1", address: ADDR }),
        sign: async ({ request }: { request: SignRequest }) =>
          Promise.resolve(fakeSignedEvm(request)),
      } as unknown as ReturnType<typeof chains>,
    });
    await ctl.init();
    return { ctl, timers, node };
  };

  it("deleting a row off getState throws — the poll keeps tracking it", async () => {
    const { ctl, timers } = await boot();
    const tx = await send(ctl, SEND);
    const state = ctl.getState();
    expect(Object.isFrozen(state.txs)).toBe(true);
    expect(Object.isFrozen(state.txs[tx.id])).toBe(true);

    expect(() => {
      delete state.txs[tx.id];
    }).toThrow(TypeError);
    expect(ctl.getState().txs[tx.id]).toBeDefined();
    expect(timers.armed(POLL_MS)).toBe(1);

    // The next poll still sees the row — the deleted-property attempt reached nothing.
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
    expect(timers.armed(POLL_MS)).toBe(1);
  });
});
