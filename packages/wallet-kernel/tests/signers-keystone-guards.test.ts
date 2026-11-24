import {
  CborMap,
  Tag,
  cbor,
  decodeCbor,
  encodeCbor,
  expectMap,
  isBytes,
  isUnsigned,
  taggedValue,
} from "@blockchaincommons/dcbor";
/**
 * Guard-level unit tests on the Keystone exchanges and the record id binding: a staged plan that no
 * longer matches the request about to be shown, a solana answer of the wrong length or a message
 * the task never carried, a signed PSBT that is not the one shown, an invalid point in a
 * key-derivation answer, and a hardware record whose header does not name its id all fail closed.
 */
import { CryptoPSBT } from "@keystonehq/bc-ur-registry-btc";
import { ed25519 } from "@noble/curves/ed25519.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2pkh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinNetwork, planBitcoinMessage, planBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { planEvm } from "@qntx/wallet-chains/evm";
import { planSolana } from "@qntx/wallet-chains/solana";
import { buildTronRawData, planTron } from "@qntx/wallet-chains/tron";
import type {
  ChainSignRequest,
  ChainTemplate,
  DeviceRequest,
  DeviceResponse,
} from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import type { DeviceLink, SignContext } from "../src/modules/signers/driver.ts";
import { createSignersModule } from "../src/modules/signers/index.ts";
import { derive } from "../src/modules/signers/keystone/derive.ts";
import { KEYSTONE_DRIVER } from "../src/modules/signers/keystone/driver.ts";
import { LEDGER_DRIVER } from "../src/modules/signers/ledger/driver.ts";
import { ONEKEY_DRIVER } from "../src/modules/signers/onekey/driver.ts";
import { sign } from "../src/modules/signers/keystone/sign.ts";
import { keystoneDevice } from "./signers-keystone-device.ts";

const HARDENED = 0x80000000;
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = mnemonicToSeedSync(MNEMONIC);
const MFP = HDKey.fromMasterSeed(SEED).fingerprint;
const MFP_BYTES = new Uint8Array(4);
new DataView(MFP_BYTES.buffer).setUint32(0, MFP);

const EVM_NETWORK = "eip155:1";
const TRON_NETWORK = "tron:728126428";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const EVM_PATH = [44 + HARDENED, 60 + HARDENED, HARDENED, 0, 0];
const SOLANA_PATH = [44 + HARDENED, 501 + HARDENED, HARDENED, HARDENED];
const BTC84_PATH = [84 + HARDENED, HARDENED, HARDENED, 0, 0];
const BTC44_PATH = [44 + HARDENED, HARDENED, HARDENED, 0, 0];
const TRON_PATH = [44 + HARDENED, 195 + HARDENED, HARDENED, 0, 0];
const BTC86_PATH = [86 + HARDENED, HARDENED, HARDENED, 0, 0];

const pub = (path: string): Uint8Array => {
  const key = HDKey.fromMasterSeed(SEED).derive(path).publicKey;
  if (key === null) {
    throw new Error(`no key at ${path}`);
  }
  return key;
};
const EVM_PUB = pub("m/44'/60'/0'/0/0");
const BTC84_PUB = pub("m/84'/0'/0'/0/0");
const BTC44_PUB = pub("m/44'/0'/0'/0/0");
const TRON_PUB = pub("m/44'/195'/0'/0/0");
const BTC86_PUB = pub("m/86'/0'/0'/0/0");
const SOLANA_PUB = ed25519.getPublicKey(
  Slip10.fromMasterSeed(SEED).derive("m/44'/501'/0'/0'").privateKey,
);

const EVM_KEY = { path: EVM_PATH, publicKey: EVM_PUB };
const TRON_KEY = { path: TRON_PATH, publicKey: TRON_PUB };
const BTC44_KEY = { path: BTC44_PATH, publicKey: BTC44_PUB };
const SOLANA_KEY = { path: SOLANA_PATH, publicKey: SOLANA_PUB };

