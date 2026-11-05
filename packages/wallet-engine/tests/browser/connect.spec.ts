/* oxlint-disable typescript/no-unsafe-type-assertion -- page evaluate results are untyped */
import { randomBytes } from "node:crypto";
/**
 * The injected EIP-1193/EIP-6963 provider against a real `Eip1193Handler`: the provider script is
 * installed via `addInitScript`, the page's `ReactNativeWebView.postMessage` forwards to a
 * Node-side `createBrowserBridge` (via `exposeFunction`), and the bridge's `inject` evaluates
 * `__qntxReceive` in the page. Page interactions run as string evaluates so they are not
 * typechecked against Node globals — the page's API is declared by the injected script and the test
 * page, not by this spec.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { NETWORK } from "@scure/btc-signer/utils.js";

import { Keys, KeysSigner, verifyEvent } from "@qntx/nostr";
import type { Event } from "@qntx/nostr";
import type { NostrKeyRef, Wallet } from "@qntx/wallet";
import {
  bitcoinAddressFromXpub,
  bitcoinPubkeyFromXpub,
  verifyBitcoinMessage,
} from "@qntx/wallet-chains/bitcoin";
import { solanaAddressFromPublicKey, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";
import type { WalletSigner } from "@qntx/wallet/nostr";

import { prepareDappPsbts, signDappPsbts } from "../../src/chains/bitcoin-dapp.ts";
import type { Esplora } from "../../src/chains/bitcoin.ts";
import { BitcoinWalletHandler } from "../../src/connect/bitcoin.ts";
import { ConnectionController } from "../../src/connect/controller.ts";
import { Eip1193Handler } from "../../src/connect/eip1193.ts";
import { createBrowserBridge, injectedScript } from "../../src/connect/index.ts";
import type { ProviderInfo } from "../../src/connect/index.ts";
import { Nip07Handler } from "../../src/connect/nip07.ts";
import { SolanaWalletHandler } from "../../src/connect/solana.ts";
import { WeblnHandler } from "../../src/connect/webln.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { RequestController } from "../../src/requests/controller.ts";
import type { SparkController } from "../../src/spark/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { bookDeps, simulateSolanaStub, tokensStub, idleNetworkDeps } from "../send-helpers.ts";

const KERNEL_URL = new URL("../../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const MAINNET = "eip155:1";
const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PAGE_URL = "http://localhost:4176/connect.html";
const ORIGIN = "http://localhost:4176";
const logger = { warn: () => undefined };

const NOSTR_KEYS = Keys.generate();
const NOSTR_PUBKEY = NOSTR_KEYS.publicKey;
const SOL_SECRET = new Uint8Array(32).fill(3);
const SOL_PUBKEY = ed25519.getPublicKey(SOL_SECRET);
const SOL_ADDR = solanaAddressFromPublicKey(SOL_PUBKEY);
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
const solanaSignBytes = (message: Uint8Array): Uint8Array => ed25519.sign(message, SOL_SECRET);
const NOSTR_REF: NostrKeyRef = { kind: "derived", walletId: "w", index: 0 };
const nostrSigner = new KeysSigner(NOSTR_KEYS);
const walletSigner: WalletSigner = {
  getPublicKey: async () => {
    const r = await nostrSigner.getPublicKey();
    return r;
  },
  signEvent: async (e) => {
    const r = await nostrSigner.signEvent(e);
    return r;
  },
  nip04Encrypt: async (p, t) => {
    const r = await nostrSigner.nip04Encrypt(p, t);
    return r;
  },
  nip04Decrypt: async (p, t) => {
    const r = await nostrSigner.nip04Decrypt(p, t);
    return r;
  },
  nip44Encrypt: async (p, t) => {
    const r = await nostrSigner.nip44Encrypt(p, t);
    return r;
  },
  nip44Decrypt: async (p, t) => {
    const r = await nostrSigner.nip44Decrypt(p, t);
    return r;
  },
  unwrapGiftWraps: async () => {
    await Promise.resolve();
    return [];
  },
};

const INFO: ProviderInfo = {
  uuid: "550e8400-e29b-41d4-a716-446655440000",
  name: "Qntx Wallet",
  icon: `data:image/png;base64,${"A".repeat(16)}`,
  rdns: "xyz.meowl",
};

/** A fresh in-memory engine store (the `send-helpers.ts` pattern). */
const memoryStore = async () => {
  await Promise.resolve();
  return createMemoryEngineStore();
};

