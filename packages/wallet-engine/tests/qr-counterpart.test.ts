import { CborMap, encodeCbor, taggedValue } from "@blockchaincommons/dcbor";
// oxlint-disable vitest/no-conditional-in-test -- frame assertions narrow prepared/result kinds
/**
 * The Web wallet as the QR counterpart, end to end in Node: the phone is the real node wallet
 * behind `qrSigner`; the "web" side is a `WatchController` plus the mirror functions — no Wallet at
 * all. Every hop goes through UR frames: export → readQrExport → watch.add → qrSignRequest →
 * readQrRequest → prepare → approve → respond → readQrSignature. Independent oracles (viem,
 *
 * @noble, btc-signer/wallet-chains) verify each result against the link's address or xpub.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { NETWORK, p2tr, p2wpkh, Transaction } from "@scure/btc-signer";
import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  address as solanaAddressOf,
} from "@solana/kit";
import { recoverTransactionAddress, verifyMessage, verifyTypedData } from "viem";
import type { TransactionSerialized } from "viem";
import { describe, expect, it } from "vite-plus/test";

import {
  INTEROP_TAGS,
  cryptoMultiAccountsCodec,
  ethSignRequestCodec,
  ethSignatureCodec,
} from "@qntx/ur/interop";
import { cryptoPsbtCodec } from "@qntx/ur/registry";
import { Ur, fromUr, toUr } from "@qntx/ur/typed";
import type { Wallet } from "@qntx/wallet";
import type { EvmTransaction } from "@qntx/wallet-chains";
import {
  bitcoinPubkeyFromXpub,
  normalizeBitcoin,
  verifyBitcoinPsbtSignatures,
} from "@qntx/wallet-chains/bitcoin";
import { normalizeEvm } from "@qntx/wallet-chains/evm";
import { parseCompiledMessage } from "@qntx/wallet-chains/solana";
import {
  normalizeTron,
  tronAddressFromPublicKey,
  tronAddressToHex,
  tronMessageDigest,
  tronRawDataFromJson,
} from "@qntx/wallet-chains/tron";
import { chains } from "@qntx/wallet/chains";
import { qrParts as qrFrames } from "@qntx/wallet/hardware";
import type { QrPayload } from "@qntx/wallet/hardware";
import type { ChainSignRequest, ChainSignResult } from "@qntx/wallet/protocol";

import { WatchController } from "../src/accounts/watch.ts";
import { signingApis } from "../src/chains/signing.ts";
import type { WalletEngine } from "../src/engine.ts";
import {
  createQrScanner,
  qrSigner,
  readQrExport,
  qrSignRequest,
  readQrRequest,
  readQrSignature,
} from "../src/qr/index.ts";
import type { QrLink, QrSentRequest } from "../src/qr/index.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SolanaSignResult } from "../src/requests/controller.ts";
import type { BitcoinPsbtInput, PreparedBitcoinPsbt } from "../src/requests/types.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type {
  AccountRef,
  SendParams,
  PreparedMessage,
  PreparedQrSign,
  PreparedRequest,
} from "../src/transactions/route.ts";
import { approval } from "./approval.ts";
import { VERIFY, nodeWallet } from "./apps-helpers.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const H = 0x80000000;
const EVM_MAINNET = "eip155:1";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON_MAINNET = "tron:728126428";
const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93";

const ENABLED: Record<string, ReadonlyArray<string>> = {
  evm: [EVM_MAINNET],
  solana: [SOLANA_MAINNET],
  tron: [TRON_MAINNET],
  bitcoin: [BITCOIN_MAINNET],
};

type Facts = {
  readonly walletId: string;
  readonly fingerprint: number;
  readonly evm: string;
  readonly tron: string;
  readonly solana: string;
  readonly btc84: string;
  readonly btc86: string;
};

/** The phone account's authenticated facts — the master fingerprint plus per-family material. */
const factsOf = async (wallet: Wallet, walletId: string): Promise<Facts> => {
  const apis = chains(wallet);
  const [evm, tron, solana, b84, b86] = await Promise.all([
    apis.account({ walletId, groupIndex: 0, template: "evm.bip44", network: EVM_MAINNET }),
    apis.account({ walletId, groupIndex: 0, template: "tron.bip44", network: TRON_MAINNET }),
    apis.account({
      walletId,
      groupIndex: 0,
      template: "solana.bip44-change",
      network: SOLANA_MAINNET,
    }),
    apis.account({ walletId, groupIndex: 0, template: "btc.bip84", network: BITCOIN_MAINNET }),
    apis.account({ walletId, groupIndex: 0, template: "btc.bip86", network: BITCOIN_MAINNET }),
  ]);
  if (!("address" in evm) || !("address" in tron) || !("address" in solana)) {
    throw new Error("expected address accounts");
  }
  if (!("xpub" in b84) || !("xpub" in b86) || !("fingerprint" in b84)) {
    throw new Error("expected bitcoin accounts");
  }
  return {
    walletId,
    fingerprint: Number.parseInt(b84.fingerprint, 16),
    evm: evm.address,
    tron: tron.address,
    solana: solana.address,
    btc84: b84.xpub,
    btc86: b86.xpub,
  };
};

const isSparkController = (_value: unknown): _value is SparkController => true;

const noSpark = ((): SparkController => {
  const stub: unknown = {};
  if (isSparkController(stub)) {
    return stub;
  }
  throw new Error("unreachable");
})();

type World = {
  readonly wallet: Wallet;
  readonly requests: RequestController;
  readonly signer: ReturnType<typeof qrSigner>;
};

/** A compiled Solana transaction whose only required signer is `payer`. */
const solanaMessage = (payer: string): Uint8Array =>
  new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(base58.encode(new Uint8Array(32).fill(9))),
            lastValidBlockHeight: 0n,
          },
          setTransactionMessageFeePayer(
            solanaAddressOf(payer),
            appendTransactionMessageInstructions(
              [
                {
                  programAddress: solanaAddressOf("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
                  accounts: [],
                  data: new Uint8Array([1, 2, 3]),
                },
              ],
              createTransactionMessage({ version: "legacy" }),
            ),
          ),
        ),
      ),
    ),
  );

/** A minimal TRX transfer raw_data the link's address owns. */
const tronRawData = (owner: string): Uint8Array =>
  tronRawDataFromJson(
    {
      ref_block_bytes: "cf38",
      ref_block_hash: "d69e580730dcecac",
      expiration: 4_200_000_000_000,
      timestamp: 1_040_000,
      contract: [
        {
          parameter: {
            value: {
              amount: 1_000_000,
              owner_address: tronAddressToHex(owner),
              to_address: tronAddressToHex(owner),
            },
            type_url: "type.googleapis.com/protocol.TransferContract",
          },
          type: "TransferContract",
        },
      ],
    },
    false,
  );