const pin = { fingerprint: MFP_BYTES, nodes: [], ed25519: [] };
const random = (length: number): Uint8Array => new Uint8Array(length).fill(0x42);

/** A link that plays the fake firmware verbatim (or through `respond`). */
const link = (respond?: (request: DeviceRequest) => DeviceResponse): DeviceLink => ({
  exchange: async (request) =>
    Promise.resolve(
      respond === undefined ? keystoneDevice(SEED, MFP_BYTES).respond(request) : respond(request),
    ),
});

const code = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError);
    return (error as KernelError).code;
  }
  throw new Error("expected the call to fail");
};

const hd = <T extends ChainTemplate>(template: T) => ({
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template,
});

const BTC44_ADDRESS = ((): string => {
  const { address } = p2pkh(BTC44_PUB, bitcoinNetwork(BTC_NETWORK).params);
  if (address === undefined) {
    throw new Error("no p2pkh address");
  }
  return address;
})();

const TYPED_DATA = JSON.stringify({
  types: {
    EIP712Domain: [{ name: "name", type: "string" }],
    Mail: [{ name: "m", type: "string" }],
  },
  domain: { name: "X" },
  primaryType: "Mail",
  message: { m: "hi" },
});
const OTHER_TYPED_DATA = JSON.stringify({
  types: {
    EIP712Domain: [{ name: "name", type: "string" }],
    Mail: [{ name: "m", type: "string" }],
  },
  domain: { name: "X" },
  primaryType: "Mail",
  message: { m: "bye" },
});

const tronTransfer = (amount: bigint): Uint8Array =>
  buildTronRawData(
    {
      refBlock: { number: 1, id: "a".repeat(64) },
      expiration: 1_700_000_000_000,
      timestamp: 1_699_999_000_000,
    },
    {
      type: "TransferContract",
      owner: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6",
      to: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6",
      amount,
    },
  );

/** A one-input P2WPKH PSBT spending the wallet's m/84'/0'/0'/0/0 key, like the e2e fixture. */
const psbt84 = (): Uint8Array => {
  const child = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'/0/0");
  if (child.publicKey === null) {
    throw new Error("no child key");
  }
  const spend = p2wpkh(child.publicKey);
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
  prev.addInput({ txid: new Uint8Array(32).fill(0x11), index: 0, sequence: 0xffffffff });
  prev.addOutput({ script: spend.script, amount: 100_000n });
  tx.addInput({
    txid: prev.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: spend.script, amount: 100_000n },
    bip32Derivation: [[child.publicKey, { fingerprint: MFP, path: BTC84_PATH }]],
  });
  const payee = OutScript.encode(
    Address(bitcoinNetwork(BTC_NETWORK).params).decode(
      "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
    ),
  );
  tx.addOutput({ script: payee, amount: 90_000n });
  return tx.toPSBT(0);
};

const psbt84Context = (): SignContext => {
  const bytes = psbt84();
  return {
    request: {
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: { kind: "hd", walletId: "w", groupIndex: 0 },
      psbt: bytes,
      sign: [{ index: 0, template: "btc.bip84" }],
    },
    stage: planBitcoinPsbt(bytes, [{ index: 0, key: { path: BTC84_PATH, publicKey: BTC84_PUB } }]),
    pin,
    display: "clear",
    random,
  };
};

