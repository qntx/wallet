/**
 * A stored row's JSON value, or `undefined` when its bytes are not JSON (a torn write, a format
 * another build wrote). Callers treat `undefined` like any other malformed row and skip it.
 */
export const readJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
};
