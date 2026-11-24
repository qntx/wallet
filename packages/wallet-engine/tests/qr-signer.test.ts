import { createRequire } from "node:module";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
/**
 * The QR signer facade end to end: `qrSigner.prepare` binds a decoded request to the selected
 * account and feeds the real `RequestController`; the test's `transactions`/`solanaSign` fakes sign
 * with the wallet vector's leaf keys so `respond` can be decoded by the vendor registry classes and
 * the signature recovered to the account. The wallet itself is real (`nodeWallet`) so the account
 * facts — fingerprint, addresses — are the authenticated ones.
 */
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
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import { ethSignatureCodec } from "@qntx/ur/interop";
import { Ur, fromUr } from "@qntx/ur/typed";
import type { Wallet } from "@qntx/wallet";
import type { TaskKey, SignRequest } from "@qntx/wallet-chains";
import { assembleEvm, planEvm, decodeEvm } from "@qntx/wallet-chains/evm";
import { parseCompiledMessage } from "@qntx/wallet-chains/solana";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type { QrPayload } from "@qntx/wallet/hardware";

import vectors from "../../../vectors/qr/requests.json" with { type: "json" };
import type { WalletEngine } from "../src/engine.ts";
import { QrError, readQrRequest } from "../src/qr/index.ts";
import type { QrRequest } from "../src/qr/request.ts";
import { qrSigner } from "../src/qr/signer.ts";
import type { QrAccount } from "../src/qr/signer.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SolanaSignResult } from "../src/requests/controller.ts";
import type { SignLogEntry } from "../src/requests/sign-log.ts";
import { OriginBusyError, RequestEndedError } from "../src/requests/types.ts";
import type { SparkController } from "../src/spark/controller.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type {
  PreparedMessage,
  PreparedQrSign,
  PreparedRequest,
} from "../src/transactions/route.ts";
import { approval } from "./approval.ts";
import { MNEMONIC, VERIFY, nodeWallet } from "./apps-helpers.ts";
import { bookDeps, simulateSolanaStub, tokensStub, idleNetworkDeps } from "./send-helpers.ts";

const SEPOLIA = "eip155:11155111";
const EVM_MAINNET = "eip155:1";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON_MAINNET = "tron:728126428";
const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93";

const seed = mnemonicToSeedSync(MNEMONIC);
const master = HDKey.fromMasterSeed(seed);
const bip32Leaf = (path: string): Uint8Array => {
  const key = master.derive(path).privateKey;
  if (key === null) {
    throw new Error("no private key");
  }
  return new Uint8Array(key);
};
const evmLeaf = bip32Leaf("m/44'/60'/0'/0/0");
const evmPublic = secp256k1.getPublicKey(evmLeaf, true);
const tronLeaf = bip32Leaf("m/44'/195'/0'/0/0");
const solanaLeaf = Slip10.fromMasterSeed(seed).derive("m/44'/501'/0'/0'").privateKey;
const solanaAddr = base58.encode(ed25519.getPublicKey(solanaLeaf));
const tronAddr = tronAddressFromPublicKey(secp256k1.getPublicKey(tronLeaf, true));
const XFP = 0x73c5da0a;
const EVM_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

