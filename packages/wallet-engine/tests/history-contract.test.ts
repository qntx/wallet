/**
 * The /v1/history contract: the address lives in a strict POST body, the cursor is a decimal block
 * bound, the page caps hold, and the route scopes to the EVM client id.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  HISTORY_ITEMS_MAX,
  HISTORY_PAGE_MAX,
  HISTORY_TRANSFERS_MAX,
  historyPath,
  historyRequest,
  historyResponse,
} from "../src/gateway/contract/index.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const transfer = {
  kind: "native",
  from: OWNER,
  to: "0xfa5180956e87bff2d1fce8423d2e755846ac3b24",
  contract: null,
  tokenId: null,
  amount: "1",
  decimals: null,
  symbol: null,
  logIndex: null,
};

const item = {
  hash: `0x${"ab".repeat(32)}`,
  block: "26401664",
  timestamp: 1700000000000,
  transfers: [transfer],
};

describe("historyRequest", () => {
  it("accepts a bare address and an address with cursor and limit", () => {
    expect(historyRequest.safeParse({ address: OWNER }).success).toBe(true);
    expect(
      historyRequest.safeParse({ address: OWNER, cursor: "26401664", limit: 25 }).success,
    ).toBe(true);
    expect(historyRequest.safeParse({ address: OWNER, cursor: "0" }).success).toBe(true);
  });

  it.each([
    [{}, "missing address"],
    [{ address: "d8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, "address without 0x"],
    [{ address: OWNER, limit: 0 }, "limit below range"],
    [{ address: OWNER, limit: HISTORY_PAGE_MAX + 1 }, "limit above range"],
    [{ address: OWNER, limit: 1.5 }, "non-integer limit"],
    [{ address: OWNER, cursor: "0x10" }, "hex cursor"],
    [{ address: OWNER, cursor: "01" }, "leading-zero cursor"],
    [{ address: OWNER, cursor: -1 }, "non-string cursor"],
    [{ address: OWNER, extra: 1 }, "unknown key"],
  ])("rejects %s (%s)", (body, _why) => {
    expect(historyRequest.safeParse(body).success).toBe(false);
  });
});

describe("historyResponse", () => {
  it("accepts the documented shape with a null cursor", () => {
    expect(
      historyResponse.safeParse({ items: [item], cursor: null, truncated: false }).success,
    ).toBe(true);
    expect(
      historyResponse.safeParse({ items: [item], cursor: "26401664", truncated: true }).success,
    ).toBe(true);
  });

  it("requires truncated", () => {
    expect(historyResponse.safeParse({ items: [item], cursor: null }).success).toBe(false);
    expect(
      historyResponse.safeParse({ items: [item], cursor: null, truncated: "no" }).success,
    ).toBe(false);
  });

  it("caps items and transfers per item", () => {
    const many = Array.from({ length: HISTORY_ITEMS_MAX + 1 }, () => item);
    expect(
      historyResponse.safeParse({ items: many, cursor: null, truncated: true }).success,
    ).toBe(false);
    const fat = {
      ...item,
      transfers: Array.from({ length: HISTORY_TRANSFERS_MAX + 1 }, () => transfer),
    };
    expect(
      historyResponse.safeParse({ items: [fat], cursor: null, truncated: true }).success,
    ).toBe(false);
    const empty = { ...item, transfers: [] };
    expect(
      historyResponse.safeParse({ items: [empty], cursor: null, truncated: false }).success,
    ).toBe(false);
  });
});

describe("historyPath", () => {
  it("is a POST body route — no address in the URL", () => {
    expect(historyPath("eip155:1")).toBe("/v1/history/eip155:1");
  });
});
