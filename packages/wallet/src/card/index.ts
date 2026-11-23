/**
 * The card module of @qntx/wallet: `card(wallet)` returns the wallet's card API. `start` runs one
 * kernel card operation and hands back a `CardTask`: the host observes the step stream and renders
 * it — an `input` step means "mount SecureInput", a `tap` step means "show the hold-the-card
 * instruction". APDUs, access codes and reader sessions stay inside the kernel; the facade never
 * drives them. The API is memoized per wallet like `sessions(wallet)`.
 */
import { checkSignResult } from "../chains/check.ts";
import { integrity } from "../channel.ts";
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type { CardOperation, CardOpResult, CardStep } from "../protocol/index.ts";
import { WalletError } from "../types.ts";
import type { VerifyFactor, Wallet } from "../types.ts";

export type {
  CardInputPurpose,
  CardOperation,
  CardOpResult,
  CardStep,
  CardTapReason,
} from "../protocol/index.ts";

/** One running card operation: the host renders steps, never drives APDUs. */
export type CardTask = {
  /** Every step as the kernel reports it, starting with the current one; returns an unsubscribe. */
  readonly observe: (listener: (step: CardStep) => void) => () => void;
  /** Ends the operation (the kernel wipes its state); idempotent; resolves when the kernel answered. */
  readonly cancel: () => Promise<void>;
  /** The operation's result, or its WalletError (cancelled → `cancelled`). */
  readonly result: Promise<CardOpResult>;
};

export type CardApi = {
  readonly start: (op: CardOperation, verify?: VerifyFactor) => CardTask;
};

const cancelledError = (): WalletError =>
  new WalletError("cancelled", "the card operation was cancelled");

function run(internals: WalletInternals, op: CardOperation, verify?: VerifyFactor): CardTask {
  const listeners = new Set<(step: CardStep) => void>();
  /** The most recent step the kernel reported — a late observe starts from it. */
  let current: CardStep | undefined;
  let opId: string | undefined;
  /** `cancel` raced `card.begin` — fire `card.cancel` the moment the opId lands. */
  let cancelRequested = false;
  let ackCancel: (() => void) | undefined;
  let cancelAck: Promise<void> | undefined;
  let done = false;
  let resolveResult!: (result: CardOpResult) => void;
  let rejectResult!: (error: WalletError) => void;
  const result = new Promise<CardOpResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // The task owns `result`'s rejection — it must never surface as unhandled.
  void (async (): Promise<void> => {
    try {
      await result;
    } catch {
      // `result` itself surfaces the WalletError to whoever awaited it.
    }
  })();

  const emit = (step: CardStep): void => {
    current = step;
    for (const listener of listeners) {
      listener(step);
    }
  };

  const cancel = async (): Promise<void> => {
    if (done) {
      return;
    }
    cancelRequested = true;
    if (opId === undefined) {
      // `card.begin` has not answered: remember and resolve once the deferred cancel lands.
      cancelAck ??= new Promise<void>((resolve) => {
        ackCancel = resolve;
      });
      await cancelAck;
      return;
    }
    // The in-flight or next `card.step` answers `cancelled`/`not-found`; the runner maps both to
    // `cancelled` because this request asked for it.
    await internals.call("card.cancel", { opId }).catch(() => undefined);
  };

  void (async (): Promise<void> => {
    try {
      const begun = await internals.secretCall("card.begin", async (wire) => ({
        op,
        ...(verify === undefined
          ? {}
          : { verify: await internals.resolveVerifyFactor(verify, wire) }),
      }));
      ({ opId } = begun);
      if (cancelRequested) {
        await internals.call("card.cancel", { opId }).catch(() => undefined);
        emit(begun.step);
        done = true;
        rejectResult(cancelledError());
        ackCancel?.();
        return;
      }
      let { step } = begun;
      while (step.kind !== "done") {
        emit(step);
        // oxlint-disable-next-line eslint/no-await-in-loop -- the kernel's poll cadence
        step = await internals.call("card.step", { opId });
      }
      const outcome = step.result;
      if (outcome.kind === "sign") {
        if (op.kind !== "sign") {
          throw integrity("card.begin answered a sign result for a non-sign operation");
        }
        // The `done` step goes out only once the result verifies — an observer never sees a
        // forged signature reported as done.
        await checkSignResult(internals, op.request, outcome.result);
      }
      emit(step);
      done = true;
      resolveResult(outcome);
    } catch (error) {
      done = true;
      ackCancel?.();
      if (cancelRequested) {
        rejectResult(cancelledError());
      } else {
        rejectResult(
          error instanceof WalletError
            ? error
            : integrity("the card channel answered in bad shape"),
        );
      }
    }
  })();

  return {
    observe: (listener) => {
      listeners.add(listener);
      if (current !== undefined) {
        listener(current);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    cancel,
    result,
  };
}

function createCardApi(internals: WalletInternals): CardApi {
  /** The running task, if any — a second `start` cancels it (the kernel does the same). */
  let active: CardTask | undefined;
  return {
    start: (op, verify) => {
      void active?.cancel();
      active = run(internals, op, verify);
      return active;
    },
  };
}

const apis = new WeakMap<Wallet, CardApi>();

export function card(wallet: Wallet): CardApi {
  const internals = internalsOf(wallet);
  let api = apis.get(wallet);
  if (api === undefined) {
    api = createCardApi(internals);
    apis.set(wallet, api);
  }
  return api;
}
