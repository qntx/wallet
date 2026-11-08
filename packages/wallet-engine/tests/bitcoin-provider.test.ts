import { randomBytes } from "node:crypto";

/**
 * The Bitcoin Wallet Standard handler over a REAL Node kernel: connect approval, the `payment` and
 * `ordinals` accounts from the account xpubs, a BIP-322 simple signature the repo's verifier
 * accepts, the sign log, and the account re-point on a group switch.
 */
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { NETWORK } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import {
  bitcoinAddressFromXpub,
  verifyBitcoinMessage,
  verifyBitcoinPsbtSignatures,
} from "@qntx/wallet-chains/bitcoin";
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

const TXID = "ab".repeat(32);
const broadcasts: string[] = [];

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
      if (!url.startsWith("https://esplora.invalid")) {
        return Promise.reject(new Error("offline"));
      }
      broadcasts.push(init?.method === "POST" ? String(init.body) : "");
      return Promise.resolve(init?.method === "POST" ? new Response(TXID) : Response.json([]));
    },
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

const scriptOf = (address: string): Uint8Array =>
  OutScript.encode(Address(NETWORK).decode(address));

/** A PSBT spending one prevout of `from` (a wallet address) to `to`, as a dApp builds it. */
const dappPsbt = (opts: {
  from: string;
  to: string;
  value: bigint;
  sighash?: number;
  foreignScript?: Uint8Array;
}): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: new Uint8Array(32).fill(9),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: opts.foreignScript ?? scriptOf(opts.from), amount: opts.value },
    ...(opts.sighash === undefined ? {} : { sighashType: opts.sighash }),
  });
  tx.addOutput({
    script: scriptOf(opts.to),
    amount: opts.value - (opts.value > 5000n ? 1000n : 100n),
  });
  return tx.toPSBT(0);
};

const bitcoinRisk = (request: { risk: ReadonlyArray<{ code: string }> } | undefined) =>
  (request?.risk ?? []).filter((finding) => finding.code.startsWith("bitcoin-"));

const xpubOf = (account: Awaited<ReturnType<ReturnType<typeof chains>["account"]>>): string =>
  "xpub" in account ? (account.xpub ?? "") : "";

const firstSigned = (done: SignedPsbts): Uint8Array =>
  done.value[0]?.signedPsbt ?? new Uint8Array();

type SignedPsbts = { value: Array<{ signedPsbt: Uint8Array }> };

async function signPsbt(r: Rig, inputs: unknown[], method = "bitcoin:signTransaction") {
  const call = r.engine.bitcoinWallet.handle(SITE, { method, params: { inputs } });
  const settled = call.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const open = () =>
    Object.values(r.engine.requests.getState().requests).filter(
      (entry) => entry.stage === "awaiting-approval",
    );
  await Promise.race([until(() => open().length > 0), settled]);
  const [request] = open();
  return {
    request,
    settled,
    approve: async () => r.engine.requests.approve(request?.id ?? "", "bitcoin-sign", PW),
  };
}