/** A one-input P2TR PSBT spending the wallet's m/86'/0'/0'/0/0 internal key. */
const psbt86Context = (): SignContext => {
  const spend = p2tr(BTC86_PUB.subarray(1));
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
  prev.addInput({ txid: new Uint8Array(32).fill(0x11), index: 0, sequence: 0xffffffff });
  prev.addOutput({ script: spend.script, amount: 100_000n });
  tx.addInput({
    txid: prev.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: spend.script, amount: 100_000n },
    tapInternalKey: BTC86_PUB.subarray(1),
    tapBip32Derivation: [
      [BTC86_PUB.subarray(1), { hashes: [], der: { fingerprint: MFP, path: BTC86_PATH } }],
    ],
  });
  const payee = OutScript.encode(
    Address(bitcoinNetwork(BTC_NETWORK).params).decode(
      "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
    ),
  );
  tx.addOutput({ script: payee, amount: 90_000n });
  const bytes = tx.toPSBT(0);
  return {
    request: {
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: { kind: "hd", walletId: "w", groupIndex: 0 },
      psbt: bytes,
      sign: [{ index: 0, template: "btc.bip86" }],
    },
    stage: planBitcoinPsbt(bytes, [{ index: 0, key: { path: BTC86_PATH, publicKey: BTC86_PUB } }]),
    pin,
    display: "clear",
    random,
  };
};

/** The device's signed PSBT bytes, ready for byte-level tampering before re-wrapping. */
const signedPsbtBytes = (request: DeviceRequest): Uint8Array => {
  const response = keystoneDevice(SEED, MFP_BYTES).respond(request);
  if (response.kind !== "qr" || response.ur.type !== "crypto-psbt") {
    throw new Error("no crypto-psbt answer");
  }
  return new Uint8Array(CryptoPSBT.fromCBOR(Buffer.from(response.ur.cbor)).getPSBT());
};

const wrapPsbt = (bytes: Uint8Array): DeviceResponse => ({
  kind: "qr",
  ur: {
    type: "crypto-psbt",
    cbor: new Uint8Array(new CryptoPSBT(Buffer.from(bytes)).toCBOR()),
  },
});

const indexOf = (haystack: Uint8Array, needle: Uint8Array): number => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
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

/** Signs verbatim, then rewrites the signature field to an oversized 65 bytes. */
const longSignature = (request: DeviceRequest): DeviceResponse => {
  const response = keystoneDevice(SEED, MFP_BYTES).respond(request);
  if (response.kind !== "qr") {
    throw new Error("no qr answer");
  }
  const sig = new Uint8Array(65);
  sig[0] = 1;
  return {
    kind: "qr",
    ur: { type: response.ur.type, cbor: replaceByteField(response.ur.cbor, 2, sig) },
  };
};

/** Signs verbatim, then shifts the payee output's 90 000-sat amount inside the signed PSBT. */
const tamperedPayee = (request: DeviceRequest): DeviceResponse => {
  const bytes = signedPsbtBytes(request);
  const at = indexOf(bytes, new Uint8Array([0x90, 0x5f, 0x01]));
  if (at < 0) {
    throw new Error("output amount not found");
  }
  bytes[at] = 0x91;
  return wrapPsbt(bytes);
};

/** Signs verbatim, then rewrites the partial signature's trailing sighash byte. */
const tamperedSighash = (request: DeviceRequest): DeviceResponse => {
  const bytes = signedPsbtBytes(request);
  const [entry] = Transaction.fromPSBT(bytes).getInput(0).partialSig ?? [];
  if (entry === undefined) {
    throw new Error("no partialSig to tamper");
  }
  const at = indexOf(bytes, entry[1]);
  if (at < 0) {
    throw new Error("signature not found");
  }
  bytes[at + entry[1].length - 1] = 0x02;
  return wrapPsbt(bytes);
};

/** Signs verbatim, then extends the taproot key signature with a sighash byte. */
const tamperedTapSighash = (request: DeviceRequest): DeviceResponse => {
  const bytes = signedPsbtBytes(request);
  const tx = Transaction.fromPSBT(bytes);
  const current = tx.getInput(0).tapKeySig;
  if (current === undefined) {
    throw new Error("no tapKeySig to tamper");
  }
  const wider = new Uint8Array(current.length + 1);
  wider.set(current);
  wider[current.length] = 0x01;
  tx.updateInput(0, { tapKeySig: wider });
  return wrapPsbt(tx.toPSBT(0));
};

