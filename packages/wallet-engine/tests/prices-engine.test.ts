/**
 * Fiat prices end to end over a REAL Node kernel: a mainnet balance read goes through the host RPC
 * (the gateway serves no networks), the balance update triggers a `POST /v1/prices` the fake
 * gateway answers, and `portfolio.group` values the group exactly. Lock clears the quotes.
 */
import { randomBytes } from "node:crypto";

import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult } from "viem";
import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { MULTICALL3_ABI } from "../src/assets/evm.ts";
import { createWalletEngine } from "../src/engine.ts";
import {
  CLIENT_ID_HEADER,
  accepts,
  clientId,
  parseWith,
  prices,
} from "../src/gateway/contract/index.ts";
import type { PricesRequest } from "../src/gateway/contract/index.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GATEWAY = "https://gw.test";
const RPC = "https://rpc.test";
const MAINNET = "eip155:1";
const ETH = `${MAINNET}/slip44:60`;
const USDC_ASSET = `${MAINNET}/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`;
const USDT_ASSET = `${MAINNET}/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7`;

/** Mainnet token balances the fake node's Multicall3 answers, per contract address. */
const TOKEN_BALANCES: Readonly<Record<string, bigint>> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 2_500_000n, // 2.5 USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 0n, // no USDT — stays unpriced
};

/** What the fake gateway prices; every other asked asset is `missing`. */
const PRICED: Readonly<Record<string, string>> = { [ETH]: "1810.44", [USDC_ASSET]: "0.9998" };

const violations: string[] = [];

afterEach(() => {
  const found = violations.splice(0);
  if (found.length > 0) {
    throw new Error(`gateway contract violations:\n${found.join("\n")}`);
  }
});

/** The Multicall3 `aggregate3` return for the batch it was asked, per-token balanceOf words. */
const answerCall = (params: unknown): Hex => {
  const [call] = Array.isArray(params) ? (params as [{ data?: Hex }]) : [{}];
  try {
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data: call.data ?? "0x" });
    return encodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      result: args[0].map(({ target }) => ({
        success: true,
        returnData: encodeAbiParameters(
          [{ type: "uint256" }],
          [TOKEN_BALANCES[target.toLowerCase()] ?? 0n],
        ),
      })),
    });
  } catch {
    return `0x${"00".repeat(32)}`;
  }
};

const rpcResult = (result: unknown): Response => Response.json({ jsonrpc: "2.0", id: 1, result });

/** Contract-checked fake gateway (/v1/networks serves nothing, /v1/prices) + fake mainnet node. */
function world() {
  const priceCalls: PricesRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin === GATEWAY && url.pathname === prices.path) {
      if (init?.method !== prices.method) {
        violations.push(`${prices.path}: ${init?.method ?? "GET"}`);
      }
      const id = new Headers(init?.headers).get(CLIENT_ID_HEADER);
      if (id === null || !accepts(clientId, id)) {
        violations.push(`${prices.path}: missing or malformed ${CLIENT_ID_HEADER}`);
      }
      const request = parseWith(prices.request, JSON.parse(String(init?.body)));
      if (request === undefined) {
        violations.push(`${prices.path}: body violates prices.request: ${String(init?.body)}`);
        return Promise.resolve(new Response("{}", { status: 400 }));
      }
      priceCalls.push(request);
      return Promise.resolve(
        Response.json({
          currency: request.currency,
          prices: request.assets.flatMap((asset) => {
            const price = PRICED[asset];
            return price === undefined
              ? []
              : [{ asset, price, change24h: null, updatedAt: Date.now() }];
          }),
          missing: request.assets.filter((asset) => PRICED[asset] === undefined),
          unsupported: [],
        }),
      );
    }
    if (url.origin === GATEWAY) {
      // The gateway serves no networks this session — every chain read goes to the host.
      if (url.pathname === "/v1/networks") {
        return Promise.resolve(Response.json({ networks: [] }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    if (url.origin === RPC) {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: unknown };
      switch (body.method) {
        case "eth_chainId":
          return Promise.resolve(rpcResult("0x1"));
        case "eth_getBalance":
          return Promise.resolve(rpcResult("0x14d1120d7b160000")); // 1.5 ETH
        case "eth_call":
          return Promise.resolve(rpcResult(answerCall(body.params)));
        default:
          return Promise.resolve(
            Response.json({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32_601, message: `unmocked ${body.method}` },
            }),
          );
      }
    }
    return Promise.reject(new Error(`unexpected fetch ${url.href}`));
  };
  return { fetch: fetchImpl, priceCalls };
}

