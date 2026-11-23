/**
 * APDU command/response codec, the status-word allow-list, chunked transmission, the byte reader,
 * and the pinned dashboard commands.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  decodeResponse,
  encodeCommand,
  transmit,
  transmitChunks,
} from "../src/modules/ledger/protocol/apdu.ts";
import type { Command, Exchange } from "../src/modules/ledger/protocol/apdu.ts";
import { encodePath, Reader, u16, u32, u64, varint } from "../src/modules/ledger/protocol/bytes.ts";
import {
  LEDGER_APPS,
  openApp,
  quitApp,
  requireApp,
} from "../src/modules/ledger/protocol/device.ts";
import { LedgerError } from "../src/modules/ledger/protocol/errors.ts";
import { statusError } from "../src/modules/ledger/protocol/status.ts";

const code = async (job: Promise<unknown>): Promise<string> => {
  try {
    await job;
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    return (error as LedgerError).code;
  }
  throw new Error("expected LedgerError");
};

const cmd = (over: Partial<Command> = {}): Command => ({
  cla: 0xe0,
  ins: 0x02,
  p1: 0,
  p2: 0,
  data: new Uint8Array(0),
  ...over,
});

type AppPins = Partial<Record<string, { name?: unknown; version?: unknown }>>;

const isAppsDoc = (value: unknown): value is { apps: AppPins } =>
  typeof value === "object" && value !== null && "apps" in value;

const appPin = (app: string): { name?: unknown; version?: unknown } => {
  const parsed: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../scripts/ledger/apps.json", import.meta.url)),
      "utf8",
    ),
  );
  if (!isAppsDoc(parsed)) {
    throw new Error("apps.json: unexpected shape");
  }
  const pin = parsed.apps[app];
  if (pin === undefined) {
    throw new Error(`apps.json: missing ${app} pin`);
  }
  return pin;
};

/** Serves `replies` one exchange call at a time; an extra call rejects. */
const queueOf = (replies: Uint8Array[]) => async (): Promise<Uint8Array> => {
  const reply = replies.shift();
  return reply === undefined
    ? Promise.reject(new Error("unexpected call"))
    : Promise.resolve(reply);
};