const TYPED_DATA = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "string" },
    ],
  },
  primaryType: "Mail" as const,
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" as `0x${string}`,
  },
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
} as const;

const LEGACY_TX: EvmTransaction = {
  type: "legacy",
  chainId: 1,
  nonce: 0,
  gas: "0x5208",
  to: "0x00000000000000000000000000000000deadbeef",
  value: "0x1",
  data: "0x",
  gasPrice: "0x3b9aca00",
};

const EIP1559_TX: EvmTransaction = {
  type: "eip1559",
  chainId: 1,
  nonce: 0,
  gas: "0x5208",
  to: "0x00000000000000000000000000000000deadbeef",
  value: "0x1",
  data: "0x",
  accessList: [],
  maxFeePerGas: "0x3b9aca00",
  maxPriorityFeePerGas: "0x3b9aca00",
};

/**
 * The phone's QR world: `qrSigner` over a real `RequestController` whose chain options submit
 * through `signingApis` — the vault kernel signs every request exactly as the engine would.
 */
const world = async (): Promise<World> => {
  const { wallet } = await nodeWallet();
  await wallet.vault.unlock(VERIFY).catch(() => undefined);
  const signing = signingApis(wallet, undefined);
  const signedTransaction = (
    request: ChainSignRequest,
    result: ChainSignResult,
  ): { kind: "evm.signed-transaction"; signedTransaction: Uint8Array } => {
    if (request.kind !== "evm.transaction" || result.kind !== "evm.transaction") {
      throw new Error("expected an evm transaction result");
    }
    return { kind: "evm.signed-transaction", signedTransaction: result.signedTransaction };
  };
  const intent = <F extends "evm" | "tron">(family: F, network: string) => ({
    family,
    network,
    summary: "contract-call" as const,
    outflows: [],
    approvals: [],
    fee: undefined,
    warnings: [],
    verifiability: "full" as const,
  });
  const preparedBase = <F extends "evm" | "tron">(request: ChainSignRequest, family: F) => ({
    account: request.account as AccountRef,
    network: request.network,
    intent: intent(family, request.network),
    signer: "",
    checks: [],
    staleReason: () => undefined,
    release: () => undefined,
  });
  const transactions = {
    getState: () => ({ txs: {} }),
    bindDappSolana: async () => {
      await Promise.resolve();
      return [];
    },
    // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
    prepareQrEvm: async (_a: never, request: ChainSignRequest): Promise<PreparedQrSign> => {
      if (request.kind !== "evm.transaction") {
        throw new Error("expected an evm transaction");
      }
      return {
        ...preparedBase(request, "evm"),
        submit: async (verify, commit) => {
          const result = await signing.sign({
            request: normalizeEvm(request) as ChainSignRequest,
            verify,
          });
          commit();
          return signedTransaction(request, result);
        },
      };
    },
    // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
    prepareDapp: async (_a: never, request: ChainSignRequest): Promise<PreparedMessage> => {
      if (
        request.kind !== "evm.personal-message" &&
        request.kind !== "evm.typed-data" &&
        request.kind !== "tron.message"
      ) {
        throw new Error(`unexpected dapp request ${request.kind}`);
      }
      return {
        ...preparedBase(request, request.kind.startsWith("evm") ? "evm" : "tron"),
        submit: async (verify) => {
          const result = await signing.sign({ request, verify });
          if (!("signature" in result) || !(result.signature instanceof Uint8Array)) {
            throw new Error("expected a signature result");
          }
          return { kind: request.kind, signature: result.signature };
        },
      };
    },
    prepareDappTron: async (
      _a: never,
      request: ChainSignRequest,
      options?: { broadcast: false },
      // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
    ): Promise<PreparedRequest | PreparedMessage | PreparedQrSign> => {
      if (request.kind === "tron.message") {
        return {
          ...preparedBase(request, "tron"),
          submit: async (verify: SendParams["verify"]) => {
            const result = await signing.sign({ request, verify });
            if (result.kind !== "tron.message") {
              throw new Error("expected a tron message result");
            }
            return { kind: "tron.message" as const, signature: result.signature };
          },
        };
      }
      if (request.kind !== "tron.transaction" || options?.broadcast !== false) {
        throw new Error("a dApp tron request is not wired in this test");
      }
      return {
        ...preparedBase(request, "tron"),
        submit: async (verify, commit) => {
          const result = await signing.sign({
            request: normalizeTron(request) as ChainSignRequest,
            verify,
          });
          if (result.kind !== "tron.transaction") {
            throw new Error("expected a tron transaction result");
          }
          commit();
          return { kind: "tron.signed-transaction" as const, signature: result.signature };
        },
      };
    },
  } as unknown as TransactionController;
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: noSpark,
    nostrSign: async (): Promise<never> => {
      await Promise.resolve();
      throw new Error("nostr-sign is not wired in this test");
    },
    bitcoinPrepare: async (
      _account,
      network,
      psbts: ReadonlyArray<BitcoinPsbtInput>,
    ): Promise<ReadonlyArray<PreparedBitcoinPsbt>> =>
      Promise.resolve(
        psbts.map((input) => ({
          request: {
            kind: "bitcoin.psbt" as const,
            network,
            account: {
              kind: "hd" as const,
              walletId: _account.walletId,
              groupIndex: _account.groupIndex,
            },
            psbt: input.psbt,
            sign: input.sign.map(({ index, template }) => ({ index, template })),
          },
          ownScripts: new Set<string>(),
          inputs: [],
        })),
      ),
    bitcoinSignPsbts: async (_account, _network, prepared, _send, verify, commit) => {
      const signedPsbts: Uint8Array[] = [];
      for (const { request } of prepared) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- signing is sequential
        const result = await signing.sign({
          request: normalizeBitcoin(request) as ChainSignRequest,
          verify,
        });
        if (result.kind !== "bitcoin.psbt") {
          throw new Error("expected a psbt result");
        }
        signedPsbts.push(result.signedPsbt);
      }
      commit();
      return { kind: "bitcoin.psbts" as const, signedPsbts, txids: [] };
    },
    bitcoinSign: async () => {
      await Promise.resolve();
      throw new Error("bitcoin message signing is not wired in this test");
    },
    solanaSign: async (account, network, request, verify, commit): Promise<SolanaSignResult> => {
      const hdAccount = {
        kind: "hd" as const,
        walletId: account.walletId,
        groupIndex: account.groupIndex,
        template: "solana.bip44-change" as const,
      };
      if (request.kind === "transactions") {
        const signedTransactions: Uint8Array[] = [];
        for (const wire of request.transactions) {
          const [count] = wire;
          if (count === undefined) {
            throw new Error("no signature count");
          }
          const message = wire.subarray(1 + 64 * count);
          const parsed = parseCompiledMessage(message);
          const index = parsed.staticAccounts.slice(0, count).indexOf(account.address);
          if (index === -1) {
            throw new Error("the account is not a required signer");
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- each signature must precede the next transaction
          const result = await signing.sign({
            request: { kind: "solana.transaction", network, account: hdAccount, message },
            verify,
          });
          if (result.kind !== "solana.transaction") {
            throw new Error("expected a solana transaction result");
          }
          const signed = new Uint8Array(wire);
          signed.set(result.signature, 1 + 64 * index);
          signedTransactions.push(signed);
        }
        commit();
        return { kind: "solana.transactions", send: false, signedTransactions };
      }
      const result = await signing.sign({
        request: {
          kind: "solana.message",
          format: "raw",
          network,
          account: hdAccount,
          message: request.message,
        },
        verify,
      });
      if (result.kind !== "solana.message") {
        throw new Error("expected a solana message result");
      }
      commit();
      return { kind: "solana.message", signature: result.signature };
    },
    fetch: globalThis.fetch,
    logger: { warn: () => undefined },
    ...idleNetworkDeps,
  });
  await requests.init();
  const engine = {
    requests,
    networks: { enabled: (family: string) => ENABLED[family] ?? [] },
  } as unknown as WalletEngine;
  return { wallet, requests, signer: qrSigner({ engine, wallet }) };
};

