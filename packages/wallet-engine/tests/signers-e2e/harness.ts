/**
 * The signers e2e harness: a real engine `world` over a caller-provided (or shared node) wallet,
 * hermetic stub RPCs for all four send families — an eip155 EVM endpoint (1559), an esplora
 * endpoint, a Solana JSON-RPC endpoint and a TRON HTTP API — a fixed clock and a broadcast catcher.
 * `sendOnce` runs an engine send (prepare → approve with the verify factor → broadcast) and the
 * `verify*` helpers check the caught wire bytes with independent libraries, never the wallet's own
 * transaction code: viem for EVM, @scure/btc-signer + @noble/curves for Bitcoin,
 *
 * @solana/kit + @noble/curves for Solana, and tronweb's generated protobufs + @noble for TRON.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58, createBase58check } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { Address, NETWORK, OutScript, Transaction } from "@scure/btc-signer";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import {
  getTransferSolInstructionDataDecoder,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import {
  AccountRole,
  address as solAddress,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getInstructionsFromCompiledTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { parseTransaction, recoverTransactionAddress } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { ethSignatureCodec, solSignatureCodec, tronSignatureCodec } from "@qntx/ur/interop";
import { cryptoPsbtCodec } from "@qntx/ur/registry";
import { Ur, fromUr } from "@qntx/ur/typed";
import type { VerifyFactor, Wallet } from "@qntx/wallet";
import { bitcoinAddressFromXpub, bitcoinPubkeyFromXpub } from "@qntx/wallet-chains/bitcoin";
import { tronAddressToHex, tronRawDataFromJson } from "@qntx/wallet-chains/tron";
import type { ChainTemplate } from "@qntx/wallet/chains";

import { scripthash } from "../../src/chains/bitcoin-scan.ts";
import { dappLanes } from "../../src/chains/dapp-lanes.ts";
import { BitcoinWalletHandler } from "../../src/connect/bitcoin.ts";
import { ConnectionController } from "../../src/connect/controller.ts";
import type { AccountGroup, PendingConnection } from "../../src/connect/controller.ts";
import { Eip1193Handler } from "../../src/connect/eip1193.ts";
import { SolanaWalletHandler } from "../../src/connect/solana.ts";
import { TronWalletHandler } from "../../src/connect/tron.ts";
import type { EngineOptions } from "../../src/engine.ts";
import type { ApproveOptions } from "../../src/index.ts";
import { readQrExport, qrSignRequest, readQrSignature } from "../../src/qr/counterpart.ts";
import type { QrSignInput } from "../../src/qr/counterpart.ts";
import { readQrRequest } from "../../src/qr/request.ts";
import { qrSigner } from "../../src/qr/signer.ts";
import type { QrEngineSurface } from "../../src/qr/signer.ts";
import type { RequestResult } from "../../src/requests/controller.ts";
import type { RequestMethod } from "../../src/requests/types.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import type { SendParams, TrackedTransaction } from "../../src/transactions/route.ts";
import { approval } from "../approval.ts";
import { manualTimer, until, VERIFY, world } from "../apps-helpers.ts";

/* tronweb's exports map exposes only the client entrypoints; its generated protobufs are the
 * independent TRON decode oracle, loaded by absolute path past that map. */
const require = createRequire(import.meta.url);
/* The pb files sit under the package's exports map — reach them by resolved path. */
const tronLib = (file: string): string => join(dirname(require.resolve("tronweb")), file);
type TronTransaction = {
  getRawData: () => {
    serializeBinary: () => Uint8Array;
    getContractList: () => Array<{
      getParameter: () => { getTypeUrl: () => string; getValue: () => Uint8Array } | undefined;
    }>;
  };
  getSignatureList: () => Uint8Array[];
};
const tronProtoModule: unknown = require(tronLib("protocol/core/Tron_pb.cjs"));
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generated module is untyped
const tronProto = tronProtoModule as {
  Transaction: { deserializeBinary: (b: Uint8Array) => TronTransaction };
};
const tronBalanceModule: unknown = require(
  tronLib("protocol/core/contract/balance_contract_pb.cjs"),
);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generated module is untyped
const tronBalance = tronBalanceModule as {
  TransferContract: {
    deserializeBinary: (b: Uint8Array) => {
      getOwnerAddress: () => Uint8Array;
      getToAddress: () => Uint8Array;
      getAmount: () => number;
    };
  };
};

const base58check = createBase58check(sha256);
const b58decode = getBase58Decoder();
const addrEncode = getAddressEncoder();

export const EVM_NETWORK = "eip155:42161";
export const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
export const SOL_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const TRON_NETWORK = "tron:728126428";

export const EVM_TO = "0x2222222222222222222222222222222222222222";
export const BTC_TO = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
export const SOL_TO = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
export const TRON_TO = "TT2T17KZhoDu47i2E4FWxfG79zdkEWkU9N";

/** One fixed wall clock for engine, timers and stubbed heads. */
export const T0 = 1_700_000_000_000;

export type CaughtBroadcast = {
  readonly family: "evm" | "bitcoin" | "solana" | "tron";
  readonly bytes: Uint8Array;
};

export type E2eWorld = Awaited<ReturnType<typeof e2eWorld>>;

/* ------------------------------------------------------------------ Bitcoin stub state --- */

const BTC_GENESIS = "000000000019d6689c085ae165831e934b763f46a2a6c172b3f1b60a8ce26f";
const BTC_TIP = 800_000;
const BLOCK_HASH = "00".repeat(32);

export type FundedUtxo = {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly address: string;
  /** The synthetic funding transaction's bytes — a spend's `nonWitnessUtxo` must match it. */
  readonly funding: Uint8Array;
};

type BtcStub = {
  readonly utxos: Map<string, ReadonlyArray<Record<string, unknown>>>;
  readonly txs: Map<string, ReadonlyArray<Record<string, unknown>>>;
  readonly hexes: Map<string, string>;
  readonly funded: Map<string, FundedUtxo>;
};

const scriptOf = (address: string): Uint8Array =>
  OutScript.encode(Address(NETWORK).decode(address));

/** A synthetic confirmed funding tx paying `address` `value` sats — the esplora stub serves it. */
const fundBtc = (btc: BtcStub, address: string, value: number): FundedUtxo => {
  const tx = new Transaction({ lockTime: 0 });
  tx.addInput({ txid: new Uint8Array(32), index: 0xffffffff, sequence: 0 });
  tx.addOutputAddress(address, BigInt(value), NETWORK);
  const utxo: FundedUtxo = { txid: tx.id, vout: 0, value, address, funding: tx.toBytes() };
  const hash = scripthash(address, NETWORK);
  const status = { confirmed: true, block_height: BTC_TIP, block_hash: BLOCK_HASH };
  btc.utxos.set(hash, [{ txid: utxo.txid, vout: 0, value, status }]);
  btc.txs.set(hash, [
    {
      txid: utxo.txid,
      vin: [
        {
          prevout: { scriptpubkey_address: address },
          txid: "00".repeat(32),
          vout: 0xffffffff,
        },
      ],
      vout: [
        {
          scriptpubkey: bytesToHex(scriptOf(address)),
          scriptpubkey_address: address,
          value,
        },
      ],
      status,
    },
  ]);
  btc.hexes.set(utxo.txid, tx.hex);
  btc.funded.set(hash, utxo);
  return utxo;
};

/* ------------------------------------------------------------------------- narrowing --- */

const arr = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : []);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const rec = (v: unknown): Record<string, unknown> | undefined => (isRecord(v) ? v : undefined);

const json = (body: unknown): Response => Response.json(body);
const text = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/plain" } });

/* --------------------------------------------------------------------- stub upstreams --- */

