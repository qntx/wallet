/**
 * Test-only UDP harness for the OneKey emulators. Both emulator images speak protocol V1 over
 * datagrams: the main link (default 54935) is one `Exchange` — each 64-byte report of the request
 * goes out as one datagram and the device answers with the report sequence of one message; the
 * debug link (default 54936) presses buttons via DebugLinkDecision.
 */
import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";

import { REPORT_SIZE } from "../../src/modules/onekey/protocol/frame.ts";
import type { Exchange } from "../../src/modules/onekey/protocol/session.ts";

const TIMEOUT_MS = 10_000;

/** Bytes a complete device response occupies once the first report's length is known. */
function expectedLength(report: Uint8Array): number | undefined {
  if (
    report.length !== REPORT_SIZE ||
    report[0] !== 0x3f ||
    report[1] !== 0x23 ||
    report[2] !== 0x23
  ) {
    return undefined;
  }
  const length = new DataView(report.buffer, report.byteOffset + 5, 4).getUint32(0);
  return REPORT_SIZE * Math.max(1, Math.ceil((8 + length) / 63));
}

/**
 * An Exchange over UDP datagrams. Writes every 64-byte report as one datagram, then gathers
 * datagrams until the first report's declared length is satisfied.
 */
export function udpExchange(host: string, port: number): Exchange & { close: () => void } {
  const socket: Socket = createSocket("udp4");
  const exchange: Exchange & { close: () => void } = async (
    data: Uint8Array,
  ): Promise<Uint8Array> => {
    for (let offset = 0; offset < data.length; offset += REPORT_SIZE) {
      socket.send(data.subarray(offset, offset + REPORT_SIZE), port, host);
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    let wanted = -1;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("message", onMessage);
        reject(new Error("emulator response timed out"));
      }, TIMEOUT_MS);
      const onMessage = (chunk: Uint8Array): void => {
        chunks.push(new Uint8Array(chunk));
        received += chunk.length;
        if (wanted < 0) {
          const expected = expectedLength(chunk);
          if (expected === undefined) {
            done(new Error("emulator sent a malformed first report"));
            return;
          }
          wanted = expected;
        }
        if (received >= wanted) {
          const out = new Uint8Array(wanted);
          let at = 0;
          for (const part of chunks) {
            out.set(part.subarray(0, Math.min(part.length, wanted - at)), at);
            at += part.length;
          }
          done(undefined, out);
        }
      };
      const done = (error: Error | undefined, out?: Uint8Array): void => {
        clearTimeout(timer);
        socket.off("message", onMessage);
        if (error === undefined) {
          resolve(out ?? new Uint8Array());
        } else {
          reject(error);
        }
      };
      socket.on("message", onMessage);
    });
  };
  exchange.close = () => {
    socket.close();
  };
  return exchange;
}

/** Presses YES on the debug link (DebugLinkDecision button=1; payload `08 01`). */
export async function debugYes(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.send(
      Uint8Array.from([0x3f, 0x23, 0x23, 0x00, 0x64, 0x00, 0x00, 0x00, 0x02, 0x08, 0x01]),
      port,
      host,
      (error) => {
        socket.close();
        if (error === null) {
          resolve();
        } else {
          reject(error);
        }
      },
    );
  });
}
