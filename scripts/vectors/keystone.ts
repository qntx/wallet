/// <reference types="node" />
/**
 * Regenerates vectors/keystone/sync.json without importing kernel or wallet-chains code.
 *
 * The independent oracle is @keystonehq/bc-ur-registry 0.8.1 (Apache-2.0): it encodes the same
 * crypto-multi-accounts shape the Keystone 3 Pro firmware produces for its Keystone-Connect sync
 * (rust/apps/wallets/src/keystone_connect.rs driven by gui_wallet.c's chain path list). The key
 * set, paths, notes and device strings mirror the firmware call sites; the keys themselves are
 * derived from the standard test mnemonic with @scure/bip32 (BIP-32) and micro-key-producer's
 * SLIP-10 (ed25519), so the kernel test can check every pinned key byte-for-byte.
 *
 * Three extra decode vectors come from the firmware's own test fixtures: the two
 * UR:CRYPTO-MULTI-ACCOUNTS strings captured in ur-registry's crypto_multi_accounts.rs tests, and
 * the literal encode-test hex from the same file (a synthetic shape the sync parser must reject — a
 * 33-byte key on an ed25519 path).
 *
 * Run from the repo root: bun scripts/vectors/keystone.ts
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  CryptoHDKey,
  CryptoKeypath,
  CryptoMultiAccounts,
  Curve,
  DerivationAlgorithm,
  KeyDerivation,
  KeyDerivationSchema,
  PathComponent,
  QRHardwareCall,
  QRHardwareCallType,
} from "@keystonehq/bc-ur-registry";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
// The family packages' own dependency copies are CJS — require them so bun resolves their
// `bc-ur-registry` the same way the published packages do.
const require = createRequire(import.meta.url);
const {
  DataType: BtcDataType,
  BtcSignRequest,
  CryptoPSBT: BtcCryptoPSBT,
  CryptoKeypath: BtcKeypath,
  PathComponent: BtcPathComponent,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS package ships no usable types
} = require("@keystonehq/bc-ur-registry-btc") as {
  CryptoKeypath: typeof CryptoKeypath;
  PathComponent: typeof PathComponent;
  DataType: { message: number };
  BtcSignRequest: new (args: {
    requestId: Buffer;
    signData: Buffer;
    dataType: number;
    derivationPaths: Array<InstanceType<typeof CryptoKeypath>>;
    origin?: string;
  }) => { toCBOR: () => Uint8Array };
  CryptoPSBT: new (psbt: Buffer) => { toCBOR: () => Uint8Array };
};
const {
  DataType: EthDataType,
  EthSignRequest,
  CryptoKeypath: EthKeypath,
  PathComponent: EthPathComponent,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS package ships no usable types
} = require("@keystonehq/bc-ur-registry-eth") as {
  CryptoKeypath: typeof CryptoKeypath;
  PathComponent: typeof PathComponent;
  DataType: {
    transaction: number;
    typedTransaction: number;
    personalMessage: number;
    typedData: number;
  };
  EthSignRequest: new (args: {
    requestId: Buffer;
    signData: Buffer;
    dataType: number;
    chainId?: number;
    derivationPath: InstanceType<typeof CryptoKeypath>;
    origin?: string;
  }) => { toCBOR: () => Uint8Array };
};
const {
  SignType,
  SolSignRequest,
  CryptoKeypath: SolKeypath,
  PathComponent: SolPathComponent,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS package ships no usable types
} = require("@keystonehq/bc-ur-registry-sol") as {
  CryptoKeypath: typeof CryptoKeypath;
  PathComponent: typeof PathComponent;
  SignType: { Transaction: number; Message: number };
  SolSignRequest: new (args: {
    requestId: Buffer;
    signData: Buffer;
    derivationPath: InstanceType<typeof CryptoKeypath>;
    origin?: string;
    signType: number;
  }) => { toCBOR: () => Uint8Array };
};
const {
  DataType: TronDataType,
  TronSignRequest,
  CryptoKeypath: TronKeypath,
  PathComponent: TronPathComponent,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS package ships no usable types
} = require("@keystonehq/bc-ur-registry-tron") as {
  CryptoKeypath: typeof CryptoKeypath;
  PathComponent: typeof PathComponent;
  DataType: { transaction: number; personalMessage: number };
  TronSignRequest: new (args: {
    requestId: Buffer;
    signData: Buffer;
    dataType: number;
    derivationPath: CryptoKeypath;
    origin?: string;
  }) => { toCBOR: () => Uint8Array };
};
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = mnemonicToSeedSync(MNEMONIC);
const ROOT = HDKey.fromMasterSeed(SEED);
const DEVICE = "Keystone 3 Pro";
const VERSION = "3.2.2";
// get_device_id(serial) = hex(sha256(sha256(serial))[0..20]) — a fixed serial keeps the vector stable.
const SERIAL = "qntx-test-serial";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const sha256hex = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const mfpBytes = (): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(ROOT.fingerprint);
  return out;
};
const fpBytes = (fingerprint: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(fingerprint);
  return out;
};

const components = (path: string): PathComponent[] =>
  path
    .replace(/^m\//, "")
    .split("/")
    .map(
      (segment) =>
        new PathComponent({
          index: Math.trunc(Number(segment.replace(/'$/, ""))),
          hardened: segment.endsWith("'"),
        }),
    );

/**
 * Firmware generate_k1_normal_key: full node with chain code, the account xpub's own depth and
 * parent fingerprint, and a `children` keypath — `[0, wildcard]` for the standard ETH account,
 * `[wildcard]` for every other k1 key.
 */
