/// <reference types="node" />
/**
 * Regenerates vectors/qr/{requests,exports,hostile}.json without importing kernel, wallet or engine
 * code.
 *
 * Requests come from the vendor encoders a watch-only wallet ships:
 * `@keystonehq/bc-ur-registry-eth` `EthSignRequest` (the class MetaMask/Rabby's `base-eth-keyring`
 * constructs — legacy signData is `RLP.encode(tx.getMessageToSign())` and typed signData is
 * `tx.getMessageToSign()`, built with the keyring's own @ethereumjs/tx copy),
 * `@keystonehq/bc-ur-registry-sol` `SolSignRequest`, `@keystonehq/bc-ur-registry-tron`
 * `TronSignRequest` and `@keystonehq/bc-ur-registry` `CryptoPSBT` over a real `@scure/btc-signer`
 * P2WPKH PSBT. Expected digests are computed independently with `viem` (`keccak256`, `hashMessage`,
 * `hashTypedData`, `hashDomain`, `hashStruct`) and `@noble/hashes` + `@scure/base` — never through
 * the engine's own decode path.
 *
 * `exports.json` carries the `chain.exportAccount`-shaped public material for group 0, derived
 * independently with `hdkey` (BIP-32) and micro-key-producer (SLIP-10), plus the fields the vendor
 * readers must observe.
 *
 * `hostile.json` mutates the canonical payloads at the byte level through a small definite-length
 * CBOR walker (truncations, duplicate/foreign map keys, non-canonical ints and floats, tag swaps)
 * plus scanner cases expressed as payloads and limits — the test turns them into frames.
 *
 * Run from the repo root: bun scripts/vectors/qr.ts
 */
// oxlint-disable eslint/no-bitwise -- a definite-length CBOR walker decodes header bytes
import { realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

import { CryptoPSBT } from "@keystonehq/bc-ur-registry";
import { DataType, EthSignRequest } from "@keystonehq/bc-ur-registry-eth";
import { SignType, SolSignRequest } from "@keystonehq/bc-ur-registry-sol";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58, createBase58check } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import HDKeyNpm from "hdkey";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { hashDomain, hashMessage, hashStruct, hashTypedData, keccak256, toHex } from "viem";

const require = createRequire(import.meta.url);
const keyringRequire = createRequire(
  realpathSync(require.resolve("@keystonehq/base-eth-keyring/package.json")),
);
type TxObject = { getMessageToSign: () => Buffer };
const { LegacyTransaction, FeeMarketEIP1559Transaction, AccessListEIP2930Transaction } =
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vendor CJS has no usable types
  keyringRequire("@ethereumjs/tx") as {
    // Legacy's signing payload is the RLP field list; typed transactions sign their envelope.
    LegacyTransaction: new (data: Record<string, unknown>) => {
      getMessageToSign: () => Buffer | Buffer[];
    };
    FeeMarketEIP1559Transaction: new (data: Record<string, unknown>) => TxObject;
    AccessListEIP2930Transaction: new (data: Record<string, unknown>) => TxObject;
  };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vendor CJS has no usable types
const { RLP } = keyringRequire("@ethereumjs/rlp") as {
  RLP: { encode: (items: unknown) => Uint8Array };
};
// @scure/btc-signer lives in wallet-chains' dependency closure, not the root devDeps.
const chainsRequire = createRequire(realpathSync("packages/wallet-chains/package.json"));
const tronRequire = createRequire(
  realpathSync(require.resolve("@keystonehq/bc-ur-registry-tron/package.json")),
);
const { DataType: TronDataType, TronSignRequest } =
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vendor CJS has no usable types
  tronRequire("@keystonehq/bc-ur-registry-tron") as {
    DataType: { transaction: number; personalMessage: number };
    TronSignRequest: {
      constructTronRequest: (
        signData: Buffer,
        dataType: number,
        path: string,
        xfp: string,
        uuid?: string,
        address?: Buffer,
        origin?: string,
      ) => { toUR: () => { type: string; cbor: Uint8Array } };
    };
  };
const { Address, OutScript, Transaction, p2wpkh } =
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vendor CJS has no usable types
  chainsRequire("@scure/btc-signer") as {
    Address: (net?: unknown) => { decode: (s: string) => Uint8Array };
    OutScript: { encode: (script: Uint8Array) => Uint8Array };
    Transaction: new (opts: { version: number }) => {
      addInput: (i: Record<string, unknown>) => void;
      addOutput: (o: { script: Uint8Array; amount: bigint }) => void;
      toPSBT: (v: number) => Uint8Array;
    };
    p2wpkh: (pub: Uint8Array) => { script: Uint8Array };
  };

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const seed = mnemonicToSeedSync(MNEMONIC);
const master = HDKeyNpm.fromMasterSeed(Buffer.from(seed));
const masterFingerprint = "73c5da0a";
const xfp = masterFingerprint;

