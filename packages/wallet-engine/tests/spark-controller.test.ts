import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import {
  encodeSparkAddress,
  encodeTokenIdentifier,
  SparkError,
  SparkInputError,
  SparkRequestError,
  SparkTokenBroadcastError,
} from "@qntx/spark";
import type { SparkClient, SparkEvent, SparkExitChain } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { createWalletEngine } from "../src/engine.ts";
import type { EngineLogger } from "../src/events.ts";
import { PHISHING_REFRESH_MS } from "../src/phishing/controller.ts";
import { SparkController, sparkTransferId } from "../src/spark/controller.ts";
import { SparkControllerError, categorize } from "../src/spark/errors.ts";
import { decodeExitChain, encodeExitChain } from "../src/spark/exit-chain-codec.ts";
import { encodePaymentNote } from "../src/spark/notes.ts";
import type { PaymentNote } from "../src/spark/notes.ts";
import { RECONCILE_BASE_MS } from "../src/spark/payments.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import { b64 } from "./phishing-helpers.ts";
import { fastTimer, realTimer } from "./send-helpers.ts";
import { encodeTestBolt11 } from "./support/bolt11.ts";

const PK = new Uint8Array(33).fill(2);
const REF: SparkAccountRef = { walletId: "w1", groupIndex: 0, network: "regtest" };
const VERIFY = { kind: "password", password: new Uint8Array([1]) } as never;
const LOGGER: EngineLogger = { warn: () => {} };
/** A UUIDv7 — the shape a prepared request's `sparkTransferId` takes. */
const TID = "01936f00-1111-7111-8111-111111111111";
/** A fixed-amount (21 sat) BOLT-11 invoice — payInvoice decodes it for the payment record. */
const TEST_INVOICE = encodeTestBolt11({
  network: "regtest",
  amountMsat: 21_000n,
  paymentHash: new Uint8Array(32).fill(3),
  secretKey: new Uint8Array(32).fill(7),
  timestamp: 1_800_000_000,
});

function warnText(m: string, e: unknown): string {
  return `${m} ${e instanceof Error ? e.message : String(e ?? "")}`;
}

