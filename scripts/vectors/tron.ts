/// <reference types="node" />
/**
 * Regenerates vectors/chains/tron.json without importing wallet-chains code — tronweb 6.5.2 is the
 * oracle for `m/44'/195'/0'/0/i` derivation (SLIP-44 coin type 195) and public-key → address.
 *
 * Address = base58check(0x41 ‖ keccak256(uncompressed secp256k1 public key [1..])[12..32]),
 * checksum = sha256(sha256(payload))[0..4).
 *
 * The "transactions" section signs fixed-input transactions offline through tronweb's
 * TransactionBuilder + utils.crypto.signTransaction — each row records our own builder input
 * (header + TronContract JSON: bigint fields as decimal strings, bytes as 0x hex), the canonical
 * raw_data hex, the txID (sha256 of raw_data) and the signature. "input: null" marks a decode-only
 * row of a contract type the wallet does not model.
 *
 * Run from the repo root: bun scripts/vectors/tron.ts
 */
import { writeFileSync } from "node:fs";

import { TronWeb } from "tronweb";

/* eslint-disable @typescript-eslint/no-explicit-any -- tronweb's untyped builder options */

const tronWeb = new TronWeb({ fullHost: "https://api.trongrid.io" });

const MNEMONICS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "test test test test test test test test test test test junk",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function assert(condition: boolean, what: string): asserts condition {
  if (!condition) {
    throw new Error(`vector oracle mismatch: ${what}`);
  }
}

const derivation = MNEMONICS.flatMap((mnemonic) =>
  [0, 1, 2].map((index) => {
    const path = `m/44'/195'/0'/0/${index}`;
    const { privateKey, address } = tronWeb.fromMnemonic(mnemonic, path);
    return { mnemonic, index, path, privateKey: privateKey.slice(2), address };
  }),
);

const keys = [
  {
    name: "trust-1",
    privateKey: "2d8f68944bdbfbc0769542fba8fc2d2a3de67393334471624364c7006da2aa54",
    address: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC",
    source:
      "https://github.com/trustwallet/wallet-core/blob/f90a51f1/tests/chains/Tron/AddressTests.cpp",
  },
  {
    name: "trust-2",
    privateKey: "be88df1d0bf30a923cb39c3bb953178baaf3726e8d3ce81e7c8462e046e0d835",
    address: "THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3",
    source:
      "https://github.com/trustwallet/wallet-core/blob/f90a51f1/tests/chains/Tron/AddressTests.cpp",
  },
  {
    name: "tronlink",
    privateKey: "15f0bbb1774be40b7a8d7965d637f324bda2f711fc5726a3dcc19585c6950954",
    address: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6",
    source:
      "https://github.com/TronLink/tronlink-extension/blob/d6a9d840/src/tests/tron_wallet/constants.ts",
  },
  {
    name: "anvil",
    privateKey: "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    address: "",
    source: "tronweb 6.5.2 pkToAddress",
  },
];

for (const key of keys) {
  const address = tronWeb.address.fromPrivateKey(key.privateKey);
  if (address === false) {
    throw new Error(`vector oracle failed: pkToAddress(${key.name})`);
  }
  if (key.address === "") {
    key.address = address;
  }
  assert(
    address === key.address,
    `pkToAddress(${key.name}): tronweb ${address} != vector ${key.address}`,
  );
}

// The TronLink constants pair is the "test…junk" mnemonic's index-0 account — the same
// m/44'/195'/0'/0/i layout TronLink, OneKey and Trust all use.
const junk0 = derivation.find((r) => r.mnemonic.startsWith("test ") && r.index === 0);
assert(
  junk0 !== undefined &&
    junk0.privateKey === keys[2]?.privateKey &&
    junk0.address === keys[2]?.address,
  '"test…junk" index 0 derivation != the TronLink constants pair',
);

const [first] = keys;
assert(first !== undefined, "no key rows");
const mutated = `${first.address.slice(0, -1)}${first.address.endsWith("C") ? "D" : "C"}`;

