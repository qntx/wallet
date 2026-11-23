/**
 * `@qntx/wallet-engine/push` — opens a delivered push message into its typed event for hosts that
 * run outside the engine (an iOS Notification Service Extension, an Android FCM service, an RN
 * headless task). The dependency floor is `@noble/ciphers` and `@scure/base` over the plain ES
 * built-ins — no timers, no I/O, no Node or Web globals — so a bundled copy runs anywhere.
 *
 * A message opens when one of the device's subscription keys authenticates the AES-256-GCM blob AND
 * the plaintext parses: anything else yields `undefined` and the host falls back to generic copy.
 * `vectors/push.json` freezes the format end to end.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { base64urlnopad } from "@scure/base";

import {
  PUSH_KEYS_MAX,
  parsePushMessage,
  parsePushPlaintext,
  pushAad,
} from "../gateway/contract/push-message.ts";
import type { PushPlaintext } from "../gateway/contract/push-message.ts";

export { PUSH_KEYS_MAX, parsePushMessage } from "../gateway/contract/push-message.ts";
export type {
  PushEventKind,
  PushMessage,
  PushPlaintext,
  PushTransfer,
} from "../gateway/contract/push-message.ts";

const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** ASCII bytes → string, or `undefined` when a byte falls outside the printable range. */
const asciiOf = (bytes: Uint8Array): string | undefined => {
  let out = "";
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) {
      return undefined;
    }
    out += String.fromCodePoint(byte);
  }
  return out;
};

/** The AAD is already ASCII by construction — this is a byte copy, not a decode. */
const asciiBytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.codePointAt(i) ?? 0;
  }
  return out;
};

/**
 * Opens `message` — whatever the provider delivered — with the device's subscription keys. The
 * first key that authenticates and yields a well-formed event wins; a key that opens the blob but
 * whose plaintext is malformed makes the whole delivery unreadable rather than continuing — another
 * key cannot legitimately open the same blob.
 */
export function openPush(
  message: unknown,
  keys: ReadonlyArray<Uint8Array>,
): { readonly keyIndex: number; readonly event: PushPlaintext } | undefined {
  const parsed = parsePushMessage(message);
  if (parsed === undefined || keys.length > PUSH_KEYS_MAX) {
    return undefined;
  }
  let blob: Uint8Array;
  try {
    blob = base64urlnopad.decode(parsed.c);
  } catch {
    return undefined;
  }
  if (blob.length < NONCE_LENGTH + TAG_LENGTH + 1) {
    return undefined;
  }
  const nonce = blob.subarray(0, NONCE_LENGTH);
  const sealed = blob.subarray(NONCE_LENGTH);
  const aad = asciiBytes(pushAad(parsed.e));
  for (const [index, key] of keys.entries()) {
    if (key.length !== KEY_LENGTH) {
      continue;
    }
    let plaintext: Uint8Array;
    try {
      plaintext = gcm(key, nonce, aad).decrypt(sealed);
    } catch {
      continue;
    }
    const text = asciiOf(plaintext);
    const event = text === undefined ? undefined : parsePushPlaintext(text);
    if (event === undefined) {
      return undefined;
    }
    return { keyIndex: index, event };
  }
  return undefined;
}
