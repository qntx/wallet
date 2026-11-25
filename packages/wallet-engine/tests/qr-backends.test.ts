// oxlint-disable vitest/no-conditional-in-test -- backend-matrix assertions narrow prepared/result kinds
/**
 * Origins × backends through the one signing seam: a QR request (like a dApp's or an internal one)
 * is signed by whatever backs the account — a vault mnemonic, a passkey-derived wallet, or a paired
 * Keystone 3 Pro through `EngineOptions.deviceIo`. The RequestController and `qrSigner` are real;
 * the transaction/solana/bitcoin options submit through the SignersController's `apis` so every
 * signature reaches the kernel (vault) or the simulated device (hardware). A hardware sign is
 * asserted to need exactly one device exchange and none before approval; the response UR and its
 * CBOR keys are identical whichever custody signed.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NETWORK, p2wpkh, Transaction } from "@scure/btc-signer";
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
import { serializeTransaction } from "viem";
import { describe, expect, it } from "vite-plus/test";

import {
  ethSignatureCodec,
  solSignatureCodec,
  tronSignatureCodec,
  cryptoMultiAccountsCodec,
} from "@qntx/ur/interop";
import { cryptoPsbtCodec } from "@qntx/ur/registry";
import { Ur, fromUr } from "@qntx/ur/typed";
import { WalletError } from "@qntx/wallet";
import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import {
  EMPTY_BITCOIN_OWN,
  bitcoinPubkeyFromXpub,
  normalizeBitcoin,
} from "@qntx/wallet-chains/bitcoin";
import { normalizeEvm, recoverEvmSigner } from "@qntx/wallet-chains/evm";
import { parseCompiledMessage } from "@qntx/wallet-chains/solana";
import { normalizeTron, tronAddressToHex, tronRawDataFromJson } from "@qntx/wallet-chains/tron";
import { chains } from "@qntx/wallet/chains";
import { hardware } from "@qntx/wallet/hardware";
import type { DeviceIo } from "@qntx/wallet/hardware";
import type {
  ChainSignRequest,
  ChainSignResult,
  ChainTemplate,
  HardwareDevice,
} from "@qntx/wallet/protocol";

import type { WalletEngine } from "../src/engine.ts";
import { QrError } from "../src/qr/index.ts";
import type { QrRequest } from "../src/qr/request.ts";
import { qrSigner } from "../src/qr/signer.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SolanaSignResult } from "../src/requests/controller.ts";
import { RequestEndedError } from "../src/requests/types.ts";
import type { BitcoinPsbtInput, PreparedBitcoinPsbt } from "../src/requests/types.ts";
import { SignersController } from "../src/signers/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type {
  PreparedMessage,
  PreparedQrSign,
  PreparedRequest,
} from "../src/transactions/route.ts";
import { approval } from "./approval.ts";
import { until, VERIFY, freshNodeWallet, nodeWallet } from "./apps-helpers.ts";
import { CARD_VERIFY, cardRig } from "./card-rig.ts";
import { keystoneSimIo } from "./keystone-io.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const H = 0x80000000;
const EVM_MAINNET = "eip155:1";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON_MAINNET = "tron:728126428";
const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93";

const EVM_PATH = [44 + H, 60 + H, H, 0, 0];
const TRON_PATH = [44 + H, 195 + H, H, 0, 0];
const SOLANA_PATH = [44 + H, 501 + H, H, H];
const BTC84_PATH = [84 + H, H, H, 0, 0];

const ENABLED: Record<string, ReadonlyArray<string>> = {
  evm: [EVM_MAINNET],
  solana: [SOLANA_MAINNET],
  tron: [TRON_MAINNET],
  bitcoin: [BITCOIN_MAINNET],
};

const BROWSER = { kind: "browser" as const, origin: "https://dapp.example" };

/* The device holds a seed the vault does not — its signatures prove which backend signed. */
const DEVICE_SEED = mnemonicToSeedSync(
  "test test test test test test test test test test test junk",
);
const deviceFingerprint = ((): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, HDKey.fromMasterSeed(DEVICE_SEED).fingerprint);
  return out;
})();

type Facts = {
  readonly walletId: string;
  readonly fingerprint: number;
  readonly evm: string;
  readonly tron: string;
  readonly solana: string;
  readonly btcXpub: string;
};

type Backends = {
  readonly wallet: Wallet;
  readonly mnemonic: Facts;
  readonly passkey: Facts;
  readonly keystone: Facts;
};