const invalid = [
  { value: "abc", reason: "too short for a 34-character base58check address" },
  {
    value: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    reason: "EVM hex form, not base58check",
  },
  {
    value: "175tWpb8K1S7NmH4Zx6rewF9WQrcZv245W",
    reason: "valid base58check but a 20-byte payload — no 0x41 prefix",
  },
  { value: "2MegQ6oqSda2tTagdEzBA", reason: "base58check payload shorter than 21 bytes" },
  { value: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYq", reason: "33 characters — too short" },
  { value: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeLL", reason: "35 characters — too long" },
  { value: mutated, reason: "last character changed — checksum mismatch" },
  {
    value: tronWeb.address.fromHex(`42${"ab".repeat(20)}`),
    reason: "valid base58check but prefix byte 0x42, not 0x41",
  },
];

// -- transactions -------------------------------------------------------------
// Fixed offline inputs: the anvil key signs every case, the block reference and times are
// constants, and every tronweb builder is driven fully offline (blockHeader supplies all four
// ref fields so createTransaction never calls a node; txLocal: true on triggerSmartContract).
const [alice, bob, carol, anvil] = keys;
assert(
  anvil !== undefined && alice !== undefined && bob !== undefined && carol !== undefined,
  "keys section is incomplete",
);
const ANVIL_KEY = anvil.privateKey;
const OWNER = anvil.address;
const ALICE = alice.address; // TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC
const BOB = bob.address; // THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3
const CAROL = carol.address; // TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const REF = {
  number: 76050000,
  id: `0000000004886e50${"1a2b3c4d5e6f7890".repeat(3)}`,
};
const HEADER = { refBlock: REF, expiration: 1767225660000, timestamp: 1767225600000 };
const BLOCK_HEADER = {
  // oxlint-disable-next-line no-bitwise -- low 16 bits of the block number, per the TRON spec
  ref_block_bytes: (REF.number & 0xffff).toString(16).padStart(4, "0"),
  ref_block_hash: REF.id.slice(16, 32),
  expiration: HEADER.expiration,
  timestamp: HEADER.timestamp,
};
const OPTS = { blockHeader: BLOCK_HEADER };

const hex = (text: string): string => `0x${Buffer.from(text, "utf8").toString("hex")}`;
const utf8 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "utf8"));

const MEMO_TEXT = "tron fixed-vector memo";

const OPS_HEX = `02${"00".repeat(2)}80${"00".repeat(28)}`; // TransferContract(1), TriggerSmartContract(31)

const transactions: Array<{
  name: string;
  input: unknown;
  rawDataHex: string;
  txId: string;
  signature: string;
}> = [];

const record = async (
  name: string,
  input: unknown,
  build: () => Promise<Record<string, any>>,
): Promise<void> => {
  const tx = await build();
  const signed: unknown = await tronWeb.trx.sign(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tronweb's sign() wants its own Transaction shape; our record is the same object
    tx as Parameters<typeof tronWeb.trx.sign>[0],
    ANVIL_KEY,
  );
  assert(isRecord(signed), `${name} signed tx is not an object`);
  const rawDataHex = signed["raw_data_hex"];
  const txId = signed["txID"];
  const signatures = signed["signature"];
  assert(Array.isArray(signatures), `${name} signature list is missing`);
  const signature = signatures.find((s): s is string => typeof s === "string");
  assert(typeof rawDataHex === "string" && /^[0-9a-f]+$/.test(rawDataHex), `${name} raw_data_hex`);
  assert(typeof txId === "string" && /^[0-9a-f]{64}$/.test(txId), `${name} txID`);
  assert(
    typeof signature === "string" && /^[0-9a-fA-F]{130}$/.test(signature),
    `${name} signature`,
  );
  transactions.push({ name, input, rawDataHex, txId, signature });
};

