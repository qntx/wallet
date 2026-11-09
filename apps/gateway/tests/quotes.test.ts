import { describe, expect, it } from "vite-plus/test";

import { bridgeQuote, swapQuote, swapQuoteSolana } from "@qntx/wallet-engine/gateway/contract";

import { zeroExConfig } from "../src/providers/zerox.ts";
import { SEPOLIA, expectContract, fakeFetch, gateway, headers } from "./helpers.ts";

const API = "https://api.0x.org";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const TAKER = "0x8f3796aa4dB3f47E0fE0D19f9c3c96a51aD5f0F8";
const AH = "0x0000000000001fF3684f28c67538d4D072C22734";

const QUERY = `network=${SEPOLIA}&sellToken=${USDC}&buyToken=${WETH}&sellAmount=1000000&taker=${TAKER}&slippageBps=100`;

const filled = (overrides: Record<string, unknown> = {}) => ({
  liquidityAvailable: true,
  allowanceTarget: AH,
  blockNumber: "21000000",
  buyAmount: "400000000000000",
  buyToken: WETH,
  sellAmount: "1000000",
  sellToken: USDC,
  minBuyAmount: "380000000000000",
  fees: { integratorFee: null, zeroExFee: { amount: "500", token: USDC, type: "volume" } },
  transaction: { to: AH, data: "0x2213bc0b00", value: "0", gas: "210000", gasPrice: "1" },
  zid: "zid",
  ...overrides,
});

describe("GET /v1/quotes/swap", () => {
  it("validates the query", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch, zeroEx: { apiKey: "k" } });
    const res = await app.request(`${swapQuote.path}?network=bad`, { headers: headers() });
    expect(res.status).toBe(400);
  });

  it("answers 503 when no 0x key is configured", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch });
    const res = await app.request(`${swapQuote.path}?${QUERY}`, { headers: headers() });
    expect(res.status).toBe(503);
  });

  it("maps a filled ERC-20 quote", async () => {
    const upstream = fakeFetch({
      [`${API}/swap/allowance-holder/quote`]: () => Response.json(filled()),
    });
    const app = gateway({ fetch: upstream.fetch, zeroEx: { apiKey: "k" } });
    const res = await app.request(`${swapQuote.path}?${QUERY}`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await expectContract(res, swapQuote.response);
    expect(body).toMatchObject({
      liquidity: true,
      provider: "0x",
      sellToken: USDC,
      buyToken: WETH,
      sellAmount: "1000000",
      minBuyAmount: "380000000000000",
      allowanceTarget: AH,
      transaction: { to: AH, value: "0" },
      fees: { zeroEx: { amount: "500", token: USDC } },
    });
    const [call] = upstream.callsTo(`${API}/swap/allowance-holder/quote`);
    expect(call?.url).toContain("chainId=11155111");
    expect(call?.url).not.toContain("recipient=");
  });

  it("forwards the integrator fee params only when configured", async () => {
    const upstream = fakeFetch({
      [`${API}/swap/allowance-holder/quote`]: () => Response.json(filled()),
    });
    const app = gateway({
      fetch: upstream.fetch,
      zeroEx: {
        apiKey: "k",
        fee: { recipient: "0x00000000000000000000000000000000000000f1", bps: 25 },
      },
    });
    await app.request(`${swapQuote.path}?${QUERY}`, { headers: headers() });
    const [call] = upstream.callsTo(`${API}/swap/allowance-holder/quote`);
    expect(call?.url).toContain("swapFeeRecipient=0x00000000000000000000000000000000000000f1");
    expect(call?.url).toContain("swapFeeBps=25");
  });

  it("maps liquidityAvailable:false to { liquidity: false }", async () => {
    const upstream = fakeFetch({
      [`${API}/swap/allowance-holder/quote`]: () =>
        Response.json({ liquidityAvailable: false, zid: "zid" }),
    });
    const app = gateway({ fetch: upstream.fetch, zeroEx: { apiKey: "k" } });
    const res = await app.request(`${swapQuote.path}?${QUERY}`, { headers: headers() });
    expect(res.status).toBe(200);
    await expect(expectContract(res, swapQuote.response)).resolves.toStrictEqual({
      liquidity: false,
    });
  });

  it.each([400, 403, 422])("maps an upstream %i error body to 400", async (status) => {
    /* The real 0x error shape: { name, message, data } — the status decides, not the body. */
    const upstream = fakeFetch({
      [`${API}/swap/allowance-holder/quote`]: () =>
        Response.json({ name: "INPUT_INVALID", message: "bad sellToken", data: {} }, { status }),
    });
    const app = gateway({ fetch: upstream.fetch, zeroEx: { apiKey: "k" } });
    const res = await app.request(`${swapQuote.path}?${QUERY}`, { headers: headers() });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
  });

  it.each([401, 429, 502])("maps an upstream %i to 503", async (status) => {
    const upstream = fakeFetch({
      [`${API}/swap/allowance-holder/quote`]: () =>
        Response.json({ name: "UPSTREAM", message: "x", data: {} }, { status }),
    });
    const app = gateway({ fetch: upstream.fetch, zeroEx: { apiKey: "k" } });
    const res = await app.request(`${swapQuote.path}?${QUERY}`, { headers: headers() });
    expect(res.status).toBe(503);
  });

  it("maps a malformed upstream body to 503", async () => {
    const upstream = fakeFetch({
      [`${API}/swap/allowance-holder/quote`]: () => Response.json({ ok: true }),
    });
    const app = gateway({ fetch: upstream.fetch, zeroEx: { apiKey: "k" } });
    const res = await app.request(`${swapQuote.path}?${QUERY}`, { headers: headers() });
    expect(res.status).toBe(503);
  });
});

