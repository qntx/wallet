import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";

/** One inventory page is at most this many items. */
export const NFT_PAGE_MAX = 100;
/** Detail attributes kept per item. */
export const NFT_ATTRIBUTES_MAX = 50;
/** A remote (non-`data:`) media or link URL is at most this many characters. */
export const NFT_URL_MAX = 2048;
/** A `data:` media URI may run to this many characters. */
export const NFT_DATA_URI_MAX = 65_536;
/** Display text an item or collection name may carry. */
export const NFT_NAME_MAX = 200;
/** A description may run to this many characters. */
export const NFT_DESCRIPTION_MAX = 4000;
/** One attribute key or value. */
export const NFT_ATTRIBUTE_TEXT_MAX = 128;

export const NFT_STANDARDS = [
  "erc721",
  "erc1155",
  "metaplex",
  "metaplex-programmable",
  "metaplex-core",
  "metaplex-compressed",
] as const;
export type NftStandard = (typeof NFT_STANDARDS)[number];

const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** A non-negative integer in decimal — no leading zeros, floats, signs or hex. */
const decimal = z.string().check(z.regex(DECIMAL));
const UINT256_MAX = 2n ** 256n - 1n;

/** An EVM token id or balance unit: decimal, no leading zeros, inside uint256. */
export const nftTokenId = z.string().check(
  z.regex(DECIMAL),
  z.refine((value) => BigInt(value) <= UINT256_MAX, { error: "over uint256" }),
);

/** A held amount: decimal, no leading zeros, at least 1, inside uint256. */
export const nftBalance = z.string().check(
  z.regex(DECIMAL),
  z.refine((value) => BigInt(value) >= 1n && BigInt(value) <= UINT256_MAX, {
    error: "balance out of range",
  }),
);

/**
 * Where the host may look for media: a remote URL capped at {@link NFT_URL_MAX} characters or a
 * `data:` URI capped at {@link NFT_DATA_URI_MAX}. The scheme itself is the client's problem —
 * nothing here is fetched.
 */
export const nftMediaRef = z.strictObject({
  url: z.string().check(
    z.minLength(1),
    z.maxLength(NFT_DATA_URI_MAX),
    z.refine((url) => url.startsWith("data:") || url.length <= NFT_URL_MAX, {
      error: "remote url over cap",
    }),
  ),
  mime: z.union([z.string().check(z.maxLength(64)), z.null()]),
});

export const nftCollectionRef = z.strictObject({
  /** The collection's on-chain id (contract or asset) when the provider knows it. */
  id: z.union([z.string().check(z.maxLength(64)), z.null()]),
  name: z.union([z.string().check(z.maxLength(NFT_NAME_MAX)), z.null()]),
  verified: z.boolean(),
});

export const nftItemSchema = z.strictObject({
  contract: z.string().check(z.maxLength(64)),
  /** Decimal on EVM; null on Solana — the asset id is the contract. */
  tokenId: z.union([nftTokenId, z.null()]),
  standard: z.enum(NFT_STANDARDS),
  balance: nftBalance,
  name: z.union([z.string().check(z.maxLength(NFT_NAME_MAX)), z.null()]),
  image: z.union([nftMediaRef, z.null()]),
  animation: z.union([nftMediaRef, z.null()]),
  collection: z.union([nftCollectionRef, z.null()]),
  spam: z.boolean(),
});

/** The opaque page cursor: ASCII-safe, bounded — never echoed back unvalidated. */
export const nftCursor = z.string().check(z.regex(/^[A-Za-z0-9_.:-]{1,512}$/));

export const nftItemsRequest = z.strictObject({
  // The address is in the body, never the URL: address-bearing routes are POST.
  owner: z.string().check(z.maxLength(64)),
  cursor: z.optional(nftCursor),
});

export const nftItemRequest = z.strictObject({
  contract: z.string().check(z.maxLength(64)),
  tokenId: z.optional(nftTokenId),
});

export const nftCollectionRequest = z.strictObject({
  collection: z.string().check(z.maxLength(64)),
});

export const nftFloorRequest = nftCollectionRequest;

export const nftPage = z.strictObject({
  items: z.array(nftItemSchema).check(z.maxLength(NFT_PAGE_MAX)),
  /** Null: there is no next page. */
  cursor: z.union([nftCursor, z.null()]),
});

export const nftAttribute = z.strictObject({
  trait: z.string().check(z.minLength(1), z.maxLength(NFT_ATTRIBUTE_TEXT_MAX)),
  value: z.string().check(z.maxLength(NFT_ATTRIBUTE_TEXT_MAX)),
});

export const nftDetail = z.strictObject({
  item: nftItemSchema,
  description: z.union([z.string().check(z.maxLength(NFT_DESCRIPTION_MAX)), z.null()]),
  attributes: z.array(nftAttribute).check(z.maxLength(NFT_ATTRIBUTES_MAX)),
  externalUrl: z.union([z.string().check(z.maxLength(NFT_URL_MAX)), z.null()]),
});

export const nftCollectionResponse = z.strictObject({
  id: z.string().check(z.maxLength(64)),
  name: z.union([z.string().check(z.maxLength(NFT_NAME_MAX)), z.null()]),
  symbol: z.union([z.string().check(z.maxLength(32)), z.null()]),
  description: z.union([z.string().check(z.maxLength(NFT_DESCRIPTION_MAX)), z.null()]),
  image: z.union([nftMediaRef, z.null()]),
  totalSupply: z.union([decimal, z.null()]),
  standard: z.union([z.enum(NFT_STANDARDS), z.null()]),
  spam: z.boolean(),
  verified: z.boolean(),
});