const triggerData = async (
  name: string,
  contractAddress: string,
  selector: string,
  options: Record<string, unknown>,
  parameters: Array<{ type: string; value: unknown }>,
  contract: (data: string) => Record<string, unknown>,
): Promise<void> => {
  let built: unknown;
  await record(name, null, async () => {
    built = await tronWeb.transactionBuilder.triggerSmartContract(
      contractAddress,
      selector,
      { txLocal: true, ...options, blockHeader: BLOCK_HEADER },
      parameters,
      OWNER,
    );
    assert(isRecord(built), `${name} triggerSmartContract result is not an object`);
    const inner = built["transaction"];
    assert(isRecord(inner), `${name} transaction is not an object`);
    return inner;
  });
  // _triggerSmartContractLocal returns { result, transaction }; its raw value.data is the
  // canonical ABI bytes — record them so our builder input reproduces the same calldata.
  assert(isRecord(built), `${name} triggerSmartContract result is not an object`);
  const builtTx = built["transaction"];
  assert(isRecord(builtTx), `${name} transaction is not an object`);
  const builtRaw = builtTx["raw_data"];
  assert(isRecord(builtRaw), `${name} raw_data is not an object`);
  const builtContracts = builtRaw["contract"];
  assert(Array.isArray(builtContracts), `${name} contract list is missing`);
  const firstContract = builtContracts.find(isRecord);
  assert(isRecord(firstContract), `${name} contract is not an object`);
  const builtParameter = firstContract["parameter"];
  assert(isRecord(builtParameter), `${name} parameter is not an object`);
  const builtValue = builtParameter["value"];
  assert(isRecord(builtValue), `${name} value is not an object`);
  const builtData = builtValue["data"];
  assert(typeof builtData === "string", `${name} calldata is not a string`);
  const lastRow = transactions.at(-1);
  assert(lastRow !== undefined, `${name} transaction row is missing`);
  lastRow.input = contract(`0x${builtData}`);
};

await record(
  "trx-transfer",
  {
    header: HEADER,
    contract: { type: "TransferContract", owner: OWNER, to: ALICE, amount: "1000000" },
  },
  async () => tronWeb.transactionBuilder.sendTrx(ALICE, 1_000_000, OWNER, OPTS),
);

await record(
  "trx-transfer-memo",
  {
    header: { ...HEADER, memo: hex(MEMO_TEXT) },
    contract: { type: "TransferContract", owner: OWNER, to: BOB, amount: "2000000" },
  },
  async () =>
    tronWeb.transactionBuilder.addUpdateData(
      await tronWeb.transactionBuilder.sendTrx(BOB, 2_000_000, OWNER, OPTS),
      MEMO_TEXT,
      "utf8",
      { txLocal: true },
    ),
);

await record(
  "trx-transfer-permission-2",
  {
    header: { ...HEADER, permissionId: 2 },
    contract: { type: "TransferContract", owner: OWNER, to: ALICE, amount: "3000000" },
  },
  async () =>
    tronWeb.transactionBuilder.sendTrx(ALICE, 3_000_000, OWNER, {
      ...OPTS,
      permissionId: 2,
    }),
);

await triggerData(
  "trc20-transfer",
  USDT,
  "transfer(address,uint256)",
  { feeLimit: 30_000_000 },
  [
    { type: "address", value: ALICE },
    { type: "uint256", value: "10000000" },
  ],
  (data) => ({
    header: { ...HEADER, feeLimit: "30000000" },
    contract: {
      type: "TriggerSmartContract",
      owner: OWNER,
      contract: USDT,
      callValue: "0",
      data,
      callTokenValue: "0",
      tokenId: "0",
    },
  }),
);

await triggerData(
  "trc20-transfer-self",
  USDT,
  "transfer(address,uint256)",
  { feeLimit: 30_000_000 },
  [
    { type: "address", value: OWNER },
    { type: "uint256", value: "1" },
  ],
  (data) => ({
    header: { ...HEADER, feeLimit: "30000000" },
    contract: {
      type: "TriggerSmartContract",
      owner: OWNER,
      contract: USDT,
      callValue: "0",
      data,
      callTokenValue: "0",
      tokenId: "0",
    },
  }),
);