async function rig() {
  const wallet = await createNodeWallet({
    verifyEvent,
    passkey: {
      rpId: "qntx.test",
      rpName: "qntx",
      walletSalt: "qntx/wallet",
      backupSalt: "qntx/backup",
      vaultSalt: "qntx/vault",
    },
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(randomBytes(32)),
    kernelUrl: KERNEL_URL,
  });
  const w = world();
  const engine = createWalletEngine({
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet,
    sparkNetwork: "regtest",
    fetch: w.fetch,
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: { warn: () => undefined },
    showCallsStatus: () => undefined,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    rpc: { [MAINNET]: [RPC] },
    gateway: { url: GATEWAY },
  });
  const info = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: { kind: "password", password: PASSWORD },
  });
  await until(() => engine.accounts.getState().selected !== null);
  return { wallet, engine, priceCalls: w.priceCalls, walletId: info.walletId };
}

async function until(read: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) {
      throw new Error("until() timed out");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type ChainsAccount = Awaited<ReturnType<ReturnType<typeof chains>["account"]>>;

const evmAddressOf = (account: ChainsAccount): string => {
  if (!("address" in account)) {
    throw new Error("no evm.bip44 account for the group");
  }
  return account.address;
};

describe("prices over a real kernel", () => {
  it("prices the group's mainnet balances and drops the quotes on lock", async () => {
    const r = await rig();
    try {
      await until(() => r.engine.networks.enabled("evm").includes(MAINNET));
      const account = await chains(r.wallet).account({
        walletId: r.walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: MAINNET,
      });

      // The balance write must reach prices through the held-change trigger alone — the
      // subscription, or prices.init's newly-held check when it subscribed after the balances
      // landed — never a manual prices.refresh. One read suffices; the fetch itself is async.
      await r.engine.assets.refresh(evmAddressOf(account), MAINNET);
      await until(() => Object.keys(r.engine.prices.getState().quotes).length === 2);

      const state = r.engine.prices.getState();
      expect(state.quotes[ETH]?.price).toBe("1810.44");
      expect(state.quotes[USDC_ASSET]?.price).toBe("0.9998");
      expect(state.errors[USDT_ASSET]).toBe("unpriced");
      expect(state.failure).toBeNull();
      expect(r.priceCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of r.priceCalls) {
        expect(call.assets).toStrictEqual([USDC_ASSET, USDT_ASSET, ETH]);
        expect(call.currency).toBe("usd");
      }

      const valuation = await r.engine.portfolio.group({
        walletId: r.walletId,
        groupIndex: 0,
      });
      // 1.5 ETH at 1810.44 + 2.5 USDC at 0.9998 = 2715.66 + 2.4995, exact.
      expect(valuation.total).toBe("2718.1595");
      expect(valuation.currency).toBe("usd");
      expect(valuation.unpriced).toBe(1); // the zero-balance USDT the gateway never priced
      expect(valuation.holdings.map((h) => h.asset)).toStrictEqual([ETH, USDC_ASSET, USDT_ASSET]);

      await r.wallet.vault.lock();
      await until(() => Object.keys(r.engine.prices.getState().quotes).length === 0);
      expect(r.engine.prices.getState()).toStrictEqual({
        currency: "usd",
        quotes: {},
        errors: {},
        failure: null,
        fetchedAt: null,
      });
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });
});
