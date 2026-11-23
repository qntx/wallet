/**
 * A `dropped` answer is a proof, not a poll result: every read of one poll goes to one pinned
 * upstream, and without a host endpoint the same picture must hold on three consecutive polls
 * spanning more than one processing age (~60 s). These tests exercise the real `pinnedSolanaCaller`
 * over a two-provider fake gateway so the pinning is observable in the requests: the first call of
 * a poll is unpinned, its answer names the provider, and every later read of that poll carries
 * `x-gateway-provider`.
 */
import { base64 } from "@scure/base";
import {
  getNonceEncoder,
  getTransferSolInstruction,
  NonceState,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type { Nonce } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { pinnedSolanaCaller } from "../src/networks/controller.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import type { DropEvidence } from "../src/transactions/drop-evidence.ts";
import type { RouteContext, TrackedTransaction } from "../src/transactions/route.ts";
import { pollSolana } from "../src/transactions/solana.ts";

const GATEWAY = "https://gateway.test";
const HOST = "https://host.test";
const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const HASH = "3o9gXxKm2wQn5rYbP7sTdUfVhJkLzNcEaWqRtYuIpAsD";
const NONCE_VALUE = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const ADVANCED_VALUE = "6vN9k1dQ3bBqM2qKf8k8tF4Hh8K5vN9k1dQ3bBqM2qKM";
const LVBH = 1000;
/** A blockhash lives 150 slots at the cluster's longest slot target of 400 ms. */
const PROCESSING_AGE_MS = 150 * 400;

let BLOCKHASH_WIRE: string;
let DURABLE_WIRE: string;
let NONCE_ACCOUNT: string;

beforeAll(async () => {
  const payer = await generateKeyPairSigner();
  const recipient = await generateKeyPairSigner();
  const plain = appendTransactionMessageInstructions(
    [
      getTransferSolInstruction({
        source: payer,
        destination: recipient.address,
        amount: 1000,
      }),
    ],
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(NONCE_VALUE), lastValidBlockHeight: BigInt(LVBH) },
      setTransactionMessageFeePayer(payer.address, createTransactionMessage({ version: 0 })),
    ),
  );
  BLOCKHASH_WIRE = base64.encode(
    new Uint8Array(getTransactionEncoder().encode(await signTransactionMessageWithSigners(plain))),
  );

  const nonceAuthority = await generateKeyPairSigner();
  const nonceAccount = await generateKeyPairSigner();
  const durable = setTransactionMessageLifetimeUsingDurableNonce(
    {
      nonce: NONCE_VALUE as Nonce,
      nonceAccountAddress: nonceAccount.address,
      nonceAuthorityAddress: nonceAuthority.address,
    },
    appendTransactionMessageInstructions(
      [
        getTransferSolInstruction({
          source: nonceAuthority,
          destination: recipient.address,
          amount: 1000,
        }),
      ],
      setTransactionMessageFeePayerSigner(nonceAuthority, createTransactionMessage({ version: 0 })),
    ),
  );
  DURABLE_WIRE = base64.encode(
    new Uint8Array(
      getTransactionEncoder().encode(await signTransactionMessageWithSigners(durable)),
    ),
  );
  NONCE_ACCOUNT = nonceAccount.address;
});

/** `getNonceEncoder` is the oracle for what the endpoint's base64 account data carries. */
const nonceAccountValue = (value: string): string =>
  base64.encode(
    new Uint8Array(
      getNonceEncoder().encode({
        version: 1,
        state: NonceState.Initialized,
        authority: address(NONCE_VALUE),
        blockhash: address(value),
        lamportsPerSignature: 5000n,
      }),
    ),
  );

/**
 * A signature-history entry that provably reaches back before the row's `submittedAt` (1_000_000 in
 * this rig): its blockTime predates the submission by more than the 10-minute skew margin.
 */
const HISTORY_BEFORE_SUBMISSION = {
  signature: "4xother",
  slot: 4900,
  err: null,
  confirmationStatus: "finalized",
  blockTime: 300,
};

const FINALIZED_ENTRY = { slot: 5001, confirmationStatus: "finalized", err: null };

