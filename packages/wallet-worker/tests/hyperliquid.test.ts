import { readFile } from "node:fs/promises";

/**
 * The @qntx/wallet/hyperliquid subpath end to end on the real Node host: `hyperliquid(wallet)`
 * reaches the kernel's apps module over the channel — createAgent, listAgents, signL1 (verified by
 * recovering the agent address from the signature with the independent nktkas hash), deleteAgent.
 */
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { bytesToHex } from "@noble/hashes/utils.js";
import { recoverTypedDataAddress } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { WalletError } from "@qntx/wallet";
import type { Wallet } from "@qntx/wallet";
import { hyperliquid } from "@qntx/wallet/hyperliquid";

import { createNodeWallet, createSoftwarePasskey } from "../src/node/index.ts";

const KERNEL_URL = new URL("../dist/kernel.node.js", import.meta.url);
const PASSKEY_CONFIG = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  backupSalt: "qntx/backup",
  vaultSalt: "qntx/vault",
};
const PASSWORD = "correct horse battery staple";
const ACCOUNTS = JSON.parse(
  await readFile(new URL("../../../vectors/spark-accounts.json", import.meta.url), "utf8"),
) as { mnemonic: string };
const DAY = 86_400_000;

async function nodeWallet(): Promise<Wallet> {
  return createNodeWallet({
    verifyEvent,
    passkey: PASSKEY_CONFIG,
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(new Uint8Array(32).fill(11)),
    kernelUrl: KERNEL_URL,
  });
}

function code(error: unknown): string {
  if (error instanceof WalletError) {
    return error.code;
  }
  throw error;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return code(error);
  }
  throw new Error("expected rejection");
}

const AGENT_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

describe("hyperliquid subpath on the node host", () => {
  it("memoizes the api per wallet and rejects a foreign object", async () => {
    const wallet = await nodeWallet();
    expect(hyperliquid(wallet)).toBe(hyperliquid(wallet));
    expect(() => hyperliquid({} as Wallet)).toThrow(WalletError);
    await wallet.destroy();
  });

  it("creates, lists, signs with and deletes an agent", async () => {
    const wallet = await nodeWallet();
    const created = await wallet.wallets.importMnemonic({
      mnemonic: ACCOUNTS.mnemonic,
      factor: { kind: "password", password: PASSWORD },
    });
    const api = hyperliquid(wallet);
    const validUntil = Date.now() + DAY;

    const address = await api.createAgent({
      owner: { walletId: created.walletId, groupIndex: 0 },
      network: "Mainnet",
      name: "bot-1",
      validUntil,
    });
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const agents = await api.listAgents();
    expect(agents).toHaveLength(1);
    const [info] = agents;
    expect(info).toMatchObject({
      address,
      walletId: created.walletId,
      groupIndex: 0,
      network: "Mainnet",
      name: "bot-1",
      validUntil,
    });
    expect(info?.owner).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // The phantom-agent connectionId over the action + nonce is what the agent signs.
    const action = { type: "updateLeverage", asset: 1, isCross: true, leverage: 5 } as const;
    const nonce = Date.now();
    const signature = await api.signL1({ agent: address, action, nonce });
    expect(signature).toHaveLength(65);
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "Exchange",
        version: "1",
        chainId: 1337n,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: AGENT_TYPES,
      primaryType: "Agent",
      message: { source: "a", connectionId: createL1ActionHash({ action, nonce }) },
      signature: `0x${bytesToHex(signature)}`,
    });
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());

    await api.deleteAgent(address);
    await expect(api.listAgents()).resolves.toHaveLength(0);
    await expect(codeOf(api.deleteAgent(address))).resolves.toBe("not-found");

    await wallet.destroy();
  });
});
