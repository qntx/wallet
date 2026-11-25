// oxlint-disable vitest/no-conditional-in-test -- recorded fixtures narrow via guard throws
/**
 * Keystone signing end to end: the real driver sends its QR sign request, a fake device — decoding
 * through the independent `@keystonehq/bc-ur-registry-*` packages — answers it like firmware 3.2.2,
 * and the assembled artefact must equal the software wallet's on the same seed. Differential
 * vectors pin our request CBOR to the vendor encoders' bytes; the hostile mutants prove every
 * answer that is not exactly ours is refused (`wrong-device`, `integrity`, `unsupported`), and
 * random bytes as any signature payload only ever produce `KernelError`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CborMap,
  cbor,
  decodeCbor,
  encodeCbor,
  expectMap,
  isBytes,
  isUnsigned,
} from "@blockchaincommons/dcbor";
import { CryptoPSBT } from "@keystonehq/bc-ur-registry-btc";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2pkh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import * as fc from "fast-check";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import {
  btcSignRequestCodec,
  btcSignatureCodec,
  ethSignRequestCodec,
  ethSignatureCodec,
  qrHardwareCallCodec,
  solSignRequestCodec,
  solSignatureCodec,
  tronSignRequestCodec,
  tronSignatureCodec,
} from "@qntx/ur/interop";
import type { EthDataType, SolSignType, TronDataType } from "@qntx/ur/interop";
import { cryptoPsbtCodec } from "@qntx/ur/registry";
import type { UrCodec } from "@qntx/ur/typed";
import {
  bitcoinNetwork,
  normalizeBitcoin,
  verifyBitcoinPsbtSignatures,
} from "@qntx/wallet-chains/bitcoin";
import { EVM_DELEGATOR, normalizeEvm } from "@qntx/wallet-chains/evm";
import { buildTronRawData, normalizeTron } from "@qntx/wallet-chains/tron";
import type { DeviceRequest, DeviceResponse, ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { derive } from "../src/modules/signers/keystone/derive.ts";
import { decodeUr, encodeUr, requestKeypath } from "../src/modules/signers/keystone/ur.ts";
import { devicePromptLine } from "../src/modules/signers/prompt.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import { keystoneDevice } from "./signers-keystone-device.ts";
import type { DeviceMutant } from "./signers-keystone-device.ts";

const HARDENED = 0x80000000;
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = mnemonicToSeedSync(MNEMONIC);
const OTHER_SEED = mnemonicToSeedSync(
  "test test test test test test test test test test test junk",
);

const EVM_NETWORK = "eip155:1";
const TRON_NETWORK = "tron:728126428";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF = new Uint8Array(32).fill(0x50);
const FACTOR = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF),
});
const PASSKEY = (): unknown => ({
  kind: "passkey",
  credentialId: new Uint8Array(CREDENTIAL_ID),
  prf: new Uint8Array(PRF),
});

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/keystone/sync.json"), "utf8"),
) as { sync: { cbor: string; masterFingerprint: string } };
const signVectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/keystone/sign.json"), "utf8"),
) as {
  requestId: string;
  signData: string;
  fingerprint: string;
  origin: string;
  cases: ReadonlyArray<{
    name: string;
    urType: string;
    dataType?: number;
    chainId?: number;
    signType?: number;
    path?: string;
    paths?: ReadonlyArray<string>;
    cbor: string;
  }>;
};

const MFP = hexToBytes(vectors.sync.masterFingerprint);

const derived = (path: string): Uint8Array => {
  const pub = HDKey.fromMasterSeed(SEED).derive(path).publicKey;
  if (pub === null) {
    throw new Error(`no key at ${path}`);
  }
  return pub;
};
const PUB44 = derived("m/44'/0'/0'/0/0");
const PUB86 = derived("m/86'/0'/0'/0/0");
const ADDRESS44 = p2pkh(PUB44, bitcoinNetwork(BTC_NETWORK).params).address;
const ADDRESS86 = p2tr(PUB86.subarray(1), undefined, bitcoinNetwork(BTC_NETWORK).params).address;

const FLIP_BIT: DeviceMutant = {
  cbor: (bytes) => {
    const out = new Uint8Array(bytes);
    const index = out.length - 40;
    out[index] = (out[index] ?? 0) ^ 0x01;
    return out;
  },
};

const BOGUS_V: DeviceMutant = {
  cbor: (bytes) => {
    const out = new Uint8Array(bytes);
    out[out.length - 1] = 0x7e;
    return out;
  },
};

/** Re-encodes a signature answer's map with byte field `n` replaced by `value`. */
const replaceByteField = (bytes: Uint8Array, n: number, value: Uint8Array): Uint8Array => {
  const map = expectMap(decodeCbor(bytes));
  const out = new CborMap();
  for (const [key, item] of map) {
    out.set(
      key,
      isUnsigned(key) && key.value === n && isBytes(item) ? new Uint8Array(value) : item,
    );
  }
  return encodeCbor(cbor(out));
};

