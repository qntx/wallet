import { hexToBytes, isHex, serializeTransaction } from "viem";
import type { Hex } from "viem";

import type { Event } from "@qntx/nostr";
import type { SignRequest } from "@qntx/wallet-chains";

import { AddressBookController } from "../src/addresses/controller.ts";
import type { EsploraDeps } from "../src/chains/bitcoin.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { BitcoinRoute } from "../src/transactions/bitcoin.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type { RouteContext, SendParams, TrackedTransaction } from "../src/transactions/route.ts";

const isSparkController = (_value: unknown): _value is SparkController => true;

/** Chain-only tests never reach the Spark controller; any object stands in for it. */
const noSpark = ((): SparkController => {
  const stub: unknown = {};
  if (isSparkController(stub)) {
    return stub;
  }
  throw new Error("unreachable");
})();

/** An address book and the store factory a `RequestController` needs, over one shared backing. */
export const bookDeps = (): {
  addressBook: AddressBookController;
  openStore: () => Promise<ReturnType<typeof createMemoryEngineStore>>;
} => {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const openStore = async () => {
    await Promise.resolve();
    return createMemoryEngineStore(backing);
  };
  let n = 0;
  const next = (): number => {
    n += 1;
    return n % 251;
  };
  const addressBook = new AddressBookController({
    openStore,
    random: (len) => new Uint8Array(len).fill(next()),
    now: () => 0,
    logger: { warn: () => undefined },
  });
  return { addressBook, openStore };
};

let counter = 0;
const nextCounter = (): number => {
  counter += 1;
  return counter;
};
const requestControllers = new WeakMap<TransactionController, RequestController>();

/** A request controller bound to `transactions`, unlocked on first use (ids are unique per call). */
export const requestsFor = async (
  transactions: TransactionController,
): Promise<RequestController> => {
  const existing = requestControllers.get(transactions);
  if (existing !== undefined) {
    return existing;
  }
  const created = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: noSpark,
    nostrSign: async (_ref, _event): Promise<Event> => {
      await Promise.resolve();
      throw new Error("nostr-sign is not wired in this test");
    },
    bitcoinSign: async () => {
      await Promise.resolve();
      throw new Error("unused");
    },
    solanaSign: async () => {
      await Promise.resolve();
      throw new Error("solana-sign is not wired in this test");
    },
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(nextCounter() % 251),
    now: () => 0,
    setTimer: () => () => undefined,
    logger: { warn: () => undefined },
  });
  await created.init();
  requestControllers.set(transactions, created);
  return created;
};

/** The pipeline end to end: prepare, then approve with the params' own `verify`. */
export const send = async (
  transactions: TransactionController,
  params: SendParams,
): Promise<TrackedTransaction> => {
  const { verify, ...rest } = params;
  const requests = await requestsFor(transactions);
  const request = await requests.prepare({ method: "send", ...rest });
  return requests.approve(request.id, "send", verify);
};

/** Speed up or cancel a transaction through the pipeline. */
export const replaceVia = async (
  transactions: TransactionController,
  txId: string,
  mode: "speed-up" | "cancel",
  verify: SendParams["verify"],
): Promise<TrackedTransaction> => {
  const requests = await requestsFor(transactions);
  const request = await requests.prepare({ method: mode, txId });
  return requests.approve(request.id, mode, verify);
};

/** CPFP a bitcoin transaction through the pipeline. */
export const cpfpVia = async (
  transactions: TransactionController,
  txId: string,
  feeRate: number,
  verify: SendParams["verify"],
): Promise<TrackedTransaction> => {
  const requests = await requestsFor(transactions);
  const request = await requests.prepare({ method: "cpfp", txId, feeRate });
  return requests.approve(request.id, "cpfp", verify);
};

/** Route-level send for tests that drive a bitcoin route directly. */
export const routeSend = async (
  route: BitcoinRoute,
  ctx: RouteContext,
  params: SendParams,
): Promise<TrackedTransaction> => {
  const { verify, ...rest } = params;
  counter += 1;
  const prepared = await route.prepare(ctx, rest, `req-test-${counter}`);
  return prepared.submit(verify);
};

