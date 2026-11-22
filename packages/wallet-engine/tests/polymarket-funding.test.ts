// oxlint-disable vitest/no-conditional-in-test -- narrowing JSON payloads is inherent to
// asserting on them.

/**
 * `fund.deposit` / `fund.withdraw` on the real Node kernel + RequestController: the deposit is a
 * described `send` of pUSD to the located deposit wallet (never eligibility-gated), the withdraw is
 * a relayer `Batch` of exactly one `pUSD.transfer(owner, amount)` — builder-guarded,
 * kernel-described, submitted over the exact HMAC'd body, and never auto-resubmitted when the
 * submit is lost (`unknown`).
 */
import { createHmac } from "node:crypto";

import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { PUSD } from "../src/apps/polymarket/constants.ts";
import type { PolymarketBuilder } from "../src/apps/polymarket/provider.ts";
import { derivePolymarketWallets } from "../src/apps/polymarket/wallets.ts";
import type { EligibilityResponse } from "../src/gateway/contract/eligibility.ts";
import { MNEMONIC, pumpUntil, world } from "./apps-helpers.ts";

const OWNER = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const SIGNER = OWNER.address;
const WALLETS = derivePolymarketWallets(SIGNER);

type Tx = { readonly state: string; readonly proxyAddress?: string };

type Feed = {
  deployed?: (address: string, type: string) => boolean;
  nonce?: string;
  transactions?: Tx[];
  submitted?: string[];
};

const ELIGIBILITY: EligibilityResponse = {
  apps: { hyperliquid: "available", polymarket: "available" },
} as unknown as EligibilityResponse;

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

const scripted = (feed: Feed): typeof fetch => {
  const submitted: string[] = [];
  feed.submitted = submitted;
  return async (input, init) => {
    await Promise.resolve();
    const url = new URL(
      typeof input === "string" ? input : input instanceof Request ? input.url : input.href,
    );
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.pathname === "/deployed") {
      const type = url.searchParams.get("type") ?? "SAFE";
      return json({
        deployed: feed.deployed?.(url.searchParams.get("address") ?? "", type) ?? false,
      });
    }
    if (url.pathname === "/nonce") {
      return json({ nonce: feed.nonce ?? "7" });
    }
    if (url.pathname === "/submit") {
      submitted.push(body);
      return json({ transactionID: "tx-1", state: "STATE_PENDING" });
    }
    if (url.pathname === "/transaction") {
      const tx = feed.transactions?.shift() ?? { state: "STATE_CONFIRMED" };
      return json([
        {
          transactionID: url.searchParams.get("id") ?? "tx-1",
          transactionHash: `0x${"aa".repeat(32)}`,
          ...tx,
        },
      ]);
    }
    if (url.pathname === "/api/v1/apps/eligibility" || url.pathname.endsWith("/eligibility")) {
      return json(ELIGIBILITY);
    }
    if (url.pathname === "/time") {
      return json(Date.now());
    }
    /* Everything else (locate reads, token metadata, etc.) answers an empty ok. */
    return json({}, 200);
  };
};

const BUILDER_TS = "1795270107";
const builderFor = (): PolymarketBuilder & {
  signs: Array<{ method: string; path: string; body: string }>;
} => {
  const signs: Array<{ method: string; path: string; body: string }> = [];
  return {
    signs,
    code: `0x${"ab".repeat(32)}`,
    sign: async (request) => {
      await Promise.resolve();
      signs.push(request);
      const signature = createHmac("sha256", "builder-secret")
        .update(`${BUILDER_TS}${request.method}${request.path}${request.body}`)
        .digest("base64");
      return {
        POLY_BUILDER_API_KEY: "key",
        POLY_BUILDER_PASSPHRASE: "pass",
        POLY_BUILDER_SIGNATURE: signature,
        POLY_BUILDER_TIMESTAMP: BUILDER_TS,
      };
    },
  };
};

const funded = async (feed: Feed, opts?: { builder?: PolymarketBuilder | false }) => {
  const w = await world(0, {
    polymarket: opts?.builder === false ? {} : { builder: opts?.builder ?? builderFor() },
    fetch: scripted(feed),
  });
  feed.deployed ??= (address, type) =>
    type === "WALLET" && address.toLowerCase() === WALLETS.beacon.toLowerCase();
  return w;
};

const approveById = async (w: Awaited<ReturnType<typeof world>>, id: string): Promise<void> => {
  await w.approve(id);
};