const esploraAnswer = (
  path: string,
  init: RequestInit | undefined,
  btc: BtcStub,
  caught: CaughtBroadcast[],
): Response => {
  if (path === "/block-height/0") {
    return text(BTC_GENESIS);
  }
  if (path === "/blocks/tip/height") {
    return text(String(BTC_TIP));
  }
  if (path === "/fee-estimates") {
    return json({ "1": 10, "3": 5, "6": 3, "144": 1, "504": 1, "1008": 1 });
  }
  if (path === "/tx" && init?.method === "POST") {
    const body = typeof init.body === "string" ? init.body : "";
    caught.push({ family: "bitcoin", bytes: hexToBytes(body) });
    return text(Transaction.fromRaw(hexToBytes(body)).id);
  }
  const hashMatch = /^\/scripthash\/([0-9a-f]{64})\/(utxo|txs)$/.exec(path);
  if (hashMatch !== null) {
    const hash = hashMatch[1] ?? "";
    return json(hashMatch[2] === "utxo" ? (btc.utxos.get(hash) ?? []) : (btc.txs.get(hash) ?? []));
  }
  const txMatch = /^\/tx\/([0-9a-f]{64})(\/(status|hex|outspends))?$/.exec(path);
  if (txMatch === null) {
    throw new Error(`unstubbed esplora ${path}`);
  }
  const txid = txMatch[1] ?? "";
  const funded = [...btc.funded.values()].find((f) => f.txid === txid);
  if (txMatch[3] === "status") {
    return json({ confirmed: true, block_height: BTC_TIP, block_hash: BLOCK_HASH });
  }
  if (txMatch[3] === "hex") {
    const hex = btc.hexes.get(txid);
    return hex === undefined ? new Response("not found", { status: 404 }) : text(hex);
  }
  if (txMatch[3] === "outspends") {
    return json(funded === undefined ? [] : [{ spent: false }]);
  }
  if (funded === undefined) {
    return new Response("not found", { status: 404 });
  }
  return json({
    txid,
    vin: [
      {
        prevout: { scriptpubkey_address: funded.address },
        txid: "00".repeat(32),
        vout: 0xffffffff,
      },
    ],
    vout: [
      {
        scriptpubkey: bytesToHex(scriptOf(funded.address)),
        scriptpubkey_address: funded.address,
        value: funded.value,
      },
    ],
    status: { confirmed: true, block_height: BTC_TIP, block_hash: BLOCK_HASH },
  });
};

const SOL_BLOCKHASH = b58decode.decode(new Uint8Array(32).fill(7));

const solanaAnswer = (body: Record<string, unknown>, caught: CaughtBroadcast[]): unknown => {
  const method = str(body["method"]) ?? "";
  const params = arr(body["params"]);
  switch (method) {
    case "getGenesisHash":
      return SOL_NETWORK.split(":")[1];
    case "getLatestBlockhash":
      return {
        context: { slot: 1000 },
        value: { blockhash: SOL_BLOCKHASH, lastValidBlockHeight: 200_000 },
      };
    case "getRecentPrioritizationFees":
      return [];
    case "getBalance":
      return { context: { slot: 1 }, value: 10_000_000_000 };
    case "getMultipleAccounts":
      return { context: { slot: 1 }, value: arr(params[0]).map(() => null) };
    case "getAccountInfo":
      return { context: { slot: 1 }, value: null };
    case "simulateTransaction": {
      const watched = rec(params[1])?.["accounts"];
      const addresses = rec(watched)?.["addresses"];
      return {
        context: { slot: 1 },
        value: {
          err: null,
          accounts: arr(addresses).map(() => null),
          unitsConsumed: 5000,
          logs: [],
          returnData: null,
          innerInstructions: null,
        },
      };
    }
    case "sendTransaction": {
      const bytes = new Uint8Array(Buffer.from(str(params[0]) ?? "", "base64"));
      caught.push({ family: "solana", bytes });
      /* The first signature in the wire format is the txid. */
      return b58decode.decode(bytes.subarray(1, 65));
    }
    case "getSignatureStatuses":
      return {
        context: { slot: 1 },
        value: [{ slot: 100, confirmations: null, err: null, confirmationStatus: "finalized" }],
      };
    case "getEpochInfo":
      return {
        absoluteSlot: 100,
        blockHeight: 90,
        epoch: 2,
        slotIndex: 1,
        slotsInEpoch: 432_000,
      };
    case "getBlockHeight":
      return 90;
    case "isBlockhashValid":
      return { context: { slot: 1 }, value: true };
    case "getFeeForMessage":
      return { context: { slot: 1 }, value: 5000 };
    default:
      throw new Error(`unstubbed solana ${method}`);
  }
};

const TRON_HEAD_ID = bytesToHex(sha256(new Uint8Array(32).fill(9)));
const TRON_CHAIN_PARAMS = {
  chainParameter: [
    { key: "getTransactionFee", value: 1000 },
    { key: "getEnergyFee", value: 100 },
    { key: "getCreateAccountFee", value: 100_000 },
    { key: "getCreateNewAccountFeeInSystemContract", value: 1_000_000 },
    { key: "getMaxFeeLimit", value: 15_000_000_000 },
    { key: "getCreateNewAccountBandwidthRate", value: 0 },
    { key: "getMaxCreateAccountTxSize", value: 1000 },
    { key: "getMemoFee", value: 1_000_000 },
  ],
};

const tronBlock = (num: number): Record<string, unknown> => ({
  blockID: TRON_HEAD_ID,
  block_header: {
    raw_data: {
      number: num,
      timestamp: T0,
      version: 32,
      txTrieRoot: "0".repeat(64),
      parentHash: "0".repeat(64),
      witness_address: `41${"0".repeat(40)}`,
      witness_signature: "0",
    },
  },
});

const tronAnswer = (
  path: string,
  body: Record<string, unknown>,
  caught: CaughtBroadcast[],
): unknown => {
  switch (path) {
    case "/wallet/getnowblock":
    case "/walletsolidity/getnowblock":
      return tronBlock(800);
    case "/wallet/getblockbynum":
    case "/walletsolidity/getblockbynum":
      return tronBlock(typeof body["num"] === "number" ? body["num"] : 0);
    case "/wallet/getchainparameters":
      return TRON_CHAIN_PARAMS;
    case "/wallet/getaccount":
      /* Every account the stub knows is activated; the sender just happens to be funded. */
      return { address: str(body["address"]) ?? "", balance: 100_000_000_000_000, type: "Normal" };
    case "/wallet/getaccountresource":
      return { freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 };
    case "/wallet/broadcasthex": {
      const bytes = hexToBytes(str(body["transaction"]) ?? "");
      caught.push({ family: "tron", bytes });
      const tx = tronProto.Transaction.deserializeBinary(bytes);
      return { result: true, txid: bytesToHex(sha256(tx.getRawData().serializeBinary())) };
    }
    default:
      throw new Error(`unstubbed tron ${path}`);
  }
};

/* ----------------------------------------------------------------------- EVM answers --- */

const word = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;