const evmNode = master.derive("m/44'/60'/0'");
const evmLeaf = evmNode.derive("m/0/0");
const tronLeaf = master.derive("m/44'/195'/0'/0/0");
const solLeaf = Slip10.fromMasterSeed(seed).derive("m/44'/501'/0'/0'");
const bip84Account = master.derive("m/84'/0'/0'");
const bip86Account = master.derive("m/86'/0'/0'");
const bip84Leaf = bip84Account.derive("m/0/0");

const evmAddress = `0x${bytesToHex(
  keccak_256(
    secp256k1.Point.fromBytes(new Uint8Array(evmLeaf.publicKey)).toBytes(false).subarray(1),
  ).subarray(12),
)}`;
const solanaPublic = ed25519.getPublicKey(new Uint8Array(solLeaf.privateKey));
const solanaAddress = base58.encode(solanaPublic);
const tronAddress = createBase58check(sha256).encode(
  new Uint8Array([
    0x41,
    ...keccak_256(
      secp256k1.Point.fromBytes(new Uint8Array(tronLeaf.publicKey)).toBytes(false).subarray(1),
    ).subarray(12),
  ]),
);

const uuid = "12345678-1234-4321-abcd-1234567890ab";
const uuidBytes = hexToBytes(uuid.replaceAll("-", ""));

const EVM_PATH = "m/44'/60'/0'/0/0";
const TRON_PATH = "m/44'/195'/0'/0/0";
const SOL_PATH = "m/44'/501'/0'/0'";

const fp8 = (value: number): string => value.toString(16).padStart(8, "0");

const urJson = (ur: { type: string; cbor: Uint8Array }): { type: string; cbor: string } => ({
  type: ur.type,
  cbor: bytesToHex(new Uint8Array(ur.cbor)),
});

/** Kernel KeyPath numbers (hardened step = index | 2^31) for a literal `m/…` path. */
const steps = (path: string): number[] =>
  path
    .slice(2)
    .split("/")
    .map((step) => (step.endsWith("'") ? Number(step.slice(0, -1)) + 0x80000000 : Number(step)));

type Digest = { readonly kind: string; readonly value: string };
type RequestCase = {
  readonly name: string;
  readonly type: string;
  readonly cbor: string;
  readonly expect: Record<string, unknown>;
  readonly digests: ReadonlyArray<Digest>;
};

const ethRequest = (
  signData: Uint8Array,
  dataType: number,
  chainId?: number,
  address?: string,
): { type: string; cbor: Uint8Array } =>
  EthSignRequest.constructETHRequest(
    Buffer.from(signData),
    dataType,
    EVM_PATH,
    xfp,
    uuid,
    chainId,
    address,
  ).toUR();

const TO = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const legacyTx = new LegacyTransaction({
  nonce: 0,
  gasPrice: 20_000_000_000n,
  gasLimit: 21_000n,
  to: TO,
  value: 10n ** 15n,
  chainId: 1,
});
const LEGACY_SD = Buffer.from(RLP.encode(legacyTx.getMessageToSign()));

const tx1559 = new FeeMarketEIP1559Transaction({
  chainId: 1,
  nonce: 1,
  maxPriorityFeePerGas: 1_500_000_000n,
  maxFeePerGas: 30_000_000_000n,
  gasLimit: 25_000n,
  to: TO,
  value: 10n ** 14n,
  data: "0xa9059cbb",
});
const SD_1559 = Buffer.from(tx1559.getMessageToSign());

const tx2930 = new AccessListEIP2930Transaction({
  chainId: 1,
  nonce: 2,
  gasPrice: 15_000_000_000n,
  gasLimit: 50_000n,
  to: TO,
  value: 0n,
  accessList: [
    {
      address: TO,
      storageKeys: ["0x0000000000000000000000000000000000000000000000000000000000000001"],
    },
  ],
});
const SD_2930 = Buffer.from(tx2930.getMessageToSign());

const TYPED_DATA = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
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
} as const;
const TYPED_DATA_TEXT = JSON.stringify(TYPED_DATA);

const viemTypedData = (data: typeof TYPED_DATA): never => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- identical runtime shape; viem's TypedData types are nominal
  return data as never;
};

const viemStruct = (data: typeof TYPED_DATA): never => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- identical runtime shape; viem's TypedData types are nominal
  return {
    data: data.message,
    primaryType: data.primaryType,
    types: data.types,
  } as never;
};

const viemDomain = (data: typeof TYPED_DATA): never => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- identical runtime shape; viem's TypedData types are nominal
  return { domain: data.domain, types: data.types } as never;
};

const PERSONAL = new TextEncoder().encode("hello qr");
const SOL_TX_BYTES = sha256(new TextEncoder().encode("solana tx message"));
const SOL_MSG_BYTES = new TextEncoder().encode("hello solana");
const TRON_RAW = sha256(new TextEncoder().encode("tron raw_data"));
const TRON_MSG = new TextEncoder().encode("hello tron");

