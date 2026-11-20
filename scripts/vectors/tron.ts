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
 * (header + TronContract JSON: bigint fields as decimal strings, bytes as 0x hex), the
 * canonical raw_data hex, the txID (sha256 of raw_data) and the signature. "input: null" marks a
 * decode-only row of a contract type the wallet does not model.
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
const ANVIL_KEY = keys[3]?.privateKey as string;
const OWNER = keys[3]?.address as string;
const ALICE = keys[0]?.address as string; // TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC
const BOB = keys[1]?.address as string; // THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3
const CAROL = keys[2]?.address as string; // TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const REF = {
  number: 76050000,
  id: `0000000004886e50${"1a2b3c4d5e6f7890".repeat(3)}`,
};
const HEADER = { refBlock: REF, expiration: 1767225660000, timestamp: 1767225600000 };
const BLOCK_HEADER = {
  ref_block_bytes: (REF.number & 0xffff).toString(16).padStart(4, "0"),
  ref_block_hash: REF.id.slice(16, 32),
  expiration: HEADER.expiration,
  timestamp: HEADER.timestamp,
};
const OPTS = { blockHeader: BLOCK_HEADER };

const hex = (text: string): string => `0x${Buffer.from(text, "utf8").toString("hex")}`;

const MEMO_TEXT = "tron fixed-vector memo";

const OPS_HEX = "02" + "00".repeat(2) + "80" + "00".repeat(28); // TransferContract(1), TriggerSmartContract(31)

const transactions: Array<{
  name: string;
  input: Record<string, unknown> | null;
  rawDataHex: string;
  txId: string;
  signature: string;
}> = [];

const record = async (
  name: string,
  input: Record<string, unknown> | null,
  build: () => Promise<Record<string, any>>,
): Promise<void> => {
  const tx = (await build()) as Record<string, any>;
  const signed = (await tronWeb.trx.sign(tx as never, ANVIL_KEY)) as Record<string, any>;
  const rawDataHex = signed["raw_data_hex"] as string;
  const txId = signed["txID"] as string;
  const signature = (signed["signature"] as string[])[0];
  assert(typeof rawDataHex === "string" && /^[0-9a-f]+$/.test(rawDataHex), `${name} raw_data_hex`);
  assert(typeof txId === "string" && /^[0-9a-f]{64}$/.test(txId), `${name} txID`);
  assert(typeof signature === "string" && /^[0-9a-fA-F]{130}$/.test(signature), `${name} signature`);
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
  let built: Record<string, any> | undefined;
  await record(
    name,
    null,
    async () => {
      built = (await tronWeb.transactionBuilder.triggerSmartContract(
        contractAddress,
        selector,
        { txLocal: true, ...options, blockHeader: BLOCK_HEADER },
        parameters as never,
        OWNER,
      )) as Record<string, any>;
      return built["transaction"] as Record<string, any>;
    },
  );
  // _triggerSmartContractLocal returns { result, transaction }; its raw value.data is the
  // canonical ABI bytes — record them so our builder input reproduces the same calldata.
  const value = (built as Record<string, any>)["transaction"]["raw_data"]["contract"][0][
    "parameter"
  ]["value"] as Record<string, unknown>;
  transactions[transactions.length - 1]!.input = contract(`0x${value["data"] as string}`);
};

await record(
  "trx-transfer",
  {
    header: HEADER,
    contract: { type: "TransferContract", owner: OWNER, to: ALICE, amount: "1000000" },
  },
  () => tronWeb.transactionBuilder.sendTrx(ALICE, 1_000_000, OWNER, OPTS) as never,
);

await record(
  "trx-transfer-memo",
  {
    header: { ...HEADER, memo: hex(MEMO_TEXT) },
    contract: { type: "TransferContract", owner: OWNER, to: BOB, amount: "2000000" },
  },
  async () =>
    tronWeb.transactionBuilder.addUpdateData(
      (await tronWeb.transactionBuilder.sendTrx(BOB, 2_000_000, OWNER, OPTS)) as never,
      MEMO_TEXT,
      "utf8",
      { txLocal: true },
    ) as never,
);

await record(
  "trx-transfer-permission-2",
  {
    header: { ...HEADER, permissionId: 2 },
    contract: { type: "TransferContract", owner: OWNER, to: ALICE, amount: "3000000" },
  },
  () =>
    tronWeb.transactionBuilder.sendTrx(ALICE, 3_000_000, OWNER, {
      ...OPTS,
      permissionId: 2,
    } as never) as never,
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
  () => tronWeb.transactionBuilder.sendToken(ALICE, 500, "1002000", OWNER, OPTS) as never,
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
  () => tronWeb.transactionBuilder.freezeBalanceV2(2_000_000, "ENERGY", OWNER, OPTS) as never,
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
  () => tronWeb.transactionBuilder.freezeBalanceV2(3_000_000, "BANDWIDTH", OWNER, OPTS) as never,
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
  () => tronWeb.transactionBuilder.unfreezeBalanceV2(1_000_000, "ENERGY", OWNER, OPTS) as never,
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
  () =>
    tronWeb.transactionBuilder.delegateResource(
      4_000_000,
      ALICE,
      "ENERGY",
      OWNER,
      false,
      undefined,
      OPTS,
    ) as never,
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
  () =>
    tronWeb.transactionBuilder.delegateResource(
      5_000_000,
      BOB,
      "BANDWIDTH",
      OWNER,
      true,
      28800,
      OPTS,
    ) as never,
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
  () =>
    tronWeb.transactionBuilder.undelegateResource(2_000_000, ALICE, "ENERGY", OWNER, OPTS) as never,
);

await record(
  "withdraw-expire-unfreeze",
  {
    header: HEADER,
    contract: { type: "WithdrawExpireUnfreezeContract", owner: OWNER },
  },
  () => tronWeb.transactionBuilder.withdrawExpireUnfreeze(OWNER, OPTS) as never,
);

await record(
  "cancel-all-unfreeze-v2",
  {
    header: HEADER,
    contract: { type: "CancelAllUnfreezeV2Contract", owner: OWNER },
  },
  () => tronWeb.transactionBuilder.cancelUnfreezeBalanceV2(OWNER, OPTS) as never,
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
  () => tronWeb.transactionBuilder.vote({ [ALICE]: 3, [BOB]: 7 }, OWNER, OPTS) as never,
);

await record(
  "withdraw-balance",
  {
    header: HEADER,
    contract: { type: "WithdrawBalanceContract", owner: OWNER },
  },
  () => tronWeb.transactionBuilder.withdrawBlockRewards(OWNER, OPTS) as never,
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
  () =>
    tronWeb.transactionBuilder.updateAccountPermissions(
      OWNER,
      { type: 0, permission_name: "owner", threshold: 1, id: 2, keys: [{ address: CAROL, weight: 1 }] } as never,
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
      ] as never,
      OPTS,
    ) as never,
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

await record("unsupported-account-update", null, () =>
  tronWeb.transactionBuilder.updateAccount("vector-account", OWNER, OPTS) as never,
);

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
      ],
      derivation,
      keys,
      invalid,
      transactions,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `vectors/chains/tron.json: ${derivation.length} derivation rows, ${keys.length} keys, ` +
    `${invalid.length} invalid, ${transactions.length} transactions. abandon…about: ${derivation
      .filter((r) => r.mnemonic.startsWith("abandon ") && r.mnemonic.endsWith("about"))
      .map((r) => r.address)
      .join(", ")}`,
);
