import type { Event } from "@qntx/nostr";

import { AddressBookController } from "../src/addresses/controller.ts";
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
    transactions,
    ...bookDeps(),
    spark: noSpark,
    nostrSign: async (_ref, _event): Promise<Event> => {
      await Promise.resolve();
      throw new Error("nostr-sign is not wired in this test");
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