describe("keystone sign stage/request consistency", () => {
  it("refuses a plan whose task digest is not the request's preimage digest", async () => {
    const request: Extract<ChainSignRequest, { kind: "evm.transaction" }> = {
      kind: "evm.transaction",
      network: EVM_NETWORK,
      account: hd("evm.bip44"),
      tx: {
        type: "legacy",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        gasPrice: "0x4a817c800",
        value: "0xde0b6b3a7640000",
        data: "0x",
        to: "0x00000000000000000000000000000000deadbeef",
      },
    };
    const stage = planEvm({ ...request, tx: { ...request.tx, nonce: 1 } }, EVM_KEY);
    await expect(code(async () => sign(link(), { request, stage, pin, display: "clear", random }))).resolves.toBe(
      "integrity",
    );
  });

  it("refuses a mismatched stage on every secp256k1 family", async () => {
    const personal: Extract<ChainSignRequest, { kind: "evm.personal-message" }> = {
      kind: "evm.personal-message",
      network: EVM_NETWORK,
      account: hd("evm.bip44"),
      message: utf8ToBytes("hello"),
    };
    const fiat24: Extract<ChainSignRequest, { kind: "evm.fiat24-session" }> = {
      kind: "evm.fiat24-session",
      network: "eip155:42161",
      account: hd("evm.bip44"),
      tokenId: "7",
      deadline: 1_700_000_600,
    };
    const typed: Extract<ChainSignRequest, { kind: "evm.typed-data" }> = {
      kind: "evm.typed-data",
      network: EVM_NETWORK,
      account: hd("evm.bip44"),
      typedData: TYPED_DATA,
    };
    const tronTx: Extract<ChainSignRequest, { kind: "tron.transaction" }> = {
      kind: "tron.transaction",
      network: TRON_NETWORK,
      account: hd("tron.bip44"),
      rawData: tronTransfer(1n),
    };
    const tronMsg: Extract<ChainSignRequest, { kind: "tron.message" }> = {
      kind: "tron.message",
      network: TRON_NETWORK,
      account: hd("tron.bip44"),
      message: utf8ToBytes("hello tron"),
    };
    const btcMsg: Extract<ChainSignRequest, { kind: "bitcoin.message" }> = {
      kind: "bitcoin.message",
      network: BTC_NETWORK,
      account: hd("btc.bip44"),
      address: BTC44_ADDRESS,
      message: "sign this",
      format: "legacy",
      change: 0,
      index: 0,
    };
    const contexts: SignContext[] = [
      {
        request: personal,
        stage: planEvm({ ...personal, message: utf8ToBytes("bye") }, EVM_KEY),
        pin,
        display: "clear",
        random,
      },
      {
        request: fiat24,
        stage: planEvm({ ...fiat24, tokenId: "8" }, EVM_KEY),
        pin,
        display: "clear",
        random,
      },
      {
        request: typed,
        stage: planEvm({ ...typed, typedData: OTHER_TYPED_DATA }, EVM_KEY),
        pin,
        display: "clear",
        random,
      },
      {
        request: tronTx,
        stage: planTron({ ...tronTx, rawData: tronTransfer(2n) }, TRON_KEY),
        pin,
        display: "clear",
        random,
      },
      {
        request: tronMsg,
        stage: planTron({ ...tronMsg, message: utf8ToBytes("bye tron") }, TRON_KEY),
        pin,
        display: "clear",
        random,
      },
      {
        request: btcMsg,
        stage: planBitcoinMessage({ ...btcMsg, message: "sign that" }, BTC44_KEY),
        pin,
        display: "clear",
        random,
      },
    ];
    for (const context of contexts) {
      // oxlint-disable-next-line no-await-in-loop -- one device exchange at a time
      await expect(code(async () => sign(link(), context))).resolves.toBe("integrity");
    }
  });

  it("refuses a solana answer whose task message the request never carried", async () => {
    const request: Extract<ChainSignRequest, { kind: "solana.message" }> = {
      kind: "solana.message",
      network: SOLANA_NETWORK,
      account: hd("solana.bip44-change"),
      message: utf8ToBytes("transfer auth"),
      format: "raw",
    };
    const stage = planSolana({ ...request, message: utf8ToBytes("different") }, SOLANA_KEY);
    await expect(code(async () => sign(link(), { request, stage, pin, display: "clear", random }))).resolves.toBe(
      "integrity",
    );
  });

  it("refuses a solana signature that is not 64 bytes", async () => {
    const request: Extract<ChainSignRequest, { kind: "solana.message" }> = {
      kind: "solana.message",
      network: SOLANA_NETWORK,
      account: hd("solana.bip44-change"),
      message: utf8ToBytes("transfer auth"),
      format: "raw",
    };
    const stage = planSolana(request, SOLANA_KEY);
    await expect(
      code(async () => sign(link(longSignature), { request, stage, pin, display: "clear", random })),
    ).resolves.toBe("integrity");
  });
});