/** The vendor sol-sign-request vectors carry opaque bytes — a real compiled message is needed. */
const solanaMessage = (): Uint8Array =>
  new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(base58.encode(new Uint8Array(32).fill(9))),
            lastValidBlockHeight: 0n,
          },
          setTransactionMessageFeePayer(
            solanaAddressOf(solanaAddr),
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

const solanaTransactionRequest = (): QrRequest => ({
  family: "solana",
  kind: "transaction",
  path: [0x8000002c, 0x800001f5, 0x80000000, 0x80000000],
  xfp: XFP,
  address: solanaAddr,
  data: solanaMessage(),
});

/** A 65-byte r‖s‖v over `raw`'s sha256 by the tron leaf — the kernel's tron signature shape. */
const tronSign = (raw: Uint8Array): Uint8Array => {
  const sig = secp256k1.sign(sha256(raw), tronLeaf, {
    lowS: true,
    format: "recovered",
    prehash: false,
  });
  const [recid] = sig;
  if (sig.length !== 65 || recid === undefined) {
    throw new Error("bad recovered signature");
  }
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = 27 + recid;
  return out;
};

/** PlanEvm only copies the TaskKey — the signature is verified against the account address. */
const taskKey: TaskKey = {
  path: [0x8000002c, 0x8000003c, 0x80000000, 0, 0],
  publicKey: evmPublic,
};

type EvmRequest = Parameters<typeof planEvm>[0];

/** Signs the request's plan digest with the vector leaf through the kernel's plan/assemble code. */
const evmArtefact = (request: EvmRequest): Uint8Array => {
  const plan = planEvm(request, taskKey);
  const digest = plan.tasks[0]?.digest;
  if (digest === undefined) {
    throw new Error("plan produced no task");
  }
  const compact = secp256k1.sign(digest, evmLeaf, { lowS: true, prehash: false });
  const assembled = assembleEvm(plan, [compact]);
  if (assembled.kind !== "signed") {
    throw new Error("unexpected next-stage plan");
  }
  return assembled.artefact;
};

const loadRequest = (name: string): QrRequest => {
  const entry = vectors.requests.find((r) => r.name === name);
  if (entry === undefined) {
    throw new Error(`no vector ${name}`);
  }
  return readQrRequest({
    type: entry.type,
    cbor: new Uint8Array(Buffer.from(entry.cbor, "hex")),
  });
};

/* The keyring's nested registry copies — its public types name those versions. */
const require_ = createRequire(import.meta.url);
const vendorRequire = createRequire(require_.resolve("@keystonehq/base-eth-keyring/package.json"));
const { CryptoHDKey } = vendorRequire("@keystonehq/bc-ur-registry") as {
  CryptoHDKey: {
    fromCBOR: (cbor: Buffer) => {
      getName: () => string | undefined;
      getOrigin: () => { getDepth: () => number } | undefined;
    };
  };
};
const { ETHSignature } = vendorRequire("@keystonehq/bc-ur-registry-eth") as {
  ETHSignature: {
    fromCBOR: (cbor: Buffer) => {
      getRequestId: () => Buffer | undefined;
      getSignature: () => Buffer;
    };
  };
};

const ENABLED: Record<string, ReadonlyArray<string>> = {
  evm: [EVM_MAINNET, SEPOLIA],
  solana: [SOLANA_MAINNET],
  tron: [TRON_MAINNET],
  bitcoin: [BITCOIN_MAINNET],
};

const isSparkController = (_value: unknown): _value is SparkController => true;

/** Chain-only tests never reach the Spark controller; any object stands in for it. */
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
  readonly account: QrAccount;
  readonly log: () => Promise<ReadonlyArray<SignLogEntry>>;
};

