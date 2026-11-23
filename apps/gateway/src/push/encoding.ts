/**
 * Byte-level encodings shared by the push modules. `btoa`/`atob`/`TextEncoder` are globals in both
 * workerd and Node, so the same helpers run in the Worker and under the test runner.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const textOf = (bytes: Uint8Array | ArrayBuffer): string =>
  decoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

export const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export const bytesOfHex = (hex: string): Uint8Array | undefined => {
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) {
    return undefined;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export const hexOf = (bytes: Uint8Array | ArrayBuffer): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
};

/** Unpadded base64url — the `c` field, sealed targets and JWS sections. */
export const base64urlOf = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const decode = (text: string): Uint8Array | undefined => {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.codePointAt(i) ?? 0;
  }
  return out;
};

/** Standard base64 (`PUSH_SEAL_KEY`, PEM bodies); `undefined` when malformed. */
export const base64Bytes = (text: string): Uint8Array | undefined =>
  /^[A-Za-z0-9+/]*={0,2}$/.test(text) && text.length % 4 === 0 ? decode(text) : undefined;

/** Unpadded base64url; `undefined` when malformed or not a whole number of bytes. */
export const base64urlBytes = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  const padding = (4 - (text.length % 4)) % 4;
  return decode(`${text.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(padding)}`);
};
