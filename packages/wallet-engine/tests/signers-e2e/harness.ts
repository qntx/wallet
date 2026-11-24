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
import { createBase58check } from "@scure/base";
import { Address, NETWORK, OutScript, Transaction } from "@scure/btc-signer";
import {
  getTransferSolInstructionDataDecoder,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import {
  address as solAddress,
  getAddressEncoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
} from "@solana/kit";
import { parseTransaction, recoverTransactionAddress } from "viem";
import { expect } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import { scripthash } from "../../src/chains/bitcoin-scan.ts";
import type { EngineOptions } from "../../src/engine.ts";
import type { SendParams, TrackedTransaction } from "../../src/transactions/route.ts";
import { approval } from "../approval.ts";
import { manualTimer, VERIFY, world } from "../apps-helpers.ts";

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
/* oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generated module is untyped */
const tronProto = require(tronLib("protocol/core/Tron_pb.cjs")) as {
  Transaction: { deserializeBinary: (b: Uint8Array) => TronTransaction };
};
const tronBalance =
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generated module is untyped
  require(tronLib("protocol/core/contract/balance_contract_pb.cjs")) as {
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

type FundedUtxo = {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly address: string;
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
  const utxo: FundedUtxo = { txid: tx.id, vout: 0, value, address };
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

/**
 * A world whose stub upstreams answer every family: BTC/SOL/TRON over the injected fetch, EVM via
 * `arb1`. `fund` credits a P2WPKH address with a confirmed UTXO; `caught` collects every
 * broadcast's wire bytes.
 */
export const e2eWorld = async (options: {
  readonly wallet?: { wallet: Wallet; walletId: string };
  readonly deviceIo?: EngineOptions["deviceIo"];
}): Promise<{
  readonly w: Awaited<ReturnType<typeof world>>;
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
  return { w, caught, fund: (address, sats) => fundBtc(btc, address, sats) };
};

/** One engine send through the request pipeline: prepare → approve → broadcast → returns tracked. */
export const sendOnce = async (
  w: E2eWorld["w"],
  params: Omit<SendParams, "verify">,
): Promise<TrackedTransaction> => {
  const request = await w.requests.prepare({ method: "send", ...params });
  expect(request.stage).toBe("awaiting-approval");
  return w.requests.approve(request.id, "send", approval(request, VERIFY));
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
