import * as z from "zod/mini";

import {
  NFT_ATTRIBUTES_MAX,
  NFT_ATTRIBUTE_TEXT_MAX,
  NFT_DESCRIPTION_MAX,
  NFT_NAME_MAX,
  NFT_URL_MAX,
  accepts,
  nftCollectionFits,
  nftCollectionResponse,
  nftDetail,
  nftFloorResponse,
  nftItemFits,
  nftMediaRef,
  nftPage,
  nftPageFits,
  nftTokenId,
} from "@qntx/wallet-engine/gateway/contract";
import type {
  NftAttribute,
  NftCollection,
  NftDetail,
  NftFloor,
  NftItem,
  NftMediaRef,
  NftPage,
  NftStandard,
} from "@qntx/wallet-engine/gateway/contract";

import { nftCost } from "../budget/costs.ts";
import type { NftMethod } from "../budget/costs.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import type { ResolvedNetwork } from "../middleware/network.ts";
import type { ResolvedProvider } from "../types.ts";
import type { Forwarded, Forwarder, Meter, Send, UpstreamResponse } from "./forward.ts";
import { ProviderFailure, REFUSED_STATUSES, REQUEST_ERROR_STATUSES } from "./forward.ts";
import { plainDecimal } from "./prices.ts";

/**
 * NFT inventory, detail, collection and floor reads over Alchemy: the NFT API v3 for EVM (on the
 * same host and bearer as the network's RPC, `/v2` → `/nft/v3`) and the DAS JSON-RPC methods for
 * Solana. Display-only data — nothing here is trusted to build or sign transactions. This adapter
 * has not been exercised live with the production key.
 */

/** A page of items is at most ~100 trimmed entries; 4 MiB leaves headroom. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Upstream items one page asks for on either family. */
const PAGE_SIZE = 100;

/**
 * Chains where Alchemy's NFT API answers, probed live 2026-11-23 with the public demo key (evidence
 * alchemy-nft-probe.txt); every other built-in Alchemy network answered "This endpoint isn't
 * enabled for that chain".
 */
const NFT_CHAINS: ReadonlySet<number> = new Set([
  1, 8453, 42161, 10, 137, 56, 43114, 4663, 143, 5042, 100, 80094, 480, 130, 59144, 42220, 324,
  1868, 33139, 2020, 534352, 7777777,
]);

