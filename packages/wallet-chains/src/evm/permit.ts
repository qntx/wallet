/**
 * Recognition of EIP-712 permits: EIP-2612 `Permit`, DAI `Permit` and the Permit2 allowance and
 * signature-transfer types. A document is recognized only when the primary type and every struct it
 * references have exactly the canonical field lists; any other shape stays an opaque message.
 */
import type { ApprovalChange, IntentWarning } from "../index.ts";
import { MAX_UINT160, MAX_UINT256, PERMIT2_ADDRESS, allowanceChange } from "./approval.ts";
import type { EvmTokenTable } from "./tokens.ts";
import {
  MAX_UINT48,
  isTypedDataMessage,
  sameFields,
  typedDataAddress,
  typedDataUint,
} from "./typed-data.ts";
import type { TypedDataInput, TypedDataMessage } from "./typed-data.ts";

export type Permit = {
  readonly approvals: ReadonlyArray<ApprovalChange>;
  readonly warnings: ReadonlyArray<IntentWarning>;
};

type Types = TypedDataInput["types"];
type Message = TypedDataMessage;

const isMessage = isTypedDataMessage;
const address = typedDataAddress;
const uint = typedDataUint;

const DETAILS = ["address token", "uint160 amount", "uint48 expiration", "uint48 nonce"];
const PERMISSIONS = ["address token", "uint256 amount"];

const WITNESS_WARNING: IntentWarning = {
  kind: "permit2-witness",
  message: "the permit carries a witness with further terms",
};

const entries = (value: unknown): ReadonlyArray<Message> | undefined =>
  Array.isArray(value) && value.length > 0 && value.every(isMessage) ? value : undefined;

const permit = (...approvals: ApprovalChange[]): Permit => ({ approvals, warnings: [] });

/**
 * The permit a typed-data document grants, or `undefined` when its shape is not exactly one of the
 * recognized ones. `chainId` is the request network's, used for the built-in token table.
 */
export function recognizePermit(
  json: TypedDataInput,
  chainId: number,
  table: EvmTokenTable,
): Permit | undefined {
  const { types, primaryType, message, domain } = json;
  const verifying = address(domain["verifyingContract"]);
  if (verifying === undefined) {
    return undefined;
  }
  const spender = address(message["spender"]);
  if (spender === undefined) {
    return undefined;
  }
  const allow = (
    token: string,
    value: bigint,
    change: "set" | "transfer",
    max: bigint,
    extra: { readonly expiration?: number; readonly via?: "permit2" } = {},
  ): ApprovalChange => allowanceChange(token, spender, value, change, max, chainId, table, extra);

  if (primaryType === "Permit") {
    if (
      sameFields(types, "Permit", [
        "address owner",
        "address spender",
        "uint256 value",
        "uint256 nonce",
        "uint256 deadline",
      ])
    ) {
      const value = uint(message["value"], MAX_UINT256);
      return value === undefined ? undefined : permit(allow(verifying, value, "set", MAX_UINT256));
    }
    if (
      sameFields(types, "Permit", [
        "address holder",
        "address spender",
        "uint256 nonce",
        "uint256 expiry",
        "bool allowed",
      ])
    ) {
      const { allowed } = message;
      return typeof allowed === "boolean"
        ? permit(allow(verifying, allowed ? MAX_UINT256 : 0n, "set", MAX_UINT256))
        : undefined;
    }
    return undefined;
  }
  if (verifying.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase()) {
    return undefined;
  }
  return recognizePermit2(types, primaryType, message, allow);
}

type Allow = (
  token: string,
  value: bigint,
  change: "set" | "transfer",
  max: bigint,
  extra?: { readonly expiration?: number; readonly via?: "permit2" },
) => ApprovalChange;

const recognizePermit2 = (
  types: Types,
  primaryType: string,
  message: Message,
  allow: Allow,
): Permit | undefined => {
  const via = "permit2" as const;
  const allowance = (details: Message): ApprovalChange | undefined => {
    const token = address(details["token"]);
    const amount = uint(details["amount"], MAX_UINT160);
    const expiration = uint(details["expiration"], MAX_UINT48);
    return token === undefined || amount === undefined || expiration === undefined
      ? undefined
      : allow(token, amount, "set", MAX_UINT160, { via, expiration: Number(expiration) });
  };
  const transfer = (permitted: Message, deadline: bigint): ApprovalChange | undefined => {
    const token = address(permitted["token"]);
    const amount = uint(permitted["amount"], MAX_UINT256);
    return token === undefined || amount === undefined
      ? undefined
      : allow(token, amount, "transfer", MAX_UINT256, {
          via,
          ...(deadline <= MAX_UINT48 ? { expiration: Number(deadline) } : {}),
        });
  };
  const all = (
    list: ReadonlyArray<Message> | undefined,
    build: (item: Message) => ApprovalChange | undefined,
  ): Permit | undefined => {
    const built = list?.map(build);
    return built === undefined || built.some((a) => a === undefined)
      ? undefined
      : permit(...built.filter((a): a is ApprovalChange => a !== undefined));
  };

  if (primaryType === "PermitSingle") {
    const { details } = message;
    return sameFields(types, primaryType, [
      "PermitDetails details",
      "address spender",
      "uint256 sigDeadline",
    ]) &&
      sameFields(types, "PermitDetails", DETAILS) &&
      isMessage(details)
      ? all([details], allowance)
      : undefined;
  }
  if (primaryType === "PermitBatch") {
    return sameFields(types, primaryType, [
      "PermitDetails[] details",
      "address spender",
      "uint256 sigDeadline",
    ]) && sameFields(types, "PermitDetails", DETAILS)
      ? all(entries(message["details"]), allowance)
      : undefined;
  }

  const witness = primaryType.includes("Witness");
  const batch = primaryType.includes("Batch");
  const expected = batch
    ? ["TokenPermissions[] permitted", "address spender", "uint256 nonce", "uint256 deadline"]
    : ["TokenPermissions permitted", "address spender", "uint256 nonce", "uint256 deadline"];
  const name = `Permit${batch ? "Batch" : ""}${witness ? "Witness" : ""}TransferFrom`;
  if (primaryType !== name) {
    return undefined;
  }
  const own = types[primaryType];
  const last = own?.at(-1);
  const fieldsOk = witness
    ? sameFields({ ...types, [primaryType]: own?.slice(0, -1) ?? [] }, primaryType, expected) &&
      last?.name === "witness" &&
      types[last.type] !== undefined
    : sameFields(types, primaryType, expected);
  const deadline = uint(message["deadline"], MAX_UINT256);
  if (!fieldsOk || !sameFields(types, "TokenPermissions", PERMISSIONS) || deadline === undefined) {
    return undefined;
  }
  const { permitted } = message;
  const result = batch
    ? all(entries(permitted), (item) => transfer(item, deadline))
    : isMessage(permitted)
      ? all([permitted], (item) => transfer(item, deadline))
      : undefined;
  return result === undefined || !witness
    ? result
    : { approvals: result.approvals, warnings: [WITNESS_WARNING] };
};
