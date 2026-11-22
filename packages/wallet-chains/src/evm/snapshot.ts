/**
 * Recognition of Snapshot documents under the `{name: "snapshot", version: "0.1.4"}` domain
 * (snapshot.js `src/sign/index.ts` at 2c1198f5 —
 * https://github.com/snapshot-labs/snapshot.js/blob/2c1198f5ead59cff427f2bd63cdb56336cdf351d/src/sign/index.ts),
 * with the declared `EIP712Domain` exactly `[string name, string version]` and `types` exactly
 * `EIP712Domain` plus the primary type:
 *
 * - `Vote` with one of the three field lists snapshot.js emits (`voteTypes`/`voteArrayTypes`/
 *   `voteStringTypes`, `src/sign/types.ts`) — the ballot the prompt renders as field lines.
 * - `Alias(address from,address alias,uint64 timestamp)` — the alias may vote and act on Snapshot as
 *   `from` for 30 days (snapshot-sequencer `src/helpers/alias.ts` at f577889 —
 *   https://github.com/snapshot-labs/snapshot-sequencer/blob/f577889/src/helpers/alias.ts); only
 *   when `from` is the signer.
 *
 * Any other shape is not Snapshot and falls through to the generic rules.
 */
import type { AccountAuthority } from "../index.ts";
import { sameFields, typedDataAddress } from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

const DOMAIN_FIELDS = ["string name", "string version"] as const;
const VOTE_FIELDS = ["string from", "string space", "uint64 timestamp", "string proposal"] as const;
const VOTE_TAIL = ["string reason", "string app", "string metadata"] as const;
const VOTE_CHOICE = ["uint32 choice", "uint32[] choice", "string choice"] as const;
const ALIAS_FIELDS = ["address from", "address alias", "uint64 timestamp"] as const;

export type SnapshotResult =
  | { readonly kind: "vote" }
  | {
      readonly kind: "alias";
      readonly content: { readonly authority: AccountAuthority };
      readonly summary: "authorization";
      readonly outflows: ReadonlyArray<never>;
      readonly verifiability: "partial";
    };

export const recognizeSnapshot = (
  json: TypedDataInput,
  signer: string,
): SnapshotResult | undefined => {
  const { types, primaryType, domain, message } = json;
  if (
    domain["name"] !== "snapshot" ||
    domain["version"] !== "0.1.4" ||
    Object.keys(domain).length !== 2 ||
    Object.keys(types).length !== 2 ||
    !sameFields(types, "EIP712Domain", DOMAIN_FIELDS)
  ) {
    return undefined;
  }
  if (
    primaryType === "Vote" &&
    VOTE_CHOICE.some((choice) => sameFields(types, "Vote", [...VOTE_FIELDS, choice, ...VOTE_TAIL]))
  ) {
    return { kind: "vote" };
  }
  if (primaryType === "Alias" && sameFields(types, "Alias", ALIAS_FIELDS)) {
    const from = typedDataAddress(message["from"]);
    const alias = typedDataAddress(message["alias"]);
    if (from === undefined || from.toLowerCase() !== signer.toLowerCase() || alias === undefined) {
      return undefined;
    }
    return {
      kind: "alias",
      content: { authority: { kind: "snapshot-alias", alias } },
      summary: "authorization",
      outflows: [],
      verifiability: "partial",
    };
  }
  return undefined;
};