/** No address has history: the scan finds nothing and a broadcast answers a fixed txid. */
async function noHistory(): Promise<unknown> {
  await Promise.resolve();
  return [];
}

async function fixedTxid(): Promise<unknown> {
  await Promise.resolve();
  return "cd".repeat(32);
}

const fakeEsplora: Esplora = { get: noHistory, post: fixedTxid };

async function engineRig() {
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
  const { walletId } = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: { kind: "password", password: PASSWORD },
  });
  const apis = chains(wallet);
  const bitcoinAccount = async (
    group: { walletId: string; groupIndex: number },
    network: string,
    purpose: "payment" | "ordinals",
  ) => {
    const template = purpose === "payment" ? "btc.bip84" : "btc.bip86";
    const account = await apis.account({ ...group, template, network });
    if (!("xpub" in account) || account.xpub === undefined) {
      throw new Error("no bitcoin account");
    }
    return {
      address: bitcoinAddressFromXpub(account.xpub, template, network, 0, 0),
      publicKey: bitcoinPubkeyFromXpub(account.xpub, template, network, 0, 0),
    };
  };
  const addressAt = async (groupIndex: number, network = MAINNET): Promise<string> => {
    const account = await apis.account({ walletId, groupIndex, template: "evm.bip44", network });
    return "address" in account ? account.address : "";
  };
  let counter = 0;
  const random = (n: number): Uint8Array => {
    counter += 1;
    return new Uint8Array(n).fill(counter % 251);
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: async (_input, init) => {
      await Promise.resolve();
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      const id = typeof body === "object" && body !== null && "id" in body ? body.id : null;
      return Response.json({ jsonrpc: "2.0", id, result: "0x10" });
    },
    rpc: { [MAINNET]: ["https://rpc.example"] },
    openStore: memoryStore,
    logger,
  });
  const transactions = new TransactionController({
    wallet,
    networks,
    openStore: memoryStore,
    random,
    setTimer: () => () => undefined,
    now: () => 1000,
    logger,
  });
  await transactions.init();
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: {
      createInvoice: async () => {
        await Promise.resolve();
        return {
          id: "inv-1",
          invoice: "lnbc1testinvoice",
          paymentHash: new Uint8Array(32),
          amountSats: 100,
          expiresAtMs: 9999,
        };
      },
    } as unknown as SparkController,
    nostrSign: async (_ref, event): Promise<Event> => nostrSigner.signEvent(event),
    bitcoinPrepare: async (account, network, psbts) =>
      prepareDappPsbts(apis, fakeEsplora, account, network, psbts),
    bitcoinSignPsbts: async (account, _network, prepared, send, verify) => {
      const { signedPsbts, txids } = await signDappPsbts(
        apis,
        account,
        fakeEsplora,
        prepared,
        send,
        verify,
      );
      return { kind: "bitcoin.psbts" as const, signedPsbts, txids };
    },
    bitcoinSign: async (account, network, request, verify) => {
      const result = await apis.sign({
        request: {
          kind: "bitcoin.message",
          network,
          account: {
            kind: "hd",
            walletId: account.walletId,
            groupIndex: account.groupIndex,
            template: account.template,
          },
          address: account.address,
          message: request.message,
          format: "bip322-simple",
          change: 0,
          index: 0,
        },
        verify,
      });
      if (result.kind !== "bitcoin.message") {
        throw new Error("unexpected result");
      }
      return { kind: "bitcoin.message" as const, signature: result.signature };
    },
    solanaSign: async (_account, _network, request) => {
      await Promise.resolve();
      if (request.kind === "message") {
        return {
          kind: "solana.message" as const,
          signature: solanaSignBytes(request.message),
        };
      }
      throw new Error("solana transactions are not wired in this test");
    },
    fetch: globalThis.fetch,
    random,
    now: () => 1000,
    setTimer: () => () => undefined,
    logger,
  });
  await requests.init();
  const connections = new ConnectionController({
    phishing: { check: () => "clear" },
    setTimer: () => () => undefined,
    openStore: memoryStore,
    random,
    now: () => Date.now(),
    logger,
    allowLocalhost: true,
    selectedGroup: () => ({ walletId, groupIndex: 0 }),
    evmAddress: async (group: { walletId: string; groupIndex: number }, network: string) =>
      addressAt(group.groupIndex, network),
    enabledNetworks: () => [MAINNET, SOL_NET, BTC_NET],
    bitcoinAddress: async (group, network, purpose) => {
      const { address } = await bitcoinAccount(group, network, purpose);
      return address;
    },
    solanaAddress: async (_group: { walletId: string; groupIndex: number }, _network: string) => {
      await Promise.resolve();
      return SOL_ADDR;
    },
    nostrPubkey: async (ref) => {
      await Promise.resolve(ref);
      return NOSTR_PUBKEY;
    },
    invalidate: (origin) => requests.invalidateOrigin(origin),
  });
  await connections.init();
  const eip1193 = new Eip1193Handler({
    connections,
    requests,
    networks,
    defaultNetwork: () => MAINNET,
    isTracked: () => false,
  });
  const nip07 = new Nip07Handler({
    connections,
    requests,
    signerFor: () => walletSigner,
  });
  const webln = new WeblnHandler({
    connections,
    requests,
    now: () => 1000,
    spark: {
      accountBalance: () => 42000,
      paymentStatus: async () => {
        await Promise.resolve();
        return {
          status: "succeeded",
          outcome: "succeeded",
          preimage: new Uint8Array(32).fill(1),
        };
      },
    },
    sparkAccount: () => ({ walletId, groupIndex: 0, network: "regtest" }),
    alias: "qntx-test",
    lightningMaxFee: () => 10,
    sleep: async () => {
      await Promise.resolve();
    },
  });
  const solana = new SolanaWalletHandler({
    connections,
    requests,
    solanaAccount: async () => {
      await Promise.resolve();
      return { address: SOL_ADDR, publicKey: SOL_PUBKEY };
    },
    activeGroup: () => ({ walletId, groupIndex: 0 }),
    solanaNetwork: () => SOL_NET,
  });
  const bitcoin = new BitcoinWalletHandler({
    connections,
    requests,
    bitcoinAccount,
    activeGroup: () => ({ walletId, groupIndex: 0 }),
    bitcoinNetwork: () => BTC_NET,
  });
  await connections.setActiveIdentity(NOSTR_REF);
  return { connections, requests, eip1193, nip07, webln, solana, bitcoin, addressAt };
}