const NFT_MARKETPLACES = ["opensea", "looksrare"] as const;

/**
 * A floor quote as a canonical decimal string — never a binary float, no trailing zeros in the
 * fraction, at most 18 decimals.
 */
const floorAmount = z.string().check(z.regex(/^(0|[1-9][0-9]*)(\.[0-9]{0,17}[1-9])?$/));

export const nftFloorResponse = z.strictObject({
  floors: z
    .array(
      z.strictObject({
        marketplace: z.enum(NFT_MARKETPLACES),
        amount: floorAmount,
        currency: z.string().check(z.regex(/^[A-Z0-9]{1,10}$/)),
        /** Milliseconds since the epoch; null when the provider gave none. */
        retrievedAt: z.union([z.int().check(z.minimum(0)), z.null()]),
      }),
    )
    .check(z.maxLength(2)),
});

export const nftItems = endpoint("POST", "/v1/nfts/items/:caip2", nftItemsRequest, nftPage);
export const nftItem = endpoint("POST", "/v1/nfts/item/:caip2", nftItemRequest, nftDetail);
export const nftCollection = endpoint(
  "POST",
  "/v1/nfts/collection/:caip2",
  nftCollectionRequest,
  nftCollectionResponse,
);
export const nftFloor = endpoint(
  "POST",
  "/v1/nfts/floor/:caip2",
  nftFloorRequest,
  nftFloorResponse,
);

/** The items path for one network. */
export const nftItemsPath = (caip2: string): string => nftItems.path.replace(":caip2", caip2);
/** The item path for one network. */
export const nftItemPath = (caip2: string): string => nftItem.path.replace(":caip2", caip2);
/** The collection path for one network. */
export const nftCollectionPath = (caip2: string): string =>
  nftCollection.path.replace(":caip2", caip2);
/** The floor path for one network. */
export const nftFloorPath = (caip2: string): string => nftFloor.path.replace(":caip2", caip2);

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const namespaceOf = (network: string): string => network.split(":")[0] ?? "";

/**
 * Whether `address` has the shape `network` spells on-chain — a contract, an asset id, an owner or
 * a collection id. EVM ids are lowercase hex only; Solana ids are base58. Other namespaces have no
 * NFT inventory at all.
 */
export function nftAddressFits(network: string, address: string): boolean {
  const namespace = namespaceOf(network);
  if (namespace === "eip155") {
    return EVM_ADDRESS.test(address);
  }
  if (namespace === "solana") {
    return SOLANA_ADDRESS.test(address);
  }
  return false;
}

/**
 * Whether an item can belong to `network`: the contract fits, the token id and standard match the
 * family's rules (EVM ids are mandatory, Solana's asset id is the contract), an erc721 holds
 * exactly one, and a named collection points at an address of the same family.
 */
export function nftItemFits(network: string, item: NftItem): boolean {
  const namespace = namespaceOf(network);
  if (!nftAddressFits(network, item.contract)) {
    return false;
  }
  if (namespace === "eip155") {
    if (item.tokenId === null) {
      return false;
    }
    if (item.standard !== "erc721" && item.standard !== "erc1155") {
      return false;
    }
    if (item.standard === "erc721" && item.balance !== "1") {
      return false;
    }
  } else if (namespace === "solana") {
    if (item.tokenId !== null || !item.standard.startsWith("metaplex")) {
      return false;
    }
  } else {
    return false;
  }
  const collectionId = item.collection?.id;
  return collectionId === null || collectionId === undefined
    ? true
    : nftAddressFits(network, collectionId);
}

/** Every item fits the network and no `(contract, tokenId)` pair repeats inside the page. */
export function nftPageFits(network: string, page: NftPage): boolean {
  const seen = new Set<string>();
  for (const item of page.items) {
    if (!nftItemFits(network, item)) {
      return false;
    }
    const key = `${item.contract}${item.tokenId ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

/** The collection id fits the network and its standard is the family's (or unreported). */
export function nftCollectionFits(network: string, collection: NftCollection): boolean {
  const namespace = namespaceOf(network);
  if (!nftAddressFits(network, collection.id)) {
    return false;
  }
  if (collection.standard === null) {
    return true;
  }
  if (namespace === "eip155") {
    return collection.standard === "erc721" || collection.standard === "erc1155";
  }
  if (namespace === "solana") {
    return collection.standard.startsWith("metaplex");
  }
  return false;
}

export type NftItem = z.infer<typeof nftItemSchema>;
export type NftMediaRef = z.infer<typeof nftMediaRef>;
export type NftCollectionRef = z.infer<typeof nftCollectionRef>;
export type NftAttribute = z.infer<typeof nftAttribute>;
export type NftPage = z.infer<typeof nftPage>;
export type NftDetail = z.infer<typeof nftDetail>;
export type NftCollection = z.infer<typeof nftCollectionResponse>;
export type NftFloor = z.infer<typeof nftFloorResponse>;
export type NftItemsRequest = z.infer<typeof nftItemsRequest>;
export type NftItemRequest = z.infer<typeof nftItemRequest>;
export type NftCollectionRequest = z.infer<typeof nftCollectionRequest>;
export type NftFloorRequest = z.infer<typeof nftFloorRequest>;