/** A signed PSBT answer whose trailing sighash byte is not the planned one. */
const tamperedPsbt = (request: DeviceRequest): DeviceResponse => {
  const response = keystoneDevice(SEED, MFP).respond(request);
  if (response.kind !== "qr" || response.ur.type !== "crypto-psbt") {
    return response;
  }
  const signed = CryptoPSBT.fromCBOR(Buffer.from(response.ur.cbor)).getPSBT();
  const tx = Transaction.fromPSBT(new Uint8Array(signed));
  const partial = tx.getInput(0).partialSig;
  if (partial === undefined || partial[0] === undefined) {
    throw new Error("no partialSig to tamper");
  }
  partial[0][1] = new Uint8Array([...partial[0][1].slice(0, -1), 0x02]);
  return { kind: "qr", ur: { type: "crypto-psbt", cbor: tx.toPSBT(0) } };
};

/** A signature answer whose field-2 byte string is cut to 64 bytes. */
const shortenSignature = (bytes: Uint8Array): Uint8Array => {
  const signature = expectMap(decodeCbor(bytes)).get(2);
  if (signature === undefined || !isBytes(signature)) {
    throw new Error("no signature field");
  }
  return replaceByteField(bytes, 2, signature.value.subarray(0, 64));
};

const RESPONSE_PARSERS: ReadonlyArray<readonly [string, UrCodec<unknown>]> = [
  ["eth-signature", ethSignatureCodec],
  ["sol-signature", solSignatureCodec],
  ["tron-signature", tronSignatureCodec],
  ["btc-signature", btcSignatureCodec],
  ["crypto-psbt", cryptoPsbtCodec],
];

/** `safe` when the decoders only ever refuse with a KernelError (or accept the value). */
const codeOf = (bytes: Uint8Array): string => {
  try {
    for (const [type, codec] of RESPONSE_PARSERS) {
      decodeUr(type, bytes, codec);
    }
    return "safe";
  } catch (error) {
    return error instanceof KernelError ? "safe" : "foreign";
  }
};

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
const errCode = (response: KernelResponse): string | undefined =>
  "err" in response ? response.err.code : undefined;
function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error(`expected object, got ${String(value)}`);
  }
  const v = (value as Record<string, ProtocolValue>)[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}
const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};
const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

type Boot = { h: Harness; session: string; walletId: string; hwId: string };

/** Imports the oracle software wallet and pairs the real Keystone driver against the sync UR. */
const boot = async (): Promise<Boot> => {
  const h = createHarness();
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: FACTOR() }),
  );
  const session = (res as Record<string, ProtocolValue>)["session"] as string;
  const walletId = (
    (res as Record<string, ProtocolValue>)["wallet"] as Record<string, ProtocolValue>
  )["walletId"] as string;
  ok(await h.call("vault.setBlindSigning", { enabled: true, verify: PASSKEY() }, session));
  const begin = ok(
    await h.call(
      "hardware.begin",
      { op: { kind: "pair", device: "keystone" }, verify: PASSKEY() },
      session,
    ),
  );
  const done = ok(
    await h.call(
      "hardware.step",
      {
        opId: strField(begin, "opId"),
        response: {
          kind: "qr",
          ur: { type: "crypto-multi-accounts", cbor: hexToBytes(vectors.sync.cbor) },
        },
      },
      session,
    ),
  );
  const hwId = strField(field(field(done, "result"), "wallet"), "walletId");
  return { h, session, walletId, hwId };
};

const hd = (walletId: string, template: string) => ({
  kind: "hd",
  walletId,
  groupIndex: 0,
  template,
});

const signLocal = async (h: Harness, session: string, request: unknown) =>
  ok(await h.call("chain.sign", { request, verify: PASSKEY() }, session));

/** Steps a hardware sign, feeding each exchange through the (possibly mutant) device. */
const signOnDevice = async (
  h: Harness,
  session: string,
  request: unknown,
  mutant: DeviceMutant = {},
  respond?: (request: DeviceRequest, device: DeviceMutant) => DeviceResponse,
  verify: unknown = PASSKEY(),
): Promise<KernelResponse> => {
  const device = keystoneDevice(SEED, MFP, mutant);
  const begin = await h.call("hardware.begin", { op: { kind: "sign", request }, verify }, session);
  if ("err" in begin) {
    console.error("BEGIN-ERR", JSON.stringify(begin.err));
    return begin;
  }
  const opId = strField(begin.ok, "opId");
  let step = field(begin.ok, "step");
  for (let guard = 0; strField(step, "kind") === "exchange" && guard < 16; guard++) {
    const deviceRequest = field(step, "request") as DeviceRequest;
    let response: DeviceResponse;
    try {
      response =
        respond === undefined ? device.respond(deviceRequest) : respond(deviceRequest, mutant);
    } catch (error) {
      throw new Error(`device refused: ${(error as Error).message}`, { cause: error });
    }
    // oxlint-disable-next-line no-await-in-loop -- the coroutine advances one turn per step
    const next = await h.call("hardware.step", { opId, response }, session);
    if ("err" in next) {
      console.error("STEP-ERR", JSON.stringify(next.err));
      return next;
    }
    step = next.ok;
  }
  if (strField(step, "kind") !== "done") {
    throw new Error("sign did not finish");
  }
  return { id: 0, ok: field(field(step, "result"), "result") };
};