type Node = {
  /** `getEpochInfo`: the tip's absoluteSlot and blockHeight. */
  tipSlot: number;
  tipHeight: number;
  /** `isBlockhashValid`'s answer and the bank it was read on. */
  blockhashAlive: boolean;
  validitySlot: number;
  /** `getSignatureStatuses`: the entry it names and the bank it was read on. */
  entry: unknown;
  statusSlot: number;
  /** `getFirstAvailableBlock`: the oldest slot served; `"fail"` rejects, `"weird"` misforms. */
  firstBlock: number | "fail" | "weird";
  /** `getBlockTime(firstBlock)`: its unix seconds — `null` answers a pruned block. */
  firstBlockTime: number | null;
  /** The nonce account's stored value and read bank; `nonceGone` reads the account as closed. */
  nonce: string;
  nonceSlot: number;
  nonceGone: boolean;
  /** The nonce account's `getSignaturesForAddress` page; `"fail"` rejects the read. */
  history: ReadonlyArray<unknown> | "fail";
  /** Methods whose next read throws a transport error. */
  failing: Set<string>;
};

/** The gateway provider claiming the whole drop: expired, invalid, no entry on a fresh bank. */
const dropNode = (over: Partial<Node> = {}): Node => ({
  tipSlot: 6000,
  tipHeight: 2000,
  blockhashAlive: false,
  validitySlot: 6000,
  entry: undefined,
  statusSlot: 6000,
  /* Slot 300 sits at second 300 — well before the rig's submission time (1_000_000 ms less the
     ten-minute skew), so the default node's ledger provably covers the submission. */
  firstBlock: 300,
  firstBlockTime: 300,
  nonce: ADVANCED_VALUE,
  nonceSlot: 5000,
  nonceGone: false,
  history: [HISTORY_BEFORE_SUBMISSION],
  failing: new Set(),
  ...over,
});

const answer = (n: Node, method: string, _params: unknown[]): unknown => {
  if (n.failing.has(method)) {
    throw new TypeError("fetch failed");
  }
  switch (method) {
    case "getEpochInfo":
      return { absoluteSlot: n.tipSlot, blockHeight: n.tipHeight };
    case "isBlockhashValid":
      return { context: { slot: n.validitySlot }, value: n.blockhashAlive };
    case "getSignatureStatuses":
      return { context: { slot: n.statusSlot }, value: [n.entry ?? null] };
    case "getFirstAvailableBlock":
      if (n.firstBlock === "fail") {
        throw new TypeError("fetch failed");
      }
      return n.firstBlock === "weird" ? "not-a-slot" : n.firstBlock;
    case "getBlockTime":
      return n.firstBlockTime;
    case "getAccountInfo":
      return {
        context: { slot: n.nonceSlot },
        value: n.nonceGone
          ? null
          : {
              owner: SYSTEM_PROGRAM_ADDRESS,
              data: [nonceAccountValue(n.nonce), "base64"],
            },
      };
    case "getSignaturesForAddress":
      if (n.history === "fail") {
        throw new TypeError("fetch failed");
      }
      return [...n.history];
    case "sendTransaction":
      return HASH;
    default:
      throw new Error(`unmocked ${method}`);
  }
};

type World = {
  /** Provider ids the gateway routes to, by name. */
  readonly nodes: { readonly a: Node; readonly b: Node };
  /** Every JSON-RPC call the gateway received: the routed provider and the request's pin. */
  readonly requests: Array<{ method: string; provider: string; pin: string | undefined }>;
  /** Every wire the poll rebroadcast. */
  readonly broadcasts: string[];
  /** A fresh pinned caller per call — like `NetworkController.pinnedSolanaRpc`. */
  readonly api: () => SolanaRpc;
  /** The world plus a callable fetch for caller-level tests. */
  readonly fetchFn: typeof globalThis.fetch;
};

