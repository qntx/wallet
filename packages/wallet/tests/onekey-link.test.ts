/**
 * The host-side OneKey link: Protocol-V1 exchanges over fake HID/BLE ports (report sequences, stale
 * padding, MTU splitting, one exchange at a time) and the `oneKeyIo` DeviceIo adapter that carries
 * `message` requests and refuses every other kind.
 */

import { describe, expect, it } from "vite-plus/test";

import {
  oneKeyAnswerLength,
  oneKeyBleExchange,
  oneKeyHidExchange,
  oneKeyIo,
} from "../src/hardware/onekey.ts";
import type { BlePort, HidPort } from "../src/hardware/ports.ts";
import type { DeviceRequest } from "../src/protocol/hardware.ts";
import { WalletError } from "../src/types.ts";

const code = async (job: Promise<unknown>): Promise<string> => {
  try {
    await job;
  } catch (error) {
    expect(error).toBeInstanceOf(WalletError);
    return (error as WalletError).code;
  }
  throw new Error("expected WalletError");
};

/** A HidPort that records writes and serves the queued reads (then errors on exhaustion). */
const hidQueue = (reads: Uint8Array[]): { port: HidPort; written: Uint8Array[] } => {
  const written: Uint8Array[] = [];
  return {
    written,
    port: {
      write: async (report) => {
        written.push(report);
        return Promise.resolve();
      },
      read: async () => {
        const chunk = reads.shift();
        return chunk === undefined
          ? Promise.reject(new Error("unexpected read"))
          : Promise.resolve(chunk);
      },
    },
  };
};

/** A BlePort that records writes and serves the queued reads (then errors on exhaustion). */
const bleQueue = (reads: Uint8Array[]): { port: BlePort; written: Uint8Array[] } => {
  const written: Uint8Array[] = [];
  return {
    written,
    port: {
      write: async (frame) => {
        written.push(frame);
        return Promise.resolve();
      },
      read: async () => {
        const chunk = reads.shift();
        return chunk === undefined
          ? Promise.reject(new Error("unexpected read"))
          : Promise.resolve(chunk);
      },
    },
  };
};

/** A 64-byte USB report: `3f 23 23` ‖ type ‖ BE u32 length ‖ payload ‖ padding. */
const report = (length: number, fill = 0xab, offset = 0): Uint8Array => {
  const out = new Uint8Array(64);
  out.set([0x3f, 0x23, 0x23, 0, 0]);
  new DataView(out.buffer).setUint32(5, length);
  out.fill(fill, 9 + offset);
  return out;
};

describe("onekey link", () => {
  it("writes the request report by report and hands back the whole answer sequence", async () => {
    const answer = report(3);
    const { port, written } = hidQueue([answer]);
    const exchange = oneKeyHidExchange(port);
    const request = new Uint8Array(128).fill(0x55); // two reports
    const response = await exchange(request);
    expect(written).toHaveLength(2);
    expect(written[0]).toStrictEqual(request.subarray(0, 64));
    expect(response).toStrictEqual(answer);
  });

  it("collects continuation reports and ignores the stale final padding", async () => {
    // payload of 118 bytes: 55 in the first report, 63 in one continuation → two reports
    const first = report(118);
    const second = new Uint8Array(64).fill(0x3f);
    second[64 - 1] = 0xde; // stale padding byte — ignored, the declared length governs
    const { port } = hidQueue([first, second]);
    const exchange = oneKeyHidExchange(port);
    const response = await exchange(new Uint8Array(64).fill(1));
    expect(response).toStrictEqual(new Uint8Array([...first, ...second]));
  });

  it("refuses a request that is not a whole number of HID reports", async () => {
    const { port } = hidQueue([]);
    const exchange = oneKeyHidExchange(port);
    await expect(code(exchange(new Uint8Array(63)))).resolves.toBe("invalid-input");
    await expect(code(exchange(new Uint8Array(0)))).resolves.toBe("invalid-input");
  });

  it("forbids a second HID exchange while one is in flight", async () => {
    const slow: HidPort = {
      write: async () => Promise.resolve(),
      read: async () => new Promise<Uint8Array>(() => {}),
    };
    const exchange = oneKeyHidExchange(slow);
    const first = exchange(new Uint8Array(64).fill(1));
    void first.catch(() => {});
    await expect(code(exchange(new Uint8Array(64).fill(1)))).resolves.toBe("invalid-input");
  });

  it("splits the report sequence into writes of at most the MTU over BLE", async () => {
    const stream = new Uint8Array(40);
    stream.set([0x3f, 0x23, 0x23, 0, 0]);
    new DataView(stream.buffer).setUint32(5, 31); // 9 + 31 = 40
    stream.fill(0x77, 9);
    const { port, written } = bleQueue([stream]);
    const exchange = oneKeyBleExchange(port, 30);
    const response = await exchange(new Uint8Array(128).fill(0x55));
    expect(written.map((f) => f.length)).toStrictEqual([30, 30, 30, 30, 8]);
    expect(response).toStrictEqual(stream);
  });

  it("concatenates BLE notifications into the announced stream", async () => {
    const first = new Uint8Array(20);
    first.set([0x3f, 0x23, 0x23, 0, 0]);
    new DataView(first.buffer).setUint32(5, 20); // 9 + 20 = 29 bytes total
    first.fill(0x11, 9);
    const second = new Uint8Array(9).fill(0x22);
    const { port } = bleQueue([first, second]);
    const exchange = oneKeyBleExchange(port, 20);
    const response = await exchange(new Uint8Array(64).fill(1));
    expect(response).toStrictEqual(new Uint8Array([...first, ...second]));
  });

  it("forbids a second BLE exchange while one is in flight", async () => {
    const hang: BlePort = {
      write: async () => Promise.resolve(),
      read: async () => new Promise<Uint8Array>(() => {}),
    };
    const exchange = oneKeyBleExchange(hang, 20);
    const first = exchange(new Uint8Array(64).fill(1));
    void first.catch(() => {});
    await expect(code(exchange(new Uint8Array(64).fill(1)))).resolves.toBe("invalid-input");
  });

  it("rejects a first answer chunk that is not a OneKey frame", async () => {
    const { port } = hidQueue([new Uint8Array(64).fill(0)]);
    const exchange = oneKeyHidExchange(port);
    await expect(code(exchange(new Uint8Array(64).fill(1)))).resolves.toBe("invalid-input");

    const { port: ble } = bleQueue([new Uint8Array(8).fill(0x3f)]);
    const bleExchange = oneKeyBleExchange(ble, 20);
    await expect(code(bleExchange(new Uint8Array(64).fill(1)))).resolves.toBe("invalid-input");
  });

  it("rejects a first HID report that is not 64 bytes as integrity", async () => {
    const { port } = hidQueue([report(3).subarray(0, 63)]);
    const exchange = oneKeyHidExchange(port);
    await expect(code(exchange(new Uint8Array(64).fill(1)))).resolves.toBe("integrity");
  });

  it("rejects a continuation HID report that is not 64 bytes as integrity", async () => {
    const { port } = hidQueue([report(118), new Uint8Array(32)]);
    const exchange = oneKeyHidExchange(port);
    await expect(code(exchange(new Uint8Array(64).fill(1)))).resolves.toBe("integrity");
  });

  it("rejects a BLE stream that runs past the announced length as integrity", async () => {
    const first = new Uint8Array(20);
    first.set([0x3f, 0x23, 0x23, 0, 0]);
    new DataView(first.buffer).setUint32(5, 20); // announces 29 bytes
    const { port } = bleQueue([first, new Uint8Array(20).fill(0x22)]);
    const exchange = oneKeyBleExchange(port, 20);
    await expect(code(exchange(new Uint8Array(64).fill(1)))).resolves.toBe("integrity");
  });

  it("rejects an empty BLE notification as integrity", async () => {
    const first = new Uint8Array(20);
    first.set([0x3f, 0x23, 0x23, 0, 0]);
    new DataView(first.buffer).setUint32(5, 20); // announces 29 bytes
    const { port } = bleQueue([first, new Uint8Array(0)]);
    const exchange = oneKeyBleExchange(port, 20);
    await expect(code(exchange(new Uint8Array(64).fill(1)))).resolves.toBe("integrity");
  });
});