/* `approve` is typed per method literal; the pipeline itself routes on the same union value. */
const approvePending = async (
  requests: RequestController,
  pending: {
    readonly id: string;
    readonly method: string;
    readonly risk: unknown;
    readonly checks: unknown;
  },
): Promise<unknown> =>
  requests.approve(
    pending.id,
    pending.method as Parameters<RequestController["approve"]>[1] as never,
    approval(pending as Parameters<typeof approval>[0], VERIFY),
  );

/** Feed a payload's frames into a fresh scanner until it completes. */
const scanPayload = (payload: QrPayload, kind: "request" | "export" | "response"): QrPayload => {
  const scanner = createQrScanner({ kind, now: () => Date.now() });
  const nextFrame = qrFrames(payload);
  for (let i = 0; i < 256; i += 1) {
    const outcome = scanner.receive(nextFrame());
    if (outcome.status === "complete") {
      return outcome.payload;
    }
  }
  throw new Error("scanner never completed");
};

const webRandom = (n: number): Uint8Array => new Uint8Array(n).fill(0x5a);

type Backing = { readonly collections: Map<string, Map<string, Uint8Array>> };

const webWatch = async (): Promise<{
  readonly watch: WatchController;
  readonly backing: Backing;
}> => {
  const backing: Backing = { collections: new Map() };
  const watch = new WatchController({
    random: webRandom,
    now: () => 1_700_000_000_000,
    logger: { warn: () => undefined },
    ownAddresses: async () => {
      await Promise.resolve();
      return [];
    },
  });
  watch.setStore(createMemoryEngineStore(backing));
  await watch.init();
  return { watch, backing };
};

/** The phone's export of one bitcoin template plus the three leaf families, as scanned frames. */
const phoneExport = async (
  w: World,
  account: { readonly walletId: string; readonly groupIndex: number },
  template: "btc.bip84" | "btc.bip86",
): Promise<ReadonlyArray<QrLink>> => {
  const exported = await w.signer.exportAccount({
    account,
    form: "crypto-multi-accounts",
    families: ["evm", "tron", "solana"],
    bitcoin: { template, network: BITCOIN_MAINNET },
    verify: VERIFY,
  });
  return readQrExport(scanPayload(exported.payload, "export"));
};

/** One full signing round-trip: web encodes, frames cross, phone prepares/approves/responds. */
const roundTrip = async (
  w: World,
  sent: QrSentRequest,
  account: { readonly walletId: string; readonly groupIndex: number },
): Promise<QrPayload> => {
  const scanned = scanPayload(sent.payload, "request");
  const request = readQrRequest(scanned);
  const pending = await w.signer.prepare(request, account);
  await approvePending(w.requests, pending);
  const payload = await w.signer.respond(pending.id);
  return scanPayload(payload, "response");
};

const linkFor = (links: ReadonlyArray<QrLink>, family: QrLink["family"]): QrLink => {
  const link = links.find((l) => l.family === family);
  if (link === undefined) {
    throw new Error(`no ${family} link`);
  }
  return link;
};

const RANDOM = { random: webRandom };

