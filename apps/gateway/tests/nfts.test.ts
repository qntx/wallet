import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDERS_HEADER,
  nftCollectionPath,
  nftFloorPath,
  nftItemPath,
  nftItemsPath,
} from "@qntx/wallet-engine/gateway/contract";
import type {
  NftCollection,
  NftDetail,
  NftFloor,
  NftPage,
} from "@qntx/wallet-engine/gateway/contract";

import type { GatewayNetwork } from "../src/types.ts";
import {
  allowAll,
  fakeFetch,
  gateway,
  memoryEdgeCache,
  post,
  recordingLimiter,
} from "./helpers.ts";
import type { Upstream, UpstreamCall } from "./helpers.ts";

const ETH = "eip155:1";
const ARB = "eip155:42161";
const SEPOLIA = "eip155:11155111";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const ETH_API = "https://eth.alchemy.test/nft/v3";
const ARB_API = "https://arb.alchemy.test/nft/v3";
const SOL_RPC = "https://sol.alchemy.test/v2";

const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  { id: ETH, providers: [{ id: "alchemy", url: "https://eth.alchemy.test/v2" }] },
  { id: ARB, providers: [{ id: "alchemy", url: "https://arb.alchemy.test/v2" }] },
  { id: SEPOLIA, providers: [{ id: "alchemy", url: "https://sep.alchemy.test/v2" }] },
  { id: SOLANA, providers: [{ id: "alchemy", url: SOL_RPC }] },
];

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BAYC = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";
const WOW = "0xe785e82358879f061bc3dcac6f0444462d4b5330";
const SOL_OWNER = "2RtGg6fsFiiF1EQzHqbd66AhW7R5bWeQGpTbv2UMkCdW";
const MADLAD = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`fixtures/nfts/${name}.json`, import.meta.url).pathname, "utf8"));

const json = (body: unknown): Response => Response.json(body);

type DasCall = { readonly method?: string; readonly params?: Record<string, unknown> };

const dasCall = (call: UpstreamCall | undefined): DasCall =>
  JSON.parse(call?.body ?? "{}") as DasCall;

/** First call fails malformed, the second answers an empty page — failures must not be cached. */
const flakyUpstream = (): Upstream => {
  let bad = true;
  return () => {
    const answer = bad ? new Response("<html>") : Response.json({ ownedNfts: [], pageKey: null });
    bad = false;
    return answer;
  };
};

const items = (res: NftPage) => res.items;

