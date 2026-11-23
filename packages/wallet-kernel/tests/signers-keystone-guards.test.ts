/**
 * Guard-level unit tests on the Keystone exchanges and the record id binding: a staged plan whose
 * digest no longer matches the bytes about to be shown, a solana answer of the wrong length or a
 * message the task never carried, a signed PSBT that is not the one shown, an invalid point in a
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

import {
  bitcoinNetwork,
  normalizeBitcoin,
  planBitcoinMessage,
  planBitcoinPsbt,
} from "@qntx/wallet-chains/bitcoin";
import { normalizeEvm, planEvm } from "@qntx/wallet-chains/evm";
import { planSolana } from "@qntx/wallet-chains/solana";
import { buildTronRawData, normalizeTron, planTron } from "@qntx/wallet-chains/tron";
import type { DeviceRequest, DeviceResponse } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import type { DeviceLink, SignContext } from "../src/modules/signers/driver.ts";
import { createSignersModule } from "../src/modules/signers/index.ts";
import { decodeCbor, encodeCbor } from "../src/modules/signers/keystone/cbor.ts";
import { derive } from "../src/modules/signers/keystone/derive.ts";
import { KEYSTONE_DRIVER } from "../src/modules/signers/keystone/driver.ts";
import type { Cbor } from "../src/modules/signers/keystone/cbor.ts";
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

const pin = { fingerprint: MFP_BYTES, nodes: [], ed25519: [] };
const random = (length: number): Uint8Array => new Uint8Array(length).fill(0x42);

/** A link that plays the fake firmware verbatim (or through `respond`). */
const link = (respond?: (request: DeviceRequest) => DeviceResponse): DeviceLink => ({
  exchange: async (request) =>
    respond === undefined ? keystoneDevice(SEED, MFP_BYTES).respond(request) : respond(request),
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

const evmStage = (): { request: ChainSignRequestT; stage: ReturnType<typeof planEvm> } => {
  const request = normalizeEvm({
    kind: "evm.transaction",
    network: EVM_NETWORK,
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
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
  });
  return { request, stage: planEvm(request, { path: EVM_PATH, publicKey: EVM_PUB }) };
};

type ChainSignRequestT = SignContext["request"];

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
    bip32Derivation: [
      [
        child.publicKey,
        { fingerprint: MFP, path: BTC84_PATH },
      ],
    ],
  });
  const payee = OutScript.encode(
    Address(bitcoinNetwork(BTC_NETWORK).params).decode("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"),
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
    stage: planBitcoinPsbt(bytes, [
      { index: 0, key: { path: BTC84_PATH, publicKey: BTC84_PUB } },
    ]),
    pin,
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
  const map = decodeCbor(bytes);
  if (map.kind !== "map") {
    throw new Error("not a map");
  }
  return encodeCbor({
    kind: "map",
    entries: map.entries.map(([key, item]) =>
      key.kind === "uint" && key.value === n && item.kind === "bytes"
        ? [key, { kind: "bytes" as const, value }]
        : [key, item],
    ),
  });
};