const evmTx = (type: string, extra: Record<string, unknown>) => ({
  kind: "evm.transaction",
  network: EVM_NETWORK,
  tx: {
    type,
    chainId: 1,
    nonce: 0,
    gas: "0x5208",
    value: "0xde0b6b3a7640000",
    data: "0x",
    to: "0x00000000000000000000000000000000deadbeef",
    ...extra,
  },
});

describe("keystone sign requests encode like the vendor SDK's", () => {
  const path = (rendered: string): number[] =>
    rendered
      .replace(/^m\//, "")
      .split("/")
      .map((segment) => Number(segment.replace(/'$/, "")) + (segment.endsWith("'") ? HARDENED : 0));
  const requestId = hexToBytes(signVectors.requestId);
  const fingerprint = hexToBytes(signVectors.fingerprint);
  const signData = hexToBytes(signVectors.signData);
  const texts: Record<string, Uint8Array> = {
    "eth-personal-message": utf8ToBytes("hello qntx"),
    "eth-typed-data": utf8ToBytes('{"types":{"EIP712Domain":[]}}'),
    "tron-message": utf8ToBytes("hello tron"),
    "solana-message": utf8ToBytes("hello solana"),
    "bitcoin-message": utf8ToBytes("hello bitcoin"),
  };

  const ETH_DATA_TYPES: Readonly<Record<number, EthDataType>> = {
    1: "transaction",
    2: "typedData",
    3: "personalMessage",
    4: "typedTransaction",
  };
  const TRON_DATA_TYPES: Readonly<Record<number, TronDataType>> = {
    1: "transaction",
    2: "messageV2",
  };
  const SOL_SIGN_TYPES: Readonly<Record<number, SolSignType>> = {
    1: "transaction",
    2: "message",
  };
  const keypath = (rendered: string) => requestKeypath(path(rendered), fingerprint);
  const signedPsbt = (): Uint8Array => psbt("btc.bip84");

  const encode = (c: (typeof signVectors.cases)[number]): Uint8Array => {
    const data = texts[c.name] ?? signData;
    switch (c.urType) {
      case "eth-sign-request":
        return encodeUr(
          {
            requestId,
            signData: data,
            dataType: ETH_DATA_TYPES[c.dataType ?? 0] ?? "transaction",
            ...(c.chainId === undefined ? {} : { chainId: c.chainId }),
            derivationPath: keypath(c.path ?? ""),
            origin: signVectors.origin,
          },
          ethSignRequestCodec,
        );
      case "tron-sign-request":
        return encodeUr(
          {
            requestId,
            signData: data,
            dataType: TRON_DATA_TYPES[c.dataType ?? 0] ?? "transaction",
            derivationPath: keypath(c.path ?? ""),
            origin: signVectors.origin,
          },
          tronSignRequestCodec,
        );
      case "sol-sign-request":
        return encodeUr(
          {
            requestId,
            signData: data,
            signType: SOL_SIGN_TYPES[c.signType ?? 0] ?? "transaction",
            derivationPath: keypath(c.path ?? ""),
            origin: signVectors.origin,
          },
          solSignRequestCodec,
        );
      case "btc-sign-request":
        return encodeUr(
          {
            requestId,
            signData: data,
            dataType: "message",
            derivationPaths: [keypath(c.path ?? "")],
            origin: signVectors.origin,
          },
          btcSignRequestCodec,
        );
      case "crypto-psbt":
        return encodeUr({ bytes: signedPsbt() }, cryptoPsbtCodec);
      case "qr-hardware-call": {
        const [secp, ed] = c.paths ?? [];
        return encodeUr(
          {
            params: {
              kind: "keyDerivation",
              schemas: [
                { keyPath: keypath(secp ?? ""), curve: "secp256k1", algorithm: "slip10" },
                { keyPath: keypath(ed ?? ""), curve: "ed25519", algorithm: "slip10" },
              ],
            },
            origin: signVectors.origin,
          },
          qrHardwareCallCodec,
        );
      }
      default:
        throw new Error(c.urType);
    }
  };

  // The recorded crypto-psbt vector wraps a non-PSBT payload the typed codec now refuses;
  // the vendor oracle on a real PSBT is the same assertion.
  const expectedCbor = (c: (typeof signVectors.cases)[number]): Uint8Array =>
    c.urType === "crypto-psbt"
      ? new Uint8Array(new CryptoPSBT(Buffer.from(signedPsbt())).toCBOR())
      : hexToBytes(c.cbor);

  it("is byte-identical for every request kind", () => {
    for (const c of signVectors.cases) {
      expect(encode(c)).toStrictEqual(expectedCbor(c));
    }
  });
});

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
const MFP_NUMBER = new DataView(MFP.buffer, MFP.byteOffset, 4).getUint32(0);
const PAYEE_SCRIPT = OutScript.encode(
  Address(bitcoinNetwork(BTC_NETWORK).params).decode("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"),
);

/** A one-input PSBT spending the wallet's `template` account-0 receive-0 key. */
const psbt = (template: "btc.bip84" | "btc.bip86", sighashType?: number): Uint8Array => {
  const purpose = template === "btc.bip84" ? 84 : 86;
  const child = HDKey.fromMasterSeed(SEED).derive(`m/${purpose}'/0'/0'/0/0`);
  const pub = child.publicKey;
  if (pub === null) {
    throw new Error("no child key");
  }
  const spend = purpose === 86 ? p2tr(pub.subarray(1)) : p2wpkh(pub);
  const path = [purpose + HARDENED, HARDENED, HARDENED, 0, 0];
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  const input: Record<string, unknown> = {
    txid: hex("0707".repeat(16)),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: spend.script, amount: 100_000n },
    ...(sighashType === undefined ? {} : { sighashType }),
    ...(purpose === 86
      ? {
          tapInternalKey: pub.subarray(1),
          tapBip32Derivation: [
            [pub.subarray(1), { hashes: [], der: { fingerprint: MFP_NUMBER, path } }],
          ],
        }
      : { bip32Derivation: [[pub, { fingerprint: MFP_NUMBER, path }]] }),
  };
  if (purpose !== 86) {
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({ txid: hex("1111".repeat(16)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: spend.script, amount: 100_000n });
    input["txid"] = hex(prev.id);
    input["nonWitnessUtxo"] = prev.toBytes(true, false);
  }
  tx.addInput(input);
  tx.addOutput({ script: PAYEE_SCRIPT, amount: 90_000n });
  return tx.toPSBT(0);
};

const bip84Request = (walletId: string) => ({
  kind: "bitcoin.psbt",
  origin: "internal",
  network: BTC_NETWORK,
  account: { kind: "hd", walletId, groupIndex: 0 },
  psbt: psbt("btc.bip84"),
  sign: [{ index: 0, template: "btc.bip84" }],
});

describe("keystone signing byte-identical to local signing", () => {
  it("evm legacy and eip1559 transactions", async () => {
    const { h, session, walletId, hwId } = await boot();
    const requests = [
      { ...evmTx("legacy", { gasPrice: "0x4a817c800" }), account: hd(walletId, "evm.bip44") },
      {
        ...evmTx("eip1559", {
          maxFeePerGas: "0x59682f00",
          maxPriorityFeePerGas: "0x1",
          accessList: [],
        }),
        account: hd(walletId, "evm.bip44"),
      },
    ];
    for (const local of requests) {
      const hardware = { ...local, account: hd(hwId, "evm.bip44") };
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const sw = await signLocal(h, session, normalizeEvm(local));
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const hw = ok(await signOnDevice(h, session, normalizeEvm(hardware)));
      expect(hw).toStrictEqual(sw);
    }
  });

  it("evm personal message, fiat24 session and typed data", async () => {
    const { h, session, walletId, hwId } = await boot();
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "m", type: "string" }],
      },
      domain: { name: "X" },
      primaryType: "Mail",
      message: { m: "hi" },
    });
    for (const partial of [
      { kind: "evm.personal-message", network: EVM_NETWORK, message: utf8ToBytes("hello") },
      {
        kind: "evm.fiat24-session",
        network: "eip155:42161",
        tokenId: "7",
        deadline: 1_700_000_600, // the harness wall clock starts at 1_700_000_000_000 ms
      },
      { kind: "evm.typed-data", network: EVM_NETWORK, typedData },
    ]) {
      const local = normalizeEvm({ ...partial, account: hd(walletId, "evm.bip44") });
      const hardware = normalizeEvm({ ...partial, account: hd(hwId, "evm.bip44") });
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const sw = await signLocal(h, session, local);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const hw = ok(await signOnDevice(h, session, hardware));
      expect(hw).toStrictEqual(sw);
    }
  });

  it("tron transaction and message", async () => {
    const { h, session, walletId, hwId } = await boot();
    const accounts = ok(
      await h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "tron.bip44", network: TRON_NETWORK },
        session,
      ),
    );
    const owner = strField(accounts, "address");
    const rawData = buildTronRawData(
      {
        refBlock: { number: 1, id: "a".repeat(64) },
        expiration: 1_700_000_000_000,
        timestamp: 1_699_999_000_000,
      },
      { type: "TransferContract", owner, to: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6", amount: 1n },
    );
    for (const partial of [
      { kind: "tron.transaction", rawData },
      { kind: "tron.message", message: utf8ToBytes("hello tron") },
    ]) {
      const local = { ...partial, network: TRON_NETWORK, account: hd(walletId, "tron.bip44") };
      const hardware = { ...local, account: hd(hwId, "tron.bip44") };
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const sw = await signLocal(h, session, local);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const hw = ok(await signOnDevice(h, session, hardware));
      expect(hw).toStrictEqual(sw);
    }
  });

  it("solana transaction and raw message", async () => {
    const { h, session, walletId, hwId } = await boot();
    const feePayer = ed25519.getPublicKey(
      Slip10.fromMasterSeed(SEED).derive("m/44'/501'/0'/0'").privateKey,
    );
    const dest = new Uint8Array(32).fill(0x22);
    const system = new Uint8Array(32);
    system[31] = 2;
    const blockhash = new Uint8Array(32).fill(0x33);
    const data = new Uint8Array(12);
    const dv = new DataView(data.buffer);
    dv.setUint32(0, 2, true);
    dv.setBigUint64(4, 1000n, true);
    const message = new Uint8Array([
      1,
      0,
      1,
      3,
      ...feePayer,
      ...dest,
      ...system,
      ...blockhash,
      1,
      2,
      2,
      0,
      1,
      12,
      ...data,
    ]);
    for (const partial of [
      { kind: "solana.transaction", message },
      { kind: "solana.message", message: utf8ToBytes("hello solana"), format: "raw" },
    ]) {
      const local = {
        ...partial,
        network: SOLANA_NETWORK,
        account: hd(walletId, "solana.bip44-change"),
      };
      const hardware = { ...local, account: hd(hwId, "solana.bip44-change") };
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const sw = await signLocal(h, session, local);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const hw = ok(await signOnDevice(h, session, hardware));
      expect(hw).toStrictEqual(sw);
    }
  });

  it("bitcoin psbt (bip84) is byte-identical; taproot is verified, not compared", async () => {
    const { h, session, walletId, hwId } = await boot();
    const sw84 = await signLocal(h, session, bip84Request(walletId));
    const hw84 = ok(await signOnDevice(h, session, bip84Request(hwId)));
    expect(hw84).toStrictEqual(sw84);

    const bip86 = {
      ...bip84Request(hwId),
      psbt: psbt("btc.bip86"),
      sign: [{ index: 0, template: "btc.bip86" }],
    };
    const hw86 = ok(await signOnDevice(h, session, bip86));
    expect(
      verifyBitcoinPsbtSignatures(
        bytesField(hw86, "signedPsbt"),
        [0],
        HDKey.fromMasterSeed(SEED).derive("m/86'/0'/0'").publicExtendedKey,
        "btc.bip86",
        BTC_NETWORK,
      ),
    ).toBe(true);
  });

  it("bitcoin legacy message signature", async () => {
    const { h, session, walletId, hwId } = await boot();
    const partial = {
      kind: "bitcoin.message",
      network: BTC_NETWORK,
      address: ADDRESS44,
      message: "sign this",
      format: "legacy" as const,
      change: 0 as const,
      index: 0,
    };
    const local = normalizeBitcoin({ ...partial, account: hd(walletId, "btc.bip44") });
    const hardware = normalizeBitcoin({ ...partial, account: hd(hwId, "btc.bip44") });
    const sw = await signLocal(h, session, local);
    const hw = ok(await signOnDevice(h, session, hardware));
    expect(hw).toStrictEqual(sw);
  });

  it("sends an unusual own-key output's psbt unchanged and keeps the clear line", async () => {
    /* keystone3-firmware renders every output — an own-key output at a far change index is shown
       with a badge, never hidden — so the driver sends the PSBT as-is and the `clear` device line
       stays true while the prompt shows the unusual-path row. */
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const session = strField(res, "session");
    ok(
      await h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: { kind: "hardware" } },
        session,
      ),
    );
    const paired = ok(
      await h.call(
        "hardware.begin",
        { op: { kind: "pair", device: "keystone" }, verify: { kind: "hardware" } },
        session,
      ),
    );
    const done = ok(
      await h.call(
        "hardware.step",
        {
          opId: strField(paired, "opId"),
          response: {
            kind: "qr",
            ur: { type: "crypto-multi-accounts", cbor: hexToBytes(vectors.sync.cbor) },
          },
        },
        session,
      ),
    );
    const hwId = strField(field(field(done, "result"), "wallet"), "walletId");

    // The signed input sits at /0/0: a change index past the bound is shown, not hidden.
    const tx = Transaction.fromPSBT(psbt("btc.bip84"), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    const near = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'/1/0");
    const far = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'/1/5000");
    const nearPub = near.publicKey;
    const farPub = far.publicKey;
    if (nearPub === null || farPub === null) {
      throw new Error("no change keys");
    }
    tx.addOutput({
      script: p2wpkh(nearPub).script,
      amount: 5000n,
      bip32Derivation: [
        [nearPub, { fingerprint: MFP_NUMBER, path: [HARDENED + 84, HARDENED, HARDENED, 1, 0] }],
      ],
    });
    tx.addOutput({
      script: p2wpkh(farPub).script,
      amount: 4000n,
      bip32Derivation: [
        [farPub, { fingerprint: MFP_NUMBER, path: [HARDENED + 84, HARDENED, HARDENED, 1, 5000] }],
      ],
    });
    const request = normalizeBitcoin({ ...bip84Request(hwId), psbt: tx.toPSBT(0) });
    if (request.kind !== "bitcoin.psbt") {
      throw new Error("normalizeBitcoin changed the request kind");
    }

    const seen: DeviceRequest[] = [];
    ok(
      await signOnDevice(
        h,
        session,
        request,
        {},
        (req) => {
          seen.push(req);
          return keystoneDevice(SEED, MFP).respond(req);
        },
        { kind: "hardware" },
      ),
    );

    const shown = seen
      .flatMap((r) => (r.kind === "qr" && r.show !== undefined ? [r.show] : []))
      .find((ur) => ur.type === "crypto-psbt");
    if (shown === undefined) {
      throw new Error("the driver never showed a crypto-psbt request");
    }
    const sentPsbt = new Uint8Array(CryptoPSBT.fromCBOR(Buffer.from(shown.cbor)).getPSBT());
    expect(sentPsbt).toStrictEqual(request.psbt);

    const prompt = fake.calls
      .flatMap((c) => (c.op === "open" && c.prompt !== undefined ? [c.prompt] : []))
      .at(-1);
    expect(prompt?.description.startsWith(devicePromptLine("en", "clear", "keystone"))).toBe(true);
    expect(prompt?.description).toContain("m/84'/0'/0'/1/5000");
  });
});