describe("nft items page", () => {
  it("maps an Alchemy owner page: spam flags, safelist, bad items dropped, pageKey cursor", async () => {
    const up = fakeFetch({ [ETH_API]: () => json(fixture("evm-owned-page")) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(ETH), post({ owner: OWNER }));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("alchemy-nfts");
    const page = (await res.json()) as NftPage;
    expect(page.cursor).toBe("c864816d-9b0e-4c8d-ab0b-77ca3676254b");
    // Two rows dropped: an erc721 whose balance is not "1", and an unknown tokenType.
    expect(page.items).toHaveLength(3);
    const [ens, spam, blast] = page.items;
    expect(ens?.contract).toBe("0x0000000000696760e15f265e828db644a0c242eb");
    expect(ens?.tokenId).toBe(
      "34454361969670104802583458346517400542074712368450903800518897101070583190115",
    );
    expect(ens?.standard).toBe("erc721");
    expect(ens?.spam).toBe(false);
    expect(ens?.image?.url).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(ens?.image?.mime).toBe("image/svg+xml");
    expect(ens?.collection?.verified).toBe(true);
    expect(spam?.spam).toBe(true);
    expect(spam?.collection?.verified).toBe(false);
    expect(spam?.collection?.name).toBe("Namefi (Ethereum)");
    expect(blast?.spam).toBe(true);
    const [call] = up.callsTo(ETH_API);
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe(
      `${ETH_API}/getNFTsForOwner?owner=${OWNER.toLowerCase()}&withMetadata=true&pageSize=100`,
    );
  });

  it("accepts a checksummed owner by lower-casing it for the upstream and the cache", async () => {
    const up = fakeFetch({ [ETH_API]: () => json({ ownedNfts: [], pageKey: null }) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(ETH), post({ owner: OWNER }));
    expect(res.status).toBe(200);
    expect(up.callsTo(ETH_API)).toHaveLength(1);
    expect(up.callsTo(ETH_API)[0]?.url).toContain(`owner=${OWNER.toLowerCase()}`);
  });

  it("keeps the good items when one page row fails its shape", async () => {
    const base = fixture("evm-owned-page") as { ownedNfts: unknown[]; pageKey: unknown };
    const page = {
      ownedNfts: [base.ownedNfts[0], null, { contract: "not a record" }, base.ownedNfts[1]],
      pageKey: null,
    };
    const up = fakeFetch({ [ETH_API]: () => json(page) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(ETH), post({ owner: OWNER }));
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(2);
  });

  it("keeps the good DAS assets when one row fails its shape", async () => {
    const base = (fixture("solana-owned-page") as { result: { items: unknown[] } }).result.items;
    const result = { items: [base[0], "broken", base[1]] };
    const up = fakeFetch({ [SOL_RPC]: () => json({ jsonrpc: "2.0", result, id: 1 }) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(SOLANA), post({ owner: SOL_OWNER }));
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(2);
  });

  it("maps a DAS owner page: compressed/programmable/plain metaplex, Custom skipped", async () => {
    const up = fakeFetch({ [SOL_RPC]: () => json(fixture("solana-owned-page")) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(SOLANA), post({ owner: SOL_OWNER }));
    expect(res.status).toBe(200);
    const page = (await res.json()) as NftPage;
    expect(page.cursor).toBeNull();
    const standards = items(page).map((item) => item.standard);
    expect(standards).toStrictEqual(["metaplex-compressed", "metaplex", "metaplex-programmable"]);
    const [compressed] = page.items;
    expect(compressed?.collection?.id).toBe("5aPf1zww469Lj5VAWgBg8hyWpu584rPBEtnDLe92sudq");
    expect(compressed?.collection?.verified).toBe(true);
    for (const item of page.items) {
      expect(item.tokenId).toBeNull();
      expect(item.balance).toBe("1");
      expect(item.spam).toBe(false);
    }
    const p = dasCall(up.callsTo(SOL_RPC)[0]);
    expect(p.method).toBe("getAssetsByOwner");
    expect(p.params).toStrictEqual({ ownerAddress: SOL_OWNER, page: 1, limit: 100 });
  });

  it("skips burnt, fungible and Custom assets and maps a core asset", async () => {
    const base = (fixture("solana-owned-page") as { result: { items: unknown[] } }).result.items;
    const good = base[0] as Record<string, unknown>;
    const extra = (patch: Record<string, unknown>, id: string) => ({
      ...good,
      ...patch,
      id,
      grouping: [],
    });
    const result = {
      items: [
        ...base,
        extra({ interface: "MplCoreAsset", compression: null }, "9".repeat(44)),
        extra({ interface: "FungibleAsset", compression: null }, "8".repeat(44)),
        extra({ burnt: true }, "7".repeat(44)),
      ],
    };
    const up = fakeFetch({
      [SOL_RPC]: () => json({ jsonrpc: "2.0", result, id: 1 }),
    });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(SOLANA), post({ owner: SOL_OWNER }));
    expect(res.status).toBe(200);
    const page = (await res.json()) as NftPage;
    expect(page.items.map((item) => item.standard)).toStrictEqual([
      "metaplex-compressed",
      "metaplex",
      "metaplex-programmable",
      "metaplex-core",
    ]);
  });

  it("answers the next page number when the DAS page is full", async () => {
    const base = (fixture("solana-owned-page") as { result: { items: unknown[] } }).result
      .items[0] as Record<string, unknown>;
    const dasId = (i: number) =>
      "b".repeat(40) +
      String(i)
        .split("")
        .map((d) => "abcdefghij"[Number(d)])
        .join("");
    const result = {
      items: Array.from({ length: 100 }, (_, i) => ({ ...base, id: dasId(i), grouping: [] })),
    };
    const up = fakeFetch({ [SOL_RPC]: () => json({ jsonrpc: "2.0", result, id: 1 }) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(SOLANA), post({ owner: SOL_OWNER }));
    expect(res.status).toBe(200);
    const page = (await res.json()) as NftPage;
    expect(page.items).toHaveLength(100);
    expect(page.cursor).toBe("2");
    // The next page request carries the cursor as the DAS page number.
    await app.request(nftItemsPath(SOLANA), post({ owner: SOL_OWNER, cursor: "2" }));
    const p = dasCall(up.callsTo(SOL_RPC)[1]);
    expect(p.params).toStrictEqual({ ownerAddress: SOL_OWNER, page: 2, limit: 100 });
  });

  it("rejects a non-page-number Solana cursor and a non-page 1 start", async () => {
    const up = fakeFetch({ [SOL_RPC]: () => json({}) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    for (const cursor of ["0", "abc", "-1", "x1"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential bad inputs on purpose
      const res = await app.request(nftItemsPath(SOLANA), post({ owner: SOL_OWNER, cursor }));
      expect(res.status).toBe(400);
    }
    expect(up.calls).toHaveLength(0);
  });
});

describe("nft item detail", () => {
  it("maps getNFTMetadata: metadata fields, numeric attributes, fallback balance", async () => {
    const up = fakeFetch({ [ETH_API]: () => json(fixture("evm-item-detail")) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(
      nftItemPath(ETH),
      post({ contract: WOW.toUpperCase().replace("X", "x"), tokenId: "44" }),
    );
    expect(res.status).toBe(200);
    const detail = (await res.json()) as NftDetail;
    expect(detail.item.contract).toBe(WOW);
    expect(detail.item.tokenId).toBe("44");
    expect(detail.item.standard).toBe("erc721");
    // getNFTMetadata carries no owner balance — the detail shows one token.
    expect(detail.item.balance).toBe("1");
    expect(detail.description).toBe("World of Women #44.");
    expect(detail.attributes).toStrictEqual([
      { trait: "Background", value: "Purple" },
      { trait: "Mint Order", value: "12" },
      { trait: "Is Rare", value: "true" },
    ]);
    expect(detail.externalUrl).toBe("https://worldofwomen.art/");
    expect(up.callsTo(ETH_API)[0]?.url).toBe(
      `${ETH_API}/getNFTMetadata?contractAddress=${WOW}&tokenId=44&refreshCache=false`,
    );
  });

  it("maps getAsset on Solana: the asset id is the item", async () => {
    const up = fakeFetch({ [SOL_RPC]: () => json(fixture("solana-asset")) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemPath(SOLANA), post({ contract: MADLAD }));
    expect(res.status).toBe(200);
    const detail = (await res.json()) as NftDetail;
    expect(detail.item.contract).toBe(MADLAD);
    expect(detail.item.tokenId).toBeNull();
    expect(detail.item.standard).toBe("metaplex-programmable");
    expect(detail.description).toBe("Fock it.");
    expect(detail.attributes).toStrictEqual([
      { trait: "Background", value: "Orange" },
      { trait: "Rank", value: "441" },
    ]);
    expect(detail.externalUrl).toBe("https://madlads.com");
    const p = dasCall(up.callsTo(SOL_RPC)[0]);
    expect(p.method).toBe("getAsset");
    expect(p.params).toStrictEqual({ id: MADLAD });
  });

  it("rejects a missing EVM tokenId and a present Solana one", async () => {
    const up = fakeFetch({ [ETH_API]: () => json({}), [SOL_RPC]: () => json({}) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const evm = await app.request(nftItemPath(ETH), post({ contract: WOW }));
    const sol = await app.request(nftItemPath(SOLANA), post({ contract: MADLAD, tokenId: "1" }));
    expect(evm.status).toBe(400);
    expect(sol.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });
});

describe("nft collection", () => {
  it("maps getContractMetadata: openSea name, image, supply, safelist", async () => {
    const up = fakeFetch({ [ETH_API]: () => json(fixture("evm-collection")) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftCollectionPath(ETH), post({ collection: WOW }));
    expect(res.status).toBe(200);
    const collection = (await res.json()) as NftCollection;
    expect(collection).toStrictEqual({
      id: WOW,
      name: "World of Women",
      symbol: "WOW",
      description:
        "World of Women is a collection of 10,000 NFTs that gives you full access to our network of artists, creators, entrepreneurs, and executives who are championing diversity and equal opportunity on the blockchain.\n\nCreated and illustrated by Yam Karkai (@ykarkai), World of Women has made prominent appearances at Christie's, The New Yorker and Billboard.\n\nThe Time is WoW.",
      image: {
        url: "https://i2c.seadn.io/admin-uploads/20e55f17e6d30cc82f8fcd35347339/e320e55f17e6d30cc82f8fcd35347339.png",
        mime: null,
      },
      totalSupply: "10000",
      standard: "erc721",
      spam: false,
      verified: true,
    });
    expect(up.callsTo(ETH_API)[0]?.url).toBe(
      `${ETH_API}/getContractMetadata?contractAddress=${WOW}`,
    );
  });

  it("maps a Solana collection asset", async () => {
    const up = fakeFetch({ [SOL_RPC]: () => json(fixture("solana-asset")) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftCollectionPath(SOLANA), post({ collection: MADLAD }));
    expect(res.status).toBe(200);
    const collection = (await res.json()) as NftCollection;
    expect(collection.id).toBe(MADLAD);
    expect(collection.name).toBe("Mad Lads");
    expect(collection.symbol).toBe("MAD");
    expect(collection.totalSupply).toBeNull();
    expect(collection.standard).toBe("metaplex-programmable");
    expect(collection.verified).toBe(false);
    expect(collection.image?.url).toBe(
      "https://madlads-collection.s3.us-west-2.amazonaws.com/_collection.png",
    );
  });
});

describe("nft floor", () => {
  it("maps both market rows and normalises amounts and currency", async () => {
    const up = fakeFetch({ [ETH_API]: () => json(fixture("evm-floor")) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftFloorPath(ETH), post({ collection: BAYC }));
    expect(res.status).toBe(200);
    const floor = (await res.json()) as NftFloor;
    expect(floor.floors).toStrictEqual([
      {
        marketplace: "opensea",
        amount: "6.03",
        currency: "ETH",
        retrievedAt: Date.parse("2026-11-23T03:35:32.348Z"),
      },
      {
        marketplace: "looksrare",
        amount: "69",
        currency: "ETH",
        retrievedAt: Date.parse("2025-01-13T03:42:07.872Z"),
      },
    ]);
    expect(up.callsTo(ETH_API)[0]?.url).toBe(`${ETH_API}/getFloorPrice?contractAddress=${BAYC}`);
  });

  it("prints exponent amounts as plain decimals and skips errored rows", async () => {
    const up = fakeFetch({ [ETH_API]: () => json(fixture("evm-floor-exponent")) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftFloorPath(ETH), post({ collection: BAYC }));
    expect(res.status).toBe(200);
    const floor = (await res.json()) as NftFloor;
    expect(floor.floors).toStrictEqual([
      { marketplace: "opensea", amount: "0.000055", currency: "ETH", retrievedAt: null },
    ]);
  });

  it("answers unsupported on Solana and on a chain the floor API does not serve", async () => {
    const up = fakeFetch({ [SOL_RPC]: () => json({}), [ARB_API]: () => json({}) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const sol = await app.request(nftFloorPath(SOLANA), post({ collection: MADLAD }));
    expect(sol.status).toBe(404);
    // eip155:42161 is in FLOOR_CHAINS; eip155:11155111 is neither covered nor floored.
    const sep = await app.request(nftFloorPath(SEPOLIA), post({ collection: WOW }));
    expect(sep.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });
});

describe("nft routes validation and failure mapping", () => {
  it("answers 404 unsupported without an upstream call on an uncovered chain", async () => {
    const up = fakeFetch({});
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(SEPOLIA), post({ owner: OWNER }));
    expect(res.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });

  it("answers 400 for a malformed owner", async () => {
    const up = fakeFetch({});
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    for (const owner of ["0x123", "not-an-address", "0xZZzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential bad inputs on purpose
      const res = await app.request(nftItemsPath(ETH), post({ owner }));
      expect(res.status).toBe(400);
    }
    expect(up.calls).toHaveLength(0);
  });

  it("fails over a malformed upstream answer, then gives up with 503", async () => {
    const up = fakeFetch({ [ETH_API]: () => new Response("<html>") });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(ETH), post({ owner: OWNER }));
    expect(res.status).toBe(503);
    expect(up.callsTo(ETH_API)).toHaveLength(1);
  });

  it("maps a DAS not-found error to 404", async () => {
    const up = fakeFetch({
      [SOL_RPC]: () =>
        json({ jsonrpc: "2.0", error: { code: -32000, message: "Asset not found" }, id: 1 }),
    });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemPath(SOLANA), post({ contract: MADLAD }));
    expect(res.status).toBe(404);
  });

  it("maps a non-not-found DAS error to a provider failure", async () => {
    const up = fakeFetch({
      [SOL_RPC]: () =>
        json({ jsonrpc: "2.0", error: { code: -32602, message: "Invalid params" }, id: 1 }),
    });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const res = await app.request(nftItemsPath(SOLANA), post({ owner: SOL_OWNER }));
    expect(res.status).toBe(503);
  });
});

describe("nft routes cache", () => {
  it("serves the second identical request from the cache with the same providers header", async () => {
    const cache = memoryEdgeCache();
    const up = fakeFetch({ [ETH_API]: () => json(fixture("evm-owned-page")) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, nfts: { cache } });
    const first = await app.request(nftItemsPath(ETH), post({ owner: OWNER }));
    const second = await app.request(nftItemsPath(ETH), post({ owner: OWNER }));
    expect(second.status).toBe(200);
    expect(up.callsTo(ETH_API)).toHaveLength(1);
    expect(second.headers.get(PROVIDERS_HEADER)).toBe("alchemy-nfts");
    expect(second.headers.get(PROVIDERS_HEADER)).toBe(first.headers.get(PROVIDERS_HEADER));
    await expect(second.json()).resolves.toStrictEqual(await first.json());
    expect(cache.ttls).toStrictEqual([60]);
  });

  it("does not cache a provider failure", async () => {
    const cache = memoryEdgeCache();
    const up = fakeFetch({ [ETH_API]: flakyUpstream() });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, nfts: { cache } });
    const failed = await app.request(nftItemsPath(ETH), post({ owner: OWNER }));
    const retried = await app.request(nftItemsPath(ETH), post({ owner: OWNER }));
    expect(failed.status).toBe(503);
    expect(retried.status).toBe(200);
    expect(up.callsTo(ETH_API)).toHaveLength(2);
  });
});

describe("nft routes metering", () => {
  const app = (up: ReturnType<typeof fakeFetch>, share: ReturnType<typeof recordingLimiter>) =>
    gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share },
    });

  it("bills each upstream call by its NFT cost row", async () => {
    const share = recordingLimiter();
    const up = fakeFetch({
      [ETH_API]: () => json({ ownedNfts: [], pageKey: null }),
      [SOL_RPC]: () => json({ jsonrpc: "2.0", result: { items: [] }, id: 1 }),
    });
    const g = app(up, share);
    const nfts = await g.request(nftItemsPath(ETH), post({ owner: OWNER }));
    expect(nfts.status).toBe(200);
    // getNFTsForOwner = 100 CU → 2 share units; getAssetsByOwner = 200 CU → 4.
    expect(share.deltas).toStrictEqual([2]);
    const sol = await g.request(nftItemsPath(SOLANA), post({ owner: SOL_OWNER }));
    expect(sol.status).toBe(200);
    expect(share.deltas).toStrictEqual([2, 4]);
  });

  it("bills detail, collection and floor by their rows", async () => {
    const share = recordingLimiter();
    const up = fakeFetch({
      [`${ETH_API}/getNFTMetadata`]: () => json(fixture("evm-item-detail")),
      [`${ETH_API}/getContractMetadata`]: () => json(fixture("evm-collection")),
      [`${ETH_API}/getFloorPrice`]: () => json(fixture("evm-floor")),
      [SOL_RPC]: () => json(fixture("solana-asset")),
    });
    const g = app(up, share);
    await g.request(nftItemPath(ETH), post({ contract: WOW, tokenId: "44" }));
    await g.request(nftCollectionPath(ETH), post({ collection: WOW }));
    await g.request(nftFloorPath(ETH), post({ collection: BAYC }));
    await g.request(nftItemPath(SOLANA), post({ contract: MADLAD }));
    // 10 CU → 1 share unit each; the Solana getAsset is 200 CU → 4.
    expect(share.deltas).toStrictEqual([1, 1, 1, 4]);
    expect(share.keys).toStrictEqual(Array.from({ length: 4 }, () => "alchemy:unknown"));
  });
});