describe("zeroExConfig", () => {
  it("is undefined without a key, key-only without fee bindings, and pairs a valid fee", () => {
    expect(zeroExConfig({})).toBeUndefined();
    expect(zeroExConfig({ ZEROX_API_KEY: "k" })).toStrictEqual({ apiKey: "k" });
    expect(
      zeroExConfig({
        ZEROX_API_KEY: "k",
        ZEROX_FEE_RECIPIENT: "0x00000000000000000000000000000000000000f1",
        ZEROX_FEE_BPS: "25",
      }),
    ).toStrictEqual({
      apiKey: "k",
      fee: { recipient: "0x00000000000000000000000000000000000000f1", bps: 25 },
    });
  });

  it.each([
    { ZEROX_API_KEY: "k", ZEROX_FEE_RECIPIENT: "0x123", ZEROX_FEE_BPS: "25" },
    { ZEROX_API_KEY: "k", ZEROX_FEE_RECIPIENT: "0x00000000000000000000000000000000000000f1" },
    {
      ZEROX_API_KEY: "k",
      ZEROX_FEE_RECIPIENT: "0x00000000000000000000000000000000000000f1",
      ZEROX_FEE_BPS: "0",
    },
    {
      ZEROX_API_KEY: "k",
      ZEROX_FEE_RECIPIENT: "0x00000000000000000000000000000000000000f1",
      ZEROX_FEE_BPS: "1001",
    },
    {
      ZEROX_API_KEY: "k",
      ZEROX_FEE_RECIPIENT: "0x00000000000000000000000000000000000000f1",
      ZEROX_FEE_BPS: "1.5",
    },
    { ZEROX_API_KEY: "k", ZEROX_FEE_BPS: "25" },
  ])("rejects %o", (env) => {
    expect(() => zeroExConfig(env)).toThrow("ZEROX_FEE");
  });
});

const JAPI = "https://api.jup.ag";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const WSOL = "So11111111111111111111111111111111111111112";
const SUSDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STAKER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const STABLE = "5A5XJTxSYiFzmYtMiFwjqH9Cu3Lan6wFsjMuLTSjsGLB";

const SOL_QUERY = `network=${SOL_NET}&inputMint=${WSOL}&outputMint=${SUSDC}&amount=100000000&taker=${STAKER}&slippageBps=50`;

const solIx = (overrides: Record<string, unknown> = {}) => ({
  programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  accounts: [{ pubkey: STAKER, isSigner: true, isWritable: true }],
  data: "CQ==",
  ...overrides,
});

const jupBuild = (overrides: Record<string, unknown> = {}) => ({
  inputMint: WSOL,
  outputMint: SUSDC,
  inAmount: "100000000",
  outAmount: "8944396",
  otherAmountThreshold: "8899675",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0",
  computeBudgetInstructions: [solIx({ programId: "ComputeBudget111111111111111111111111111111" })],
  setupInstructions: [solIx()],
  swapInstruction: solIx({ programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }),
  cleanupInstruction: solIx({ data: "CQ==" }),
  otherInstructions: [],
  tipInstruction: null,
  addressesByLookupTableAddress: { [STABLE]: [WSOL, SUSDC] },
  transactionVersion: 0,
  ...overrides,
});

