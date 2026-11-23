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
  ChainTemplate,
  ChainAccount,
  ChainSignRequest,
  ChainSignResult,
} from "../protocol/chains.ts";
import type {
  DeviceDisplay,
  DeviceRequest,
  DeviceResponse,
  HardwareDevice,
  HardwareOperation,
  HardwareResult,
  QrPayload,
} from "../protocol/hardware.ts";
import type { ResultOf } from "../protocol/index.ts";
import { WalletError } from "../types.ts";
import type { VerifyFactor, Wallet, WalletInfo } from "../types.ts";

export type {
  DeviceDisplay,
  DeviceRequest,
  DeviceResponse,
  HardwareDevice,
  HardwareOperation,
  HardwareResult,
  HardwareStep,
  QrPayload,
} from "../protocol/hardware.ts";

/** The host transport for one device operation. */
export type DeviceIo = {
  /**
   * Carries one kernel-produced exchange: show `request.show` / send `request.data`, then resolve
   * with what the device answered. Rejecting aborts the operation.
   */
  readonly exchange: (
    request: DeviceRequest,
    context: { readonly device: HardwareDevice; readonly display?: DeviceDisplay },
  ) => Promise<DeviceResponse>;
  /** Aborted before or while waiting → the operation is cancelled and the call rejects `cancelled`. */
  readonly signal?: AbortSignal;
};

export type HardwareApi = {
  /** Pair a device from its sync answer; resolves with the new hardware wallet. */
  readonly pair: (device: HardwareDevice, io: DeviceIo) => Promise<WalletInfo>;
  /** Fetch public keys for paths the device has not yet exported (per-group account nodes). */
  readonly accounts: (
    params: {
      readonly walletId: string;
      readonly groupIndex: number;
      readonly templates: ReadonlyArray<ChainTemplate>;
      readonly network: string;
    },
    io: DeviceIo,
  ) => Promise<ReadonlyArray<ChainAccount>>;
  /**
   * Sign `request` on the device: the same user verification and the same result checks as
   * `chains().sign` — a signature that does not verify for the account fails `integrity`.
   */
  readonly sign: (
    params: { readonly request: ChainSignRequest; readonly verify: VerifyFactor },
    io: DeviceIo,
  ) => Promise<ChainSignResult>;
  /** Derive or compare an address on the device; `method` reports which happened. */
  readonly verifyAddress: (
    params: {
      readonly walletId: string;
      readonly groupIndex: number;
      readonly template: ChainTemplate;
      readonly network: string;
      readonly index?: number;
    },
    io: DeviceIo,
  ) => Promise<{ readonly address: string; readonly method: "device" | "compare" }>;
};

const cancelled = (): WalletError =>
  new WalletError("cancelled", "the device operation was aborted");

/** A live read of the abort flag — a plain property access would let TS narrow it to `false`. */
const aborted = (io: DeviceIo): boolean => io.signal?.aborted === true;

/**
 * Runs one operation: begin, then fold `exchange` steps through `io.exchange` until `done`. Any
 * failure — abort, a rejected `io.exchange`, a kernel error — cancels the operation best-effort
 * before propagating, so no kernel operation outlives the call.
 */
const run = async (
  internals: WalletInternals,
  op: HardwareOperation,
  io: DeviceIo,
  verify?: VerifyFactor,
): Promise<HardwareResult> => {
  let opId: string | undefined;
  try {
    if (aborted(io)) {
      throw cancelled();
    }
    const beginCall = async (): Promise<ResultOf<"hardware.begin">> =>
      internals.secretCall("hardware.begin", async (wire) => ({
        op,
        ...(verify === undefined
          ? {}
          : { verify: await internals.resolveVerifyFactor(verify, wire) }),
      }));
    // The user verification lives inside begin; the QR exchange that follows is not part of it.
    const begin =
      verify === undefined ? await beginCall() : await internals.withVerifying(beginCall);
    ({ opId } = begin);
    let { step } = begin;
    while (step.kind === "exchange") {
      if (aborted(io)) {
        throw cancelled();
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- one exchange at a time by design.
      const response = await io.exchange(step.request, {
        device: step.device,
        ...(step.display === undefined ? {} : { display: step.display }),
      });
      if (aborted(io)) {
        throw cancelled();
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- one exchange at a time by design.
      step = await internals.call("hardware.step", { opId, response });
    }
    if (step.result.kind !== op.kind) {
      throw integrity("operation result does not match the operation");
    }
    return step.result;
  } catch (error) {
    if (opId !== undefined) {
      await internals.call("hardware.cancel", { opId }).catch(() => undefined);
    }
    if (aborted(io) && !(error instanceof WalletError && error.code === "cancelled")) {
      throw cancelled();
    }
    throw error;
  }
};

function createHardwareApi(internals: WalletInternals): HardwareApi {
  return {
    pair: async (device, io) => {
      const result = await run(internals, { kind: "pair", device }, io);
      if (result.kind !== "pair") {
        throw integrity("operation result does not match the operation");
      }
      return result.wallet;
    },
    accounts: async (params, io) => {
      const result = await run(internals, { kind: "accounts", ...params }, io);
      if (result.kind !== "accounts") {
        throw integrity("operation result does not match the operation");
      }
      return result.accounts;
    },
    sign: async (params, io) => {
      const result = await run(
        internals,
        { kind: "sign", request: params.request },
        io,
        params.verify,
      );
      if (result.kind !== "sign") {
        throw integrity("operation result does not match the operation");
      }
      await checkSignResult(internals, params.request, result.result);
      return result.result;
    },
    verifyAddress: async (params, io) => {
      const result = await run(internals, { kind: "verify-address", ...params }, io);
      if (result.kind !== "verify-address") {
        throw integrity("operation result does not match the operation");
      }
      return { address: result.address, method: result.method };
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
