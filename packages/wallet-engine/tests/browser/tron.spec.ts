/* oxlint-disable typescript/no-unsafe-type-assertion -- page evaluate results are untyped */
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
/**
 * The injected TRON provider (`window.tron`/`window.tronLink`/`window.tronWeb` + TIP-6963) against
 * the real engine stack — kernel + wallet like connect.spec — with the OFFICIAL
 * `@tronweb3/tronwallet-adapter-tronlink` driving the page. A mobile UA context exercises the
 * adapter's immediate `window.tronLink` path; a desktop context with `checkTimeout: 1000` falls
 * back from the TIP-6963 lookup (our info.name is not "TronLink") to the same legacy object.
 * Node-side `tronweb` builds the unsigned transaction over a stub `createtransaction` endpoint and
 * verifies every signature the page produced.
 */

import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { TronWeb } from "tronweb";

import { Keys, KeysSigner, verifyEvent } from "@qntx/nostr";
import type { Event } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { bitcoinAddressFromXpub, bitcoinPubkeyFromXpub } from "@qntx/wallet-chains/bitcoin";
import {
  tronAddressToHex,
  tronRawDataFromJson,
  verifyTronTransactionSignature,
} from "@qntx/wallet-chains/tron";
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
import { TronWalletHandler } from "../../src/connect/tron.ts";
import { WeblnHandler } from "../../src/connect/webln.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { RequestController } from "../../src/requests/controller.ts";
import type { SparkController } from "../../src/spark/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { approval } from "../approval.ts";
import { bookDeps, simulateSolanaStub, tokensStub, idleNetworkDeps } from "../send-helpers.ts";