/** The same account facts `qrSigner` binds against — fingerprint plus per-family addresses. */
const factsOf = async (wallet: Wallet, walletId: string): Promise<Facts> => {
  const info = wallet.getSnapshot().wallets.find((entry) => entry.walletId === walletId);
  if (info === undefined) {
    throw new Error(`no wallet ${walletId}`);
  }
  const apis = chains(wallet);
  const [evm, tron, solana, bitcoin] = await Promise.all([
    apis.account({ walletId, groupIndex: 0, template: "evm.bip44", network: EVM_MAINNET }),
    apis.account({ walletId, groupIndex: 0, template: "tron.bip44", network: TRON_MAINNET }),
    apis.account({
      walletId,
      groupIndex: 0,
      template: "solana.bip44-change",
      network: SOLANA_MAINNET,
    }),
    apis.account({ walletId, groupIndex: 0, template: "btc.bip84", network: BITCOIN_MAINNET }),
  ]);
  if (!("address" in evm) || !("address" in tron) || !("address" in solana)) {
    throw new Error("expected address accounts");
  }
  if (!("xpub" in bitcoin)) {
    throw new Error("expected a bitcoin account");
  }
  return {
    walletId,
    fingerprint:
      info.custody === "hardware"
        ? Number.parseInt(info.fingerprint, 16)
        : Number.parseInt(bitcoin.fingerprint, 16),
    evm: evm.address,
    tron: tron.address,
    solana: solana.address,
    btcXpub: bitcoin.xpub,
  };
};

let shared: Backends | undefined;

/**
 * The shared node wallet with its three backends: the imported mnemonic wallet, one passkey wallet,
 * and the Keystone 3 Pro pair exchange answered by the simulated device.
 */
const backends = async (): Promise<Backends> => {
  if (shared !== undefined) {
    return shared;
  }
  const { wallet, walletId } = await nodeWallet();
  await wallet.vault.unlock(VERIFY).catch(() => undefined);
  const passkey = await wallet.wallets.createWithPasskey({ name: "qr backends passkey" });
  const device = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
  const pairResult = await hardware(wallet).start(
    { kind: "pair", device: "keystone" },
    { io: device.io },
  ).result;
  if (pairResult.kind !== "pair") {
    throw new Error("expected a pair result");
  }
  const paired = pairResult.wallet;
  shared = {
    wallet,
    mnemonic: await factsOf(wallet, walletId),
    passkey: await factsOf(wallet, passkey.walletId),
    keystone: await factsOf(wallet, paired.walletId),
  };
  return shared;
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

const TYPED_DATA = JSON.stringify({
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
  primaryType: "Mail",
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
});

const qrPersonal = (f: Facts): Extract<QrRequest, { kind: "personal-message" }> => ({
  family: "evm",
  kind: "personal-message",
  path: EVM_PATH,
  xfp: f.fingerprint,
  address: f.evm,
  chainId: 1,
  message: new TextEncoder().encode("hello from the counterpart"),
});

const qrTypedData = (f: Facts): Extract<QrRequest, { kind: "typed-data" }> => ({
  family: "evm",
  kind: "typed-data",
  path: EVM_PATH,
  xfp: f.fingerprint,
  address: f.evm,
  chainId: 1,
  typedData: TYPED_DATA,
});

const qrTransaction = (f: Facts): QrRequest => ({
  family: "evm",
  kind: "transaction",
  path: EVM_PATH,
  xfp: f.fingerprint,
  address: f.evm,
  chainId: 1,
  tx: {
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
  },
  data: new Uint8Array(
    Buffer.from(
      serializeTransaction({
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: 21000n,
        to: "0x00000000000000000000000000000000deadbeef",
        value: 1n,
        data: "0x",
        accessList: [],
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }).slice(2),
      "hex",
    ),
  ),
});

/**
 * A minimal TRX transfer raw_data the backend's own address owns — `decodeTron` requires the owner
 * to be the signing account.
 */
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

const qrTron = (f: Facts): QrRequest => ({
  family: "tron",
  kind: "transaction",
  path: TRON_PATH,
  xfp: f.fingerprint,
  address: f.tron,
  data: tronRawData(f.tron),
});

/** A single-input p2wpkh PSBT whose bip32 derivation is this backend's own material. */
const qrPsbt = (f: Facts): QrRequest => {
  const pubkey = bitcoinPubkeyFromXpub(f.btcXpub, "btc.bip84", BITCOIN_MAINNET, 0, 0);
  const { script } = p2wpkh(pubkey, NETWORK);
  /* The signer verifies each input's nonWitnessUtxo against the txid, so the funding tx is a real
     transaction rather than a placeholder hash. */
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
    bip32Derivation: [[pubkey, { fingerprint: f.fingerprint, path: [...BTC84_PATH] }]],
  });
  tx.addOutput({ script: p2wpkh(pubkey, NETWORK).script, amount: 90_000n });
  return { family: "bitcoin", kind: "psbt", urType: "crypto-psbt", psbt: tx.toPSBT(0) };
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
  readonly signers: SignersController;
};

