import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { encodeFunctionData, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { gatewaySession } from "../src/gateway/client.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { NftController } from "../src/nfts/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { approval } from "./approval.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";
import { manualTimers } from "./support/timers.ts";

const RUN = process.env["ENGINE_E2E_ANVIL"] === "1";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const RECIPIENT = "0x00000000000000000000000000000000deadbeef";
const NETWORK = "eip155:1";
const GATEWAY = "https://nfts.test.invalid";
const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);

const anvil = (): string => {
  const local = `${process.env["HOME"] ?? ""}/.foundry/bin/anvil`;
  return existsSync(local) ? local : execFileSync("which", ["anvil"]).toString().trim();
};

const forge = (): string => {
  const local = `${process.env["HOME"] ?? ""}/.foundry/bin/forge`;
  return existsSync(local) ? local : execFileSync("which", ["forge"]).toString().trim();
};

const compile = (name: string): `0x${string}` => {
  const dir = mkdtempSync(join(tmpdir(), "nft-anvil-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "foundry.toml"),
    '[profile.default]\nsolc = "0.8.36"\nevm_version = "prague"\n',
  );
  writeFileSync(
    join(dir, "src", "TestNft.sol"),
    readFileSync(new URL("fixtures/TestNft.sol", import.meta.url).pathname, "utf8"),
  );
  execFileSync(forge(), ["build", "--root", dir, "--quiet"], { stdio: "pipe" });
  const artifact = JSON.parse(
    readFileSync(join(dir, "out", "TestNft.sol", `${name}.json`), "utf8"),
  ) as { bytecode: { object: `0x${string}` } };
  return artifact.bytecode.object;
};

const rpcCall = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) {
    throw new Error(body.error.message);
  }
  return body.result;
};

