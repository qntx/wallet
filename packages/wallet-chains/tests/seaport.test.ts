import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import type { EvmTokenTable } from "../src/evm/tokens.ts";

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;
const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";
const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const OFFERER = "0x00000000000000000000000000000000DeaDBeef";
const ZONE = "0x0000000000000000000000000000000000000000";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NFT = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
const table: EvmTokenTable = { "1": { [TOKEN]: { symbol: "USDC", decimals: 6 } } };

type Field = { name: string; type: string };
const fields = (spec: string): Field[] =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });

const OFFER_ITEM = fields(
  "uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount",
);
const CONSIDERATION_ITEM = [...OFFER_ITEM, { type: "address", name: "recipient" }];

const orderTypes = (): Record<string, Field[]> => ({
  OrderComponents: fields(
    "address offerer, address zone, OfferItem[] offer, ConsiderationItem[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter",
  ),
  OfferItem: OFFER_ITEM,
  ConsiderationItem: CONSIDERATION_ITEM,
});

const offerItem = (itemType: number, token: string, start = "1", end = "1") => ({
  itemType,
  token,
  identifierOrCriteria: "1",
  startAmount: start,
  endAmount: end,
});

const order = (overrides: Record<string, unknown> = {}) => ({
  offerer: OFFERER,
  zone: ZONE,
  offer: [offerItem(2, NFT)],
  consideration: [{ ...offerItem(1, TOKEN, "5000000", "5000000"), recipient: OFFERER }],
  orderType: 0,
  startTime: "1700000000",
  endTime: "1700001000",
  zoneHash: `0x${"00".repeat(32)}`,
  salt: "123",
  conduitKey: `0x${"00".repeat(32)}`,
  counter: "0",
  ...overrides,
});

const doc = (
  overrides: Record<string, unknown> = {},
  message: Record<string, unknown> = {},
  types: Record<string, Field[]> = orderTypes(),
) => ({
  types,
  primaryType: "OrderComponents",
  domain: {
    name: "Seaport",
    version: "1.6",
    chainId: 1,
    verifyingContract: SEAPORT_16,
    ...overrides,
  },
  message: order(message),
});

const decode = (d: unknown) =>
  decodeEvm(
    { kind: "evm.typed-data", network: "eip155:1", account: ACCOUNT, typedData: JSON.stringify(d) },
    table,
  );

const seaportOf = (d: unknown) => {
  const { message } = decode(d);
  return message?.kind === "typed-data" ? message.seaport : undefined;
};

describe("decodeEvm: Seaport orders", () => {
  it("recognizes an OrderComponents listing on Seaport 1.6 and 1.5", () => {
    const intent = decode(doc());
    expect(intent.summary).toBe("swap");
    expect(intent.verifiability).toBe("opaque");
    expect(intent.message).toMatchObject({ kind: "typed-data", primaryType: "OrderComponents" });
    const seaport = seaportOf(doc());
    expect(seaport?.offerer).toBe("0x00000000000000000000000000000000DeaDBeef");
    expect(seaport?.startTime).toBe(1700000000);
    expect(seaport?.endTime).toBe(1700001000);
    expect(seaport?.offer).toStrictEqual([
      {
        kind: "erc721",
        token: NFT,
        identifier: "1",
        startAmount: { asset: NFT, amount: "1" },
        endAmount: { asset: NFT, amount: "1" },
      },
    ]);
    expect(seaport?.consideration).toStrictEqual([
      {
        kind: "erc20",
        token: TOKEN,
        identifier: "1",
        startAmount: { asset: TOKEN, amount: "5000000", symbol: "USDC", decimals: 6 },
        endAmount: { asset: TOKEN, amount: "5000000", symbol: "USDC", decimals: 6 },
        recipient: OFFERER,
      },
    ]);

    expect(seaportOf(doc({ verifyingContract: SEAPORT_15 }))).toBeDefined();
  });

  it("reads a native offer item as ETH and keeps amounts opaque for criteria items", () => {
    const seaport = seaportOf(
      doc({}, { offer: [offerItem(0, ZONE, "100", "200"), offerItem(4, NFT)], consideration: [] }),
    );
    expect(seaport?.offer[0]?.startAmount).toStrictEqual({
      asset: "native",
      amount: "100",
      symbol: "ETH",
      decimals: 18,
    });
    expect(seaport?.offer[1]?.kind).toBe("erc721-criteria");
  });

  it("omits startTime/endTime beyond uint48", () => {
    const big = (2n ** 256n - 1n).toString(10);
    const seaport = seaportOf(doc({}, { startTime: big }));
    expect(seaport?.startTime).toBeUndefined();
    expect(seaport?.endTime).toBe(1700001000);
  });

  it("does not recognize a wrong contract, domain name, or BulkOrder", () => {
    expect(seaportOf(doc({ verifyingContract: NFT }))).toBeUndefined();
    expect(seaportOf(doc({ name: "OpenSea" }))).toBeUndefined();
    const bulk = {
      types: orderTypes(),
      primaryType: "BulkOrder",
      domain: doc().domain,
      message: {},
    };
    expect(decode(bulk).message).toMatchObject({ kind: "typed-data" });
    expect(seaportOf(bulk)).toBeUndefined();
  });

  it("does not recognize a renamed, extra or reordered field", () => {
    const ownFields =
      "address offerer, address zone, OfferItem[] offer, ConsiderationItem[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter";
    const renamed = doc(
      {},
      {},
      {
        ...orderTypes(),
        OrderComponents: fields(ownFields.replace("bytes32 zoneHash", "uint256 zoneHash")),
      },
    );
    const extra = doc(
      {},
      {},
      { ...orderTypes(), OrderComponents: fields(`${ownFields}, uint256 hint`) },
    );
    const extraType = doc({}, {}, { ...orderTypes(), Other: fields("uint256 a") });
    for (const d of [renamed, extra, extraType]) {
      expect(seaportOf(d)).toBeUndefined();
    }
  });

  it("does not recognize an itemType outside 0-5 or a malformed message field", () => {
    expect(seaportOf(doc({}, { offer: [offerItem(6, NFT)] }))).toBeUndefined();
    expect(seaportOf(doc({}, { offerer: "0xzz" }))).toBeUndefined();
    expect(
      seaportOf(doc({}, { consideration: [{ ...offerItem(1, TOKEN), recipient: "0xzz" }] })),
    ).toBeUndefined();
  });
});
