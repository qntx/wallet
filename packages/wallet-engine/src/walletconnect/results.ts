import { internalError } from "../connect/errors.ts";

/**
 * Field extraction for the shared handlers' results — `handle` returns `unknown`, and an unexpected
 * shape is the engine's contract broken, not bad dApp input: -32603, not -32602.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** One bytes field of a handler result — a signature, a signed transaction. */
export const bytesField = (result: unknown, key: string): Uint8Array => {
  const value = isRecord(result) ? result[key] : undefined;
  if (!(value instanceof Uint8Array)) {
    throw internalError(`the handler returned no ${key}`);
  }
  return value;
};

/** A bytes-array field of a handler result — `signedTransactions`, `signatures`. */
export const bytesListField = (result: unknown, key: string): Uint8Array[] => {
  const value = isRecord(result) ? result[key] : undefined;
  if (!Array.isArray(value) || !value.every((item) => item instanceof Uint8Array)) {
    throw internalError(`the handler returned no ${key}`);
  }
  return value;
};

/** A handler result that is itself a list of records — `bitcoin:signTransaction`. */
export const recordsList = (result: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (!Array.isArray(result) || !result.every(isRecord)) {
    throw internalError("the handler returned no result list");
  }
  return result;
};

/** A list-of-records field of a handler result — `bitcoin:connect`'s `accounts`. */
export const recordsListField = (
  result: unknown,
  key: string,
): ReadonlyArray<Record<string, unknown>> => {
  const value = isRecord(result) ? result[key] : undefined;
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw internalError(`the handler returned no ${key}`);
  }
  return value;
};
