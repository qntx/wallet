/** What a handler answers with (`4200`) for sign-message bytes that are not UTF-8 text. */
export const BLIND_SIGNING_MESSAGE = "blind signing is not enabled: the message is not UTF-8 text";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The bytes as UTF-8 text, or `undefined` when they are not valid UTF-8. */
export function utf8Text(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}