describe("ledger apdu", () => {
  it("encodes commands with an always-present Lc", () => {
    expect([...encodeCommand(cmd())]).toStrictEqual([0xe0, 0x02, 0, 0, 0]);
    expect([...encodeCommand(cmd({ data: Uint8Array.of(1, 2, 3) }))]).toStrictEqual([
      0xe0, 0x02, 0, 0, 3, 1, 2, 3,
    ]);
    expect(encodeCommand(cmd({ data: new Uint8Array(255) }))).toHaveLength(260);
    expect(() => encodeCommand(cmd({ data: new Uint8Array(256) }))).toThrow(LedgerError);
    expect(() => encodeCommand(cmd({ cla: 256 }))).toThrow(LedgerError);
    expect(() => encodeCommand(cmd({ ins: -1 }))).toThrow(LedgerError);
    expect(() => encodeCommand(cmd({ p1: 1.5 }))).toThrow(LedgerError);
  });

  it("decodes responses into data and status word", () => {
    const r = decodeResponse(Uint8Array.of(0xaa, 0xbb, 0x90, 0x00));
    expect([...r.data]).toStrictEqual([0xaa, 0xbb]);
    expect(r.sw).toBe(0x9000);
    expect(decodeResponse(Uint8Array.of(0x90, 0x00)).data).toHaveLength(0);
    expect(() => decodeResponse(new Uint8Array(1))).toThrow(LedgerError);
    expect(() => decodeResponse(new Uint8Array(0))).toThrow(LedgerError);
  });

  it("maps every allowed status word and defaults the rest to device-fault", () => {
    const table: Array<[Parameters<typeof statusError>[0], number, string]> = [
      ["ethereum", 0x5515, "device-locked"],
      ["dashboard", 0x5515, "device-locked"],
      ["ethereum", 0x5501, "user-rejected"],
      ["ethereum", 0x6e00, "app-not-open"],
      ["solana", 0x6d00, "unsupported"],
      ["dashboard", 0x6807, "app-not-installed"],
      ["ethereum", 0x6985, "user-rejected"],
      ["solana", 0x6985, "user-rejected"],
      ["tron", 0x6985, "user-rejected"],
      ["solana", 0x6982, "user-rejected"],
      ["solana", 0x6808, "setting-required"],
      ["tron", 0x6a8b, "setting-required"],
      ["tron", 0x6a8c, "setting-required"],
      ["tron", 0x6a8d, "setting-required"],
      ["tron", 0x6a8e, "unsupported"],
      ["ethereum", 0x6a80, "device-fault"],
      ["ethereum", 0x1234, "device-fault"],
      ["dashboard", 0x6985, "device-fault"],
      ["bitcoin", 0x6a80, "device-fault"],
    ];
    for (const [app, sw, expected] of table) {
      const error = statusError(app, sw);
      expect(error.code, `sw ${sw.toString(16)}`).toBe(expected);
      expect(error.sw).toBe(sw);
    }
  });

  it("transmit returns data on 9000 and throws the mapped error otherwise", async () => {
    const ok = async () => Promise.resolve(Uint8Array.of(0xaa, 0x90, 0x00));
    expect([...(await transmit(ok, "ethereum", cmd()))]).toStrictEqual([0xaa]);
    const denied = async () => Promise.resolve(Uint8Array.of(0x69, 0x85));
    await expect(code(transmit(denied, "ethereum", cmd()))).resolves.toBe("user-rejected");
    const odd = async () => Promise.resolve(Uint8Array.of(0x6a, 0x8e));
    await expect(code(transmit(odd, "tron", cmd()))).resolves.toBe("unsupported");
  });

  it("transmitChunks rejects non-empty intermediate replies", async () => {
    const dirty = async () => Promise.resolve(Uint8Array.of(0xaa, 0x90, 0x00));
    await expect(code(transmitChunks(dirty, "ethereum", [cmd(), cmd({ ins: 3 })]))).resolves.toBe(
      "invalid-response",
    );
    const seq = queueOf([
      Uint8Array.of(0x90, 0x00),
      Uint8Array.of(0x90, 0x00),
      Uint8Array.of(0x77, 0x90, 0x00),
    ]);
    const out = await transmitChunks(seq, "ethereum", [cmd(), cmd(), cmd()]);
    expect([...out]).toStrictEqual([0x77]);
    await expect(code(transmitChunks(seq, "ethereum", []))).resolves.toBe("invalid-input");
  });
});

