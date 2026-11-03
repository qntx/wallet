import { ChainError } from "./index.ts";
import type { AccountRef } from "./index.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAccountRef = (value: unknown): value is AccountRef => {
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    return false;
  }
  if (value["kind"] === "hd") {
    return (
      typeof value["walletId"] === "string" &&
      typeof value["groupIndex"] === "number" &&
      typeof value["template"] === "string"
    );
  }
  return (
    value["kind"] === "imported" &&
    typeof value["keyId"] === "string" &&
    typeof value["family"] === "string"
  );
};

/** The network/account head every SignRequest shares; per-family checks follow it. */
export const requestBase = (request: unknown): { network: string; account: AccountRef } => {
  if (!isRecord(request)) {
    throw new ChainError("invalid-request", "request must be an object");
  }
  const { network, account } = request;
  if (typeof network !== "string") {
    throw new ChainError("invalid-request", "request.network must be a string");
  }
  if (!isAccountRef(account)) {
    throw new ChainError("invalid-request", "request.account must be an AccountRef");
  }
  return { network, account };
};