const world = (): World => {
  const nodes = { a: dropNode(), b: dropNode() };
  const requests: World["requests"] = [];
  const broadcasts: string[] = [];
  const fetchFn: typeof globalThis.fetch = async (_input, init) => {
    await Promise.resolve();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const pin = headers["x-gateway-provider"];
    const provider = pin === "node-b" ? "b" : "a"; // unpinned requests route to the first provider
    const body = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
    requests.push({ method: body.method, provider, pin });
    if (body.method === "sendTransaction") {
      broadcasts.push(String(body.params?.[0]));
    }
    const result = answer(nodes[provider], body.method, body.params ?? []);
    return Response.json(
      { jsonrpc: "2.0", id: 1, result },
      { headers: { "x-gateway-providers": `node-${provider}` } },
    );
  };
  return {
    nodes,
    requests,
    broadcasts,
    api: () => pinnedSolanaCaller([GATEWAY], fetchFn),
    fetchFn,
  };
};

const NOT_NEEDED = { kind: "not-needed" };
const UNAVAILABLE = { kind: "unavailable" };

const ctx = (
  w: World,
  independent: unknown = NOT_NEEDED,
  now: () => number = () => 1_000_000,
  networks: Record<string, unknown> = {},
): RouteContext => ({
  options: {
    networks: {
      solanaRpc: w.api,
      pinnedSolanaRpc: w.api,
      independentSolanaRpc: () => independent,
      independentPinnedSolanaRpc: () => independent,
      ...networks,
    } as never,
    wallet: {} as never,
    openStore: async () => Promise.resolve({} as never),
    random: (n: number) => new Uint8Array(n),
    setTimer: () => () => {},
    now,
    logger: { warn: () => {} },
  },
  transition: async (tx, next) => Promise.resolve({ ...tx, ...next }),
  track: () => {},
  txs: () => ({}),
  newId: () => "tx-test",
});

const tx = (over: Partial<TrackedTransaction> = {}): TrackedTransaction => ({
  id: "tx-1",
  family: "solana",
  network: NET,
  account: "w",
  hash: HASH,
  state: "submitted",
  intent: undefined,
  nonce: 0,
  lastValidBlockHeight: LVBH,
  raw: BLOCKHASH_WIRE,
  submittedAt: 1_000_000,
  error: undefined,
  ...over,
});

const durableTx = (over: Partial<TrackedTransaction> = {}): TrackedTransaction => {
  const { lastValidBlockHeight: _bound, ...rest } = tx({
    durableNonce: { account: NONCE_ACCOUNT, value: NONCE_VALUE },
    raw: DURABLE_WIRE,
    ...over,
  });
  return rest;
};

const ev = (): DropEvidence => new Map();

/** Drives `n` polls on `c` against `t`, advancing `now` by `step` before each poll after the first. */
const polls = async (
  c: RouteContext,
  t: TrackedTransaction,
  evidence: DropEvidence,
  clock: { t: number },
  n: number,
  step = 30_000,
): Promise<unknown> => {
  let last: unknown;
  for (let i = 0; i < n; i += 1) {
    if (i > 0) {
      clock.t += step;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polls are sequential, order is the point
    last = await pollSolana(c, t, evidence);
  }
  return last;
};

/** A fetch that throws for `dead.url` — counting each attempt — and delegates the rest. */
const deadEndpoint =
  (dead: { url: string; calls: number }, inner: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) => {
    if (String(input) === dead.url) {
      dead.calls += 1;
      throw new TypeError("fetch failed");
    }
    return inner(input, init);
  };

/**
 * A fetch that answers `method` on the gateway with a JSON-RPC error the first time it is asked —
 * every other call delegates to the world — while counting calls routed to `other`.
 */
const errorOnceFor = (
  w: World,
  method: string,
  other: { url: string; calls: number },
): typeof globalThis.fetch => {
  let served = false;
  return async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (String(input) === other.url) {
      other.calls += 1;
      return Response.json({ jsonrpc: "2.0", id: 1, result: null });
    }
    if (!served && String(input) === GATEWAY && body.method === method) {
      served = true;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "node behind" },
      });
    }
    return w.fetchFn(input, init);
  };
};

/** A host endpoint stub: a `SolanaRpc` answering from `n`, its calls recorded. */
const hostApi = (n: Node) => {
  const calls: string[] = [];
  return {
    calls,
    api: {
      call: async (method: string, params: unknown[]) => {
        calls.push(method);
        await Promise.resolve();
        return answer(n, method, params);
      },
    },
  };
};