describe("keystone sign stage/digest consistency", () => {
  it("refuses a plan whose task digest is not the request's preimage digest", async () => {
    const { request, stage } = evmStage();
    const [task] = stage.tasks;
    const tampered = { ...stage, tasks: [{ ...task, digest: new Uint8Array(32) }] };
    await expect(code(async () => sign(link(), { request, stage: tampered, pin, random }))).resolves
      .toBe("integrity");
  });

  it("refuses a tampered task digest on every secp256k1 family", async () => {
    const account = {
      kind: "hd" as const,
      walletId: "w",
      groupIndex: 0,
      template: "evm.bip44" as const,
    };
    const tronAccount = { ...account, template: "tron.bip44" as const };
    const btcAccount = { ...account, template: "btc.bip44" as const };
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "m", type: "string" }],
      },
      domain: { name: "X" },
      primaryType: "Mail",
      message: { m: "hi" },
    });
    const address = p2pkh(BTC44_PUB, bitcoinNetwork(BTC_NETWORK).params).address;
    const tronRaw = buildTronRawData(
      {
        refBlock: { number: 1, id: "a".repeat(64) },
        expiration: 1_700_000_000_000,
        timestamp: 1_699_999_000_000,
      },
      {
        type: "TransferContract",
        owner: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6",
        to: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6",
        amount: 1n,
      },
    );
    const contexts: SignContext[] = [
      {
        request: normalizeEvm({
          kind: "evm.personal-message",
          network: EVM_NETWORK,
          account,
          message: utf8ToBytes("hello"),
        }),
        stage: planEvm(
          normalizeEvm({
            kind: "evm.personal-message",
            network: EVM_NETWORK,
            account,
            message: utf8ToBytes("hello"),
          }),
          { path: EVM_PATH, publicKey: EVM_PUB },
        ),
        pin,
        random,
      },
      {
        request: normalizeEvm({
          kind: "evm.fiat24-session",
          network: "eip155:42161",
          account,
          tokenId: "7",
          deadline: 1_700_000_600,
        }),
        stage: planEvm(
          normalizeEvm({
            kind: "evm.fiat24-session",
            network: "eip155:42161",
            account,
            tokenId: "7",
            deadline: 1_700_000_600,
          }),
          { path: EVM_PATH, publicKey: EVM_PUB },
        ),
        pin,
        random,
      },
      {
        request: normalizeEvm({
          kind: "evm.typed-data",
          network: EVM_NETWORK,
          account,
          typedData,
        }),
        stage: planEvm(
          normalizeEvm({ kind: "evm.typed-data", network: EVM_NETWORK, account, typedData }),
          { path: EVM_PATH, publicKey: EVM_PUB },
        ),
        pin,
        random,
      },
      {
        request: normalizeTron({
          kind: "tron.transaction",
          network: TRON_NETWORK,
          account: tronAccount,
          rawData: tronRaw,
        }),
        stage: planTron(
          normalizeTron({
            kind: "tron.transaction",
            network: TRON_NETWORK,
            account: tronAccount,
            rawData: tronRaw,
          }),
          { path: TRON_PATH, publicKey: TRON_PUB },
        ),
        pin,
        random,
      },
      {
        request: normalizeTron({
          kind: "tron.message",
          network: TRON_NETWORK,
          account: tronAccount,
          message: utf8ToBytes("hello tron"),
        }),
        stage: planTron(
          normalizeTron({
            kind: "tron.message",
            network: TRON_NETWORK,
            account: tronAccount,
            message: utf8ToBytes("hello tron"),
          }),
          { path: TRON_PATH, publicKey: TRON_PUB },
        ),
        pin,
        random,
      },
      {
        request: normalizeBitcoin({
          kind: "bitcoin.message",
          network: BTC_NETWORK,
          account: btcAccount,
          address,
          message: "sign this",
          format: "legacy" as const,
          change: 0 as const,
          index: 0,
        }),
        stage: planBitcoinMessage(
          { network: BTC_NETWORK, address, message: "sign this", format: "legacy" },
          { path: BTC44_PATH, publicKey: BTC44_PUB },
        ),
        pin,
        random,
      },
    ];
    for (const context of contexts) {
      const stage = {
        ...context.stage,
        tasks: context.stage.tasks.map((task, i) =>
          i === 0 && "digest" in task ? { ...task, digest: new Uint8Array(32) } : task,
        ),
      };
      // oxlint-disable-next-line no-await-in-loop -- one exchange at a time
      await expect(
        code(async () => sign(link(), { ...context, stage })),
      ).resolves.toBe("integrity");
    }
  });

  it("refuses a solana answer whose task message the request never carried", async () => {
    const request = {
      kind: "solana.message" as const,
      network: SOLANA_NETWORK,
      account: {
        kind: "hd" as const,
        walletId: "w",
        groupIndex: 0,
        template: "solana.bip44" as const,
      },
      message: utf8ToBytes("transfer auth"),
      format: "raw" as const,
    };
    const publicKey = ed25519.getPublicKey(
      Slip10.fromMasterSeed(SEED).derive("m/44'/501'/0'/0'").privateKey,
    );
    const stage = planSolana(request, { path: SOLANA_PATH, publicKey });
    const [task] = stage.tasks;
    const tampered = { ...stage, tasks: [{ ...task, message: utf8ToBytes("different") }] };
    await expect(code(async () => sign(link(), { request, stage: tampered, pin, random }))).resolves
      .toBe("integrity");
  });

  it("refuses a solana signature that is not 64 bytes", async () => {
    const request = {
      kind: "solana.message" as const,
      network: SOLANA_NETWORK,
      account: {
        kind: "hd" as const,
        walletId: "w",
        groupIndex: 0,
        template: "solana.bip44" as const,
      },
      message: utf8ToBytes("transfer auth"),
      format: "raw" as const,
    };
    const publicKey = ed25519.getPublicKey(
      Slip10.fromMasterSeed(SEED).derive("m/44'/501'/0'/0'").privateKey,
    );
    const stage = planSolana(request, { path: SOLANA_PATH, publicKey });
    const long = (req: DeviceRequest): DeviceResponse => {
      const response = keystoneDevice(SEED, MFP_BYTES).respond(req);
      if (response.kind !== "qr") {
        throw new Error("no qr answer");
      }
      const sig = new Uint8Array(65);
      sig[0] = 1;
      return {
        kind: "qr",
        ur: {
          type: response.ur.type,
          cbor: replaceByteField(response.ur.cbor, 2, sig),
        },
      };
    };
    await expect(
      code(async () => sign(link(long), { request, stage, pin, random })),
    ).resolves.toBe("integrity");
  });
});