const RANDOM = (length: number): Uint8Array => new Uint8Array(length).fill(7);

/** The signer seam built the way the engine builds it — `deviceIo` resolves per paired kind. */
const signersOf = (wallet: Wallet, deviceIo?: (device: HardwareDevice) => DeviceIo) =>
  new SignersController({
    wallet,
    deviceIo,
    recheck: async () => {
      await Promise.resolve();
    },
    networks: { enabled: (family) => ENABLED[family] ?? [] },
    random: RANDOM,
    logger: { warn: () => undefined },
  });

/**
 * The QR world with real signing: every option the pipeline calls signs through `signers.apis`, the
 * seam an engine builds from `options.deviceIo` — the kernel for vault wallets, the device for
 * hardware custody.
 */
const worldOver = async (
  wallet: Wallet,
  deviceIo: ((device: HardwareDevice) => DeviceIo) | undefined,
): Promise<World> => {
  const signers = signersOf(wallet, deviceIo);
  const signing = signers.apis;
  const signedTransaction = (
    request: ChainSignRequest,
    result: ChainSignResult,
  ): { kind: "evm.signed-transaction"; signedTransaction: Uint8Array } => {
    if (request.kind !== "evm.transaction" || result.kind !== "evm.transaction") {
      throw new Error("expected an evm transaction result");
    }
    return { kind: "evm.signed-transaction", signedTransaction: result.signedTransaction };
  };
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
        account: request.account,
        network: request.network,
        intent: {
          family: "evm" as const,
          network: request.network,
          summary: "transfer",
          outflows: [],
          approvals: [],
          fee: undefined,
          warnings: [],
          verifiability: "full" as const,
        },
        signer: "",
        checks: [],
        staleReason: () => undefined,
        release: () => undefined,
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
        request.kind !== "tron.message" &&
        request.kind !== "tron.typed-data"
      ) {
        throw new Error(`unexpected dapp request ${request.kind}`);
      }
      return {
        account: request.account,
        network: request.network,
        intent: {
          family: request.kind.startsWith("evm") ? ("evm" as const) : ("tron" as const),
          network: request.network,
          summary: "message",
          outflows: [],
          approvals: [],
          fee: undefined,
          warnings: [],
          verifiability: "full" as const,
        },
        signer: "",
        checks: [],
        staleReason: () => undefined,
        release: () => undefined,
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
      if (request.kind !== "tron.transaction" || options?.broadcast !== false) {
        throw new Error("a dApp tron request is not wired in this test");
      }
      return {
        account: request.account,
        network: request.network,
        intent: {
          family: "tron" as const,
          network: request.network,
          summary: "contract-call",
          outflows: [],
          approvals: [],
          fee: undefined,
          warnings: [],
          verifiability: "full" as const,
        },
        signer: "",
        checks: [],
        staleReason: () => undefined,
        release: () => undefined,
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
            origin: "internal",
            network,
            account: {
              kind: "hd" as const,
              walletId: _account.walletId,
              groupIndex: _account.groupIndex,
            },
            psbt: input.psbt,
            sign: input.sign.map(({ index, template }) => ({ index, template })),
          },
          own: EMPTY_BITCOIN_OWN,
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
    signers: { apis: signers.apis },
  } as unknown as WalletEngine;
  return { wallet, requests, signer: qrSigner({ engine, wallet }), signers };
};

const world = async (
  deviceIo: ((device: HardwareDevice) => DeviceIo) | undefined,
): Promise<World> => {
  const { wallet } = await nodeWallet();
  await wallet.vault.unlock(VERIFY).catch(() => undefined);
  return worldOver(wallet, deviceIo);
};

/** One signature round-trip through the QR facade; `prepare` never asks the device. */
/* `approve` is typed per method literal; `pending.method` is the union — the pipeline itself
   routes on the same value. */
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

const signQr = async (
  w: World,
  request: QrRequest,
  account: { readonly walletId: string; readonly groupIndex: number },
  device?: { exchanges: () => number },
): Promise<{ type: string; cbor: Uint8Array }> => {
  const pending = await w.signer.prepare(request, account);
  /* The device is asked only after approval — nothing may have talked to it while the request
     waited. */
  expect(device?.exchanges() ?? 0).toBe(0);
  await approvePending(w.requests, pending);
  return w.signer.respond(pending.id);
};

/** A dApp or internal request through the same pipeline the QR facade feeds. */
const signRequest = async (
  w: World,
  input: Parameters<RequestController["prepare"]>[0],
): Promise<unknown> => {
  const pending = await w.requests.prepare(input);
  await approvePending(w.requests, pending);
  return w.requests.outcome(pending.id);
};

