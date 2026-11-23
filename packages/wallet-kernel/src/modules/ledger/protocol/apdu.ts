/**
 * Short-APDU codec and the exchange primitive every app call is built on
 * (ledger-app-solana/doc/api.md "APDU Command payload encoding").
 *
 * Wire command: `CLA ‖ INS ‖ P1 ‖ P2 ‖ Lc ‖ data` — Lc is always present, data ≤ 255 bytes. Wire
 * response: `data ‖ SW(2)` — the transport layer's length prefix is stripped before this.
 */
import { input } from "./bytes.ts";
import { LedgerError } from "./errors.ts";
import type { LedgerApp } from "./status.ts";
import { statusError } from "./status.ts";

export type Command = {
  readonly cla: number;
  readonly ins: number;
  readonly p1: number;
  readonly p2: number;
  readonly data: Uint8Array;
};

/** Raw APDU bytes → raw response bytes (`data ‖ SW`), transport supplied by the host. */
export type Exchange = (apdu: Uint8Array) => Promise<Uint8Array>;

const byte = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
    throw input("APDU header field is not a byte");
  }
};

export function encodeCommand(command: Command): Uint8Array {
  const { cla, ins, p1, p2, data } = command;
  for (const field of [cla, ins, p1, p2]) {
    byte(field);
  }
  if (data.length > 0xff) {
    throw input("APDU data exceeds 255 bytes");
  }
  const out = new Uint8Array(5 + data.length);
  out.set([cla, ins, p1, p2, data.length]);
  out.set(data, 5);
  return out;
}

export function decodeResponse(bytes: Uint8Array): {
  readonly data: Uint8Array;
  readonly sw: number;
} {
  if (bytes.length < 2) {
    throw new LedgerError("transport", "response is shorter than a status word");
  }
  return {
    data: bytes.subarray(0, -2),
    sw: new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 2, 2).getUint16(0),
  };
}

/** One command → its data, or the LedgerError the status word maps to. */
export async function transmit(
  exchange: Exchange,
  app: LedgerApp | "dashboard",
  command: Command,
): Promise<Uint8Array> {
  const { data, sw } = decodeResponse(await exchange(encodeCommand(command)));
  if (sw !== 0x9000) {
    throw statusError(app, sw);
  }
  return data;
}

/**
 * A multi-chunk command sequence: every non-last reply must be `9000` with empty data
 * (ledger-app-ethereum/doc/apdu.md "streamed to the device in 255 bytes maximum data chunks"); a
 * non-empty intermediate reply is `invalid-response`. Returns the last reply's data.
 */
export async function transmitChunks(
  exchange: Exchange,
  app: LedgerApp | "dashboard",
  commands: ReadonlyArray<Command>,
): Promise<Uint8Array> {
  const last = commands.at(-1);
  if (last === undefined) {
    throw input("empty command sequence");
  }
  for (const command of commands.slice(0, -1)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks are ordered on one link
    const data = await transmit(exchange, app, command);
    if (data.length > 0) {
      throw new LedgerError("invalid-response", "an intermediate chunk returned data");
    }
  }
  return transmit(exchange, app, last);
}