/** Solana networks whose Alchemy endpoint answers the DAS reads. */
const DAS_NETWORKS: ReadonlySet<string> = new Set(["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);

/** `getFloorPrice` answers on these chains only (the Alchemy doc's own note). */
const FLOOR_CHAINS: ReadonlySet<number> = new Set([1, 42161, 8453]);

const chainIdOf = (network: ResolvedNetwork): number => Number(network.id.split(":")[1]);

/** The network's Alchemy providers re-labelled so NFT failures never open the RPC breaker. */
const alchemyNfts = (network: ResolvedNetwork): ResolvedProvider[] => {
  const out: ResolvedProvider[] = [];
  for (const provider of network.providers) {
    if (provider.id === "alchemy") {
      out.push({ ...provider, id: "alchemy-nfts" });
    }
  }
  return out;
};

/**
 * Providers that can answer item, detail and collection reads for `network` — empty when the chain
 * is not covered, so the route answers `unsupported` without an upstream call.
 */
export const nftProviders = (network: ResolvedNetwork): ReadonlyArray<ResolvedProvider> => {
  const covered =
    network.family === "evm"
      ? NFT_CHAINS.has(chainIdOf(network))
      : network.family === "solana" && DAS_NETWORKS.has(network.id);
  return covered ? alchemyNfts(network) : [];
};

/** Providers for the floor route — EVM-only, and only on the chains `getFloorPrice` serves. */
export const nftFloorProviders = (network: ResolvedNetwork): ReadonlyArray<ResolvedProvider> =>
  network.family === "evm" && FLOOR_CHAINS.has(chainIdOf(network)) ? alchemyNfts(network) : [];

/* Upstream wire shapes — loose: fields not read are ignored, absent fields tolerated. */

const optStr = z.optional(z.union([z.string(), z.null()]));

const upstreamMedia = z.looseObject({
  originalUrl: optStr,
  cachedUrl: optStr,
  contentType: optStr,
});

const upstreamOpenSea = z.looseObject({
  collectionName: optStr,
  safelistRequestStatus: optStr,
  description: optStr,
  imageUrl: optStr,
});

const upstreamContract = z.looseObject({
  address: optStr,
  name: optStr,
  symbol: optStr,
  totalSupply: optStr,
  tokenType: optStr,
  isSpam: z.optional(z.union([z.boolean(), z.null()])),
  openSeaMetadata: z.optional(z.union([upstreamOpenSea, z.null()])),
});

const upstreamCollection = z.looseObject({ name: optStr });

const upstreamEvmNft = z.looseObject({
  contract: upstreamContract,
  tokenId: z.optional(z.union([z.string(), z.number(), z.null()])),
  tokenType: optStr,
  balance: z.optional(z.union([z.string(), z.number(), z.null()])),
  name: optStr,
  description: optStr,
  image: z.optional(z.union([upstreamMedia, z.null()])),
  animation: z.optional(z.union([upstreamMedia, z.null()])),
  collection: z.optional(z.union([upstreamCollection, z.null()])),
  raw: z.optional(
    z.union([
      z.looseObject({ metadata: z.optional(z.union([z.looseObject({}), z.null()])) }),
      z.null(),
    ]),
  ),
});

const upstreamEvmPage = z.looseObject({
  // Items are validated one by one — a single bad NFT must not fail the page.
  ownedNfts: z.array(z.unknown()),
  pageKey: optStr,
});

const upstreamMarket = z.looseObject({
  floorPrice: z.optional(z.union([z.number(), z.null()])),
  priceCurrency: optStr,
  retrievedAt: optStr,
  error: z.optional(z.union([z.string(), z.null()])),
});

const upstreamFloor = z.looseObject({
  openSea: z.optional(z.union([upstreamMarket, z.null()])),
  looksRare: z.optional(z.union([upstreamMarket, z.null()])),
});

const dasFile = z.looseObject({ uri: optStr, mime: optStr });

const dasGrouping = z.looseObject({
  group_key: z.optional(z.string()),
  group_value: optStr,
});

const dasContent = z.looseObject({
  metadata: z.optional(z.union([z.looseObject({}), z.null()])),
  links: z.optional(z.union([z.looseObject({}), z.null()])),
  files: z.optional(z.union([z.array(dasFile), z.null()])),
});

const dasAsset = z.looseObject({
  id: z.optional(z.string()),
  interface: z.optional(z.string()),
  compression: z.optional(
    z.union([z.looseObject({ compressed: z.optional(z.boolean()) }), z.null()]),
  ),
  content: z.optional(z.union([dasContent, z.null()])),
  grouping: z.optional(z.union([z.array(dasGrouping), z.null()])),
  burnt: z.optional(z.boolean()),
});

const dasPage = z.looseObject({
  total: z.optional(z.number()),
  page: z.optional(z.number()),
  limit: z.optional(z.number()),
  items: z.array(z.unknown()),
});

const dasResponse = z.looseObject({
  result: z.optional(z.unknown()),
  error: z.optional(
    z.union([
      z.looseObject({ code: z.optional(z.number()), message: z.optional(z.string()) }),
      z.null(),
    ]),
  ),
});

type UpstreamEvmNft = z.output<typeof upstreamEvmNft>;
type UpstreamMedia = z.output<typeof upstreamMedia>;
type UpstreamMarket = z.output<typeof upstreamMarket>;
type DasAsset = z.output<typeof dasAsset>;
type DasContent = z.output<typeof dasContent>;

/* Reading upstream bodies. */

const readJson = async (response: UpstreamResponse): Promise<unknown> => {
  if (!response.ok) {
    if (REQUEST_ERROR_STATUSES.has(response.status)) {
      throw new GatewayHttpError(400, "invalid-request");
    }
    throw new ProviderFailure(`status-${response.status}`, REFUSED_STATUSES.has(response.status));
  }
  const text = await response.text(MAX_BODY_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderFailure("malformed", false);
  }
};

const nftApiBase = (url: string): string => url.replace(/\/v2$/, "/nft/v3");

/** One NFT API GET; `send` adds the provider's bearer. */
const evmGet = async (
  send: Send,
  provider: ResolvedProvider,
  method: Exclude<NftMethod, "getAssetsByOwner" | "getAsset">,
  query: string,
): Promise<unknown> => {
  const response = await send({
    url: `${nftApiBase(provider.url)}/${method}?${query}`,
    cost: nftCost(provider.costs, method),
  });
  return readJson(response);
};

/**
 * One DAS call on the provider's JSON-RPC URL. A `not found` error on `getAsset` is the request's
 * own 404 — the asset does not exist; every other JSON-RPC error is a provider failure.
 */
const dasCall = async (
  send: Send,
  provider: ResolvedProvider,
  method: "getAssetsByOwner" | "getAsset",
  params: Record<string, unknown>,
): Promise<unknown> => {
  const response = await send({
    url: provider.url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cost: nftCost(provider.costs, method),
  });
  const parsed = z.safeParse(dasResponse, await readJson(response));
  if (!parsed.success) {
    throw new ProviderFailure("malformed", false);
  }
  const { error } = parsed.data;
  if (error !== undefined && error !== null) {
    if (method === "getAsset" && /not found/i.test(error.message ?? "")) {
      throw new GatewayHttpError(404, "not-found");
    }
    throw new ProviderFailure("rpc-error", false);
  }
  if (parsed.data.result === undefined || parsed.data.result === null) {
    throw new ProviderFailure("malformed", false);
  }
  return parsed.data.result;
};

/* Mapping helpers. */

// oxlint-disable-next-line typescript/no-restricted-types -- the contract spells absent fields null
type OrNull<T> = T | null;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** `value` as display text: trimmed, empty or over-`max` strings become `null`. */
const boundedText = (value: unknown, max: number): OrNull<string> => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? null : trimmed;
};

/** A decimal field carried as a string or a number upstream. */
const decimalOf = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value);
  return DECIMAL.test(text) ? text : undefined;
};