const hdRef = (account: { readonly walletId: string }, template: ChainTemplate) =>
  ({ kind: "hd", walletId: account.walletId, groupIndex: 0, template }) as const;

/** The eth-signature payload's signature field, decoded. */
const ethSignature = (payload: { type: string; cbor: Uint8Array }): Uint8Array => {
  const { signature } = fromUr(Ur.fromCborData(payload.type, payload.cbor), ethSignatureCodec) as {
    signature: Uint8Array;
  };
  return signature;
};

/** Recovers an EVM signature's signer — the backend that signed is the proof. */
const evmSigner = (
  request: SignRequest,
  result: { readonly signature?: Uint8Array; readonly signedTransaction?: Uint8Array },
): string => recoverEvmSigner(request, result);

const NAMES = ["mnemonic", "passkey", "keystone"] as const;

describe("qr backends — origin × custody matrix", () => {
  // oxlint-disable-next-line vitest/prefer-each -- `it.each` would run the suite once per backend; the loop builds them explicitly
  for (const name of NAMES) {
    it(`qr personal-message signs through the ${name} backend`, { timeout: 60_000 }, async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b[name];
      expect(io.exchanges()).toBe(0);
      const payload = await signQr(w, qrPersonal(f), { walletId: f.walletId, groupIndex: 0 }, io);
      expect(payload.type).toBe("eth-signature");
      const recovered = evmSigner(
        {
          kind: "evm.personal-message",
          network: EVM_MAINNET,
          account: hdRef(f, "evm.bip44"),
          message: new TextEncoder().encode("hello from the counterpart"),
        },
        { signature: ethSignature(payload) },
      );
      expect(recovered.toLowerCase()).toBe(f.evm.toLowerCase());
      expect(io.exchanges()).toBe(name === "keystone" ? 1 : 0);
    });

    it(`qr typed-data signs through the ${name} backend`, { timeout: 60_000 }, async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b[name];
      const payload = await signQr(w, qrTypedData(f), { walletId: f.walletId, groupIndex: 0 }, io);
      expect(payload.type).toBe("eth-signature");
      const recovered = evmSigner(
        {
          kind: "evm.typed-data",
          network: EVM_MAINNET,
          account: hdRef(f, "evm.bip44"),
          typedData: TYPED_DATA,
        },
        { signature: ethSignature(payload) },
      );
      expect(recovered.toLowerCase()).toBe(f.evm.toLowerCase());
      expect(io.exchanges()).toBe(name === "keystone" ? 1 : 0);
    });

    it(
      `a dApp personal-message signs through the ${name} backend`,
      { timeout: 60_000 },
      async () => {
        const b = await backends();
        const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
        const w = await world(() => io.io);
        const f = b[name];
        const request = {
          kind: "evm.personal-message" as const,
          network: EVM_MAINNET,
          account: hdRef(f, "evm.bip44"),
          message: new TextEncoder().encode("a dApp asks"),
        };
        const result = await signRequest(w, {
          method: "evm-sign",
          origin: BROWSER,
          account: hdRef(f, "evm.bip44"),
          network: EVM_MAINNET,
          request,
        });
        if (typeof result !== "object" || result === null || !("signature" in result)) {
          throw new Error("expected a signature outcome");
        }
        expect(
          evmSigner(request, { signature: result.signature as Uint8Array }).toLowerCase(),
        ).toBe(f.evm.toLowerCase());
        expect(io.exchanges()).toBe(name === "keystone" ? 1 : 0);
      },
    );

    it(`a dApp typed-data signs through the ${name} backend`, { timeout: 60_000 }, async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b[name];
      const request = {
        kind: "evm.typed-data" as const,
        network: EVM_MAINNET,
        account: hdRef(f, "evm.bip44"),
        typedData: TYPED_DATA,
      };
      const result = await signRequest(w, {
        method: "evm-sign",
        origin: BROWSER,
        account: hdRef(f, "evm.bip44"),
        network: EVM_MAINNET,
        request,
      });
      if (typeof result !== "object" || result === null || !("signature" in result)) {
        throw new Error("expected a signature outcome");
      }
      expect(evmSigner(request, { signature: result.signature as Uint8Array }).toLowerCase()).toBe(
        f.evm.toLowerCase(),
      );
      expect(io.exchanges()).toBe(name === "keystone" ? 1 : 0);
    });

    it(
      `an internal typed-data signs through the ${name} backend`,
      { timeout: 60_000 },
      async () => {
        const b = await backends();
        const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
        const w = await world(() => io.io);
        const f = b[name];
        const request = {
          kind: "evm.typed-data" as const,
          network: EVM_MAINNET,
          account: hdRef(f, "evm.bip44"),
          typedData: TYPED_DATA,
        };
        const result = await signRequest(w, {
          method: "evm-sign",
          account: hdRef(f, "evm.bip44"),
          network: EVM_MAINNET,
          request,
        });
        if (typeof result !== "object" || result === null || !("signature" in result)) {
          throw new Error("expected a signature outcome");
        }
        expect(
          evmSigner(request, { signature: result.signature as Uint8Array }).toLowerCase(),
        ).toBe(f.evm.toLowerCase());
        expect(io.exchanges()).toBe(name === "keystone" ? 1 : 0);
      },
    );
  }

  // oxlint-disable-next-line vitest/prefer-each -- `it.each` would run the suite once per backend; the loop builds them explicitly
  for (const name of NAMES) {
    it(`qr evm transaction signs through the ${name} backend`, { timeout: 60_000 }, async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b[name];
      const request = qrTransaction(f);
      const payload = await signQr(w, request, { walletId: f.walletId, groupIndex: 0 }, io);
      expect(payload.type).toBe("eth-signature");
      /* The eth-signature carries r‖s‖yParity — rebuild the signed envelope to recover. */
      const sig = ethSignature(payload);
      const signedTransaction = new Uint8Array(
        Buffer.from(
          serializeTransaction(
            {
              type: "eip1559",
              chainId: 1,
              nonce: 0,
              gas: 21000n,
              to: "0x00000000000000000000000000000000deadbeef",
              value: 1n,
              data: "0x",
              accessList: [],
              maxFeePerGas: 1_000_000_000n,
              maxPriorityFeePerGas: 1_000_000_000n,
            },
            {
              r: `0x${Buffer.from(sig.subarray(0, 32)).toString("hex")}`,
              s: `0x${Buffer.from(sig.subarray(32, 64)).toString("hex")}`,
              yParity: sig[64] === 1 ? 1 : 0,
            },
          ).slice(2),
          "hex",
        ),
      );
      const recovered = evmSigner(
        {
          kind: "evm.transaction",
          network: EVM_MAINNET,
          account: hdRef(f, "evm.bip44"),
          tx:
            request.family === "evm" && request.kind === "transaction"
              ? request.tx
              : (() => {
                  throw new Error("unreachable");
                })(),
        },
        { signedTransaction },
      );
      expect(recovered.toLowerCase()).toBe(f.evm.toLowerCase());
      expect(io.exchanges()).toBe(name === "keystone" ? 1 : 0);
    });

    it(`qr solana transaction signs through the ${name} backend`, { timeout: 60_000 }, async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b[name];
      const message = solanaMessage(f.solana);
      const request: QrRequest = {
        family: "solana",
        kind: "transaction",
        path: SOLANA_PATH,
        xfp: f.fingerprint,
        address: f.solana,
        data: message,
      };
      const payload = await signQr(w, request, { walletId: f.walletId, groupIndex: 0 }, io);
      expect(payload.type).toBe("sol-signature");
      const { signature } = fromUr(
        Ur.fromCborData(payload.type, payload.cbor),
        solSignatureCodec,
      ) as { signature: Uint8Array };
      /* The request data is the message bytes — the signature must verify under the backend's
         own solana address. */
      expect(ed25519.verify(signature, message, base58.decode(f.solana))).toBe(true);
      expect(io.exchanges()).toBe(name === "keystone" ? 1 : 0);
    });

    it(`qr tron transaction signs through the ${name} backend`, { timeout: 60_000 }, async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b[name];
      const payload = await signQr(w, qrTron(f), { walletId: f.walletId, groupIndex: 0 }, io);
      expect(payload.type).toBe("tron-signature");
      /* qrResponse already re-verified the signature recovers to the bound address; the UR
         decode proves the counterpart's codec reads it. */
      const { signature } = fromUr(
        Ur.fromCborData(payload.type, payload.cbor),
        tronSignatureCodec,
      ) as { signature: Uint8Array };
      expect(signature).toHaveLength(65);
      expect(io.exchanges()).toBe(name === "keystone" ? 1 : 0);
    });

    it(`qr bitcoin psbt signs through the ${name} backend`, { timeout: 60_000 }, async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b[name];
      const request = qrPsbt(f);
      const payload = await signQr(w, request, { walletId: f.walletId, groupIndex: 0 }, io);
      expect(payload.type).toBe("crypto-psbt");
      const signed = Transaction.fromPSBT(
        (
          fromUr(Ur.fromCborData(payload.type, payload.cbor), cryptoPsbtCodec) as {
            bytes: Uint8Array;
          }
        ).bytes,
      );
      expect(signed.getInput(0).partialSig?.length ?? 0).toBe(1);
      expect(io.exchanges()).toBe(name === "keystone" ? 1 : 0);
    });
  }
});