const k1Key = (path: string, note?: string, standard = false): CryptoHDKey => {
  const node = ROOT.derive(`m/${path}`);
  if (node.publicKey === null || node.chainCode === null) {
    throw new Error(`no node at ${path}`);
  }
  return new CryptoHDKey({
    isMaster: false,
    isPrivateKey: false,
    key: Buffer.from(node.publicKey),
    chainCode: Buffer.from(node.chainCode),
    origin: new CryptoKeypath(components(path), mfpBytes(), node.depth),
    children: new CryptoKeypath(
      standard
        ? [new PathComponent({ index: 0, hardened: false }), new PathComponent({ hardened: false })]
        : [new PathComponent({ hardened: false })],
      undefined,
      0,
    ),
    parentFingerprint: fpBytes(node.parentFingerprint),
    name: "Keystone",
    ...(note === undefined ? {} : { note }),
  });
};

/**
 * Firmware generate_eth_ledger_legacy_pubkey / generate_eth_ledger_live_key: the derived leaf's
 * public key with no chain code — the sync parser must skip these.
 */
const ethLeafKey = (path: string, note: string): CryptoHDKey => {
  const account = ROOT.derive("m/44'/60'/0'");
  const node = account.derive(`m/${path.split("/").slice(3).join("/")}`);
  if (node.publicKey === null) {
    throw new Error(`no leaf at ${path}`);
  }
  return new CryptoHDKey({
    isMaster: false,
    isPrivateKey: false,
    key: Buffer.from(node.publicKey),
    origin: new CryptoKeypath(components(path), mfpBytes(), account.depth),
    parentFingerprint: fpBytes(node.parentFingerprint),
    name: "Keystone",
    note,
  });
};

/** Firmware generate_ed25519_key: the bare 32-byte SLIP-10 public key, no chain code. */
const ed25519Key = (path: string): CryptoHDKey => {
  const publicKey = ed25519.getPublicKey(
    Slip10.fromMasterSeed(SEED).derive(`m/${path}`).privateKey,
  );
  return new CryptoHDKey({
    isMaster: false,
    isPrivateKey: false,
    key: Buffer.from(publicKey),
    origin: new CryptoKeypath(components(path), mfpBytes(), undefined),
    name: "Keystone",
  });
};

/** Firmware generate_ada_key: a 64-byte `chainCode ‖ publicKey` source, split into two fields. */
const adaKey = (path: string): CryptoHDKey => {
  // The cardano key is ed25519-bip32 material we do not derive here — the parser ignores it, so a
  // deterministic stand-in of the right shape keeps the vector stable.
  const publicKey = ed25519.getPublicKey(
    Slip10.fromMasterSeed(SEED).derive(`m/${path}`).privateKey,
  );
  const chainCode = sha256(new Uint8Array([...Buffer.from("ada-chain-code"), ...SEED]));
  return new CryptoHDKey({
    isMaster: false,
    isPrivateKey: false,
    key: Buffer.from(publicKey),
    chainCode: Buffer.from(chainCode),
    origin: new CryptoKeypath(components(path), mfpBytes(), 3),
    name: "Keystone",
  });
};