describe("qr counterpart — phone ↔ watch-only web through frames", () => {
  it(
    "the export yields one link per family and each lands as a qr watch account",
    {
      timeout: 60_000,
    },
    async () => {
      const { wallet, walletId } = await nodeWallet();
      const facts = await factsOf(wallet, walletId);
      const w = await world();
      const { watch } = await webWatch();
      const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip84");
      expect(links.map((l) => l.family).toSorted()).toStrictEqual([
        "bitcoin",
        "evm",
        "solana",
        "tron",
      ]);
      const watched = await Promise.all(
        links.map(async (link) =>
          watch.add({
            family: link.family,
            address: link.address,
            qr: {
              fingerprint: link.fingerprint,
              path: link.path,
              ...(link.xpub === undefined ? {} : { xpub: link.xpub }),
            },
          }),
        ),
      );
      for (const [i, link] of links.entries()) {
        expect(link.fingerprint).toBe(facts.fingerprint.toString(16).padStart(8, "0"));
        expect(watched[i]?.qr?.path).toBe(link.path);
      }
      const evm = linkFor(links, "evm");
      expect(evm.address.toLowerCase()).toBe(facts.evm.toLowerCase());
      expect(linkFor(links, "tron").address).toBe(facts.tron);
      expect(linkFor(links, "solana").address).toBe(facts.solana);
      const btc = linkFor(links, "bitcoin");
      expect(btc.path).toBe("m/84'/0'/0'");
      expect(btc.xpub).toBe(facts.btc84);
    },
  );

  it(
    "an evm legacy transaction signs end to end and recovers to the link",
    {
      timeout: 60_000,
    },
    async () => {
      const { walletId } = await nodeWallet();
      const w = await world();
      const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip84");
      const link = linkFor(links, "evm");
      const sent = qrSignRequest(
        link,
        { family: "evm", kind: "transaction", tx: LEGACY_TX },
        RANDOM,
      );
      const payload = await roundTrip(w, sent, { walletId, groupIndex: 0 });
      const sig = readQrSignature(sent, payload);
      if (sig.kind !== "evm.transaction") {
        throw new Error("expected a signed transaction");
      }
      const sender = await recoverTransactionAddress({
        serializedTransaction:
          `0x${Buffer.from(sig.signedTransaction).toString("hex")}` as TransactionSerialized,
      });
      expect(sender.toLowerCase()).toBe(link.address.toLowerCase());
    },
  );

  it(
    "an evm eip1559 transaction signs end to end and recovers to the link",
    {
      timeout: 60_000,
    },
    async () => {
      const { walletId } = await nodeWallet();
      const w = await world();
      const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip84");
      const link = linkFor(links, "evm");
      const sent = qrSignRequest(
        link,
        { family: "evm", kind: "transaction", tx: EIP1559_TX },
        RANDOM,
      );
      const payload = await roundTrip(w, sent, { walletId, groupIndex: 0 });
      const sig = readQrSignature(sent, payload);
      if (sig.kind !== "evm.transaction") {
        throw new Error("expected a signed transaction");
      }
      const sender = await recoverTransactionAddress({
        serializedTransaction:
          `0x${Buffer.from(sig.signedTransaction).toString("hex")}` as TransactionSerialized,
      });
      expect(sender.toLowerCase()).toBe(link.address.toLowerCase());
    },
  );

  it("eip-712 typed data signs end to end and verifies", { timeout: 60_000 }, async () => {
    const { walletId } = await nodeWallet();
    const w = await world();
    const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip84");
    const link = linkFor(links, "evm");
    const sent = qrSignRequest(
      link,
      {
        family: "evm",
        kind: "typed-data",
        typedData: JSON.stringify(TYPED_DATA),
        chainId: 1,
      },
      RANDOM,
    );
    const payload = await roundTrip(w, sent, { walletId, groupIndex: 0 });
    const sig = readQrSignature(sent, payload);
    if (sig.kind !== "evm.signature") {
      throw new Error("expected an evm signature");
    }
    await expect(
      verifyTypedData({
        address: link.address as `0x${string}`,
        domain: { ...TYPED_DATA.domain, chainId: BigInt(TYPED_DATA.domain.chainId) },
        types: TYPED_DATA.types,
        primaryType: TYPED_DATA.primaryType,
        message: TYPED_DATA.message,
        signature: `0x${Buffer.from(sig.signature).toString("hex")}`,
      }),
    ).resolves.toBe(true);
  });

  it("a personal message signs end to end and verifies", { timeout: 60_000 }, async () => {
    const { walletId } = await nodeWallet();
    const w = await world();
    const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip84");
    const link = linkFor(links, "evm");
    const message = new TextEncoder().encode("sign me");
    const sent = qrSignRequest(link, { family: "evm", kind: "personal-message", message }, RANDOM);
    const payload = await roundTrip(w, sent, { walletId, groupIndex: 0 });
    const sig = readQrSignature(sent, payload);
    if (sig.kind !== "evm.signature") {
      throw new Error("expected an evm signature");
    }
    await expect(
      verifyMessage({
        address: link.address as `0x${string}`,
        message: "sign me",
        signature: `0x${Buffer.from(sig.signature).toString("hex")}`,
      }),
    ).resolves.toBe(true);
  });

  it(
    "a solana transaction signs end to end under the link's ed25519 key",
    {
      timeout: 60_000,
    },
    async () => {
      const { walletId } = await nodeWallet();
      const w = await world();
      const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip84");
      const link = linkFor(links, "solana");
      const data = solanaMessage(link.address);
      const sent = qrSignRequest(link, { family: "solana", kind: "transaction", data }, RANDOM);
      const payload = await roundTrip(w, sent, { walletId, groupIndex: 0 });
      const sig = readQrSignature(sent, payload);
      if (sig.kind !== "solana.signature") {
        throw new Error("expected a solana signature");
      }
      expect(sig.signature).toHaveLength(64);
      expect(ed25519.verify(sig.signature, data, base58.decode(link.address))).toBe(true);
    },
  );

  it(
    "a tron transaction signs end to end and recovers to the link",
    {
      timeout: 60_000,
    },
    async () => {
      const { walletId } = await nodeWallet();
      const w = await world();
      const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip84");
      const link = linkFor(links, "tron");
      const data = tronRawData(link.address);
      const sent = qrSignRequest(link, { family: "tron", kind: "transaction", data }, RANDOM);
      const payload = await roundTrip(w, sent, { walletId, groupIndex: 0 });
      const sig = readQrSignature(sent, payload);
      if (sig.kind !== "tron.signature") {
        throw new Error("expected a tron signature");
      }
      /* The wire's v is the recovery id — recover the sha256(rawData) signer independently. */
      const [v] = sig.signature.subarray(64);
      const compact = secp256k1.Signature.fromBytes(sig.signature.subarray(0, 64));
      const publicKey = secp256k1.Signature.fromBytes(compact.toBytes())
        .addRecoveryBit(v ?? 0)
        .recoverPublicKey(sha256(data));
      expect(tronAddressFromPublicKey(publicKey.toBytes(true))).toBe(link.address);
    },
  );

  it("a tron message signs end to end and recovers to the link", { timeout: 60_000 }, async () => {
    const { walletId } = await nodeWallet();
    const w = await world();
    const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip84");
    const link = linkFor(links, "tron");
    const data = new TextEncoder().encode("hello tron");
    const sent = qrSignRequest(link, { family: "tron", kind: "message", data }, RANDOM);
    const payload = await roundTrip(w, sent, { walletId, groupIndex: 0 });
    const sig = readQrSignature(sent, payload);
    if (sig.kind !== "tron.signature") {
      throw new Error("expected a tron signature");
    }
    const [v] = sig.signature.subarray(64);
    const compact = secp256k1.Signature.fromBytes(sig.signature.subarray(0, 64));
    const publicKey = secp256k1.Signature.fromBytes(compact.toBytes())
      .addRecoveryBit((v ?? 0) - 27)
      .recoverPublicKey(tronMessageDigest(data));
    expect(tronAddressFromPublicKey(publicKey.toBytes(true))).toBe(link.address);
  });

  it("a p2wpkh psbt signs end to end against the account xpub", { timeout: 60_000 }, async () => {
    const { wallet, walletId } = await nodeWallet();
    const facts = await factsOf(wallet, walletId);
    const w = await world();
    const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip84");
    const link = linkFor(links, "bitcoin");
    const pubkey = bitcoinPubkeyFromXpub(link.xpub ?? "", "btc.bip84", BITCOIN_MAINNET, 0, 0);
    const { script } = p2wpkh(pubkey, NETWORK);
    const funding = new Transaction({ version: 2 });
    funding.addInput({ txid: new Uint8Array(32).fill(7), index: 1 });
    funding.addOutput({ script, amount: 100_000n });
    const tx = new Transaction({ version: 2 });
    tx.addInput({
      txid: funding.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script, amount: 100_000n },
      nonWitnessUtxo: funding.toBytes(true),
      bip32Derivation: [[pubkey, { fingerprint: facts.fingerprint, path: [84 + H, H, H, 0, 0] }]],
    });
    tx.addOutput({ script: p2wpkh(pubkey, NETWORK).script, amount: 90_000n });
    const sent = qrSignRequest(
      link,
      { family: "bitcoin", kind: "psbt", psbt: tx.toPSBT(0) },
      RANDOM,
    );
    const payload = await roundTrip(w, sent, { walletId, groupIndex: 0 });
    const sig = readQrSignature(sent, payload);
    if (sig.kind !== "bitcoin.psbt") {
      throw new Error("expected a signed psbt");
    }
    expect(
      verifyBitcoinPsbtSignatures(sig.psbt, [0], link.xpub ?? "", "btc.bip84", BITCOIN_MAINNET),
    ).toBe(true);
    const finalized = Transaction.fromPSBT(sig.psbt);
    finalized.finalize();
    expect(finalized.getInput(0).finalScriptWitness?.length).toBe(2);
  });

  it(
    "a taproot key-path psbt signs end to end against the bip86 xpub",
    {
      timeout: 60_000,
    },
    async () => {
      const { wallet, walletId } = await nodeWallet();
      const facts = await factsOf(wallet, walletId);
      const w = await world();
      const links = await phoneExport(w, { walletId, groupIndex: 0 }, "btc.bip86");
      const link = linkFor(links, "bitcoin");
      expect(link.path).toBe("m/86'/0'/0'");
      const pubkey = bitcoinPubkeyFromXpub(link.xpub ?? "", "btc.bip86", BITCOIN_MAINNET, 0, 0);
      const { script } = p2tr(pubkey, undefined, NETWORK);
      const funding = new Transaction({ version: 2 });
      funding.addInput({ txid: new Uint8Array(32).fill(7), index: 1 });
      funding.addOutput({ script, amount: 100_000n });
      const tx = new Transaction({ version: 2 });
      tx.addInput({
        txid: funding.id,
        index: 0,
        witnessUtxo: { script, amount: 100_000n },
        nonWitnessUtxo: funding.toBytes(true),
        tapInternalKey: pubkey,
        tapBip32Derivation: [
          [
            pubkey,
            { hashes: [], der: { fingerprint: facts.fingerprint, path: [86 + H, H, H, 0, 0] } },
          ],
        ],
      });
      tx.addOutput({ script: p2tr(pubkey, undefined, NETWORK).script, amount: 90_000n });
      const sent = qrSignRequest(
        link,
        { family: "bitcoin", kind: "psbt", psbt: tx.toPSBT(0) },
        RANDOM,
      );
      const payload = await roundTrip(w, sent, { walletId, groupIndex: 0 });
      const sig = readQrSignature(sent, payload);
      if (sig.kind !== "bitcoin.psbt") {
        throw new Error("expected a signed psbt");
      }
      expect(
        verifyBitcoinPsbtSignatures(sig.psbt, [0], link.xpub ?? "", "btc.bip86", BITCOIN_MAINNET),
      ).toBe(true);
      const finalized = Transaction.fromPSBT(sig.psbt);
      finalized.finalize();
      expect(finalized.getInput(0).finalScriptWitness?.length).toBe(1);
    },
  );
});

