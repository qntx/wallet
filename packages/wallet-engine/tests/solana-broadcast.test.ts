/**
 * A Solana broadcast whose answer is lost stays `submitted`: the wire is persisted, the fee payer's
 * signature inside it is the tracked id, polls rebroadcast the same bytes while the blockhash is
 * live and settle `dropped` once it expires — across restarts, without in-memory state. Only a
 * node's own refusal fails the send. Polls run on `manualTimers` — one-shot `setTimeout`
 * semantics.
 */
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { idleNetworkDeps, send } from "./send-helpers.ts";
import { manualTimers } from "./support/timers.ts";
import type { ManualTimers } from "./support/timers.ts";

const POLL_MS = 4000;
/** A blockhash lives 150 slots at the cluster's longest slot target of 400 ms. */
const PROCESSING_AGE_MS = 150 * 400;
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
  const env = {
    blockHeight: 1,
    /** The tip's absoluteSlot; `statusSlot` is the bank the status answer came from. */
    slot: 500,
    statusSlot: 500,
    /** `isBlockhashValid` answers: false = the blockhash is dead; `validitySlot` is its bank. */
    blockhashAlive: false,
    validitySlot: undefined as number | undefined,
    /** Fired after the poll's first read — a transaction landing between the two reads. */
    landAfterFirstRead: undefined as undefined | (() => void),
    /** The engine's clock — a drop streak's span is measured against it. */
    now: 1_000_000,
  };
  /** How sendTransaction answers: a real signature, an rpc error, or a dead transport. */
  let sendMode: { kind: "ok" } | { kind: "rpc-error"; message: string } | { kind: "drop" } = {
    kind: "ok",
  };
  const backing: Backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const warnings: string[] = [];
  // Transaction ids draw on `random` — keep the counter in world scope across restarts.
  let tag = 0;

  const answer = (method: string, params: unknown[]): unknown => {
    calls.push(method);
    const result = answerMethod(method, params);
    const land = env.landAfterFirstRead;
    if (
      land !== undefined &&
      (method === "getEpochInfo" ||
        method === "getBlockHeight" ||
        method === "getSignatureStatuses")
    ) {
      env.landAfterFirstRead = undefined;
      land();
    }
    return result;
  };

  const answerMethod = (method: string, params: unknown[]): unknown => {
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
      case "getEpochInfo":
        return { absoluteSlot: env.slot, blockHeight: env.blockHeight };
      case "sendTransaction": {
        const wire = String(params[0]);
        wires.push(wire);
        if (sendMode.kind === "rpc-error") {
          throw Object.assign(new Error(sendMode.message), { code: -32002 });
        }
        // A node answers with the transaction's own signature — the fee payer's, at bytes 1..65.
        return base58.encode(base64.decode(wire).slice(1, 65));
      }
      case "isBlockhashValid":
        return {
          context: { slot: env.validitySlot ?? env.slot },
          value: env.blockhashAlive,
        };
      case "getSignatureStatuses": {
        const sigs = Array.isArray(params[0]) ? params[0] : [];
        return {
          context: { slot: env.statusSlot },
          value: sigs.map((s) => statuses.get(String(s)) ?? null),
        };
      }
      /* The node's ledger reaches back to second 300 — before every submission the rig tracks
         (clock 1_000_000 ms, skew margin ten minutes), so coverage holds. */
      case "getFirstAvailableBlock":
        return 300;
      case "getBlockTime":
        return 300;
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
      now: () => env.now,
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
    statuses,
    wires,
    attempts,
    calls,
    env,
    backing,
    warnings,
    boot,
    persistedTx,
    setSendMode: (mode: typeof sendMode) => {
      sendMode = mode;
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

const rawOf = (tx: TrackedTransaction): string => {
  const { raw } = tx;
  if (raw === undefined) {
    throw new Error("tracked transaction has no raw");
  }
  return raw;
};

/**
 * The streak a drop claim without a host endpoint needs after the first claiming poll: two more
 * consecutive polls, the last more than one processing age after the streak began.
 */
const corroborate = async (w: ReturnType<typeof world>, timers: ManualTimers): Promise<void> => {
  w.env.now += PROCESSING_AGE_MS + 1;
  await timers.fire(POLL_MS);
  await timers.fire(POLL_MS);
};

describe("a Solana broadcast with an unsettled outcome", () => {
  it("a transport failure keeps the send submitted; polls rebroadcast the same wire", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();

    w.setSendMode({ kind: "drop" });
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    // The tracked id is the fee payer's signature, recovered from the persisted wire alone.
    const wire = base64.decode(rawOf(tx));
    expect(base58.encode(wire.slice(1, 65))).toBe(hashOf(tx));
    expect(w.wires).toHaveLength(0); // the node never saw it

    w.setSendMode({ kind: "ok" });
    await timers.fire(POLL_MS);
    expect(w.wires).toStrictEqual([rawOf(tx)]); // byte-identical rebroadcast

    w.statuses.set(hashOf(tx), { confirmationStatus: "confirmed", err: null, slot: w.env.slot });
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
  });

  it("a failed rebroadcast is swallowed and the next poll tries again", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();

    w.setSendMode({ kind: "drop" });
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(w.attempts).toStrictEqual([rawOf(tx)]); // the original send
    expect(w.wires).toHaveLength(0); // the node never saw it

    // The poll's rebroadcast dies in transit too — swallowed, the tx stays tracked.
    await timers.fire(POLL_MS);
    expect(w.attempts).toStrictEqual([rawOf(tx), rawOf(tx)]);
    expect(w.wires).toHaveLength(0);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
    expect(w.warnings).not.toContain("tx status poll failed");

    // The endpoint recovers: the next poll broadcasts the same wire for real.
    w.setSendMode({ kind: "ok" });
    await timers.fire(POLL_MS);
    expect(w.wires).toStrictEqual([rawOf(tx)]);

    w.statuses.set(hashOf(tx), { confirmationStatus: "confirmed", err: null, slot: w.env.slot });
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
  });

  it("a failed simulation refuses the send", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.setSendMode({
      kind: "rpc-error",
      message:
        "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
    });

    await expect(send(ctl, SEND)).rejects.toThrow(/simulation failed/);
    const [tx] = Object.values(ctl.getState().txs);
    expect(tx?.state).toBe("failed");
    expect(tx?.hash).toBeUndefined();
    expect(tx?.raw).toBeUndefined();
  });

  it("an already-processed answer is an accepted send", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.setSendMode({
      kind: "rpc-error",
      message: "Transaction simulation failed: This transaction has already been processed",
    });

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
  });

  it("a blockhash-not-found answer stays submitted and drops once the blockhash expires", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setSendMode({
      kind: "rpc-error",
      message: "Transaction simulation failed: Blockhash not found",
    });

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");

    // While the blockhash lives the poll keeps the tx and rebroadcasts it.
    w.setSendMode({ kind: "ok" });
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
    expect(w.wires.length).toBeGreaterThan(1);

    w.env.blockHeight = LVBH + 1;
    await timers.fire(POLL_MS);
    // One upstream's claim is only a claim: the streak proves the drop.
    await corroborate(w, timers);
    expect(ctl.getState().txs[tx.id]?.state).toBe("dropped");
  });

  it("a signed row recovered after a restart is watched but never resent", async () => {
    const w = world();
    const first = await w.boot();
    w.setSendMode({ kind: "ok" });
    const tx = await send(first.ctl, SEND);
    expect(tx.state).toBe("submitted");

    /* The process dies after the signed row persisted but before the broadcast outcome could:
       disk says `signed` — bytes the wallet never settled stay bytes it never posts again. */
    const stored = await w.persistedTx(tx.id);
    await createMemoryEngineStore(w.backing)
      .collection("transactions")
      .put(tx.id, new TextEncoder().encode(JSON.stringify({ ...stored, state: "signed" })));

    const second = await w.boot();
    const recovered = second.ctl.getState().txs[tx.id];
    expect(recovered?.state).toBe("submitted");
    expect(recovered?.rebroadcast).toBe(false);

    // Past the stored expiry with the blockhash still alive, the poll puts nothing on the wire.
    w.env.blockHeight = LVBH + 1;
    w.env.blockhashAlive = true;
    const before = w.attempts.length;
    await second.timers.fire(POLL_MS);
    expect(w.attempts).toHaveLength(before);
  });

  it("a restart restores the blockhash expiry and rebroadcasts the persisted wire", async () => {
    const w = world();
    const first = await w.boot();
    w.setSendMode({ kind: "drop" });

    const tx = await send(first.ctl, SEND);
    expect(tx.state).toBe("submitted");
    const before = w.wires.length;

    const second = await w.boot();
    const reloaded = second.ctl.getState().txs[tx.id];
    expect(reloaded?.state).toBe("submitted");
    expect(reloaded?.lastValidBlockHeight).toBe(LVBH);
    expect(reloaded?.raw).toBe(rawOf(tx));

    w.setSendMode({ kind: "ok" });
    await second.timers.fire(POLL_MS);
    expect(w.wires.length).toBeGreaterThan(before);
    expect(w.wires.at(-1)).toBe(rawOf(tx));

    w.env.blockHeight = LVBH + 1;
    await second.timers.fire(POLL_MS);
    await corroborate(w, second.timers);
    expect(second.ctl.getState().txs[tx.id]?.state).toBe("dropped");
  });

  it("a transaction landing between the tip and status reads is never dropped", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setSendMode({ kind: "drop" });

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    const hash = hashOf(tx);
    const before = w.attempts.length;

    // The blockhash is dead and the transaction lands exactly between the poll's two reads.
    w.env.blockHeight = LVBH + 1;
    w.env.landAfterFirstRead = () => {
      w.statuses.set(hash, { confirmationStatus: "processed", err: null, slot: w.env.slot });
    };
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
    // Nothing was rebroadcast either: an expired blockhash cannot carry the bytes anymore.
    expect(w.attempts).toHaveLength(before);

    w.statuses.set(hash, { confirmationStatus: "confirmed", err: null, slot: w.env.slot });
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
  });

  it("a status answer from a bank behind the tip cannot prove a drop", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setSendMode({ kind: "drop" });

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    const before = w.attempts.length;

    // Expired — but the status answer came from an older bank than the height proof.
    w.env.blockHeight = LVBH + 1;
    w.env.slot = 700;
    w.env.statusSlot = 600;
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
    expect(w.attempts).toHaveLength(before);

    // A bank at least as far along as the tip also has no entry: the claim needs its streak.
    w.env.statusSlot = 700;
    await timers.fire(POLL_MS);
    await corroborate(w, timers);
    expect(ctl.getState().txs[tx.id]?.state).toBe("dropped");
  });

  it("a processed-only entry past the blockhash's validity is not a drop", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setSendMode({ kind: "drop" });

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    const before = w.attempts.length;

    w.env.blockHeight = LVBH + 1;
    w.statuses.set(hashOf(tx), { confirmationStatus: "processed", err: null, slot: w.env.slot });
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
    expect(w.attempts).toHaveLength(before);
  });

  it("the tip and the blockhash validity are read before the status so the proof is never stale", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setSendMode({ kind: "drop" });

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(ctl.getState().txs[tx.id]?.lastValidBlockHeight).toBe(LVBH);

    w.calls.length = 0;
    w.env.blockHeight = LVBH + 1;
    await timers.fire(POLL_MS);
    const proofReads = new Set(["getEpochInfo", "isBlockhashValid", "getSignatureStatuses"]);
    const reads = w.calls.filter((call) => proofReads.has(call));
    expect(reads).toStrictEqual(["getEpochInfo", "isBlockhashValid", "getSignatureStatuses"]);
    await corroborate(w, timers);
    expect(ctl.getState().txs[tx.id]?.state).toBe("dropped");
  });

  it("a blockhash still valid on the endpoint is never dropped, whatever the stored bound", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setSendMode({ kind: "drop" });

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    const before = w.attempts.length;

    // The wallet stamped this bound from a lagging endpoint — the true expiry is higher.
    w.env.blockHeight = LVBH + 1;
    w.env.blockhashAlive = true;
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
    // Still executable: the poll rebroadcasts the persisted wire.
    expect(w.attempts.length).toBeGreaterThan(before);

    // The blockhash dying on the same endpoint claims the drop — the streak proves it.
    w.env.blockhashAlive = false;
    await timers.fire(POLL_MS);
    await corroborate(w, timers);
    expect(ctl.getState().txs[tx.id]?.state).toBe("dropped");
  });

  it("a status bank behind the blockhash-validity read cannot prove a drop", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setSendMode({ kind: "drop" });

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");

    w.env.blockHeight = LVBH + 1;
    w.env.validitySlot = 800;
    w.env.statusSlot = 700;
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");

    w.env.statusSlot = 800;
    await timers.fire(POLL_MS);
    await corroborate(w, timers);
    expect(ctl.getState().txs[tx.id]?.state).toBe("dropped");
  });
});