describe("qr backends — the device hop", () => {
  it(
    "a device lost mid-signature ends the request with no payload; the next signs normally",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b.keystone;
      const pending = await w.signer.prepare(qrPersonal(f), {
        walletId: f.walletId,
        groupIndex: 0,
      });
      io.fail(new Error("device disconnected"));
      await expect(approvePending(w.requests, pending)).rejects.toThrow("device disconnected");
      expect(w.requests.getState().requests[pending.id]?.stage).toBe("failed");
      /* The response hop refuses — the counterpart never hears a backend error. */
      await expect(w.signer.respond(pending.id)).rejects.toSatisfy(
        (error) => error instanceof RequestEndedError,
      );
      /* The kernel operation was cancelled — a following signature on the same wallet works. */
      io.fail(undefined);
      const payload = await signQr(w, qrTypedData(f), {
        walletId: f.walletId,
        groupIndex: 0,
      });
      expect(payload.type).toBe("eth-signature");
    },
  );

  it(
    "cancelling the signers operation aborts the request with no payload",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const device = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      /* The host cancels while the device holds the request — the kernel checks the flag after
         the exchange and cancels the operation. */
      const io: DeviceIo = {
        exchange: async (request, context) => {
          const response = await device.io.exchange(request, context);
          await gate;
          return response;
        },
      };
      const w = await world(() => io);
      const f = b.keystone;
      const pending = await w.signer.prepare(qrPersonal(f), {
        walletId: f.walletId,
        groupIndex: 0,
      });
      const approving = approvePending(w.requests, pending).then(
        () => {
          throw new Error("expected the approval to be cancelled");
        },
        (error: unknown) => error,
      );
      await until(() => device.exchanges() === 1);
      await w.signers.cancel();
      release();
      await expect(approving).resolves.toSatisfy(
        (error) => error instanceof WalletError && error.code === "cancelled",
      );
      await expect(w.signer.respond(pending.id)).rejects.toSatisfy(
        (error) => error instanceof RequestEndedError,
      );
    },
  );

  it(
    "no device transport answers a hardware request with unsupported and no exchanges",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const w = await world(undefined);
      const f = b.keystone;
      const pending = await w.signer.prepare(qrPersonal(f), {
        walletId: f.walletId,
        groupIndex: 0,
      });
      await expect(approvePending(w.requests, pending)).rejects.toSatisfy(
        (error) => error instanceof WalletError && error.code === "unsupported",
      );
      await expect(w.signer.respond(pending.id)).rejects.toSatisfy(
        (error) => error instanceof RequestEndedError,
      );
    },
  );

  it(
    "a QR request for another key is refused account-mismatch without asking the device",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b.keystone;
      const foreign = { ...qrPersonal(f), xfp: f.fingerprint + 1 };
      await expect(
        w.signer.prepare(foreign, { walletId: f.walletId, groupIndex: 0 }),
      ).rejects.toSatisfy((error) => error instanceof QrError && error.code === "account-mismatch");
      expect(io.exchanges()).toBe(0);
      const wrongAddress = { ...qrPersonal(f), address: b.mnemonic.evm };
      await expect(
        w.signer.prepare(wrongAddress, { walletId: f.walletId, groupIndex: 0 }),
      ).rejects.toSatisfy((error) => error instanceof QrError && error.code === "account-mismatch");
      const wrongPath = { ...qrPersonal(f), path: [...EVM_PATH.slice(0, 4), 1] };
      await expect(
        w.signer.prepare(wrongPath, { walletId: f.walletId, groupIndex: 0 }),
      ).rejects.toSatisfy((error) => error instanceof QrError && error.code === "account-mismatch");
      expect(io.exchanges()).toBe(0);
    },
  );
});

