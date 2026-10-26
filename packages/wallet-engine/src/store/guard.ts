import { EngineStoreError } from "../errors.ts";

/** NUL is the composite-key/AAD separator — a name or key containing it collides. */
export function checkName(kind: "collection" | "key", value: string): void {
  if (value.includes("\u0000")) {
    throw new EngineStoreError("invalid-input", `${kind} must not contain NUL`);
  }
}
