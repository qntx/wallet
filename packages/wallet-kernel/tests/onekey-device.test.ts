/** Features → DeviceInfo mapping and every initialize() refusal, over scripted exchanges. */
import { describe, expect, it } from "vite-plus/test";

import { initialize, supports } from "../src/modules/onekey/protocol/device.ts";
import type { DeviceInfo } from "../src/modules/onekey/protocol/device.ts";
import { OneKeyError } from "../src/modules/onekey/protocol/errors.ts";
import { decodeMessage, encodeMessage } from "../src/modules/onekey/protocol/frame.ts";
import { Features, Initialize } from "../src/modules/onekey/protocol/messages.ts";
import type { FeaturesFields } from "../src/modules/onekey/protocol/messages.ts";
import { decode, encode } from "../src/modules/onekey/protocol/proto.ts";
import type { Decoded } from "../src/modules/onekey/protocol/proto.ts";
import type { Exchange } from "../src/modules/onekey/protocol/session.ts";

const BASE: Decoded<FeaturesFields> = {
  majorVersion: 3,
  minorVersion: 21,
  patchVersion: 0,
  initialized: true,
  onekeyDeviceType: 1,
  onekeyFirmwareVersion: "3.21.0",
};

/** An exchange whose device answers any request with these Features. */
function device(features: Decoded<FeaturesFields>): Exchange {
  const answer = encodeMessage(Features.typeId, encode(Features, features));
  return async () => Promise.resolve(answer);
}

async function info(features: Decoded<FeaturesFields>): Promise<DeviceInfo> {
  return initialize(device(features));
}