let routeCounter = 0;

/** Route-level speed-up/cancel for tests that drive a bitcoin route directly. */
export const routeReplace = async (
  route: BitcoinRoute,
  ctx: RouteContext,
  old: TrackedTransaction,
  mode: "speed-up" | "cancel",
  verify: SendParams["verify"],
): Promise<TrackedTransaction> => {
  routeCounter += 1;
  const prepared = await route.prepareReplace(ctx, old, mode, `req-replace-${routeCounter}`);
  return prepared.submit(verify);
};

/** Route-level CPFP for tests that drive a bitcoin route directly. */
export const routeCpfp = async (
  route: BitcoinRoute,
  ctx: RouteContext,
  parent: TrackedTransaction,
  feeRate: number,
  verify: SendParams["verify"],
): Promise<TrackedTransaction> => {
  routeCounter += 1;
  const prepared = await route.prepareCpfp(ctx, parent, feeRate, `req-cpfp-${routeCounter}`);
  return prepared.submit(verify);
};

/** `simulateSolana` for rigs that never simulate. */
export async function simulateSolanaStub(): Promise<{ status: "unavailable"; error: string }> {
  await Promise.resolve();
  return { status: "unavailable", error: "not wired in this test" };
}

/** A permissive `eth_simulateV1` answer: every simulated call succeeds with empty return data. */
export function simulateV1Result(params: unknown): unknown {
  const first: unknown = Array.isArray(params) ? params[0] : undefined;
  const states: unknown =
    typeof first === "object" && first !== null && "blockStateCalls" in first
      ? first.blockStateCalls
      : [];
  return (Array.isArray(states) ? (states as unknown[]) : []).map((state, index) => {
    const calls: unknown =
      typeof state === "object" && state !== null && "calls" in state ? state.calls : [];
    return {
      number: `0x${(index + 1).toString(16)}`,
      hash: `0x${"00".repeat(32)}`,
      parentHash: `0x${"00".repeat(32)}`,
      timestamp: "0x1",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      baseFeePerGas: "0x1",
      miner: `0x${"00".repeat(20)}`,
      transactions: [],
      calls: (Array.isArray(calls) ? (calls as unknown[]) : []).map(() => ({
        status: "0x1",
        returnData: "0x",
        gasUsed: "0x0",
        logs: [],
      })),
    };
  });
}

/** `tokens` for rigs that never watch an asset. */
export const tokensStub = {
  metadata: async (): Promise<{ symbol: string; decimals: number }> => {
    await Promise.resolve();
    throw new Error("tokens are not wired in this test");
  },
  add: async (): Promise<void> => {
    await Promise.resolve();
    throw new Error("tokens are not wired in this test");
  },
};

/**
 * `EsploraDeps` whose timers run `sleep` for backoff delays; the request-timeout timer never fires.
 * `random` is all zeros, so jitter is 0.
 */
export function esploraDeps(
  sleep: (ms: number) => Promise<void> = async () => {
    await Promise.resolve();
  },
): EsploraDeps {
  return {
    setTimer: (ms, fn) => {
      if (ms === 10_000) {
        return () => undefined;
      }
      let live = true;
      void (async () => {
        await sleep(ms);
        if (live) {
          fn();
        }
      })();
      return () => {
        live = false;
      };
    },
    random: (n) => new Uint8Array(n),
  };
}

/** `setTimer` and `random` for a `NetworkController` that never waits. */
export const idleNetworkDeps = {
  setTimer: (): (() => void) => () => undefined,
  random: (n: number): Uint8Array => new Uint8Array(n),
};

const hexOf = (value: string | undefined): Hex => {
  if (value === undefined || !isHex(value)) {
    throw new Error("malformed hex field");
  }
  return value;
};

/** A sign result whose bytes are the request's transaction serialized with a placeholder signature. */
export const fakeSignedEvm = (
  request: SignRequest,
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
  const r: Hex = `0x${"11".repeat(32)}`;
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
          signature,
        );
  return { kind: "evm.transaction", signedTransaction: hexToBytes(raw) };
};