describe("GET /v1/quotes/swap/solana", () => {
  it("rejects a non-mainnet network and a malformed mint", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch });
    const badQueries = [
      `network=solana:devnet&inputMint=${WSOL}&outputMint=${SUSDC}&amount=1&taker=${TAKER}&slippageBps=50`,
      `network=${SOL_NET}&inputMint=bad&outputMint=${SUSDC}&amount=1&taker=${TAKER}&slippageBps=50`,
      `network=${SOL_NET}&inputMint=${WSOL}&outputMint=${SUSDC}&amount=0&taker=${TAKER}&slippageBps=50`,
    ];
    const results = await Promise.all(
      badQueries.map(async (q) =>
        app.request(`${swapQuoteSolana.path}?${q}`, { headers: headers() }),
      ),
    );
    for (const res of results) {
      expect(res.status).toBe(400);
    }
  });

  it("calls upstream keyless, drops compute budget, and maps the wire shape", async () => {
    const upstream = fakeFetch({
      [`${JAPI}/swap/v2/build`]: () => Response.json(jupBuild()),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${swapQuoteSolana.path}?${SOL_QUERY}`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await expectContract(res, swapQuoteSolana.response);
    expect(body).toMatchObject({
      liquidity: true,
      provider: "jupiter",
      inputMint: WSOL,
      outputMint: SUSDC,
      inAmount: "100000000",
      outAmount: "8944396",
      otherAmountThreshold: "8899675",
      slippageBps: 50,
      swap: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
      lookupTables: [STABLE],
    });
    const [call] = upstream.callsTo(`${JAPI}/swap/v2/build`);
    expect(call?.url).toContain(`inputMint=${WSOL}`);
    expect(call?.url).toContain(`taker=${STAKER}`);
    expect(call?.headers).toBeUndefined();
  });

  it("sends x-api-key when a key is configured", async () => {
    const upstream = fakeFetch({
      [`${JAPI}/swap/v2/build`]: () => Response.json(jupBuild()),
    });
    const app = gateway({ fetch: upstream.fetch, jupiter: { apiKey: "secret-key" } });
    await app.request(`${swapQuoteSolana.path}?${SOL_QUERY}`, { headers: headers() });
    const [call] = upstream.callsTo(`${JAPI}/swap/v2/build`);
    expect(call?.headers).toMatchObject({ "x-api-key": "secret-key" });
  });

  it('maps a 400 "No routes found" to { liquidity: false }', async () => {
    const upstream = fakeFetch({
      [`${JAPI}/swap/v2/build`]: () => Response.json({ error: "No routes found" }, { status: 400 }),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${swapQuoteSolana.path}?${SOL_QUERY}`, { headers: headers() });
    expect(res.status).toBe(200);
    await expect(expectContract(res, swapQuoteSolana.response)).resolves.toStrictEqual({
      liquidity: false,
    });
  });

  it("maps other 4xx to 400 and upstream failures to 503", async () => {
    const cases = [
      [400, 400],
      [422, 400],
      [429, 503],
      [502, 503],
    ] as const;
    const statuses = await Promise.all(
      cases.map(async ([status]) => {
        const upstream = fakeFetch({
          [`${JAPI}/swap/v2/build`]: () => Response.json({ error: "bad request" }, { status }),
        });
        const app = gateway({ fetch: upstream.fetch });
        const res = await app.request(`${swapQuoteSolana.path}?${SOL_QUERY}`, {
          headers: headers(),
        });
        return res.status;
      }),
    );
    expect(statuses).toStrictEqual(cases.map(([, expected]) => expected));
  });

  const unbuildable: Array<Record<string, unknown>> = [
    { otherInstructions: [solIx()] },
    { tipInstruction: solIx() },
    { transactionVersion: 1 },
    { transactionVersion: "legacy" },
  ];

  it.each(unbuildable)("refuses a build with %j", async (patch) => {
    const upstream = fakeFetch({
      [`${JAPI}/swap/v2/build`]: () => Response.json(jupBuild(patch)),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${swapQuoteSolana.path}?${SOL_QUERY}`, { headers: headers() });
    expect(res.status).toBe(503);
  });

  it("maps a non-JSON upstream body to 503", async () => {
    const upstream = fakeFetch({
      [`${JAPI}/swap/v2/build`]: () => new Response("upstream overload"),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${swapQuoteSolana.path}?${SOL_QUERY}`, { headers: headers() });
    expect(res.status).toBe(503);
  });

  it("maps a valid JSON body that fails the schema to 503", async () => {
    const upstream = fakeFetch({
      [`${JAPI}/swap/v2/build`]: () => Response.json({ routes: [] }),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${swapQuoteSolana.path}?${SOL_QUERY}`, { headers: headers() });
    expect(res.status).toBe(503);
  });
});

const N1 = "eip155:1";
const N10 = "eip155:10";
const USDC1 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC10 = "0x0b2c639c533813f4aa9d7837caf62653d097ff85";
const ACROSS_API = "https://app.across.to";
const BRIDGE_QUERY = `network=${N1}&destinationNetwork=${N10}&inputToken=${USDC1}&outputToken=${USDC10}&amount=300000000&taker=${TAKER}`;

const acrossFees = (overrides: Record<string, unknown> = {}) => ({
  inputToken: { address: USDC1 },
  outputToken: { address: USDC10 },
  timestamp: 1794190799,
  isAmountTooLow: false,
  exclusiveRelayer: "0xFD03AbCAdaF3F930fA4E37Eb2f6ea3A44a41b7F0",
  exclusivityDeadline: 1794191119,
  fillDeadline: 1794197999,
  outputAmount: "299966316",
  spokePoolAddress: "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5",
  limits: { minDeposit: "1000", maxDeposit: "900000000000000000000" },
  ...overrides,
});

describe("GET /v1/quotes/bridge", () => {
  it("rejects malformed query params", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch });
    const res = await app.request(
      `${bridgeQuote.path}?network=eip155:1&destinationNetwork=eip155:10&inputToken=bad&outputToken=${USDC10}&amount=1&taker=${TAKER}`,
      { headers: headers() },
    );
    expect(res.status).toBe(400);
  });

  it("maps the upstream response to the wire shape", async () => {
    const upstream = fakeFetch({
      [`${ACROSS_API}/api/suggested-fees`]: () => Response.json(acrossFees()),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${bridgeQuote.path}?${BRIDGE_QUERY}`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["provider"]).toBe("across");
    expect(body["outputAmount"]).toBe("299966316");
    expect(body["destinationNetwork"]).toBe("eip155:10");
    expect(body["quoteTimestamp"]).toBe(1794190799);
    expect(body["fillDeadline"]).toBe(1794197999);
    expect(body["exclusiveRelayer"]).toBe("0xFD03AbCAdaF3F930fA4E37Eb2f6ea3A44a41b7F0");
    expect(body["exclusivityParameter"]).toBe(1794191119);
    expect(body["spokePool"]).toBe("0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5");
    const called = upstream.calls.at(-1)!;
    const url = new URL(called.url);
    expect(url.searchParams.get("originChainId")).toBe("1");
    expect(url.searchParams.get("destinationChainId")).toBe("10");
    expect(url.searchParams.get("amount")).toBe("300000000");
    expect(called.headers).toBeUndefined();
  });

  it("reports no liquidity when the amount is too low", async () => {
    const upstream = fakeFetch({
      [`${ACROSS_API}/api/suggested-fees`]: () =>
        Response.json(acrossFees({ isAmountTooLow: true })),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${bridgeQuote.path}?${BRIDGE_QUERY}`, { headers: headers() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["liquidity"]).toBe(false);
  });

  it("reports no liquidity when the amount exceeds the limits", async () => {
    const upstream = fakeFetch({
      [`${ACROSS_API}/api/suggested-fees`]: () =>
        Response.json(acrossFees({ limits: { minDeposit: "1", maxDeposit: "10" } })),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${bridgeQuote.path}?${BRIDGE_QUERY}`, { headers: headers() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["liquidity"]).toBe(false);
  });

  it.each([
    [400, 400],
    [422, 400],
    [429, 503],
    [502, 503],
  ] as const)("maps an upstream %i to %i", async (status, expected) => {
    const upstream = fakeFetch({
      [`${ACROSS_API}/api/suggested-fees`]: () =>
        Response.json({ error: "bad request" }, { status }),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${bridgeQuote.path}?${BRIDGE_QUERY}`, {
      headers: headers(),
    });
    expect(res.status).toBe(expected);
  });

  it("maps a non-JSON upstream body to 503", async () => {
    const upstream = fakeFetch({
      [`${ACROSS_API}/api/suggested-fees`]: () => new Response("upstream overload"),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${bridgeQuote.path}?${BRIDGE_QUERY}`, { headers: headers() });
    expect(res.status).toBe(503);
  });

  it("maps a schema-mismatch upstream body to 503", async () => {
    const upstream = fakeFetch({
      [`${ACROSS_API}/api/suggested-fees`]: () => Response.json({ routes: [] }),
    });
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`${bridgeQuote.path}?${BRIDGE_QUERY}`, { headers: headers() });
    expect(res.status).toBe(503);
  });
});