describe("unsupported displays refuse before the prompt", () => {
  it("eip2930, eip7702, tron typed-data and bip322 are unsupported", async () => {
    const { h, session, hwId } = await boot();

    const requests = [
      normalizeEvm({
        ...evmTx("eip2930", { gasPrice: "0x1", accessList: [] }),
        account: hd(hwId, "evm.bip44"),
      }),
      normalizeEvm({
        ...evmTx("eip7702", {
          maxFeePerGas: "0x59682f00",
          maxPriorityFeePerGas: "0x1",
          accessList: [],
          authorization: { address: EVM_DELEGATOR.address },
        }),
        account: hd(hwId, "evm.bip44"),
      }),
      normalizeTron({
        kind: "tron.typed-data",
        network: TRON_NETWORK,
        account: hd(hwId, "tron.bip44"),
        typedData: JSON.stringify({
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
            ],
            Mail: [{ name: "m", type: "string" }],
          },
          domain: { name: "Tron", version: "1", chainId: TRON_NETWORK.slice(5) },
          primaryType: "Mail",
          message: { m: "hi" },
        }),
      }),
      normalizeBitcoin({
        kind: "bitcoin.message",
        network: BTC_NETWORK,
        account: hd(hwId, "btc.bip86"),
        address: ADDRESS86,
        message: "sign this",
        format: "bip322-simple",
        change: 0,
        index: 0,
      }),
    ];
    for (const request of requests) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const result = await signOnDevice(h, session, request);
      expect(errCode(result)).toBe("unsupported");
    }
  });
});