await triggerData(
  "trc20-approve",
  USDT,
  "approve(address,uint256)",
  { feeLimit: 30_000_000 },
  [
    { type: "address", value: BOB },
    { type: "uint256", value: "5000000" },
  ],
  (data) => ({
    header: { ...HEADER, feeLimit: "30000000" },
    contract: {
      type: "TriggerSmartContract",
      owner: OWNER,
      contract: USDT,
      callValue: "0",
      data,
      callTokenValue: "0",
      tokenId: "0",
    },
  }),
);

await triggerData(
  "trc20-approve-unlimited",
  USDT,
  "approve(address,uint256)",
  { feeLimit: 30_000_000 },
  [
    { type: "address", value: BOB },
    {
      type: "uint256",
      value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    },
  ],
  (data) => ({
    header: { ...HEADER, feeLimit: "30000000" },
    contract: {
      type: "TriggerSmartContract",
      owner: OWNER,
      contract: USDT,
      callValue: "0",
      data,
      callTokenValue: "0",
      tokenId: "0",
    },
  }),
);

await record(
  "trc10-transfer",
  {
    header: HEADER,
    contract: {
      type: "TransferAssetContract",
      owner: OWNER,
      to: ALICE,
      assetId: "1002000",
      amount: "500",
    },
  },
  async () => tronWeb.transactionBuilder.sendToken(ALICE, 500, "1002000", OWNER, OPTS),
);

await record(
  "freeze-v2-energy",
  {
    header: HEADER,
    contract: {
      type: "FreezeBalanceV2Contract",
      owner: OWNER,
      amount: "2000000",
      resource: 1,
    },
  },
  async () => tronWeb.transactionBuilder.freezeBalanceV2(2_000_000, "ENERGY", OWNER, OPTS),
);

await record(
  "freeze-v2-bandwidth",
  {
    header: HEADER,
    contract: {
      type: "FreezeBalanceV2Contract",
      owner: OWNER,
      amount: "3000000",
      resource: 0,
    },
  },
  async () => tronWeb.transactionBuilder.freezeBalanceV2(3_000_000, "BANDWIDTH", OWNER, OPTS),
);

await record(
  "unfreeze-v2-energy",
  {
    header: HEADER,
    contract: {
      type: "UnfreezeBalanceV2Contract",
      owner: OWNER,
      amount: "1000000",
      resource: 1,
    },
  },
  async () => tronWeb.transactionBuilder.unfreezeBalanceV2(1_000_000, "ENERGY", OWNER, OPTS),
);

await record(
  "delegate-energy",
  {
    header: HEADER,
    contract: {
      type: "DelegateResourceContract",
      owner: OWNER,
      resource: 1,
      balance: "4000000",
      receiver: ALICE,
      lock: false,
      lockPeriod: "0",
    },
  },
  async () =>
    tronWeb.transactionBuilder.delegateResource(
      4_000_000,
      ALICE,
      "ENERGY",
      OWNER,
      false,
      undefined,
      OPTS,
    ),
);

await record(
  "delegate-bandwidth-locked",
  {
    header: HEADER,
    contract: {
      type: "DelegateResourceContract",
      owner: OWNER,
      resource: 0,
      balance: "5000000",
      receiver: BOB,
      lock: true,
      lockPeriod: "28800",
    },
  },
  async () =>
    tronWeb.transactionBuilder.delegateResource(
      5_000_000,
      BOB,
      "BANDWIDTH",
      OWNER,
      true,
      28800,
      OPTS,
    ),
);

await record(
  "undelegate-energy",
  {
    header: HEADER,
    contract: {
      type: "UnDelegateResourceContract",
      owner: OWNER,
      resource: 1,
      balance: "2000000",
      receiver: ALICE,
    },
  },
  async () =>
    tronWeb.transactionBuilder.undelegateResource(2_000_000, ALICE, "ENERGY", OWNER, OPTS),
);