const psbtBytes = (() => {
  const target = p2wpkh(new Uint8Array(bip84Leaf.publicKey));
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: new Uint8Array(32).fill(3),
    index: 0,
    witnessUtxo: { script: target.script, amount: 100_000n },
    bip32Derivation: [
      [
        new Uint8Array(bip84Leaf.publicKey),
        {
          fingerprint: Number.parseInt(masterFingerprint, 16),
          path: [0x80000054, 0x80000000, 0x80000000, 0, 0],
        },
      ],
    ],
  });
  const payee = Address().decode("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");
  tx.addOutput({ script: OutScript.encode(payee), amount: 90_000n });
  return tx.toPSBT(0);
})();

const tronDigest = (message: Uint8Array): string => {
  const head = new TextEncoder().encode(`\u0019TRON Signed Message:\n${message.length}`);
  const pre = new Uint8Array(head.length + message.length);
  pre.set(head);
  pre.set(message, head.length);
  return `0x${bytesToHex(keccak_256(pre))}`;
};

const hexJson = (bytes: Uint8Array): string => bytesToHex(bytes);

const requests: RequestCase[] = [
  {
    name: "evm-legacy-transfer",
    ...urJson(ethRequest(LEGACY_SD, DataType.transaction, 1)),
    expect: {
      family: "evm",
      kind: "transaction",
      path: EVM_PATH,
      steps: steps(EVM_PATH),
      xfp,
      requestId: hexJson(uuidBytes),
      chainId: 1,
      data: hexJson(LEGACY_SD),
      tx: {
        type: "legacy",
        chainId: 1,
        nonce: 0,
        gasPrice: "0x4a817c800",
        gas: "0x5208",
        to: TO.toLowerCase(),
        value: "0x38d7ea4c68000",
        data: "0x",
      },
    },
    digests: [{ kind: "evm-transaction-hash", value: keccak256(toHex(LEGACY_SD)) }],
  },
  {
    name: "evm-1559-transfer",
    ...urJson(ethRequest(SD_1559, DataType.typedTransaction, 1)),
    expect: {
      family: "evm",
      kind: "transaction",
      path: EVM_PATH,
      steps: steps(EVM_PATH),
      xfp,
      requestId: hexJson(uuidBytes),
      chainId: 1,
      data: hexJson(SD_1559),
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 1,
        maxPriorityFeePerGas: "0x59682f00",
        maxFeePerGas: "0x6fc23ac00",
        gas: "0x61a8",
        to: TO.toLowerCase(),
        value: "0x5af3107a4000",
        data: "0xa9059cbb",
        accessList: [],
      },
    },
    digests: [{ kind: "evm-transaction-hash", value: keccak256(toHex(SD_1559)) }],
  },
  {
    name: "evm-2930-transfer",
    ...urJson(ethRequest(SD_2930, DataType.typedTransaction, 1)),
    expect: {
      family: "evm",
      kind: "transaction",
      path: EVM_PATH,
      steps: steps(EVM_PATH),
      xfp,
      requestId: hexJson(uuidBytes),
      chainId: 1,
      data: hexJson(SD_2930),
      tx: {
        type: "eip2930",
        chainId: 1,
        nonce: 2,
        gasPrice: "0x37e11d600",
        gas: "0xc350",
        to: TO.toLowerCase(),
        value: "0x0",
        data: "0x",
        accessList: [
          {
            address: TO.toLowerCase(),
            storageKeys: ["0x0000000000000000000000000000000000000000000000000000000000000001"],
          },
        ],
      },
    },
    digests: [{ kind: "evm-transaction-hash", value: keccak256(toHex(SD_2930)) }],
  },
  {
    name: "evm-personal-message",
    ...urJson(
      EthSignRequest.constructETHRequest(
        Buffer.from(PERSONAL),
        DataType.personalMessage,
        EVM_PATH,
        xfp,
        uuid,
        undefined,
        evmAddress,
      ).toUR(),
    ),
    expect: {
      family: "evm",
      kind: "personal-message",
      path: EVM_PATH,
      steps: steps(EVM_PATH),
      xfp,
      requestId: hexJson(uuidBytes),
      address: evmAddress,
      message: hexJson(PERSONAL),
    },
    digests: [{ kind: "eip191-digest", value: hashMessage({ raw: toHex(PERSONAL) }) }],
  },
  {
    name: "evm-typed-data",
    ...urJson(
      EthSignRequest.constructETHRequest(
        Buffer.from(TYPED_DATA_TEXT),
        DataType.typedData,
        EVM_PATH,
        xfp,
        uuid,
        undefined,
        evmAddress,
      ).toUR(),
    ),
    expect: {
      family: "evm",
      kind: "typed-data",
      path: EVM_PATH,
      steps: steps(EVM_PATH),
      xfp,
      requestId: hexJson(uuidBytes),
      address: evmAddress,
      typedData: TYPED_DATA_TEXT,
    },
    digests: [
      {
        kind: "eip712-domain-hash",
        value: hashDomain(viemDomain(TYPED_DATA)),
      },
      {
        kind: "eip712-message-hash",
        value: hashStruct(viemStruct(TYPED_DATA)),
      },
      { kind: "eip712-digest", value: hashTypedData(viemTypedData(TYPED_DATA)) },
    ],
  },
  {
    name: "sol-transaction",
    ...urJson(
      SolSignRequest.constructSOLRequest(
        Buffer.from(SOL_TX_BYTES),
        SOL_PATH,
        xfp,
        SignType.Transaction,
        uuid,
        `0x${bytesToHex(base58.decode(solanaAddress))}`,
      ).toUR(),
    ),
    expect: {
      family: "solana",
      kind: "transaction",
      path: SOL_PATH,
      steps: steps(SOL_PATH),
      xfp,
      requestId: hexJson(uuidBytes),
      address: solanaAddress,
      data: hexJson(SOL_TX_BYTES),
    },
    digests: [{ kind: "solana-message-hash", value: base58.encode(sha256(SOL_TX_BYTES)) }],
  },
  {
    name: "sol-message",
    ...urJson(
      SolSignRequest.constructSOLRequest(
        Buffer.from(SOL_MSG_BYTES),
        SOL_PATH,
        xfp,
        SignType.Message,
      ).toUR(),
    ),
    expect: {
      family: "solana",
      kind: "message",
      path: SOL_PATH,
      steps: steps(SOL_PATH),
      xfp,
      data: hexJson(SOL_MSG_BYTES),
    },
    digests: [{ kind: "solana-message-hash", value: base58.encode(sha256(SOL_MSG_BYTES)) }],
  },
  {
    name: "tron-transaction",
    ...urJson(
      TronSignRequest.constructTronRequest(
        Buffer.from(TRON_RAW),
        TronDataType.transaction,
        TRON_PATH,
        xfp,
        uuid,
        Buffer.from(createBase58check(sha256).decode(tronAddress)),
      ).toUR(),
    ),
    expect: {
      family: "tron",
      kind: "transaction",
      path: TRON_PATH,
      steps: steps(TRON_PATH),
      xfp,
      requestId: hexJson(uuidBytes),
      address: tronAddress,
      data: hexJson(TRON_RAW),
    },
    digests: [{ kind: "tron-txid", value: `0x${bytesToHex(sha256(TRON_RAW))}` }],
  },
  {
    name: "tron-message",
    ...urJson(
      TronSignRequest.constructTronRequest(
        Buffer.from(TRON_MSG),
        TronDataType.personalMessage,
        TRON_PATH,
        xfp,
      ).toUR(),
    ),
    expect: {
      family: "tron",
      kind: "message",
      path: TRON_PATH,
      steps: steps(TRON_PATH),
      xfp,
      data: hexJson(TRON_MSG),
    },
    digests: [{ kind: "tron-message-digest", value: tronDigest(TRON_MSG) }],
  },
  {
    name: "bitcoin-psbt",
    ...urJson(new CryptoPSBT(Buffer.from(psbtBytes)).toUR()),
    expect: { family: "bitcoin", kind: "psbt", urType: "crypto-psbt", psbt: hexJson(psbtBytes) },
    digests: [],
  },
];

