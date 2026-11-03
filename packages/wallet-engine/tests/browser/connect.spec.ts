/**
 * The injected EIP-1193/EIP-6963 provider against a real `Eip1193Handler`: the provider script is
 * installed via `addInitScript`, the page's `ReactNativeWebView.postMessage` forwards to a
 * Node-side `createBrowserBridge` (via `exposeFunction`), and the bridge's `inject` evaluates
 * `__qntxReceive` in the page. Page interactions run as string evaluates so they are not
 * typechecked against Node globals — the page's API is declared by the injected script and the test
 * page, not by this spec.
 */
import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { Keys, KeysSigner, verifyEvent } from "@qntx/nostr";
import type { Event } from "@qntx/nostr";
import type { NostrKeyRef, Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";
import type { WalletSigner } from "@qntx/wallet/nostr";

import { ConnectionController } from "../../src/connect/controller.ts";
import { Eip1193Handler } from "../../src/connect/eip1193.ts";
import { createBrowserBridge, injectedScript } from "../../src/connect/index.ts";
import type { ProviderInfo } from "../../src/connect/index.ts";
import { Nip07Handler } from "../../src/connect/nip07.ts";
import { WeblnHandler } from "../../src/connect/webln.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { RequestController } from "../../src/requests/controller.ts";
import type { SparkController } from "../../src/spark/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { bookDeps } from "../send-helpers.ts";

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

async function engineRig() {
  const wallet: Wallet = await createNodeWallet({
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
    transactions,
    ...bookDeps(),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a createInvoice stub suffices
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
    fetch: globalThis.fetch,
    random,
    now: () => 1000,
    setTimer: () => () => undefined,
    logger,
  });
  await requests.init();
  const connections = new ConnectionController({
    openStore: memoryStore,
    random,
    now: () => Date.now(),
    logger,
    allowLocalhost: true,
    selectedGroup: () => ({ walletId, groupIndex: 0 }),
    evmAddress: async (group: { walletId: string; groupIndex: number }, network: string) =>
      addressAt(group.groupIndex, network),
    enabledNetworks: () => [MAINNET],
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
  });
  const nip07 = new Nip07Handler({
    connections,
    requests,
    signerFor: () => walletSigner,
  });
  const webln = new WeblnHandler({
    connections,
    requests,
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
  await connections.setActiveIdentity(NOSTR_REF);
  return { connections, requests, eip1193, nip07, webln, addressAt };
}

async function openConnect(context: BrowserContext) {
  const rig = await engineRig();
  const page = await context.newPage();
  const bridge = createBrowserBridge({
    eip1193: rig.eip1193,
    nip07: rig.nip07,
    webln: rig.webln,
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