/* --- hostile exports ------------------------------------------------------- */

const mfp = 0x73c5da0a;

const keypathOf = (
  path: string,
  fp: number,
): {
  readonly components: ReadonlyArray<{ kind: "index"; index: number; hardened: boolean }>;
  readonly sourceFingerprint: number;
  readonly depth: number;
} => ({
  components: path
    .slice(2)
    .split("/")
    .map((step) => {
      const hardened = step.endsWith("'");
      return {
        kind: "index" as const,
        index: Number(hardened ? step.slice(0, -1) : step),
        hardened,
      };
    }),
  sourceFingerprint: fp,
  depth: path.slice(2).split("/").length,
});

const accountsPayload = (accounts: Record<string, unknown>): QrPayload => ({
  type: "crypto-multi-accounts",
  cbor: toUr(accounts as never, cryptoMultiAccountsCodec).toCborData(),
});

const evmKey = (path: string, fp = mfp) => ({
  curve: "secp256k1" as const,
  key: {
    kind: "derived" as const,
    isPrivate: false,
    keyData: secp256k1.getPublicKey(new Uint8Array(32).fill(9), true),
    origin: keypathOf(path, fp),
  },
});

const btcKey = (
  path: string,
  extra: Record<string, unknown> = {},
  fp = mfp,
): Record<string, unknown> => ({
  curve: "secp256k1" as const,
  key: {
    kind: "derived" as const,
    isPrivate: false,
    keyData: secp256k1.getPublicKey(new Uint8Array(32).fill(9), true),
    chainCode: new Uint8Array(32).fill(4),
    parentFingerprint: 0x11223344,
    origin: keypathOf(path, fp),
    ...extra,
  },
});