const evmAnswer = (method: string, params: unknown, caught: CaughtBroadcast[]): unknown => {
  const base: Record<string, unknown> = {
    eth_chainId: "0xa4b1",
    eth_blockNumber: "0x2dc6c0",
    eth_getTransactionCount: "0x0",
    eth_estimateGas: "0x5208",
    eth_feeHistory: { baseFeePerGas: ["0x64"], reward: [["0x1", "0x1", "0x1"]] },
    eth_getCode: "0x",
    eth_getBalance: "0x3635c9adc5dea00000",
    eth_gasPrice: "0x64",
    eth_getTransactionByHash: null,
    eth_getTransactionReceipt: null,
  };
  if (method === "eth_getBlockByNumber") {
    return {
      number: "0x2dc6c0",
      baseFeePerGas: "0x64",
      gasLimit: "0x1c9c380",
      timestamp: "0x1",
    };
  }
  if (method === "eth_call") {
    return word(0n);
  }
  if (method === "eth_simulateV1") {
    return {
      status: "ok",
      blocks: [
        {
          calls: [{ status: "0x1", gasUsed: "0x5208", logs: [] }],
          assetChanges: [],
          balanceChanges: [],
        },
      ],
    };
  }
  if (method === "eth_sendRawTransaction") {
    const raw = str(arr(params)[0]) ?? "";
    caught.push({ family: "evm", bytes: hexToBytes(raw.replace(/^0x/, "")) });
    return bytesToHex(keccak_256(hexToBytes(raw.replace(/^0x/, ""))));
  }
  if (!(method in base)) {
    throw new Error(`unstubbed evm ${method}`);
  }
  return base[method];
};

/* ----------------------------------------------------------------------------- world --- */

/* ------------------------------------------------------------------------- dApp layer --- */

/** The dApp origin every connect-session and sign call in this harness is attributed to. */
export const SITE = "https://dapp.example";

export type DappLayer = {
  /** Bind the next connect session's scopes to this account group. */
  readonly select: (group: AccountGroup | undefined) => void;
  readonly connections: ConnectionController;
  readonly eip1193: Eip1193Handler;
  readonly solanaWallet: SolanaWalletHandler;
  readonly bitcoinWallet: BitcoinWalletHandler;
  readonly tronWallet: TronWalletHandler;
};

/**
 * The real connect layer over the world's controllers: sessions bind to `select`'d group exactly
 * the way the engine binds them to `accounts.selected`, and the four Wallet Standard handlers sit
 * on the same `requests`/`signers` the internal send drives.
 */
const buildDapp = async (w: Awaited<ReturnType<typeof world>>): Promise<DappLayer> => {
  let selected: AccountGroup | undefined;
  const { apis } = w.signers;
  const addressAccount = async (
    group: AccountGroup,
    template: ChainTemplate,
    network: string,
  ): Promise<string> => {
    const account = await apis.account({
      walletId: group.walletId,
      groupIndex: group.groupIndex,
      template,
      network,
    });
    if (!("address" in account) || account.address === undefined) {
      throw new Error(`no address for ${template}`);
    }
    return account.address;
  };
  const bitcoinAccount = async (
    group: AccountGroup,
    network: string,
    purpose: "payment" | "ordinals",
  ): Promise<{ address: string; publicKey: Uint8Array }> => {
    const template = purpose === "payment" ? "btc.bip84" : "btc.bip86";
    const account = await apis.account({ ...group, template, network });
    if (!("xpub" in account) || account.xpub === undefined) {
      throw new Error("no Bitcoin account for the group");
    }
    return {
      address: bitcoinAddressFromXpub(account.xpub, template, network, 0, 0),
      publicKey: bitcoinPubkeyFromXpub(account.xpub, template, network, 0, 0),
    };
  };
  const connections = new ConnectionController({
    // oxlint-disable-next-line typescript/require-await -- the openStore option requires an async accessor
    openStore: async () => createMemoryEngineStore(),
    random: (n) => new Uint8Array(n).fill(7),
    now: () => w.timers.time,
    logger: { warn: () => undefined },
    allowLocalhost: false,
    selectedGroup: () => selected,
    evmAddress: async (group, network) => addressAccount(group, "evm.bip44", network),
    solanaAddress: async (group, network) => addressAccount(group, "solana.bip44-change", network),
    tronAddress: async (group, network) => addressAccount(group, "tron.bip44", network),
    bitcoinAddress: async (group, network, purpose) => {
      const account = await bitcoinAccount(group, network, purpose);
      return account.address;
    },
    enabledNetworks: () => [EVM_NETWORK, SOL_NETWORK, TRON_NETWORK, BTC_NETWORK],
    nostrPubkey: async () => {
      await Promise.resolve();
      throw new Error("nostr is not wired in this harness");
    },
    invalidate: (origin) => w.requests.invalidateOrigin(origin),
    onSelectedGroup: () => () => undefined,
    invalidateAll: () => w.requests.invalidateAll(),
    phishing: { check: () => "clear" },
    setTimer: w.timers.setTimer,
  });
  const eip1193 = new Eip1193Handler({
    connections,
    requests: w.requests,
    networks: w.networks,
    defaultNetwork: () => EVM_NETWORK,
    isTracked: () => false,
    delegationState: async (account, network) => w.transactions.delegationState(account, network),
    batches: {
      record: async (record) => w.transactions.recordBatch(record),
      get: (origin, id) => w.transactions.batchById(origin, id),
    },
    txById: (id) => w.transactions.txById(id),
    showCallsStatus: () => undefined,
    now: () => w.timers.time,
    random: (n) => new Uint8Array(n).fill(7),
  });
  const solanaWallet = new SolanaWalletHandler({
    connections,
    requests: w.requests,
    solanaAccount: async (group, network) => {
      const account = await apis.account({
        ...group,
        template: "solana.bip44-change",
        network,
      });
      if (!("address" in account) || account.address === undefined) {
        throw new Error("no Solana account for the group");
      }
      return { address: account.address, publicKey: base58.decode(account.address) };
    },
    solanaNetwork: () => SOL_NETWORK,
  });
  const bitcoinWallet = new BitcoinWalletHandler({
    connections,
    requests: w.requests,
    bitcoinAccount,
    bitcoinNetwork: () => BTC_NETWORK,
  });
  const tronWallet = new TronWalletHandler({
    connections,
    requests: w.requests,
    transactions: w.transactions,
    tronNetworks: () => [TRON_NETWORK],
    tronNetwork: () => TRON_NETWORK,
    isTracked: () => false,
  });
  await connections.init();
  return {
    select: (group) => {
      selected = group;
    },
    connections,
    eip1193,
    solanaWallet,
    bitcoinWallet,
    tronWallet,
  };
};

/**
 * A world whose stub upstreams answer every family: BTC/SOL/TRON over the injected fetch, EVM via
 * `arb1`. `fund` credits a P2WPKH address with a confirmed UTXO; `caught` collects every
 * broadcast's wire bytes. `dapp` is the real connect layer and `signer` the QR facade — the three
 * origins every backend matrix cell drives.
 */
export const e2eWorld = async (options: {
  readonly wallet?: { wallet: Wallet; walletId: string };
  readonly deviceIo?: EngineOptions["deviceIo"];
}): Promise<{
  readonly w: Awaited<ReturnType<typeof world>>;
  readonly dapp: DappLayer;
  readonly signer: ReturnType<typeof qrSigner>;
  readonly caught: CaughtBroadcast[];
  readonly fund: (address: string, sats: number) => FundedUtxo;
}> => {
  const caught: CaughtBroadcast[] = [];
  const btc: BtcStub = { utxos: new Map(), txs: new Map(), hexes: new Map(), funded: new Map() };
  const w = await world(0, {
    ...(options.wallet === undefined ? {} : { wallet: options.wallet }),
    deviceIo: options.deviceIo,
    hyperliquid: false,
    timers: manualTimer(T0),
    requestOptions: dappLanes,
    arb1: async ({ method, params }) => {
      await Promise.resolve();
      return evmAnswer(method, params, caught);
    },
    rpc: {
      [BTC_NETWORK]: ["https://esplora.test"],
      [SOL_NETWORK]: ["https://solana.test/rpc"],
      [TRON_NETWORK]: ["https://tron.test"],
    },
    fetch: async (input, init) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://esplora.test")) {
        return esploraAnswer(url.slice("https://esplora.test".length), init, btc, caught);
      }
      if (url === "https://solana.test/rpc") {
        return json({
          jsonrpc: "2.0",
          id: 1,
          result: solanaAnswer(rec(JSON.parse(str(init?.body) ?? "{}")) ?? {}, caught),
        });
      }
      if (url.startsWith("https://tron.test")) {
        return json(
          tronAnswer(
            url.slice("https://tron.test".length),
            rec(JSON.parse(str(init?.body) ?? "{}")) ?? {},
            caught,
          ),
        );
      }
      throw new Error(`unstubbed fetch ${url}`);
    },
  });
  const dapp = await buildDapp(w);
  /* The QR facade over the same controllers the engine hands it: `requests` for the pipeline,
     `networks.enabled` for request routing and `signers.apis` for the account/verification seam. */
  const engine: QrEngineSurface = {
    requests: w.requests,
    networks: w.networks,
    signers: { apis: w.signers.apis },
  };
  const signer = qrSigner({ engine, wallet: w.wallet });
  return { w, dapp, signer, caught, fund: (address, sats) => fundBtc(btc, address, sats) };
};

