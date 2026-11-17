import { randomBytes } from "node:crypto";

/**
 * The Solana Wallet Standard handler over a REAL Node kernel: connect approval returning the
 * group's address with the public key behind it.
 */
import { address, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import type { SolanaWalletAccount } from "../src/connect/solana.ts";
import { createWalletEngine } from "../src/engine.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SITE = "https://app.example.com";

const rpcReply = (method: string): unknown => {
  if (method === "getGenesisHash") {
    return GENESIS;
  }
  throw new Error(`no rpc answer for ${method}`);
};

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
  const backing = new Map<string, Map<string, Uint8Array>>();
  const engine = createWalletEngine({
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet,
    sparkNetwork: "regtest",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://solana.invalid" || init?.method !== "POST") {
        return Promise.reject(new Error("offline"));
      }
      const call = JSON.parse(String(init.body)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      let result: unknown;
      try {
        result = rpcReply(call.method);
      } catch (error) {
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32_601, message: (error as Error).message },
          }),
        );
      }
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: call.id, result }));
    },
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: { warn: () => undefined },
    showCallsStatus: () => undefined,
    openStore: async () => Promise.resolve(createMemoryEngineStore({ collections: backing })),
    rpc: { [SOL_NET]: ["https://solana.invalid"] },
  });
  const info = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: { kind: "password", password: PASSWORD },
  });
  await until(() => engine.accounts.getState().selected !== null);
  return { wallet, engine };
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

type Rig = Awaited<ReturnType<typeof rig>>;

async function connect(r: Rig): Promise<SolanaWalletAccount> {
  const pending = r.engine.solanaWallet.handle(SITE, { method: "standard:connect" });
  await until(() => r.engine.connections.pending().length > 0);
  const [entry] = r.engine.connections.pending();
  await r.engine.connections.approveConnection(entry?.id ?? "", {
    accounts: [],
    network: SOL_NET,
  });
  const { accounts } = (await pending) as { accounts: SolanaWalletAccount[] };
  const [account] = accounts;
  if (account === undefined) {
    throw new Error("connect returned no solana account");
  }
  return account;
}

describe("solana provider over a real kernel", () => {
  it("connects with the group's address and its 32-byte public key", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      expect(account.publicKey).toStrictEqual(
        new Uint8Array(getAddressEncoder().encode(address(account.address))),
      );
      expect(account.chains).toStrictEqual(["solana:mainnet"]);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });
});
