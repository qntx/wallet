/**
 * The display rules for untrusted NFT metadata the gateway serves. Every string an NFT carries is
 * hostile until it passes these sanitizers: media URLs are allow-listed by scheme and shape, names
 * that hide or masquerade are dropped as deceptive, descriptions and attributes are cut to display
 * budget. Nothing here fetches a media URL — the wallet shows what remote content gives it, never
 * executes it: anything that could run script as a document is marked `active`.
 */
import { displayExcerpt } from "@qntx/wallet-chains";
import type { DisplayExcerpt } from "@qntx/wallet-chains";

import { hasUnsafeText, safeDisplayText } from "../display.ts";
import { NFT_ATTRIBUTES_MAX, NFT_DATA_URI_MAX, NFT_URL_MAX } from "../gateway/contract/index.ts";
import type {
  NftCollection,
  NftDetail,
  NftItem,
  NftMediaRef,
  NftStandard,
} from "../gateway/contract/index.ts";

/** A displayed name is shorter than the wire cap — the row it renders in is small. */
export const NFT_NAME_DISPLAY_MAX = 100;

export type NftMedia = {
  readonly scheme: "https" | "ipfs" | "ar" | "data";
  readonly url: string;
  /**
   * The type the source declared (data URIs: their own); a hint — remote content is unknown until
   * fetched.
   */
  readonly mime?: string;
  /** May run script when rendered as a document: SVG, HTML, or an animation of unknown type. */
  readonly active: boolean;
};

/** How the standard lets the wallet move the item: programmable rules or no token account at all. */
export type NftTransferSupport = "supported" | "programmable" | "compressed";

/** One sanitised gateway item, before spam/visibility. */
export type NftItemFacts = {
  readonly id: string;
  readonly network: string;
  readonly contract: string;
  readonly tokenId?: string;
  readonly standard: NftStandard;
  readonly balance: string;
  readonly name?: string;
  readonly image?: NftMedia;
  readonly animation?: NftMedia;
  readonly collection?: {
    readonly id?: string;
    readonly name?: string;
    readonly verified: boolean;
  };
  readonly gatewaySpam: boolean;
  /** The item or collection name carried hidden characters or markup and was dropped. */
  readonly deceptive: boolean;
  readonly transfer: NftTransferSupport;
};

export type NftCollectionView = {
  readonly id: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly description?: DisplayExcerpt;
  readonly image?: NftMedia;
  readonly totalSupply?: string;
  readonly standard?: NftStandard;
  readonly spam: boolean;
  readonly verified: boolean;
};

// oxlint-disable-next-line typescript/no-restricted-types -- the contract spells absent fields null
type OrNull<T> = T | null;

const TRANSFER: Readonly<Record<NftStandard, NftTransferSupport>> = {
  erc721: "supported",
  erc1155: "supported",
  metaplex: "supported",
  "metaplex-programmable": "programmable",
  "metaplex-core": "supported",
  "metaplex-compressed": "compressed",
};

/** Whitespace or a C0/C1 control makes a URL ambiguous to both the parser and the eye. */
// oxlint-disable-next-line eslint/no-control-regex -- URL noise is exactly control characters
const URL_NOISE = /[\s\u0000-\u001F\u007F-\u009F]/;

const MIME_HINT = /^[a-z]+\/[a-z0-9.+-]+$/;

const IPFS_MEDIA =
  /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/;

const AR_MEDIA = /^ar:\/\/[A-Za-z0-9_-]{43}(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/;

const DATA_MEDIA =
  /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml)(;charset=[A-Za-z0-9-]{1,32})?(;base64)?,/i;

const BASE64_PAYLOAD = /^[A-Za-z0-9+/]*={0,2}$/;

/** Percent-encoded or plain ASCII a non-base64 SVG data URI may carry — no `<` or `"`. */
const SVG_PAYLOAD = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/;

/** Mimes that render as a document and so may run script. */
const ACTIVE_MIMES: ReadonlySet<string> = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
]);

const ACTIVE_PATH = /\.(svgz?|x?html?)$/i;

/** Media families an animation may be without being treated as a document. */
const PASSIVE_MEDIA = /^(?:image|video|audio|model)\//;