describe("qr backends — export and indistinguishability", () => {
  it(
    "exporting the hardware account uses the pinned material with zero device exchanges",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const f = b.keystone;
      const exported = await w.signer.exportAccount({
        account: { walletId: f.walletId, groupIndex: 0 },
        form: "crypto-multi-accounts",
        families: ["evm", "tron", "solana"],
        bitcoin: { template: "btc.bip84", network: BITCOIN_MAINNET },
        verify: VERIFY,
      });
      expect(io.exchanges()).toBe(0);
      expect(exported.payload.type).toBe("crypto-multi-accounts");
      const decoded = fromUr(
        Ur.fromCborData(exported.payload.type, exported.payload.cbor),
        cryptoMultiAccountsCodec,
      ) as { device?: string };
      expect(decoded.device).toBe("qntx");
    },
  );

  it(
    "the export device field is the constant whichever custody produced it",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const w = await world(undefined);
      for (const f of [b.mnemonic, b.keystone]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- exports decode in order
        const exported = await w.signer.exportAccount({
          account: { walletId: f.walletId, groupIndex: 0 },
          form: "crypto-multi-accounts",
          families: ["evm", "tron", "solana"],
          bitcoin: { template: "btc.bip84", network: BITCOIN_MAINNET },
          verify: VERIFY,
        });
        const decoded = fromUr(
          Ur.fromCborData(exported.payload.type, exported.payload.cbor),
          cryptoMultiAccountsCodec,
        ) as { device?: string; masterFingerprint: number };
        expect(decoded.device).toBe("qntx");
        expect(decoded.masterFingerprint).toBe(f.fingerprint);
      }
    },
  );

  it(
    "a hardware-backed and a vault-backed answer carry the same UR type and CBOR keys",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await world(() => io.io);
      const requestId = new Uint8Array(16).fill(3);
      const decode = (payload: { type: string; cbor: Uint8Array }) =>
        fromUr(Ur.fromCborData(payload.type, payload.cbor), ethSignatureCodec) as Record<
          string,
          unknown
        >;
      const vault = decode(
        await signQr(
          w,
          { ...qrPersonal(b.mnemonic), requestId },
          { walletId: b.mnemonic.walletId, groupIndex: 0 },
        ),
      );
      const device = decode(
        await signQr(
          w,
          { ...qrPersonal(b.keystone), requestId },
          { walletId: b.keystone.walletId, groupIndex: 0 },
        ),
      );
      expect(device["signature"]).toBeInstanceOf(Uint8Array);
      /* The counterpart sees the same map — custody is not a field. */
      expect(Object.keys(device).toSorted()).toStrictEqual(Object.keys(vault).toSorted());
      expect(io.exchanges()).toBe(1);
    },
  );
});