describe("a dropped answer must be proven on one upstream", () => {
  it("a single lagging-primary poll does not drop", async () => {
    const w = world();
    w.nodes.b.entry = FINALIZED_ENTRY; // the second provider knows the transaction
    const answer1 = await pollSolana(ctx(w), tx(), ev());
    expect(answer1).toBeUndefined();
    expect(w.broadcasts).toHaveLength(0); // a claimed-dead blockhash carries nothing
  });

  it("pins every read of a poll to the first answering provider", async () => {
    const w = world();
    w.nodes.b.entry = FINALIZED_ENTRY; // would contradict — but it is never asked mid-poll
    await pollSolana(ctx(w), tx(), ev());
    // tip, blockhash validity, signature status, then the ledger-coverage pair: five reads…
    const methods = w.requests.map((r) => r.method);
    expect(methods.slice(0, 5)).toStrictEqual([
      "getEpochInfo",
      "isBlockhashValid",
      "getSignatureStatuses",
      "getFirstAvailableBlock",
      "getBlockTime",
    ]);
    // …the first unpinned, its provider id pinned on every later read
    expect(w.requests[0]?.pin).toBeUndefined();
    expect(w.requests.slice(1).map((r) => r.pin)).toStrictEqual(
      w.requests.slice(1).map(() => "node-a"),
    );
    expect(w.requests.every((r) => r.provider === "a")).toBe(true);
  });

  it("a new poll pins afresh — it may land on a different provider than the last poll", async () => {
    const w = world();
    await pollSolana(ctx(w), tx(), ev());
    w.requests.length = 0;
    await pollSolana(ctx(w), tx(), ev());
    expect(w.requests[0]?.pin).toBeUndefined(); // fresh pinned client per poll
    expect(w.requests[1]?.pin).toBe("node-a");
  });

  it("drops only after three consecutive polls spanning a processing age", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += PROCESSING_AGE_MS; // a full age later — but only the second poll
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 1; // third poll, span now past one processing age
    await expect(pollSolana(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
  });

  it("two drop polls spanning a full processing age still do not drop", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += PROCESSING_AGE_MS + 1; // a full age — but only the second observation
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    // The third consecutive observation completes the proof.
    await expect(pollSolana(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
  });

  it("three polls inside one processing age still do not drop", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    await expect(polls(c, tx(), ev(), clock, 3, 20_000)).resolves.toBeUndefined();
  });

  it("a blockhash the endpoint still calls valid resets the streak", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    w.nodes.a.blockhashAlive = true; // contrary observation: the wire can still land
    clock.t += 30_000;
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    expect(w.broadcasts).toHaveLength(1); // still valid: the wire went out again
    w.nodes.a.blockhashAlive = false;
    // the streak restarts from zero: three fresh corroborating polls over a fresh age
    clock.t += 30_000;
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 30_000;
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 31_000; // span from the restarted since: 61 s > one processing age
    await expect(pollSolana(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
  });

  it("a poll that sees the transaction's entry ends as included, not dropped", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    w.nodes.a.entry = { slot: 5001, confirmationStatus: "confirmed", err: null };
    clock.t += 30_000;
    await expect(pollSolana(c, t, evidence)).resolves.toMatchObject({
      kind: "included",
      state: "confirmed",
    });
  });

  it("a pinned read failure neither drops nor keeps the streak", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += PROCESSING_AGE_MS;
    // the pinned provider now fails mid-poll — no failover to the second provider
    w.nodes.a.failing.add("getSignatureStatuses");
    await expect(pollSolana(c, t, evidence)).rejects.toThrow(TypeError);
    expect(w.requests.every((r) => r.provider === "a")).toBe(true);
    w.nodes.a.failing.clear();
    // the failed read cleared the streak: it must build again from zero
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 30_000;
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 30_001;
    await expect(pollSolana(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
  });

  it("an unavailable host endpoint falls back to repeated corroboration", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    const c = ctx(w, UNAVAILABLE, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += PROCESSING_AGE_MS + 1;
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    await expect(pollSolana(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
  });
});

describe("with a host endpoint configured", () => {
  it("a host endpoint agreeing on the drop proves it in one poll", async () => {
    const w = world();
    const host = hostApi(dropNode());
    const independent = { kind: "available", source: "host", client: host.api };
    const answer1 = await pollSolana(ctx(w, independent), tx(), ev());
    expect(answer1).toStrictEqual({ kind: "ended", state: "dropped" });
    // The host ran the whole proof too: tip, validity, status, ledger coverage.
    expect(host.calls).toStrictEqual([
      "getEpochInfo",
      "isBlockhashValid",
      "getSignatureStatuses",
      "getFirstAvailableBlock",
      "getBlockTime",
    ]);
  });

  it("a host endpoint that knows the transaction lands the row instead", async () => {
    const w = world();
    const host = hostApi(dropNode({ entry: FINALIZED_ENTRY }));
    const independent = { kind: "available", source: "host", client: host.api };
    const answer1 = await pollSolana(ctx(w, independent), tx(), ev());
    expect(answer1).toStrictEqual({
      kind: "included",
      state: "confirmed",
      block: { height: 5001 },
      final: true,
    });
  });

  it("a host whose blockhash is still valid keeps the transaction submitted", async () => {
    const w = world();
    const host = hostApi(dropNode({ blockhashAlive: true }));
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), tx(), ev())).resolves.toBeUndefined();
  });

  it("a host read failure keeps the transaction submitted", async () => {
    const w = world();
    const host = hostApi(dropNode({ failing: new Set(["isBlockhashValid"]) }));
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), tx(), ev())).resolves.toBeUndefined();
  });

  it("the host sees the durable-nonce drop proof in one poll", async () => {
    const w = world();
    const host = hostApi(dropNode());
    const independent = { kind: "available", source: "host", client: host.api };
    const answer1 = await pollSolana(ctx(w, independent), durableTx(), ev());
    expect(answer1).toStrictEqual({ kind: "ended", state: "dropped" });
    // Nonce account, status, then the nonce account's own history — the same reads the
    // primary ran, in the same order.
    expect(host.calls).toStrictEqual([
      "getAccountInfo",
      "getSignatureStatuses",
      "getSignaturesForAddress",
    ]);
  });

  it("a host whose nonce history lists our signature lands it, not drops it", async () => {
    const w = world();
    const host = hostApi(
      dropNode({
        history: [
          {
            signature: HASH,
            slot: 5001,
            err: null,
            confirmationStatus: "finalized",
            blockTime: 500,
          },
        ],
      }),
    );
    const independent = { kind: "available", source: "host", client: host.api };
    const answer1 = await pollSolana(ctx(w, independent), durableTx(), ev());
    expect(answer1).toStrictEqual({
      kind: "included",
      state: "confirmed",
      block: { height: 5001 },
      final: true,
    });
  });

  it("a host whose nonce history does not reach back keeps the row", async () => {
    const w = world();
    const host = hostApi(
      dropNode({ history: [{ ...HISTORY_BEFORE_SUBMISSION, blockTime: 999_999 }] }),
    );
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), durableTx(), ev())).resolves.toBeUndefined();
  });

  it("a status bank behind the nonce read proves nothing", async () => {
    const w = world();
    w.nodes.a.statusSlot = 4999; // the status answer predates the finalized nonce read's slot
    const host = hostApi(dropNode({ statusSlot: 4999 }));
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), durableTx(), ev())).resolves.toBeUndefined();
    // The primary never claimed the drop — the host is never asked, and nothing went out again:
    // the nonce may already be consumed.
    expect(host.calls).toHaveLength(0);
    expect(w.broadcasts).toHaveLength(0);
  });

  it("the durable-nonce poll pins its reads too", async () => {
    const w = world();
    w.nodes.b.entry = FINALIZED_ENTRY;
    await pollSolana(ctx(w), durableTx(), ev());
    const methods = w.requests.map((r) => r.method);
    expect(methods.slice(0, 3)).toStrictEqual([
      "getAccountInfo",
      "getSignatureStatuses",
      "getSignaturesForAddress",
    ]);
    expect(w.requests[0]?.pin).toBeUndefined();
    expect(w.requests.slice(1).map((r) => r.pin)).toStrictEqual(
      w.requests.slice(1).map(() => "node-a"),
    );
    expect(w.requests.every((r) => r.provider === "a")).toBe(true);
  });

  it("the durable-nonce drop needs the streak without a host endpoint", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = durableTx();
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += PROCESSING_AGE_MS + 1;
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    await expect(pollSolana(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
  });
});