/**
 * The receive address at `index` of a BTC account-level xpub (chain 0) — what `chains().account`
 * hands back for bitcoin templates is the xpub, so tests and the recorder derive the funded address
 * the same way.
 */
export const btcAddressFromXpub = (xpub: string, index = 0): string => {
  const pub = HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(index).publicKey;
  if (pub === undefined || pub === null) {
    throw new Error(`no public key under ${xpub}`);
  }
  return p2wpkh(pub, NETWORK).address;
};

/**
 * Per-backend hooks the matrix drivers call around every pipeline approval: `beforeApprove` runs
 * right before `requests.approve` (queue the card's access code — a held input request never sees a
 * later push), `duringApprove` runs after approve is kicked off and before it is awaited (answer
 * the card's tap step), and `beforeCell` runs at the start of each matrix cell (open the right
 * Ledger app, switch the replay phase).
 */
export type MatrixHooks = {
  readonly beforeApprove?: (w: E2eWorld["w"]) => void;
  readonly duringApprove?: (w: E2eWorld["w"]) => Promise<void>;
  readonly beforeCell?: (origin: "internal" | "dapp" | "qr", family: MatrixFamily) => void;
};

/** One engine send through the request pipeline: prepare → approve → broadcast → returns tracked. */
export const sendOnce = async (
  w: E2eWorld["w"],
  params: Omit<SendParams, "verify">,
  verify: ApproveOptions["verify"] = VERIFY,
  hooks?: MatrixHooks,
): Promise<TrackedTransaction> => {
  const request = await w.requests.prepare({ method: "send", ...params });
  expect(request.stage).toBe("awaiting-approval");
  hooks?.beforeApprove?.(w);
  const approving = w.requests.approve(request.id, "send", approval(request, verify));
  await hooks?.duringApprove?.(w);
  return approving;
};

/** The caught broadcast of one family — asserts exactly one was made. */
export const caughtOne = (
  caught: CaughtBroadcast[],
  family: CaughtBroadcast["family"],
): Uint8Array => {
  const matches = caught.filter((c) => c.family === family);
  expect(matches).toHaveLength(1);
  return matches[0]?.bytes ?? new Uint8Array();
};

/**
 * Watches the signers activity over a send: subscribe before `sendOnce`, then assert `steps`
 * contains `starting`, a device step and the final `cleared`.
 */
export const watchSignerActivity = (
  w: E2eWorld["w"],
): { readonly steps: string[]; readonly stop: () => void } => {
  const steps: string[] = [];
  const stop = w.signers.store.subscribe((state) => {
    const step = state.active?.step;
    steps.push(step === undefined ? "cleared" : step.kind);
  });
  return { steps, stop };
};

/* --------------------------------------------------------------------------- verifiers --- */

const eip1559 = (bytes: Uint8Array): `0x02${string}` => {
  expect(bytes[0]).toBe(0x02);
  return `0x02${bytesToHex(bytes.subarray(1))}`;
};

/** Viem: parse the 1559 wire tx and recover the signer — to/value/chainId must match. */
export const verifyEvm = async (
  bytes: Uint8Array,
  expected: { readonly from: string; readonly to: string; readonly amount: bigint },
): Promise<void> => {
  const serialized = eip1559(bytes);
  const tx = parseTransaction(serialized);
  expect(tx.type).toBe("eip1559");
  expect(tx.to?.toLowerCase()).toBe(expected.to.toLowerCase());
  expect(tx.value).toBe(expected.amount);
  expect(tx.chainId).toBe(42161);
  const recovered = await recoverTransactionAddress({ serializedTransaction: serialized });
  expect(recovered.toLowerCase()).toBe(expected.from.toLowerCase());
};

/**
 * @scure/btc-signer + noble secp256k1: recompute each input's BIP-143 sighash and verify the
 * witness signature against the witness pubkey — the p2wpkh address of that key must be the
 * account's. Outputs must carry the recipient amount.
 */
export const verifyBtc = (
  bytes: Uint8Array,
  expected: {
    readonly fromAddress: string;
    readonly to: string;
    readonly amount: bigint;
    readonly inputSats: bigint;
  },
): void => {
  const tx = Transaction.fromRaw(bytes, { allowUnknownInputs: true });
  expect(tx.inputsLength).toBeGreaterThan(0);
  for (let i = 0; i < tx.inputsLength; i += 1) {
    const input = tx.getInput(i);
    const witness = input.finalScriptWitness;
    expect(witness).toBeDefined();
    const sigWithType = witness?.[0];
    const pubkey = witness?.[1];
    if (sigWithType === undefined || pubkey === undefined || witness?.length !== 2) {
      throw new Error("p2wpkh witness must be [sig, pubkey]");
    }
    const sigBytes = new Uint8Array(sigWithType);
    const sighashType = sigBytes.at(-1);
    expect(sighashType).toBe(0x01);
    /* The funded stub pays exactly one output to one key — every input spends inputSats.
       BIP-143 signs the p2pkh scriptCode, not the witness program (scure's own sign path). */
    const program = OutScript.decode(scriptOf(expected.fromAddress));
    if (program.type !== "wpkh") {
      throw new Error("funded address must be p2wpkh");
    }
    /* preimageWitnessV0 returns the finalized double-sha256 digest, not the raw preimage. */
    const sighash = tx.preimageWitnessV0(
      i,
      OutScript.encode({ type: "pkh", hash: program.hash }),
      0x01,
      expected.inputSats,
    );
    const sig = secp256k1.Signature.fromBytes(sigBytes.subarray(0, -1), "der");
    /* prehash: false — the sighash is already the ECDSA message; noble 2.x hashes otherwise. */
    expect(
      secp256k1.verify(sig.toBytes(), sighash, new Uint8Array(pubkey), {
        lowS: true,
        prehash: false,
      }),
    ).toBe(true);
    /* The witness key must be the account's key: its p2wpkh address equals fromAddress. */
    const derived = Address(NETWORK).encode({
      type: "wpkh",
      hash: ripemd160(sha256(new Uint8Array(pubkey))),
    });
    expect(derived).toBe(expected.fromAddress);
  }
  const outs: Array<{ readonly address: string | undefined; readonly amount: bigint }> = [];
  for (let i = 0; i < tx.outputsLength; i += 1) {
    outs.push({ address: tx.getOutputAddress(i, NETWORK), amount: tx.getOutput(i).amount ?? 0n });
  }
  expect(outs.filter((o) => o.address === expected.to).map((o) => o.amount)).toContain(
    expected.amount,
  );
};

/**
 * @solana/kit + noble ed25519: verify the fee-payer signature over the message bytes and decode
 * the compiled message's System transfer — source, destination and lamports must match.
 */