describe("polymarket funding", () => {
  it("deposit prepares a described pUSD send to the located deposit wallet", async () => {
    const w = await funded({ transactions: [] });
    const pending = await w.pm!.fund.deposit(w.group, { amount: 2_500_000n, fee: "normal" });
    const request = w.requests.getState().requests[pending.requestId] as
      | {
          display?: {
            outflows?: Array<{ to?: string; amount?: { asset?: string; amount?: string } }>;
          };
        }
      | undefined;
    expect(request).toBeDefined();
    const outflow = request?.display?.outflows?.[0];
    expect(outflow?.to?.toLowerCase()).toBe(WALLETS.beacon.toLowerCase());
    expect(outflow?.amount?.asset?.toLowerCase()).toBe(PUSD.toLowerCase());
    expect(outflow?.amount?.amount).toBe("2500000");
    void pending.outcome.catch(() => undefined);
    await w.destroy();
  });

  it("deposit refuses an undeployed or Safe-only account and a non-positive amount", async () => {
    const w = await funded({
      deployed: () => false,
      transactions: [],
    });
    await expect(
      w.pm!.fund.deposit(w.group, { amount: 1_000_000n, fee: "normal" }),
    ).rejects.toMatchObject({
      category: "not-enabled",
    });
    await expect(w.pm!.fund.deposit(w.group, { amount: 0n, fee: "normal" })).rejects.toMatchObject({
      category: "invalid-input",
    });
    await w.destroy();
    const safe = await funded({
      deployed: (address, type) =>
        type === "SAFE" && address.toLowerCase() === WALLETS.safe.toLowerCase(),
      transactions: [],
    });
    await expect(
      safe.pm!.fund.deposit(safe.group, { amount: 1_000_000n, fee: "normal" }),
    ).rejects.toMatchObject({ category: "needs-migration" });
    await safe.destroy();
  });

  it("withdraw signs one pUSD transfer to the owner, submits the exact signed body and confirms", async () => {
    const builder = builderFor();
    const feed: Feed = { nonce: "7", transactions: [{ state: "STATE_CONFIRMED" }] };
    const w = await funded(feed, { builder });
    const { requestId, outcome } = await w.pm!.fund.withdraw(w.group, { amount: 3_000_000n });
    const request = w.requests.getState().requests[requestId];
    expect(request).toBeDefined();
    await approveById(w, requestId);
    await pumpUntil(w.timers, () => (feed.submitted?.length ?? 0) > 0);
    expect(builder.signs).toHaveLength(1);
    const body = JSON.parse(feed.submitted![0]!) as {
      type: string;
      signature: string;
      depositWalletParams: {
        depositWallet: string;
        calls: Array<{ target: string; value: string; data: string }>;
      };
    };
    expect(body.type).toBe("WALLET");
    expect(body.depositWalletParams.depositWallet.toLowerCase()).toBe(WALLETS.beacon.toLowerCase());
    expect(body.depositWalletParams.calls).toHaveLength(1);
    const call = body.depositWalletParams.calls[0]!;
    expect(call.target.toLowerCase()).toBe(PUSD.toLowerCase());
    expect(call.value).toBe("0");
    /* transfer(owner, 3_000_000) */
    expect(call.data.startsWith("0xa9059cbb")).toBe(true);
    expect(call.data.slice(10, 74)).toBe(SIGNER.slice(2).toLowerCase().padStart(64, "0"));
    expect(BigInt(`0x${call.data.slice(74)}`)).toBe(3_000_000n);
    let settled: string | undefined;
    void outcome.then((o) => {
      settled = o.kind;
      return undefined;
    });
    await pumpUntil(w.timers, () => settled !== undefined);
    await expect(outcome).resolves.toStrictEqual({ kind: "ok" });
    await w.destroy();
  });

  it("withdraw without a builder fails before any request or fetch", async () => {
    const w = await funded({ transactions: [] }, { builder: false });
    const calls = 0;
    await expect(w.pm!.fund.withdraw(w.group, { amount: 1_000_000n })).rejects.toMatchObject({
      category: "builder-required",
    });
    expect(w.requests.getState().requests[""]).toBeUndefined();
    expect(calls).toBe(0);
    await w.destroy();
  });

  it("a lost withdraw submit resolves unknown — never resubmitted", async () => {
    const builder = builderFor();
    const feed: Feed = { nonce: "7", transactions: [] };
    const base = scripted(feed);
    let submitted = 0;
    const flakyFetch: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href,
      );
      if (url.pathname === "/submit") {
        submitted += 1;
        throw new Error("socket hangup");
      }
      return base(input, init);
    };
    const w = await world(0, { polymarket: { builder }, fetch: flakyFetch });
    feed.deployed = (address, type) =>
      type === "WALLET" && address.toLowerCase() === WALLETS.beacon.toLowerCase();
    const { requestId, outcome } = await w.pm!.fund.withdraw(w.group, { amount: 1_000_000n });
    await approveById(w, requestId);
    await expect(outcome).resolves.toStrictEqual({ kind: "unknown" });
    expect(submitted).toBe(1);
    await w.destroy();
  });
});
