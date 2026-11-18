/**
 * PoC for r3-review: assets/controller.ts `refresh` → `record()` writes `balances` and the
 * `tracked` reread closure with no lock/generation check. A balance read that is in flight
 * across `lock()` repopulates `balances` after the wallet locked, and its reread closure is
 * re-added to `tracked` (which lock() had just cleared) — so the next unlock's poll re-reads an
 * address the new session never asked for.
 * Correct behaviour: drop the read when the lock generation moved on — no state write and no
 * tracked entry may survive a lock.
 * This test ASSERTS THE CURRENT (BUGGY) BEHAVIOUR.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import type { PublicClient } from "viem";

import { AssetsController } from "../../src/assets/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { manualTimers } from "../support/timers.ts";

const ADDR = "0x2222222222222222222222222222222222222222";
const NET = "eip155:1";
const logger = { warn: () => {} };

const enc0 = `0x${"0".repeat(64)}`;

const client = (handlers: Record<string, unknown>): PublicClient =>
  ({
    transport: {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        const v = handlers[method];
        return method in handlers
          ? Promise.resolve(typeof v === "function" ? (v as (p?: unknown[]) => unknown)(params) : v)
          : Promise.reject(new Error(`unmocked ${method}`));
      },
    },
  }) as unknown as PublicClient;

const fakeNetworks = (c: PublicClient) =>
  ({
    client: () => c,
    info: () => ({ family: "evm", chainId: 1 }),
  }) as never;

const chains = {
  account: async () => Promise.reject(new Error("unmocked chains.account")),
};

describe("PoC: a balance read in flight across lock() repopulates a locked controller", () => {
  it("PoC: the gated read writes balances and a tracked reread after lock — and the next session re-reads it", async () => {
    let balanceReads = 0;
    let gated = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const c = client({
      // The balance read holds until the test releases it — the in-flight window.
      eth_getBalance: () => {
        balanceReads += 1;
        gated = true;
        return gate.then(() => "0xde0b6b3a7640000");
      },
      eth_call: () => enc0,
    });
    const timers = manualTimers();
    const ctl = new AssetsController({
      networks: fakeNetworks(c),
      chains,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: timers.setTimer,
      logger,
    });
    await ctl.init();

    const p = ctl.refresh(ADDR, NET);
    await vi.waitFor(() => {
      if (!gated) {
        throw new Error("balance read not pending yet");
      }
    });

    ctl.lock();
    // Locked state is empty…
    expect(ctl.getState().balances).toStrictEqual({});

    // …until the in-flight read lands and records anyway.
    releaseGate();
    await p;
    const key = `${NET}:${ADDR}`;
    expect(Object.keys(ctl.getState().balances)).toContain(key);
    expect(ctl.getState().balances[key]?.native).toBe("1000000000000000000");
    console.log("balances after lock + late read:", ctl.getState().balances);

    // The late record() also re-registered its reread in `tracked` (cleared by lock()): the
    // next session's poll re-reads this address although nothing in it asked for it.
    await ctl.init();
    ctl.setVisible(true);
    await timers.fire();
    expect(balanceReads).toBe(2);
    console.log(`eth_getBalance calls for ${ADDR}: ${String(balanceReads)}`);
    ctl.setVisible(false);
    ctl.lock();
  });
});
