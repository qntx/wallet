/**
 * The host-side Ledger link: framed exchanges over fake HID/BLE ports (one exchange at a time, the
 * BLE MTU handshake) and the `ledgerIo` DeviceIo adapter that carries `message` requests and
 * refuses every other kind.
 */

import { describe, expect, it } from "vite-plus/test";

import { ledgerBleExchange, ledgerHidExchange, ledgerIo } from "../src/hardware/ledger.ts";
import type { LedgerBlePort, LedgerHidPort } from "../src/hardware/ledger.ts";
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

/** A LedgerHidPort that records writes and serves the queued reads (then errors on exhaustion). */
const hidQueue = (reads: Uint8Array[]): { port: LedgerHidPort; written: Uint8Array[] } => {
  const written: Uint8Array[] = [];
  return {
    written,
    port: {
      write: async (report) => {
        written.push(report);
        return Promise.resolve();
      },
      read: async () => {
        const frame = reads.shift();
        return frame === undefined
          ? Promise.reject(new Error("unexpected read"))
          : Promise.resolve(frame);
      },
    },
  };
};

/** A LedgerBlePort that records writes and serves the queued reads (then errors on exhaustion). */
const bleQueue = (reads: Uint8Array[]): { port: LedgerBlePort; written: Uint8Array[] } => {
  const written: Uint8Array[] = [];
  return {
    written,
    port: {
      write: async (frame) => {
        written.push(frame);
        return Promise.resolve();
      },
      read: async () => {
        const frame = reads.shift();
        return frame === undefined
          ? Promise.reject(new Error("unexpected read"))
          : Promise.resolve(frame);
      },
    },
  };
};

/** A LedgerBlePort that answers the MTU handshake, then leaves every later read pending. */
const bleMtuThenHang = (): LedgerBlePort => {
  let reads = 0;
  return {
    write: async () => Promise.resolve(),
    read: async () => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve(Uint8Array.of(0x08, 0, 0, 0, 3, 32));
      }
      return new Promise<Uint8Array>(() => {});
    },
  };
};

describe("ledger link", () => {
  it("exchanges APDUs over a fake HID port and forbids interleaving", async () => {
    const channel = 0x2a3f;
    // one 64-byte response frame: channel ‖ 05 ‖ seq 0 ‖ len 2 ‖ 90 00 ‖ pad
    const frame = new Uint8Array(64);
    frame.set([Math.floor(channel / 256), channel % 256, 0x05, 0, 0, 0, 2, 0x90, 0]);
    const { port, written } = hidQueue([frame]);
    const exchange = ledgerHidExchange(port, channel);
    const response = await exchange(Uint8Array.of(0xe0, 0x01, 0, 0, 0));
    expect([...response]).toStrictEqual([0x90, 0]);
    expect(written).toHaveLength(1);
  });

  it("forbids a second exchange while one is in flight", async () => {
    const slow: LedgerHidPort = {
      write: async () => Promise.resolve(),
      read: async () => new Promise<Uint8Array>(() => {}),
    };
    const slowExchange = ledgerHidExchange(slow, 1);
    const first = slowExchange(Uint8Array.of(0xe0, 0x01, 0, 0, 0));
    void first.catch(() => {});
    await expect(code(slowExchange(Uint8Array.of(0xe0, 0x01, 0, 0, 0)))).resolves.toBe(
      "invalid-input",
    );
  });

  it("runs the BLE MTU handshake before framing", async () => {
    const { port, written } = bleQueue([
      Uint8Array.of(0x08, 0, 0, 0, 3, 32), // mtu answer: 32
      Uint8Array.of(0x05, 0, 0, 0, 2, 0x90, 0x00), // assembled response: 9000
    ]);
    const exchange = await ledgerBleExchange(port);
    expect(written.map((f) => [...f])).toStrictEqual([[0x08, 0, 0, 0, 0]]);
    const response = await exchange(Uint8Array.of(0xe0, 0x01, 0, 0, 0));
    expect([...response]).toStrictEqual([0x90, 0x00]);
    // every written frame fits the negotiated mtu
    for (const f of written.slice(1)) {
      expect(f.length).toBeLessThanOrEqual(32);
    }
  });

  it("rejects out-of-range HID channels", () => {
    const { port } = hidQueue([]);
    expect(() => ledgerHidExchange(port, -1)).toThrow(WalletError);
    expect(() => ledgerHidExchange(port, 0x1_00_00)).toThrow(WalletError);
    expect(() => ledgerHidExchange(port, 1.5)).toThrow(WalletError);
  });

  it("forbids a second BLE exchange while one is in flight", async () => {
    const exchange = await ledgerBleExchange(bleMtuThenHang());
    const first = exchange(Uint8Array.of(0xe0, 0x01, 0, 0, 0));
    void first.catch(() => {});
    await expect(code(exchange(Uint8Array.of(0xe0, 0x01, 0, 0, 0)))).resolves.toBe("invalid-input");
  });
});

describe("ledgerIo", () => {
  const apdu = async (request: Uint8Array): Promise<Uint8Array> =>
    Promise.resolve(Uint8Array.from([...request, 0x90, 0x00]));

  it("answers message requests with the APDU response", async () => {
    const io = ledgerIo(apdu);
    const response = await io.exchange(
      { kind: "message", data: Uint8Array.of(0xb0, 0x01) },
      { device: "ledger" },
    );
    expect(response).toStrictEqual({
      kind: "message",
      data: Uint8Array.of(0xb0, 0x01, 0x90, 0x00),
    });
  });

  it("rejects qr and compare requests with unsupported", async () => {
    const io = ledgerIo(apdu);
    const qr: DeviceRequest = { kind: "qr", scan: ["crypto-psbt"] };
    const compare: DeviceRequest = {
      kind: "compare",
      address: "bc1qexampleaddress000000000000000000000",
      path: "m/84'/0'/0'/0/0",
    };
    await expect(code(io.exchange(qr, { device: "ledger" }))).resolves.toBe("unsupported");
    await expect(code(io.exchange(compare, { device: "ledger" }))).resolves.toBe("unsupported");
  });

  it("propagates underlying exchange errors", async () => {
    const failing = ledgerIo(async () =>
      Promise.reject(new WalletError("integrity", "link dropped")),
    );
    await expect(
      code(failing.exchange({ kind: "message", data: Uint8Array.of(1) }, { device: "ledger" })),
    ).resolves.toBe("integrity");
  });
});