describe("ledger bytes", () => {
  it("writes big-endian integers", () => {
    expect([...u16(0x1234)]).toStrictEqual([0x12, 0x34]);
    expect([...u32(0x12345678)]).toStrictEqual([0x12, 0x34, 0x56, 0x78]);
    expect([...u64(0x0102030405060708n)]).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("writes CompactSize varints at every boundary", () => {
    expect([...varint(0xfc)]).toStrictEqual([0xfc]);
    expect([...varint(0xfd)]).toStrictEqual([0xfd, 0xfd, 0x00]);
    expect([...varint(0xffff)]).toStrictEqual([0xfd, 0xff, 0xff]);
    expect([...varint(0x1_00_00)]).toStrictEqual([0xfe, 0x00, 0x00, 0x01, 0x00]);
    expect([...varint(0xff_ff_ff_ff)]).toStrictEqual([0xfe, 0xff, 0xff, 0xff, 0xff]);
    expect([...varint(0x1_00_00_00_00)]).toStrictEqual([
      0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    ]);
    expect(() => varint(-1)).toThrow(LedgerError);
    expect(() => varint(1.5)).toThrow(LedgerError);
    expect(() => varint(Number.MAX_SAFE_INTEGER + 1)).toThrow(LedgerError);
  });

  it("encodes derivation paths within the depth bound", () => {
    expect([...encodePath([0x80_00_00_2c, 0x80_00_00_3c], 10)]).toStrictEqual([
      2, 0x80, 0, 0, 0x2c, 0x80, 0, 0, 0x3c,
    ]);
    expect(() => encodePath([], 10)).toThrow(LedgerError);
    expect(() => encodePath([0, 0, 0], 2)).toThrow(LedgerError);
    expect(() => encodePath([0x1_00_00_00_00], 10)).toThrow(LedgerError);
    expect(() => encodePath([-1], 10)).toThrow(LedgerError);
    expect(() => encodePath([1.5], 10)).toThrow(LedgerError);
  });

  it("reads u16/u32/bytes/lv/rest and refuses overruns and leftovers", () => {
    const r = new Reader(Uint8Array.of(0x12, 0x34, 0xaa, 0xbb, 0xcc, 0xdd, 2, 0xe0, 0xe1, 0x99));
    expect(r.u16()).toBe(0x1234);
    expect(r.u32()).toBe(0xaabbccdd);
    expect([...r.lv()]).toStrictEqual([0xe0, 0xe1]);
    expect([...r.rest()]).toStrictEqual([0x99]);
    r.end();
    const r2 = new Reader(Uint8Array.of(0x12, 0x34, 0x56));
    expect(r2.bytes(2)).toStrictEqual(Uint8Array.of(0x12, 0x34));
    expect(() => r2.u16()).toThrow(LedgerError);
    const r3 = new Reader(Uint8Array.of(0xaa, 0xbb));
    expect(r3.u8()).toBe(0xaa);
    expect(() => r3.end()).toThrow(LedgerError);
    expect(() => new Reader(new Uint8Array(0)).u32()).toThrow(LedgerError);
  });

  it("reads CompactSize varints and rejects unsafe counts", () => {
    expect(new Reader(Uint8Array.of(0x2a)).varint()).toBe(0x2a);
    expect(new Reader(Uint8Array.of(0xfd, 0x34, 0x12)).varint()).toBe(0x1234);
    expect(new Reader(Uint8Array.of(0xfe, 0x78, 0x56, 0x34, 0x12)).varint()).toBe(0x12345678);
    expect(
      new Reader(Uint8Array.of(0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00)).varint(),
    ).toBe(0x1_00_00_00_00);
    // count above u53 cannot be represented exactly
    expect(() =>
      new Reader(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)).varint(),
    ).toThrow(LedgerError);
    expect(() => new Reader(Uint8Array.of(0xfd)).varint()).toThrow(LedgerError);
  });
});

describe("ledger device", () => {
  /** Captures sent APDUs and serves canned replies. */
  const capture = (replies: Uint8Array[]): { ex: Exchange; sent: Uint8Array[] } => {
    const sent: Uint8Array[] = [];
    const ex: Exchange = async (apdu) => {
      sent.push(apdu);
      const reply = replies.shift();
      return reply === undefined
        ? Promise.reject(new Error("unexpected call"))
        : Promise.resolve(reply);
    };
    return { ex, sent };
  };

  it("sends the dashboard open-app and quit-app commands", async () => {
    const { ex, sent } = capture([Uint8Array.of(0x90, 0x00), Uint8Array.of(0x90, 0x00)]);
    await openApp(ex, "ethereum");
    await quitApp(ex);
    const name = [...new TextEncoder().encode("Ethereum")];
    expect(sent.map((a) => [...a])).toStrictEqual([
      [0xe0, 0xd8, 0, 0, name.length, ...name],
      [0xb0, 0xa7, 0, 0, 0],
    ]);
  });

  it("maps dashboard status words", async () => {
    const { ex } = capture([Uint8Array.of(0x68, 0x07)]);
    await expect(code(openApp(ex, "solana"))).resolves.toBe("app-not-installed");
  });

  it("requireApp enforces the pinned name and minimum version", () => {
    const info = (name: string, version: string): Parameters<typeof requireApp>[0] => ({
      name,
      version,
      flags: new Uint8Array(0),
    });
    expect(() => requireApp(info("Ethereum", "1.24.0"), "ethereum")).not.toThrow();
    expect(() => requireApp(info("Ethereum", "1.24.1"), "ethereum")).not.toThrow();
    expect(() => requireApp(info("Ethereum", "2.0.0"), "ethereum")).not.toThrow();
    expect(() => requireApp(info("Bitcoin", "1.24.0"), "ethereum")).toThrow(LedgerError);
    expect(() => requireApp(info("Ethereum", "1.23.9"), "ethereum")).toThrow(LedgerError);
    expect(() => requireApp(info("Ethereum", "1.24.0.1"), "ethereum")).toThrow(LedgerError);
    expect(() => requireApp(info("Ethereum", "1.24"), "ethereum")).toThrow(LedgerError);
  });

  it.each(["bitcoin", "ethereum", "solana", "tron"] as const)(
    "keeps LEDGER_APPS.%s in sync with the pinned apps.json",
    (app) => {
      const pin = appPin(app);
      expect(LEDGER_APPS[app].name).toBe(pin.name);
      expect(LEDGER_APPS[app].minimum.join(".")).toBe(pin.version);
    },
  );
});