const zecNote = (): string =>
  JSON.stringify({
    seed_fingerprint: hex(sha256(new Uint8Array([...Buffer.from("zcash-sfp"), ...SEED]))),
  });

const deviceId = (): string => hex(sha256hex(sha256hex(Buffer.from(SERIAL))).subarray(0, 20));

const syncKeys = (): CryptoHDKey[] => [
  k1Key("44'/0'/0'"),
  k1Key("49'/0'/0'"),
  k1Key("84'/0'/0'"),
  k1Key("86'/0'/0'"),
  k1Key("44'/195'/0'"),
  k1Key("44'/3'/0'"), // DOGE
  k1Key("44'/144'/0'"), // XRP
  k1Key("49'/2'/0'"), // LTC
  k1Key("84'/2'/0'"), // LTC native segwit
  k1Key("44'/145'/0'"), // BCH
  k1Key("44'/133'/0'", zecNote()), // ZEC
  adaKey("1852'/1815'/0'"),
  k1Key("44'/60'/0'", "account.standard", true),
  ethLeafKey("44'/60'/0'/0", "account.ledger_legacy"),
  ethLeafKey("44'/60'/0'/0/0", "account.ledger_live"),
  ed25519Key("44'/501'/0'"),
  ed25519Key("44'/501'/0'/0'"),
];

const multi = new CryptoMultiAccounts(mfpBytes(), syncKeys(), DEVICE, deviceId(), VERSION);

const pinnedNode = (path: string) => {
  const node = ROOT.derive(`m/${path}`);
  if (node.publicKey === null || node.chainCode === null) {
    throw new Error(`no node at ${path}`);
  }
  return {
    path: `m/${path}`,
    publicKey: hex(node.publicKey),
    chainCode: hex(node.chainCode),
    parentFingerprint: fpBytes(node.parentFingerprint).toString("hex"),
  };
};

const pinnedEd25519 = (path: string) => ({
  path: `m/${path}`,
  publicKey: hex(ed25519.getPublicKey(Slip10.fromMasterSeed(SEED).derive(`m/${path}`).privateKey)),
});

