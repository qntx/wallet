import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

/**
 * The Bitcoin Wallet Standard handler over a REAL Node kernel: connect approval, the `payment` and
 * `ordinals` accounts from the account xpubs, a BIP-322 simple signature the repo's verifier
 * accepts, the sign log, and the account re-point on a group switch.
 */
import { verifyEvent } from "@qntx/nostr";
import { bitcoinAddressFromXpub, verifyBitcoinMessage } from "@qntx/wallet-chains/bitcoin";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import type { BitcoinEvent, BitcoinWalletAccount } from "../src/connect/bitcoin.ts";
import { createWalletEngine } from "../src/engine.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const MAINNET = "bip122:000000000019d6689c085ae165831e93";
const SITE = "https://app.example.com";
const PW = { kind: "password" as const, password: PASSWORD };
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// BIP-84 / BIP-86 first receive addresses of the public test mnemonic (BIP-84 and BIP-86 texts).
const BIP84_FIRST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const BIP86_FIRST = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";

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
    fetch: async () => Promise.reject(new Error("offline")),
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: { warn: () => undefined },
    openStore: async () => Promise.resolve(createMemoryEngineStore({ collections: backing })),
    rpc: { [MAINNET]: ["https://esplora.invalid"] },
  });
  const info = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: { kind: "password", password: PASSWORD },
  });
  await until(() => engine.accounts.getState().selected !== null);
  await until(() => engine.networks.enabled("bitcoin").length > 0);
  return { wallet, engine, walletId: info.walletId };
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

const firstAddress = (
  account: Awaited<ReturnType<ReturnType<typeof chains>["account"]>>,
): string =>
  "xpub" in account ? bitcoinAddressFromXpub(account.xpub ?? "", "btc.bip84", MAINNET, 0, 0) : "";

const accountsOf = (event: BitcoinEvent | undefined): ReadonlyArray<BitcoinWalletAccount> =>
  event === undefined ? [] : event.accounts;

type Signed = { value: { signedMessage: Uint8Array; signature: Uint8Array } };

const signed = (outcome: { value: unknown } | { error: unknown }): Signed => {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome as Signed;
};

/** The sign log is written asynchronously: waits until it holds `count` entries. */
async function signLogOf(r: Rig, count: number) {
  for (let i = 0; i < 100; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    const log = await r.engine.requests.signLog();
    if (log.length >= count) {
      return log;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return r.engine.requests.signLog();
}

async function connect(r: Rig, purposes: string[]): Promise<BitcoinWalletAccount[]> {
  const pending = r.engine.bitcoinWallet.handle(SITE, {
    method: "bitcoin:connect",
    params: { purposes },
  });
  await until(() => r.engine.connections.pending().length > 0);
  const [entry] = r.engine.connections.pending();
  expect(entry).toMatchObject({ namespace: "bip122", kind: "connect" });
  await r.engine.connections.approveConnection(entry?.id ?? "", { accounts: [], network: MAINNET });
  return ((await pending) as { accounts: BitcoinWalletAccount[] }).accounts;
}

async function sign(r: Rig, address: string, text: string) {
  const call = r.engine.bitcoinWallet.handle(SITE, {
    method: "bitcoin:signMessage",
    params: { account: address, message: new TextEncoder().encode(text) },
  });
  const settled = call.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const open = () =>
    Object.values(r.engine.requests.getState().requests).filter(
      (entry) => entry.stage === "awaiting-approval",
    );
  await until(() => open().length > 0);
  const [request] = open();
  if (request === undefined) {
    throw new Error("no pending request");
  }
  return {
    request,
    settled,
    approve: async () => r.engine.requests.approve(request.id, "bitcoin-sign", PW),
  };
}

describe("bitcoin provider over a real kernel", () => {
  it("connects with the group's bip84 and bip86 first receive addresses", async () => {
    const r = await rig();
    try {
      const accounts = await connect(r, ["ordinals", "payment"]);
      expect(accounts.map((a) => a.address)).toStrictEqual([BIP86_FIRST, BIP84_FIRST]);
      expect(accounts[0]?.publicKey).toHaveLength(32);
      expect(accounts[1]?.publicKey).toHaveLength(33);
      expect(accounts[0]?.chains).toStrictEqual(["bitcoin:mainnet"]);
      const scope = Object.values(r.engine.connections.getState().sessions)[0]?.scopes[MAINNET];
      expect(scope?.methods).toContain("bitcoin:signMessage");
      expect(scope?.accounts).toStrictEqual([
        `${MAINNET}:${BIP84_FIRST}`,
        `${MAINNET}:${BIP86_FIRST}`,
      ]);
      // The xpub path the engine already uses agrees with the address it hands out.
      const account = await chains(r.wallet).account({
        walletId: r.walletId,
        groupIndex: 0,
        template: "btc.bip84",
        network: MAINNET,
      });
      expect(firstAddress(account)).toBe(BIP84_FIRST);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("signs a message with a BIP-322 simple signature the verifier accepts, for both accounts", async () => {
    const r = await rig();
    try {
      await connect(r, ["payment", "ordinals"]);
      for (const address of [BIP84_FIRST, BIP86_FIRST]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one request at a time per origin
        const { request, settled, approve } = await sign(r, address, "Hello Bitcoin");
        expect(request).toMatchObject({
          method: "bitcoin-sign",
          network: MAINNET,
          display: { kind: "bitcoin.sign", message: { kind: "text", text: "Hello Bitcoin" } },
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- see above
        await approve();
        // oxlint-disable-next-line eslint/no-await-in-loop -- see above
        const result = signed(await settled);
        expect(new TextDecoder().decode(result.value.signedMessage)).toBe("Hello Bitcoin");
        expect(
          verifyBitcoinMessage(
            address,
            "Hello Bitcoin",
            `smp${Buffer.from(result.value.signature).toString("base64")}`,
            MAINNET,
          ),
        ).toBe(true);
      }
      const log = await signLogOf(r, 2);
      expect(log.map((e) => e.summary)).toStrictEqual(["bitcoin message", "bitcoin message"]);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("re-points the accounts when the active group changes", async () => {
    const r = await rig();
    try {
      await connect(r, ["payment"]);
      const events: BitcoinEvent[] = [];
      r.engine.bitcoinWallet.subscribe((event) => events.push(event));
      const index = r.engine.accounts.addGroup(r.walletId);
      await r.engine.connections.setActiveGroup(r.walletId, index);
      await until(() => events.length > 0);
      expect(events[0]?.origin).toBe(SITE);
      const [payment, ordinals] = accountsOf(events[0]);
      expect(payment?.address).toMatch(/^bc1q/);
      expect(payment?.address).not.toBe(BIP84_FIRST);
      expect(ordinals?.address).toMatch(/^bc1p/);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("refuses non-UTF-8 bytes and an account outside the session", async () => {
    const r = await rig();
    try {
      await connect(r, ["payment"]);
      await expect(
        r.engine.bitcoinWallet.handle(SITE, {
          method: "bitcoin:signMessage",
          params: { account: BIP84_FIRST, message: new Uint8Array([0xff]) },
        }),
      ).rejects.toMatchObject({ code: 4200 });
      await expect(
        r.engine.bitcoinWallet.handle(SITE, {
          method: "bitcoin:signMessage",
          params: { account: "bc1qother", message: new TextEncoder().encode("x") },
        }),
      ).rejects.toMatchObject({ code: 4100 });
      expect(Object.keys(r.engine.requests.getState().requests)).toHaveLength(0);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });
});