describe("a hostile keystone is refused", () => {
  const legacy = (walletId: string) =>
    normalizeEvm({
      ...evmTx("legacy", { gasPrice: "0x4a817c800" }),
      account: hd(walletId, "evm.bip44"),
    });

  it("rejects a wrong key and a flipped signature bit", async () => {
    const { h, session, hwId } = await boot();
    const request = legacy(hwId);
    expect(errCode(await signOnDevice(h, session, request, { seed: OTHER_SEED }))).toBe(
      "integrity",
    );
    expect(errCode(await signOnDevice(h, session, request, FLIP_BIT))).toBe("integrity");
  });

  it("rejects a signature answering a different request id", async () => {
    const { h, session, hwId } = await boot();
    const request = legacy(hwId);
    expect(
      errCode(await signOnDevice(h, session, request, { requestId: new Uint8Array(16).fill(9) })),
    ).toBe("wrong-device");
  });

  it("rejects the right signature under the wrong UR type", async () => {
    const { h, session, hwId } = await boot();
    const request = legacy(hwId);
    expect(errCode(await signOnDevice(h, session, request, { urType: "sol-signature" }))).toBe(
      "integrity",
    );
  });

  it("rejects truncated, oversized and trailing-byte signature CBOR", async () => {
    const { h, session, hwId } = await boot();
    const request = legacy(hwId);
    const variants: Array<NonNullable<DeviceMutant["cbor"]>> = [
      (bytes) => bytes.subarray(0, -3),
      (bytes) => new Uint8Array([0x5b, ...new Uint8Array(8), ...bytes]),
      (bytes) => new Uint8Array([...bytes, 0x00]),
    ];
    for (const cbor of variants) {
      // oxlint-disable-next-line no-await-in-loop -- one exchange at a time
      expect(errCode(await signOnDevice(h, session, request, { cbor }))).toBe("integrity");
    }
  });

  it("accepts a bogus v when r‖s still verifies — v is ignored", async () => {
    const { h, session, walletId, hwId } = await boot();
    const request = legacy(hwId);
    const hw = ok(await signOnDevice(h, session, request, BOGUS_V));
    const sw = await signLocal(h, session, legacy(walletId));
    expect(hw).toStrictEqual(sw);
  });

  it("rejects a wrong-length signature", async () => {
    const { h, session, hwId } = await boot();
    const request = legacy(hwId);
    // An eth-signature whose signature is 64 bytes instead of 65.
    expect(errCode(await signOnDevice(h, session, request, { cbor: shortenSignature }))).toBe(
      "integrity",
    );
  });
});