async function openConnect(context: BrowserContext) {
  const rig = await engineRig();
  const page = await context.newPage();
  const bridge = createBrowserBridge({
    eip1193: rig.eip1193,
    nip07: rig.nip07,
    webln: rig.webln,
    solana: rig.solana,
    bitcoin: rig.bitcoin,
    connections: rig.connections,
    inject: (script) => void page.evaluate(script),
    now: () => Date.now(),
  });
  await page.exposeFunction("__qntxPostToHost", (json: string) => {
    bridge.message(ORIGIN, json);
  });
  await page.addInitScript(`window.ReactNativeWebView = { postMessage: window.__qntxPostToHost };`);
  await page.addInitScript(injectedScript(INFO));
  await page.goto(PAGE_URL);
  bridge.navigated(PAGE_URL);
  return { page, rig };
}

const request = async (page: Page, method: string, params?: unknown): Promise<unknown> =>
  page.evaluate(`window.ethereum.request(${JSON.stringify({ method, params })})`);

test("EIP-6963 announce carries the frozen provider", async ({ context }) => {
  const { page } = await openConnect(context);
  const detail = await page.evaluate(`new Promise((resolve) => {
    window.addEventListener("eip6963:announceProvider", (e) => {
      const d = e.detail;
      resolve({
        info: d.info,
        frozen: Object.isFrozen(d.provider) && Object.isFrozen(d.info),
      });
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  })`);
  expect(detail).toMatchObject({ info: { uuid: INFO.uuid, rdns: INFO.rdns }, frozen: true });
});

