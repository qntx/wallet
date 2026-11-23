/** Features → DeviceInfo mapping and every initialize() refusal, over scripted exchanges. */
import { describe, expect, it } from "vite-plus/test";

import { initialize } from "../src/modules/onekey/protocol/device.ts";
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
  const models: Array<[number, DeviceInfo["model"]]> = [
    [0, "classic"],
    [1, "classic1s"],
    [2, "mini"],
    [3, "touch"],
    [5, "pro"],
    [6, "pure"],
  ];

  it.each(models)("maps device type %i to %s", async (type, model) => {
    const result = await info({ ...BASE, onekeyDeviceType: type });
    expect(result.model).toBe(model);
    expect(result.firmware).toStrictEqual([3, 21, 0]);
  });

  it("takes the firmware version from onekey_version when 609 is absent", async () => {
    const result = await info({
      majorVersion: 4,
      minorVersion: 0,
      patchVersion: 1,
      initialized: true,
      onekeyDeviceType: 5,
      onekeyVersion: "4.0.1",
    });
    expect(result.firmware).toStrictEqual([4, 0, 1]);
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
});
