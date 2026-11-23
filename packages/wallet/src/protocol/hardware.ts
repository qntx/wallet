/**
 * The hardware-signer method table and wire types. `hardware.begin` starts one device operation —
 * pair, accounts, sign or verify-address — and runs it until the device needs a host exchange;
 * `hardware.step` answers the pending exchange and runs to the next one; `hardware.cancel` drops
 * the operation. One operation at a time: a new `begin` discards the previous one.
 *
 * The kernel produces logical requests and parses the answers; the host only moves the frames — a
 * QR payload is a UR type plus CBOR, `message` is one logical message on a byte pipe, `compare`
 * asks the user to check an address on the device itself. Everything a device returns is untrusted
 * and re-validated in the kernel.
 */
import type { HardwareDevice, WalletInfo } from "../types.ts";
import type { ChainAccount, ChainSignRequest, ChainSignResult, ChainTemplate } from "./chains.ts";
import { caip2, chainAccount, signRequest, signResult, template } from "./chains.ts";
import type { MethodSpec, VerifyFactor } from "./core.ts";
import { groupIndex, hardwareDevice, verifier, walletId, walletInfo } from "./core.ts";
import type { NullValue, Validator } from "./validate.ts";
import { arr, bool, bytes, int, literal, nullValue, obj, opt, str, union } from "./validate.ts";

export type { HardwareDevice } from "../types.ts";

export type QrPayload = { readonly type: string; readonly cbor: Uint8Array };

export type DeviceRequest =
  | { readonly kind: "qr"; readonly show?: QrPayload; readonly scan: ReadonlyArray<string> }
  | { readonly kind: "message"; readonly data: Uint8Array }
  | { readonly kind: "compare"; readonly address: string; readonly path: string };

export type DeviceResponse =
  | { readonly kind: "qr"; readonly ur: QrPayload }
  | { readonly kind: "message"; readonly data: Uint8Array }
  | { readonly kind: "compare"; readonly matched: boolean };

export type DeviceDisplay = "clear" | "blind";

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

export type HardwareOperation =
  | { readonly kind: "pair"; readonly device: HardwareDevice }
  | {
      readonly kind: "accounts";
      readonly walletId: string;
      readonly groupIndex: number;
      readonly templates: ReadonlyArray<ChainTemplate>;
      readonly network: string;
    }
  | { readonly kind: "sign"; readonly request: ChainSignRequest }
  | {
      readonly kind: "verify-address";
      readonly walletId: string;
      readonly groupIndex: number;
      readonly template: ChainTemplate;
      readonly network: string;
      /** The Bitcoin receive-address index; meaningful only for btc.* templates. */
      readonly index?: number;
    };

export type HardwareResult =
  | { readonly kind: "pair"; readonly wallet: WalletInfo }
  | { readonly kind: "accounts"; readonly accounts: ReadonlyArray<ChainAccount> }
  | { readonly kind: "sign"; readonly result: ChainSignResult }
  | {
      readonly kind: "verify-address";
      readonly address: string;
      readonly method: "device" | "compare";
    };

export type HardwareStep =
  | {
      readonly kind: "exchange";
      readonly device: HardwareDevice;
      readonly request: DeviceRequest;
      readonly display?: DeviceDisplay;
    }
  | { readonly kind: "done"; readonly result: HardwareResult };

const UR_TYPE = /^[a-z0-9-]{1,64}$/;
const DERIVATION_PATH = /^m(\/[0-9]+'?){1,10}$/;

const qrPayload: Validator<QrPayload> = obj({
  type: str(64, UR_TYPE),
  cbor: bytes(1, 262_144),
});

const deviceRequest: Validator<DeviceRequest> = union(
  obj({ kind: literal("qr"), show: opt(qrPayload), scan: arr(str(64, UR_TYPE), 4, 1) }),
  obj({ kind: literal("message"), data: bytes(1, 65_536) }),
  obj({
    kind: literal("compare"),
    address: str(128, /^.+$/),
    path: str(128, DERIVATION_PATH),
  }),
);

const deviceResponse: Validator<DeviceResponse> = union(
  obj({ kind: literal("qr"), ur: qrPayload }),
  obj({ kind: literal("message"), data: bytes(1, 65_536) }),
  obj({ kind: literal("compare"), matched: bool }),
);

const deviceDisplay: Validator<DeviceDisplay> = union(literal("clear"), literal("blind"));

const hardwareOperation: Validator<HardwareOperation> = union(
  obj({ kind: literal("pair"), device: hardwareDevice }),
  obj({
    kind: literal("accounts"),
    walletId,
    groupIndex,
    templates: arr(template, 7, 1),
    network: caip2,
  }),
  obj({ kind: literal("sign"), request: signRequest }),
  obj({
    kind: literal("verify-address"),
    walletId,
    groupIndex,
    template,
    network: caip2,
    index: opt(int(0, 0x7fffffff)),
  }),
);

const hardwareResult: Validator<HardwareResult> = union(
  obj({ kind: literal("pair"), wallet: walletInfo }),
  obj({ kind: literal("accounts"), accounts: arr(chainAccount, 64) }),
  obj({ kind: literal("sign"), result: signResult }),
  obj({
    kind: literal("verify-address"),
    address: str(128, /^.+$/),
    method: union(literal("device"), literal("compare")),
  }),
);

const hardwareStep: Validator<HardwareStep> = union(
  obj({
    kind: literal("exchange"),
    device: hardwareDevice,
    request: deviceRequest,
    display: opt(deviceDisplay),
  }),
  obj({ kind: literal("done"), result: hardwareResult }),
);

const opId: Validator<string> = str(32, /^[0-9a-f]{32}$/);

export const HARDWARE_METHODS: {
  readonly "hardware.begin": MethodSpec<
    { readonly op: HardwareOperation; readonly verify?: VerifyFactor },
    { readonly opId: string; readonly step: HardwareStep }
  >;
  readonly "hardware.step": MethodSpec<
    { readonly opId: string; readonly response: DeviceResponse },
    HardwareStep
  >;
  readonly "hardware.cancel": MethodSpec<{ readonly opId: string }, NullValue>;
} = {
  "hardware.begin": {
    session: true,
    presence: true,
    params: obj({ op: hardwareOperation, verify: opt(verifier) }),
    result: obj({ opId, step: hardwareStep }),
  },
  "hardware.step": {
    session: true,
    presence: true,
    params: obj({ opId, response: deviceResponse }),
    result: hardwareStep,
  },
  "hardware.cancel": {
    session: true,
    presence: false,
    params: obj({ opId }),
    result: nullValue,
  },
};