describe("a hostile psbt answer is refused", () => {
  it("rejects a psbt of a different transaction, a missing signature and a wrong sighash", async () => {
    const { h, session, hwId } = await boot();
    const request = bip84Request(hwId);
    // A signed PSBT for a different (taproot) transaction is not this one signed.
    const other: DeviceMutant = {
      cbor: () => new Uint8Array(CryptoPSBT.fromCBOR(Buffer.from(psbt("btc.bip86"))).getPSBT()),
    };
    expect(errCode(await signOnDevice(h, session, request, other))).toBe("integrity");
    // The original PSBT echoed back unsigned has no partialSig for the task key.
    const unsigned: DeviceMutant = {
      cbor: () => encodeUr({ bytes: request.psbt }, cryptoPsbtCodec),
    };
    expect(errCode(await signOnDevice(h, session, request, unsigned))).toBe("integrity");
    // A real signature whose trailing sighash byte is not the planned one.
    expect(errCode(await signOnDevice(h, session, request, {}, (r) => tamperedPsbt(r)))).toBe(
      "integrity",
    );
  });

  it("rejects a 65-byte taproot signature whose sighash byte is not the planned one", async () => {
    const { h, session, hwId } = await boot();
    const request = normalizeBitcoin({
      ...bip84Request(hwId),
      psbt: psbt("btc.bip86", 0x83),
      sign: [{ index: 0, template: "btc.bip86" }],
    });
    if (request.kind !== "bitcoin.psbt") {
      throw new Error("normalizeBitcoin changed the request kind");
    }
    // The device answers an honestly signed PSBT — except the tapKeySig's sighash byte lies.
    const tamperedTapKeySig = (req: DeviceRequest): DeviceResponse => {
      const response = keystoneDevice(SEED, MFP).respond(req);
      if (response.kind !== "qr" || response.ur.type !== "crypto-psbt") {
        return response;
      }
      const signed = CryptoPSBT.fromCBOR(Buffer.from(response.ur.cbor)).getPSBT();
      const tx = Transaction.fromPSBT(new Uint8Array(signed));
      const tap = tx.getInput(0).tapKeySig;
      if (tap === undefined || tap.length !== 65) {
        throw new Error("no 65-byte tapKeySig to tamper");
      }
      tx.getInput(0).tapKeySig = new Uint8Array([...tap.subarray(0, 64), 0x02]);
      return { kind: "qr", ur: { type: "crypto-psbt", cbor: tx.toPSBT(0) } };
    };
    expect(errCode(await signOnDevice(h, session, request, {}, tamperedTapKeySig))).toBe(
      "integrity",
    );
  });

  it("rejects a btc-signature carrying another public key", async () => {
    const { h, session, hwId } = await boot();
    const request = normalizeBitcoin({
      kind: "bitcoin.message",
      network: BTC_NETWORK,
      account: hd(hwId, "btc.bip44"),
      address: ADDRESS44,
      message: "sign this",
      format: "legacy" as const,
      change: 0 as const,
      index: 0,
    });
    const otherPub: DeviceMutant["cbor"] = (bytes) =>
      replaceByteField(bytes, 3, secp256k1.getPublicKey(new Uint8Array(32).fill(7), true));
    expect(errCode(await signOnDevice(h, session, request, { cbor: otherPub }))).toBe(
      "wrong-device",
    );
  });
});

