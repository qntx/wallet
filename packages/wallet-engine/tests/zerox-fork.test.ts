// oxlint-disable vitest/no-conditional-in-test -- fork e2e is inherently conditional
/**
 * Manual 0x fork check — NOT run in CI. `ENGINE_E2E_FORK_RPC=<mainnet rpc>` plus
 * `ZEROX_API_KEY=<key>` runs anvil on a mainnet fork and a local gateway holding the real 0x key,
 * then drives quote → prepare → approve for a native sell and an ERC-20 sell through the request
 * pipeline. The key never touches a file or a log line.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { ALLOWANCE_HOLDER, EVM_NATIVE_ASSET } from "@qntx/wallet-chains/evm";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { createGateway } from "../../../apps/gateway/src/app.ts";
import type { RiskStore } from "../../../apps/gateway/src/risk/phishing.ts";
import type { Limiters } from "../../../apps/gateway/src/types.ts";
import { createWalletEngine } from "../src/engine.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";
import type { ZeroExSwapQuote } from "../src/swaps/index.ts";
import { rpc, sleep, waitReceipt } from "./fork-helpers.ts";

const FORK = process.env["ENGINE_E2E_FORK_RPC"];
const KEY = process.env["ZEROX_API_KEY"];
const RUN = FORK !== undefined && FORK !== "" && KEY !== undefined && KEY !== "";
const N1 = "eip155:1";
const ANVIL_PORT = 18547;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const VERIFY = { kind: "password" as const, password: "correct horse battery staple" };
const KERNEL_URL: URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const INSTALL_ID = "0123456789abcdef0123456789abcdef";
const USDC = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const SLIPPAGE_BPS = 100;

const balanceOf = async (token: string, owner: string): Promise<bigint> =>
  BigInt(
    (await rpc(RPC_URL, "eth_call", [
      { to: token, data: `0x70a08231000000000000000000000000${owner.slice(2)}` },
      "latest",
    ])) as string,
  );

const erc20Allowance = async (token: string, owner: string): Promise<bigint> =>
  BigInt(
    (await rpc(RPC_URL, "eth_call", [
      {
        to: token,
        data: `0xdd62ed3e000000000000000000000000${owner.slice(2)}000000000000000000000000${ALLOWANCE_HOLDER.slice(2)}`,
      },
      "latest",
    ])) as string,
  );

describe.skipIf(!RUN)("0x swap on a mainnet fork", () => {
  it("swaps ETH→USDC and USDC→WETH through the real quote pipeline", async () => {
    const anvil = spawn(
      "anvil",
      ["--fork-url", FORK ?? "", "--port", String(ANVIL_PORT), "--silent"],
      { stdio: "ignore" },
    );
    let server: Server | undefined;
    try {
      for (let i = 0; i < 60; i++) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential polling
          await rpc(RPC_URL, "eth_chainId", []);
          break;
        } catch {
          // oxlint-disable-next-line no-await-in-loop -- sequential polling
          await sleep(1000);
        }
      }
      const allowAll = {
        limit: async () => {
          await Promise.resolve();
          return { success: true };
        },
      };
      const limiters: Limiters = { rpc: allowAll, default: allowAll };
      const risk: RiskStore = {
        get: async () => Promise.resolve(undefined),
        put: async () => Promise.resolve(),
      };
      const gateway = createGateway({
        fetch: globalThis.fetch.bind(globalThis),
        networks: [{ id: N1, providers: [{ id: "fork", url: RPC_URL }] }],
        limiters,
        corsOrigins: [],
        risk,
        zeroEx: { apiKey: KEY ?? "" },
        log: () => undefined,
      });
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (value !== undefined) {
              headers.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
          }
          const body = Buffer.concat(chunks);
          const upstream = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
            method: req.method ?? "GET",
            headers,
            ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
          });
          void (async () => {
            try {
              const response = await gateway.fetch(upstream);
              res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
              res.end(Buffer.from(await response.arrayBuffer()));
            } catch {
              res.writeHead(502);
              res.end();
            }
          })();
        });
      });
      await new Promise<void>((resolve) => {
        server?.listen(0, "127.0.0.1", resolve);
      });
      const gwPort = (server.address() as AddressInfo).port;
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
      const info = await wallet.wallets.importMnemonic({
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        factor: VERIFY,
      });
      const { walletId } = info;
      const acct = await chains(wallet).account({
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: N1,
      });
      const from = (acct as { address?: string }).address ?? "";
      await rpc(RPC_URL, "anvil_setBalance", [from, "0x56BC75E2D63100000"]);
      const engine = createWalletEngine({
        publicStore: createMemoryPublicStore(),
        verifyEvent,
        weblnAlias: "test",
        lightningMaxFee: () => 0,
        wallet,
        sparkNetwork: "regtest",
        fetch: globalThis.fetch.bind(globalThis),
        random: (n) => randomBytes(n),
        now: () => Date.now(),
        logger: { warn: () => {} },
        showCallsStatus: () => undefined,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        rpc: { [N1]: [RPC_URL] },
        gateway: { url: `http://127.0.0.1:${gwPort}`, installId: INSTALL_ID },
      });
      // The unlock transition drives accounts.init()…requests.init() — wait for the tree.
      for (let i = 0; i < 100; i++) {
        if (engine.accounts.getState().status === "ready") {
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- sequential polling
        await sleep(300);
      }
      expect(engine.accounts.getState().status).toBe("ready");
      const account = {
        kind: "hd" as const,
        walletId,
        groupIndex: 0,
        template: "evm.bip44" as const,
      };
      const quote = async (sell: string, buy: string, amount: bigint) => {
        const q = await engine.swaps.quote({
          account,
          network: N1,
          sell,
          buy,
          amount,
          slippageBps: SLIPPAGE_BPS,
        });
        if (q === undefined) {
          throw new Error("0x reported no liquidity");
        }
        return q as ZeroExSwapQuote;
      };
      const swap = async (q: ZeroExSwapQuote) => {
        const pending = await engine.requests.prepare({
          method: "evm-swap",
          account,
          network: N1,
          quote: q,
          fee: "normal",
        });
        const display = pending.display as {
          summary?: string;
          minimumReceived?: Array<{ amount: { asset: string; amount: string } }>;
        };
        expect(display.summary).toBe("swap");
        expect(display.minimumReceived).toHaveLength(1);
        const tx = await engine.requests.approve(pending.id, "evm-swap", VERIFY);
        expect(tx.intent?.summary).toBe("swap");
        await waitReceipt(RPC_URL, tx.hash ?? "", Date.now() + 180_000);
        return tx;
      };

      // (a) native ETH → USDC — no approval needed.
      const sellNativeAmount = 5_000_000_000_000_000n; // 0.005 ETH
      const qNative = await quote(EVM_NATIVE_ASSET, USDC, sellNativeAmount);
      expect(qNative.transaction.to.toLowerCase()).toBe(ALLOWANCE_HOLDER.toLowerCase());
      expect(qNative.transaction.value).toBe(sellNativeAmount);
      const usdcBefore = await balanceOf(USDC, from);
      await swap(qNative);
      const usdcAfter = await balanceOf(USDC, from);
      expect(usdcAfter - usdcBefore).toBeGreaterThanOrEqual(qNative.minBuyAmount);

      // (b) USDC → WETH — approve the AllowanceHolder for the exact sell amount first.
      const sellUsdc = usdcAfter - usdcBefore;
      const qErc = await quote(USDC, WETH, sellUsdc);
      expect(qErc.transaction.value).toBe(0n);
      const approvePending = await engine.requests.prepare({
        method: "evm-approve",
        account,
        network: N1,
        token: USDC,
        spender: ALLOWANCE_HOLDER,
        amount: sellUsdc,
        fee: "normal",
      });
      const approveTx = await engine.requests.approve(approvePending.id, "evm-approve", VERIFY);
      await waitReceipt(RPC_URL, approveTx.hash ?? "", Date.now() + 180_000);
      await expect(erc20Allowance(USDC, from)).resolves.toBeGreaterThanOrEqual(sellUsdc);
      const qErc2 = await quote(USDC, WETH, sellUsdc);
      const wethBefore = await balanceOf(WETH, from);
      await swap(qErc2);
      const wethAfter = await balanceOf(WETH, from);
      expect(wethAfter - wethBefore).toBeGreaterThanOrEqual(qErc2.minBuyAmount);
    } finally {
      server?.close();
      anvil.kill("SIGKILL");
      spawnSync("pkill", ["-f", `anvil.*--port.*${ANVIL_PORT}`]);
    }
  }, 600_000);
});
