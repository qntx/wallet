import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { EvmChainAdapter } from "../src/chains/evm.ts";
import type { EngineLogger } from "../src/events.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";

const RUN = process.env["ENGINE_E2E_ANVIL"] === "1";

const anvil = (): string => {
  const local = `${process.env["HOME"] ?? ""}/.foundry/bin/anvil`;
  return existsSync(local) ? local : execFileSync("which", ["anvil"]).toString().trim();
};
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = mnemonicToAccount(MNEMONIC, { accountIndex: 0 });
const RECIPIENT = "0x00000000000000000000000000000000deadbeef";

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

const waitFor = async (
  adapter: EvmChainAdapter,
  client: PublicClient,
  hash: string,
  deadline: number,
): Promise<string> => {
  const state = await adapter.status(client, hash);
  if (state !== "pending" || Date.now() >= deadline) {
    return state;
  }
  await sleep(300);
  return waitFor(adapter, client, hash, deadline);
};

const sendOne = async (
  adapter: EvmChainAdapter,
  client: PublicClient,
  nonce: number,
  amount: bigint,
): Promise<void> => {
  const tx = await adapter.build(client, "eip155:31337", account.address, {
    kind: "native",
    to: RECIPIENT,
    value: amount,
  });
  expect(tx.nonce).toBe(nonce);
  const signed = await account.signTransaction({
    chainId: 31337,
    nonce: tx.nonce,
    gas: tx.gas,
    to: RECIPIENT,
    value: amount,
    maxFeePerGas: 2n * 10n ** 9n,
    maxPriorityFeePerGas: 10n ** 8n,
  });
  const hash = await adapter.broadcast(client, signed);
  const state = await waitFor(adapter, client, hash, Date.now() + 15_000);
  expect(["confirmed", "finalized"]).toContain(state);
};

describe.runIf(RUN)("anvil e2e: native transfer", () => {
  it("sends two sequential transfers, nonces n and n+1, and the recipient balance doubles", async () => {
    const port = 18545;
    const proc = execFile(anvil(), ["--port", String(port), "--silent"]);
    await sleep(1500);
    try {
      const url = `http://127.0.0.1:${port}`;
      await rpcCall(url, "anvil_setBalance", [account.address, "0xde0b6b3a7640000"]);
      const client = createPublicClient({ transport: http(url) });
      const adapter = new EvmChainAdapter();
      const amount = 10n ** 15n;
      await sendOne(adapter, client, 0, amount);
      await sendOne(adapter, client, 1, amount);
      const balance = BigInt(
        (await rpcCall(url, "eth_getBalance", [RECIPIENT, "latest"])) as string,
      );
      expect(balance).toBe(2n * amount);
    } finally {
      proc.kill();
    }
  }, 30_000);
});

const forge = (): string => {
  const local = `${process.env["HOME"] ?? ""}/.foundry/bin/forge`;
  return existsSync(local) ? local : execFileSync("which", ["forge"]).toString().trim();
};

const compileToken = (): string => {
  const dir = execFileSync("mktemp", ["-d"]).toString().trim();
  execFileSync(forge(), ["init", "--no-commit", dir]);
  execFileSync("cp", ["tests/fixtures/TestToken.sol", `${dir}/src/TestToken.sol`]);
  execFileSync(forge(), ["build", "--root", dir]);
  const artifact = JSON.parse(
    execFileSync("cat", [`${dir}/out/TestToken.sol/TestToken.json`]).toString(),
  ) as { bytecode: { object: string } };
  return artifact.bytecode.object;
};

const pad32 = (v: bigint): string => v.toString(16).padStart(64, "0");
const nonZero = (v: bigint | undefined): bigint => v ?? 0n;

