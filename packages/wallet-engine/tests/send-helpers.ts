import { RequestController } from "../src/requests/controller.ts";
import type { BitcoinRoute } from "../src/transactions/bitcoin.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type { RouteContext, SendParams, TrackedTransaction } from "../src/transactions/route.ts";

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