describe("the signers dispatch", () => {
  const personalRequest = (
    account: Extract<ChainSignRequest, { kind: "evm.personal-message" }>["account"],
  ): ChainSignRequest => ({
    kind: "evm.personal-message",
    network: EVM_MAINNET,
    account,
    message: new TextEncoder().encode("dispatch check"),
  });

  it(
    "a vault wallet signs in the kernel — the device transport is never consulted",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const signers = signersOf(b.wallet, () => {
        throw new Error("a vault account must not reach the device transport");
      });
      const result = await signers.apis.sign({
        request: personalRequest(hdRef(b.mnemonic, "evm.bip44")),
        verify: VERIFY,
      });
      if (result.kind !== "evm.personal-message") {
        throw new Error("expected a personal-message result");
      }
      expect(
        evmSigner(personalRequest(hdRef(b.mnemonic, "evm.bip44")), {
          signature: result.signature,
        }).toLowerCase(),
      ).toBe(b.mnemonic.evm.toLowerCase());
    },
  );

  it(
    "a hardware wallet signs on the device the transport resolves for its kind",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      let seen: HardwareDevice | undefined;
      const signers = signersOf(b.wallet, (device) => {
        seen = device;
        return io.io;
      });
      const request = personalRequest(hdRef(b.keystone, "evm.bip44"));
      const result = await signers.apis.sign({ request, verify: VERIFY });
      if (result.kind !== "evm.personal-message") {
        throw new Error("expected a personal-message result");
      }
      expect(evmSigner(request, { signature: result.signature }).toLowerCase()).toBe(
        b.keystone.evm.toLowerCase(),
      );
      {
        const info = b.wallet
          .getSnapshot()
          .wallets.find((entry) => entry.walletId === b.keystone.walletId);
        expect(info?.custody).toBe("hardware");
        expect(seen).toBe("keystone");
      }
      expect(io.exchanges()).toBe(1);
    },
  );

  it(
    "an imported key delegates to the kernel — never the device transport",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const leaf = secp256k1.utils.randomSecretKey();
      const key = await b.wallet.keys.import("evm", leaf);
      const signers = signersOf(b.wallet, () => {
        throw new Error("an imported key must not reach the device transport");
      });
      const request = personalRequest({ kind: "imported", keyId: key.keyId, family: "evm" });
      const result = await signers.apis.sign({ request, verify: VERIFY });
      if (result.kind !== "evm.personal-message") {
        throw new Error("expected a personal-message result");
      }
      expect(evmSigner(request, { signature: result.signature }).toLowerCase()).toBe(
        key.address.toLowerCase(),
      );
    },
  );

  it(
    "a walletId the snapshot does not know delegates to the kernel, not the device",
    { timeout: 60_000 },
    async () => {
      const b = await backends();
      const signers = signersOf(b.wallet, () => {
        throw new Error("an unknown wallet must not reach the device transport");
      });
      await expect(
        signers.apis.sign({
          request: personalRequest(hdRef({ walletId: "00000000" }, "evm.bip44")),
          verify: VERIFY,
        }),
      ).rejects.toSatisfy(
        (error) =>
          error instanceof WalletError &&
          error.code !== "unsupported" &&
          error.code !== "cancelled",
      );
    },
  );
});