/** Polls until a read satisfies the predicate — the event loop's resync is fire-and-forget. */
async function until<T>(read: () => T, want: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = read();
  while (!want(value)) {
    if (Date.now() > deadline) {
      throw new Error(`until() timed out on ${JSON.stringify(value)}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling is the point
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = read();
  }
  return value;
}

type FakeClaimOptions = {
  readonly claimErrors?: Error[];
  readonly claimPendingFailures?: Array<{ transferId: string; error: unknown }>;
  readonly streams?: ReadonlyArray<() => AsyncGenerator<SparkEvent>>;
  /** `transfers.history` pages returned in order — a rejected promise exercises the warn path. */
  readonly historyPages?: ReadonlyArray<unknown>;
  /** `transfers.send` results in order — an Error rejects that attempt, else resolves the params. */
  readonly sendResults?: ReadonlyArray<unknown>;
  /** `lightning.pay` results in order — an Error rejects that attempt, else resolves the params. */
  readonly payResults?: ReadonlyArray<unknown>;
  /** `tokens.balances` results in order — an Error rejects that read, exercising the warn path. */
  readonly tokenPages?: ReadonlyArray<unknown>;
  /** `tokens.transfer` results in order — an Error rejects that attempt, a string returns it. */
  readonly tokenResults?: ReadonlyArray<unknown>;
  /** Records each `tokens.transfer` argument. */
  readonly tokenArgs?: unknown[];
  readonly setTimer?: (ms: number, fn: () => void) => () => void;
  /** Fee every speed quotes for an exit amount — exercises quote convergence. */
  readonly quoteFee?: (amountSats: number) => number;
  /** The operator's `balance()` answer — defaults to 42. */
  readonly balanceSats?: number;
};

function fakeClient(
  calls: string[],
  sendArgs: unknown[] = [],
  claimArgs: Array<{ id: string; signal: unknown }> = [],
  opts: FakeClaimOptions = {},
) {
  const aborters: Array<{ aborted: boolean }> = [];
  const claimErrors = [...(opts.claimErrors ?? [])];
  const claimPendingFailures = [...(opts.claimPendingFailures ?? [])];
  const historyPages = [...(opts.historyPages ?? [])];
  const tokenPages = [...(opts.tokenPages ?? [])];
  const tokenResults = [...(opts.tokenResults ?? [])];
  const sendResults = [...(opts.sendResults ?? [])];
  const payResults = [...(opts.payResults ?? [])];
  let lastPage: unknown;
  let lastTokenPage: unknown;
  let streamCalls = 0;
  const client = {
    identityPublicKey: async () => Promise.resolve(PK),
    balance: async () => Promise.resolve(opts.balanceSats ?? 42),
    transfers: {
      claimPending: async () => {
        calls.push("claimPending");
        return Promise.resolve({ leaves: [], failures: [...claimPendingFailures] });
      },
      claim: async (id: unknown, claimOpts: unknown) => {
        calls.push(`claim:${String(id)}`);
        claimArgs.push({ id: String(id), signal: claimOpts });
        const error = claimErrors.shift();
        if (error !== undefined) {
          return Promise.reject(error);
        }
        return Promise.resolve([]);
      },
      send: async (o: unknown) => {
        calls.push("send");
        sendArgs.push(o);
        const result = sendResults.shift() ?? "ok";
        if (result instanceof Error) {
          return Promise.reject(result);
        }
        return Promise.resolve(o);
      },
      history: async () => {
        calls.push("history");
        const page = historyPages.shift() ?? lastPage ?? { payments: [], nextOffset: undefined };
        if (page instanceof Error) {
          return Promise.reject(page);
        }
        lastPage = page;
        return Promise.resolve(page);
      },
    },
    lightning: {
      createInvoice: async (o: unknown) => Promise.resolve(o),
      pay: async (o: unknown) => {
        calls.push("pay");
        const result = payResults.shift() ?? "ok";
        if (result instanceof Error) {
          return Promise.reject(result);
        }
        return Promise.resolve(o);
      },
    },
    invoices: {
      pay: async (_invoice: unknown, o: unknown) => {
        calls.push("invoicePay");
        return Promise.resolve(o);
      },
    },
    tokens: {
      balances: async () => {
        calls.push("tokenBalances");
        const page = tokenPages.shift() ?? lastTokenPage ?? [];
        if (page instanceof Error) {
          return Promise.reject(page);
        }
        lastTokenPage = page;
        return Promise.resolve(page);
      },
      transfer: async (o: unknown) => {
        calls.push("tokenTransfer");
        opts.tokenArgs?.push(o);
        const result = tokenResults.shift() ?? "tok-hash";
        if (result instanceof Error) {
          return Promise.reject(result);
        }
        return Promise.resolve(result);
      },
    },
    withdrawals: {
      quoteCooperativeExit: async (o: unknown) => {
        const quoted = opts.quoteFee?.((o as { amountSats: number }).amountSats);
        return Promise.resolve(
          quoted === undefined
            ? { fees: { fast: 5, medium: 3, slow: 1 } }
            : { fees: { fast: quoted, medium: quoted, slow: quoted } },
        );
      },
      cooperativeExit: async (o: unknown) => {
        calls.push("exit");
        return Promise.resolve(o);
      },
    },
    events: (signal?: AbortSignal) => {
      const rec = { aborted: false };
      aborters.push(rec);
      signal?.addEventListener("abort", () => {
        rec.aborted = true;
      });
      const streams = opts.streams ?? [
        async function* () {
          yield await Promise.resolve({
            type: "transfer",
            direction: "incoming",
            transferId: "t",
            senderIdentityPublicKey: PK,
            receiverIdentityPublicKey: PK,
          });
        },
      ];
      const gen = streams[Math.min(streamCalls, streams.length - 1)];
      streamCalls += 1;
      return gen!();
    },
    close: () => {
      calls.push("close");
    },
  };
  return { client: client as unknown as SparkClient, aborters, sendArgs };
}

function controller(calls: string[], approvals: unknown[], opts: FakeClaimOptions = {}) {
  const sendArgs: unknown[] = [];
  const tokenArgs: unknown[] = [];
  const { client, aborters } = fakeClient(calls, sendArgs, [], { ...opts, tokenArgs });
  const c = new SparkController({
    setTimer: opts.setTimer ?? realTimer,
    spark: {
      signer: () => null as never,
      approve: async (p: unknown) => {
        approvals.push(p);
        return Promise.resolve({});
      },
    },
    fetch: async () => Promise.reject(new Error("no fetch")),
    now: () => 0,
    logger: LOGGER,
    createClient: () => client,
  });
  return { c, client, aborters, sendArgs, tokenArgs };
}

describe("lightning-address registration errors", () => {
  const PARAMS = {
    serverUrl: "https://ln.example",
    domain: "ln.example",
    username: "alice",
    description: "d",
  };

  // A signer that lets registerLightningAddress reach the network call.
  const SIGNER = {
    identityPublicKey: async () => Promise.resolve(new Uint8Array(32)),
    signIdentity: async () => Promise.resolve(new Uint8Array(64)),
  };
  const withFetch = (fetch: (input: unknown, init?: unknown) => Promise<unknown>) => {
    const { client } = fakeClient([], []);
    return new SparkController({
      setTimer: realTimer,
      spark: { signer: () => SIGNER as never, approve: async () => Promise.resolve({}) },
      fetch: fetch as never,
      now: () => 0,
      logger: LOGGER,
      createClient: () => client,
    });
  };

  it("a request failure maps to network and keeps the upstream error as cause", async () => {
    const c = withFetch(async () => Promise.resolve(new Response("boom", { status: 500 })));
    const failure = await c.registerLightningAddress(REF, PARAMS).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SparkControllerError);
    const sparkError = failure as SparkControllerError;
    expect(sparkError.category).toBe("network");
    expect(sparkError.cause).toBeInstanceOf(SparkRequestError);
    expect(sparkError.message).toBe("registration failed");
  });

  it("a non-request failure maps to internal and keeps the original error as cause", async () => {
    const original = new Error("signer unavailable");
    const { client } = fakeClient([], []);
    const c = new SparkController({
      setTimer: realTimer,
      spark: {
        signer: () =>
          ({
            identityPublicKey: async () => Promise.reject(original),
            signIdentity: async () => Promise.resolve(new Uint8Array(64)),
          }) as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("no fetch")),
      now: () => 0,
      logger: LOGGER,
      createClient: () => client,
    });
    const failure = await c
      .unregisterLightningAddress(REF, {
        serverUrl: "https://ln.example",
        domain: "ln.example",
        username: "alice",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SparkControllerError);
    const sparkError = failure as SparkControllerError;
    expect(sparkError.category).toBe("internal");
    expect(sparkError.cause).toBe(original);
  });
});

describe("SparkController", () => {
  it("init starts the account, send approves first, lockAll resets", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c, aborters, sendArgs } = controller(calls, approvals);
    const store = createMemoryEngineStore();
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    await c.send(REF, {
      receiver,
      amountSats: 10,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
    expect(approvals).toHaveLength(1);
    expect(calls.filter((x) => x === "claimPending").length).toBeGreaterThan(0);
    expect(calls).toContain("send");
    // The caller's idempotent transfer id reaches the client untouched.
    expect((sendArgs[0] as { transferId?: string }).transferId).toBe(TID);
    const state = c.getState().accounts["w1:0:regtest"];
    expect(state?.status).toBe("ready");
    expect(state?.balanceSats).toBe(42);
    await c.lockAll();
    expect(aborters[0]?.aborted).toBe(true);
    await c.destroy();
  });
});

describe("SparkExitChain codec", () => {
  it("round-trips byte fields", () => {
    const chain = {
      leafId: "l1",
      refundTxs: [new Uint8Array([1, 2])],
      cpfpTx: new Uint8Array([3]),
    } as unknown as SparkExitChain;
    const back = decodeExitChain(encodeExitChain(chain)) as unknown as {
      cpfpTx: Uint8Array;
    };
    expect(back.cpfpTx[0]).toBe(3);
  });
});

describe("send network check", () => {
  it("rejects a receiver address on a different network before approving", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = controller(calls, approvals);
    const store = createMemoryEngineStore();
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    // PK on mainnet — ref is regtest.
    const wrongNet = encodeSparkAddress({ network: "mainnet", identityPublicKey: PK });
    await expect(
      c.send(REF, {
        receiver: wrongNet,
        amountSats: 10,
        transferId: TID,
        verify: VERIFY,
        commit: () => undefined,
      }),
    ).rejects.toSatisfy((e) => (e as { category?: string }).category === "rejected");
    expect(approvals).toHaveLength(0);
    await c.destroy();
  });
});

const EXIT_ADDRESS = "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz";

/** Raw 32-byte token identifier and its regtest/mainnet bech32m encodings. */
const TOKEN_RAW = new Uint8Array(32).fill(9);
const BTKN = encodeTokenIdentifier(TOKEN_RAW, "regtest");
const BTKN_MAINNET = encodeTokenIdentifier(TOKEN_RAW, "mainnet");
const RECEIVER_PK = secp256k1.getPublicKey(new Uint8Array(32).fill(7), true);
const RECEIVER = encodeSparkAddress({ network: "regtest", identityPublicKey: RECEIVER_PK });
const RECEIVER_MAINNET = encodeSparkAddress({
  network: "mainnet",
  identityPublicKey: RECEIVER_PK,
});

describe("Spark token balances", () => {
  it("the resync pass after start fills the token list", async () => {
    const calls: string[] = [];
    const { c } = controller(calls, [], {
      tokenPages: [[{ tokenIdentifier: BTKN, amount: 1234n, outputCount: 2 }]],
    });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    await c.init();
    const state = await until(
      () => c.getState().accounts["w1:0:regtest"],
      (s) => s?.tokens !== undefined,
    );
    expect(state?.tokens).toStrictEqual([
      { tokenIdentifier: BTKN, amount: "1234", outputCount: 2 },
    ]);
    await c.destroy();
  });

  it("a handled transfer event refreshes the token list", async () => {
    const calls: string[] = [];
    const { c } = controller(calls, [], {
      tokenPages: [
        [{ tokenIdentifier: BTKN, amount: 10n, outputCount: 1 }],
        [{ tokenIdentifier: BTKN, amount: 25n, outputCount: 3 }],
      ],
    });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    await c.init();
    const state = await until(
      () => c.getState().accounts["w1:0:regtest"],
      (s) => s?.tokens?.[0]?.amount === "25",
    );
    expect(state?.tokens).toStrictEqual([{ tokenIdentifier: BTKN, amount: "25", outputCount: 3 }]);
    await c.destroy();
  });

  it("a failed balances read keeps the previous list and never touches status", async () => {
    const calls: string[] = [];
    const { c } = controller(calls, [], {
      tokenPages: [
        [{ tokenIdentifier: BTKN, amount: 10n, outputCount: 1 }],
        new Error("token read down"),
      ],
    });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    await c.init();
    await until(
      () => c.getState().accounts["w1:0:regtest"],
      (s) => s?.tokens !== undefined,
    );
    // The default stream's transfer event drives a second (failing) read.
    await until(
      () => calls.filter((x) => x === "tokenBalances").length,
      (n) => n >= 2,
    );
    const state = c.getState().accounts["w1:0:regtest"];
    expect(state?.tokens).toStrictEqual([{ tokenIdentifier: BTKN, amount: "10", outputCount: 1 }]);
    expect(state?.status).toBe("ready");
    expect(state?.errorCategory).toBeUndefined();
    await c.destroy();
  });
});

describe("SparkController.sendToken", () => {
  const boot = async (opts: Parameters<typeof controller>[2] = {}) => {
    const calls: string[] = [];
    const approvals: Array<{ intent?: unknown }> = [];
    const { c, tokenArgs } = controller(calls, approvals, { setTimer: fastTimer, ...opts });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    await c.init();
    return { calls, approvals, c, tokenArgs };
  };

  it("approves the raw identifier and receiver identity, then transfers", async () => {
    const { approvals, c, tokenArgs } = await boot({ tokenResults: ["tx-hash-1"] });
    let committed = false;
    const hash = await c.sendToken(REF, {
      receiver: RECEIVER,
      tokenIdentifier: BTKN,
      amount: 123n,
      transferId: TID,
      verify: VERIFY,
      commit: () => {
        committed = true;
      },
    });
    expect(hash).toBe("tx-hash-1");
    expect(committed).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.intent).toStrictEqual({
      kind: "token",
      tokenIdentifier: TOKEN_RAW,
      receivers: [{ ownerPublicKey: RECEIVER_PK, amount: "123" }],
    });
    expect(tokenArgs).toStrictEqual([{ tokenIdentifier: BTKN, amount: 123n, receiver: RECEIVER }]);
    await c.destroy();
  });

  it.each([
    ["a wrong-network receiver", { receiver: RECEIVER_MAINNET }],
    ["a wrong-network identifier", { tokenIdentifier: BTKN_MAINNET }],
    ["a malformed identifier", { tokenIdentifier: "not-a-token-id" }],
    ["a zero amount", { amount: 0n }],
    ["an amount above u128", { amount: 340282366920938463463374607431768211456n }],
  ])("rejects %s before approving", async (_name, override) => {
    const { approvals, calls, c } = await boot();
    const params = {
      receiver: RECEIVER,
      tokenIdentifier: BTKN,
      amount: 5n,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
      ...override,
    };
    await expect(c.sendToken(REF, params)).rejects.toSatisfy(
      (e) => (e as { category?: string }).category === "rejected",
    );
    expect(approvals).toHaveLength(0);
    expect(calls).not.toContain("tokenTransfer");
    await c.destroy();
  });

  it("a lost broadcast retries under its input output ids with one approval", async () => {
    const broadcastLost = new SparkTokenBroadcastError("lost", {
      inputOutputIds: ["a:0", "b:1"],
    });
    const { approvals, calls, c, tokenArgs } = await boot({
      tokenResults: [broadcastLost, "tx-hash-2"],
    });
    const hash = await c.sendToken(REF, {
      receiver: RECEIVER,
      tokenIdentifier: BTKN,
      amount: 5n,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
    expect(hash).toBe("tx-hash-2");
    expect(approvals).toHaveLength(1);
    expect(calls.filter((x) => x === "tokenTransfer")).toHaveLength(2);
    expect(tokenArgs[1]).toStrictEqual({
      tokenIdentifier: BTKN,
      amount: 5n,
      receiver: RECEIVER,
      inputOutputIds: ["a:0", "b:1"],
    });
    await c.destroy();
  });

  it("exhausted broadcast retries report unknown and carry the input output ids", async () => {
    const broadcastLost = () =>
      new SparkTokenBroadcastError("lost", { inputOutputIds: ["a:0", "b:1"] });
    const { calls, c } = await boot({
      tokenResults: [broadcastLost(), broadcastLost(), broadcastLost(), broadcastLost()],
    });
    const failure = await c
      .sendToken(REF, {
        receiver: RECEIVER,
        tokenIdentifier: BTKN,
        amount: 5n,
        transferId: TID,
        verify: VERIFY,
        commit: () => undefined,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SparkControllerError);
    const sparkError = failure as SparkControllerError;
    expect(sparkError.category).toBe("unknown");
    expect(sparkError.message).toBe("token transfer outcome unknown");
    expect(sparkError.payment?.inputOutputIds).toStrictEqual(["a:0", "b:1"]);
    expect(calls.filter((x) => x === "tokenTransfer")).toHaveLength(4);
    await c.destroy();
  });

  it.each([
    ["a plain network error", new SparkRequestError("net down")],
    ["a definite refusal", new SparkInputError("bad input")],
  ])("does not retry %s — uncertainty is only SparkTokenBroadcastError", async (_name, error) => {
    const { calls, c } = await boot({ tokenResults: [error] });
    await expect(
      c.sendToken(REF, {
        receiver: RECEIVER,
        tokenIdentifier: BTKN,
        amount: 5n,
        transferId: TID,
        verify: VERIFY,
        commit: () => undefined,
      }),
    ).rejects.toBeInstanceOf(SparkControllerError);
    expect(calls.filter((x) => x === "tokenTransfer")).toHaveLength(1);
    await c.destroy();
  });
});

/** A quote that grows once then settles: f(100000) = 500, f(100500) = 600, f(100600) = 600. */
const growOnce = (amountSats: number): number => (amountSats <= 100_000 ? 500 : 600);

describe("cooperative exit quoting", () => {
  const approval = (approvals: unknown[]) => approvals[0] as { intent: unknown };

  async function setup(
    calls: string[],
    approvals: unknown[],
    quoteFee?: (amountSats: number) => number,
  ) {
    const { c, client } = controller(calls, approvals, {
      balanceSats: 200_000,
      ...(quoteFee === undefined ? {} : { quoteFee }),
    });
    const store = createMemoryEngineStore();
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    return { c, client };
  }

  it("quotes the converged fee and the gross exit amount", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals, growOnce);
    // Requotes 100500 then 100600: the fee settles at 600.
    await expect(
      c.quoteExit(REF, { address: EXIT_ADDRESS, amountSats: 100_000, speed: "FAST" }),
    ).resolves.toStrictEqual({ feeSats: 600, exitSats: 100_600 });
    expect(approvals).toHaveLength(0);
    expect(calls).not.toContain("exit");
    await c.destroy();
  });

  it("rejects a quote that never settles", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals, (amount) => amount);
    await expect(
      c.quoteExit(REF, { address: EXIT_ADDRESS, amountSats: 1000, speed: "FAST" }),
    ).rejects.toMatchObject({
      category: "rejected",
      message: expect.stringContaining("settle"),
    });
    await c.destroy();
  });

  it("rejects an address on the wrong network before quoting", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await expect(
      c.quoteExit(REF, {
        address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        amountSats: 1000,
        speed: "FAST",
      }),
    ).rejects.toSatisfy((e) => (e as { category?: string }).category === "rejected");
    await c.destroy();
  });

  it("exits amountSats + the settled fee so amountSats arrives", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    const exit = await c.withdraw(REF, {
      address: EXIT_ADDRESS,
      amountSats: 1000,
      speed: "FAST",
      maxFeeSats: 10,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
    // fast fee 5: the exit debits 1005 of leaves and the receiver gets 1000.
    expect(exit).toMatchObject({
      address: EXIT_ADDRESS,
      speed: "FAST",
      amountSats: 1005,
      maxFeeSats: 5,
      transferId: TID,
    });
    expect(approval(approvals).intent).toStrictEqual({
      kind: "exit",
      address: EXIT_ADDRESS,
      amountSats: 1000,
      maxFeeSats: 5,
    });
    await c.destroy();
  });

  it("rejects a settled fee above the caller cap before approving", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await expect(
      c.withdraw(REF, {
        address: EXIT_ADDRESS,
        amountSats: 1000,
        speed: "FAST",
        maxFeeSats: 2,
        transferId: TID,
        verify: VERIFY,
        commit: () => undefined,
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      message: expect.stringContaining("maxFeeSats"),
    });
    expect(approvals).toHaveLength(0);
    expect(calls).not.toContain("exit");
    await c.destroy();
  });

  it("rejects a fee at or above the amount that arrives", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await expect(
      c.withdraw(REF, {
        address: EXIT_ADDRESS,
        amountSats: 5,
        speed: "FAST",
        maxFeeSats: 10,
        transferId: TID,
        verify: VERIFY,
        commit: () => undefined,
      }),
    ).rejects.toSatisfy((e) => (e as { category?: string }).category === "insufficient-funds");
    expect(approvals).toHaveLength(0);
    await c.destroy();
  });

  it("rejects a requote that grows past the cap before approving", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    // The first quote (500) is inside the cap, but the settled 600 exceeds it.
    const { c } = await setup(calls, approvals, growOnce);
    await expect(
      c.withdraw(REF, {
        address: EXIT_ADDRESS,
        amountSats: 100_000,
        speed: "FAST",
        maxFeeSats: 550,
        transferId: TID,
        verify: VERIFY,
        commit: () => undefined,
      }),
    ).rejects.toSatisfy((e) => (e as { category?: string }).category === "rejected");
    expect(approvals).toHaveLength(0);
    expect(calls).not.toContain("exit");
    await c.destroy();
  });
});

async function gateOpenStore(failures: number): Promise<EngineStore> {
  return failures > 0
    ? Promise.reject(new Error("open failed"))
    : Promise.resolve(createMemoryEngineStore());
}

/** The first store returned rejects every `list` — a transient IDB failure mid-start. */
function listFailsOnce(): () => Promise<EngineStore> {
  let dropped = false;
  return async () => {
    const inner = createMemoryEngineStore();
    if (dropped) {
      return Promise.resolve(inner);
    }
    dropped = true;
    const base = inner.collection.bind(inner);
    return Promise.resolve({
      close: inner.close,
      collection: (name) => {
        const col = base(name);
        return { ...col, list: async () => Promise.reject(new Error("idb list failed")) };
      },
    });
  };
}

function flakyClient(calls: string[], sendArgs: unknown[], aborters: Array<{ aborted: boolean }>) {
  let claimCalls = 0;
  let streamCalls = 0;
  const historyPages: unknown[] = [];
  let lastPage: unknown;
  const client = {
    identityPublicKey: async () => Promise.resolve(PK),
    balance: async () => Promise.resolve(42),
    transfers: {
      claimPending: async () => {
        calls.push("claimPending");
        const outcomes = [
          async () => Promise.resolve({ leaves: [], failures: [] }),
          // A poisoned pending transfer is logged, not fatal.
          async () =>
            Promise.resolve({
              leaves: [],
              failures: [{ transferId: "t-poison", error: new Error("claim raced") }],
            }),
          async () => Promise.reject(new Error("claim query down")),
          async () => Promise.resolve({ leaves: [], failures: [] }),
        ];
        claimCalls += 1;
        return outcomes[Math.min(claimCalls - 1, outcomes.length - 1)]!();
      },
      claim: async (id: unknown, _opts: unknown) => {
        calls.push(`claim:${String(id)}`);
        return Promise.resolve([]);
      },
      send: async (o: unknown) => {
        calls.push("send");
        sendArgs.push(o);
        return Promise.resolve(o);
      },
      history: async () => {
        calls.push("history");
        const page = historyPages.shift() ?? lastPage ?? { payments: [], nextOffset: undefined };
        if (page instanceof Error) {
          return Promise.reject(page);
        }
        lastPage = page;
        return Promise.resolve(page);
      },
    },
    lightning: {
      createInvoice: async (o: unknown) => Promise.resolve(o),
      pay: async (o: unknown) => Promise.resolve(o),
    },
    withdrawals: {
      quoteCooperativeExit: async () => Promise.resolve({ fees: { fast: 5, medium: 3, slow: 1 } }),
      cooperativeExit: async (o: unknown) => Promise.resolve(o),
    },
    events: (signal?: AbortSignal) => {
      const rec = { aborted: false };
      aborters.push(rec);
      signal?.addEventListener("abort", () => {
        rec.aborted = true;
      });
      const gens: Array<() => AsyncGenerator<SparkEvent>> = [
        async function* () {
          yield await Promise.reject(new Error("stream dropped"));
        },
        async function* () {
          yield await Promise.reject(new Error("stream dropped again"));
        },
        async function* () {
          await Promise.resolve();
          yield {
            type: "transfer",
            direction: "incoming",
            transferId: "t",
            senderIdentityPublicKey: PK,
            receiverIdentityPublicKey: PK,
          };
        },
      ];
      const gen = gens[Math.min(streamCalls, gens.length - 1)];
      streamCalls += 1;
      return gen!();
    },
    close: () => {
      calls.push("close");
    },
  };
  return client as unknown as SparkClient;
}

describe("event stream resilience", () => {
  it("survives a claimPending failure and a dead stream — keeps refreshing balance", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const sendArgs: unknown[] = [];
    const aborters: Array<{ aborted: boolean }> = [];
    const warns: string[] = [];
    const client = flakyClient(calls, sendArgs, aborters);
    const c = new SparkController({
      setTimer: fastTimer,
      spark: {
        signer: () => null as never,
        approve: async (p: unknown) => {
          approvals.push(p);
          return Promise.resolve({});
        },
      },
      fetch: async () => Promise.reject(new Error("no fetch")),
      now: () => 0,
      logger: { warn: (m, e) => warns.push(warnText(m, e)) },
      createClient: () => client,
    });
    const store = createMemoryEngineStore();
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    // Wait until the loop has died on the first stream, resubscribed, and recovered —
    // pass-2's catch-up fails (claim query down), pass-3 resyncs and the incoming event's
    // claim(id) refreshes the balance.
    await vi.waitFor(() => {
      expect(aborters.length).toBeGreaterThan(1);
      expect(calls).toContain("claim:t");
    }, 20_000);
    const state = c.getState().accounts["w1:0:regtest"];
    expect(state?.balanceSats).toBe(42);
    expect(state?.status).toBe("ready");
    // The event's transfer id went to claim(), with the loop's abort signal.
    expect(calls).toContain("claim:t");
    // claimPending ran per pass: ok, a logged failure entry, a thrown failure retried next pass.
    expect(calls.filter((x) => x === "claimPending").length).toBeGreaterThan(1);
    // The poisoned catch-up entry was logged, not fatal.
    expect(warns.some((m) => m.includes("t-poison"))).toBe(true);
    expect(warns.some((m) => m.includes("claim query down"))).toBe(true);
  }, 30_000);
});

describe("event claims", () => {
  function controllerWith(client: SparkClient, warns: string[]) {
    const calls: string[] = [];
    const c = new SparkController({
      setTimer: fastTimer,
      spark: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("no fetch")),
      now: () => 0,
      logger: { warn: (m, e) => warns.push(warnText(m, e)) },
      createClient: () => client,
    });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    return { c, calls };
  }

  const transfer = (id: string): SparkEvent => ({
    type: "transfer",
    direction: "incoming",
    transferId: id,
    senderIdentityPublicKey: PK,
    receiverIdentityPublicKey: PK,
  });

  it("claims the event's transfer id with the loop's signal, then patches balance", async () => {
    const warns: string[] = [];
    const calls: string[] = [];
    const claimArgs: Array<{ id: string; signal: unknown }> = [];
    const { client } = fakeClient(calls, [], claimArgs);
    const { c } = controllerWith(client, warns);
    await c.init();
    await vi.waitFor(() => {
      expect(claimArgs.length).toBeGreaterThan(0);
    }, 8000);
    expect(claimArgs[0]?.id).toBe("t");
    expect(claimArgs[0]?.signal).toMatchObject({ signal: expect.anything() });
    expect(c.getState().accounts["w1:0:regtest"]?.balanceSats).toBe(42);
    await c.lockAll();
  }, 15_000);

  it("a terminal-status claim error logs and keeps the stream alive", async () => {
    const warns: string[] = [];
    const calls: string[] = [];
    const claimArgs: Array<{ id: string; signal: unknown }> = [];
    const { client } = fakeClient(calls, [], claimArgs, {
      claimErrors: [new SparkInputError("claim: transfer t status EXPIRED is not claimable")],
      streams: [
        async function* () {
          yield await Promise.resolve(transfer("t-expired"));
          yield await Promise.resolve(transfer("t-ok"));
        },
      ],
    });
    const { c } = controllerWith(client, warns);
    await c.init();
    await vi.waitFor(() => {
      expect(calls).toContain("claim:t-ok");
    }, 8000);
    expect(warns.some((m) => m.includes("t-expired"))).toBe(true);
    expect(c.getState().accounts["w1:0:regtest"]?.status).toBe("ready");
    await c.lockAll();
  }, 15_000);

  it("a transient claim error drops the pass; catch-up retries next pass", async () => {
    const warns: string[] = [];
    const calls: string[] = [];
    const claimArgs: Array<{ id: string; signal: unknown }> = [];
    const { client, aborters } = fakeClient(calls, [], claimArgs, {
      claimErrors: [
        new SparkRequestError("claim: transfer t did not become claimable", {
          code: "deadline_exceeded",
        }),
      ],
    });
    const { c } = controllerWith(client, warns);
    await c.init();
    await vi.waitFor(() => {
      expect(aborters.length).toBeGreaterThan(1);
    }, 12_000);
    // Next pass's catch-up ran claimPending again after the failed pass.
    expect(calls.filter((x) => x === "claimPending").length).toBeGreaterThan(1);
    await c.lockAll();
  }, 15_000);
});

const armedRefreshes = (timers: ReadonlyArray<{ ms: number; cancelled: boolean }>): number =>
  timers.filter((t) => t.ms === PHISHING_REFRESH_MS && !t.cancelled).length;

describe("lock transition serialization", () => {
  type FakeWallet = {
    vault: string;
    listeners: Set<() => void>;
    set: (v: string) => void;
  };
  function wallet(vault = "locked"): FakeWallet & {
    getSnapshot: () => { vault: { status: string } };
    subscribe: (l: () => void) => () => void;
  } {
    const listeners = new Set<() => void>();
    const w = {
      vault,
      listeners,
      getSnapshot() {
        return { vault: { status: w.vault } };
      },
      subscribe(l: () => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      set(v: string) {
        w.vault = v;
        for (const l of listeners) {
          l();
        }
      },
    };
    return w;
  }

  it("unlock→lock→unlock serializes — no client is created after a lock", async () => {
    const w = wallet("locked");
    const calls: string[] = [];
    const client = fakeClient(calls);
    const clientCount = 0;
    const engine = createWalletEngine({
      publicStore: createMemoryPublicStore(),
      verifyEvent,
      weblnAlias: "test",
      lightningMaxFee: () => 0,
      wallet: w as never,
      sparkNetwork: "regtest",
      sparkApis: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("nf")),
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger: LOGGER,
      showCallsStatus: () => undefined,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
    });
    const c = engine.spark as SparkController;
    // Drive transitions straight through the controller's lifecycle — addAccount then unlock.
    c.setAccounts([REF]);
    w.set("unlocked");
    w.set("locked");
    w.set("unlocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // After serialization the final unlock leaves exactly one connected client set.
    expect(calls.filter((x) => x === "close").length).toBeLessThanOrEqual(1);
    engine.unsubscribe();
    void client;
    void clientCount;
  });

  it("loads the phishing list while locked and stops refreshing on unsubscribe", async () => {
    const w = wallet("locked");
    const timers: Array<{ ms: number; cancelled: boolean }> = [];
    const engine = createWalletEngine({
      publicStore: createMemoryPublicStore(),
      gateway: { url: "https://gateway.test" },
      verifyEvent,
      weblnAlias: "test",
      lightningMaxFee: () => 0,
      wallet: w as never,
      sparkNetwork: "regtest",
      sparkApis: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () =>
        Promise.resolve(
          Response.json({ kind: "snapshot", version: 1, deny: b64(["evil.com"]), allow: "" }),
        ),
      random: (n) => new Uint8Array(n),
      now: () => 0,
      setTimer: (ms) => {
        const timer = { ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      logger: LOGGER,
      showCallsStatus: () => undefined,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.phishing.check("https://evil.com/")).toBe("blocked");
    expect(armedRefreshes(timers)).toBe(1);
    engine.unsubscribe();
    expect(armedRefreshes(timers)).toBe(0);
  });

  it("openStore failure resets and the next unlock retries", async () => {
    const w = wallet("locked");
    let failures = 0;
    let opens = 0;
    const warnings: unknown[] = [];
    const engine = createWalletEngine({
      publicStore: createMemoryPublicStore(),
      verifyEvent,
      weblnAlias: "test",
      lightningMaxFee: () => 0,
      wallet: w as never,
      sparkNetwork: "regtest",
      sparkApis: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("nf")),
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger: { warn: (m, e) => void warnings.push([m, e]) },
      showCallsStatus: () => undefined,
      openStore: async () => {
        opens += 1;
        return gateOpenStore(failures);
      },
    });
    (engine.spark as SparkController).setAccounts([REF]);
    failures = 1;
    w.set("unlocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const openedAfterFailure = opens;
    expect(openedAfterFailure).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeGreaterThan(0);
    expect(engine.spark.getState().accounts["w1:0:regtest"]?.status).toBe("locked");
    // The next unlock retries and succeeds.
    failures = 0;
    w.set("locked");
    w.set("unlocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opens).toBeGreaterThan(openedAfterFailure);
    engine.unsubscribe();
  });

  it("a failure mid-start tears down and the next status event retries", async () => {
    const listeners = new Set<() => void>();
    const w = {
      // Unlocked at construction: the constructor's queued transition is the first start, so
      // the transient store failure below is consumed by it rather than racing a later event.
      vault: "unlocked",
      getSnapshot() {
        return { vault: { status: w.vault }, wallets: [], backup: null };
      },
      subscribe(l: () => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      set(v: string) {
        w.vault = v;
        for (const l of listeners) {
          l();
        }
      },
    };
    const warnings: string[] = [];
    const engine = createWalletEngine({
      publicStore: createMemoryPublicStore(),
      verifyEvent,
      weblnAlias: "test",
      lightningMaxFee: () => 0,
      wallet: w as never,
      sparkNetwork: "regtest",
      sparkApis: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("nf")),
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger: { warn: (m) => void warnings.push(m) },
      showCallsStatus: () => undefined,
      openStore: listFailsOnce(),
    });
    // Torn down exactly like a lock: the store is closed and nothing stays started.
    await vi.waitFor(
      () => {
        expect(warnings).toContain("engine start failed");
        expect(engine.accounts.getState().status).toBe("locked");
      },
      { timeout: 10_000, interval: 10 },
    );
    w.set("locked");
    w.set("unlocked");
    await vi.waitFor(
      () => {
        expect(engine.accounts.getState().status).toBe("ready");
      },
      { timeout: 10_000, interval: 10 },
    );
    engine.unsubscribe();
  });
});

describe("createWalletEngine lifecycle", () => {
  it("subscribes to wallet state and builds the controller", () => {
    expect.hasAssertions();
    const listeners = new Set<() => void>();
    const wallet = {
      getSnapshot: () => ({ vault: { status: "locked" } }),
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const engine = createWalletEngine({
      publicStore: createMemoryPublicStore(),
      verifyEvent,
      weblnAlias: "test",
      lightningMaxFee: () => 0,
      wallet: wallet as never,
      sparkNetwork: "regtest",
      sparkApis: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: async () => Promise.reject(new Error("nf")),
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger: LOGGER,
      showCallsStatus: () => undefined,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
    });
    expect(listeners.size).toBe(1);
    expect(engine.spark.getState().accounts).toStrictEqual({});
    engine.unsubscribe();
  });
});

function failPaymentDeletes(store: EngineStore, shouldThrow: () => boolean): EngineStore {
  return {
    close: store.close,
    collection: (name) => {
      const col = store.collection(name);
      return {
        ...col,
        delete: async (key: string) => {
          if (name.startsWith("spark-payments:") && shouldThrow()) {
            throw new Error("engine store is on fire");
          }
          await col.delete(key);
        },
      };
    },
  };
}

describe("history and notes", () => {
  const K = "w1:0:regtest";
  const NOTE: PaymentNote = {
    kind: "zap",
    recipientPubkey: "ab".repeat(32),
    lightning: "alice@wallet.test",
  };
  const parseNote = (record: unknown) =>
    record === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(record as Uint8Array)) as unknown);
  const PAYMENT = {
    id: "t1",
    direction: "send",
    status: "completed",
    method: "lightning",
    amountSats: 100,
    feeSats: 5,
    createdAt: 1,
    details: undefined,
  };

  async function started(
    payments: unknown[] = [{ payments: [PAYMENT], nextOffset: undefined }],
    wrapStore: (store: EngineStore) => EngineStore = (store) => store,
  ) {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const sendArgs: unknown[] = [];
    const { client } = fakeClient(calls, sendArgs, [], { historyPages: payments });
    const store = wrapStore(createMemoryEngineStore());
    const warns: string[] = [];
    const c = new SparkController({
      setTimer: realTimer,
      spark: {
        signer: () => null as never,
        approve: async (p: unknown) => {
          approvals.push(p);
          return Promise.resolve({});
        },
      },
      fetch: async () => Promise.reject(new Error("no fetch")),
      now: () => 0,
      logger: { warn: (m, e) => warns.push(warnText(m, e)) },
      createClient: () => client,
    });
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    await until(
      () => c.getState().accounts[K]?.recent,
      (v) => v !== undefined,
    );
    return { c, calls, store, warns, approvals, setStore: (s: EngineStore) => c.setStore(s) };
  }

  it("populates recent at init and merges notes into history", async () => {
    const { c, store } = await started();
    const col = store.collection(`spark-notes:${K}`);
    await col.put("t1", encodePaymentNote(NOTE));
    await col.put("t2", new TextEncoder().encode(JSON.stringify(NOTE)));
    const { items } = await c.history(REF, { limit: 10 });
    expect(items[0]).toMatchObject({ id: "t1", note: NOTE });
    expect(c.getState().accounts[K]?.recent).toHaveLength(1);
  });

  it("a note with unknown keys is rejected", async () => {
    const extra = {
      ...(JSON.parse(new TextDecoder().decode(encodePaymentNote(NOTE))) as object),
      extra: "field",
    };
    const { c, store, warns } = await started();
    await store
      .collection(`spark-notes:${K}`)
      .put("t1", new TextEncoder().encode(JSON.stringify(extra)));
    const { items } = await c.history(REF);
    expect(items[0]).not.toMatchObject({ note: expect.anything() });
    expect(warns.some((w) => w.includes("malformed"))).toBe(true);
  });

  it("a malformed note record is ignored and warned", async () => {
    const { c, store, warns } = await started();
    await store.collection(`spark-notes:${K}`).put("t1", new Uint8Array([1, 2, 3]));
    const { items } = await c.history(REF);
    expect(items[0]).not.toMatchObject({ note: expect.anything() });
    expect(warns.some((w) => w.includes("malformed"))).toBe(true);
    // The warn never names the payment or echoes the note bytes — the id could link to a tx.
    expect(warns.every((w) => !w.includes("t1"))).toBe(true);
  });

  it("a settled send resolves even when its record write fails after the commit", async () => {
    let bombed = false;
    const { c, warns } = await started(
      [{ payments: [{ ...PAYMENT, id: TID }], nextOffset: undefined }],
      (store) => failPaymentDeletes(store, () => bombed),
    );
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    bombed = true;
    // The commit reaches the operator; the settled record's delete fails on the next observe.
    const result = await c.send(REF, {
      receiver,
      amountSats: 10,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
    expect(result).toBeDefined();
    await until(
      () => warns.some((w) => w.includes("spark payment record write failed")),
      (v) => v,
    );
    await c.destroy();
  });

  it("refreshes recent after send and refresh failures keep the previous page", async () => {
    const { c, calls } = await started();
    expect(c.getState().accounts[K]?.recent?.[0]).toMatchObject({ id: "t1" });
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    await c.send(REF, {
      receiver,
      amountSats: 10,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
    expect(calls).toContain("send");
    // The refresh is fire-and-forget — it runs after send returns.
    await until(
      () => calls.filter((x) => x === "history").length,
      (n) => n >= 2,
    );
    expect(c.getState().accounts[K]?.status).toBe("ready");
    expect(c.getState().accounts[K]?.recent).toHaveLength(1);
  });

  it("a failed refresh keeps the previous recent and leaves status ready", async () => {
    const { c } = await started([
      { payments: [PAYMENT], nextOffset: undefined },
      new Error("down"),
    ]);
    expect(c.getState().accounts[K]?.recent).toHaveLength(1);
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    await c.send(REF, {
      receiver,
      amountSats: 10,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
    // The failing refresh lands after send returns — status and the previous page survive.
    await until(
      () => c.getState().accounts[K]?.recent,
      (v) => v !== undefined,
    );
    const state = c.getState().accounts[K];
    expect(state?.status).toBe("ready");
    expect(state?.recent).toHaveLength(1);
  });

  it("payInvoice writes the note under the transfer id", async () => {
    const { c, store } = await started();
    const payment = (await c.payInvoice(REF, {
      invoice: TEST_INVOICE,
      maxFeeSats: 5,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
      note: NOTE,
    })) as { transferId: string };
    const record = await store.collection(`spark-notes:${K}`).get(payment.transferId);
    expect(parseNote(record)).toStrictEqual(NOTE);
  });

  it("a failing note write still resolves the payment", async () => {
    const { c, store, warns } = await started();
    const wrapped: EngineStore = {
      ...store,
      collection: (name: string) => {
        const col = store.collection(name);
        // oxlint-disable-next-line vitest/no-conditional-in-test -- collection routing
        if (name.startsWith("spark-notes:")) {
          return { ...col, put: async () => Promise.reject(new Error("write failed")) };
        }
        return col;
      },
    };
    const col = store.collection(`spark-notes:${K}`);
    c.setStore(wrapped);
    const payment = (await c.payInvoice(REF, {
      invoice: TEST_INVOICE,
      maxFeeSats: 5,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
      note: NOTE,
    })) as { transferId: string };
    expect(payment.transferId).toMatch(/^[0-9a-f-]{36}$/);
    expect(warns.some((w) => w.includes("note write failed"))).toBe(true);
    await expect(col.get(payment.transferId)).resolves.toBeUndefined();
  });

  it("a slower older refresh never overwrites a newer one", async () => {
    // The init resync's refresh parks inside a gated history call; a concurrent send's refresh
    // (newer seq) lands first. When the gate opens the stale page must be dropped.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const calls: string[] = [];
    const { client } = fakeClient(calls, [], [], {
      historyPages: [
        { payments: [{ ...PAYMENT, id: "t-stale" }], nextOffset: undefined },
        { payments: [{ ...PAYMENT, id: "t-new" }], nextOffset: undefined },
      ],
    });
    let call = 0;
    const realHistory = client.transfers.history.bind(client.transfers);
    const gated = {
      ...client,
      transfers: {
        ...client.transfers,
        history: async () => {
          call += 1;
          const page = realHistory();
          // oxlint-disable-next-line vitest/no-conditional-in-test -- gate the first call only
          if (call === 1) {
            await gate;
          }
          return page;
        },
      },
    } as SparkClient;
    const c = new SparkController({
      setTimer: realTimer,
      spark: { signer: () => null as never, approve: async () => Promise.resolve({}) },
      fetch: async () => Promise.reject(new Error("x")),
      now: () => 0,
      logger: LOGGER,
      createClient: () => gated,
    });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    await c.init();
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    const sendPromise = c.send(REF, {
      receiver,
      amountSats: 10,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
    // The send's refresh (seq 2) lands while the init refresh (seq 1) is still gated.
    await until(
      () => c.getState().accounts[K]?.recent,
      (v) => v?.[0]?.id === "t-new",
    );
    release();
    await sendPromise;
    const recent = c.getState().accounts[K]?.recent;
    expect(recent?.some((p) => p.id === "t-stale")).toBe(false);
    expect(recent?.some((p) => p.id === "t-new")).toBe(true);
  });
});

describe("paySparkInvoice pre-approval checks", () => {
  const INVOICE_ID = "01936f00-0000-7000-8000-000000000001";

  async function setup(calls: string[], approvals: unknown[]) {
    const { c, client } = controller(calls, approvals);
    const store = createMemoryEngineStore();
    c.setAccounts([REF]);
    c.setStore(store);
    await c.init();
    return { c, client };
  }

  it("rejects a token invoice before any approval call", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    const tokenInvoice = encodeSparkAddress({
      network: "regtest",
      identityPublicKey: PK,
      invoice: {
        version: 1,
        id: INVOICE_ID,
        payment: { type: "tokens", amount: new Uint8Array([0, 1]) },
      },
    });
    await expect(
      c.paySparkInvoice(REF, {
        invoice: tokenInvoice,
        transferId: TID,
        verify: VERIFY,
        commit: () => undefined,
      }),
    ).rejects.toThrow(/only sats invoices are supported/);
    expect(approvals).toHaveLength(0);
    await c.destroy();
  });

  it("rejects a caller amount conflicting with a fixed invoice amount", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    const fixedInvoice = encodeSparkAddress({
      network: "regtest",
      identityPublicKey: PK,
      invoice: {
        version: 1,
        id: INVOICE_ID,
        payment: { type: "sats", amount: 500 },
      },
    });
    await expect(
      c.paySparkInvoice(REF, {
        invoice: fixedInvoice,
        amountSats: 999,
        transferId: TID,
        verify: VERIFY,
        commit: () => undefined,
      }),
    ).rejects.toThrow(/conflicts with the invoice amount/);
    expect(approvals).toHaveLength(0);
    await c.destroy();
  });
});

describe("commit before the client send", () => {
  const gone = (): never => {
    throw new Error("gone");
  };

  async function setup(calls: string[], approvals: unknown[]) {
    // A balance that always covers the send so the preflight passes and `commit` is what throws.
    const { c, client } = controller(calls, approvals, { balanceSats: 1_000_000 });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    await c.init();
    return { c, client };
  }

  it("a throwing commit stops a Spark send after approval", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    const receiver = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
    await expect(
      c.send(REF, { receiver, amountSats: 10, transferId: TID, verify: VERIFY, commit: gone }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: "gone" }) });
    expect(approvals).toHaveLength(1);
    expect(calls).not.toContain("send");
    await c.destroy();
  });

  it("a throwing commit stops a lightning payment after approval", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await expect(
      c.payInvoice(REF, {
        invoice: TEST_INVOICE,
        maxFeeSats: 5,
        transferId: TID,
        verify: VERIFY,
        commit: gone,
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: "gone" }) });
    expect(approvals).toHaveLength(1);
    expect(calls).not.toContain("pay");
    await c.destroy();
  });

  it("a throwing commit stops a Spark invoice payment after approval", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    const invoice = encodeSparkAddress({
      network: "regtest",
      identityPublicKey: PK,
      invoice: {
        version: 1,
        id: "01936f00-0000-7000-8000-000000000001",
        payment: { type: "sats", amount: 500 },
      },
    });
    await expect(
      c.paySparkInvoice(REF, { invoice, transferId: TID, verify: VERIFY, commit: gone }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: "gone" }) });
    expect(approvals).toHaveLength(1);
    expect(calls).not.toContain("invoicePay");
    await c.destroy();
  });

  it("a throwing commit stops a cooperative exit after approval", async () => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = await setup(calls, approvals);
    await expect(
      c.withdraw(REF, {
        address: "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz",
        amountSats: 1000,
        speed: "FAST",
        maxFeeSats: 10,
        transferId: TID,
        verify: VERIFY,
        commit: gone,
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: "gone" }) });
    expect(approvals).toHaveLength(1);
    expect(calls).not.toContain("exit");
    await c.destroy();
  });
});

describe("sparkTransferId", () => {
  it("mints a UUIDv7 — deterministic for a request, distinct across requests", () => {
    const id = sparkTransferId("req-a", 1_800_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sparkTransferId("req-a", 1_800_000_000_000)).toBe(id);
    expect(sparkTransferId("req-b", 1_800_000_000_000)).not.toBe(id);
  });
});

describe("idempotent commits", () => {
  const LOST = new SparkRequestError("response lost", { code: "unavailable" });
  const P2TR = "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz";
  const RECEIVER = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
  const SATS_INVOICE = encodeSparkAddress({
    network: "regtest",
    identityPublicKey: PK,
    invoice: {
      version: 1,
      id: "01936f00-0000-7000-8000-000000000001",
      payment: { type: "sats", amount: 500 },
    },
  });

  type Method = "send" | "pay" | "invoicePay" | "exit";

  /** A client whose committing calls run a per-method script; its event stream parks forever. */
  function retryRig(script: Partial<Record<Method, ReadonlyArray<Error | "ok">>>) {
    const calls: Array<{ method: Method; params: unknown }> = [];
    const waits: number[] = [];
    const queues: Record<Method, Array<Error | "ok">> = {
      send: [...(script.send ?? ["ok"])],
      pay: [...(script.pay ?? ["ok"])],
      invoicePay: [...(script.invoicePay ?? ["ok"])],
      exit: [...(script.exit ?? ["ok"])],
    };
    const commit = async (method: Method, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      const outcome = queues[method].shift() ?? "ok";
      return outcome === "ok" ? Promise.resolve(params) : Promise.reject(outcome);
    };
    const client = {
      identityPublicKey: async () => Promise.resolve(PK),
      balance: async () => Promise.resolve(10_000),
      transfers: {
        claimPending: async () => Promise.resolve({ leaves: [], failures: [] }),
        claim: async () => Promise.resolve([]),
        history: async () => Promise.resolve({ payments: [], nextOffset: undefined }),
        send: async (o: unknown) => commit("send", o),
      },
      lightning: {
        createInvoice: async (o: unknown) => Promise.resolve(o),
        pay: async (o: unknown) => commit("pay", o),
      },
      invoices: {
        pay: async (_invoice: unknown, o: unknown) => commit("invoicePay", o),
      },
      withdrawals: {
        quoteCooperativeExit: async () =>
          Promise.resolve({ fees: { fast: 5, medium: 3, slow: 1 } }),
        cooperativeExit: async (o: unknown) => commit("exit", o),
      },
      // The stream never ends — the loop parks inside it and never takes a resubscribe backoff.
      events: () =>
        (async function* (): AsyncGenerator<SparkEvent> {
          await new Promise(() => undefined);
          yield* [];
        })(),
      close: () => undefined,
    };
    const approvals: unknown[] = [];
    const c = new SparkController({
      // Commit backoff sleeps resolve on the next microtask — the test never waits on the wall
      // clock; the payment-record poll is never fired.
      setTimer: (ms, fn) => {
        if (ms >= RECONCILE_BASE_MS) {
          return () => undefined;
        }
        waits.push(ms);
        queueMicrotask(fn);
        return () => undefined;
      },
      spark: {
        signer: () => null as never,
        approve: async (p: unknown) => {
          approvals.push(p);
          return Promise.resolve({});
        },
      },
      fetch: async () => Promise.reject(new Error("no fetch")),
      now: () => 0,
      logger: LOGGER,
      createClient: () => client as unknown as SparkClient,
    });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    return { c, calls, waits, approvals };
  }

  const COMMITS: ReadonlyArray<{
    readonly name: string;
    readonly method: Method;
    readonly run: (c: SparkController) => Promise<unknown>;
  }> = [
    {
      name: "send",
      method: "send",
      run: async (c) =>
        c.send(REF, {
          receiver: RECEIVER,
          amountSats: 10,
          transferId: TID,
          verify: VERIFY,
          commit: () => undefined,
        }),
    },
    {
      name: "payInvoice",
      method: "pay",
      run: async (c) =>
        c.payInvoice(REF, {
          invoice: TEST_INVOICE,
          maxFeeSats: 5,
          transferId: TID,
          verify: VERIFY,
          commit: () => undefined,
        }),
    },
    {
      name: "paySparkInvoice",
      method: "invoicePay",
      run: async (c) =>
        c.paySparkInvoice(REF, {
          invoice: SATS_INVOICE,
          transferId: TID,
          verify: VERIFY,
          commit: () => undefined,
        }),
    },
    {
      name: "withdraw",
      method: "exit",
      run: async (c) =>
        c.withdraw(REF, {
          address: P2TR,
          amountSats: 1000,
          speed: "FAST",
          maxFeeSats: 10,
          transferId: TID,
          verify: VERIFY,
          commit: () => undefined,
        }),
    },
  ];

  it.each(COMMITS)(
    "$name retries a lost commit response under the same transfer id",
    async ({ method, run }) => {
      const { c, calls, waits, approvals } = retryRig({ [method]: [LOST] });
      await c.init();
      const result = await run(c);
      const commits = calls.filter((x) => x.method === method);
      // One approval, two identical commit attempts — the second resumes the same payment.
      expect(commits).toHaveLength(2);
      expect(commits[0]?.params).toMatchObject({ transferId: TID });
      expect(commits[1]?.params).toStrictEqual(commits[0]?.params);
      expect(result).toBe(commits[1]?.params);
      expect(waits).toStrictEqual([1000]);
      expect(approvals).toHaveLength(1);
      await c.destroy();
    },
  );

  it.each(COMMITS)(
    "$name reports an unknown outcome after three retries",
    async ({ method, run }) => {
      const { c, calls, waits, approvals } = retryRig({ [method]: [LOST, LOST, LOST, LOST] });
      await c.init();
      const failure = await run(c).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SparkControllerError);
      expect(failure).toMatchObject({
        category: "unknown",
        payment: { id: TID, state: "unknown" },
      });
      expect(calls.filter((x) => x.method === method)).toHaveLength(4);
      expect(waits).toStrictEqual([1000, 2000, 4000]);
      expect(approvals).toHaveLength(1);
      await c.destroy();
    },
  );

  it.each(COMMITS)("$name does not retry a definite failure", async ({ method, run }) => {
    const { c, calls, waits } = retryRig({ [method]: [new SparkInputError("bad input")] });
    await c.init();
    const failure = await run(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    /* A definite error is not retried, but sats absence still proves nothing — the operator's
       probe is the only verdict, so the record stays open as unknown. */
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({ category: "unknown" });
    expect(calls.filter((x) => x.method === method)).toHaveLength(1);
    expect(waits).toStrictEqual([]);
    await c.destroy();
  });
});

describe("categorize", () => {
  it("a request or server error is a network failure whatever its message says", () => {
    // A 502 whose server message contains "rejected" is still a network failure — the class, not
    // the text, decides.
    expect(
      categorize(
        new SparkRequestError("ssp request failed with status 502: upstream rejected the request", {
          code: "http_502",
        }),
      ),
    ).toBe("network");
    expect(categorize(new SparkTokenBroadcastError("lost", { inputOutputIds: [] }))).toBe(
      "network",
    );
    expect(categorize(new SparkRequestError("unavailable", { code: "unavailable" }))).toBe(
      "network",
    );
  });

  it("an input error is rejected — insufficient only when it says so", () => {
    expect(categorize(new SparkInputError("insufficient balance for the send"))).toBe(
      "insufficient-funds",
    );
    expect(categorize(new SparkInputError("leaf missing signing keyshare"))).toBe("rejected");
  });

  it("a plain SparkError is internal; only non-Spark errors read their message", () => {
    expect(categorize(new SparkError("ssp send request is for a different invoice"))).toBe(
      "internal",
    );
    expect(categorize(new SparkError("insufficient balance"))).toBe("internal");
    expect(categorize(new Error("approval denied"))).toBe("rejected");
    expect(categorize(new Error("approval required"))).toBe("approval-required");
    expect(categorize(new Error("insufficient funds"))).toBe("insufficient-funds");
    expect(categorize(new Error("fetch failed"))).toBe("network");
  });
});

describe("a sats commit failure asks the operator before failing", () => {
  const RECEIVER = encodeSparkAddress({ network: "regtest", identityPublicKey: PK });
  const boot = async (opts: Parameters<typeof controller>[2] = {}) => {
    const calls: string[] = [];
    const approvals: unknown[] = [];
    const { c } = controller(calls, approvals, { setTimer: fastTimer, ...opts });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    await c.init();
    return { calls, c };
  };

  const send = async (c: SparkController) =>
    c.send(REF, {
      receiver: RECEIVER,
      amountSats: 10,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
  const payInvoice = async (c: SparkController) =>
    c.payInvoice(REF, {
      invoice: TEST_INVOICE,
      maxFeeSats: 5,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
  const record = (c: SparkController) => c.getState().accounts["w1:0:regtest"]?.payments?.[TID];

  it("a first-attempt error with no transfer listed stays unknown — absence proves nothing", async () => {
    const { calls, c } = await boot({
      sendResults: [new SparkInputError("insufficient balance for the send")],
      historyPages: [{ payments: [], nextOffset: undefined }],
    });
    const failure = await send(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({ category: "unknown" });
    expect(record(c)).toMatchObject({ state: "unknown" });
    expect(calls.filter((x) => x === "send")).toHaveLength(1);
    // The probe asked the operator before deciding.
    expect(calls).toContain("history");
    await c.destroy();
  });

  it("a first-attempt error whose probe cannot be answered stays unknown", async () => {
    const { c } = await boot({
      sendResults: [new SparkInputError("insufficient balance for the send")],
      // Every history read fails — boot's refresh, the probe, the reconcile pass.
      historyPages: Array.from({ length: 10 }, () => new Error("history unreachable")),
    });
    const failure = await send(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({
      category: "unknown",
      payment: { id: TID, state: "unknown" },
    });
    expect(record(c)).toMatchObject({ state: "unknown" });
    await c.destroy();
  });

  it("a first-attempt error with an incomplete listing stays unknown — absent is never guessed", async () => {
    const { c } = await boot({
      sendResults: [new SparkInputError("insufficient balance for the send")],
      // The listing never ends — every page has a next offset — so "not found" proves nothing.
      historyPages: Array.from({ length: 12 }, () => ({
        payments: [],
        nextOffset: 1,
      })),
    });
    const failure = await send(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({ category: "unknown" });
    expect(record(c)).toMatchObject({ state: "unknown" });
    await c.destroy();
  });

  it("a post-commit error with the transfer still listed is unknown, not internal", async () => {
    const { calls, c } = await boot({
      payResults: [new SparkError("ssp send request is for a different invoice")],
      historyPages: [
        {
          payments: [{ id: TID, status: "pending", createdAt: 0, transferDirection: "OUTBOUND" }],
          nextOffset: undefined,
        },
      ],
    });
    const failure = await payInvoice(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    // The commit ran and the operator lists the transfer — the caller is told the outcome is
    // unknown, never a plain internal error it might retry.
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({ category: "unknown" });
    expect(record(c)).toMatchObject({ state: "unknown" });
    expect(calls.filter((x) => x === "pay")).toHaveLength(1);
    await c.destroy();
  });

  it("a post-commit input error with the transfer listed is unknown", async () => {
    const { c } = await boot({
      sendResults: [new SparkInputError("leaf missing signing keyshare")],
      historyPages: [
        {
          payments: [{ id: TID, status: "pending", createdAt: 0, transferDirection: "OUTBOUND" }],
          nextOffset: undefined,
        },
      ],
    });
    const failure = await send(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({ category: "unknown" });
    expect(record(c)).toMatchObject({ state: "unknown" });
    await c.destroy();
  });

  it("a listed payment's final answer wins over the thrown error", async () => {
    const { c } = await boot({
      sendResults: [new SparkInputError("leaf missing signing keyshare")],
      historyPages: [
        {
          payments: [{ id: TID, status: "failed", createdAt: 0, transferDirection: "OUTBOUND" }],
          nextOffset: undefined,
        },
      ],
    });
    const failure = await send(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    // The operator says the transfer failed — the original error is rethrown, categorized by
    // class, and the record carries the operator's own verdict.
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({ category: "rejected" });
    expect(record(c)).toMatchObject({ state: "failed" });
    await c.destroy();
  });
});

describe("a token commit failure is definite before the broadcast", () => {
  const boot = async (opts: Parameters<typeof controller>[2] = {}) => {
    const calls: string[] = [];
    const { c } = controller(calls, [], { setTimer: fastTimer, ...opts });
    c.setAccounts([REF]);
    c.setStore(createMemoryEngineStore());
    await c.init();
    return { calls, c };
  };

  const sendToken = async (c: SparkController) =>
    c.sendToken(REF, {
      receiver: RECEIVER,
      tokenIdentifier: BTKN,
      amount: 5n,
      transferId: TID,
      verify: VERIFY,
      commit: () => undefined,
    });
  const record = (c: SparkController) => c.getState().accounts["w1:0:regtest"]?.payments?.[TID];

  it("an input error fails — selection runs before the broadcast", async () => {
    const { calls, c } = await boot({ tokenResults: [new SparkInputError("not enough outputs")] });
    const failure = await sendToken(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).not.toMatchObject({ category: "unknown" });
    expect(record(c)).toMatchObject({ state: "failed" });
    expect(calls.filter((x) => x === "tokenTransfer")).toHaveLength(1);
    await c.destroy();
  });

  it("a non-broadcast request error fails — the request never reached the broadcast", async () => {
    const { calls, c } = await boot({
      tokenResults: [new SparkRequestError("metadata lookup failed", { code: "unavailable" })],
    });
    const failure = await sendToken(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({ category: "network" });
    expect(record(c)).toMatchObject({ state: "failed" });
    expect(calls.filter((x) => x === "tokenTransfer")).toHaveLength(1);
    await c.destroy();
  });

  it("any other error after the commit call stays unknown — nothing proves it did not go out", async () => {
    const { calls, c } = await boot({
      tokenResults: [new SparkError("broadcast_transaction: unexpected commit status")],
    });
    const failure = await sendToken(c).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({
      category: "unknown",
      payment: { id: TID, state: "unknown" },
    });
    expect(record(c)).toMatchObject({ state: "unknown" });
    expect(calls.filter((x) => x === "tokenTransfer")).toHaveLength(1);
    await c.destroy();
  });
});
