export type PhishingEntries = {
  readonly deny: ReadonlyArray<string>;
  readonly allow: ReadonlyArray<string>;
};

export type PhishingSource = {
  readonly id: string;
  readonly url: string;
  /** Throws when the document does not have the expected shape. */
  readonly parse: (json: unknown) => PhishingEntries;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringList = (source: string, record: Record<string, unknown>, field: string): string[] => {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new TypeError(`${source}: "${field}" is not an array`);
  }
  return value.filter((item): item is string => typeof item === "string");
};

const lists = (
  source: string,
  json: unknown,
  denyField: string,
  allowField: string,
): PhishingEntries => {
  if (!isRecord(json)) {
    throw new TypeError(`${source}: document is not an object`);
  }
  return {
    deny: stringList(source, json, denyField),
    allow: stringList(source, json, allowField),
  };
};

export const PHISHING_SOURCES: ReadonlyArray<PhishingSource> = [
  {
    // MetaMask eth-phishing-detect — DBAD 1.2: any use is allowed, attribution is required and
    // verbatim resale is not. `blacklist` and `whitelist` are used; `fuzzylist` is not.
    id: "metamask",
    url: "https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json",
    parse: (json) => lists("metamask", json, "blacklist", "whitelist"),
  },
  {
    // Polkadot phishing — Apache-2.0. `deny` and `allow` are used; `denySub` (social account
    // pages) is not.
    id: "polkadot",
    url: "https://polkadot.js.org/phishing/all.json",
    parse: (json) => lists("polkadot", json, "deny", "allow"),
  },
];