// Captured device syncs quoted in ur-registry's crypto_multi_accounts.rs tests; `cbor` is the
// UR payload decoded (bytewords) once — the kernel never sees the UR text.
const firmwareVectors = [
  {
    name: "device-sync-eth-account",
    source: "ur-registry-1.0.9 crypto_multi_accounts.rs test_decode_multi_accounts",
    ur: "UR:CRYPTO-MULTI-ACCOUNTS/OXADCYWMCMJKCTAOLFTAADDLOTAXHDCLAXRSJEQZPETEIMAXTOBSTIJNJKVSIMPRCWFHYTSTWDLYTDNBTDHHYNDMCYJPOEUECSAAHDCXEOTEWFLFMYPLAXWPDTHPFHWNATYAFHMUDPLUAHGSNLVONLBESRGLCHFYJOPDFMHGAMTAADDYOYADLNCSDWYKCSFNYKAEYKTAADDLOEAXHDCXTIDIFEHYSFWTETHESRMYCLKEHPZORHHEJSCYCMZOVDLFPEKGEOPTKICTCHWMSNKKAMTAADDYOYADLNCSDWYKCFADYKYKAEYKAXJTGRIHKKJKJYJLJTIHCXEOCXGDJPJLAHIHEHDMEHDMDYDLEYYLLD",
    cbor: "a4011aeb16731f0282d9012fa303582103bf6bb4afd36a03ce0fd06d73e86ab21b3ff9c7ea81d2a0d25cf62e1a72a2de1804582033d3f3828fae03ec295b3ff107f83f932d8b054c99e29910c34e174470a83e5706d90130a10186182cf5183cf500f5d9012fa2035820d027455eccf0385fc38f217c5bfbb95f711a16fbe782af7b33a97d1f17ebcd7906d90130a10186182cf51901f5f500f5036e4b657973746f6e6520332050726f0565312e312e30",
    // What the Rust test asserts for key 0.
    firstKey: {
      path: "m/44'/60'/0'",
      publicKey: "03bf6bb4afd36a03ce0fd06d73e86ab21b3ff9c7ea81d2a0d25cf62e1a72a2de18",
      chainCode: "33d3f3828fae03ec295b3ff107f83f932d8b054c99e29910c34e174470a83e57",
    },
  },
  {
    name: "device-sync-eight-keys",
    source: "ur-registry-1.0.9 crypto_multi_accounts.rs test_decode_multi",
    ur: "UR:CRYPTO-MULTI-ACCOUNTS/OTADCYCNTIFDWTAOLNTAADDLOXAOWKAXHDCXSPTPFWOEWNLBTSPKRPAYTODMONECOLWLHDURZSCXSGYNINQDFLRHBYSSCHCFIHGUAMTAADDYOTADLOCSDWYKCFADYKYKAEYKAEYKAOCYCNTIFDWTAXAHASISGRIHKKJKJYJLJTIHTAADDLOXAOWKAXHDCXBSMDKOCXPRDERDVORHGSLFUTTYRTMUMKFTIOENGOGORLEMWPKIUOBYCHVACEJPVTAMTAADDYOTADLOCSDWYKCFADYKYKADYKAEYKAOCYCNTIFDWTAXAHASISGRIHKKJKJYJLJTIHTAADDLOXAOWKAXHDCXWZDKVSECEOURRKKEVWWYRDFGAELYNNPYMDPRAATKAYJKTYRFHSTSBANYZMGLGHPMAMTAADDYOTADLOCSDWYKCFADYKYKAOYKAEYKAOCYCNTIFDWTAXAHASISGRIHKKJKJYJLJTIHTAADDLOXAOWKAXHDCXGLAAUECPATIEADBGPKJNUEYKNNTLADOXTIMURTGWCPAYGSZSYABTVLISECSOJYTKAMTAADDYOTADLOCSDWYKCFADYKYKAXYKAEYKAOCYCNTIFDWTAXAHASISGRIHKKJKJYJLJTIHTAADDLOXAOWKAXHDCXMUJLWLCKPYPMKBNEDPIOGRDINYRYIYWLECBAONHDPMSPBGFYTDEHASKEMTLDFZINAMTAADDYOTADLOCSDWYKCFADYKYKAAYKAEYKAOCYCNTIFDWTAXAHASISGRIHKKJKJYJLJTIHTAADDLOXAOWKAXHDCXKEOLGWPEFSRSKEEMGAONWLMWVWKOISTPPEJZFRVEPKFWVDGAAMAHBTTIJSFSGSLDAMTAADDYOTADLOCSDWYKCFADYKYKAHYKAEYKAOCYCNTIFDWTAXAHASISGRIHKKJKJYJLJTIHAXISGRIHKKJKJYJLJTIHLDMEDATK",
    cbor: "a3011a23d048f00286d9012fa402f4035820c8d842a2f17fd7aab608ce2ea535a6e958dffa20caf669b347b911c41719655306d90130a30188182cf51901f5f500f500f5021a23d048f0030509684b657973746f6e65d9012fa402f40358200f957620b228bae2b94c82ddd4c093983a67365555b737ec7ddc1117e61c72e006d90130a30188182cf51901f5f501f500f5021a23d048f0030509684b657973746f6e65d9012fa402f4035820f224e83533dfbb7ce5eeba4600819eab95b204cf0873d4bc61d70e9aff4e54ad06d90130a30188182cf51901f5f502f500f5021a23d048f0030509684b657973746f6e65d9012fa402f40358204e04de2207640112aa6ddef59ed501a4d093c04f22084cfaf80de36835c974cf06d90130a30188182cf51901f5f503f500f5021a23d048f0030509684b657973746f6e65d9012fa402f4035820936fe91eabad7e9f2d674b279abd66e9350ea558adc81244d231097c9689406906d90130a30188182cf51901f5f504f500f5021a23d048f0030509684b657973746f6e65d9012fa402f40358207ca64faf3dbf7c3749a5e994e57668d8af6c3be4aa42e74906050dd0713d4c8906d90130a30188182cf51901f5f505f500f5021a23d048f0030509684b657973746f6e6503684b657973746f6e65",
    firstKey: {
      path: "m/44'/501'/0'/0'",
      depth: 5,
    },
  },
];