export const verifySol = (
  bytes: Uint8Array,
  expected: { readonly from: string; readonly to: string; readonly amount: bigint },
): void => {
  expect(bytes[0]).toBe(1);
  const sig = bytes.subarray(1, 65);
  const message = bytes.subarray(65);
  const payerKey = new Uint8Array(addrEncode.encode(solAddress(expected.from)));
  expect(ed25519.verify(sig, message, payerKey)).toBe(true);
  const compiled = getCompiledTransactionMessageDecoder().decode(message);
  const instructions = getInstructionsFromCompiledTransactionMessage(compiled);
  const transfers = instructions.filter((ix) => ix.programAddress === SYSTEM_PROGRAM_ADDRESS);
  expect(transfers.length).toBe(1);
  const [transfer] = transfers;
  if (transfer === undefined) {
    throw new Error("no system transfer");
  }
  const data = getTransferSolInstructionDataDecoder().decode(transfer.data ?? new Uint8Array());
  expect(data.amount).toBe(expected.amount);
  const accounts = transfer.accounts ?? [];
  expect(accounts.at(0)?.address).toBe(solAddress(expected.from));
  expect(accounts.at(1)?.address).toBe(solAddress(expected.to));
};

/**
 * Tronweb protobufs + noble secp256k1: txID = sha256(raw_data); the 65-byte signature recovers a
 * key whose TRON address is the account's; the TransferContract carries owner/to/amount.
 */
export const verifyTron = (
  bytes: Uint8Array,
  expected: { readonly from: string; readonly to: string; readonly amount: bigint },
): void => {
  const tx = tronProto.Transaction.deserializeBinary(bytes);
  const raw = tx.getRawData();
  const digest = sha256(raw.serializeBinary());
  const [sig] = tx.getSignatureList();
  if (sig === undefined || sig.length !== 65) {
    throw new Error("tron signature must be 65 bytes");
  }
  const last = sig[64] ?? 0;
  const recid = last >= 27 ? last - 27 : last;
  const recovered = secp256k1.Signature.fromBytes(new Uint8Array(sig.subarray(0, 64)))
    .addRecoveryBit(recid)
    .recoverPublicKey(digest);
  const uncompressed = recovered.toBytes(false).subarray(1);
  expect(tronAddress(uncompressed)).toBe(expected.from);
  const [contract] = raw.getContractList();
  const param = contract?.getParameter();
  expect(param?.getTypeUrl()).toContain("TransferContract");
  const transferValue = param?.getValue();
  const transfer = tronBalance.TransferContract.deserializeBinary(
    transferValue === undefined ? new Uint8Array() : new Uint8Array(transferValue),
  );
  expect(tronAddressCheck(transfer.getOwnerAddress())).toBe(expected.from);
  expect(tronAddressCheck(transfer.getToAddress())).toBe(expected.to);
  expect(BigInt(transfer.getAmount())).toBe(expected.amount);
};

const tronAddress = (uncompressed64: Uint8Array): string =>
  tronAddressCheck(new Uint8Array([0x41, ...keccak_256(uncompressed64).subarray(12)]));

const tronAddressCheck = (hex21: Uint8Array): string => base58check.encode(hex21);

/* ----------------------------------------------------------------- origin drivers --- */

export type MatrixFamily = "evm" | "bitcoin" | "solana" | "tron";

/** The facts every origin binds against — the same account material `matrixAccount` resolves. */
export type MatrixAccount = {
  readonly walletId: string;
  readonly groupIndex: number;
  /** The master fingerprint the QR requests and PSBT derivations carry. */
  readonly fingerprint: number;
  readonly evm: string;
  readonly solana: string;
  readonly tron: string;
  /** The btc.bip84 account xpub — receive index 0 is the funded address. */
  readonly bitcoinXpub: string;
};

const FAMILY_TEMPLATE: Record<MatrixFamily, ChainTemplate> = {
  evm: "evm.bip44",
  bitcoin: "btc.bip84",
  solana: "solana.bip44-change",
  tron: "tron.bip44",
};

const FAMILY_NETWORK: Record<MatrixFamily, string> = {
  evm: EVM_NETWORK,
  bitcoin: BTC_NETWORK,
  solana: SOL_NETWORK,
  tron: TRON_NETWORK,
};

const FAMILY_NAMESPACE: Record<MatrixFamily, PendingConnection["namespace"]> = {
  evm: "eip155",
  bitcoin: "bip122",
  solana: "solana",
  tron: "tron",
};

/** Resolve the group's per-family account facts through the one seam — the QR counterpart reads. */
export const matrixAccount = async (
  w: E2eWorld["w"],
  walletId: string,
  groupIndex = 0,
): Promise<MatrixAccount> => {
  const info = w.wallet.getSnapshot().wallets.find((entry) => entry.walletId === walletId);
  const { apis } = w.signers;
  const [evm, solana, tron, bitcoin] = await Promise.all([
    apis.account({ walletId, groupIndex, template: "evm.bip44", network: EVM_NETWORK }),
    apis.account({ walletId, groupIndex, template: "solana.bip44-change", network: SOL_NETWORK }),
    apis.account({ walletId, groupIndex, template: "tron.bip44", network: TRON_NETWORK }),
    apis.account({ walletId, groupIndex, template: "btc.bip84", network: BTC_NETWORK }),
  ]);
  if (!("address" in evm) || !("address" in solana) || !("address" in tron)) {
    throw new Error("expected address accounts");
  }
  if (!("xpub" in bitcoin) || bitcoin.xpub === undefined) {
    throw new Error("expected a bitcoin account");
  }
  const fingerprint =
    info !== undefined && info.custody === "hardware"
      ? info.fingerprint
      : "fingerprint" in bitcoin
        ? bitcoin.fingerprint
        : "";
  return {
    walletId,
    groupIndex,
    fingerprint: Number.parseInt(fingerprint, 16),
    evm: evm.address,
    solana: solana.address,
    tron: tron.address,
    bitcoinXpub: bitcoin.xpub,
  };
};

const HARD = 0x80_00_00_00;

/** A System transfer instruction — the program's own layout (u32 2 + u64 lamports). */
const transferIx = (from: string, to: string, amount: bigint) => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, amount, true);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: solAddress(from), role: AccountRole.WRITABLE_SIGNER },
      { address: solAddress(to), role: AccountRole.WRITABLE },
    ],
    data,
  };
};

/** A compiled legacy message paying `amount` lamports from `payer`, on the stub blockhash. */
const solanaMessage = (payer: string, to: string, amount: bigint): Uint8Array =>
  new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash(SOL_BLOCKHASH), lastValidBlockHeight: 0n },
          setTransactionMessageFeePayer(
            solAddress(payer),
            appendTransactionMessageInstructions(
              [transferIx(payer, to, amount)],
              createTransactionMessage({ version: "legacy" }),
            ),
          ),
        ),
      ),
    ),
  );

/** The same transfer as a signed-slot wire transaction — the dApp's `transactions` element. */
const solanaWire = (payer: string, to: string, amount: bigint): Uint8Array => {
  const message = solanaMessage(payer, to, amount);
  const wire = new Uint8Array(65 + message.length);
  wire[0] = 1;
  wire.set(message, 65);
  return wire;
};

/** The stub's solid head is block 800 — the dApp-side raw_data references it. */
const tronTransfer = (owner: string, to: string, amount: number): Record<string, unknown> => ({
  ref_block_bytes: "0320",
  ref_block_hash: TRON_HEAD_ID.slice(16, 32),
  expiration: T0 + 300_000,
  timestamp: T0,
  contract: [
    {
      parameter: {
        value: {
          amount,
          owner_address: tronAddressToHex(owner),
          to_address: tronAddressToHex(to),
        },
        type_url: "type.googleapis.com/protocol.TransferContract",
      },
      type: "TransferContract",
    },
  ],
});

