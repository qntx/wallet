import { describe, expect, it } from "vite-plus/test";

import { swapQuote } from "@qntx/wallet-engine/gateway/contract";

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

  it("maps an upstream 4xx error body to 400", async () => {
    const upstream = fakeFetch({
      [`${API}/swap/allowance-holder/quote`]: () =>
        Response.json({ code: "INSUFFICIENT_ASSET_LIQUIDITY", reason: "x" }, { status: 400 }),
    });
    const app = gateway({ fetch: upstream.fetch, zeroEx: { apiKey: "k" } });
    const res = await app.request(`${swapQuote.path}?${QUERY}`, { headers: headers() });
    expect(res.status).toBe(400);
  });

  it("maps an upstream 5xx to 503", async () => {
    const upstream = fakeFetch({
      [`${API}/swap/allowance-holder/quote`]: () => new Response("down", { status: 502 }),
    });
    const app = gateway({ fetch: upstream.fetch, zeroEx: { apiKey: "k" } });
    const res = await app.request(`${swapQuote.path}?${QUERY}`, { headers: headers() });
    expect(res.status).toBe(503);
  });
});