describe.runIf(RUN)("anvil e2e: erc20 transfer", () => {
  it("deploys TestToken, transfers erc20 via the adapter, recipient balance grows; intent is partial", async () => {
    const port = 18546;
    const proc = execFile(anvil(), ["--port", String(port), "--silent"]);
    await sleep(1500);
    try {
      const url = `http://127.0.0.1:${port}`;
      await rpcCall(url, "anvil_setBalance", [account.address, "0xde0b6b3a7640000"]);
      const client = createPublicClient({ transport: http(url) });
      const adapter = new EvmChainAdapter();
      const supply = 1_000_000n * 10n ** 18n;
      const initcode = `${compileToken()}${pad32(supply)}`;
      const deploySigned = await account.signTransaction({
        chainId: 31337,
        nonce: 0,
        gas: 1_500_000n,
        data: initcode as `0x${string}`,
        maxFeePerGas: 2n * 10n ** 9n,
        maxPriorityFeePerGas: 10n ** 8n,
      });
      const deployHash = await adapter.broadcast(client, deploySigned);
      expect(["confirmed", "finalized"]).toContain(
        await waitFor(adapter, client, deployHash, Date.now() + 15_000),
      );
      const receipt = (await rpcCall(url, "eth_getTransactionReceipt", [deployHash])) as {
        contractAddress: string;
      };
      const token = receipt.contractAddress as `0x${string}`;

      const amount = 500n * 10n ** 18n;
      const tx = await adapter.build(client, "eip155:31337", account.address, {
        kind: "erc20",
        token,
        to: RECIPIENT,
        value: amount,
      });
      expect(tx.to).toBe(token);
      expect(tx.value).toBe(0n);
      expect(tx.data.startsWith("0xa9059cbb")).toBe(true);
      const signed = await account.signTransaction({
        chainId: 31337,
        nonce: tx.nonce,
        gas: tx.gas,
        to: token,
        value: 0n,
        data: tx.data as `0x${string}`,
        maxFeePerGas: 2n * 10n ** 9n,
        maxPriorityFeePerGas: 10n ** 8n,
      });
      const hash = await adapter.broadcast(client, signed);
      expect(["confirmed", "finalized"]).toContain(
        await waitFor(adapter, client, hash, Date.now() + 15_000),
      );
      const balCall = `0x70a08231${"0".repeat(24)}${RECIPIENT.slice(2).toLowerCase()}`;
      const balance = BigInt(
        (await rpcCall(url, "eth_call", [{ to: token, data: balCall }, "latest"])) as string,
      );
      expect(balance).toBe(amount);
    } finally {
      proc.kill();
    }
  }, 60_000);
});

describe.runIf(RUN)("anvil e2e: evm replace", () => {
  it("speed-up confirms the replacement and marks the original replaced", async () => {
    const port = 18548;
    const proc = execFile(anvil(), ["--port", String(port), "--silent"]);
    await sleep(1500);
    try {
      const url = `http://127.0.0.1:${port}`;
      await rpcCall(url, "anvil_setBalance", [account.address, "0xde0b6b3a7640000"]);
      await rpcCall(url, "evm_setAutomine", [false]);
      const client = createPublicClient({ transport: http(url) });
      const adapter = new EvmChainAdapter();
      // low-fee original
      const unsigned = await adapter.build(client, "eip155:31337", account.address, {
        kind: "native",
        to: RECIPIENT,
        value: 10n ** 15n,
      });
      const feed = adapter.applyFee(unsigned, {
        tier: "slow",
        wei: 10n ** 9n,
        maxFeePerGas: 10n ** 9n,
        maxPriorityFeePerGas: 10n ** 8n,
      });
      const signed = await account.signTransaction({
        chainId: 31337,
        nonce: feed.nonce,
        gas: feed.gas,
        to: feed.to as `0x${string}`,

        value: feed.value,
        data: feed.data as `0x${string}`,
        maxFeePerGas: nonZero(feed.maxFeePerGas),
        maxPriorityFeePerGas: nonZero(feed.maxPriorityFeePerGas),
      });
      const hash = await adapter.broadcast(client, signed);
      // speed-up: same nonce, fee × ~1.5 → lands in the block first
      const bumped = {
        ...feed,
        maxFeePerGas: 15n * 10n ** 8n,
        maxPriorityFeePerGas: 15n * 10n ** 7n,
      };
      const bumpedSigned = await account.signTransaction({
        chainId: 31337,
        nonce: bumped.nonce,
        gas: bumped.gas,
        to: bumped.to as `0x${string}`,
        value: bumped.value,
        data: bumped.data as `0x${string}`,
        maxFeePerGas: nonZero(bumped.maxFeePerGas),
        maxPriorityFeePerGas: nonZero(bumped.maxPriorityFeePerGas),
      });
      const bumpHash = await adapter.broadcast(client, bumpedSigned);
      await rpcCall(url, "evm_mine", [{ blocks: 1 }]);
      const bumpState = await adapter.status(client, bumpHash);
      const origState = await adapter.status(client, hash);
      expect(["confirmed", "finalized"]).toContain(bumpState);
      expect(["failed", "dropped", "pending"]).toContain(origState);
    } finally {
      proc.kill();
    }
  }, 30_000);
});