/**
 * A p2wpkh PSBT spending the funded utxo, paying `sats` and returning change — the input carries
 * the account's bip32 derivation (its fingerprint is what `psbtHasLinkInput` matches on QR) and the
 * change output its own, so the kernel hides it exactly like a wallet-built spend.
 */
const spendPsbt = (
  funded: FundedUtxo,
  account: MatrixAccount,
  to: string,
  sats: bigint,
): Uint8Array => {
  const root = HDKey.fromExtendedKey(account.bitcoinXpub);
  const receive = root.deriveChild(0).deriveChild(0);
  const change = root.deriveChild(1).deriveChild(0);
  if (receive.publicKey === null || change.publicKey === null) {
    throw new Error("no child public key");
  }
  const { script } = p2wpkh(receive.publicKey, NETWORK);
  const { script: changeScript } = p2wpkh(change.publicKey, NETWORK);
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: funded.txid,
    index: funded.vout,
    sequence: 0xff_ff_ff_fd,
    witnessUtxo: { script, amount: BigInt(funded.value) },
    nonWitnessUtxo: funded.funding,
    bip32Derivation: [
      [
        receive.publicKey,
        { fingerprint: account.fingerprint, path: [84 + HARD, HARD, HARD, 0, 0] },
      ],
    ],
  });
  tx.addOutput({ script: scriptOf(to), amount: sats });
  tx.addOutput({
    script: changeScript,
    amount: BigInt(funded.value) - sats - 1000n,
    bip32Derivation: [
      [change.publicKey, { fingerprint: account.fingerprint, path: [84 + HARD, HARD, HARD, 1, 0] }],
    ],
  });
  return tx.toPSBT(0);
};

/**
 * `spendPsbt` with `outputs` distinct payment outputs — the unbounded chain prompt renders one row
 * per output, which is how the oversized-prompt refusal cells reach a display cap while still
 * decoding `clear`.
 */
export const longPsbt = (
  funded: FundedUtxo,
  account: MatrixAccount,
  outputs: number,
): Uint8Array => {
  const root = HDKey.fromExtendedKey(account.bitcoinXpub);
  const receive = root.deriveChild(0).deriveChild(0);
  const change = root.deriveChild(1).deriveChild(0);
  if (receive.publicKey === null || change.publicKey === null) {
    throw new Error("no child public key");
  }
  const { script } = p2wpkh(receive.publicKey, NETWORK);
  const { script: changeScript } = p2wpkh(change.publicKey, NETWORK);
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: funded.txid,
    index: funded.vout,
    sequence: 0xff_ff_ff_fd,
    witnessUtxo: { script, amount: BigInt(funded.value) },
    nonWitnessUtxo: funded.funding,
    bip32Derivation: [
      [
        receive.publicKey,
        { fingerprint: account.fingerprint, path: [84 + HARD, HARD, HARD, 0, 0] },
      ],
    ],
  });
  let paid = 0n;
  for (let i = 0; i < outputs; i += 1) {
    const amount = 1000n + BigInt(i);
    paid += amount;
    tx.addOutput({ script: scriptOf(BTC_TO), amount });
  }
  tx.addOutput({
    script: changeScript,
    amount: BigInt(funded.value) - paid - 1000n,
    bip32Derivation: [
      [change.publicKey, { fingerprint: account.fingerprint, path: [84 + HARD, HARD, HARD, 1, 0] }],
    ],
  });
  return tx.toPSBT(0);
};

/** The pipeline's currently awaiting entries — one sign call parks exactly one. */
const awaiting = (w: E2eWorld["w"]) =>
  Object.values(w.requests.getState().requests).filter((e) => e.stage === "awaiting-approval");

/** Approve the request the last call parked — the host's part of every origin's sign step. */
/** The implementation signature of `RequestController.approve`, past the per-method overloads. */
type ApproveAny = (
  id: string,
  method: RequestMethod,
  options?: ApproveOptions,
) => Promise<RequestResult>;

/** `approve` is overloaded per method literal; the pipeline itself routes on the runtime value. */
const isApproveAny = (value: unknown): value is ApproveAny => typeof value === "function";

const approveOf = (w: E2eWorld["w"]): ApproveAny => {
  const bound: unknown = w.requests.approve.bind(w.requests);
  if (!isApproveAny(bound)) {
    throw new Error("requests.approve is not callable");
  }
  return bound;
};

const approveNext = async (
  w: E2eWorld["w"],
  verify: VerifyFactor,
  hooks?: MatrixHooks,
): Promise<void> => {
  await until(() => awaiting(w).length > 0);
  const [request] = awaiting(w);
  if (request === undefined) {
    throw new Error("no request reached awaiting-approval");
  }
  hooks?.beforeApprove?.(w);
  const approving = approveOf(w)(request.id, request.method, approval(request, verify));
  await hooks?.duringApprove?.(w);
  await approving;
};

/**
 * A dApp connect for `family`: the real ConnectionController session the handler's sign calls bind
 * to — scope accounts derive from `select`'d group exactly like the engine's.
 */
export const dappConnect = async (
  e2e: E2eWorld,
  account: MatrixAccount,
  family: MatrixFamily,
): Promise<void> => {
  e2e.dapp.select({ walletId: account.walletId, groupIndex: account.groupIndex });
  const granted = e2e.dapp.connections.request(SITE, {
    kind: "connect",
    namespace: FAMILY_NAMESPACE[family],
  });
  const [entry] = e2e.dapp.connections.pending();
  if (entry === undefined) {
    throw new Error("no pending connection");
  }
  await e2e.dapp.connections.approveConnection(entry.id, {
    /* eip155 validates the grant names the group's own account; the other namespaces derive
       their scope accounts from the bound group and ignore the list. */
    accounts: family === "evm" ? [account.evm] : [],
    network: FAMILY_NETWORK[family],
  });
  await granted;
};

/**
 * One dApp-initiated sign per family through the real Wallet Standard handlers: connect the origin,
 * hand it the request, approve through the pipeline, and verify the caught broadcast. `dappConnect`
 * must have run for this family first.
 */
export const dappOnce = async (
  e2e: E2eWorld,
  account: MatrixAccount,
  family: MatrixFamily,
  verify: VerifyFactor,
  hooks?: MatrixHooks,
): Promise<void> => {
  if (family === "evm") {
    const settled = e2e.dapp.eip1193.handle(SITE, {
      method: "eth_sendTransaction",
      params: [{ from: account.evm, to: EVM_TO, value: "0x38d7ea4c68000" }],
    });
    await approveNext(e2e.w, verify, hooks);
    await settled;
    await verifyEvm(caughtOne(e2e.caught, "evm"), {
      from: account.evm,
      to: EVM_TO,
      amount: 1_000_000_000_000_000n,
    });
    return;
  }
  if (family === "bitcoin") {
    const funded = e2e.fund(btcAddressFromXpub(account.bitcoinXpub), 100_000);
    const psbt = spendPsbt(funded, account, BTC_TO, 20_000n);
    const settled = e2e.dapp.bitcoinWallet.handle(SITE, {
      method: "bitcoin:signAndSendTransaction",
      params: {
        inputs: [
          {
            psbt,
            chain: "bitcoin:mainnet",
            inputsToSign: [{ address: funded.address, signingIndexes: [0] }],
          },
        ],
      },
    });
    await approveNext(e2e.w, verify, hooks);
    await settled;
    verifyBtc(caughtOne(e2e.caught, "bitcoin"), {
      fromAddress: funded.address,
      to: BTC_TO,
      amount: 20_000n,
      inputSats: BigInt(funded.value),
    });
    return;
  }
  if (family === "solana") {
    const settled = e2e.dapp.solanaWallet.handle(SITE, {
      method: "solana:signAndSendTransaction",
      params: {
        transactions: [solanaWire(account.solana, SOL_TO, 1_000_000n)],
        chains: ["solana:mainnet"],
      },
    });
    await approveNext(e2e.w, verify, hooks);
    await settled;
    verifySol(caughtOne(e2e.caught, "solana"), {
      from: account.solana,
      to: SOL_TO,
      amount: 1_000_000n,
    });
    return;
  }
  const rawJson = tronTransfer(account.tron, TRON_TO, 5_000_000);
  const rawBytes = tronRawDataFromJson(rawJson, false);
  const transaction = {
    txID: bytesToHex(sha256(rawBytes)),
    raw_data: rawJson,
    raw_data_hex: bytesToHex(rawBytes),
  };
  const signing = e2e.dapp.tronWallet.handle(SITE, {
    method: "tron_signTransaction",
    params: { transaction },
  });
  await approveNext(e2e.w, verify, hooks);
  const signedTx = await signing;
  /* signTransaction only signs — the dApp broadcasts its signed bytes itself. */
  const sent = await e2e.dapp.tronWallet.handle(SITE, {
    method: "tron_sendRawTransaction",
    params: { transaction: signedTx },
  });
  expect(sent).toMatchObject({ result: true });
  verifyTron(caughtOne(e2e.caught, "tron"), {
    from: account.tron,
    to: TRON_TO,
    amount: 5_000_000n,
  });
};

