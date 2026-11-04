import { encodeHashList, hashList, phishingHash } from "../src/gateway/contract/index.ts";
import type { HashList } from "../src/gateway/contract/index.ts";

export const listOf = (keys: ReadonlyArray<string>): HashList =>
  hashList(keys.map((key) => phishingHash(key)));

export const b64 = (keys: ReadonlyArray<string>): string => encodeHashList(listOf(keys));