const KERNEL_URL = new URL("../../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PAGE_URL = "http://localhost:4176/tron.html";
const ORIGIN = "http://localhost:4176";
const TRON_NET = "tron:728126428";
const INFO: ProviderInfo = {
  name: "Qntx Wallet",
  icon: "data:image/svg+xml;base64,PHN2Zy8+",
  rdns: "app.qntx",
};
const logger = { warn: () => undefined };

const NOSTR_KEYS = Keys.generate();
const NOSTR_PUBKEY = NOSTR_KEYS.publicKey;
const nostrSigner = new KeysSigner(NOSTR_KEYS);
const walletSigner: WalletSigner = {
  unwrapGiftWraps: async () => {
    await Promise.resolve();
    return [];
  },
  getPublicKey: async () => {
    const r = await nostrSigner.getPublicKey();
    return r;
  },
  signEvent: async (event) => {
    const r = await nostrSigner.signEvent(event);
    return r;
  },
};
const noHistory = async (): Promise<Response> => {
  await Promise.resolve();
  return Response.json({ txs: [] });
};
const fixedTxid = async (): Promise<Response> => {
  await Promise.resolve();
  return Response.json("11".repeat(32));
};
const fakeEsplora: Esplora = { get: noHistory, post: fixedTxid };

/** The fake TRON node: solid head 100 (id `ab..ab`), full head 105, one funded account. */
const SOLID_ID = "ab".repeat(32);
const REF_BYTES = "0064";
const REF_HASH = SOLID_ID.slice(16, 32);
const NOW = 1_900_000_000_000;

const PARAMS = {
  getTransactionFee: 1000,
  getEnergyFee: 210,
  getCreateAccountFee: 100_000,
  getCreateNewAccountFeeInSystemContract: 1_000_000,
  getMaxFeeLimit: 5_000_000_000,
  getCreateNewAccountBandwidthRate: 4,
  getMaxCreateAccountTxSize: 5000,
  getMemoFee: 1_000_000,
};

const tronNode = (account: { address: string; balance: number }) => {
  const broadcasts: string[] = [];
  const answer = (path: string, body: Record<string, unknown>): unknown => {
    switch (path) {
      case "/walletsolidity/getnowblock":
        return {
          blockID: SOLID_ID,
          block_header: { raw_data: { number: 100, timestamp: NOW - 600_000 } },
        };
      case "/wallet/getnowblock":
        return {
          blockID: "cd".repeat(32),
          block_header: { raw_data: { number: 105, timestamp: NOW - 590_000 } },
        };
      case "/wallet/getblockbynum":
      case "/walletsolidity/getblockbynum":
        return Number(body["num"]) === 100
          ? {
              blockID: SOLID_ID,
              block_header: { raw_data: { number: 100, timestamp: NOW - 600_000 } },
            }
          : {};
      case "/wallet/getchainparameters":
        return {
          chainParameter: Object.entries(PARAMS).map(([key, value]) => ({ key, value })),
        };
      case "/wallet/getaccount":
        return body["address"] === account.address ? account : {};
      case "/wallet/getaccountresource":
        return {
          freeNetLimit: 600,
          freeNetUsed: 0,
          NetLimit: 0,
          NetUsed: 0,
          EnergyLimit: 0,
          EnergyUsed: 0,
        };
      case "/wallet/triggerconstantcontract":
        return { result: { result: true }, energy_used: 0, energy_penalty: 0 };
      case "/wallet/broadcasthex":
        broadcasts.push(String(body["transaction"]));
        return { result: true, txid: "ee".repeat(32) };
      case "/wallet/gettransactionbyid":
      case "/wallet/gettransactioninfobyid":
      case "/walletsolidity/gettransactioninfobyid":
        return {};
      default:
        throw new Error(`unmocked ${path}`);
    }
  };
  return { broadcasts, answer };
};

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
  let counter = 0;
  const random = (n: number): Uint8Array => {
    counter += 1;
    return new Uint8Array(n).fill(counter % 251);
  };
  const tronAccount = await apis.account({
    walletId,
    groupIndex: 0,
    template: "tron.bip44",
    network: TRON_NET,
  });
  const tronAddr = "address" in tronAccount ? tronAccount.address : "";
  if (tronAddr === "") {
    throw new Error("no tron address for the group");
  }
  const node = tronNode({ address: tronAddr, balance: 100_000_000 });
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: async (input, init) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      if (url.startsWith("https://tron.example")) {
        const path = url.slice("https://tron.example".length);
        return Response.json(node.answer(path, body as Record<string, unknown>));
      }
      const id = typeof body === "object" && body !== null && "id" in body ? body.id : null;
      return Response.json({ jsonrpc: "2.0", id, result: "0x10" });
    },
    rpc: { [TRON_NET]: ["https://tron.example"] },
    openStore: memoryStore,
    logger,
  });
  const transactions = new TransactionController({
    wallet,
    networks,
    openStore: memoryStore,
    random,
    setTimer: () => () => undefined,
    now: () => NOW,
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
      prepareDappPsbts(apis, fakeEsplora, account, network, psbts, new Set<string>()),
    bitcoinSignPsbts: async (account, network, prepared, send, verify) => {
      const { signedPsbts, txids } = await signDappPsbts(
        apis,
        prepared,
        send,
        verify,
        () => undefined,
        async (p, r) => transactions.submitDappBitcoin(network, account.walletId, p, r),
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
    solanaSign: async () => {
      await Promise.resolve();
      throw new Error("solana is not wired in this test");
    },
    fetch: globalThis.fetch,
    random,
    now: () => NOW,
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
    onSelectedGroup: () => () => undefined,
    invalidateAll: () => {
      requests.invalidateAll();
    },
    evmAddress: async () => {
      const r = await Promise.resolve("0x0000000000000000000000000000000000000001");
      return r;
    },
    solanaAddress: async () => {
      const r = await Promise.resolve("SoLaNaUnused");
      return r;
    },
    tronAddress: async (_group, network) => {
      const account = await apis.account({
        walletId,
        groupIndex: 0,
        template: "tron.bip44",
        network,
      });
      return "address" in account ? account.address : "";
    },
    bitcoinAddress: async () => {
      const r = await Promise.resolve("bc1qunused");
      return r;
    },
    enabledNetworks: () => [TRON_NET],
    nostrPubkey: async () => {
      const r = await Promise.resolve(NOSTR_PUBKEY);
      return r;
    },
    invalidate: (origin) => requests.invalidateOrigin(origin),
  });
  await connections.init();
  const eip1193 = new Eip1193Handler({
    connections,
    requests,
    networks,
    defaultNetwork: () => "eip155:1",
    isTracked: () => false,
    delegationState: async () => {
      await Promise.resolve();
      return { supported: true, state: "none" };
    },
    batches: {
      record: async () => {
        await Promise.resolve();
      },
      get: () => undefined,
    },
    txById: () => undefined,
    showCallsStatus: () => undefined,
    now: () => 1000,
    random,
  });
  const nip07 = new Nip07Handler({ connections, requests, signerFor: () => walletSigner });
  const webln = new WeblnHandler({
    connections,
    requests,
    now: () => 1000,
    spark: {
      accountBalance: () => 42000,
      paymentStatus: async () => {
        await Promise.resolve();
        return { status: "succeeded", outcome: "succeeded", preimage: new Uint8Array(32).fill(1) };
      },
    },
    sparkNetwork: "regtest",
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
      return { address: "", publicKey: new Uint8Array(32) };
    },
    solanaNetwork: () => "solana:mainnet",
  });
  const bitcoin = new BitcoinWalletHandler({
    connections,
    requests,
    bitcoinAccount,
    bitcoinNetwork: () => "bitcoin:mainnet",
  });
  const tron = new TronWalletHandler({
    connections,
    requests,
    transactions,
    tronNetworks: () => [TRON_NET],
    tronNetwork: () => TRON_NET,
    isTracked: () => false,
  });
  return { connections, requests, eip1193, nip07, webln, solana, bitcoin, tron, node, tronAddr };
}

