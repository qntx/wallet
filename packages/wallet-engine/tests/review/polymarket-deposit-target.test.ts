/**
 * PoC for finding R-6 (polymarket-deposit-relayer-only).
 *
 * Property that should hold: a `deployed` verdict steering deposits to an account wallet is proven
 * on-chain (an `eth_getCode` on the candidate, cross-checked like the transaction pipeline's
 * independent-endpoint reads), not by the unauthenticated relayer's word alone.
 *
 * Current behaviour pinned here: `wallets.locate` (src/apps/polymarket/wallets.ts) holds only the
 * relayer `PolymarketHttp` — three unauthenticated `GET /deployed` probes decide `deployed` and
 * pick the UUPS candidate first — and `funding.deposit` (src/apps/polymarket/funding.ts) prepares a
 * pUSD `send` to that answer with no chain-RPC code check anywhere in the path.
 *
 * These assertions pin the buggy behaviour: they pass today and must be revisited by the fix.
 */
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { RELAYER_HOST } from "../../src/apps/polymarket/constants.ts";
import type { PolymarketHttp, PolymarketHttpRequest } from "../../src/apps/polymarket/http.ts";
import {
  createPolymarketWallets,
  derivePolymarketWallets,
} from "../../src/apps/polymarket/wallets.ts";
import type { EligibilityResponse } from "../../src/gateway/contract/eligibility.ts";
import { MNEMONIC, world } from "../apps-helpers.ts";

const OWNER = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const SIGNER = OWNER.address;
const WALLETS = derivePolymarketWallets(SIGNER);

const ELIGIBILITY: EligibilityResponse = {
  apps: { hyperliquid: "available", polymarket: "available" },
} as unknown as EligibilityResponse;

type Captured = { readonly url: string; readonly method: string; readonly body: string };

/** `true` when the relayer claims only the UUPS candidate deployed. */
const onlyUupsUp = (address: string, type: string): boolean =>
  type === "WALLET" && address.toLowerCase() === WALLETS.uups.toLowerCase();

/** A `GET /deployed` spec — every call `locate` issues is one. */
const isDeployedGet = (s: PolymarketHttpRequest): boolean =>
  s.method === "GET" && s.path === "/deployed";

/** `type:address` the spec probed — Set-compared so call order does not matter. */
const probe = (s: PolymarketHttpRequest): string => `${s.query?.["type"]}:${s.query?.["address"]}`;

/**
 * The funding test's scripted feed plus a record of every request that reaches it — anything not a
 * relayer/CLOB call falls through to an empty ok, exactly like tests/polymarket-funding.test.ts.
 * `polygon.test/rpc` calls never reach this stub: `world` routes them to its private `polyRpc`
 * (apps-helpers.ts), which answers a fixed send-prep method list — chain-RPC calls inside the
 * `send` preparation are generic gas/metadata reads, not wallet-existence checks.
 */
const scripted =
  (
    feed: { deployed: (address: string, type: string) => boolean },
    calls: Captured[],
  ): typeof fetch =>
  async (input, init) => {
    await Promise.resolve();
    const url = new URL(
      typeof input === "string" ? input : input instanceof Request ? input.url : input.href,
    );
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url: url.toString(), method: init?.method ?? "GET", body });
    if (url.pathname === "/deployed") {
      const type = url.searchParams.get("type") ?? "SAFE";
      return Response.json({
        deployed: feed.deployed(url.searchParams.get("address") ?? "", type),
      });
    }
    if (url.pathname === "/api/v1/apps/eligibility" || url.pathname.endsWith("/eligibility")) {
      return Response.json(ELIGIBILITY);
    }
    if (url.pathname === "/time") {
      return Response.json(Date.now());
    }
    return Response.json({});
  };

describe("R-6: the deposit target is proven only by the unauthenticated relayer", () => {
  it("locate's entire evidence gather is three unauthenticated GET /deployed calls", async () => {
    const specs: PolymarketHttpRequest[] = [];
    const http: PolymarketHttp = {
      request: async (spec, _schema) => {
        specs.push(spec);
        await Promise.resolve();
        // The relayer claims only the UUPS candidate is deployed.
        return { deployed: spec.query?.["address"] === WALLETS.uups } as never;
      },
      time: async () => Promise.resolve({ serverSeconds: 0, skewMs: 0 }),
    };
    const located = await createPolymarketWallets(http).locate(SIGNER);
    // UUPS first — the relayer's `true` on it alone made it "deployed" and the deposit target.
    expect(located).toMatchObject({
      wallet: WALLETS.uups,
      kind: "deposit-wallet",
      deployed: true,
    });
    /* The complete I/O surface of `locate` — the type it is built from (`PolymarketHttp`) can only
       reach the Polymarket hosts; no chain-RPC client exists in this object at all. */
    expect(specs).toHaveLength(3);
    expect(specs.every(isDeployedGet)).toBe(true);
    expect(specs.every((s) => s.host === RELAYER_HOST)).toBe(true);
    expect(new Set(specs.map(probe))).toStrictEqual(
      new Set([`WALLET:${WALLETS.beacon}`, `SAFE:${WALLETS.safe}`, `WALLET:${WALLETS.uups}`]),
    );
    // Every probe is unauthenticated — no header set carries a credential.
    expect(specs.every((s) => s.headers === undefined)).toBe(true);
  });

  it("a relayer `true` on the UUPS candidate alone steers the deposit send to it", async () => {
    const calls: Captured[] = [];
    const w = await world(0, {
      polymarket: {},
      fetch: scripted({ deployed: onlyUupsUp }, calls),
    });
    const pending = await w.pm!.fund.deposit(w.group, { amount: 2_500_000n, fee: "normal" });
    const request = w.requests.getState().requests[pending.requestId] as
      | { display?: { outflows?: Array<{ to?: string }> } }
      | undefined;
    // The pUSD send is addressed to the UUPS candidate — the answer the relayer alone gave.
    expect(request?.display?.outflows?.[0]?.to?.toLowerCase()).toBe(WALLETS.uups.toLowerCase());
    // No request the funding flow issued carried an eth_getCode — the wallet-existence evidence
    // came only from the three relayer probes (also unauthenticated in the full path).
    const deployedCalls = calls.filter((c) => c.url.includes("/deployed"));
    expect(deployedCalls).toHaveLength(3);
    expect(calls.every((c) => !c.body.includes("eth_getCode"))).toBe(true);
    void pending.outcome.catch(() => undefined);
    await w.destroy();
  });
});
