import { sValidator } from "@hono/standard-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import * as z from "zod/mini";

import {
  PROVIDERS_HEADER,
  nftCollection,
  nftCollectionRequest,
  nftFloor,
  nftFloorRequest,
  nftItem,
  nftItemRequest,
  nftItems,
  nftItemsRequest,
} from "@qntx/wallet-engine/gateway/contract";

import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { Family, NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import type { RateLimitVariables } from "../middleware/rate-limit.ts";
import type { Forwarded, Forwarder } from "../providers/forward.ts";
import {
  alchemyNftCollection,
  alchemyNftDetail,
  alchemyNftFloor,
  alchemyNftPage,
  nftFloorProviders,
  nftProviders,
} from "../providers/nfts-alchemy.ts";
import type { EdgeCache } from "../types.ts";

/** The request is a small JSON body of an address and a cursor — a few hundred bytes. */
const MAX_BODY_BYTES = 4096;

/** Display TTLs per route: inventory turns fast, detail and collections barely change. */
const ITEMS_TTL_SECONDS = 60;
const ITEM_TTL_SECONDS = 3600;
const COLLECTION_TTL_SECONDS = 3600;
const FLOOR_TTL_SECONDS = 600;

type Deps = {
  readonly forwarder: Forwarder;
  readonly served: ReadonlyMap<string, ResolvedNetwork>;
  readonly cache: EdgeCache;
  readonly log: (line: string) => void;
};

type RouteContext = Context<{ Variables: NetworkVariables & RateLimitVariables }>;

/** The request-side address rule: EVM in any hex case, normalised lowercase; Solana base58. */
const requestAddress = (family: Family, value: string): string | undefined => {
  if (family === "evm") {
    return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : undefined;
  }
  if (family === "solana") {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : undefined;
  }
  return undefined;
};

/** The wire shape one cache entry carries — the answering provider and its final body. */
const cachedEntry = z.looseObject({ providerId: z.string(), body: z.unknown() });

type CachedEntry = { readonly providerId: string; readonly body: unknown };

/** A cache failure degrades to a miss — the upstream answers instead. */
const readCached = async (
  cache: EdgeCache,
  key: string,
  log: (line: string) => void,
): Promise<CachedEntry | undefined> => {
  try {
    const raw = await cache.get(key);
    if (raw === undefined) {
      return undefined;
    }
    const parsed = z.safeParse(cachedEntry, JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    log(JSON.stringify({ event: "nft-cache-failure", error: String(error) }));
    return undefined;
  }
};

const writeCached = async (
  cache: EdgeCache,
  key: string,
  entry: CachedEntry,
  ttlSeconds: number,
  log: (line: string) => void,
): Promise<void> => {
  try {
    await cache.put(key, JSON.stringify(entry), ttlSeconds);
  } catch (error) {
    log(JSON.stringify({ event: "nft-cache-failure", error: String(error) }));
  }
};

/** The four `/v1/nfts` routes — display-only inventory, detail, collection and floor reads. */
export function nftRoutes({
  forwarder,
  served,
  cache,
  log,
}: Deps): Hono<{ Variables: NetworkVariables & RateLimitVariables }> {
  const routes = new Hono<{ Variables: NetworkVariables & RateLimitVariables }>();

  /** Answer from the edge cache or `load`, caching only a successful answer. */
  const answerCached = async (
    c: RouteContext,
    key: string,
    ttlSeconds: number,
    load: () => Promise<Forwarded<unknown>>,
  ): Promise<Response> => {
    const hit = await readCached(cache, key, log);
    if (hit !== undefined) {
      return c.json(hit.body, 200, { [PROVIDERS_HEADER]: hit.providerId });
    }
    const { value, providerId } = await load();
    await writeCached(cache, key, { providerId, body: value }, ttlSeconds, log);
    return c.json(value, 200, { [PROVIDERS_HEADER]: providerId });
  };

  routes.post(
    nftItems.path,
    limitBody(MAX_BODY_BYTES),
    resolveNetwork(served, ["evm", "solana"]),
    sValidator("json", nftItemsRequest, (result) => {
      if (!result.success) {
        throw new GatewayHttpError(400, "invalid-request");
      }
    }),
    async (c) => {
      const network = c.get("network");
      const providers = nftProviders(network);
      if (providers.length === 0) {
        throw new GatewayHttpError(404, "unsupported");
      }
      const body = c.req.valid("json");
      const owner = requestAddress(network.family, body.owner);
      if (owner === undefined) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      // DAS pages are numbered; the Solana cursor is the next 1-based page, never page 0.
      let page = 1;
      if (network.family === "solana") {
        if (body.cursor !== undefined && !/^[1-9][0-9]{0,4}$/.test(body.cursor)) {
          throw new GatewayHttpError(400, "invalid-request");
        }
        page = body.cursor === undefined ? 1 : Number(body.cursor);
      }
      const key = `items/${network.id}/${owner}/${body.cursor ?? ""}`;
      return answerCached(c, key, ITEMS_TTL_SECONDS, async () =>
        alchemyNftPage(
          forwarder,
          providers,
          {
            network,
            owner,
            ...(network.family === "solana"
              ? { page }
              : body.cursor === undefined
                ? {}
                : { cursor: body.cursor }),
          },
          c.get("meter"),
        ),
      );
    },
  );

  routes.post(
    nftItem.path,
    limitBody(MAX_BODY_BYTES),
    resolveNetwork(served, ["evm", "solana"]),
    sValidator("json", nftItemRequest, (result) => {
      if (!result.success) {
        throw new GatewayHttpError(400, "invalid-request");
      }
    }),
    async (c) => {
      const network = c.get("network");
      const providers = nftProviders(network);
      if (providers.length === 0) {
        throw new GatewayHttpError(404, "unsupported");
      }
      const body = c.req.valid("json");
      const contract = requestAddress(network.family, body.contract);
      // A Solana asset is its own id — it has no token index; an EVM item needs one.
      const tokenOk =
        network.family === "solana" ? body.tokenId === undefined : body.tokenId !== undefined;
      if (contract === undefined || !tokenOk) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      const key = `item/${network.id}/${contract}/${body.tokenId ?? ""}`;
      return answerCached(c, key, ITEM_TTL_SECONDS, async () =>
        alchemyNftDetail(
          forwarder,
          providers,
          {
            network,
            contract,
            ...(body.tokenId === undefined ? {} : { tokenId: body.tokenId }),
          },
          c.get("meter"),
        ),
      );
    },
  );

  routes.post(
    nftCollection.path,
    limitBody(MAX_BODY_BYTES),
    resolveNetwork(served, ["evm", "solana"]),
    sValidator("json", nftCollectionRequest, (result) => {
      if (!result.success) {
        throw new GatewayHttpError(400, "invalid-request");
      }
    }),
    async (c) => {
      const network = c.get("network");
      const providers = nftProviders(network);
      if (providers.length === 0) {
        throw new GatewayHttpError(404, "unsupported");
      }
      const body = c.req.valid("json");
      const collection = requestAddress(network.family, body.collection);
      if (collection === undefined) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      const key = `collection/${network.id}/${collection}`;
      return answerCached(c, key, COLLECTION_TTL_SECONDS, async () =>
        alchemyNftCollection(forwarder, providers, { network, collection }, c.get("meter")),
      );
    },
  );

  routes.post(
    nftFloor.path,
    limitBody(MAX_BODY_BYTES),
    resolveNetwork(served, ["evm", "solana"]),
    sValidator("json", nftFloorRequest, (result) => {
      if (!result.success) {
        throw new GatewayHttpError(400, "invalid-request");
      }
    }),
    async (c) => {
      const network = c.get("network");
      // Floor has no Solana source at all — the route answers unsupported without calling out.
      const providers = nftFloorProviders(network);
      if (providers.length === 0) {
        throw new GatewayHttpError(404, "unsupported");
      }
      const body = c.req.valid("json");
      const collection = requestAddress(network.family, body.collection);
      if (collection === undefined) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      const key = `floor/${network.id}/${collection}`;
      return answerCached(c, key, FLOOR_TTL_SECONDS, async () =>
        alchemyNftFloor(forwarder, providers, { contract: collection }, c.get("meter")),
      );
    },
  );

  return routes;
}
