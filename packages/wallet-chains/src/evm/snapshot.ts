/**
 * Recognition of a Snapshot `Vote`: the document is a claim of the Snapshot family only when the
 * domain is exactly `{name: "snapshot", version: "0.1.4"}` (snapshot.js `src/sign/index.ts`), the
 * declared `EIP712Domain` is exactly `[string name, string version]`, the primary type is `Vote`
 * and `types` holds exactly `EIP712Domain` plus `Vote` with one of the three field lists
 * snapshot.js emits (`voteTypes`/`voteArrayTypes`/`voteStringTypes`, `src/sign/types.ts`). Any
 * other shape is not Snapshot and falls through to the generic rules.
 */
import { sameFields } from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

const VOTE_FIELDS = ["string from", "string space", "uint64 timestamp", "string proposal"] as const;
const VOTE_TAIL = ["string reason", "string app", "string metadata"] as const;
const VOTE_CHOICE = ["uint32 choice", "uint32[] choice", "string choice"] as const;

export const recognizeSnapshot = (json: TypedDataInput): boolean => {
  const { types, primaryType, domain } = json;
  return (
    primaryType === "Vote" &&
    domain["name"] === "snapshot" &&
    domain["version"] === "0.1.4" &&
    Object.keys(domain).length === 2 &&
    Object.keys(types).length === 2 &&
    sameFields(types, "EIP712Domain", ["string name", "string version"]) &&
    VOTE_CHOICE.some((choice) => sameFields(types, "Vote", [...VOTE_FIELDS, choice, ...VOTE_TAIL]))
  );
};