describe("qr counterpart — readQrExport refuses hostile exports", () => {
  it("refuses non crypto-multi-accounts payloads", () => {
    expect(() => readQrExport({ type: "eth-sign-request", cbor: new Uint8Array([0xa0]) })).toThrow(
      expect.objectContaining({ code: "unsupported" }),
    );
  });

  it("refuses a missing master fingerprint", () => {
    const body = new CborMap(new Map([[2, []]]));
    const payload = {
      type: "crypto-multi-accounts",
      cbor: encodeCbor(taggedValue(INTEROP_TAGS["crypto-multi-accounts"], body)),
    };
    /* The codec refuses a missing field before our own check — malformed either way. */
    expect(() => readQrExport(payload)).toThrow(expect.objectContaining({ code: "malformed" }));
  });

  it("refuses a key whose path is no signing shape", () => {
    expect(() =>
      readQrExport(accountsPayload({ masterFingerprint: mfp, keys: [evmKey("m/44'/60'/0'/1/0")] })),
    ).toThrow(expect.objectContaining({ code: "unsupported" }));
    expect(() =>
      readQrExport(accountsPayload({ masterFingerprint: mfp, keys: [evmKey("m/0'/0'/0'")] })),
    ).toThrow(expect.objectContaining({ code: "unsupported" }));
  });

  it("refuses mixed fingerprints and duplicate families", () => {
    expect(() =>
      readQrExport(
        accountsPayload({
          masterFingerprint: mfp,
          keys: [evmKey("m/44'/60'/0'/0/0", mfp + 1)],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "malformed" }));
    expect(() =>
      readQrExport(
        accountsPayload({
          masterFingerprint: mfp,
          keys: [evmKey("m/44'/60'/0'/0/0"), evmKey("m/44'/60'/0'/0/1")],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "malformed" }));
  });

  it("refuses a bitcoin key without a chain code", () => {
    const send = () =>
      readQrExport(
        accountsPayload({
          masterFingerprint: mfp,
          keys: [evmKey("m/84'/0'/0'")],
        }),
      );
    expect(send).toThrow(expect.objectContaining({ code: "malformed" }));
    expect(send).toThrow(/chain code/);
  });

  it("refuses malformed key material", () => {
    /* The codec reads a key's curve from its keyData length — a 32-byte key on an evm
       path is an ed25519 key, not a secp256k1 leaf. */
    const edOnEvm = {
      curve: "ed25519" as const,
      key: {
        kind: "derived" as const,
        isPrivate: false,
        keyData: new Uint8Array(32).fill(5),
        origin: keypathOf("m/44'/60'/0'/0/0", mfp),
      },
    };
    expect(() =>
      readQrExport(accountsPayload({ masterFingerprint: mfp, keys: [edOnEvm] })),
    ).toThrow(expect.objectContaining({ code: "malformed" }));
    const secpOnSolana = {
      curve: "secp256k1" as const,
      key: {
        kind: "derived" as const,
        isPrivate: false,
        keyData: secp256k1.getPublicKey(new Uint8Array(32).fill(9), true),
        origin: keypathOf("m/44'/501'/0'/0'", mfp),
      },
    };
    expect(() =>
      readQrExport(accountsPayload({ masterFingerprint: mfp, keys: [secpOnSolana] })),
    ).toThrow(expect.objectContaining({ code: "malformed" }));
    const noOrigin = {
      curve: "secp256k1" as const,
      key: {
        kind: "derived" as const,
        isPrivate: false,
        keyData: secp256k1.getPublicKey(new Uint8Array(32).fill(9), true),
      },
    };
    expect(() =>
      readQrExport(accountsPayload({ masterFingerprint: mfp, keys: [noOrigin] })),
    ).toThrow(expect.objectContaining({ code: "malformed" }));
    expect(() =>
      readQrExport(
        accountsPayload({
          masterFingerprint: mfp,
          keys: [btcKey("m/84'/0'/0'", { parentFingerprint: undefined })],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "malformed" }));
    /* An account leaf is not an account — the link claims exactly m/p'/coin'/i'. */
    expect(() =>
      readQrExport(accountsPayload({ masterFingerprint: mfp, keys: [btcKey("m/84'/0'/0'/0/0")] })),
    ).toThrow(expect.objectContaining({ code: "unsupported" }));
  });
});

/* --- qrSignRequest / readQrSignature refusals ------------------------------- */

const OTHER_SOLANA = base58.encode(new Uint8Array(32).fill(2));

const EVM_LINK: QrLink = {
  family: "evm",
  fingerprint: "73c5da0a",
  path: "m/44'/60'/0'/0/0",
  address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
};

describe("qr counterpart — request and signature guards", () => {
  it("refuses what the phone would refuse anyway", () => {
    expect(() =>
      qrSignRequest(
        EVM_LINK,
        {
          family: "evm",
          kind: "transaction",
          tx: (() => {
            const tx = { ...EIP1559_TX };
            delete tx.to;
            return tx;
          })(),
        },
        RANDOM,
      ),
    ).toThrow(expect.objectContaining({ code: "contract-creation" }));
    expect(() =>
      qrSignRequest(
        EVM_LINK,
        {
          family: "evm",
          kind: "transaction",
          tx: {
            ...EIP1559_TX,
            type: "eip7702",
            authorization: { address: "0x0000000000000000000000000000000000000001" },
          } as EvmTransaction,
        },
        RANDOM,
      ),
    ).toThrow(expect.objectContaining({ code: "unsupported" }));
    const solana: QrLink = {
      family: "solana",
      fingerprint: "73c5da0a",
      path: "m/44'/501'/0'/0'",
      address: base58.encode(new Uint8Array(32).fill(1)),
    };
    expect(() =>
      qrSignRequest(
        solana,
        { family: "solana", kind: "transaction", data: solanaMessage(OTHER_SOLANA) },
        RANDOM,
      ),
    ).toThrow(expect.objectContaining({ code: "account-mismatch" }));
    const bitcoin: QrLink = {
      family: "bitcoin",
      fingerprint: "73c5da0a",
      path: "m/84'/0'/0'",
      address: "bc1qexample0000000000000000000000000000000",
      xpub: "xpub-example",
    };
    const tx = new Transaction({ version: 2 });
    tx.addInput({ txid: new Uint8Array(32).fill(7), index: 0 });
    expect(() =>
      qrSignRequest(bitcoin, { family: "bitcoin", kind: "psbt", psbt: tx.toPSBT(0) }, RANDOM),
    ).toThrow(expect.objectContaining({ code: "nothing-to-sign" }));
  });

  it("refuses a malformed link", () => {
    const solana: QrLink = {
      family: "solana",
      fingerprint: "73c5da0a",
      path: "m/44'/501'/0'/0'",
      address: base58.encode(new Uint8Array(32).fill(1)),
    };
    const message = {
      family: "evm" as const,
      kind: "personal-message" as const,
      message: new Uint8Array(1),
    };
    expect(() => qrSignRequest(solana, message, RANDOM)).toThrow(
      expect.objectContaining({ code: "malformed" }),
    );
    expect(() => qrSignRequest({ ...EVM_LINK, fingerprint: "zz" }, message, RANDOM)).toThrow(
      expect.objectContaining({ code: "malformed" }),
    );
    expect(() => qrSignRequest({ ...EVM_LINK, path: "m/0'/0'" }, message, RANDOM)).toThrow(
      expect.objectContaining({ code: "malformed" }),
    );
    expect(() => qrSignRequest({ ...EVM_LINK, address: "0x1234" }, message, RANDOM)).toThrow(
      expect.objectContaining({ code: "malformed" }),
    );
    expect(() => qrSignRequest(EVM_LINK, message, { random: () => new Uint8Array(4) })).toThrow(
      expect.objectContaining({ code: "malformed" }),
    );
  });

  it("encodes a solana message the phone reads", () => {
    const solana: QrLink = {
      family: "solana",
      fingerprint: "73c5da0a",
      path: "m/44'/501'/0'/0'",
      address: base58.encode(new Uint8Array(32).fill(1)),
    };
    const sent = qrSignRequest(
      solana,
      { family: "solana", kind: "message", data: new TextEncoder().encode("memo") },
      RANDOM,
    );
    const request = readQrRequest(sent.payload);
    if (request.family !== "solana" || request.kind !== "message") {
      throw new Error("expected a solana message request");
    }
    expect(request.xfp).toBe(0x73c5da0a);
  });

  it("rejects an impossible recovery id", () => {
    const sent = qrSignRequest(
      EVM_LINK,
      { family: "evm", kind: "transaction", tx: LEGACY_TX },
      RANDOM,
    );
    const payload = toUr(
      {
        ...(sent.requestId === undefined ? {} : { requestId: sent.requestId }),
        signature: new Uint8Array(65),
      },
      ethSignatureCodec,
    );
    /* v = 0 on a legacy transaction is no EIP-155 parity — a QrError, never a foreign throw. */
    const read = () => readQrSignature(sent, { type: "eth-signature", cbor: payload.toCborData() });
    expect(read).toThrow(expect.objectContaining({ code: "result-mismatch" }));
    expect(read).toThrow(/unexpected recovery id/);
  });

  it("encodes each eth dataType the phone decodes", () => {
    const dataType = (tx: EvmTransaction): string => {
      const sent = qrSignRequest(EVM_LINK, { family: "evm", kind: "transaction", tx }, RANDOM);
      return fromUr(Ur.fromCborData(sent.payload.type, sent.payload.cbor), ethSignRequestCodec)
        .dataType;
    };
    expect(dataType(LEGACY_TX)).toBe("transaction");
    expect(dataType(EIP1559_TX)).toBe("typedTransaction");
  });

  it("the encoded request is exactly what readQrRequest accepts", () => {
    const sent = qrSignRequest(
      EVM_LINK,
      { family: "evm", kind: "personal-message", message: new Uint8Array([1, 2, 3]) },
      { ...RANDOM, origin: "https://web.example" },
    );
    const request = readQrRequest(sent.payload);
    if (request.family !== "evm" || request.kind !== "personal-message") {
      throw new Error("expected an evm personal-message request");
    }
    expect(request.xfp).toBe(0x73c5da0a);
    expect(request.address).toBe(EVM_LINK.address.toLowerCase());
    expect(request.declared).toBe("https://web.example");
  });

  it("rejects the wrong response type and a foreign request id", () => {
    const sent = qrSignRequest(
      EVM_LINK,
      { family: "evm", kind: "personal-message", message: new Uint8Array([1]) },
      RANDOM,
    );
    expect(() =>
      readQrSignature(sent, { type: "sol-signature", cbor: new Uint8Array([0xa0]) }),
    ).toThrow(expect.objectContaining({ code: "result-mismatch" }));
    const wrongId = toUr(
      { requestId: new Uint8Array(16).fill(1), signature: new Uint8Array(65) },
      ethSignatureCodec,
    );
    expect(() =>
      readQrSignature(sent, { type: "eth-signature", cbor: wrongId.toCborData() }),
    ).toThrow(expect.objectContaining({ code: "result-mismatch" }));
  });

  it("rejects a signature by another key", () => {
    const sent = qrSignRequest(
      EVM_LINK,
      { family: "evm", kind: "personal-message", message: new TextEncoder().encode("m") },
      RANDOM,
    );
    const other = new Uint8Array(32).fill(11);
    const digest = sha256(
      new Uint8Array([...new TextEncoder().encode(`\u0019Ethereum Signed Message:\n1`), 109]),
    );
    const sig = secp256k1.sign(digest, other, { lowS: true, format: "recovered", prehash: false });
    const wire = new Uint8Array(65);
    wire.set(sig.subarray(1));
    wire[64] = 27 + (sig[0] ?? 0);
    const payload = toUr(
      {
        ...(sent.requestId === undefined ? {} : { requestId: sent.requestId }),
        signature: wire,
      },
      ethSignatureCodec,
    );
    expect(() =>
      readQrSignature(sent, { type: "eth-signature", cbor: payload.toCborData() }),
    ).toThrow(expect.objectContaining({ code: "result-mismatch" }));
  });

  it("rejects a changed or unsigned psbt", () => {
    const pubkey = secp256k1.getPublicKey(new Uint8Array(32).fill(9), true);
    const { script } = p2wpkh(pubkey, NETWORK);
    const funding = new Transaction({ version: 2 });
    funding.addInput({ txid: new Uint8Array(32).fill(7), index: 1 });
    funding.addOutput({ script, amount: 100_000n });
    const tx = new Transaction({ version: 2 });
    tx.addInput({
      txid: funding.id,
      index: 0,
      witnessUtxo: { script, amount: 100_000n },
      nonWitnessUtxo: funding.toBytes(true),
      bip32Derivation: [[pubkey, { fingerprint: 0x73c5da0a, path: [84 + H, H, H, 0, 0] }]],
    });
    tx.addOutput({ script, amount: 90_000n });
    const psbt = tx.toPSBT(0);
    const link: QrLink = {
      family: "bitcoin",
      fingerprint: "73c5da0a",
      path: "m/84'/0'/0'",
      address: "bc1qexample",
      xpub: "xpub-example",
    };
    const sent = qrSignRequest(link, { family: "bitcoin", kind: "psbt", psbt }, RANDOM);
    /* An echo of the unsigned request is no answer. */
    const echo = toUr({ bytes: psbt }, cryptoPsbtCodec);
    expect(() => readQrSignature(sent, { type: "crypto-psbt", cbor: echo.toCborData() })).toThrow(
      expect.objectContaining({ code: "result-mismatch" }),
    );
    /* Content the request did not carry is refused before any signature check. */
    const tampered = Transaction.fromPSBT(psbt);
    tampered.addOutput({ script, amount: 1n });
    const tamperedUr = toUr({ bytes: tampered.toPSBT(0) }, cryptoPsbtCodec);
    expect(() =>
      readQrSignature(sent, { type: "crypto-psbt", cbor: tamperedUr.toCborData() }),
    ).toThrow(expect.objectContaining({ code: "result-mismatch" }));
    /* A signature the request already carried is not new progress. */
    const presigned = Transaction.fromPSBT(psbt);
    presigned.updateInput(0, { partialSig: [[pubkey, new Uint8Array(64).fill(1)]] });
    const presignedUr = toUr({ bytes: presigned.toPSBT(0) }, cryptoPsbtCodec);
    const sentSigned = qrSignRequest(
      link,
      { family: "bitcoin", kind: "psbt", psbt: presigned.toPSBT(0) },
      RANDOM,
    );
    expect(() =>
      readQrSignature(sentSigned, { type: "crypto-psbt", cbor: presignedUr.toCborData() }),
    ).toThrow(expect.objectContaining({ code: "result-mismatch" }));
    /* A taproot signature by a key outside the link is not this account's. */
    const xonly = pubkey.subarray(1);
    const tr = new Transaction({ version: 2 });
    tr.addInput({
      txid: funding.id,
      index: 0,
      witnessUtxo: { script: p2tr(xonly, undefined, NETWORK).script, amount: 100_000n },
      tapInternalKey: xonly,
      bip32Derivation: [[pubkey, { fingerprint: 0x73c5da0a, path: [86 + H, H, H, 0, 0] }]],
    });
    tr.addOutput({ script, amount: 90_000n });
    const trSent = qrSignRequest(
      { ...link, path: "m/86'/0'/0'" },
      { family: "bitcoin", kind: "psbt", psbt: tr.toPSBT(0) },
      RANDOM,
    );
    /* A bare tapKeySig names no key — with no tap derivation under the link it is not progress. */
    const trSigned = Transaction.fromPSBT(tr.toPSBT(0));
    trSigned.updateInput(0, { tapKeySig: new Uint8Array(64).fill(2) });
    const trUr = toUr({ bytes: trSigned.toPSBT(0) }, cryptoPsbtCodec);
    expect(() => readQrSignature(trSent, { type: "crypto-psbt", cbor: trUr.toCborData() })).toThrow(
      expect.objectContaining({ code: "result-mismatch" }),
    );
  });
});

/* --- watch qr accounts ----------------------------------------------------- */

describe("qr counterpart — watch qr accounts", () => {
  const QR = { fingerprint: "73c5da0a", path: "m/44'/60'/0'/0/0" };
  const ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

  it("a qr watch account persists its link across reopen", { timeout: 60_000 }, async () => {
    const { watch, backing } = await webWatch();
    await watch.add({ family: "evm", address: ADDRESS, qr: QR });
    const reopened = new WatchController({
      random: webRandom,
      now: () => 0,
      logger: { warn: () => undefined },
      ownAddresses: async () => {
        await Promise.resolve();
        return [];
      },
    });
    reopened.setStore(createMemoryEngineStore(backing));
    await reopened.init();
    const [account] = reopened.list();
    expect(account?.qr).toStrictEqual(QR);
  });

  it("rejects malformed qr links at add time", { timeout: 60_000 }, async () => {
    const { watch } = await webWatch();
    await expect(
      watch.add({ family: "evm", address: ADDRESS, qr: { ...QR, fingerprint: "zz" } }),
    ).rejects.toThrow("fingerprint");
    await expect(
      watch.add({ family: "evm", address: ADDRESS, qr: { ...QR, path: "m/44'/60'/0'/0'/0" } }),
    ).rejects.toThrow("path");
    await expect(
      watch.add({ family: "solana", address: base58.encode(new Uint8Array(32).fill(3)), qr: QR }),
    ).rejects.toThrow("path");
    await expect(
      watch.add({
        family: "evm",
        address: ADDRESS,
        qr: { ...QR, xpub: "xpub-not-for-evm" },
      }),
    ).rejects.toThrow("xpub");
  });

  it("rejects a bitcoin qr without xpub or with a foreign xpub", { timeout: 60_000 }, async () => {
    const { wallet, walletId } = await nodeWallet();
    const facts = await factsOf(wallet, walletId);
    const address = await import("@qntx/wallet-chains/bitcoin").then((m) =>
      m.bitcoinAddressFromXpub(facts.btc84, "btc.bip84", BITCOIN_MAINNET, 0, 0),
    );
    const { watch } = await webWatch();
    await expect(
      watch.add({
        family: "bitcoin",
        address,
        qr: { fingerprint: QR.fingerprint, path: "m/84'/0'/0'" },
      }),
    ).rejects.toThrow("xpub");
    const other = secp256k1.getPublicKey(new Uint8Array(32).fill(9), true);
    void other;
    await expect(
      watch.add({
        family: "bitcoin",
        address,
        qr: {
          fingerprint: QR.fingerprint,
          path: "m/84'/0'/0'",
          xpub: "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG4DSSSSoekkudhUd9yLb6qx39T9nMdj",
        },
      }),
    ).rejects.toThrow("xpub");
  });

  it("drops a watch record whose qr link is malformed", { timeout: 60_000 }, async () => {
    const { watch, backing } = await webWatch();
    await watch.add({ family: "evm", address: ADDRESS, qr: QR });
    const table = backing.collections.get("watch");
    const [key] = [...(table?.keys() ?? [])];
    const record = JSON.parse(new TextDecoder().decode(table?.get(key ?? "") ?? new Uint8Array()));
    record.qr = { fingerprint: "not-hex", path: QR.path };
    table?.set(key ?? "", new TextEncoder().encode(JSON.stringify(record)));
    const warned: unknown[] = [];
    const reopened = new WatchController({
      random: webRandom,
      now: () => 0,
      logger: { warn: (_m, meta) => warned.push(meta) },
      ownAddresses: async () => {
        await Promise.resolve();
        return [];
      },
    });
    reopened.setStore(createMemoryEngineStore(backing));
    await reopened.init();
    expect(reopened.list()).toHaveLength(0);
    expect(warned).toHaveLength(1);
  });
});
