import { SECRET_FIELDS } from "@qntx/wallet/protocol";
import type { ProtocolValue } from "@qntx/wallet/protocol";

const SECRET_KEYS: ReadonlySet<string> = new Set<string>(SECRET_FIELDS);

/**
 * A custom transport that posts kernel requests itself gives every secret field its own buffer, the
 * way `@qntx/wallet` does: the kernel wipes secrets in place and refuses, with `invalid-input`, a
 * request whose secret shares memory with another field. Returns a copy whose secret bytes are
 * fresh exact-size arrays; the caller transfers or wipes them.
 */
export function ownSecretBuffers(value: ProtocolValue, secret = false): ProtocolValue {
  if (value instanceof Uint8Array) {
    return secret ? new Uint8Array(value) : value;
  }
  if (Array.isArray(value)) {
    const elements: ReadonlyArray<ProtocolValue> = value;
    return elements.map((element) => ownSecretBuffers(element, secret));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        ownSecretBuffers(child, SECRET_KEYS.has(key)),
      ]),
    );
  }
  return value;
}