await record(
  "withdraw-expire-unfreeze",
  {
    header: HEADER,
    contract: { type: "WithdrawExpireUnfreezeContract", owner: OWNER },
  },
  async () => tronWeb.transactionBuilder.withdrawExpireUnfreeze(OWNER, OPTS),
);

await record(
  "cancel-all-unfreeze-v2",
  {
    header: HEADER,
    contract: { type: "CancelAllUnfreezeV2Contract", owner: OWNER },
  },
  async () => tronWeb.transactionBuilder.cancelUnfreezeBalanceV2(OWNER, OPTS),
);

await record(
  "vote-witness",
  {
    header: HEADER,
    contract: {
      type: "VoteWitnessContract",
      owner: OWNER,
      votes: [
        { witness: ALICE, count: "3" },
        { witness: BOB, count: "7" },
      ],
      support: false,
    },
  },
  async () => tronWeb.transactionBuilder.vote({ [ALICE]: 3, [BOB]: 7 }, OWNER, OPTS),
);

await record(
  "withdraw-balance",
  {
    header: HEADER,
    contract: { type: "WithdrawBalanceContract", owner: OWNER },
  },
  async () => tronWeb.transactionBuilder.withdrawBlockRewards(OWNER, OPTS),
);

await record(
  "account-permission-update",
  {
    header: HEADER,
    contract: {
      type: "AccountPermissionUpdateContract",
      owner: OWNER,
      ownerPermission: {
        type: 0,
        id: 2,
        name: "owner",
        threshold: "1",
        parentId: 0,
        operations: "0x",
        keys: [{ address: CAROL, weight: "1" }],
      },
      actives: [
        {
          type: 2,
          id: 2,
          name: "active0",
          threshold: "2",
          parentId: 0,
          operations: `0x${OPS_HEX}`,
          keys: [
            { address: OWNER, weight: "1" },
            { address: ALICE, weight: "1" },
          ],
        },
      ],
    },
  },
  async () =>
    tronWeb.transactionBuilder.updateAccountPermissions(
      OWNER,
      {
        type: 0,
        permission_name: "owner",
        threshold: 1,
        id: 2,
        keys: [{ address: CAROL, weight: 1 }],
      },
      null,
      [
        {
          type: 2,
          permission_name: "active0",
          threshold: 2,
          id: 2,
          operations: OPS_HEX,
          keys: [
            { address: OWNER, weight: 1 },
            { address: ALICE, weight: 1 },
          ],
        },
      ],
      OPTS,
    ),
);

await triggerData(
  "trigger-call-value",
  CAROL,
  "foo(uint256)",
  { feeLimit: 10_000_000, callValue: 1_000_000 },
  [{ type: "uint256", value: "7" }],
  (data) => ({
    header: { ...HEADER, feeLimit: "10000000" },
    contract: {
      type: "TriggerSmartContract",
      owner: OWNER,
      contract: CAROL,
      callValue: "1000000",
      data,
      callTokenValue: "0",
      tokenId: "0",
    },
  }),
);

await triggerData(
  "trigger-token-unknown-selector",
  USDT,
  "issue(uint256)",
  { feeLimit: 10_000_000 },
  [{ type: "uint256", value: "42" }],
  (data) => ({
    header: { ...HEADER, feeLimit: "10000000" },
    contract: {
      type: "TriggerSmartContract",
      owner: OWNER,
      contract: USDT,
      callValue: "0",
      data,
      callTokenValue: "0",
      tokenId: "0",
    },
  }),
);

await record("unsupported-account-update", null, async () =>
  tronWeb.transactionBuilder.updateAccount("vector-account", OWNER, OPTS),
);

const TRUST_MSG_KEY = "75065f100e38d3f3b4c5c4235834ba8216de62272a4f03532c44b31a5734360a";
const TRUST_MSG_LITERALS: Record<string, string> = {
  "Hello World":
    "bc0753c070cc55693097df11bc11e1a7c4bd5e1a40b9dc94c75568e59bcc9d6b50a7873ef25b469e494490a54de37327b4bc7fc825c81a377b555e34fb7261ba1c",
  "A much longer message to test the signing and verification process":
    "93aee5f753cf889e0749c74dd0c5996cce889883ae079e09ede462e16d65d06a4f43d1ed2745e9f3c1690695628269bd58f057a4a93953cc50e66b4a05bc0f451b",
};

