/**
 * PoC for r3-review: transactions/solana.ts `pollSolana` reads `getSignatureStatuses` first and
 * `getBlockHeight` second. A transaction that lands in its last valid block between the two reads
 * is settled `dropped` — a terminal, untracked state — although the node reports it confirmed.
 * Correct behaviour: check the status again (or the height first) before condemning the tx, so a
 * transaction that confirmed inside its validity window can never be recorded as dropped.
 * This test ASSERTS THE CURRENT (BUGGY) BEHAVIOUR.
 */
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import type { TrackedTransaction } from "../../src/transactions/route.ts";
import { idleNetworkDeps, send } from "../send-helpers.ts";
import { manualTimers } from "../support/timers.ts";

const POLL_MS = 4000;
const HOST = "http://host.local";
const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PAYER = "11111111111111111111111111111112";
const DEST = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LVBH = 100_000;
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change" as const,
};
const SEND = {
  account: ACCOUNT,
  network: NET,
  to: DEST,
  amount: 1000n,
  fee: "normal" as const,
  verify: { kind: "password" as const, password: "pw" },
};

type Backing = { collections: Map<string, Map<string, Uint8Array>> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const world = () => {
  /** Signature → the getSignatureStatuses slot; absent stays null. */
  const statuses = new Map<string, unknown>();
  /** Every wire sendTransaction was asked about, in order, as base64. */
  const wires: string[] = [];
  /** Every sendTransaction fetch, including ones dropped before the node saw them. */
  const attempts: string[] = [];
  const calls: string[] = [];
  const env = { blockHeight: 1 };
  /** How sendTransaction answers: a real signature, an rpc error, or a dead transport. */
  let sendMode: { kind: "ok" } | { kind: "rpc-error"; message: string } | { kind: "drop" } = {
    kind: "ok",
  };
  /** One-shot hook run inside the next getSignatureStatuses answer, after the reply is computed. */
  let onStatuses: ((sigs: string[]) => void) | undefined;
  const backing: Backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const warnings: string[] = [];
  let tag = 0;

  const answer = (method: string, params: unknown[]): unknown => {
    calls.push(method);
    switch (method) {
      case "getLatestBlockhash":
        return {
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: LVBH,
          },
        };
      case "getRecentPrioritizationFees":
        return [];
      case "getMultipleAccounts":
        return { value: (Array.isArray(params[0]) ? params[0] : []).map(() => null) };
      case "simulateTransaction": {
        const cfg = isObject(params[1]) ? params[1] : undefined;
        const accounts = isObject(cfg?.["accounts"]) ? cfg["accounts"] : undefined;
        const watch = Array.isArray(accounts?.["addresses"]) ? accounts["addresses"] : [];
        return {
          value: { err: null, logs: [], unitsConsumed: 6000, accounts: watch.map(() => null) },
        };
      }
      case "getBlockHeight":
        return env.blockHeight;
      case "sendTransaction": {
        const wire = String(params[0]);
        wires.push(wire);
        if (sendMode.kind === "rpc-error") {
          throw Object.assign(new Error(sendMode.message), { code: -32002 });
        }
        // A node answers with the transaction's own signature — the fee payer's, at bytes 1..65.
        return base58.encode(base64.decode(wire).slice(1, 65));
      }
      case "getSignatureStatuses": {
        const sigs = (Array.isArray(params[0]) ? params[0] : []).map(String);
        const reply = { value: sigs.map((s) => statuses.get(s) ?? null) };
        const hook = onStatuses;
        onStatuses = undefined;
        hook?.(sigs);
        return reply;
      }
      default:
        throw new Error(`unmocked ${method}`);
    }
  };

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    if (body.method === "sendTransaction") {
      attempts.push(String((body.params ?? [])[0]));
      if (sendMode.kind === "drop") {
        return Promise.reject(new TypeError("fetch failed"));
      }
    }
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: answer(body.method, body.params ?? []) };
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
      Promise.resolve({ template: "solana.bip44-change", network: NET, address: PAYER }),
    sign: async ({ request }: { request: { kind: string } }) => {
      await Promise.resolve();
      if (request.kind !== "solana.transaction") {
        throw new Error("unexpected request kind");
      }
      return { kind: "solana.transaction" as const, signature: new Uint8Array(64).fill(7) };
    },
  } as unknown as ReturnType<typeof chains>;

  const boot = async () => {
    const timers = manualTimers();
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: fetchImpl,
        rpc: { [NET]: [HOST] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      }),
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => 1_000_000,
      logger: { warn: (msg) => warnings.push(msg) },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  return {
    statuses,
    wires,
    attempts,
    calls,
    env,
    backing,
    warnings,
    boot,
    setSendMode: (mode: typeof sendMode) => {
      sendMode = mode;
    },
    /**
     * Arms the TOCTOU window: the next getSignatureStatuses replies `null` (the tx is still
     * unknown) and then, before the poll's getBlockHeight read, the transaction lands in its last
     * valid block — statuses say confirmed and the height moves past LVBH.
     */
    armLateLanding: () => {
      onStatuses = (sigs) => {
        for (const sig of sigs) {
          statuses.set(sig, { confirmationStatus: "confirmed", err: null });
        }
        env.blockHeight = LVBH + 1;
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

describe("PoC: a Solana tx confirmed between the status and height reads settles dropped", () => {
  it("PoC: confirmed-in-last-valid-block between the two reads is recorded dropped, terminally", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();

    w.setSendMode({ kind: "drop" });
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    const hash = hashOf(tx);

    // The node is reachable again; on the next poll the tx lands inside its validity window —
    // right between the poll's status read and its block-height read.
    w.setSendMode({ kind: "ok" });
    w.armLateLanding();
    await timers.fire(POLL_MS);

    // The node now reports the transaction confirmed…
    expect(w.statuses.get(hash)).toStrictEqual({ confirmationStatus: "confirmed", err: null });
    // …but the poll already settled it dropped, and the verdict is final: no poll is re-armed.
    expect(ctl.getState().txs[tx.id]?.state).toBe("dropped");
    expect(timers.armed(POLL_MS)).toBe(0);
    const lastStatus = w.calls.lastIndexOf("getSignatureStatuses");
    const lastHeight = w.calls.lastIndexOf("getBlockHeight");
    expect(lastStatus).toBeGreaterThanOrEqual(0);
    expect(lastHeight).toBeGreaterThan(lastStatus);
    console.log("call order tail:", w.calls.slice(-4));
  });
});