describe("the response parser only ever throws KernelError", () => {
  it("random bytes as each signature payload", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (bytes) => {
        expect(codeOf(bytes)).toBe("safe");
      }),
      { numRuns: 300 },
    );
  });
});

describe("keystone accounts over qr-hardware-call", () => {
  const accountsOp = (walletId: string, groupIndex: number) => ({
    kind: "accounts" as const,
    walletId,
    groupIndex,
    templates: ["btc.bip84", "solana.bip44-change"],
    network: BTC_NETWORK,
  });

  const runAccounts = async (
    h: Harness,
    session: string,
    op: unknown,
    mutant: DeviceMutant = {},
  ): Promise<KernelResponse> => {
    const device = keystoneDevice(SEED, MFP, mutant);
    const begin = await h.call("hardware.begin", { op, verify: PASSKEY() }, session);
    if ("err" in begin) {
      return begin;
    }
    const opId = strField(begin.ok, "opId");
    let step = field(begin.ok, "step");
    for (let guard = 0; strField(step, "kind") === "exchange" && guard < 8; guard++) {
      const deviceRequest = field(step, "request") as DeviceRequest;
      if (deviceRequest.kind !== "qr" || deviceRequest.show?.type !== "qr-hardware-call") {
        throw new Error("accounts asked for a non hardware-call exchange");
      }
      // oxlint-disable-next-line no-await-in-loop -- the coroutine advances one turn per step
      const next = await h.call(
        "hardware.step",
        { opId, response: device.respond(deviceRequest) },
        session,
      );
      if ("err" in next) {
        return next;
      }
      step = next.ok;
    }
    if (strField(step, "kind") !== "done") {
      throw new Error("accounts did not finish");
    }
    return { id: 0, ok: field(field(step, "result"), "accounts") };
  };

  const walletAccounts = async (
    h: Harness,
    session: string,
    walletId: string,
    template: string,
    network: string,
    groupIndex: number,
  ) => h.call("wallet.accounts", { walletId, groupIndex, template, network }, session);

  it("pins exactly the missing group keys, then wallet.accounts answers", async () => {
    const { h, session, hwId } = await boot();
    // Group 1 has not been derived yet: both families miss their hardened nodes.
    expect(errCode(await walletAccounts(h, session, hwId, "btc.bip84", BTC_NETWORK, 1))).toBe(
      "device-required",
    );
    expect(
      errCode(await walletAccounts(h, session, hwId, "solana.bip44-change", SOLANA_NETWORK, 1)),
    ).toBe("device-required");

    const done = await runAccounts(h, session, {
      ...accountsOp(hwId, 1),
      templates: ["btc.bip84"],
      network: BTC_NETWORK,
    });
    expect(errCode(done)).toBeUndefined();

    const btc = await walletAccounts(h, session, hwId, "btc.bip84", BTC_NETWORK, 1);
    const node = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/1'");
    const [account] = ok(done) as ProtocolValue[];
    expect(account).toBeDefined();
    expect(strField(account as ProtocolValue, "xpub")).toBe(node.publicExtendedKey);
    expect(strField(ok(btc), "xpub")).toBe(node.publicExtendedKey);
  });

  it("derives the solana group-1 leaf and refuses hostile answers", async () => {
    const { h, session, hwId } = await boot();
    const solana = async (mutant: DeviceMutant = {}) =>
      runAccounts(
        h,
        session,
        {
          kind: "accounts",
          walletId: hwId,
          groupIndex: 1,
          templates: ["solana.bip44-change"],
          network: SOLANA_NETWORK,
        },
        mutant,
      );

    // The honest answer pins m/44'/501'/1'/0' — the group-1 account leaf.
    const done = await solana();
    expect(errCode(done)).toBeUndefined();
    const account = await walletAccounts(
      h,
      session,
      hwId,
      "solana.bip44-change",
      SOLANA_NETWORK,
      1,
    );
    const leaf = Slip10.fromMasterSeed(SEED).derive("m/44'/501'/1'/0'").publicKey;
    expect(strField(ok(account), "address")).toBe(base58.encode(leaf.subarray(1)));

    // Hostile variants against a fresh wallet each miss the same gap and must fail closed.
    const hostile = async (mutant: DeviceMutant) => {
      const again = await boot();
      return runAccounts(
        again.h,
        again.session,
        {
          kind: "accounts",
          walletId: again.hwId,
          groupIndex: 1,
          templates: ["solana.bip44-change"],
          network: SOLANA_NETWORK,
        },
        mutant,
      );
    };
    expect(
      errCode(await hostile({ accounts: { fingerprint: new Uint8Array([9, 9, 9, 9]) } })),
    ).toBe("wrong-device");
    expect(errCode(await hostile({ accounts: { dropPath: "m/44'/501'/1'/0'" } }))).toBe(
      "integrity",
    );
    expect(errCode(await hostile({ accounts: { extraPath: "m/44'/60'/9'" } }))).toBe("integrity");
    expect(errCode(await hostile({ accounts: { duplicatePath: "m/44'/501'/1'/0'" } }))).toBe(
      "integrity",
    );
    expect(errCode(await hostile({ accounts: { badKeyPath: "m/44'/501'/1'/0'" } }))).toBe(
      "integrity",
    );

    // A secp256k1 answer whose point is not on the curve is refused the same way.
    const btc = await boot();
    expect(
      errCode(
        await runAccounts(
          btc.h,
          btc.session,
          {
            kind: "accounts",
            walletId: btc.hwId,
            groupIndex: 1,
            templates: ["btc.bip84"],
            network: BTC_NETWORK,
          },
          { accounts: { badKeyPath: "m/84'/0'/1'" } },
        ),
      ),
    ).toBe("integrity");
  });

  it("refuses a path the firmware cannot derive before any exchange", async () => {
    let asked = false;
    const link = {
      exchange: async (): Promise<DeviceResponse> => {
        asked = true;
        return Promise.reject(new Error("unreachable"));
      },
    };
    // m/44'/1' is not in the firmware allow-list.
    await expect(
      derive(
        link,
        { secp256k1: [[44 + HARDENED, 1 + HARDENED, HARDENED]], ed25519: [] },
        { fingerprint: MFP },
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(asked).toBe(false);
  });
});