describe("keystone psbt answer binding", () => {
  it("refuses a crypto-psbt answer that is not a PSBT", async () => {
    const hostile: DeviceLink = {
      exchange: async () =>
        Promise.resolve({
          kind: "qr",
          ur: { type: "crypto-psbt", cbor: encodeCbor(cbor(new Uint8Array(42))) },
        }),
    };
    await expect(code(async () => sign(hostile, psbt84Context()))).resolves.toBe("integrity");
  });

  it("refuses a signed PSBT whose transaction content differs", async () => {
    await expect(code(async () => sign(link(tamperedPayee), psbt84Context()))).resolves.toBe(
      "integrity",
    );
  });

  it("refuses a partialSig whose trailing sighash is not the planned one", async () => {
    await expect(code(async () => sign(link(tamperedSighash), psbt84Context()))).resolves.toBe(
      "integrity",
    );
  });

  it("refuses a tapKeySig whose sighash the plan did not ask for", async () => {
    await expect(code(async () => sign(link(tamperedTapSighash), psbt86Context()))).resolves.toBe(
      "integrity",
    );
  });
});

describe("keystone key-derivation answer", () => {
  it("refuses a 33-byte secp256k1 key that is not a valid point", async () => {
    const path = [84 + HARDENED, HARDENED, 1 + HARDENED];
    const badKey = new Uint8Array(33);
    badKey[0] = 0x02;
    const keypath = new CborMap();
    keypath.set(
      1,
      path.flatMap((index) => [index % HARDENED, index >= HARDENED]),
    );
    keypath.set(2, MFP);
    const hdkey = new CborMap();
    hdkey.set(3, badKey);
    hdkey.set(4, new Uint8Array(32).fill(7));
    hdkey.set(6, taggedValue(Tag.from(304), cbor(keypath)));
    const accounts = new CborMap();
    accounts.set(1, MFP);
    accounts.set(2, [taggedValue(Tag.from(303), cbor(hdkey))]);
    const multiAccountsBytes = encodeCbor(cbor(accounts));
    const hostile: DeviceLink = {
      exchange: async () =>
        Promise.resolve({
          kind: "qr",
          ur: { type: "crypto-multi-accounts", cbor: multiAccountsBytes },
        }),
    };
    await expect(
      code(async () => derive(hostile, { secp256k1: [path], ed25519: [] }, pin)),
    ).resolves.toBe("integrity");
  });
});

describe("hardware-wallet record id binding", () => {
  it("a header that does not name its record id is integrity", () => {
    const module = createSignersModule({ keystone: KEYSTONE_DRIVER, ledger: LEDGER_DRIVER, onekey: ONEKEY_DRIVER });
    const record = {
      kind: "hardware-wallet",
      id: "deadbeefdeadbeef",
      header: JSON.stringify({ device: "keystone", fingerprint: "a1b2c3d4", createdAt: 1 }),
      sealed: new Uint8Array(0),
    };
    expect(() => module.vault.parseHeader(record)).toThrow(KernelError);
  });
});