async function openTron(context: BrowserContext) {
  const rig = await engineRig();
  const page = await context.newPage();
  const bridge = createBrowserBridge({
    eip1193: rig.eip1193,
    nip07: rig.nip07,
    webln: rig.webln,
    solana: rig.solana,
    bitcoin: rig.bitcoin,
    tron: rig.tron,
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

const memoryStore = async () => {
  await Promise.resolve();
  return createMemoryEngineStore();
};

const pendingRequests = (rig: Awaited<ReturnType<typeof engineRig>>) =>
  Object.values(rig.requests.getState().requests).filter((r) => r.stage === "awaiting-approval");

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MOBILE = { userAgent: MOBILE_UA };
const DESKTOP = { userAgent: DESKTOP_UA };

const tronFor = async (): Promise<{ tw: TronWeb; server: Server }> => {
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
    });
    req.on("end", () => {
      if (
        req.method === "POST" &&
        (req.url === "/wallet/getblock" || req.url === "/walletsolidity/getblock")
      ) {
        res.end(
          JSON.stringify({
            blockID: SOLID_ID,
            block_header: { raw_data: { number: 100, timestamp: NOW - 10_000 } },
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/wallet/createtransaction") {
        const body = JSON.parse(data) as {
          to_address: string;
          owner_address: string;
          amount: number;
        };
        const raw_data = {
          ref_block_bytes: REF_BYTES,
          ref_block_hash: REF_HASH,
          expiration: NOW + 3_600_000,
          timestamp: NOW - 60_000,
          contract: [
            {
              parameter: {
                value: {
                  amount: body.amount,
                  owner_address: body.owner_address,
                  to_address: body.to_address,
                },
                type_url: "type.googleapis.com/protocol.TransferContract",
              },
              type: "TransferContract",
            },
          ],
        };
        const rawData = tronRawDataFromJson(raw_data, false);
        const raw_data_hex = [...rawData].map((b) => b.toString(16).padStart(2, "0")).join("");
        const txID = createHash("sha256").update(rawData).digest("hex");
        res.end(JSON.stringify({ raw_data, raw_data_hex, txID, visible: false }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  const tw = new TronWeb({ fullHost: `http://127.0.0.1:${port}` });
  return { tw, server };
};

const connect = async (
  page: Page,
  rig: Awaited<ReturnType<typeof engineRig>>,
  checkTimeout: number,
) => {
  const result = page.evaluate(`globalThis.tronConnect(${checkTimeout})`);
  await expect.poll(() => rig.connections.pending().length, { timeout: 10_000 }).toBe(1);
  const [pending] = rig.connections.pending();
  await rig.connections.approveConnection(pending?.id ?? "", {
    accounts: [],
    network: TRON_NET,
  });
  return (await result) as { address: string };
};

const signAndApprove = async <T>(
  page: Page,
  rig: Awaited<ReturnType<typeof engineRig>>,
  evaluate: string,
): Promise<T> => {
  const call = page.evaluate<T>(evaluate);
  await expect.poll(() => pendingRequests(rig).length, { timeout: 10_000 }).toBeGreaterThan(0);
  const [sign] = pendingRequests(rig);
  await rig.requests.approve(sign?.id ?? "", "tron-sign", approval(sign, VERIFY));
  return call;
};

test.describe("tron injected provider (official TronLink adapter)", () => {
  for (const [name, ctxOptions, checkTimeout] of [
    ["mobile UA", MOBILE, 0],
    ["desktop UA + TIP-6963 fallback", DESKTOP, 1000],
  ] as const) {
    test(`${name}: adapter connect → sign → send`, async ({ browser }) => {
      const context = await browser.newContext(ctxOptions);
      const { page, rig } = await openTron(context);

      // The TIP-6963 announcement fires at install and on every requestProvider.
      const announced = await page.evaluate<{
        name: string;
        isTron: boolean;
        hasRequest: boolean;
      }>(
        `new Promise((resolve) => {
          globalThis.addEventListener("TIP6963:announceProvider", (e) =>
            resolve({
              name: e.detail.info.name,
              uuid: e.detail.info.uuid,
              isTron: e.detail.provider === globalThis.tron,
              hasRequest: typeof e.detail.provider.request === "function",
            }),
          );
          globalThis.dispatchEvent(new CustomEvent("TIP6963:requestProvider"));
        })`,
      );
      expect(announced.name).toBe(INFO.name);
      expect(announced.isTron).toBe(true);
      expect(announced.hasRequest).toBe(true);

      // The provider is disconnected until tron_requestAccounts is granted.
      const before = await page.evaluate<{ defaultAddress: { base58: unknown; hex: unknown } }>(
        `globalThis.tronProbe()`,
      );
      expect(before.defaultAddress).toStrictEqual({ base58: false, hex: false });

      const connected = await connect(page, rig, checkTimeout);
      expect(connected.address).toBe(rig.tronAddr);
      const probe = await page.evaluate<{
        defaultAddress: { base58: string; hex: string };
        viaTron: boolean;
        typeofSign: string;
        typeofSignMessageV2: string;
        typeofMultiSign: string;
        typeofSendRaw: string;
        typeofGetBlock: string;
        thenUndef: boolean;
        toJsonUndef: boolean;
        isFlagUndef: boolean;
      }>(`globalThis.tronProbe()`);
      expect(probe.defaultAddress).toStrictEqual({
        base58: rig.tronAddr,
        hex: tronAddressToHex(rig.tronAddr).toLowerCase(),
      });
      expect(probe.viaTron).toBe(true);
      // Implemented members are real functions — the 4200 stub never shadows them.
      expect(probe.typeofSign).toBe("function");
      expect(probe.typeofSignMessageV2).toBe("function");
      expect(probe.typeofMultiSign).toBe("function");
      expect(probe.typeofSendRaw).toBe("function");
      expect(probe.typeofGetBlock).toBe("function");
      // Stub rules: never thenable, never serializable, `is*` flags stay undefined.
      expect(probe.thenUndef).toBe(true);
      expect(probe.toJsonUndef).toBe(true);
      expect(probe.isFlagUndef).toBe(true);
      const genesis = await page.evaluate<{ blockID: string }>(`globalThis.tronGenesis()`);
      expect(genesis.blockID).toBe(
        "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc",
      );

      const { tw, server } = await tronFor();
      try {
        const tx = (await tw.transactionBuilder.sendTrx(
          "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs",
          1_000_000,
          rig.tronAddr,
        )) as {
          raw_data: Record<string, unknown>;
          raw_data_hex: string;
          txID: string;
          visible: boolean;
        };
        expect(tx.txID).toBe(
          createHash("sha256").update(Buffer.from(tx.raw_data_hex, "hex")).digest("hex"),
        );

        // tronWeb.trx.sign → tron-sign → approve → signature over the exact raw bytes
        const signCall = signAndApprove<{ signature: string[] }>(
          page,
          rig,
          `globalThis.tronSignTransaction(${JSON.stringify({ raw_data: tx.raw_data, raw_data_hex: tx.raw_data_hex, txID: tx.txID, visible: tx.visible })})`,
        );
        const signed = await signCall;
        expect(signed.signature).toHaveLength(1);
        const sigBytes = Buffer.from(signed.signature[0] ?? "", "hex");
        expect(sigBytes).toHaveLength(65);
        const rawData = new Uint8Array(Buffer.from(tx.raw_data_hex, "hex"));
        expect(
          verifyTronTransactionSignature(rawData, new Uint8Array(sigBytes), rig.tronAddr),
        ).toBe(true);

        // signMessage → tron_signMessageV2 → verify with tronweb
        const message = "hello qntx tron";
        const msgSig = await signAndApprove<string>(
          page,
          rig,
          `globalThis.tronSignMessage(${JSON.stringify(message)})`,
        );
        const verifiedMsg = await tw.trx.verifyMessageV2(message, msgSig);
        expect(verifiedMsg).toBe(rig.tronAddr);

        // signTypedData (SUN Permit2 PermitSingle) → tron_signTypedData → verifyTypedData
        const typed = {
          domain: {
            name: "Permit2",
            chainId: "0x2b6653dc",
            verifyingContract: "TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9",
          },
          types: {
            PermitSingle: [
              { name: "details", type: "PermitDetails" },
              { name: "spender", type: "address" },
              { name: "sigDeadline", type: "uint256" },
            ],
            PermitDetails: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint160" },
              { name: "expiration", type: "uint48" },
              { name: "nonce", type: "uint48" },
            ],
          },
          message: {
            details: {
              token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
              amount: "16000000",
              expiration: "999999999",
              nonce: "0",
            },
            spender: "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs",
            sigDeadline: "999999999",
          },
        };
        const typedSig = await signAndApprove<string>(
          page,
          rig,
          `globalThis.tronSignTypedData(${JSON.stringify(typed)})`,
        );
        expect(typedSig.startsWith("0x")).toBe(true);
        // verifyTypedData throws on mismatch and returns true on success.
        const verifiedTyped = tw.trx.verifyTypedData(
          typed.domain,
          typed.types,
          typed.message,
          typedSig,
          rig.tronAddr,
        );
        expect(verifiedTyped).toBe(true);

        // trx.sendRawTransaction broadcasts the wallet-signed transaction
        const sendResult = await page.evaluate<{ result: boolean }>(
          `globalThis.tronSendRaw(${JSON.stringify({ ...tx, signature: [signed.signature[0]] })})`,
        );
        expect(sendResult.result).toBe(true);
        expect(rig.node.broadcasts).toHaveLength(1);
      } finally {
        server.close();
        await context.close();
      }
    });
  }
});

test("the minimal surface refuses unimplemented members with 4200", async ({ browser }) => {
  const context = await browser.newContext(DESKTOP);
  const { page } = await openTron(context);
  const refusals = await page.evaluate<{
    signHex: { code: number; message: string };
    multiSign: { code: number; message: string };
    sendTrx: { code: number; message: string };
    signMessage: { code: number; message: string };
    nonZeroBlock: { code: number; message: string };
    deep: { code: number; message: string };
  }>(`globalThis.tronRefusals()`);
  expect(refusals.signHex?.code).toBe(4200);
  expect(refusals.multiSign?.code).toBe(4200);
  expect(refusals.sendTrx?.code).toBe(4200);
  expect(refusals.signMessage?.code).toBe(4200);
  expect(refusals.nonZeroBlock?.code).toBe(4200);
  expect(refusals.deep?.code).toBe(4200);
  await context.close();
});