/** The QR answer's shape — identical whichever custody signed (RESPONSE_TYPES pinned per family). */
export type QrShape = { readonly type: string; readonly keys: ReadonlyArray<string> };

const QR_RANDOM = (n: number): Uint8Array => new Uint8Array(n).fill(9);

const QR_RESPONSE_KEY: Record<MatrixFamily, string> = {
  evm: "eth-signature",
  solana: "sol-signature",
  tron: "tron-signature",
  bitcoin: "crypto-psbt",
};

const qrInput = (
  account: MatrixAccount,
  family: MatrixFamily,
  funded: FundedUtxo | undefined,
): QrSignInput => {
  if (family === "evm") {
    return {
      family: "evm",
      kind: "transaction",
      tx: {
        type: "eip1559",
        chainId: 42161,
        nonce: 0,
        gas: "0x5208",
        to: EVM_TO,
        value: "0x38d7ea4c68000",
        data: "0x",
        accessList: [],
        maxFeePerGas: "0x64",
        maxPriorityFeePerGas: "0x1",
      },
    };
  }
  if (family === "bitcoin") {
    if (funded === undefined) {
      throw new Error("the bitcoin cell needs a funded utxo");
    }
    return { family: "bitcoin", kind: "psbt", psbt: spendPsbt(funded, account, BTC_TO, 20_000n) };
  }
  if (family === "solana") {
    return {
      family: "solana",
      kind: "transaction",
      data: solanaMessage(account.solana, SOL_TO, 1_000_000n),
    };
  }
  return {
    family: "tron",
    kind: "transaction",
    data: tronRawDataFromJson(tronTransfer(account.tron, TRON_TO, 5_000_000), false),
  };
};

const cborKeys = (payload: { readonly type: string; readonly cbor: Uint8Array }): string[] => {
  const ur = Ur.fromCborData(payload.type, payload.cbor);
  const decoded =
    payload.type === "eth-signature"
      ? fromUr(ur, ethSignatureCodec)
      : payload.type === "sol-signature"
        ? fromUr(ur, solSignatureCodec)
        : payload.type === "tron-signature"
          ? fromUr(ur, tronSignatureCodec)
          : fromUr(ur, cryptoPsbtCodec);
  return Object.keys(decoded).toSorted();
};

/**
 * The QR origin's full loop, the way a watch-only counterpart drives it: export the account's
 * crypto-multi-accounts, build the family's request from the link, read the UR back into a
 * `QrRequest`, run prepare → approve → respond, and verify the answer with `readQrSignature` — plus
 * an independent check of the signed artefact (the assembled 1559 tx, the psbt's witness, the
 * recovered TRON signer). QR never broadcasts; `caught` stays empty for this cell.
 */
export const qrOnce = async (
  e2e: E2eWorld,
  account: MatrixAccount,
  family: MatrixFamily,
  verify: VerifyFactor,
  hooks?: MatrixHooks,
): Promise<QrShape> => {
  const exported = await e2e.signer.exportAccount({
    account: { walletId: account.walletId, groupIndex: account.groupIndex },
    form: "crypto-multi-accounts",
    families: ["evm", "tron", "solana"],
    bitcoin: { template: "btc.bip84", network: BTC_NETWORK },
    verify,
    acknowledgeUnconfirmed: true,
  });
  const links = readQrExport(exported.payload);
  const link = links.find((entry) => entry.family === family);
  if (link === undefined) {
    throw new Error(`no ${family} link in the export`);
  }
  const funded =
    family === "bitcoin" ? e2e.fund(btcAddressFromXpub(account.bitcoinXpub), 100_000) : undefined;
  const sent = qrSignRequest(link, qrInput(account, family, funded), {
    random: QR_RANDOM,
    origin: SITE,
  });
  const request = readQrRequest(sent.payload);
  const pending = await e2e.signer.prepare(request, {
    walletId: account.walletId,
    groupIndex: account.groupIndex,
  });
  hooks?.beforeApprove?.(e2e.w);
  const approving = approveOf(e2e.w)(pending.id, pending.method, approval(pending, verify));
  await hooks?.duringApprove?.(e2e.w);
  await approving;
  const payload = await e2e.signer.respond(pending.id);
  expect(payload.type).toBe(QR_RESPONSE_KEY[family]);
  const signature = readQrSignature(sent, payload);
  if (signature.kind === "evm.transaction") {
    await verifyEvm(signature.signedTransaction, {
      from: account.evm,
      to: EVM_TO,
      amount: 1_000_000_000_000_000n,
    });
  } else if (signature.kind === "bitcoin.psbt") {
    const signed = Transaction.fromPSBT(signature.psbt);
    signed.finalize();
    const raw = signed.extract();
    if (funded === undefined) {
      throw new Error("unreachable");
    }
    verifyBtc(raw, {
      fromAddress: funded.address,
      to: BTC_TO,
      amount: 20_000n,
      inputSats: BigInt(funded.value),
    });
  } else if (signature.kind === "solana.signature") {
    const message = solanaMessage(account.solana, SOL_TO, 1_000_000n);
    const payerKey = new Uint8Array(addrEncode.encode(solAddress(account.solana)));
    expect(ed25519.verify(signature.signature, message, payerKey)).toBe(true);
  } else if (signature.kind === "tron.signature") {
    const digest = sha256(
      tronRawDataFromJson(tronTransfer(account.tron, TRON_TO, 5_000_000), false),
    );
    const sig = signature.signature;
    const last = sig[64] ?? 0;
    const recid = last >= 27 ? last - 27 : last;
    const recovered = secp256k1.Signature.fromBytes(new Uint8Array(sig.subarray(0, 64)))
      .addRecoveryBit(recid)
      .recoverPublicKey(digest);
    expect(tronAddress(recovered.toBytes(false).subarray(1))).toBe(account.tron);
  }
  return { type: payload.type, keys: cborKeys(payload) };
};

/**
 * The error one refused request produces on each side of the approval: `approve` is what
 * `requests.approve` rejected with (the typed `WalletError`), `call` is what the origin's own entry
 * point rejected with — the wire `ProviderError` on dApp, `RequestEndedError` on `respond`.
 */
export type Refusal = { readonly approve: unknown; readonly call: unknown };