const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(RUN)("anvil e2e: NFT sends through the request pipeline", () => {
  it(
    "transfers an ERC-721 and an ERC-1155 batch, re-reads the inventory, and flags a contract recipient",
    async () => {
      const port = 18570;
      const proc = execFile(anvil(), ["--port", String(port), "--chain-id", "1", "--silent"]);
      await sleep(1500);
      const timers = manualTimers();
      const url = `http://127.0.0.1:${port}`;

      try {
        const wallet: Wallet = await createNodeWallet({
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
          mnemonic: MNEMONIC,
          factor: { kind: "password", password: PASSWORD },
        });
        const walletId = info.walletId;
        const evmAccount = await chains(wallet).account({
          walletId,
          groupIndex: 0,
          template: "evm.bip44",
          network: NETWORK,
        });
        const from = "address" in evmAccount ? evmAccount.address : "";
        const acct = {
          kind: "hd" as const,
          walletId,
          groupIndex: 0,
          template: "evm.bip44" as const,
        };
        await rpcCall(url, "anvil_setBalance", [from, "0xde0b6b3a7640000"]);
        await rpcCall(url, "evm_setAutomine", [false]);

        const deployer = mnemonicToAccount(MNEMONIC, { accountIndex: 0 });
        const rawTx = async (to: `0x${string}` | undefined, data: `0x${string}`): Promise<string> => {
          const nonce = (await rpcCall(url, "eth_getTransactionCount", [
            deployer.address,
            "pending",
          ])) as string;
          const signed = await deployer.signTransaction({
            chainId: 1,
            nonce: Number(BigInt(nonce)),
            gas: 3_000_000n,
            ...(to === undefined ? {} : { to }),
            data,
            maxFeePerGas: 2n * 10n ** 9n,
            maxPriorityFeePerGas: 10n ** 8n,
          });
          const hash = (await rpcCall(url, "eth_sendRawTransaction", [signed])) as string;
          await rpcCall(url, "evm_mine", [{ blocks: 1 }]);
          return hash;
        };
        const deploy = async (name: string): Promise<`0x${string}`> => {
          const hash = await rawTx(undefined, compile(name));
          const receipt = (await rpcCall(url, "eth_getTransactionReceipt", [hash])) as {
            contractAddress: `0x${string}`;
          };
          return receipt.contractAddress;
        };
        const contract721 = await deploy("TestNft721");
        const contract1155 = await deploy("TestNft1155");
        const mint721 = (to: `0x${string}`, id: bigint): Promise<string> =>
          rawTx(
            to,
            encodeFunctionData({
              abi: parseAbi(["function mint(uint256 id)"]),
              functionName: "mint",
              args: [id],
            }),
          );
        const mint1155 = (to: `0x${string}`, id: bigint, amount: bigint): Promise<string> =>
          rawTx(
            to,
            encodeFunctionData({
              abi: parseAbi(["function mint(uint256 id, uint256 amount)"]),
              functionName: "mint",
              args: [id, amount],
            }),
          );
        await mint721(contract721, 1n);
        await mint721(contract721, 2n);
        await mint1155(contract1155, 7n, 5n);
        await mint1155(contract1155, 8n, 3n);

        const fetch = async (
          input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          const target =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (target.startsWith(GATEWAY)) {
            if (target.endsWith("/v1/networks")) {
              return Response.json({ networks: [] });
            }
            return Response.json({
              items: [
                { contract: contract721, tokenId: "1", standard: "erc721", balance: "1" },
                { contract: contract1155, tokenId: "7", standard: "erc1155", balance: "5" },
                { contract: contract1155, tokenId: "8", standard: "erc1155", balance: "3" },
              ].map((item) => ({
                ...item,
                name: null,
                image: null,
                animation: null,
                collection: null,
                spam: false,
              })),
              cursor: null,
            });
          }
          return globalThis.fetch(input, init);
        };

        const networks = new NetworkController({
          ...idleNetworkDeps,
          fetch,
          rpc: { [NETWORK]: [url] },
          openStore: async () => Promise.resolve(createMemoryEngineStore()),
          logger: { warn: () => undefined },
        });
        const ctl = new TransactionController({
          wallet,
          networks,
          openStore: async () => Promise.resolve(createMemoryEngineStore()),
          random: (n) => new Uint8Array(n).fill(7),
          setTimer: timers.setTimer,
          now: () => 1000,
          logger: { warn: () => undefined },
          pollMs: 1,
        });
        await ctl.init();
        const requests = new RequestController({
          phishing: { check: () => "clear" },
          blindSigning: () => false,
          simulateSolana: simulateSolanaStub,
          tokens: tokensStub,
          transactions: ctl,
          ...bookDeps(),
          spark: {} as SparkController,
          nostrSign: async () => {
            await Promise.resolve();
            throw new Error("unused");
          },
          bitcoinPrepare: async () => {
            await Promise.resolve();
            throw new Error("unused");
          },
          bitcoinSignPsbts: async () => {
            await Promise.resolve();
            throw new Error("unused");
          },
          bitcoinSign: async () => {
            await Promise.resolve();
            throw new Error("unused");
          },
          solanaSign: async () => {
            await Promise.resolve();
            throw new Error("unused");
          },
          fetch,
          random: (n) => new Uint8Array(n).fill(9),
          now: () => 1000,
          setTimer: () => () => undefined,
          logger: { warn: () => undefined },
        });
        await requests.init();
        const nfts = new NftController({
          gateway: gatewaySession(GATEWAY, (n) => new Uint8Array(n).fill(3)),
          fetch,
          openStore: async () => Promise.resolve(createMemoryEngineStore()),
          setTimer: timers.setTimer,
          now: () => 1000,
          logger: { warn: () => undefined },
          networks,
          balances: () => ({}),
          activity: () => ({ entries: [], txs: Object.values(ctl.getState().txs) }),
          onActivityChange: () => () => undefined,
          onConfirmed: (listener) =>
            ctl.store.subscribe((state, previous) => {
              for (const tx of Object.values(state.txs)) {
                if (tx.state === "confirmed" && previous.txs[tx.id]?.state !== "confirmed") {
                  listener(tx);
                }
              }
            }),
        });
        await nfts.init();

        const inventory = await nfts.load(from, NETWORK);
        expect(inventory.items).toHaveLength(3);

        const prepared721 = await requests.prepare({
          method: "evm-nft-send",
          account: acct,
          network: NETWORK,
          contract: contract721,
          items: [{ tokenId: 1n }],
          to: RECIPIENT,
          fee: "slow",
        });
        expect(prepared721.stage).toBe("awaiting-approval");
        const sent721 = await requests.approve(
          prepared721.id,
          "evm-nft-send",
          approval(prepared721, VERIFY),
        );
        expect(sent721.state).toBe("submitted");
        await rpcCall(url, "evm_mine", [{ blocks: 1 }]);
        await timers.fire();
        expect(ctl.getState().txs[sent721.id]?.state).toBe("confirmed");

        const deadline = Date.now() + 10_000;
        let after721 = nfts.getState().inventories[`${NETWORK}:${from.toLowerCase()}`];
        while (Date.now() < deadline) {
          after721 = nfts.getState().inventories[`${NETWORK}:${from.toLowerCase()}`];
          if (
            after721 !== undefined &&
            !after721.items.some((item) => item.contract === contract721)
          ) {
            break;
          }
          await sleep(100);
        }
        expect(after721?.items.some((item) => item.contract === contract721)).toBe(false);
        expect(
          after721?.items.find((item) => item.tokenId === "7")?.balance,
        ).toBe("5");

        const preparedBatch = await requests.prepare({
          method: "evm-nft-send",
          account: acct,
          network: NETWORK,
          contract: contract1155,
          items: [
            { tokenId: 7n, amount: 5n },
            { tokenId: 8n, amount: 3n },
          ],
          to: RECIPIENT,
          fee: "slow",
        });
        expect(preparedBatch.stage).toBe("awaiting-approval");
        const sentBatch = await requests.approve(
          preparedBatch.id,
          "evm-nft-send",
          approval(preparedBatch, VERIFY),
        );
        expect(sentBatch.state).toBe("submitted");
        await rpcCall(url, "evm_mine", [{ blocks: 1 }]);
        await timers.fire();
        expect(ctl.getState().txs[sentBatch.id]?.state).toBe("confirmed");

        const balanceOf = async (id: bigint): Promise<bigint> =>
          BigInt(
            (await rpcCall(url, "eth_call", [
              {
                to: contract1155,
                data: encodeFunctionData({
                  abi: parseAbi([
                    "function balanceOf(address owner, uint256 id) view returns (uint256)",
                  ]),
                  functionName: "balanceOf",
                  args: [RECIPIENT, id],
                }),
              },
              "latest",
            ])) as string,
          );
        expect(await balanceOf(7n)).toBe(5n);
        expect(await balanceOf(8n)).toBe(3n);

        const preparedSelf = await requests.prepare({
          method: "evm-nft-send",
          account: acct,
          network: NETWORK,
          contract: contract721,
          items: [{ tokenId: 2n }],
          to: contract721,
          fee: "slow",
        });
        expect(preparedSelf.stage).toBe("awaiting-approval");
        const codes = (preparedSelf.risk ?? []).map((finding) => finding.code);
        expect(codes).toContain("token-contract-recipient");
        expect(preparedSelf.simulation?.status).toBe("reverted");
      } finally {
        proc.kill();
      }
    },
    120_000,
  );
});
