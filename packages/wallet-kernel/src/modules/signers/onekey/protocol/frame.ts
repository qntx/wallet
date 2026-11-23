/**
 * Protocol V1 message framing (firmware `common/protob/protocol.md`). Host→device bytes are a
 * sequence of 64-byte reports — `3f 23 23` + BE u16 type + BE u32 length + 55 payload bytes on the
 * first, `3f` + 63 payload bytes on each continuation — for both transports (the BLE chip consumes
 * concatenated reports inside any GATT write; research.md "BLE host→device"). Device→host bytes
 * come in two forms the same function detects structurally: the BLE stream (`3f 23 23` + type +
 * length + contiguous payload, reassembled by the host from notifications) and the USB report
 * sequence above. The forms never conflict: m USB reports carry at most 64m − m − 8 payload bytes,
 * so a USB sequence of length 64m = 9 + L would need L = 64m − 9 ≤ 64m − m − 8, i.e. m ≤ 1 — and at
 * m = 1 the two forms are byte-identical.
 */
import { OneKeyError } from "./errors.ts";

export const REPORT_SIZE = 64;
// The signer foundation caps an exchange at 65 536 bytes total (hw-signers DeviceRequest/
// DeviceResponse data). The largest payload whose report sequence fits is 1024 reports × 63
// payload bytes − the 8-byte header = 64 504.
export const MAX_MESSAGE = 64_504;

const MAGIC0 = 0x3f;
const MAGIC1 = 0x23;
const MAGIC2 = 0x23;
const FIRST_PAYLOAD = REPORT_SIZE - 9;
const CONT_PAYLOAD = REPORT_SIZE - 1;

export type Message = { readonly type: number; readonly payload: Uint8Array };

const frame = (message: string): OneKeyError => new OneKeyError("frame", message);

/** Report count a payload of `length` bytes occupies. */
function reportCount(length: number): number {
  return Math.max(1, Math.ceil((8 + length) / CONT_PAYLOAD));
}

/** Encodes one logical message as the concatenated V1 reports both transports send. */
export function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(type) || type < 0 || type > 0xffff) {
    throw new OneKeyError("invalid-input", "message type id out of range");
  }
  if (payload.length > MAX_MESSAGE) {
    throw new OneKeyError("invalid-input", "message payload too large");
  }
  const reports = reportCount(payload.length);
  const out = new Uint8Array(REPORT_SIZE * reports);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = MAGIC2;
  const view = new DataView(out.buffer);
  view.setUint16(3, type);
  view.setUint32(5, payload.length);
  let written = 0;
  for (let r = 0; r < reports; r++) {
    const base = r * REPORT_SIZE;
    if (r > 0) {
      out[base] = MAGIC0;
    }
    const offset = r === 0 ? base + 9 : base + 1;
    const take = Math.min(payload.length - written, r === 0 ? FIRST_PAYLOAD : CONT_PAYLOAD);
    out.set(payload.subarray(written, written + take), offset);
    written += take;
  }
  return out;
}

/** Decodes device→host bytes in either the BLE stream or USB report form (see file note). */
export function decodeMessage(data: Uint8Array): Message {
  if (data.length < 9 || data[0] !== MAGIC0 || data[1] !== MAGIC1 || data[2] !== MAGIC2) {
    throw frame("missing report magic");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  const length = view.getUint32(5);
  if (length > MAX_MESSAGE) {
    throw frame("message length exceeds the maximum");
  }
  const type = view.getUint16(3);
  if (data.length === 9 + length) {
    // BLE stream form: header + contiguous payload, nothing else.
    return { type, payload: data.slice(9) };
  }
  const reports = reportCount(length);
  if (data.length !== REPORT_SIZE * reports) {
    throw frame("report count does not match the declared length");
  }
  const gathered = new Uint8Array(FIRST_PAYLOAD + CONT_PAYLOAD * (reports - 1));
  gathered.set(data.subarray(9, REPORT_SIZE), 0);
  for (let r = 1; r < reports; r++) {
    const base = r * REPORT_SIZE;
    if (data[base] !== MAGIC0) {
      throw frame("missing continuation magic");
    }
    gathered.set(
      data.subarray(base + 1, base + REPORT_SIZE),
      FIRST_PAYLOAD + (r - 1) * CONT_PAYLOAD,
    );
  }
  // Bytes after the payload in the last report are padding with no meaning: legacy firmware
  // zeroes them (firmware-classic1s legacy/firmware/messages.c msg_out_pad) while core firmware
  // reuses the report buffer and leaks bytes from the previous report (firmware-pro
  // core/src/trezor/wire/codec_v1.py write_message). Never read them.
  return { type, payload: gathered.slice(0, length) };
}