/** Wait for a parked request and approve it with `verify`, returning the rejection, not throwing. */
const refusedApprove = async (w: E2eWorld["w"], verify: VerifyFactor): Promise<unknown> => {
  await until(() => awaiting(w).length > 0);
  const [request] = awaiting(w);
  if (request === undefined) {
    throw new Error("no request reached awaiting-approval");
  }
  return approveOf(w)(request.id, request.method, approval(request, verify)).catch(
    (error: unknown) => error,
  );
};

/**
 * One refused dApp call: connect the family's namespace, issue `call`, approve the parked request,
 * and return both rejections for the test to assert.
 */
export const dappRefusal = async (
  e2e: E2eWorld,
  account: MatrixAccount,
  family: MatrixFamily,
  verify: VerifyFactor,
  call: () => Promise<unknown>,
): Promise<Refusal> => {
  await dappConnect(e2e, account, family);
  /* The wire call settles after the approve below — capture it in a promise that carries the
     rejection as its value instead of rejecting unobserved. */
  const page = (async (): Promise<unknown> => {
    try {
      return await call();
    } catch (error) {
      return error;
    }
  })();
  const approve = await refusedApprove(e2e.w, verify);
  /* A refusal thrown before the approve transition leaves the request parked — reject it so the
     origin's promise settles. */
  const [leftover] = awaiting(e2e.w);
  if (leftover !== undefined) {
    e2e.w.requests.reject(leftover.id);
  }
  return { approve, call: await page };
};

/**
 * One refused QR request: export the account, build the counterpart request for `family`, prepare →
 * approve (expecting a refusal) → respond, and return both rejections.
 */
export const qrRefusal = async (
  e2e: E2eWorld,
  account: MatrixAccount,
  family: MatrixFamily,
  input: QrSignInput,
  verify: VerifyFactor,
): Promise<Refusal> => {
  const exported = await e2e.signer.exportAccount({
    account: { walletId: account.walletId, groupIndex: account.groupIndex },
    form: "crypto-multi-accounts",
    families: ["evm", "tron", "solana"],
    bitcoin: { template: "btc.bip84", network: BTC_NETWORK },
    verify,
    acknowledgeUnconfirmed: true,
  });
  const link = readQrExport(exported.payload).find((entry) => entry.family === family);
  if (link === undefined) {
    throw new Error(`no ${family} link in the export`);
  }
  const sent = qrSignRequest(link, input, { random: QR_RANDOM, origin: SITE });
  const pending = await e2e.signer.prepare(readQrRequest(sent.payload), {
    walletId: account.walletId,
    groupIndex: account.groupIndex,
  });
  const approve = await approveOf(e2e.w)(
    pending.id,
    pending.method,
    approval(pending, verify),
  ).catch((error: unknown) => error);
  const [leftover] = awaiting(e2e.w);
  if (leftover !== undefined) {
    e2e.w.requests.reject(leftover.id);
  }
  const call = await e2e.signer.respond(pending.id).catch((error: unknown) => error);
  return { approve, call };
};

/** One internal send per family through `sendOnce` — the same scenario the other origins run. */
export const internalOnce = async (
  e2e: E2eWorld,
  account: MatrixAccount,
  family: MatrixFamily,
  verify: VerifyFactor,
  hooks?: MatrixHooks,
): Promise<void> => {
  const accountRef = {
    kind: "hd" as const,
    walletId: account.walletId,
    groupIndex: account.groupIndex,
    template: FAMILY_TEMPLATE[family],
  };
  if (family === "bitcoin") {
    const funded = e2e.fund(btcAddressFromXpub(account.bitcoinXpub), 100_000);
    const tx = await sendOnce(
      e2e.w,
      { account: accountRef, network: BTC_NETWORK, to: BTC_TO, amount: 20_000n, fee: "normal" },
      verify,
      hooks,
    );
    expect(tx.state).not.toBe("failed");
    verifyBtc(caughtOne(e2e.caught, "bitcoin"), {
      fromAddress: funded.address,
      to: BTC_TO,
      amount: 20_000n,
      inputSats: BigInt(funded.value),
    });
    return;
  }
  if (family === "evm") {
    const tx = await sendOnce(
      e2e.w,
      {
        account: accountRef,
        network: EVM_NETWORK,
        to: EVM_TO,
        amount: 1_000_000_000_000_000n,
        fee: "normal",
      },
      verify,
      hooks,
    );
    expect(tx.state).not.toBe("failed");
    await verifyEvm(caughtOne(e2e.caught, "evm"), {
      from: account.evm,
      to: EVM_TO,
      amount: 1_000_000_000_000_000n,
    });
    return;
  }
  if (family === "solana") {
    const tx = await sendOnce(
      e2e.w,
      { account: accountRef, network: SOL_NETWORK, to: SOL_TO, amount: 1_000_000n, fee: "normal" },
      verify,
      hooks,
    );
    expect(tx.state).not.toBe("failed");
    verifySol(caughtOne(e2e.caught, "solana"), {
      from: account.solana,
      to: SOL_TO,
      amount: 1_000_000n,
    });
    return;
  }
  const tx = await sendOnce(
    e2e.w,
    { account: accountRef, network: TRON_NETWORK, to: TRON_TO, amount: 5_000_000n, fee: "normal" },
    verify,
    hooks,
  );
  expect(tx.state).not.toBe("failed");
  verifyTron(caughtOne(e2e.caught, "tron"), {
    from: account.tron,
    to: TRON_TO,
    amount: 5_000_000n,
  });
};

/** A backend's 12 cells — the setup pairs/imports whatever custody the file covers. */
export type MatrixCellSetup = () => Promise<{
  readonly e2e: E2eWorld;
  readonly account: MatrixAccount;
}>;

const FAMILIES: ReadonlyArray<MatrixFamily> = ["evm", "bitcoin", "solana", "tron"];

/**
 * The shared scenario table — every backend file calls this once and gets the same twelve cells:
 * {internal, dapp, qr} × {evm, bitcoin, solana, tron}, each signature verified by the independent
 * oracles. `setup` runs per cell (a fresh world, the backend's own pairing rig).
 */
export const matrix = (
  name: string,
  verify: VerifyFactor,
  setup: MatrixCellSetup,
  hooks?: MatrixHooks,
): void => {
  describe(`${name} signing matrix`, () => {
    for (const family of FAMILIES) {
      it(`${family}: internal send signs and broadcasts`, { timeout: 120_000 }, async () => {
        const { e2e, account } = await setup();
        hooks?.beforeCell?.("internal", family);
        await internalOnce(e2e, account, family, verify, hooks);
        await e2e.w.destroy();
      });
      it(`${family}: a dApp request signs and broadcasts`, { timeout: 120_000 }, async () => {
        const { e2e, account } = await setup();
        hooks?.beforeCell?.("dapp", family);
        await dappConnect(e2e, account, family);
        await dappOnce(e2e, account, family, verify, hooks);
        await e2e.w.destroy();
      });
      it(`${family}: a QR request signs without broadcasting`, { timeout: 120_000 }, async () => {
        const { e2e, account } = await setup();
        hooks?.beforeCell?.("qr", family);
        const shape = await qrOnce(e2e, account, family, verify, hooks);
        /* Indistinguishability: every backend answers the same UR type and CBOR map keys. */
        expect(shape).toStrictEqual(QR_SHAPES[family]);
        expect(e2e.caught).toHaveLength(0);
        await e2e.w.destroy();
      });
    }
  });
};

/** The cross-backend QR answer contract — what any custody's respond must look like. */
export const QR_SHAPES: Record<MatrixFamily, QrShape> = {
  evm: { type: "eth-signature", keys: ["requestId", "signature"] },
  solana: { type: "sol-signature", keys: ["requestId", "signature"] },
  tron: { type: "tron-signature", keys: ["requestId", "signature"] },
  bitcoin: { type: "crypto-psbt", keys: ["bytes"] },
};