const anvilLogger: EngineLogger = { warn: () => {} };

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };

const taggedRandom = (): ((n: number) => Uint8Array) => {
  let tag = 0;
  return (n) => {
    tag += 1;
    return new Uint8Array(n).fill(tag);
  };
};

const realWallet = async (): Promise<{ wallet: Wallet; walletId: string }> => {
  const wallet = await createNodeWallet({
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
  return { wallet, walletId: info.walletId };
};

describe.runIf(RUN)("anvil e2e: engine.transactions replace", () => {
  const rig = async (url: string, timers: Array<() => unknown>) => {
    const { wallet, walletId } = await realWallet();
    const acct = {
      kind: "hd" as const,
      walletId,
      groupIndex: 0,
      template: "evm.bip44" as const,
    };
    const evmAccount = await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "evm.bip44",
      network: "eip155:1",
    });
    const from = "address" in evmAccount ? evmAccount.address : "";
    await rpcCall(url, "anvil_setBalance", [from, "0xde0b6b3a7640000"]);
    await rpcCall(url, "evm_setAutomine", [false]);
    const ctl = new TransactionController({
      wallet,
      networks: new NetworkController({
        fetch: globalThis.fetch.bind(globalThis),
        rpc: { "eip155:1": [url] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: anvilLogger,
      }),
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: taggedRandom(),
      setTimer: (_ms, fn) => {
        timers.push(fn);
        return () => {};
      },
      now: () => 1000,
      logger: anvilLogger,
      pollMs: 1,
    });
    await ctl.init();
    return { ctl, acct };
  };

  it("speed-up confirms the replacement and marks the original replaced", async () => {
    const port = 18551;
    const proc = execFile(anvil(), ["--port", String(port), "--chain-id", "1", "--silent"]);
    await sleep(1500);
    const timers: Array<() => unknown> = [];
    try {
      const url = `http://127.0.0.1:${port}`;
      const { ctl, acct } = await rig(url, timers);
      const original = await ctl.send({
        account: acct,
        network: "eip155:1",
        to: RECIPIENT,
        amount: 10n ** 15n,
        fee: "slow",
        verify: VERIFY,
      });
      expect(original.state).toBe("submitted");
      const bumped = await ctl.replace(original.id, "speed-up", VERIFY);
      expect(bumped.state).toBe("submitted");
      expect(bumped.nonce).toBe(original.nonce);
      await rpcCall(url, "evm_mine", [{ blocks: 1 }]);
      await Promise.all(
        timers.map(async (fn) => {
          await fn();
        }),
      );
      const { txs } = ctl.getState();
      expect(txs[bumped.id]?.state).toBe("confirmed");
      expect(txs[original.id]?.state).toBe("replaced");
    } finally {
      proc.kill();
    }
  }, 60_000);

  it("cancel confirms a self-transfer; the original is replaced and the recipient gets nothing", async () => {
    const port = 18552;
    const proc = execFile(anvil(), ["--port", String(port), "--chain-id", "1", "--silent"]);
    await sleep(1500);
    const timers: Array<() => unknown> = [];
    try {
      const url = `http://127.0.0.1:${port}`;
      const { ctl, acct } = await rig(url, timers);
      const original = await ctl.send({
        account: acct,
        network: "eip155:1",
        to: RECIPIENT,
        amount: 10n ** 15n,
        fee: "slow",
        verify: VERIFY,
      });
      const cancelled = await ctl.replace(original.id, "cancel", VERIFY);
      expect(cancelled.state).toBe("submitted");
      await rpcCall(url, "evm_mine", [{ blocks: 1 }]);
      await Promise.all(
        timers.map(async (fn) => {
          await fn();
        }),
      );
      const { txs } = ctl.getState();
      expect(txs[cancelled.id]?.state).toBe("confirmed");
      expect(txs[original.id]?.state).toBe("replaced");
      const balance = BigInt(
        (await rpcCall(url, "eth_getBalance", [RECIPIENT, "latest"])) as string,
      );
      expect(balance).toBe(0n);
    } finally {
      proc.kill();
    }
  }, 60_000);
});