describe("bitcoin dApp PSBTs over a real kernel", () => {
  it("signs a marketplace listing (0x83) for the ordinals account and flags the risk", async () => {
    const r = await rig();
    try {
      await connect(r, ["payment", "ordinals"]);
      const psbt = dappPsbt({ from: BIP86_FIRST, to: BIP84_FIRST, value: 546n, sighash: 0x83 });
      const { request, settled, approve } = await signPsbt(r, [
        {
          psbt,
          inputsToSign: [
            { address: BIP86_FIRST, signingIndexes: [0], sigHash: "SINGLE|ANYONECANPAY" },
          ],
        },
      ]);
      expect(request?.display).toMatchObject({
        kind: "bitcoin.sign",
        psbts: [{ verifiability: "partial", warnings: [{ kind: "sighash-single-anyonecanpay" }] }],
      });
      expect(bitcoinRisk(request)).toStrictEqual([
        { code: "bitcoin-sighash-single", level: "danger" },
        { code: "bitcoin-inscription-input", level: "warning" },
      ]);
      expect(request?.checks).toContain("decode-partial");
      await approve();
      const done = (await settled) as SignedPsbts;
      const account = await chains(r.wallet).account({
        walletId: r.walletId,
        groupIndex: 0,
        template: "btc.bip86",
        network: MAINNET,
      });
      const signed = firstSigned(done);
      expect(verifyBitcoinPsbtSignatures(signed, [0], xpubOf(account), "btc.bip86", MAINNET)).toBe(
        true,
      );
      expect(Transaction.fromPSBT(signed).getInput(0).sighashType).toBe(0x83);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("signs a payment input with ALL and nothing to flag; the log says `bitcoin psbt 1`", async () => {
    const r = await rig();
    try {
      await connect(r, ["payment"]);
      const psbt = dappPsbt({
        from: BIP84_FIRST,
        to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        value: 100_000n,
      });
      const { request, settled, approve } = await signPsbt(r, [
        { psbt, inputsToSign: [{ address: BIP84_FIRST, signingIndexes: [0] }] },
      ]);
      expect(bitcoinRisk(request)).toStrictEqual([]);
      expect(request?.checks).toStrictEqual([]);
      await approve();
      const done = (await settled) as SignedPsbts;
      const account = await chains(r.wallet).account({
        walletId: r.walletId,
        groupIndex: 0,
        template: "btc.bip84",
        network: MAINNET,
      });
      expect(
        verifyBitcoinPsbtSignatures(firstSigned(done), [0], xpubOf(account), "btc.bip84", MAINNET),
      ).toBe(true);
      const log = await signLogOf(r, 1);
      expect(log[0]?.summary).toBe("bitcoin psbt 1");
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("signAndSend finalizes, broadcasts through esplora and returns the txid", async () => {
    const r = await rig();
    try {
      await connect(r, ["payment"]);
      broadcasts.length = 0;
      const psbt = dappPsbt({
        from: BIP84_FIRST,
        to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        value: 100_000n,
      });
      const { settled, approve, request } = await signPsbt(
        r,
        [
          {
            psbt,
            chain: "bitcoin:mainnet",
            inputsToSign: [{ address: BIP84_FIRST, signingIndexes: [0] }],
          },
        ],
        "bitcoin:signAndSendTransaction",
      );
      await approve();
      await expect(settled).resolves.toStrictEqual({ value: [{ txId: TXID }] });
      expect(broadcasts.some((body) => /^[0-9a-f]{100,}$/.test(body))).toBe(true);
      await until(() => true);
      expect(request?.method).toBe("bitcoin-sign");
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("signs a mixed payment+ordinals request: the ordinals output is not an outflow", async () => {
    const r = await rig();
    try {
      await connect(r, ["payment", "ordinals"]);
      // An inscription-purchase-shaped PSBT: the payment input funds, the ordinals
      // address receives — the wallet's own delivery, not an outflow.
      const psbt = dappPsbt({ from: BIP84_FIRST, to: BIP86_FIRST, value: 100_000n });
      const { request, settled, approve } = await signPsbt(r, [
        { psbt, inputsToSign: [{ address: BIP84_FIRST, signingIndexes: [0] }] },
      ]);
      expect(request?.display).toMatchObject({
        kind: "bitcoin.sign",
        psbts: [{ outflows: [] }],
      });
      await approve();
      const done = (await settled) as SignedPsbts;
      const account = await chains(r.wallet).account({
        walletId: r.walletId,
        groupIndex: 0,
        template: "btc.bip84",
        network: MAINNET,
      });
      expect(
        verifyBitcoinPsbtSignatures(firstSigned(done), [0], xpubOf(account), "btc.bip84", MAINNET),
      ).toBe(true);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("refuses an input that is not the wallet's, a sighash mismatch and a wrong declared purpose", async () => {
    const r = await rig();
    try {
      await connect(r, ["payment", "ordinals"]);
      const foreign = dappPsbt({
        from: BIP84_FIRST,
        to: BIP84_FIRST,
        value: 100_000n,
        foreignScript: scriptOf("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),
      });
      const refuse = async (inputs: unknown[]) => {
        const { settled } = await signPsbt(r, inputs);
        return settled;
      };
      await expect(
        refuse([{ psbt: foreign, inputsToSign: [{ address: BIP84_FIRST, signingIndexes: [0] }] }]),
      ).resolves.toMatchObject({ error: { code: -32_602 } });
      const sighashed = dappPsbt({
        from: BIP84_FIRST,
        to: BIP84_FIRST,
        value: 100_000n,
        sighash: 0x83,
      });
      await expect(
        refuse([
          { psbt: sighashed, inputsToSign: [{ address: BIP84_FIRST, signingIndexes: [0] }] },
        ]),
      ).resolves.toMatchObject({ error: { code: -32_602 } });
      // Declared payment but the prevout is the ordinals address.
      const ordPrevout = dappPsbt({ from: BIP86_FIRST, to: BIP84_FIRST, value: 100_000n });
      await expect(
        refuse([
          { psbt: ordPrevout, inputsToSign: [{ address: BIP84_FIRST, signingIndexes: [0] }] },
        ]),
      ).resolves.toMatchObject({ error: { code: -32_602 } });
      const plain = dappPsbt({ from: BIP84_FIRST, to: BIP84_FIRST, value: 100_000n });
      await expect(
        refuse([
          {
            psbt: plain,
            inputsToSign: [{ address: BIP84_FIRST, signingIndexes: [0], sigHash: "NONE" }],
          },
        ]),
      ).resolves.toMatchObject({ error: { code: -32_602 } });
      await expect(
        refuse([{ psbt: plain, inputsToSign: [{ address: "bc1qother", signingIndexes: [0] }] }]),
      ).resolves.toMatchObject({ error: { code: 4100 } });
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("flags a postage-size input signed with ALL as a danger", async () => {
    const r = await rig();
    try {
      await connect(r, ["ordinals"]);
      const psbt = dappPsbt({ from: BIP86_FIRST, to: BIP84_FIRST, value: 546n });
      const { request } = await signPsbt(r, [
        { psbt, inputsToSign: [{ address: BIP86_FIRST, signingIndexes: [0] }] },
      ]);
      expect(bitcoinRisk(request)).toStrictEqual([
        { code: "bitcoin-inscription-input", level: "danger" },
      ]);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });
});