/** `raw` as an https URL: parsed, credentialess, with a real host — `undefined` otherwise. */
const httpsUrl = (raw: string): { readonly url: string; readonly path: string } | undefined => {
  if (raw.length > NFT_URL_MAX || URL_NOISE.test(raw)) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return undefined;
  }
  return { url: parsed.href, path: parsed.pathname };
};

/** A declared mime type without parameters, or `undefined` when it is not `type/subtype` text. */
const mimeHint = (mime: OrNull<string>): string | undefined => {
  if (mime === null) {
    return undefined;
  }
  const hint = mime.split(";")[0]?.trim().toLowerCase();
  return hint !== undefined && MIME_HINT.test(hint) ? hint : undefined;
};

/**
 * A media reference the UI may load: `url` allow-listed to https/ipfs/ar/image-data, `mime` the
 * declared hint, `active` when displaying it as a document could run script. `undefined` when the
 * URL is off-list (javascript:, http:, file:, blob:, other data: types, relative paths).
 */
export function sanitizeMedia(ref: NftMediaRef, role: "image" | "animation"): NftMedia | undefined {
  const raw = ref.url;
  if (URL_NOISE.test(raw) || hasUnsafeText(raw)) {
    return undefined;
  }
  const colon = raw.indexOf(":");
  if (colon === -1) {
    return undefined;
  }
  const scheme = raw.slice(0, colon).toLowerCase();

  let media:
    | { readonly scheme: NftMedia["scheme"]; readonly url: string; readonly path?: string }
    | undefined;
  let mime = mimeHint(ref.mime);
  if (scheme === "https") {
    const parsed = httpsUrl(raw);
    media =
      parsed === undefined ? undefined : { scheme: "https", url: parsed.url, path: parsed.path };
  } else if (scheme === "ipfs") {
    // A redundant `ipfs://ipfs/<cid>` wrapper resolves to the CID itself.
    const unwrapped = raw.toLowerCase().startsWith("ipfs://ipfs/")
      ? `ipfs://${raw.slice("ipfs://ipfs/".length)}`
      : raw;
    const match = unwrapped.length <= NFT_URL_MAX ? IPFS_MEDIA.exec(unwrapped) : null;
    const path = match?.[2];
    media =
      match === null
        ? undefined
        : { scheme: "ipfs", url: unwrapped, ...(path === undefined ? {} : { path }) };
  } else if (scheme === "ar" && raw.length <= NFT_URL_MAX) {
    const match = AR_MEDIA.exec(raw);
    const path = match?.[1];
    media =
      match === null
        ? undefined
        : { scheme: "ar", url: raw, ...(path === undefined ? {} : { path }) };
  } else if (scheme === "data" && raw.length <= NFT_DATA_URI_MAX) {
    const match = DATA_MEDIA.exec(raw);
    if (match !== null) {
      const subtype = (match[1] ?? "").toLowerCase();
      const payload = raw.slice(match[0].length);
      const base64 = match[3] !== undefined;
      const valid = base64
        ? BASE64_PAYLOAD.test(payload) && payload.length % 4 === 0
        : subtype === "svg+xml" && SVG_PAYLOAD.test(payload);
      if (valid) {
        media = { scheme: "data", url: raw };
        mime = `image/${subtype}`;
      }
    }
  }
  if (media === undefined) {
    return undefined;
  }

  const active =
    (mime !== undefined && ACTIVE_MIMES.has(mime)) ||
    (media.path !== undefined && ACTIVE_PATH.test(media.path)) ||
    (role === "animation" && (mime === undefined || !PASSIVE_MEDIA.test(mime)));
  return { scheme: media.scheme, url: media.url, ...(mime === undefined ? {} : { mime }), active };
}

/** A name trimmed and stripped of trailing NULs. */
export function sanitizeName(raw: OrNull<string>): {
  readonly name?: string;
  readonly deceptive: boolean;
} {
  if (raw === null) {
    return { deceptive: false };
  }
  // oxlint-disable-next-line eslint/no-control-regex -- trailing NULs are stripped on purpose
  const text = raw.trim().replace(/\u0000+$/, "");
  // Markup must never reach the renderer — a `<tag` shape is deception, not a bad name.
  if (/<\s*\/?\s*[a-z!?]/i.test(text) || hasUnsafeText(text)) {
    return { deceptive: true };
  }
  const name = safeDisplayText(text, NFT_NAME_DISPLAY_MAX);
  return name === undefined ? { deceptive: false } : { name, deceptive: false };
}