const vectors = {
  mnemonic: MNEMONIC,
  sync: {
    type: "crypto-multi-accounts",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- toCBOR() is untyped in the package
    cbor: hex(multi.toCBOR() as Uint8Array),
    masterFingerprint: mfpBytes().toString("hex"),
    device: DEVICE,
    deviceVersion: VERSION,
    deviceId: deviceId(),
    pinned: {
      nodes: ["44'/0'/0'", "49'/0'/0'", "84'/0'/0'", "86'/0'/0'", "44'/60'/0'", "44'/195'/0'"].map(
        pinnedNode,
      ),
      ed25519: ["44'/501'/0'", "44'/501'/0'/0'"].map(pinnedEd25519),
    },
  },
  firmware: firmwareVectors,
  // Literal bytes of the crate's encode test — a synthetic hdkey that names an ed25519 path with a
  // 33-byte secp256k1 key: the registry layer decodes it, the sync parser must reject it.
  registryEncode: {
    source: "ur-registry-1.0.9 crypto_multi_accounts.rs test_encode",
    cbor: "a5011ae9181cf30281d9012fa203582102eae4b876a8696134b868f88cc2f51f715f2dbedb7446b8e6edf3d4541c4eb67b06d90130a10188182cf51901f5f500f500f503686b657973746f6e65047828323834373563386438306636633036626166626534366137643137353066336663663235363566370565312e302e30",
    masterFingerprint: "e9181cf3",
    device: "keystone",
    deviceVersion: "1.0.0",
    deviceId: "28475c8d80f6c06bafbe46a7d1750f3fcf2565f7",
  },
};

writeFileSync("vectors/keystone/sync.json", `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote vectors/keystone/sync.json (sync cbor ${vectors.sync.cbor.length / 2} bytes)`);

// ── Sign-request vectors (vectors/keystone/sign.json) ────────────────────────

