/**
 * The operation executor — the coroutine bridge that lets drivers be straight-line `async` code
 * while `hardware.begin`/`hardware.step` carry each device round-trip to the host. `body` runs
 * against a `DeviceLink` whose `exchange` parks the body's promise and surfaces the request as an
 * `exchange` step; `hardware.step` resolves that promise and awaits the next turn, so driver code
 * only ever runs inside some request handler and the kernel's serial queue is preserved.
 *
 * One operation at a time: a new `begin`, `cancel`, `lock` or 300 s without progress discards the
 * active operation — its parked exchange rejects `cancelled` and the body unwinds.
 */
import { bytesToHex } from "@noble/hashes/utils.js";

import type {
  DeviceDisplay,
  DeviceRequest,
  DeviceResponse,
  HardwareDevice,
  HardwareResult,
  HardwareStep,
} from "@qntx/wallet/protocol";

import { KernelError } from "../../errors.ts";
import type { KernelPlatform } from "../../platform.ts";
import type { DeviceLink } from "./driver.ts";

/** 300 s without a `step` answer discards the operation (I6). */
const NO_PROGRESS_MS = 300_000;

type Pending = {
  readonly request: DeviceRequest;
  readonly resolve: (response: DeviceResponse) => void;
  readonly reject: (error: Error) => void;
};

type Turn =
  | { readonly kind: "exchange"; readonly request: DeviceRequest }
  | { readonly kind: "done"; readonly result: HardwareResult }
  | { readonly kind: "failed"; readonly error: unknown };

type Active = {
  readonly opId: string;
  readonly device: HardwareDevice;
  readonly display: DeviceDisplay | undefined;
  cancelTimer: () => void;
  pending: Pending | undefined;
  /** Turns the body produced before any handler waited on them. */
  readonly events: Turn[];
  emit: ((turn: Turn) => void) | undefined;
};

export type OperationExecutor = {
  readonly begin: (
    device: HardwareDevice,
    display: DeviceDisplay | undefined,
    body: (link: DeviceLink) => Promise<HardwareResult>,
  ) => Promise<{ readonly opId: string; readonly step: HardwareStep }>;
  readonly step: (opId: string, response: DeviceResponse) => Promise<HardwareStep>;
  readonly cancel: (opId: string) => void;
  /** Lock aborts a pending operation the same way a cancel does. */
  readonly abort: () => void;
};

const cancelled = (): KernelError => new KernelError("cancelled", "the operation was cancelled");

export function createOperationExecutor(platform: KernelPlatform): OperationExecutor {
  let active: Active | undefined;

  const armTimer = (op: Active): void => {
    op.cancelTimer();
    op.cancelTimer = platform.setTimer(NO_PROGRESS_MS, () => {
      discard(op);
    });
  };

  const discard = (op: Active): void => {
    op.cancelTimer();
    if (active === op) {
      active = undefined;
    }
    op.pending?.reject(cancelled());
    // A handler suspended in waitTurn (a step while the body runs between exchanges) unwinds too.
    notify(op, { kind: "failed", error: cancelled() });
  };

  const notify = (op: Active, turn: Turn): void => {
    if (op.emit === undefined) {
      op.events.push(turn);
    } else {
      const { emit } = op;
      op.emit = undefined;
      emit(turn);
    }
  };

  const waitTurn = async (op: Active): Promise<Turn> => {
    const queued = op.events.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise<Turn>((resolve) => {
      op.emit = resolve;
    });
  };

  const toStep = (op: Active, turn: Turn): HardwareStep => {
    if (turn.kind === "failed") {
      discard(op);
      throw turn.error;
    }
    if (turn.kind === "done") {
      discard(op);
      return { kind: "done", result: turn.result };
    }
    const step: {
      kind: "exchange";
      device: HardwareDevice;
      request: DeviceRequest;
      display?: DeviceDisplay;
    } = { kind: "exchange", device: op.device, request: turn.request };
    if (op.display !== undefined) {
      step.display = op.display;
    }
    return step;
  };

  const begin = async (
    device: HardwareDevice,
    display: DeviceDisplay | undefined,
    body: (link: DeviceLink) => Promise<HardwareResult>,
  ): Promise<{ readonly opId: string; readonly step: HardwareStep }> => {
    if (active !== undefined) {
      discard(active);
    }
    const op: Active = {
      opId: bytesToHex(platform.random(16)),
      device,
      display,
      cancelTimer: () => undefined,
      pending: undefined,
      events: [],
      emit: undefined,
    };
    active = op;
    armTimer(op);
    const link: DeviceLink = {
      exchange: async (request) =>
        new Promise<DeviceResponse>((resolve, reject) => {
          op.pending = { request, resolve, reject };
          notify(op, { kind: "exchange", request });
        }),
    };
    void (async () => {
      try {
        notify(op, { kind: "done", result: await body(link) });
      } catch (error) {
        notify(op, { kind: "failed", error });
      }
    })();
    const step = toStep(op, await waitTurn(op));
    return { opId: op.opId, step };
  };

  const step = async (opId: string, response: DeviceResponse): Promise<HardwareStep> => {
    const op = active;
    if (op === undefined || op.opId !== opId) {
      throw new KernelError("not-found", "no such operation");
    }
    const { pending } = op;
    if (pending === undefined) {
      throw new KernelError("invalid-input", "the operation is not waiting on the device");
    }
    if (pending.request.kind !== response.kind) {
      discard(op);
      throw new KernelError("invalid-input", "the response does not match the device request");
    }
    op.pending = undefined;
    armTimer(op);
    pending.resolve(response);
    return toStep(op, await waitTurn(op));
  };

  const cancel = (opId: string): void => {
    const op = active;
    if (op === undefined || op.opId !== opId) {
      throw new KernelError("not-found", "no such operation");
    }
    discard(op);
  };

  return { begin, step, cancel, abort: () => (active === undefined ? undefined : discard(active)) };
}