describe("keystone psbt answer binding", () => {
  it("refuses a signed PSBT whose transaction content differs", async () => {
    const context = psbt84Context();
    const respond = (req: DeviceRequest): DeviceResponse => {
      const bytes = signedPsbtBytes(req);
      // The payee output's 90 000-sat amount, little-endian inside the unsigned transaction.
      const at = indexOf(bytes, new Uint8Array([0x90, 0x5f, 0x01]));
      if (at < 0) {
        throw new Error("output amount not found");
      }
      bytes[at] = 0x91;
      return wrapPsbt(bytes);
    };
    await expect(code(async () => sign(link(respond), context))).resolves.toBe("integrity");
  });

  it("refuses a partialSig whose trailing sighash is not the planned one", async () => {
    const context = psbt84Context();
    const respond = (req: DeviceRequest): DeviceResponse => {
      const bytes = signedPsbtBytes(req);
      const tx = Transaction.fromPSBT(bytes);
      const [entry] = tx.getInput(0).partialSig ?? [];
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
    await expect(code(async () => sign(link(respond), context))).resolves.toBe("integrity");
  });

  it("refuses a tapKeySig whose sighash the plan did not ask for", async () => {
    const child = HDKey.fromMasterSeed(SEED).derive("m/86'/0'/0'/0/0");
    if (child.publicKey === null) {
      throw new Error("no child key");
    }
    const spend = p2tr(child.publicKey.subarray(1));
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({ txid: new Uint8Array(32).fill(0x11), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: spend.script, amount: 100_000n });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: spend.script, amount: 100_000n },
      tapInternalKey: child.publicKey.subarray(1),
      tapBip32Derivation: [
        [
          child.publicKey.subarray(1),
          {
            hashes: [],
            der: { fingerprint: MFP, path: [86 + HARDENED, HARDENED, HARDENED, 0, 0] },
          },
        ],
      ],
    });
    const payee = OutScript.encode(
      Address(bitcoinNetwork(BTC_NETWORK).params).decode(
        "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
      ),
    );
    tx.addOutput({ script: payee, amount: 90_000n });
    const bytes = tx.toPSBT(0);
    const path = [86 + HARDENED, HARDENED, HARDENED, 0, 0];
    const context: SignContext = {
      request: {
        kind: "bitcoin.psbt",
        network: BTC_NETWORK,
        account: { kind: "hd", walletId: "w", groupIndex: 0 },
        psbt: bytes,
        sign: [{ index: 0, template: "btc.bip86" }],
      },
      stage: planBitcoinPsbt(bytes, [
        { index: 0, key: { path, publicKey: child.publicKey } },
      ]),
      pin,
      random,
    };
    const tampered = (req: DeviceRequest): DeviceResponse => {
      const bytes = signedPsbtBytes(req);
      const tx = Transaction.fromPSBT(bytes);
      tx.updateInput(0, {
        tapKeySig: new Uint8Array([...(tx.getInput(0).tapKeySig ?? new Uint8Array(0)), 0x01]),
      });
      return wrapPsbt(tx.toPSBT(0));
    };
    await expect(code(async () => sign(link(tampered), context))).resolves.toBe("integrity");
  });
});

describe("keystone key-derivation answer", () => {
  it("refuses a 33-byte secp256k1 key that is not a valid point", async () => {
    const path = [84 + HARDENED, HARDENED, 1 + HARDENED];
    const badKey = new Uint8Array(33);
    badKey[0] = 0x02;
    const cbor = encodeCbor({
      kind: "map",
      entries: [
        [{ kind: "uint", value: 1 }, { kind: "uint", value: MFP }],
        [
          { kind: "uint", value: 2 },
          {
            kind: "array",
            items: [
              {
                kind: "tag",
                tag: 303,
                item: {
                  kind: "map",
                  entries: [
                    [{ kind: "uint", value: 3 }, { kind: "bytes", value: badKey }],
                    [
                      { kind: "uint", value: 4 },
                      { kind: "bytes", value: new Uint8Array(32).fill(7) },
                    ],
                    [
                      { kind: "uint", value: 6 },
                      {
                        kind: "tag",
                        tag: 304,
                        item: {
                          kind: "map",
                          entries: [
                            [
                              { kind: "uint", value: 1 },
                              {
                                kind: "array",
                                items: path.flatMap((index): Cbor[] => [
                                  { kind: "uint", value: index % HARDENED },
                                  { kind: "bool", value: index >= HARDENED },
                                ]),
                              },
                            ],
                            [{ kind: "uint", value: 2 }, { kind: "uint", value: MFP }],
                          ],
                        },
                      },
                    ],
                  ],
                },
              },
            ],
          },
        ],
      ],
    });
    const hostile: DeviceLink = {
      exchange: async () => ({ kind: "qr", ur: { type: "crypto-multi-accounts", cbor } }),
    };
    await expect(
      code(async () => derive(hostile, { secp256k1: [path], ed25519: [] }, pin)),
    ).resolves.toBe("integrity");
  });
});

describe("hardware-wallet record id binding", () => {
  it("a header that does not name its record id is integrity", () => {
    const module = createSignersModule({ keystone: KEYSTONE_DRIVER });
    const record = {
      kind: "hardware-wallet",
      id: "deadbeefdeadbeef",
      header: JSON.stringify({ device: "keystone", fingerprint: "a1b2c3d4", createdAt: 1 }),
      sealed: new Uint8Array(0),
    };
    expect(() => module.vault.parseHeader(record)).toThrow(KernelError);
  });
});
