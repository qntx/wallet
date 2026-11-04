import { invalidParams } from "./errors.ts";

/** A Sign In With Solana request after validation: `domain` and `address` are resolved. */
export type SignInFields = {
  readonly domain: string;
  readonly address: string;
  readonly statement?: string;
  readonly uri?: string;
  readonly version?: string;
  readonly chainId?: string;
  readonly nonce?: string;
  readonly issuedAt?: string;
  readonly expirationTime?: string;
  readonly notBefore?: string;
  readonly requestId?: string;
  readonly resources?: ReadonlyArray<string>;
};

/** The dApp's input: every field optional. */
export type SignInInput = Partial<SignInFields>;

const STATEMENT_MAX = 1024;
const FIELD_MAX = 256;
const RESOURCES_MAX = 32;

const STRING_FIELDS = [
  "domain",
  "address",
  "statement",
  "uri",
  "version",
  "chainId",
  "nonce",
  "issuedAt",
  "expirationTime",
  "notBefore",
  "requestId",
] as const;

const checkString = (name: string, value: unknown, max: number): string => {
  if (typeof value !== "string") {
    throw invalidParams(`${name} must be a string`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw invalidParams(`${name} must not contain line breaks`);
  }
  if (value.length > max) {
    throw invalidParams(`${name} is longer than ${String(max)} characters`);
  }
  return value;
};

/** Validates a dApp's sign-in input: types, no line breaks, length caps. */
export function checkSignInInput(raw: unknown): SignInInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidParams("the sign-in input must be an object");
  }
  const record = new Map<string, unknown>(Object.entries(raw));
  const out: Record<string, string | string[]> = {};
  for (const name of STRING_FIELDS) {
    const value = record.get(name);
    if (value !== undefined) {
      out[name] = checkString(name, value, name === "statement" ? STATEMENT_MAX : FIELD_MAX);
    }
  }
  const resources = record.get("resources");
  if (resources !== undefined) {
    if (!Array.isArray(resources) || resources.length > RESOURCES_MAX) {
      throw invalidParams(`resources must be an array of at most ${String(RESOURCES_MAX)} strings`);
    }
    out["resources"] = resources.map((resource) => checkString("resources", resource, FIELD_MAX));
  }
  return out;
}

/**
 * The EIP-4361-style message, byte for byte `createSignInMessageText` of
 * `@solana/wallet-standard-util` 1.2.0 (an empty `resources` array still prints `Resources:`).
 */
export function signInMessageText(input: SignInFields): string {
  let message = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`;
  if (input.statement !== undefined && input.statement !== "") {
    message += `\n\n${input.statement}`;
  }
  const fields: string[] = [];
  const optional: ReadonlyArray<readonly [string, string | undefined]> = [
    ["URI", input.uri],
    ["Version", input.version],
    ["Chain ID", input.chainId],
    ["Nonce", input.nonce],
    ["Issued At", input.issuedAt],
    ["Expiration Time", input.expirationTime],
    ["Not Before", input.notBefore],
    ["Request ID", input.requestId],
  ];
  for (const [label, value] of optional) {
    if (value !== undefined && value !== "") {
      fields.push(`${label}: ${value}`);
    }
  }
  if (input.resources !== undefined) {
    fields.push("Resources:");
    for (const resource of input.resources) {
      fields.push(`- ${resource}`);
    }
  }
  if (fields.length > 0) {
    message += `\n\n${fields.join("\n")}`;
  }
  return message;
}