describe("the ledger must reach back past the submission", () => {
  it("a node whose history starts after the submission cannot prove the drop", async () => {
    const w = world();
    /* The transaction was submitted at 1_000_000 ms; this node's oldest block sits at second
       999 — `getSignatureStatuses` simply cannot see a landing that old, so `null` is not a
       drop. An identically shallow host "agrees" — but the claim never forms on the primary,
       so the host is never even asked. */
    const shallow = dropNode({ firstBlock: 999_999, firstBlockTime: 999_999 });
    w.nodes.a.firstBlock = 999_999;
    w.nodes.a.firstBlockTime = 999_999;
    const host = hostApi(shallow);
    const independent = { kind: "available", source: "host", client: host.api };
    const c = ctx(w, independent);
    await expect(pollSolana(c, tx(), ev())).resolves.toBeUndefined();
    expect(host.calls).toHaveLength(0);
    /* Nor can the streak rescue it: the claim stays unformed poll after poll. */
    await expect(pollSolana(c, tx(), ev())).resolves.toBeUndefined();
    expect(w.requests.every((r) => r.method !== "sendTransaction")).toBe(true);
  });

  it("a host whose ledger does not reach either cannot corroborate", async () => {
    const w = world(); // the primary's ledger covers the submission — it claims
    const host = hostApi(dropNode({ firstBlock: 999_999, firstBlockTime: 999_999 }));
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), tx(), ev())).resolves.toBeUndefined();
    // The host ran the coverage pair and could not agree.
    expect(host.calls).toStrictEqual([
      "getEpochInfo",
      "isBlockhashValid",
      "getSignatureStatuses",
      "getFirstAvailableBlock",
      "getBlockTime",
    ]);
  });

  it("a node whose history starts inside the skew margin cannot prove the drop", async () => {
    const w = world();
    /* The ledger reaches back only to second 700 — inside the ten-minute skew margin around
       the 1_000_000 ms submission, so it cannot rule out a landing before its own horizon. */
    w.nodes.a.firstBlock = 700;
    w.nodes.a.firstBlockTime = 700;
    const host = hostApi(dropNode());
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), tx(), ev())).resolves.toBeUndefined();
    expect(host.calls).toHaveLength(0);
  });

  it("a node whose oldest block has no recorded time cannot prove the drop", async () => {
    const w = world();
    w.nodes.a.firstBlockTime = null; // pruned or never recorded: coverage unknown
    const host = hostApi(dropNode());
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), tx(), ev())).resolves.toBeUndefined();
    expect(host.calls).toHaveLength(0);
  });

  it("a node whose coverage read fails cannot prove the drop", async () => {
    const w = world();
    w.nodes.a.firstBlock = "fail";
    const host = hostApi(dropNode());
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), tx(), ev())).resolves.toBeUndefined();
    expect(host.calls).toHaveLength(0);
  });

  it("a node whose coverage answer is malformed cannot prove the drop", async () => {
    const w = world();
    w.nodes.a.firstBlock = "weird";
    const host = hostApi(dropNode());
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), tx(), ev())).resolves.toBeUndefined();
    expect(host.calls).toHaveLength(0);
  });

  it("a status bank behind the tip and the validity read proves nothing", async () => {
    const w = world();
    /* The status answer came from bank 5_999, behind both the tip and the bank the validity
       read ran on: the transaction may have landed on the bank the status was too stale to
       see — so no claim forms and the host is never asked. */
    w.nodes.a.statusSlot = 5999;
    const host = hostApi(dropNode());
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollSolana(ctx(w, independent), tx(), ev())).resolves.toBeUndefined();
    expect(host.calls).toHaveLength(0);
  });
});