const messages: Array<{
  name: string;
  privateKey: string;
  address: string;
  messageHex: string;
  signature: string;
}> = [];

const privateKeyToAddress = (privateKey: string): string => {
  const address = tronWeb.address.fromPrivateKey(privateKey);
  assert(address !== false, `address derivation failed for ${nameOfKey(privateKey)}`);
  return address;
};

const nameOfKey = (privateKey: string): string =>
  privateKey === TRUST_MSG_KEY ? "trust" : privateKey === ANVIL_KEY ? "anvil" : "unknown";

const recordMessage = (name: string, privateKey: string, message: Uint8Array): void => {
  const signed = tronWeb.trx.signMessageV2(message, privateKey);
  assert(typeof signed === "string", `${name} signMessageV2 failed`);
  const signature = signed.replace(/^0x/i, "").toLowerCase();
  assert(/^[0-9a-f]+$/i.test(signature), `${name} signature is not hex`);
  messages.push({
    name,
    privateKey,
    address: privateKeyToAddress(privateKey),
    messageHex: Buffer.from(message).toString("hex"),
    signature: signature.toLowerCase(),
  });
};

for (const [text, expected] of Object.entries(TRUST_MSG_LITERALS)) {
  recordMessage(`trust-${text === "Hello World" ? "hello" : "long"}`, TRUST_MSG_KEY, utf8(text));
  const got = messages.at(-1)?.signature;
  assert(got === expected, `${text}: tronweb ${String(got)} != Trust ${expected}`);
}
recordMessage("hello-world", ANVIL_KEY, utf8("hello world"));
recordMessage("utf8-chinese", ANVIL_KEY, utf8("你好，TRON"));
recordMessage(
  "digest-32-bytes",
  ANVIL_KEY,
  Uint8Array.from({ length: 32 }, (_, i) => i + 1),
);
recordMessage("non-utf8-bytes", ANVIL_KEY, Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80]));

writeFileSync(
  "vectors/chains/tron.json",
  `${JSON.stringify(
    {
      comment:
        "TRON address and m/44'/195'/0'/0/i derivation vectors — generated by " +
        "scripts/vectors/tron.ts against tronweb 6.5.2, independent of wallet-chains. " +
        "privateKey is 64 lowercase hex without 0x, the TronLink/tronweb encoding.",
      sources: [
        "tronweb 6.5.2 TronWeb.fromMnemonic(path) / address.fromPrivateKey (pkToAddress)",
        "https://github.com/trustwallet/wallet-core/blob/f90a51f1/tests/chains/Tron/AddressTests.cpp — key and invalid-address vectors",
        'https://github.com/TronLink/tronlink-extension/blob/d6a9d840/src/tests/tron_wallet/constants.ts — key + "test…junk" index-0 derivation pair',
        "tronweb 6.5.2 TransactionBuilder (blockHeader / txLocal, fully offline) + trx.sign — transactions section",
        "https://github.com/trustwallet/wallet-core/blob/f90a51f1/tests/chains/Tron/TronMessageSignerTests.cpp — message-signature literals asserted in this script",
        "tronweb 6.5.2 TronWeb.Trx.signMessageV2 — messages section",
      ],
      derivation,
      keys,
      invalid,
      transactions,
      messages,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `vectors/chains/tron.json: ${derivation.length} derivation rows, ${keys.length} keys, ` +
    `${invalid.length} invalid, ${transactions.length} transactions, ${messages.length} messages. abandon…about: ${derivation
      .filter((r) => r.mnemonic.startsWith("abandon ") && r.mnemonic.endsWith("about"))
      .map((r) => r.address)
      .join(", ")}`,
);