/** Build a keypath with the _package's own_ classes — each family package vendors its registry. */
const keypath = (
  Keypath: typeof CryptoKeypath,
  Component: typeof PathComponent,
  path: string,
): InstanceType<typeof CryptoKeypath> =>
  new Keypath(
    path.split("/").map(
      (segment) =>
        new Component({
          index: Math.trunc(Number(segment.replace(/'$/, ""))),
          hardened: segment.endsWith("'"),
        }),
    ),
    mfpBytes(),
  );

const REQUEST_ID = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const SIGN_DATA = Buffer.from(
  "02ef86010a840165536084016553608094deadbeefdeadbeefdeadbeefdeadbeefdeadbeef0180c0",
  "hex",
);
const ORIGIN = "qntx";

/** The independent encoders' byte output for one fixed request — the kernel must match it. */
const cborOf = (item: { toCBOR: () => Uint8Array }): string => hex(item.toCBOR());

const signVectors = {
  requestId: REQUEST_ID.toString("hex"),
  signData: SIGN_DATA.toString("hex"),
  fingerprint: mfpBytes().toString("hex"),
  origin: ORIGIN,
  cases: [
    {
      name: "eth-legacy-transaction",
      urType: "eth-sign-request",
      dataType: 1,
      chainId: 1,
      path: "m/44'/60'/0'/0/0",
      cbor: cborOf(
        new EthSignRequest({
          requestId: REQUEST_ID,
          signData: SIGN_DATA,
          dataType: EthDataType.transaction,
          chainId: 1,
          derivationPath: keypath(EthKeypath, EthPathComponent, "44'/60'/0'/0/0"),
          origin: ORIGIN,
        }),
      ),
    },
    {
      name: "eth-typed-transaction",
      urType: "eth-sign-request",
      dataType: 4,
      chainId: 1,
      path: "m/44'/60'/0'/0/0",
      cbor: cborOf(
        new EthSignRequest({
          requestId: REQUEST_ID,
          signData: SIGN_DATA,
          dataType: EthDataType.typedTransaction,
          chainId: 1,
          derivationPath: keypath(EthKeypath, EthPathComponent, "44'/60'/0'/0/0"),
          origin: ORIGIN,
        }),
      ),
    },
    {
      name: "eth-personal-message",
      urType: "eth-sign-request",
      dataType: 3,
      path: "m/44'/60'/0'/0/0",
      cbor: cborOf(
        new EthSignRequest({
          requestId: REQUEST_ID,
          signData: Buffer.from("hello qntx"),
          dataType: EthDataType.personalMessage,
          derivationPath: keypath(EthKeypath, EthPathComponent, "44'/60'/0'/0/0"),
          origin: ORIGIN,
        }),
      ),
    },
    {
      name: "eth-typed-data",
      urType: "eth-sign-request",
      dataType: 2,
      path: "m/44'/60'/0'/0/0",
      cbor: cborOf(
        new EthSignRequest({
          requestId: REQUEST_ID,
          signData: Buffer.from('{"types":{"EIP712Domain":[]}}'),
          dataType: EthDataType.typedData,
          derivationPath: keypath(EthKeypath, EthPathComponent, "44'/60'/0'/0/0"),
          origin: ORIGIN,
        }),
      ),
    },
    {
      name: "tron-transaction",
      urType: "tron-sign-request",
      dataType: 1,
      path: "m/44'/195'/0'/0/0",
      cbor: cborOf(
        new TronSignRequest({
          requestId: REQUEST_ID,
          signData: SIGN_DATA,
          dataType: TronDataType.transaction,
          derivationPath: keypath(TronKeypath, TronPathComponent, "44'/195'/0'/0/0"),
          origin: ORIGIN,
        }),
      ),
    },
    {
      name: "tron-message",
      urType: "tron-sign-request",
      dataType: 2,
      path: "m/44'/195'/0'/0/0",
      cbor: cborOf(
        new TronSignRequest({
          requestId: REQUEST_ID,
          signData: Buffer.from("hello tron"),
          dataType: TronDataType.personalMessage,
          derivationPath: keypath(TronKeypath, TronPathComponent, "44'/195'/0'/0/0"),
          origin: ORIGIN,
        }),
      ),
    },
    {
      name: "solana-transaction",
      urType: "sol-sign-request",
      signType: 1,
      path: "m/44'/501'/0'/0'",
      cbor: cborOf(
        new SolSignRequest({
          requestId: REQUEST_ID,
          signData: SIGN_DATA,
          derivationPath: keypath(SolKeypath, SolPathComponent, "44'/501'/0'/0'"),
          origin: ORIGIN,
          signType: SignType.Transaction,
        }),
      ),
    },
    {
      name: "solana-message",
      urType: "sol-sign-request",
      signType: 2,
      path: "m/44'/501'/0'/0'",
      cbor: cborOf(
        new SolSignRequest({
          requestId: REQUEST_ID,
          signData: Buffer.from("hello solana"),
          derivationPath: keypath(SolKeypath, SolPathComponent, "44'/501'/0'/0'"),
          origin: ORIGIN,
          signType: SignType.Message,
        }),
      ),
    },
    {
      name: "bitcoin-message",
      urType: "btc-sign-request",
      dataType: 1,
      path: "m/44'/0'/0'/0/0",
      cbor: cborOf(
        new BtcSignRequest({
          requestId: REQUEST_ID,
          signData: Buffer.from("hello bitcoin"),
          dataType: BtcDataType.message,
          derivationPaths: [keypath(BtcKeypath, BtcPathComponent, "44'/0'/0'/0/0")],
          origin: ORIGIN,
        }),
      ),
    },
    {
      name: "crypto-psbt",
      urType: "crypto-psbt",
      cbor: cborOf(new BtcCryptoPSBT(SIGN_DATA)),
    },
    {
      name: "key-derivation-call",
      urType: "qr-hardware-call",
      cbor: cborOf(
        new QRHardwareCall(
          QRHardwareCallType.KeyDerivation,
          new KeyDerivation([
            new KeyDerivationSchema(
              keypath(CryptoKeypath, PathComponent, "84'/0'/1'"),
              Curve.secp256k1,
              DerivationAlgorithm.slip10,
            ),
            new KeyDerivationSchema(
              keypath(CryptoKeypath, PathComponent, "44'/501'/1'/0'"),
              Curve.ed25519,
              DerivationAlgorithm.slip10,
            ),
          ]),
          ORIGIN,
        ),
      ),
      paths: ["m/84'/0'/1'", "m/44'/501'/1'/0'"],
    },
  ],
};

writeFileSync("vectors/keystone/sign.json", `${JSON.stringify(signVectors, null, 2)}\n`);
console.log("wrote vectors/keystone/sign.json");