test("the provider exposes request/on/removeListener only", async ({ context }) => {
  const { page } = await openConnect(context);
  const keys = await page.evaluate(`Object.keys(window.ethereum).toSorted()`);
  expect(keys).toEqual(["on", "removeListener", "request"]);
});

test("eth_chainId and empty eth_accounts before connecting", async ({ context }) => {
  const { page } = await openConnect(context);
  expect(await request(page, "eth_chainId")).toBe("0x1");
  expect(await request(page, "eth_accounts")).toEqual([]);
});

test("connect → accountsChanged → personal_sign recovers the approved account", async ({
  context,
}) => {
  const { page, rig } = await openConnect(context);

  const requestAccounts = request(page, "eth_requestAccounts");
  await expect.poll(() => rig.connections.pending().length, { timeout: 10_000 }).toBe(1);
  const account = await rig.addressAt(0, MAINNET);
  const [pending] = rig.connections.pending();
  await rig.connections.approveConnection(pending?.id ?? "", {
    accounts: [account],
    network: MAINNET,
  });
  expect(await requestAccounts).toStrictEqual([account.toLowerCase()]);

  await expect
    .poll(async () => page.evaluate(`globalThis.ethEvents.length`), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const recover = page.evaluate(`globalThis.viemRecover("hello qntx")`);
  await expect
    .poll(
      () =>
        Object.values(rig.requests.getState().requests).some(
          (r) => r.stage === "awaiting-approval",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const sign = Object.values(rig.requests.getState().requests).find(
    (r) => r.stage === "awaiting-approval",
  );
  await rig.requests.approve(sign?.id ?? "", "evm-sign", VERIFY);
  expect(String(await recover).toLowerCase()).toBe(account.toLowerCase());
});

test("window.nostr getPublicKey → approve → signEvent verifies", async ({ context }) => {
  const { page, rig } = await openConnect(context);

  const pubkeyPromise = page.evaluate(`window.nostr.getPublicKey()`);
  await expect.poll(() => rig.connections.pending().length, { timeout: 10_000 }).toBe(1);
  const [pending] = rig.connections.pending();
  await rig.connections.approveConnection(pending?.id ?? "", {
    accounts: [],
    network: "",
    nostr: { pubkey: NOSTR_PUBKEY, policy: { signing: "ask", decrypt: false } },
  });
  expect(await pubkeyPromise).toBe(NOSTR_PUBKEY);

  const sign = page.evaluate<Event>(
    `window.nostr.signEvent({ kind: 1, content: "hello qntx", created_at: ${Math.floor(Date.now() / 1000)}, tags: [] })`,
  );
  await expect
    .poll(
      () =>
        Object.values(rig.requests.getState().requests).some(
          (r) => r.stage === "awaiting-approval",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const pendingSign = Object.values(rig.requests.getState().requests).find(
    (r) => r.stage === "awaiting-approval",
  );
  await rig.requests.approve(pendingSign?.id ?? "", "nostr-sign");
  const signed: Event = await sign;
  expect(verifyEvent(signed)).toBe(true);
  expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
});

test("policy 'always' signs a kind-1 event without an approval", async ({ context }) => {
  const { page, rig } = await openConnect(context);

  const pubkeyPromise = page.evaluate(`window.nostr.getPublicKey()`);
  await expect.poll(() => rig.connections.pending().length, { timeout: 10_000 }).toBe(1);
  const [pending] = rig.connections.pending();
  await rig.connections.approveConnection(pending?.id ?? "", {
    accounts: [],
    network: "",
    nostr: { pubkey: NOSTR_PUBKEY, policy: { signing: "always", decrypt: false } },
  });
  expect(await pubkeyPromise).toBe(NOSTR_PUBKEY);

  const signed = await page.evaluate<Event>(
    `window.nostr.signEvent({ kind: 1, content: "hello qntx", created_at: ${Math.floor(Date.now() / 1000)}, tags: [] })`,
  );
  expect(Object.values(rig.requests.getState().requests)).toHaveLength(0);
  expect(verifyEvent(signed)).toBe(true);
});

test("window.webln enable → getInfo → makeInvoice approved through the pipeline", async ({
  context,
}) => {
  const { page, rig } = await openConnect(context);

  const enablePromise = page.evaluate(`window.webln.enable()`);
  await expect.poll(() => rig.connections.pending().length, { timeout: 10_000 }).toBe(1);
  const [pending] = rig.connections.pending();
  await rig.connections.approveConnection(pending?.id ?? "", {
    accounts: [],
    network: "",
    lightning: { policy: { balance: true } },
  });
  expect(await enablePromise).toBe(true);

  const info = await page.evaluate(`window.webln.getInfo()`);
  expect(info).toMatchObject({ node: { alias: "qntx-test" } });

  const invoicePromise = page.evaluate(
    `window.webln.makeInvoice({ amount: 100, defaultMemo: "hi" })`,
  );
  await expect
    .poll(
      () =>
        Object.values(rig.requests.getState().requests).some(
          (r) => r.stage === "awaiting-approval",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const pendingInvoice = Object.values(rig.requests.getState().requests).find(
    (r) => r.stage === "awaiting-approval",
  );
  await rig.requests.approve(pendingInvoice?.id ?? "", "webln-invoice");
  const invoice = await invoicePromise;
  expect(invoice).toStrictEqual({ paymentRequest: "lnbc1testinvoice" });
});

test("window.webln keysend rejects in-page with NotSupported and posts nothing", async ({
  context,
}) => {
  const { page, rig } = await openConnect(context);
  const error = await page.evaluate(`window.webln.keysend().catch((e) => e.message)`);
  expect(error).toBe("NotSupported");
  expect(rig.connections.pending()).toHaveLength(0);
});

test("window wallet-standard getWallets → solana connect → signMessage verifies", async ({
  context,
}) => {
  const { page, rig } = await openConnect(context);
  await page.addInitScript({ path: "tests/browser/getwallets.js" });
  await page.reload();
  const wallets = await page.evaluate(
    `window.__getWallets().get().map((w) => ({ name: w.name, chains: [...w.chains] }))`,
  );
  expect(wallets).toMatchObject([
    { name: "Qntx Wallet", chains: ["solana:mainnet", "solana:devnet"] },
    { name: "Qntx Wallet", chains: ["bitcoin:mainnet", "bitcoin:testnet"] },
  ]);

  // The standard shapes: every feature is versioned and the signing features are variadic.
  const shape = await page.evaluate(`(() => {
    const wallet = window.__getWallets().get()[0];
    const features = wallet.features;
    const off = features["standard:events"].on("change", () => undefined);
    const unsubscribe = typeof off;
    off();
    return {
      versions: Object.fromEntries(Object.entries(features).map(([id, f]) => [id, f.version])),
      txVersions: features["solana:signTransaction"].supportedTransactionVersions,
      sendVersions: features["solana:signAndSendTransaction"].supportedTransactionVersions,
      unsubscribe,
      accountsLive: wallet.accounts === wallet.accounts,
    };
  })()`);
  expect(shape).toStrictEqual({
    versions: {
      "standard:connect": "1.0.0",
      "standard:disconnect": "1.0.0",
      "standard:events": "1.0.0",
      "solana:signTransaction": "1.0.0",
      "solana:signAndSendTransaction": "1.0.0",
      "solana:signMessage": "1.0.0",
      "solana:signIn": "1.0.0",
    },
    txVersions: ["legacy", 0],
    sendVersions: ["legacy", 0],
    unsubscribe: "function",
    accountsLive: true,
  });

  const connected = page.evaluate(
    `window.__getWallets().get()[0].features["standard:connect"].connect()`,
  );
  await expect.poll(() => rig.connections.pending().length, { timeout: 10_000 }).toBe(1);
  const [pending] = rig.connections.pending();
  await rig.connections.approveConnection(pending?.id ?? "", {
    accounts: [],
    network: "",
  });
  const { accounts } = (await connected) as { accounts: unknown[] };
  expect(accounts).toHaveLength(1);
  await expect(page.evaluate(`window.__getWallets().get()[0].accounts.length`)).resolves.toBe(1);
  const subset = `(() => {
    const wallet = window.__getWallets().get()[0];
    return wallet.accounts.every((a) => a.chains.every((c) => wallet.chains.includes(c)));
  })()`;
  await expect(page.evaluate(subset)).resolves.toBe(true);

  const message = new Uint8Array([1, 2, 3]);
  const result = page.evaluate(`(() => {
    const wallet = window.__getWallets().get()[0];
    return wallet.features["solana:signMessage"].signMessage({
      account: wallet.accounts[0],
      message: new Uint8Array([1, 2, 3]),
    });
  })()`);
  await expect
    .poll(
      () =>
        Object.values(rig.requests.getState().requests).some(
          (r) => r.stage === "awaiting-approval",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const pendingSign = Object.values(rig.requests.getState().requests).find(
    (r) => r.stage === "awaiting-approval",
  );
  await rig.requests.approve(pendingSign?.id ?? "", "solana-sign", VERIFY);
  const outputs = (await result) as Array<{ signature: Uint8Array; signatureType: string }>;
  expect(outputs).toHaveLength(1);
  expect(outputs[0]?.signatureType).toBe("ed25519");
  expect(verifySolanaSignature(message, outputs[0]?.signature ?? new Uint8Array(), SOL_ADDR)).toBe(
    true,
  );
});

test("window wallet-standard solana:signIn verifies with verifySignIn in the page", async ({
  context,
}) => {
  const { page, rig } = await openConnect(context);
  await page.addInitScript({ path: "tests/browser/getwallets.js" });
  await page.reload();
  const signedIn = page.evaluate(`(async () => {
    const wallet = window.__getWallets().get()[0];
    const input = { statement: "Sign in to the test page", nonce: "n-123", uri: "http://localhost" };
    const [output] = await wallet.features["solana:signIn"].signIn(input);
    return { ok: window.__verifySignIn(input, output), type: output.signatureType };
  })()`);
  await expect.poll(() => rig.connections.pending().length, { timeout: 10_000 }).toBe(1);
  const [pending] = rig.connections.pending();
  await rig.connections.approveConnection(pending?.id ?? "", { accounts: [], network: "" });
  await expect
    .poll(
      () =>
        Object.values(rig.requests.getState().requests).some(
          (r) => r.stage === "awaiting-approval",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const sign = Object.values(rig.requests.getState().requests).find(
    (r) => r.stage === "awaiting-approval",
  );
  expect(sign?.display).toMatchObject({ signIn: { nonce: "n-123" } });
  await rig.requests.approve(sign?.id ?? "", "solana-sign", VERIFY);
  expect((await signedIn) as { ok: boolean; type: string }).toStrictEqual({
    ok: true,
    type: "ed25519",
  });
});

test("window wallet-standard bitcoin connect → signMessage verifies in the page", async ({
  context,
}) => {
  const { page, rig } = await openConnect(context);
  await page.addInitScript({ path: "tests/browser/getwallets.js" });
  await page.reload();
  const bitcoinWallet = `window.__getWallets().get().find((w) => w.chains.includes("bitcoin:mainnet"))`;

  const versions = await page.evaluate(`(() => {
    const wallet = ${bitcoinWallet};
    const off = wallet.features["bitcoin:events"].on("change", () => undefined);
    const unsubscribe = typeof off;
    off();
    return {
      versions: Object.fromEntries(Object.entries(wallet.features).map(([id, f]) => [id, f.version])),
      unsubscribe,
    };
  })()`);
  expect(versions).toStrictEqual({
    versions: {
      "standard:disconnect": "1.0.0",
      "bitcoin:connect": "1.0.0",
      "bitcoin:disconnect": "1.0.0",
      "bitcoin:events": "1.0.0",
      "bitcoin:signMessage": "1.0.0",
      "bitcoin:signTransaction": "1.0.0",
      "bitcoin:signAndSendTransaction": "1.0.0",
    },
    unsubscribe: "function",
  });

  const connected = page.evaluate(
    `${bitcoinWallet}.features["bitcoin:connect"].connect({ purposes: ["ordinals", "payment"] })`,
  );
  await expect.poll(() => rig.connections.pending().length, { timeout: 10_000 }).toBe(1);
  const [pending] = rig.connections.pending();
  expect(pending?.namespace).toBe("bip122");
  await rig.connections.approveConnection(pending?.id ?? "", { accounts: [], network: BTC_NET });
  const { accounts } = (await connected) as { accounts: Array<{ address: string }> };
  expect(accounts.map((a) => a.address.slice(0, 4))).toStrictEqual(["bc1p", "bc1q"]);

  const text = "Hello from the page";
  const result = page.evaluate(`(() => {
    const wallet = ${bitcoinWallet};
    return wallet.features["bitcoin:signMessage"].signMessage({
      account: wallet.accounts[1],
      message: new TextEncoder().encode(${JSON.stringify(text)}),
    });
  })()`);
  await expect
    .poll(
      () =>
        Object.values(rig.requests.getState().requests).some(
          (r) => r.stage === "awaiting-approval",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const pendingSign = Object.values(rig.requests.getState().requests).find(
    (r) => r.stage === "awaiting-approval",
  );
  await rig.requests.approve(pendingSign?.id ?? "", "bitcoin-sign", VERIFY);
  const outputs = (await result) as Array<{ signedMessage: Uint8Array; signature: Uint8Array }>;
  expect(outputs).toHaveLength(1);
  const [paymentAddress] = accounts.slice(1).map((a) => a.address);
  expect(
    verifyBitcoinMessage(
      paymentAddress ?? "",
      text,
      `smp${Buffer.from(outputs[0]?.signature ?? new Uint8Array()).toString("base64")}`,
      BTC_NET,
    ),
  ).toBe(true);
});

test("window wallet-standard bitcoin:signTransaction signs a PSBT in the page", async ({
  context,
}) => {
  const { page, rig } = await openConnect(context);
  await page.addInitScript({ path: "tests/browser/getwallets.js" });
  await page.reload();
  const bitcoinWallet = `window.__getWallets().get().find((w) => w.chains.includes("bitcoin:mainnet"))`;
  const connected = page.evaluate(
    `${bitcoinWallet}.features["bitcoin:connect"].connect({ purposes: ["payment"] })`,
  );
  await expect.poll(() => rig.connections.pending().length, { timeout: 10_000 }).toBe(1);
  const [pending] = rig.connections.pending();
  await rig.connections.approveConnection(pending?.id ?? "", { accounts: [], network: BTC_NET });
  const { accounts } = (await connected) as { accounts: Array<{ address: string }> };
  const address = accounts[0]?.address ?? "";

  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: new Uint8Array(32).fill(9),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: OutScript.encode(Address(NETWORK).decode(address)), amount: 100_000n },
  });
  tx.addOutput({
    script: OutScript.encode(Address(NETWORK).decode("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")),
    amount: 99_000n,
  });
  const psbtHex = Buffer.from(tx.toPSBT(0)).toString("hex");
  const result = page.evaluate(`(() => {
    const wallet = ${bitcoinWallet};
    const psbt = Uint8Array.from(${JSON.stringify(psbtHex)}.match(/../g).map((b) => parseInt(b, 16)));
    return wallet.features["bitcoin:signTransaction"].signTransaction({
      psbt,
      inputsToSign: [{ account: wallet.accounts[0], signingIndexes: [0] }],
    });
  })()`);
  await expect
    .poll(
      () =>
        Object.values(rig.requests.getState().requests).some(
          (r) => r.stage === "awaiting-approval",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const pendingSign = Object.values(rig.requests.getState().requests).find(
    (r) => r.stage === "awaiting-approval",
  );
  await rig.requests.approve(pendingSign?.id ?? "", "bitcoin-sign", VERIFY);
  const outputs = (await result) as Array<{ signedPsbt: Uint8Array }>;
  expect(outputs).toHaveLength(1);
  const signed = Transaction.fromPSBT(new Uint8Array(Object.values(outputs[0]?.signedPsbt ?? {})));
  expect(signed.getInput(0).partialSig).toHaveLength(1);
});