describe("pinnedSolanaCaller", () => {
  it("fails over only until the first answer, then pins that provider", async () => {
    const w = world();
    const dead = { url: "https://dead.test", calls: 0 };
    const api = pinnedSolanaCaller([dead.url, GATEWAY], deadEndpoint(dead, w.fetchFn));
    await api.call("getEpochInfo", []);
    expect(dead.calls).toBe(1);
    await api.call("getEpochInfo", []);
    // Pinned to the gateway: the dead URL is never retried.
    expect(dead.calls).toBe(1);
  });

  it("throws a pinned JSON-RPC error instead of failing over", async () => {
    const w = world();
    const other = { url: "https://other.test", calls: 0 };
    const api = pinnedSolanaCaller(
      [GATEWAY, other.url],
      errorOnceFor(w, "getSignatureStatuses", other),
    );
    await api.call("getEpochInfo", []); // pins to GATEWAY
    await expect(api.call("getSignatureStatuses", [[HASH]])).rejects.toThrow("node behind");
    expect(other.calls).toBe(0);
  });

  it("names the answering endpoint in pinnedUrl once it commits", async () => {
    const w = world();
    const api = pinnedSolanaCaller([GATEWAY], w.fetchFn);
    expect(api.pinnedUrl()).toBeUndefined();
    await api.call("getEpochInfo", []);
    expect(api.pinnedUrl()).toBe(GATEWAY);
    /* Failover names the endpoint that answered, not the dead first one — the pin, not the
       list order, is what makes a corroborator "the same upstream". */
    const dead = { url: GATEWAY, calls: 0 };
    const failedOver = pinnedSolanaCaller([GATEWAY, HOST], deadEndpoint(dead, w.fetchFn));
    await failedOver.call("getEpochInfo", []);
    expect(dead.calls).toBe(1);
    expect(failedOver.pinnedUrl()).toBe(HOST);
  });
});

