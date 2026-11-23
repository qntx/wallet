/**
 * `initialize` — the first call of every device operation (it also aborts any workflow the device
 * left pending). Maps Features onto DeviceInfo: the model comes from `onekey_device_type` (the
 * Trezor-compat `model` string does not name OneKey hardware), the firmware version from
 * `onekey_firmware_version`/`onekey_version` — `major/minor/patch` carry the Trezor-compat 2.99.99
 * on both firmwares (research.md "Device type"), not the OneKey release. A device that does not
 * identify itself as a OneKey V1 model, is in bootloader mode, or is not initialized is refused
 * with a typed error.
 */
import { OneKeyError } from "./errors.ts";
import { Features, Initialize } from "./messages.ts";
import type { Decoded } from "./proto.ts";
import { call } from "./session.ts";
import type { Exchange } from "./session.ts";

export type OneKeyModel = "classic" | "classic1s" | "pure" | "mini" | "touch" | "pro";

export type DeviceInfo = {
  readonly model: OneKeyModel;
  readonly firmware: readonly [number, number, number];
  /** Features.device_id — self-reported, display/routing only; trust comes from pinned keys. */
  readonly deviceId: string;
  /** Features.capabilities — the enum values the device advertises. */
  readonly capabilities: ReadonlyArray<number>;
  readonly bitcoinOnly: boolean;
  readonly pinProtection: boolean;
  readonly passphraseProtection: boolean;
  readonly unlocked: boolean;
  readonly sessionId: Uint8Array | undefined;
};

// OneKeyDeviceType enum values, common/protob/messages-management.proto in both schemas
// (classic1s additionally has TOUCH_PRO=4 deprecated and PURE=6).
function modelOf(code: number): OneKeyModel | undefined {
  switch (code) {
    case 0:
      return "classic";
    case 1:
      return "classic1s";
    case 2:
      return "mini";
    case 3:
      return "touch";
    case 5:
      return "pro";
    case 6:
      return "pure";
    default:
      return undefined;
  }
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function firmwareVersion(
  features: Decoded<typeof Features.fields>,
): readonly [number, number, number] {
  const { onekeyFirmwareVersion, onekeyVersion } = features;
  if (
    onekeyFirmwareVersion !== undefined &&
    onekeyVersion !== undefined &&
    onekeyFirmwareVersion !== onekeyVersion
  ) {
    throw new OneKeyError("device-fault", "conflicting firmware version fields");
  }
  const text = onekeyFirmwareVersion ?? onekeyVersion;
  if (text === undefined) {
    throw new OneKeyError("unsupported", "device does not report a OneKey firmware version");
  }
  const match = VERSION.exec(text);
  if (match === null) {
    throw new OneKeyError("device-fault", "malformed firmware version");
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 0xff_ff_ff_ff)) {
    throw new OneKeyError("device-fault", "malformed firmware version");
  }
  return [parts[0], parts[1], parts[2]];
}

// Capability_Bitcoin_like = 2 (common/protob/messages-management.proto, both schemas): a
// bitcoin-only build advertises its list without it.
const CAPABILITY_BITCOIN_LIKE = 2;

// Capability_EthereumTypedData = 1000 (messages-management.proto, both schemas): the classic
// family streams parsed EIP-712 structures only when it advertises this.
const CAPABILITY_ETHEREUM_TYPED_DATA = 1000;

export type OneKeyFeature =
  | "btc-bip322"
  | "evm-1559"
  | "evm-7702"
  | "evm-typed-data-stream"
  | "tron-message-v2";

const CLASSIC_FAMILY: ReadonlySet<OneKeyModel> = new Set(["classic", "classic1s", "pure", "mini"]);

const atLeast = (
  firmware: readonly [number, number, number],
  version: readonly [number, number, number],
): boolean =>
  firmware[0] === version[0]
    ? firmware[1] === version[1]
      ? firmware[2] >= version[2]
      : firmware[1] > version[1]
    : firmware[0] > version[0];