const keyRow = (
  node: Record<string, unknown>,
  key: { publicKey: Uint8Array },
  path: string,
): Record<string, unknown> => ({
  node,
  path,
  curve: node["template"] === "solana.bip44-change" ? "ed25519" : "secp256k1",
  publicKey: bytesToHex(new Uint8Array(key.publicKey)),
});

const accountKey = (
  node: Record<string, unknown>,
  hd: HDKeyNpm,
  path: string,
): Record<string, unknown> => ({
  node,
  path,
  curve: "secp256k1",
  publicKey: bytesToHex(new Uint8Array(hd.publicKey)),
  chainCode: bytesToHex(new Uint8Array(hd.chainCode)),
  parentFingerprint: fp8(hd.parentFingerprint ?? 0),
});

const exportsVector = {
  wallets: [{ mnemonic: MNEMONIC, fingerprint: masterFingerprint }],
  cases: [
    {
      name: "crypto-hdkey-evm",
      form: "crypto-hdkey",
      result: {
        fingerprint: masterFingerprint,
        keys: [accountKey({ kind: "evm.account" }, evmNode, "m/44'/60'/0'")],
      },
      expect: {
        discloses: "evm-all-addresses",
        note: "account.standard",
        name: "qntx",
        children: "0/*",
        originPath: "44'/60'/0'",
        depth: 3,
      },
    },
    {
      name: "crypto-account-bip84",
      form: "crypto-account",
      result: {
        fingerprint: masterFingerprint,
        keys: [
          accountKey(
            {
              kind: "btc.account",
              template: "btc.bip84",
              network: "bip122:000000000019d6689c085ae165831e93",
            },
            bip84Account,
            "m/84'/0'/0'",
          ),
        ],
      },
      expect: { discloses: "account-addresses", descriptor: "wpkh(", coinType: 0, network: 0 },
    },
    {
      name: "crypto-account-bip86",
      form: "crypto-account",
      result: {
        fingerprint: masterFingerprint,
        keys: [
          accountKey(
            {
              kind: "btc.account",
              template: "btc.bip86",
              network: "bip122:000000000019d6689c085ae165831e93",
            },
            bip86Account,
            "m/86'/0'/0'",
          ),
        ],
      },
      expect: { discloses: "account-addresses", descriptor: "tr(", coinType: 0, network: 0 },
    },
    {
      name: "multi-group0",
      form: "crypto-multi-accounts",
      result: {
        fingerprint: masterFingerprint,
        keys: [
          keyRow({ kind: "leaf", template: "evm.bip44" }, evmLeaf, EVM_PATH),
          keyRow({ kind: "leaf", template: "tron.bip44" }, tronLeaf, TRON_PATH),
          keyRow(
            { kind: "leaf", template: "solana.bip44-change" },
            { publicKey: solanaPublic },
            SOL_PATH,
          ),
          accountKey(
            {
              kind: "btc.account",
              template: "btc.bip84",
              network: "bip122:000000000019d6689c085ae165831e93",
            },
            bip84Account,
            "m/84'/0'/0'",
          ),
        ],
      },
      expect: { discloses: "account-addresses", device: "qntx", keyCount: 4 },
    },
    {
      name: "multi-leaves-only",
      form: "crypto-multi-accounts",
      result: {
        fingerprint: masterFingerprint,
        keys: [
          keyRow({ kind: "leaf", template: "evm.bip44" }, evmLeaf, EVM_PATH),
          keyRow({ kind: "leaf", template: "tron.bip44" }, tronLeaf, TRON_PATH),
        ],
      },
      expect: { discloses: "single-addresses", device: "qntx", keyCount: 2 },
    },
  ],
};

