/**
 * The hardware module of @qntx/wallet: `hardware(wallet)` returns the external-signer API. Every
 * call drives one kernel device operation — `hardware.begin`, then `hardware.step` for each
 * exchange the kernel asks for, until `done`. The host only transports frames; the kernel validates
 * every request, decodes every answer and verifies every signature, and this module re-checks a
 * sign result the same way `chains().sign` does. An operation is never left running: any abort or
 * transport failure cancels it best-effort before the promise settles.
 *
 * `qrParts`/`qrReader` are the pure UR plumbing for air-gapped (QR) transports: parts are the
 * uppercase fountain strings a device scans, the reader folds scanned strings back into the payload
 * and only accepts the UR types the operation advertised.
 */
import { isUrType, toQrString, UrDecoder, UrEncoder } from "@qntx/ur";

import { checkSignResult } from "../chains/check.ts";
import { integrity } from "../channel.ts";
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type {
  DeviceIo,
  HardwareOperation,
  HardwareResult,
  HardwareStep,
  QrPayload,
} from "../protocol/hardware.ts";
import type { ResultOf } from "../protocol/index.ts";
import { WalletError } from "../types.ts";
import type { SignerTask, VerifyFactor, Wallet } from "../types.ts";

export type {
  DeviceDisplay,
  DeviceIo,
  DeviceRequest,
  DeviceResponse,
  HardwareDevice,
  HardwareOperation,
  HardwareResult,
  HardwareStep,
  LedgerDescriptors,
  QrPayload,
} from "../protocol/hardware.ts";

export { ledgerBleExchange, ledgerHidExchange, ledgerIo } from "./ledger.ts";
export { oneKeyBleExchange, oneKeyHidExchange, oneKeyIo } from "./onekey.ts";
export type { BlePort, HidPort } from "./ports.ts";
export { bundleDescriptorSource, calDescriptorSource, LEDGER_CAL_URL } from "./descriptors.ts";
export type { LedgerDescriptorBundle, LedgerDescriptorSource } from "./descriptors.ts";

/** One running device operation: observe every exchange (and the verified `done`), cancel ends it. */
export type HardwareTask = SignerTask<HardwareStep, HardwareResult>;

export type HardwareApi = {
  /**
   * Runs one device operation — pair, accounts, sign or verify-address — begin, then fold each
   * `exchange` step through `options.io.exchange` until `done`. A second `start` cancels the
   * running task. A `sign` result is verified (`chains().sign` rules) before `done` is emitted; a
   * rejected exchange or a kernel error cancels the operation best-effort and rejects `result`;
   * `cancel` answers `cancelled`.
   */
  readonly start: (
    op: HardwareOperation,
    options: { readonly io: DeviceIo; readonly verify?: VerifyFactor },
  ) => HardwareTask;
};

const cancelledError = (): WalletError =>
  new WalletError("cancelled", "the device operation was aborted");

