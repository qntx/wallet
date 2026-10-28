/**
 * Wallet metadata document — the plaintext exchanged over kind-30078 events between this wallet's
 * own devices. One document per wallet; entry-level last-writer-wins on `updatedAt`.
 */

export type MetaDocWallet = {
  readonly name?: string;
  readonly updatedAt: number;
};

export type MetaDocGroup = {
  readonly index: number;
  readonly name?: string;
  readonly hidden: boolean;
  readonly boundPubkey?: string;
  readonly updatedAt: number;
};

export type MetaDoc = {
  readonly v: 1;
  readonly wallet: MetaDocWallet;
  readonly groups: ReadonlyArray<MetaDocGroup>;
};

export const META_DOC_MAX_BYTES = 65536;

const NAME_MAX = 24;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const KNOWN_DOC_KEYS = new Set(["v", "wallet", "groups"]);
const KNOWN_WALLET_KEYS = new Set(["name", "updatedAt"]);
const KNOWN_GROUP_KEYS = new Set(["index", "name", "hidden", "boundPubkey", "updatedAt"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const validName = (v: unknown): boolean =>
  v === undefined || (typeof v === "string" && v.trim().length > 0 && v.trim().length <= NAME_MAX);

const trimmedName = (v: unknown): string | undefined =>
  typeof v === "string" ? v.trim() : undefined;

/** Strict decode — any malformed shape, unknown key or duplicate index returns `undefined`. */
export function decodeMetaDoc(value: unknown): MetaDoc | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  for (const k of Object.keys(value)) {
    if (!KNOWN_DOC_KEYS.has(k)) {
      return undefined;
    }
  }
  if (value["v"] !== 1) {
    return undefined;
  }
  const { wallet } = value;
  if (!isObject(wallet)) {
    return undefined;
  }
  for (const k of Object.keys(wallet)) {
    if (!KNOWN_WALLET_KEYS.has(k)) {
      return undefined;
    }
  }
  if (!validName(wallet["name"]) || !isNonNegativeInt(wallet["updatedAt"])) {
    return undefined;
  }
  const { groups } = value;
  if (!Array.isArray(groups)) {
    return undefined;
  }
  const seen = new Set<number>();
  const out: MetaDocGroup[] = [];
  for (const item of groups) {
    if (!isObject(item)) {
      return undefined;
    }
    for (const k of Object.keys(item)) {
      if (!KNOWN_GROUP_KEYS.has(k)) {
        return undefined;
      }
    }
    const { index } = item;
    if (!isNonNegativeInt(index) || seen.has(index)) {
      return undefined;
    }
    seen.add(index);
    if (!validName(item["name"]) || (item["hidden"] !== true && item["hidden"] !== false)) {
      return undefined;
    }
    const { boundPubkey } = item;
    if (
      boundPubkey !== undefined &&
      (typeof boundPubkey !== "string" || !PUBKEY_RE.test(boundPubkey))
    ) {
      return undefined;
    }
    if (!isNonNegativeInt(item["updatedAt"])) {
      return undefined;
    }
    const gName = trimmedName(item["name"]);
    out.push({
      index,
      hidden: item["hidden"],
      updatedAt: item["updatedAt"],
      ...(gName === undefined ? {} : { name: gName }),
      ...(boundPubkey === undefined ? {} : { boundPubkey }),
    });
  }
  out.sort((a, b) => a.index - b.index);
  const name = trimmedName(wallet["name"]);
  return {
    v: 1,
    wallet: {
      updatedAt: wallet["updatedAt"],
      ...(name === undefined ? {} : { name }),
    },
    groups: out,
  };
}

/** UTF-8 JSON — `undefined` when the document exceeds the 64 KB limit. */
export function encodeMetaDoc(doc: MetaDoc): Uint8Array | undefined {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return bytes.byteLength <= META_DOC_MAX_BYTES ? bytes : undefined;
}

export function decodeMetaDocBytes(bytes: Uint8Array): MetaDoc | undefined {
  if (bytes.byteLength > META_DOC_MAX_BYTES) {
    return undefined;
  }
  try {
    return decodeMetaDoc(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}