const world = async (options: { clusterError?: boolean } = {}): Promise<World> => {
  const { wallet, walletId } = await nodeWallet();
  /* A previous test may have locked the shared wallet — account facts need it unlocked. */
  await wallet.vault.unlock(VERIFY).catch(() => undefined);
  const evmAccount = {
    kind: "hd" as const,
    walletId,
    groupIndex: 0,
    template: "evm.bip44" as const,
  };
  const qrPrepared = (
    request: Extract<EvmRequest, { kind: "evm.transaction" }>,
  ): PreparedQrSign => ({
    account: evmAccount,
    network: request.network,
    intent: decodeEvm(request, EVM_ADDRESS),
    signer: EVM_ADDRESS,
    checks: [],
    staleReason: () => undefined,
    release: () => undefined,
    submit: async (_verify, commit) => {
      const signedTransaction = evmArtefact(request);
      commit();
      await Promise.resolve();
      return { kind: "evm.signed-transaction", signedTransaction };
    },
  });
  const messagePrepared = (
    request: Extract<EvmRequest, { kind: "evm.personal-message" | "evm.typed-data" }>,
  ): PreparedMessage => ({
    account: evmAccount,
    network: request.network,
    intent: decodeEvm(request, EVM_ADDRESS),
    signer: EVM_ADDRESS,
    checks: [],
    staleReason: () => undefined,
    release: () => undefined,
    submit: async () => {
      const signature = evmArtefact(request);
      await Promise.resolve();
      return { kind: request.kind, signature };
    },
  });
  const transactions = {
    getState: () => ({ txs: {} }),
    bindDappSolana: async () => {
      if (options.clusterError === true) {
        const { SolanaClusterBindingError } = await import("../src/transactions/solana.ts");
        throw new SolanaClusterBindingError("genesis-mismatch", "cluster mismatch");
      }
      return Promise.resolve([]);
    },
    prepareQrEvm: async (_a: never, request: SignRequest) => {
      await Promise.resolve();
      if (request.kind !== "evm.transaction") {
        throw new Error("expected an evm transaction");
      }
      return qrPrepared(request);
    },
    prepareDapp: async (_a: never, request: SignRequest): Promise<PreparedMessage> => {
      await Promise.resolve();
      if (request.kind !== "evm.personal-message" && request.kind !== "evm.typed-data") {
        throw new Error("expected an evm message");
      }
      return messagePrepared(request);
    },
    prepareDappTron: async (
      _a: never,
      request: { kind: string; rawData?: Uint8Array },
      options?: { broadcast: false },
    ): Promise<PreparedRequest | PreparedMessage | PreparedQrSign> => {
      await Promise.resolve();
      if (request.kind === "tron.transaction" && options?.broadcast === false) {
        return {
          account: {
            kind: "hd",
            walletId,
            groupIndex: 0,
            template: "tron.bip44",
          },
          network: TRON_MAINNET,
          intent: {
            family: "tron",
            network: TRON_MAINNET,
            summary: "contract-call",
            outflows: [],
            approvals: [],
            fee: undefined,
            warnings: [],
            verifiability: "full",
          },
          signer: tronAddr,
          checks: [],
          staleReason: () => undefined,
          release: () => undefined,
          submit: async (_verify, commit) => {
            if (request.rawData === undefined) {
              throw new Error("no raw data");
            }
            const signature = tronSign(request.rawData);
            commit();
            await Promise.resolve();
            return { kind: "tron.signed-transaction", signature };
          },
        };
      }
      throw new Error("a dApp tron request is not wired in this test");
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
    bitcoinPrepare: async () => {
      await Promise.resolve();
      throw new Error("unused");
    },
    bitcoinSignPsbts: async () => {
      await Promise.resolve();
      throw new Error("unused");
    },
    bitcoinSign: async () => {
      await Promise.resolve();
      throw new Error("unused");
    },
    solanaSign: async (account, _network, request, _verify, commit): Promise<SolanaSignResult> => {
      if (request.kind === "transactions") {
        const [wire] = request.transactions;
        if (wire === undefined) {
          throw new Error("no wire");
        }
        const [count] = wire;
        if (count === undefined) {
          throw new Error("no signature count");
        }
        const message = parseCompiledMessage(wire.subarray(1 + 64 * count));
        const index = message.staticAccounts.slice(0, count).indexOf(account.address);
        if (index === -1) {
          throw new Error("the account is not a required signer");
        }
        const signed = new Uint8Array(wire);
        signed.set(ed25519.sign(wire.subarray(1 + 64 * count), solanaLeaf), 1 + 64 * index);
        commit();
        await Promise.resolve();
        return { kind: "solana.transactions", signedTransactions: [signed], send: false };
      }
      commit();
      await Promise.resolve();
      return { kind: "solana.message", signature: ed25519.sign(request.message, solanaLeaf) };
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
  return {
    wallet,
    requests,
    signer: qrSigner({ engine, wallet }),
    account: { walletId, groupIndex: 0 },
    log: async () => requests.signLog(),
  };
};

describe("qrSigner", () => {
  it(
    "signs a QR transaction through the pipeline and answers in the counterpart's UR",
    { timeout: 60_000 },
    async () => {
      const w = await world();
      const scanned = loadRequest("evm-1559-transfer");
      const pending = await w.signer.prepare(scanned, w.account);
      expect(pending.method).toBe("evm-sign");
      expect(pending.origin).toStrictEqual({ kind: "qr" });
      await w.requests.approve(pending.id, "evm-sign", approval(pending, VERIFY));
      const payload = await w.signer.respond(pending.id);
      expect(payload.type).toBe("eth-signature");
      const decoded = ETHSignature.fromCBOR(Buffer.from(payload.cbor));
      expect(decoded.getRequestId()).toBeDefined();
      expect(decoded.getSignature()).toHaveLength(65);
    },
  );

  it(
    "signs a personal message and the sign log records only the qr origin kind",
    { timeout: 60_000 },
    async () => {
      const w = await world();
      const pending = await w.signer.prepare(loadRequest("evm-personal-message"), w.account);
      await w.requests.approve(pending.id, "evm-sign", approval(pending, VERIFY));
      const payload: QrPayload = await w.signer.respond(pending.id);
      expect(payload.type).toBe("eth-signature");
      const [entry] = await w.log();
      expect(entry?.origin).toStrictEqual({ kind: "qr" });
    },
  );

  it(
    "signs a Solana transaction the account is a required signer of",
    { timeout: 60_000 },
    async () => {
      const w = await world();
      const pending = await w.signer.prepare(solanaTransactionRequest(), w.account);
      expect(pending.method).toBe("solana-sign");
      await w.requests.approve(pending.id, "solana-sign", approval(pending, VERIFY));
      const payload = await w.signer.respond(pending.id);
      expect(payload.type).toBe("sol-signature");
    },
  );

  it(
    "signs a TRON transaction for the counterpart to broadcast itself",
    { timeout: 60_000 },
    async () => {
      const w = await world();
      const pending = await w.signer.prepare(loadRequest("tron-transaction"), w.account);
      expect(pending.method).toBe("tron-sign");
      await w.requests.approve(pending.id, "tron-sign", approval(pending, VERIFY));
      const payload = await w.signer.respond(pending.id);
      expect(payload.type).toBe("tron-signature");
    },
  );

  it(
    "the response carries only the counterpart's fields — no origin or device data",
    { timeout: 60_000 },
    async () => {
      const w = await world();
      const pending = await w.signer.prepare(loadRequest("evm-personal-message"), w.account);
      await w.requests.approve(pending.id, "evm-sign", approval(pending, VERIFY));
      const payload = await w.signer.respond(pending.id);
      const decoded = fromUr(
        Ur.fromCborData(payload.type, payload.cbor),
        ethSignatureCodec,
      ) as Record<string, unknown>;
      expect(Object.keys(decoded).toSorted()).toStrictEqual(["requestId", "signature"]);
    },
  );

  it(
    "a second QR request while one is in flight hits the shared busy key",
    { timeout: 60_000 },
    async () => {
      const w = await world();
      await w.signer.prepare(loadRequest("evm-1559-transfer"), w.account);
      await expect(w.signer.prepare(loadRequest("evm-legacy-transfer"), w.account)).rejects.toThrow(
        OriginBusyError,
      );
    },
  );

  it(
    "an unbindable request is unbound once every candidate's cluster binding refused",
    { timeout: 60_000 },
    async () => {
      const w = await world({ clusterError: true });
      await expect(w.signer.prepare(solanaTransactionRequest(), w.account)).rejects.toMatchObject({
        code: "unbound",
      });
    },
  );

  it("an unknown wallet cannot sign QR requests", { timeout: 60_000 }, async () => {
    const w = await world();
    await expect(
      w.signer.prepare(loadRequest("evm-1559-transfer"), { walletId: "nope", groupIndex: 0 }),
    ).rejects.toThrow(QrError);
    await expect(
      w.signer.prepare(loadRequest("evm-1559-transfer"), { walletId: "nope", groupIndex: 0 }),
    ).rejects.toMatchObject({ code: "wallet-unsupported" });
  });

  it(
    "exports the account's public material as a crypto-hdkey a vendor reader parses",
    { timeout: 60_000 },
    async () => {
      const w = await world();
      const exported = await w.signer.exportAccount({
        account: w.account,
        form: "crypto-hdkey",
        verify: VERIFY,
      });
      expect(exported.payload.type).toBe("crypto-hdkey");
      expect(exported.discloses).toBe("evm-all-addresses");
      const hd = CryptoHDKey.fromCBOR(Buffer.from(exported.payload.cbor));
      expect(hd.getName()).toBe("qntx");
      expect(hd.getOrigin()?.getDepth()).toBe(3);
    },
  );

  it(
    "respond after the request was rejected rejects with the pipeline's RequestEndedError",
    { timeout: 60_000 },
    async () => {
      const w = await world();
      const pending = await w.signer.prepare(loadRequest("evm-1559-transfer"), w.account);
      w.requests.reject(pending.id);
      await expect(w.signer.respond(pending.id)).rejects.toThrow(RequestEndedError);
    },
  );

  it(
    "a second respond for the same request fails — the bound entry is consumed",
    { timeout: 60_000 },
    async () => {
      /* `outcome` still resolves for a finished request, so only the deleted bound entry stops
         a second respond from re-encoding the same answer under a spent binding. */
      const w = await world();
      const pending = await w.signer.prepare(loadRequest("evm-1559-transfer"), w.account);
      await w.requests.approve(pending.id, "evm-sign", approval(pending, VERIFY));
      await w.signer.respond(pending.id);
      await expect(w.signer.respond(pending.id)).rejects.toMatchObject({
        code: "result-mismatch",
      });
    },
  );
});