describe("oneKeyAnswerLength", () => {
  const chunk = (length: number, magic: ReadonlyArray<number> = [0x3f, 0x23, 0x23]): Uint8Array => {
    const out = new Uint8Array(64);
    out.set(magic);
    new DataView(out.buffer).setUint32(5, length);
    return out;
  };

  it("counts whole USB reports: 55 payload bytes in the first, 63 in each continuation", () => {
    for (const [length, expected] of [
      [0, 64],
      [55, 64],
      [56, 128],
      [118, 128],
      [119, 192],
    ] as const) {
      expect(oneKeyAnswerLength(chunk(length), "usb")).toBe(expected);
    }
  });

  it("is the BLE stream length: header plus the contiguous payload", () => {
    for (const length of [0, 55, 119, 1000]) {
      expect(oneKeyAnswerLength(chunk(length), "ble")).toBe(9 + length);
    }
  });

  it("rejects a chunk without the OneKey magic or shorter than the header", () => {
    for (const bad of [chunk(0, [0x00, 0x23, 0x23]), chunk(0).subarray(0, 8)]) {
      expect(() => oneKeyAnswerLength(bad, "usb")).toThrow(
        expect.objectContaining({ code: "invalid-input" }) as Error,
      );
    }
  });
});

describe("oneKeyIo", () => {
  const echo = async (request: Uint8Array): Promise<Uint8Array> =>
    Promise.resolve(Uint8Array.from([...request, 0xaa]));

  it("answers message requests with the device response", async () => {
    const io = oneKeyIo(echo);
    const response = await io.exchange(
      { kind: "message", data: Uint8Array.of(0x3f, 0x23) },
      { device: "onekey" },
    );
    expect(response).toStrictEqual({
      kind: "message",
      data: Uint8Array.of(0x3f, 0x23, 0xaa),
    });
  });

  it("rejects qr and compare requests with unsupported", async () => {
    const io = oneKeyIo(echo);
    const qr: DeviceRequest = { kind: "qr", scan: ["crypto-psbt"] };
    const compare: DeviceRequest = {
      kind: "compare",
      address: "bc1qexampleaddress000000000000000000000",
      path: "m/84'/0'/0'/0/0",
    };
    await expect(code(io.exchange(qr, { device: "onekey" }))).resolves.toBe("unsupported");
    await expect(code(io.exchange(compare, { device: "onekey" }))).resolves.toBe("unsupported");
  });

  it("propagates underlying exchange errors", async () => {
    const failing = oneKeyIo(async () =>
      Promise.reject(new WalletError("integrity", "link dropped")),
    );
    await expect(
      code(failing.exchange({ kind: "message", data: Uint8Array.of(1) }, { device: "onekey" })),
    ).resolves.toBe("integrity");
  });
});