/** The OneKeyError initialize() throws for these Features, or a hard failure when it does not. */
async function refusalError(features: Decoded<FeaturesFields>): Promise<OneKeyError> {
  try {
    await initialize(device(features));
  } catch (error) {
    if (error instanceof OneKeyError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected initialize to throw");
}

describe("initialize", () => {
  // The touch/pro firmware floor (4.5.0) is above the classic fixture version, so each row
  // carries the firmware it reports.
  const models: Array<[number, DeviceInfo["model"], string, readonly [number, number, number]]> = [
    [0, "classic", "3.21.0", [3, 21, 0]],
    [1, "classic1s", "3.21.0", [3, 21, 0]],
    [2, "mini", "3.21.0", [3, 21, 0]],
    [3, "touch", "4.21.0", [4, 21, 0]],
    [5, "pro", "4.21.0", [4, 21, 0]],
    [6, "pure", "3.21.0", [3, 21, 0]],
  ];

  it.each(models)("maps device type %i to %s", async (type, model, version, firmware) => {
    const result = await info({
      ...BASE,
      onekeyDeviceType: type,
      onekeyFirmwareVersion: version,
    });
    expect(result.model).toBe(model);
    expect(result.firmware).toStrictEqual(firmware);
  });

  it("takes the firmware version from onekey_version when 609 is absent", async () => {
    const result = await info({
      majorVersion: 4,
      minorVersion: 0,
      patchVersion: 1,
      initialized: true,
      onekeyDeviceType: 5,
      onekeyVersion: "4.21.0",
    });
    expect(result.firmware).toStrictEqual([4, 21, 0]);
  });

  it("accepts equal version fields", async () => {
    const result = await info({ ...BASE, onekeyVersion: "3.21.0" });
    expect(result.firmware).toStrictEqual([3, 21, 0]);
  });

  it("maps the remaining Feature fields", async () => {
    const sessionId = new Uint8Array(32).fill(0x11);
    const result = await info({
      ...BASE,
      deviceId: "F1E2",
      pinProtection: true,
      passphraseProtection: false,
      unlocked: true,
      capabilities: [1, 5, 7],
      sessionId,
    });
    expect(result.deviceId).toBe("F1E2");
    expect(result.pinProtection).toBe(true);
    expect(result.passphraseProtection).toBe(false);
    expect(result.unlocked).toBe(true);
    expect(result.sessionId).toStrictEqual(sessionId);
    expect(result.capabilities).toStrictEqual([1, 5, 7]);
  });

  it("marks a capability list without Bitcoin_like as bitcoinOnly", async () => {
    const withoutBitcoin = await info({ ...BASE, capabilities: [1, 5] });
    expect(withoutBitcoin.bitcoinOnly).toBe(true);
    const withBitcoin = await info({ ...BASE, capabilities: [1, 2] });
    expect(withBitcoin.bitcoinOnly).toBe(false);
    const noCapabilities = await info({ ...BASE });
    expect(noCapabilities.bitcoinOnly).toBe(false);
  });

  it("writes a single Initialize request carrying the session id", async () => {
    const sent: Uint8Array[] = [];
    const answer = encodeMessage(Features.typeId, encode(Features, BASE));
    const sessionId = new Uint8Array(32).fill(0x22);
    const exchange: Exchange = async (data) => {
      sent.push(new Uint8Array(data));
      return Promise.resolve(answer);
    };
    await initialize(exchange, sessionId);
    expect(sent).toHaveLength(1);
    const requests = sent.map((data) => decodeMessage(data));
    expect(requests.map((request) => request.type)).toStrictEqual([Initialize.typeId]);
    const sessionIds = requests.map((request) => decode(Initialize, request.payload).sessionId);
    expect(sessionIds).toStrictEqual([sessionId]);
  });
});

describe("initialize refusals", () => {
  it("refuses bootloader mode", async () => {
    const error = await refusalError({ ...BASE, bootloaderMode: true });
    expect(error.code).toBe("unsupported");
  });

  it("refuses an uninitialized device", async () => {
    const explicit = await refusalError({ ...BASE, initialized: false });
    expect(explicit.code).toBe("not-initialized");
    const absent = await refusalError({
      majorVersion: 3,
      minorVersion: 21,
      patchVersion: 0,
      onekeyDeviceType: 1,
      onekeyFirmwareVersion: "3.21.0",
    });
    expect(absent.code).toBe("not-initialized");
  });

  it("refuses a device without a OneKey model", async () => {
    const error = await refusalError({
      majorVersion: 3,
      minorVersion: 21,
      patchVersion: 0,
      initialized: true,
      onekeyFirmwareVersion: "3.21.0",
    });
    expect(error.code).toBe("unsupported");
  });

  it("refuses unknown device types", async () => {
    const four = await refusalError({ ...BASE, onekeyDeviceType: 4 });
    expect(four.code).toBe("unsupported");
    const ninetynine = await refusalError({ ...BASE, onekeyDeviceType: 99 });
    expect(ninetynine.code).toBe("unsupported");
  });

  it("refuses a device with no OneKey firmware version", async () => {
    const error = await refusalError({
      majorVersion: 3,
      minorVersion: 21,
      patchVersion: 0,
      initialized: true,
      onekeyDeviceType: 1,
    });
    expect(error.code).toBe("unsupported");
  });

  it("rejects conflicting version fields", async () => {
    const error = await refusalError({ ...BASE, onekeyVersion: "4.0.0" });
    expect(error.code).toBe("device-fault");
  });

  it("rejects a malformed version string", async () => {
    const short = await refusalError({ ...BASE, onekeyFirmwareVersion: "4.21" });
    expect(short.code).toBe("device-fault");
    const tagged = await refusalError({ ...BASE, onekeyFirmwareVersion: "v4.21.0" });
    expect(tagged.code).toBe("device-fault");
  });

  it("refuses firmware below the current-schema floor", async () => {
    // v1CurrentSchema starts at 3.3.0 for the classic family, 4.5.0 for touch/pro (SDK
    // MessagesConfig.ts).
    const classic = await refusalError({ ...BASE, onekeyFirmwareVersion: "3.2.0" });
    expect(classic.code).toBe("unsupported");
    const touch = await refusalError({
      ...BASE,
      onekeyDeviceType: 3,
      onekeyFirmwareVersion: "4.4.9",
    });
    expect(touch.code).toBe("unsupported");
    const floorClassic = await info({ ...BASE, onekeyFirmwareVersion: "3.3.0" });
    expect(floorClassic.firmware).toStrictEqual([3, 3, 0]);
    const floorPro = await info({
      ...BASE,
      onekeyDeviceType: 5,
      onekeyFirmwareVersion: "4.5.0",
    });
    expect(floorPro.firmware).toStrictEqual([4, 5, 0]);
  });
});

describe("supports", () => {
  const deviceInfo = (partial: Partial<DeviceInfo>): DeviceInfo => ({
    model: "classic1s",
    firmware: [3, 21, 0],
    deviceId: "",
    capabilities: [],
    bitcoinOnly: false,
    pinProtection: false,
    passphraseProtection: false,
    unlocked: true,
    sessionId: undefined,
    ...partial,
  });

  it("treats evm-1559 as unconditional at the initialize floor", () => {
    expect(supports(deviceInfo({ model: "mini", firmware: [3, 3, 0] }), "evm-1559")).toBe(true);
  });

  it("gates evm-7702 on model and firmware", () => {
    expect(supports(deviceInfo({ firmware: [3, 13, 0] }), "evm-7702")).toBe(true);
    expect(supports(deviceInfo({ firmware: [3, 12, 9] }), "evm-7702")).toBe(false);
    expect(supports(deviceInfo({ model: "pure", firmware: [3, 13, 0] }), "evm-7702")).toBe(true);
    expect(supports(deviceInfo({ model: "pro", firmware: [4, 16, 0] }), "evm-7702")).toBe(true);
    expect(supports(deviceInfo({ model: "pro", firmware: [4, 15, 9] }), "evm-7702")).toBe(false);
    expect(supports(deviceInfo({ model: "mini", firmware: [3, 21, 0] }), "evm-7702")).toBe(false);
    expect(supports(deviceInfo({ model: "touch", firmware: [4, 21, 0] }), "evm-7702")).toBe(false);
  });

  it("gates typed-data streaming on the classic family's capability", () => {
    const withCap = deviceInfo({ capabilities: [1000] });
    expect(supports(withCap, "evm-typed-data-stream")).toBe(true);
    expect(supports(deviceInfo({}), "evm-typed-data-stream")).toBe(false);
    expect(
      supports(deviceInfo({ model: "pro", firmware: [4, 21, 0] }), "evm-typed-data-stream"),
    ).toBe(true);
    expect(
      supports(deviceInfo({ model: "touch", firmware: [4, 21, 0] }), "evm-typed-data-stream"),
    ).toBe(true);
  });
});