describe("the corroborator is never the pinned upstream", () => {
  it("a poll pinned onto the host endpoint keeps the row for the streak", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    const dead = { url: GATEWAY, calls: 0 };
    /* The real failover client: the gateway dies on the poll's first read and the pin lands on
       the host URL — the same URL a host corroborator would read. */
    const api = () => pinnedSolanaCaller([GATEWAY, HOST], deadEndpoint(dead, w.fetchFn));
    const pins: Array<string | undefined> = [];
    const c = ctx(w, NOT_NEEDED, () => clock.t, {
      pinnedSolanaRpc: api,
      /* The controller contract: a corroborator identical to the pinned primary is not-needed,
         so the host-only continuity rule decides instead of a second look at itself. */
      independentPinnedSolanaRpc: (_net: string, primaryUrl: string | undefined) => {
        pins.push(primaryUrl);
        return primaryUrl === HOST
          ? NOT_NEEDED
          : { kind: "available", source: "host", client: hostApi(dropNode()).api };
      },
    });
    const evidence = ev();
    const t = tx();
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    expect(pins).toStrictEqual([HOST]);
    /* The identical claim now earns the streak a host-only configuration needs: three polls
       spanning more than one processing age. */
    clock.t += PROCESSING_AGE_MS;
    await expect(pollSolana(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 1;
    await expect(pollSolana(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
    expect(pins).toStrictEqual([HOST, HOST, HOST]);
  });

  it("a poll pinned on the gateway still corroborates on the host in one poll", async () => {
    const w = world();
    const host = hostApi(dropNode());
    const pins: Array<string | undefined> = [];
    const c = ctx(w, NOT_NEEDED, () => 1_000_000, {
      independentPinnedSolanaRpc: (_net: string, primaryUrl: string | undefined) => {
        pins.push(primaryUrl);
        return { kind: "available", source: "host", client: host.api };
      },
    });
    await expect(pollSolana(c, tx(), ev())).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
    expect(pins).toStrictEqual([GATEWAY]);
    expect(host.calls).toStrictEqual([
      "getEpochInfo",
      "isBlockhashValid",
      "getSignatureStatuses",
      "getFirstAvailableBlock",
      "getBlockTime",
    ]);
  });
});
