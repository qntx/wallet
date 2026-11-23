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
  const { capabilities } = features;
  return {
    model,
    firmware,
    deviceId: features.deviceId ?? "",
    bitcoinOnly: capabilities !== undefined && !capabilities.includes(CAPABILITY_BITCOIN_LIKE),
    pinProtection: features.pinProtection ?? false,
    passphraseProtection: features.passphraseProtection ?? false,
    unlocked: features.unlocked ?? false,
    sessionId: features.sessionId,
  };
}