describe("qr account facts — partial pins and card custody", () => {
  it(
    "a hardware wallet with only evm material pinned signs evm and refuses solana device-required",
    { timeout: 60_000 },
    async () => {
      /* A fresh vault — the shared node's keystone is already paired with every family. */
      const { wallet } = await freshNodeWallet();
      await wallet.vault.unlock(VERIFY).catch(() => undefined);
      /* The pair sync publishes only the EVM account — every other family's material is missing
         from the wallet's pin. */
      const pairIo = keystoneSimIo(DEVICE_SEED, deviceFingerprint, {
        sync: { secp256k1: ["m/44'/60'/0'"], ed25519: [] },
      });
      const pairResult = await hardware(wallet).start(
        { kind: "pair", device: "keystone" },
        { io: pairIo.io },
      ).result;
      if (pairResult.kind !== "pair") {
        throw new Error("expected a pair result");
      }
      const { walletId } = pairResult.wallet;
      const info = wallet.getSnapshot().wallets.find((entry) => entry.walletId === walletId);
      if (info === undefined || info.custody !== "hardware") {
        throw new Error("expected a hardware wallet");
      }
      const evm = await chains(wallet).account({
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: EVM_MAINNET,
      });
      if (!("address" in evm)) {
        throw new Error("expected an address account");
      }
      const f: Facts = {
        walletId,
        fingerprint: Number.parseInt(info.fingerprint, 16),
        evm: evm.address,
        tron: "",
        solana: "",
        btcXpub: "",
      };
      const io = keystoneSimIo(DEVICE_SEED, deviceFingerprint);
      const w = await worldOver(wallet, () => io.io);
      const payload = await signQr(w, qrPersonal(f), { walletId, groupIndex: 0 }, io);
      expect(payload.type).toBe("eth-signature");
      expect(io.exchanges()).toBe(1);
      /* A solana request's own family is missing — the refusal is the kernel's typed
         device-required, not a QR error, so the host can fetch accounts and retry. */
      await expect(
        w.signer.prepare(
          {
            family: "solana",
            kind: "transaction",
            path: SOLANA_PATH,
            xfp: f.fingerprint,
            address: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
            data: solanaMessage("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM"),
          },
          { walletId, groupIndex: 0 },
        ),
      ).rejects.toMatchObject({ code: "device-required" });
      expect(io.exchanges()).toBe(1);
    },
  );

  it(
    "a card wallet prepares an evm qr request and exports with zero taps",
    { timeout: 60_000 },
    async () => {
      const rig = await cardRig();
      const w = await worldOver(rig.wallet, undefined);
      const apis = chains(rig.wallet);
      const [evm, bitcoin] = await Promise.all([
        apis.account({
          walletId: rig.cardWalletId,
          groupIndex: 0,
          template: "evm.bip44",
          network: EVM_MAINNET,
        }),
        apis.account({
          walletId: rig.cardWalletId,
          groupIndex: 0,
          template: "btc.bip84",
          network: BITCOIN_MAINNET,
        }),
      ]);
      if (!("address" in evm) || !("fingerprint" in bitcoin) || bitcoin.fingerprint === undefined) {
        throw new Error("expected an evm address and a bitcoin fingerprint");
      }
      const f: Facts = {
        walletId: rig.cardWalletId,
        fingerprint: Number.parseInt(bitcoin.fingerprint, 16),
        evm: evm.address,
        tron: "",
        solana: "",
        btcXpub: "",
      };
      const pending = await w.signer.prepare(qrPersonal(f), {
        walletId: rig.cardWalletId,
        groupIndex: 0,
      });
      expect(pending.method).toBe("evm-sign");
      const sentBefore = rig.reader.sent.length;
      const exported = await w.signer.exportAccount({
        account: { walletId: rig.cardWalletId, groupIndex: 0 },
        form: "crypto-multi-accounts",
        families: ["evm", "tron", "solana"],
        bitcoin: { template: "btc.bip84", network: BITCOIN_MAINNET },
        verify: CARD_VERIFY,
      });
      expect(exported.payload.type).toBe("crypto-multi-accounts");
      expect(rig.reader.sent).toHaveLength(sentBefore);
    },
  );
});
