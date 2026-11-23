/**
 * The /v1/approvals contract: the address lives in a strict POST body, candidates are keys only
 * (token, spender, block — never a live state), the list cap holds, and the route scopes to the EVM
 * client id.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  APPROVAL_CANDIDATES_MAX,
  approvals,
  approvalsPath,
  approvalsRequest,
  approvalsResponse,
} from "../src/gateway/contract/index.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

describe("approvalsRequest", () => {
  it("accepts a bare address", () => {
    expect(approvalsRequest.safeParse({ address: OWNER }).success).toBe(true);
  });

  it.each([
    [{}, "missing address"],
    [{ address: "d8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, "address without 0x"],
    [{ address: "not-an-address" }, "not hex"],
    [{ address: OWNER, cursor: "100" }, "no cursor on this route"],
    [{ address: OWNER, extra: 1 }, "unknown key"],
    ["not-an-object", "not an object"],
  ])("rejects %s (%s)", (body, _why) => {
    expect(approvalsRequest.safeParse(body).success).toBe(false);
  });
});

describe("approvalsResponse", () => {
  const candidates = [
    { kind: "erc20", token: TOKEN, spender: OWNER, block: "26401664" },
    { kind: "erc721", token: TOKEN, spender: OWNER, tokenId: "42", block: "1" },
    { kind: "operator", token: TOKEN, operator: OWNER, block: "2" },
    { kind: "permit2", token: TOKEN, spender: OWNER, block: "3" },
  ];

  it("accepts every candidate kind and an empty list", () => {
    expect(
      approvalsResponse.safeParse({ toBlock: "26401664", candidates, truncated: false }).success,
    ).toBe(true);
    expect(
      approvalsResponse.safeParse({ toBlock: "26401664", candidates: [], truncated: false })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown kind, a wrong field set and bad field shapes", () => {
    expect(
      approvalsResponse.safeParse({
        toBlock: "26401664",
        candidates: [{ kind: "erc1155", token: TOKEN, operator: OWNER, block: "1" }],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      approvalsResponse.safeParse({
        toBlock: "26401664",
        candidates: [{ kind: "erc721", token: TOKEN, spender: OWNER, block: "1" }],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      approvalsResponse.safeParse({
        toBlock: "26401664",
        candidates: [{ kind: "erc20", token: TOKEN, spender: OWNER, block: "1", extra: 1 }],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      approvalsResponse.safeParse({
        toBlock: "0x1934900",
        candidates: [],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      approvalsResponse.safeParse({
        toBlock: "26401664",
        candidates: [{ kind: "erc20", token: "nothex", spender: OWNER, block: "1" }],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      approvalsResponse.safeParse({
        toBlock: "26401664",
        candidates: [{ kind: "erc721", token: TOKEN, spender: OWNER, tokenId: "01", block: "1" }],
        truncated: false,
      }).success,
    ).toBe(false);
  });

  it("requires truncated and caps the candidate list", () => {
    expect(approvalsResponse.safeParse({ toBlock: "1", candidates: [] }).success).toBe(false);
    const many = Array.from({ length: APPROVAL_CANDIDATES_MAX + 1 }, () => candidates[0]);
    expect(
      approvalsResponse.safeParse({ toBlock: "1", candidates: many, truncated: true }).success,
    ).toBe(false);
    expect(
      approvalsResponse.safeParse({
        toBlock: "1",
        candidates: many.slice(0, APPROVAL_CANDIDATES_MAX),
        truncated: true,
      }).success,
    ).toBe(true);
  });
});

describe("approvalsPath", () => {
  it("is a POST body route — no address in the URL", () => {
    expect(approvals.method).toBe("POST");
    expect(approvalsPath("eip155:1")).toBe("/v1/approvals/eip155:1");
    expect(approvals.path.replace(":caip2", "eip155:1")).toBe(approvalsPath("eip155:1"));
  });
});