/* ---------------------------------------------------------------------------
 * Definite-length CBOR walker for byte surgery on the hostile cases. Each node
 * keeps its byte span; a tag keeps the inner node under `item`.
 * ------------------------------------------------------------------------- */
type CborNode = {
  readonly start: number;
  readonly end: number;
  readonly major: number;
  readonly value: unknown;
  readonly item?: CborNode;
};

const pairsOf = (node: CborNode): Array<[CborNode, CborNode]> => {
  if (node.major !== 5 || !Array.isArray(node.value)) {
    throw new Error("not a map node");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walker stores key-value pairs for a major-5 node
  return node.value as Array<[CborNode, CborNode]>;
};

const itemsOf = (node: CborNode): CborNode[] => {
  if (node.major !== 4 || !Array.isArray(node.value)) {
    throw new Error("not an array node");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walker stores items for a major-4 node
  return node.value as CborNode[];
};

const parseCbor = (bytes: Uint8Array, at_ = 0): { node: CborNode; next: number } => {
  let at = at_;
  const fail = (msg: string): never => {
    throw new Error(`cbor@${String(at)}: ${msg}`);
  };

  const start = at;
  const head = bytes[at];
  if (head === undefined) {
    throw new Error(`cbor@${String(at)}: eof`);
  }
  at += 1;
  const major = head >> 5;
  const info = head & 0x1f;
  let arg = BigInt(info);
  let size = info;
  if (info === 24) {
    size = 1;
  } else if (info === 25) {
    size = 2;
  } else if (info === 26) {
    size = 4;
  } else if (info === 27) {
    size = 8;
  } else if (info >= 28) {
    fail("indefinite item");
  }
  if (info >= 24) {
    arg = 0n;
    for (let i = 0; i < size; i += 1) {
      const b = bytes[at + i];
      if (b === undefined) {
        throw new Error(`cbor@${String(at + i)}: eof`);
      }
      arg = (arg << 8n) | BigInt(b);
    }
    at += size;
  }
  if (major === 0 || major === 1) {
    return { node: { start, end: at, major, value: arg }, next: at };
  }
  if (major === 2 || major === 3) {
    const end = at + Number(arg);
    if (end > bytes.length) {
      fail("eof in string");
    }
    const value =
      major === 2
        ? bytes.slice(at, end)
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(at, end));
    return { node: { start, end, major, value }, next: end };
  }
  if (major === 4) {
    const items: CborNode[] = [];
    for (let i = 0; i < Number(arg); i += 1) {
      const parsed = parseCbor(bytes, at);
      items.push(parsed.node);
      at = parsed.next;
    }
    return { node: { start, end: at, major, value: items }, next: at };
  }
  if (major === 5) {
    const pairs: Array<[CborNode, CborNode]> = [];
    for (let i = 0; i < Number(arg); i += 1) {
      const key = parseCbor(bytes, at);
      const val = parseCbor(bytes, key.next);
      pairs.push([key.node, val.node]);
      at = val.next;
    }
    return { node: { start, end: at, major, value: pairs }, next: at };
  }
  if (major === 6) {
    const item = parseCbor(bytes, at);
    return {
      node: { start, end: item.next, major, value: arg, item: item.node },
      next: item.next,
    };
  }
  return { node: { start, end: at, major, value: arg }, next: at };
};

const intEntries = (map: CborNode): Map<number, { key: CborNode; value: CborNode }> => {
  const out = new Map<number, { key: CborNode; value: CborNode }>();
  for (const pair of pairsOf(map)) {
    const [key, value] = pair;
    if (key.major === 0) {
      out.set(Number(key.value), { key, value });
    }
  }
  return out;
};

const mustInner = (node: CborNode): CborNode => {
  if (node.item === undefined) {
    throw new Error("not a tagged node");
  }
  return node.item;
};

const intEntry = (map: CborNode, key: number): { key: CborNode; value: CborNode } => {
  const entry = intEntries(map).get(key);
  if (entry === undefined) {
    throw new Error(`map has no int key ${String(key)}`);
  }
  return entry;
};

const spliceHex = (bytes: Uint8Array, start: number, end: number, insert: Uint8Array): string => {
  const out = new Uint8Array(bytes.length - (end - start) + insert.length);
  out.set(bytes.slice(0, start));
  out.set(insert, start);
  out.set(bytes.slice(end), start + insert.length);
  return bytesToHex(out);
};

const cbor = (hex: string): Uint8Array => hexToBytes(hex);

const request = (name: string): { type: string; cbor: Uint8Array; node: CborNode } => {
  const row = requests.find((entry) => entry.name === name);
  if (row === undefined) {
    throw new Error(`no request ${name}`);
  }
  const bytes = cbor(row.cbor);
  return { type: row.type, cbor: bytes, node: parseCbor(bytes).node };
};

/* Vendor bodies are bare int maps (no outer tag): eth `{1 #6.37 uuid?, 2 signData, 3 dataType,
   4 chainId?, 5 #6.304 keypath, 6 address?, 7 origin?}`; sol `{1 uuid?, 2 signData, 3 keypath,
   4 address?, 5 origin?, 6 signType}`; tron `{1 uuid?, 2 signData, 3 dataType, 4 keypath, 5
   address?, 6 origin?}`. */
const legacy = request("evm-legacy-transfer");
const legacyMap = legacy.node;
const signDataSpan = intEntry(legacyMap, 2).value;
const dataTypeSpan = intEntry(legacyMap, 3).value;
const chainIdSpan = intEntry(legacyMap, 4).value;
const keypathMap = mustInner(intEntry(legacyMap, 5).value);
const uuidValue = mustInner(intEntry(legacyMap, 1).value);

/* The bstr value's node span covers header+content; `contentStart` locates where the payload
   bytes begin (header for 20..255 B is `0x58 len`, longer is `0x59 len16` etc.). */
const bstrContentStart = (bytes: Uint8Array, node: CborNode): number => {
  const head = bytes[node.start];
  if (head === undefined || head >> 5 !== 2) {
    throw new Error("not a bstr");
  }
  const info = head & 0x1f;
  const headLen = info < 24 ? 1 : info === 24 ? 2 : info === 25 ? 3 : info === 26 ? 5 : 9;
  return node.start + headLen;
};

const bstr = (content: Uint8Array): Uint8Array => {
  if (content.length < 24) {
    return new Uint8Array([0x40 + content.length, ...content]);
  }
  if (content.length < 256) {
    return new Uint8Array([0x58, content.length, ...content]);
  }
  return new Uint8Array([0x59, content.length >> 8, content.length & 0xff, ...content]);
};

const replaceSpan = (bytes: Uint8Array, node: CborNode, insert: Uint8Array): string =>
  spliceHex(bytes, node.start, node.end, insert);

const entryBytes = (source: typeof legacy, key: number): Uint8Array => {
  const node = intEntry(source.node, key).value;
  return source.cbor.slice(node.start, node.end);
};

const hostilePayload = (name: string, source: typeof legacy, cborHex: string, expect: string) => ({
  name,
  subject: "payload" as const,
  payload: { type: source.type, cbor: cborHex },
  expect,
});

/* eth-sign-request mutations */
const hostile = [
  hostilePayload(
    "eth-wrong-tag",
    legacy,
    // tag 303 (d9 012f) → 304 (d9 0130)
    spliceHex(legacy.cbor, 0, 3, hexToBytes("d90130")),
    "malformed",
  ),
  hostilePayload("eth-trailing-bytes", legacy, `${bytesToHex(legacy.cbor)}00`, "malformed"),
  hostilePayload(
    "eth-duplicate-map-key",
    legacy,
    (() => {
      const pairs = pairsOf(legacyMap);
      const [first] = pairs;
      if (first === undefined) {
        throw new Error("empty map");
      }
      const dup = legacy.cbor.slice(first[0].start, first[1].end);
      const bumped = new Uint8Array(legacy.cbor);
      bumped[legacyMap.start] = (bumped[legacyMap.start] ?? 0) + 1;
      const body = bumped.slice(legacyMap.start + 1);
      return bytesToHex(
        new Uint8Array([
          ...bumped.slice(0, legacyMap.start + 1),
          ...body.slice(0, 0),
          ...dup,
          ...body,
        ]),
      );
    })(),
    "malformed",
  ),
  hostilePayload(
    "eth-unknown-map-key",
    legacy,
    (() => {
      const bumped = new Uint8Array(legacy.cbor);
      bumped[legacyMap.start] = (bumped[legacyMap.start] ?? 0) + 1;
      const inserted = new Uint8Array([0x18, 0x63, 0x00]); // key 99 → 0
      return bytesToHex(
        new Uint8Array([
          ...bumped.slice(0, legacyMap.start + 1),
          ...inserted,
          ...bumped.slice(legacyMap.start + 1),
        ]),
      );
    })(),
    "malformed",
  ),
  hostilePayload(
    "eth-noncanonical-int",
    legacy,
    replaceSpan(legacy.cbor, dataTypeSpan, hexToBytes("1b0000000000000003")),
    "malformed",
  ),
  hostilePayload(
    "eth-float-chain-id",
    legacy,
    replaceSpan(legacy.cbor, chainIdSpan, hexToBytes("fb3ff0000000000000")),
    "malformed",
  ),
  hostilePayload(
    "eth-empty-sign-data",
    legacy,
    replaceSpan(legacy.cbor, signDataSpan, new Uint8Array([0x40])),
    "malformed",
  ),
  hostilePayload(
    "eth-address-wrong-length",
    (() => {
      const src = request("evm-personal-message");
      return { type: src.type, cbor: src.cbor, node: src.node };
    })(),
    (() => {
      const src = request("evm-personal-message");
      const addressSpan = intEntry(src.node, 6).value;
      const contentStart = bstrContentStart(src.cbor, addressSpan);
      const content = src.cbor.slice(contentStart, addressSpan.end);
      return spliceHex(src.cbor, addressSpan.start, addressSpan.end, bstr(content.subarray(0, 19)));
    })(),
    "malformed",
  ),
  hostilePayload(
    "eth-request-id-15",
    legacy,
    (() => {
      const contentStart = bstrContentStart(legacy.cbor, uuidValue);
      const content = legacy.cbor.slice(contentStart, uuidValue.end);
      return spliceHex(legacy.cbor, uuidValue.start, uuidValue.end, bstr(content.subarray(0, 15)));
    })(),
    "malformed",
  ),
  hostilePayload(
    "eth-wildcard-path",
    legacy,
    (() => {
      const components = intEntry(keypathMap, 1).value;
      const items = itemsOf(components);
      // items are flat [index, hardened] pairs; rewrite the last pair as a wildcard `[] false`.
      const idx = items.length - 2;
      const last = items.slice(idx);
      const [a, b] = last;
      if (a === undefined || b === undefined) {
        throw new Error("path components too short");
      }
      return spliceHex(legacy.cbor, a.start, b.end, hexToBytes("80f4"));
    })(),
    "malformed",
  ),
  hostilePayload(
    "eth-missing-fingerprint",
    legacy,
    (() => {
      const entry = intEntry(keypathMap, 2);
      const bumped = new Uint8Array(legacy.cbor);
      bumped[keypathMap.start] = (bumped[keypathMap.start] ?? 0) - 1;
      const without = spliceHex(bumped, entry.key.start, entry.value.end, new Uint8Array());
      return without;
    })(),
    "fingerprint-missing",
  ),
  hostilePayload(
    "eth-legacy-rlp-trailing",
    legacy,
    (() => {
      const contentStart = bstrContentStart(legacy.cbor, signDataSpan);
      const content = legacy.cbor.slice(contentStart, signDataSpan.end);
      return spliceHex(
        legacy.cbor,
        signDataSpan.start,
        signDataSpan.end,
        bstr(new Uint8Array([...content, 0x00])),
      );
    })(),
    "malformed",
  ),
  hostilePayload(
    "eth-legacy-rlp-noncanonical",
    legacy,
    (() => {
      const contentStart = bstrContentStart(legacy.cbor, signDataSpan);
      const content = legacy.cbor.slice(contentStart, signDataSpan.end);
      // The RLP list's short-form length prefix f8<len> becomes long-form f9 00<len>.
      if (content[0] === undefined || content[0] < 0xb8) {
        throw new Error("unexpected rlp head");
      }
      const mutated = new Uint8Array(content);
      if (mutated[0] !== undefined && mutated[0] <= 0xf7) {
        mutated[0] = (mutated[0] ?? 0) + 1; // one-byte list → still canonical check fails downstream
      }
      const head = mutated[0] === 0xf8 ? [0xf9, 0x00, mutated[1] ?? 0] : [mutated[0] ?? 0];
      const rebuilt =
        mutated[0] === 0xf8
          ? new Uint8Array([...head, ...mutated.slice(2)])
          : new Uint8Array([0xf9, 0x00, content[0] ?? 0, ...mutated.slice(1)]);
      return spliceHex(legacy.cbor, signDataSpan.start, signDataSpan.end, bstr(rebuilt));
    })(),
    "malformed",
  ),
  hostilePayload(
    "eth-eip7702-envelope",
    legacy,
    spliceHex(
      legacy.cbor,
      signDataSpan.start,
      signDataSpan.end,
      bstr(new Uint8Array([0x04, 0xc0])),
    ),
    "unsupported",
  ),
  hostilePayload(
    "eth-typed-data-invalid-utf8",
    (() => {
      const row = requests.find((entry) => entry.name === "evm-typed-data");
      if (row === undefined) {
        throw new Error("no typed-data request");
      }
      return { type: row.type, cbor: cbor(row.cbor), node: parseCbor(cbor(row.cbor)).node };
    })(),
    (() => {
      const row = requests.find((entry) => entry.name === "evm-typed-data");
      if (row === undefined) {
        throw new Error("no typed-data request");
      }
      const bytes = cbor(row.cbor);
      const { node } = parseCbor(bytes);
      const sd = intEntry(node, 2).value;
      return spliceHex(bytes, sd.start, sd.end, bstr(hexToBytes("fffe")));
    })(),
    "malformed",
  ),
];

const solTx = request("sol-transaction");
const solMap = solTx.node;
const tronTx = request("tron-transaction");

hostile.push(
  hostilePayload(
    "sol-offchain-type",
    solTx,
    (() => {
      const signType = intEntry(solMap, 6).value;
      return spliceHex(solTx.cbor, signType.start, signType.end, new Uint8Array([0x03]));
    })(),
    "unsupported",
  ),
  hostilePayload(
    "tron-onekey-layout",
    tronTx,
    /* OneKey's BaseSignRequest body `{1 uuid?, 2 signData, 3 #6.304 path, 6 requestType}` —
       requestType 2 is messageV1, the only OneKey dialect the Keystone codec refuses. */
    bytesToHex(
      new Uint8Array([
        0xa4,
        0x01,
        ...entryBytes(tronTx, 1),
        0x02,
        ...entryBytes(tronTx, 2),
        0x03,
        ...entryBytes(tronTx, 4),
        0x06,
        0x02,
      ]),
    ),
    "unsupported",
  ),
  hostilePayload(
    "payload-empty-cbor",
    { type: "crypto-psbt", cbor: new Uint8Array(), node: parseCbor(new Uint8Array([0x40])).node },
    "",
    "malformed",
  ),
);

const scanCases = [
  {
    name: "scan-oversized-message",
    subject: "scan",
    kind: "request",
    payload: {
      type: "crypto-psbt",
      cbor: bytesToHex(
        new Uint8Array([...hexToBytes("d9a6cd"), ...new Uint8Array(70_000).fill(7)]),
      ),
    },
    limits: {},
    expect: "scan-failed",
  },
  {
    name: "scan-fragment-count-over-limit",
    subject: "scan",
    kind: "request",
    payload: {
      type: "crypto-psbt",
      cbor: bytesToHex(new Uint8Array([...hexToBytes("d9a6cd"), ...new Uint8Array(400).fill(9)])),
    },
    limits: { maxFragments: 1 },
    expect: "scan-failed",
  },
  {
    name: "scan-frames-over-maxFrames",
    subject: "scan",
    kind: "request",
    frames: ["UR:BYTES/AOEA", "UR:BYTES/AOEA", "UR:BYTES/AOEA"],
    limits: { maxFrames: 2 },
    expect: "scan-exhausted",
  },
  {
    name: "scan-deadline",
    subject: "scan",
    kind: "request",
    frames: ["UR:BYTES/AOEA", "UR:BYTES/AOEA"],
    limits: { timeoutMs: 1500 },
    now: [0, 2000],
    expect: "scan-timeout",
  },
  {
    name: "scan-mixed-ur-types",
    subject: "scan",
    kind: "request",
    // first a real (fragmented) eth-sign-request frame, then a crypto-hdkey frame
    payload: { type: "eth-sign-request", cbor: requests[0]?.cbor ?? "" },
    foreign: { type: "crypto-hdkey", cbor: bytesToHex(hexToBytes("d9a6c8a10200")) },
    fragmentLength: 50,
    expect: "scan-failed",
  },
];

writeFileSync("vectors/qr/requests.json", `${JSON.stringify({ version: 1, requests }, null, 2)}\n`);
writeFileSync(
  "vectors/qr/exports.json",
  `${JSON.stringify({ version: 1, ...exportsVector }, null, 2)}\n`,
);
writeFileSync(
  "vectors/qr/hostile.json",
  `${JSON.stringify({ version: 1, cases: [...hostile, ...scanCases] }, null, 2)}\n`,
);
console.log(
  `wrote ${String(requests.length)} requests, ${String(exportsVector.cases.length)} export cases, ${String(hostile.length + scanCases.length)} hostile cases`,
);