/** A description excerpt with markup stripped — display-safe lines, display-budget sized. */
export function sanitizeDescription(raw: OrNull<string>): DisplayExcerpt | undefined {
  if (raw === null) {
    return undefined;
  }
  const excerpt = displayExcerpt(raw.replaceAll(/<[^<>]{0,512}>/g, ""), 20, 2000);
  return excerpt.lines.length === 0 ? undefined : excerpt;
}

/** Attribute rows cut to display budget — malformed or over-long entries dropped, first 50 kept. */
export function sanitizeAttributes(
  raw: ReadonlyArray<{ readonly trait: string; readonly value: string }>,
): ReadonlyArray<{ readonly trait: string; readonly value: string }> {
  const rows: Array<{ readonly trait: string; readonly value: string }> = [];
  for (const entry of raw) {
    if (rows.length >= NFT_ATTRIBUTES_MAX) {
      break;
    }
    const trait = safeDisplayText(entry.trait, 64);
    const value = safeDisplayText(entry.value, 64);
    if (trait === undefined || value === undefined) {
      continue;
    }
    rows.push({ trait, value });
  }
  return rows;
}

/** An external link the UI may offer: https only, same rule as media. */
export function sanitizeLink(raw: OrNull<string>): string | undefined {
  if (raw === null) {
    return undefined;
  }
  return httpsUrl(raw)?.url;
}

/** One gateway item as display facts: hostile fields sanitised, ids ready for dedupe. */
export function sanitizeItem(network: string, item: NftItem): NftItemFacts {
  const name = sanitizeName(item.name);
  const { collection } = item;
  const collectionName = collection === null ? undefined : sanitizeName(collection.name);
  const image = item.image === null ? undefined : sanitizeMedia(item.image, "image");
  const animation =
    item.animation === null ? undefined : sanitizeMedia(item.animation, "animation");
  return {
    id: network.startsWith("eip155:") ? `${item.contract}:${item.tokenId ?? ""}` : item.contract,
    network,
    contract: item.contract,
    ...(item.tokenId === null ? {} : { tokenId: item.tokenId }),
    standard: item.standard,
    balance: item.balance,
    ...(name.name === undefined ? {} : { name: name.name }),
    ...(image === undefined ? {} : { image }),
    ...(animation === undefined ? {} : { animation }),
    ...(collection === null
      ? {}
      : {
          collection: {
            ...(collection.id === null ? {} : { id: collection.id }),
            ...(collectionName?.name === undefined ? {} : { name: collectionName.name }),
            verified: collection.verified,
          },
        }),
    gatewaySpam: item.spam,
    deceptive: name.deceptive || (collectionName?.deceptive ?? false),
    transfer: TRANSFER[item.standard],
  };
}

/** A gateway detail as sanitised facts plus its long-form fields. */
export function sanitizeDetail(
  network: string,
  detail: NftDetail,
): {
  readonly facts: NftItemFacts;
  readonly description?: DisplayExcerpt;
  readonly attributes: ReadonlyArray<{ readonly trait: string; readonly value: string }>;
  readonly externalUrl?: string;
} {
  const description = sanitizeDescription(detail.description);
  const externalUrl = sanitizeLink(detail.externalUrl);
  return {
    facts: sanitizeItem(network, detail.item),
    ...(description === undefined ? {} : { description }),
    attributes: sanitizeAttributes(detail.attributes),
    ...(externalUrl === undefined ? {} : { externalUrl }),
  };
}

/** A gateway collection descriptor as a display view. */
export function sanitizeCollection(collection: NftCollection): NftCollectionView {
  const name = sanitizeName(collection.name);
  const symbol = collection.symbol === null ? undefined : safeDisplayText(collection.symbol, 32);
  const description = sanitizeDescription(collection.description);
  const image = collection.image === null ? undefined : sanitizeMedia(collection.image, "image");
  return {
    id: collection.id,
    ...(name.name === undefined ? {} : { name: name.name }),
    ...(symbol === undefined ? {} : { symbol }),
    ...(description === undefined ? {} : { description }),
    ...(image === undefined ? {} : { image }),
    ...(collection.totalSupply === null ? {} : { totalSupply: collection.totalSupply }),
    ...(collection.standard === null ? {} : { standard: collection.standard }),
    spam: collection.spam,
    verified: collection.verified,
  };
}