function run(
  internals: WalletInternals,
  op: HardwareOperation,
  options: { readonly io: DeviceIo; readonly verify?: VerifyFactor },
): HardwareTask {
  const { io, verify } = options;
  const listeners = new Set<(step: HardwareStep) => void>();
  /** The most recent step reported — a late observe starts from it. */
  let current: HardwareStep | undefined;
  let opId: string | undefined;
  /** `cancel` raced `hardware.begin` — fire `hardware.cancel` the moment the opId lands. */
  let cancelRequested = false;
  /** A live read — a plain property access lets TS and the linter treat the flag as constant. */
  const isCancelled = (): boolean => cancelRequested;
  let ackCancel: (() => void) | undefined;
  let cancelAck: Promise<void> | undefined;
  let done = false;
  let resolveResult!: (result: HardwareResult) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<HardwareResult>((resolve, reject) => {
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

  const emit = (step: HardwareStep): void => {
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
      // `hardware.begin` has not answered: remember and resolve once the deferred cancel lands.
      cancelAck ??= new Promise<void>((resolve) => {
        ackCancel = resolve;
      });
      await cancelAck;
      return;
    }
    await internals.call("hardware.cancel", { opId }).catch(() => undefined);
  };

  void (async (): Promise<void> => {
    try {
      const beginCall = async (): Promise<ResultOf<"hardware.begin">> =>
        internals.secretCall("hardware.begin", async (wire) => ({
          op,
          ...(verify === undefined
            ? {}
            : { verify: await internals.resolveVerifyFactor(verify, wire) }),
        }));
      // The user verification lives inside begin; the exchanges that follow are not part of it.
      const begin =
        verify === undefined ? await beginCall() : await internals.withVerifying(beginCall);
      ({ opId } = begin);
      if (cancelRequested) {
        await internals.call("hardware.cancel", { opId }).catch(() => undefined);
        emit(begin.step);
        done = true;
        rejectResult(cancelledError());
        ackCancel?.();
        return;
      }
      let { step } = begin;
      while (step.kind === "exchange" && !isCancelled()) {
        emit(step);
        // oxlint-disable-next-line eslint/no-await-in-loop -- one exchange at a time by design.
        const response = await io.exchange(step.request, {
          device: step.device,
          ...(step.display === undefined ? {} : { display: step.display }),
        });
        if (isCancelled()) {
          throw cancelledError();
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one exchange at a time by design.
        step = await internals.call("hardware.step", { opId, response });
      }
      if (isCancelled()) {
        throw cancelledError();
      }
      if (step.kind !== "done") {
        throw integrity("hardware.step answered a step kind the wire does not define");
      }
      const outcome = step.result;
      if (outcome.kind !== op.kind) {
        throw integrity("operation result does not match the operation");
      }
      if (outcome.kind === "sign" && op.kind === "sign") {
        // The `done` step goes out only once the signature verifies — an observer never sees a
        // forged signature reported as done.
        await checkSignResult(internals, op.request, outcome.result);
      }
      emit(step);
      done = true;
      resolveResult(outcome);
    } catch (error) {
      done = true;
      ackCancel?.();
      if (opId !== undefined) {
        await internals.call("hardware.cancel", { opId }).catch(() => undefined);
      }
      if (cancelRequested) {
        rejectResult(cancelledError());
      } else {
        // A host transport failure or a kernel error propagates as itself; only the channel's own
        // validation failures are WalletErrors already.
        rejectResult(error);
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

function createHardwareApi(internals: WalletInternals): HardwareApi {
  /** The running task, if any — a second `start` cancels it (the kernel does the same). */
  let active: HardwareTask | undefined;
  return {
    start: (op, options) => {
      void active?.cancel();
      active = run(internals, op, options);
      return active;
    },
  };
}

const apis = new WeakMap<Wallet, HardwareApi>();

export function hardware(wallet: Wallet): HardwareApi {
  const internals = internalsOf(wallet);
  let api = apis.get(wallet);
  if (api === undefined) {
    api = createHardwareApi(internals);
    apis.set(wallet, api);
  }
  return api;
}

/**
 * Firmware 3.2.2 `FRAGMENT_MAX_LENGTH_DEFAULT` (rust_c/src/common/ur.rs) — the fragment size the
 * device's own encoder uses and its decoder is guaranteed to keep up with.
 */
const DEFAULT_FRAGMENT_LENGTH = 200;

/**
 * Endless, cyclic fountain parts for one QR payload: each call returns the next uppercase UR string
 * (`UR:<type>/…`), ready for an animated QR. For single-part payloads the same frame repeats — the
 * loop is safe to drive on a timer.
 */
export const qrParts = (
  payload: QrPayload,
  options?: { readonly maxFragmentLength?: number },
): (() => string) => {
  if (!isUrType(payload.type)) {
    throw new WalletError("invalid-input", `not a UR type: ${payload.type}`);
  }
  const encoder = new UrEncoder(payload.type, payload.cbor, {
    maxFragmentLength: options?.maxFragmentLength ?? DEFAULT_FRAGMENT_LENGTH,
  });
  return () => {
    const next = encoder.next();
    if (typeof next.value !== "string") {
      throw integrity("fountain encoder ended");
    }
    return toQrString(next.value);
  };
};

export type QrReader = {
  /**
   * Feeds one scanned string. `progress` is the fountain decode ratio in [0, 1]; `payload` appears
   * once complete. Frames of a type outside `scan`, duplicates and out-of-order parts leave the
   * session unchanged; a fatal decoder failure throws `invalid-input`.
   */
  readonly receive: (part: string) => { readonly progress: number; readonly payload?: QrPayload };
};

/** An incremental reader for the frames a device shows back; only `scan` types are admitted. */
export const qrReader = (scan: ReadonlyArray<string>): QrReader => {
  const accept = scan.map((type) => {
    if (!isUrType(type)) {
      throw new WalletError("invalid-input", `not a UR type: ${type}`);
    }
    return type;
  });
  const decoder = new UrDecoder({ accept });
  return {
    receive: (part) => {
      const outcome = decoder.receive(part);
      if (outcome.status === "fatal") {
        throw new WalletError("invalid-input", outcome.error.message);
      }
      const { state } = decoder;
      if (state.phase === "complete") {
        return { progress: 1, payload: { type: state.value.type, cbor: state.value.message } };
      }
      return { progress: decoder.progress.ratio };
    },
  };
};