/** `{url, mime}` validated against the media cap — `null` when absent or oversized. */
const mediaRefOf = (url: unknown, mime: unknown): OrNull<NftMediaRef> => {
  if (typeof url !== "string" || url === "") {
    return null;
  }
  const ref = { url, mime: typeof mime === "string" && mime.length <= 64 ? mime : null };
  return accepts(nftMediaRef, ref) ? ref : null;
};

const evmMedia = (media: OrNull<UpstreamMedia> | undefined): OrNull<NftMediaRef> =>
  mediaRefOf(media?.originalUrl ?? media?.cachedUrl, media?.contentType);

const EVM_STANDARD: Readonly<Record<string, NftStandard>> = {
  ERC721: "erc721",
  ERC1155: "erc1155",
};

const SAFELISTED: ReadonlySet<string> = new Set(["verified", "approved"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

/** The `raw.metadata` object of an upstream NFT, or `{}`. */
const rawMetadata = (nft: UpstreamEvmNft): Record<string, unknown> =>
  recordOf(nft.raw?.metadata) ?? {};

/**
 * The contract item one upstream record maps to, or `undefined` when it cannot be trusted.
 * `fallbackBalance` applies when the record carries none (a single metadata read has no owner).
 */
const mapEvmItem = (
  network: string,
  nft: UpstreamEvmNft,
  fallbackBalance?: string,
): NftItem | undefined => {
  const standard = nft.tokenType === null ? undefined : EVM_STANDARD[nft.tokenType ?? ""];
  const tokenId =
    typeof nft.tokenId === "string" || typeof nft.tokenId === "number"
      ? String(nft.tokenId)
      : undefined;
  if (
    typeof nft.contract.address !== "string" ||
    standard === undefined ||
    tokenId === undefined ||
    !accepts(nftTokenId, tokenId)
  ) {
    return undefined;
  }
  const balance = decimalOf(nft.balance) ?? fallbackBalance;
  if (balance === undefined) {
    return undefined;
  }
  const contract = nft.contract.address.toLowerCase();
  const openSea = nft.contract.openSeaMetadata;
  const collectionName = openSea?.collectionName ?? nft.contract.name ?? nft.collection?.name;
  const item: NftItem = {
    contract,
    tokenId,
    standard,
    balance,
    name: boundedText(nft.name ?? rawMetadata(nft)["name"], NFT_NAME_MAX),
    image: evmMedia(nft.image),
    animation: evmMedia(nft.animation),
    collection: {
      id: contract,
      name: boundedText(collectionName, NFT_NAME_MAX),
      verified: SAFELISTED.has(openSea?.safelistRequestStatus ?? ""),
    },
    spam: nft.contract.isSpam === true,
  };
  return nftItemFits(network, item) ? item : undefined;
};

const dasStandard = (asset: DasAsset): NftStandard | undefined => {
  if (asset.compression?.compressed === true) {
    return "metaplex-compressed";
  }
  switch (asset.interface) {
    case "ProgrammableNFT":
      return "metaplex-programmable";
    case "MplCoreAsset":
      return "metaplex-core";
    case "V1_NFT":
    case "V1_PRINT":
    case "LEGACY_NFT":
    case "V2_NFT":
      return "metaplex";
    default:
      return undefined;
  }
};

const dasMetadata = (asset: DasAsset): Record<string, unknown> | undefined =>
  recordOf(asset.content?.metadata);

const dasLinks = (asset: DasAsset): Record<string, unknown> | undefined =>
  recordOf(asset.content?.links);

/** `content.links.image`, else the first image-typed file — its mime when the URIs match. */
const dasImage = (content: OrNull<DasContent> | undefined): OrNull<NftMediaRef> => {
  const files = content?.files ?? [];
  const links = recordOf(content?.links);
  const fallback = files.find(
    (file) => typeof file.mime === "string" && file.mime.startsWith("image/"),
  );
  const url = links?.["image"] ?? fallback?.uri;
  const file = files.find((f) => f.uri === url);
  return mediaRefOf(url, file?.mime);
};

const mapDasItem = (network: string, asset: DasAsset): NftItem | undefined => {
  if (asset.burnt === true) {
    return undefined;
  }
  const standard = dasStandard(asset);
  if (standard === undefined || asset.id === undefined) {
    return undefined;
  }
  const metadata = dasMetadata(asset);
  const collectionGroup = (asset.grouping ?? []).find((group) => group.group_key === "collection");
  const item: NftItem = {
    contract: asset.id,
    tokenId: null,
    standard,
    balance: "1",
    name: boundedText(metadata?.["name"], NFT_NAME_MAX),
    image: dasImage(asset.content),
    animation: mediaRefOf(dasLinks(asset)?.["animation_url"], null),
    // DAS only lists verified groupings by default (showUnverifiedCollections=false).
    collection:
      typeof collectionGroup?.group_value === "string"
        ? { id: collectionGroup.group_value, name: null, verified: true }
        : null,
    spam: false,
  };
  return nftItemFits(network, item) ? item : undefined;
};

const attributeRows = (raw: unknown): NftAttribute[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows: NftAttribute[] = [];
  for (const entry of raw) {
    if (rows.length >= NFT_ATTRIBUTES_MAX) {
      break;
    }
    const record = recordOf(entry);
    const trait = record?.["trait_type"];
    const value = record?.["value"];
    if (
      typeof trait !== "string" ||
      trait === "" ||
      trait.length > NFT_ATTRIBUTE_TEXT_MAX ||
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    ) {
      continue;
    }
    const text = String(value);
    if (text.length > NFT_ATTRIBUTE_TEXT_MAX) {
      continue;
    }
    rows.push({ trait, value: text });
  }
  return rows;
};

/**
 * One inventory page for `owner`: `getNFTsForOwner` on EVM (`cursor` is the opaque pageKey),
 * `getAssetsByOwner` on Solana (`page` is 1-based; a full page advertises the next page number).
 */
export const alchemyNftPage = async (
  forwarder: Forwarder,
  providers: ReadonlyArray<ResolvedProvider>,
  params: {
    readonly network: ResolvedNetwork;
    readonly owner: string;
    /** EVM pageKey. */
    readonly cursor?: string;
    /** Solana 1-based page. */
    readonly page?: number;
  },
  meter: Meter,
): Promise<Forwarded<NftPage>> =>
  forwarder.run(
    providers,
    async (send, provider) => {
      const { network, owner } = params;
      let response: NftPage;
      if (network.family === "solana") {
        const page = params.page ?? 1;
        const result = z.safeParse(
          dasPage,
          await dasCall(send, provider, "getAssetsByOwner", {
            ownerAddress: owner,
            page,
            limit: PAGE_SIZE,
          }),
        );
        if (!result.success) {
          throw new ProviderFailure("malformed", false);
        }
        const items = result.data.items.flatMap((raw) => {
          const asset = z.safeParse(dasAsset, raw);
          if (!asset.success) {
            return [];
          }
          const item = mapDasItem(network.id, asset.data);
          return item === undefined ? [] : [item];
        });
        response = {
          items,
          // A full page probably has a successor; the cursor is the next 1-based page number.
          cursor: result.data.items.length === PAGE_SIZE ? String(page + 1) : null,
        };
      } else {
        const result = z.safeParse(
          upstreamEvmPage,
          await evmGet(
            send,
            provider,
            "getNFTsForOwner",
            `owner=${encodeURIComponent(owner)}&withMetadata=true&pageSize=${String(PAGE_SIZE)}${params.cursor === undefined ? "" : `&pageKey=${encodeURIComponent(params.cursor)}`}`,
          ),
        );
        if (!result.success) {
          throw new ProviderFailure("malformed", false);
        }
        const items = result.data.ownedNfts.flatMap((raw) => {
          const nft = z.safeParse(upstreamEvmNft, raw);
          if (!nft.success) {
            return [];
          }
          const item = mapEvmItem(network.id, nft.data);
          return item === undefined ? [] : [item];
        });
        response = { items, cursor: result.data.pageKey ?? null };
      }
      if (!accepts(nftPage, response) || !nftPageFits(network.id, response)) {
        throw new ProviderFailure("malformed", false);
      }
      return response;
    },
    { meter },
  );

/**
 * One item's detail: `getNFTMetadata` on EVM (contract + tokenId), `getAsset` on Solana (the
 * contract is the asset id itself). Description, attributes and external url come from the token's
 * metadata; over-cap fields are nulled, malformed attribute rows dropped.
 */
export const alchemyNftDetail = async (
  forwarder: Forwarder,
  providers: ReadonlyArray<ResolvedProvider>,
  params: {
    readonly network: ResolvedNetwork;
    readonly contract: string;
    readonly tokenId?: string;
  },
  meter: Meter,
): Promise<Forwarded<NftDetail>> =>
  forwarder.run(
    providers,
    async (send, provider) => {
      const { network, contract } = params;
      let item: NftItem | undefined;
      let description: OrNull<string>;
      let attributes: NftAttribute[];
      let externalUrl: OrNull<string>;
      if (network.family === "solana") {
        const asset = z.safeParse(
          dasAsset,
          await dasCall(send, provider, "getAsset", { id: contract }),
        );
        if (!asset.success) {
          throw new ProviderFailure("malformed", false);
        }
        item = mapDasItem(network.id, asset.data);
        const metadata = dasMetadata(asset.data);
        description = boundedText(metadata?.["description"], NFT_DESCRIPTION_MAX);
        attributes = attributeRows(metadata?.["attributes"]);
        externalUrl = boundedText(dasLinks(asset.data)?.["external_url"], NFT_URL_MAX);
      } else {
        if (params.tokenId === undefined) {
          throw new GatewayHttpError(400, "invalid-request");
        }
        const nft = z.safeParse(
          upstreamEvmNft,
          await evmGet(
            send,
            provider,
            "getNFTMetadata",
            `contractAddress=${encodeURIComponent(contract)}&tokenId=${encodeURIComponent(
              params.tokenId,
            )}&refreshCache=false`,
          ),
        );
        if (!nft.success) {
          throw new ProviderFailure("malformed", false);
        }
        // A single metadata read knows no owner balance — a displayed detail counts one token.
        item = mapEvmItem(network.id, nft.data, "1");
        const metadata = rawMetadata(nft.data);
        description = boundedText(
          metadata["description"] ?? nft.data.description,
          NFT_DESCRIPTION_MAX,
        );
        attributes = attributeRows(metadata["attributes"]);
        externalUrl = boundedText(metadata["external_url"], NFT_URL_MAX);
      }
      if (item === undefined) {
        throw new ProviderFailure("malformed", false);
      }
      const detail: NftDetail = { item, description, attributes, externalUrl };
      if (!accepts(nftDetail, detail)) {
        throw new ProviderFailure("malformed", false);
      }
      return detail;
    },
    { meter },
  );

/**
 * A collection descriptor: `getContractMetadata` on EVM, `getAsset` on Solana (a collection is
 * itself an asset there).
 */
export const alchemyNftCollection = async (
  forwarder: Forwarder,
  providers: ReadonlyArray<ResolvedProvider>,
  params: { readonly network: ResolvedNetwork; readonly collection: string },
  meter: Meter,
): Promise<Forwarded<NftCollection>> =>
  forwarder.run(
    providers,
    async (send, provider) => {
      const { network, collection } = params;
      let response: NftCollection;
      if (network.family === "solana") {
        const asset = z.safeParse(
          dasAsset,
          await dasCall(send, provider, "getAsset", { id: collection }),
        );
        if (!asset.success) {
          throw new ProviderFailure("malformed", false);
        }
        const metadata = dasMetadata(asset.data);
        response = {
          id: asset.data.id ?? "",
          name: boundedText(metadata?.["name"], NFT_NAME_MAX),
          symbol: boundedText(metadata?.["symbol"], 32),
          description: boundedText(metadata?.["description"], NFT_DESCRIPTION_MAX),
          image: dasImage(asset.data.content),
          totalSupply: null,
          standard: dasStandard(asset.data) ?? null,
          spam: false,
          verified: false,
        };
      } else {
        const contract = z.safeParse(
          upstreamContract,
          await evmGet(
            send,
            provider,
            "getContractMetadata",
            `contractAddress=${encodeURIComponent(collection)}`,
          ),
        );
        if (!contract.success) {
          throw new ProviderFailure("malformed", false);
        }
        const openSea = contract.data.openSeaMetadata;
        response = {
          id: contract.data.address?.toLowerCase() ?? "",
          name: boundedText(openSea?.collectionName ?? contract.data.name, NFT_NAME_MAX),
          symbol: boundedText(contract.data.symbol, 32),
          description: boundedText(openSea?.description, NFT_DESCRIPTION_MAX),
          image: mediaRefOf(openSea?.imageUrl, null),
          totalSupply: decimalOf(contract.data.totalSupply) ?? null,
          standard:
            contract.data.tokenType === null || contract.data.tokenType === undefined
              ? null
              : (EVM_STANDARD[contract.data.tokenType] ?? null),
          spam: contract.data.isSpam === true,
          verified: SAFELISTED.has(openSea?.safelistRequestStatus ?? ""),
        };
      }
      if (!accepts(nftCollectionResponse, response) || !nftCollectionFits(network.id, response)) {
        throw new ProviderFailure("malformed", false);
      }
      return response;
    },
    { meter },
  );

const floorMarket = (
  marketplace: "opensea" | "looksrare",
  market: OrNull<UpstreamMarket> | undefined,
): NftFloor["floors"][number] | undefined => {
  if (
    market === undefined ||
    market === null ||
    market.error !== null ||
    typeof market.floorPrice !== "number" ||
    !Number.isFinite(market.floorPrice) ||
    market.floorPrice < 0 ||
    typeof market.priceCurrency !== "string"
  ) {
    return undefined;
  }
  const amount = plainDecimal(market.floorPrice, 18);
  const currency = market.priceCurrency.toUpperCase();
  if (amount === undefined || !/^[A-Z0-9]{1,10}$/.test(currency)) {
    return undefined;
  }
  const retrievedAt = Date.parse(market.retrievedAt ?? "");
  return {
    marketplace,
    amount,
    currency,
    retrievedAt: Number.isFinite(retrievedAt) && retrievedAt >= 0 ? retrievedAt : null,
  };
};

/** Floor quotes for a collection contract: `getFloorPrice`'s OpenSea and LooksRare rows. */
export const alchemyNftFloor = async (
  forwarder: Forwarder,
  providers: ReadonlyArray<ResolvedProvider>,
  params: { readonly contract: string },
  meter: Meter,
): Promise<Forwarded<NftFloor>> =>
  forwarder.run(
    providers,
    async (send, provider) => {
      const result = z.safeParse(
        upstreamFloor,
        await evmGet(
          send,
          provider,
          "getFloorPrice",
          `contractAddress=${encodeURIComponent(params.contract)}`,
        ),
      );
      if (!result.success) {
        throw new ProviderFailure("malformed", false);
      }
      const floors = [
        floorMarket("opensea", result.data.openSea),
        floorMarket("looksrare", result.data.looksRare),
      ].filter((floor): floor is NonNullable<typeof floor> => floor !== undefined);
      const response: NftFloor = { floors };
      if (!accepts(nftFloorResponse, response)) {
        throw new ProviderFailure("malformed", false);
      }
      return response;
    },
    { meter },
  );