/**
 * Whether the device supports a feature the wire layer gates on. Table built from the SDK's
 * per-method version ranges (EVMSignTransaction.ts getVersionRange, EVMSignTypedData.ts
 * supportEip712OnClassic) — entries already implied by the initialize floor are unconditional.
 *
 * - `evm-1559`: the only SDK gate is model_mini ≥ 2.1.11, below the 3.3.0 floor.
 * - `evm-7702`: classic1s/pure ≥ 3.13.0, pro ≥ 4.16.0, never on the other models.
 * - `evm-typed-data-stream`: classic family needs Capability_EthereumTypedData (1000); touch/pro
 *   stream unconditionally.
 * - `tron-message-v2`: classic ≥ 3.12.0, classic1s/pure ≥ 3.13.0, touch ≥ 4.12.0, pro ≥ 4.16.0, never
 *   on mini (SDK api/tron/TronSignMessage.ts getVersionRange).
 */
// oxlint-disable-next-line typescript/consistent-return -- every feature returns above
export function supports(info: DeviceInfo, feature: OneKeyFeature): boolean {
  switch (feature) {
    case "btc-bip322":
      // SDK api/btc/BTCSignMessage.ts: BIP-322 simple signing is pro-only from 4.9.3.
      return info.model === "pro" && atLeast(info.firmware, [4, 9, 3]);
    case "evm-1559":
      return true;
    case "evm-7702":
      if (info.model === "classic1s" || info.model === "pure") {
        return atLeast(info.firmware, [3, 13, 0]);
      }
      return info.model === "pro" && atLeast(info.firmware, [4, 16, 0]);
    case "evm-typed-data-stream":
      return CLASSIC_FAMILY.has(info.model)
        ? info.capabilities.includes(CAPABILITY_ETHEREUM_TYPED_DATA)
        : true;
    case "tron-message-v2":
      switch (info.model) {
        case "classic":
          return atLeast(info.firmware, [3, 12, 0]);
        case "classic1s":
        case "pure":
          return atLeast(info.firmware, [3, 13, 0]);
        case "touch":
          return atLeast(info.firmware, [4, 12, 0]);
        case "pro":
          return atLeast(info.firmware, [4, 16, 0]);
        case "mini":
          return false;
      }
  }
}

export async function initialize(exchange: Exchange, sessionId?: Uint8Array): Promise<DeviceInfo> {
  const features = await call(
    exchange,
    { def: Initialize, value: sessionId === undefined ? {} : { sessionId } },
    Features,
  );
  if (features.bootloaderMode === true) {
    throw new OneKeyError("unsupported", "device is in bootloader mode");
  }
  if (features.onekeyDeviceType === undefined) {
    throw new OneKeyError("unsupported", "device does not report a OneKey model");
  }
  const model = modelOf(features.onekeyDeviceType);
  if (model === undefined) {
    throw new OneKeyError("unsupported", "unknown OneKey device type");
  }
  const firmware = firmwareVersion(features);
  if (features.initialized !== true) {
    throw new OneKeyError("not-initialized", "device has no wallet loaded");
  }
  // Older firmware speaks the legacy V1 schema the client does not implement (SDK
  // MessagesConfig.ts: v1CurrentSchema starts at 3.3.0 for the classic family, 4.5.0 for
  // touch/pro).
  const floor: readonly [number, number, number] = CLASSIC_FAMILY.has(model)
    ? [3, 3, 0]
    : [4, 5, 0];
  if (!atLeast(firmware, floor)) {
    throw new OneKeyError("unsupported", "firmware speaks a legacy message schema");
  }
  const { capabilities } = features;
  return {
    model,
    firmware,
    deviceId: features.deviceId ?? "",
    capabilities: capabilities ?? [],
    bitcoinOnly: capabilities !== undefined && !capabilities.includes(CAPABILITY_BITCOIN_LIKE),
    pinProtection: features.pinProtection ?? false,
    passphraseProtection: features.passphraseProtection ?? false,
    unlocked: features.unlocked ?? false,
    sessionId: features.sessionId,
  };
}
