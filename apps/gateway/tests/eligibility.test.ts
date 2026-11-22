/**
 * `GET /v1/eligibility` — edge-resolved country/region → per-app availability, with the
 * conservative blocked default for unknown/Tor callers and `private, no-store` caching.
 */
import { describe, expect, it } from "vite-plus/test";

import { eligibility } from "@qntx/wallet-engine/gateway/contract";

import { ELIGIBILITY } from "../src/config/eligibility.ts";
import { expectContract, fakeFetch, gateway, headers } from "./helpers.ts";

/* Eligibility has no upstream — an empty handler table makes any call throw. */
const up = fakeFetch({});
const app = gateway({ fetch: up.fetch });

const at = async (cf?: { country?: string; regionCode?: string }): Promise<Response> => {
  const request = new Request(`https://gw.test${eligibility.path}`, { headers: headers() });
  if (cf !== undefined) {
    Object.defineProperty(request, "cf", { value: cf, configurable: true });
  }
  return app.request(request);
};

type Apps = {
  country: string | null;
  region: string | null;
  apps: Record<string, string>;
};

describe("eligibility", () => {
  it("answers exactly the configured apps — no app name appears in the route", async () => {
    const body = (await expectContract(await at({ country: "FR" }), eligibility.response)) as Apps;
    expect(Object.keys(body.apps).toSorted()).toStrictEqual(Object.keys(ELIGIBILITY).toSorted());
  });

  it("answers blocked for the US (Hyperliquid) and close-only for Polymarket", async () => {
    const body = (await expectContract(await at({ country: "US" }), eligibility.response)) as Apps;
    expect(body.country).toBe("US");
    expect(body.apps).toStrictEqual({ hyperliquid: "blocked", polymarket: "close-only" });
  });

  it("resolves subdivisions before the country: CA-ON vs CA-BC", async () => {
    const on = (await expectContract(
      await at({ country: "CA", regionCode: "ON" }),
      eligibility.response,
    )) as Apps;
    expect(on.apps).toStrictEqual({ hyperliquid: "blocked", polymarket: "close-only" });
    const bc = (await expectContract(
      await at({ country: "CA", regionCode: "BC" }),
      eligibility.response,
    )) as Apps;
    expect(bc.apps).toStrictEqual({ hyperliquid: "available", polymarket: "close-only" });
  });

  it("a bare CA is available for Hyperliquid and unlisted for Polymarket", async () => {
    const body = (await expectContract(await at({ country: "CA" }), eligibility.response)) as Apps;
    expect(body.apps).toStrictEqual({ hyperliquid: "available", polymarket: "available" });
  });

  it("sanctioned subdivisions block both apps while the rest of the country stays open", async () => {
    const crimea = (await expectContract(
      await at({ country: "UA", regionCode: "43" }),
      eligibility.response,
    )) as Apps;
    expect(crimea.apps).toStrictEqual({ hyperliquid: "blocked", polymarket: "blocked" });
    const elsewhere = (await expectContract(
      await at({ country: "UA", regionCode: "80" }),
      eligibility.response,
    )) as Apps;
    expect(elsewhere.apps).toStrictEqual({ hyperliquid: "available", polymarket: "available" });
  });

  it("GB is available for Hyperliquid and close-only for Polymarket", async () => {
    const body = (await expectContract(await at({ country: "GB" }), eligibility.response)) as Apps;
    expect(body.apps).toStrictEqual({ hyperliquid: "available", polymarket: "close-only" });
  });

  it("KP is blocked for both apps even though it also appears in the close-only table", async () => {
    const body = (await expectContract(await at({ country: "KP" }), eligibility.response)) as Apps;
    expect(body.apps).toStrictEqual({ hyperliquid: "blocked", polymarket: "blocked" });
  });

  it.each(["XX", "T1"])("fails closed for %s", async (country) => {
    const body = (await expectContract(await at({ country }), eligibility.response)) as Apps;
    expect(body.country).toBe(country);
    expect(body.apps).toStrictEqual({ hyperliquid: "blocked", polymarket: "blocked" });
  });

  it("fails closed when the edge provides no cf properties", async () => {
    const body = (await expectContract(await at(), eligibility.response)) as Apps;
    expect(body.country).toBeNull();
    expect(body.region).toBeNull();
    expect(body.apps).toStrictEqual({ hyperliquid: "blocked", polymarket: "blocked" });
  });

  it("is private and uncached — the answer depends on the caller IP", async () => {
    const res = await at({ country: "US" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
