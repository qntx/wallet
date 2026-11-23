/**
 * Speculos case definitions shared by the live suite (`apps.test.ts`, which also records
 * vectors/ledger/*.json) and the unit replay test (`tests/ledger-replay.test.ts`). Keeping the
 * tables here means the replay asserts exactly the calls the device saw.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2pkh, p2sh, p2tr, p2wpkh, Transaction } from "@scure/btc-signer";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { serializeTransaction } from "viem";

import type { BitcoinTemplate } from "@qntx/wallet-chains";
import { verifyBitcoinPsbtSignatures } from "@qntx/wallet-chains/bitcoin";
import type { TypedDataInput } from "@qntx/wallet-chains/evm";

import {
  btcExtendedPublicKey,
  btcMasterFingerprint,
  btcSignMessage,
  btcSignPsbt,
  btcWalletAddress,
} from "../../src/modules/ledger/protocol/bitcoin/index.ts";
import { defaultPolicy } from "../../src/modules/ledger/protocol/bitcoin/policy.ts";
import type { BitcoinPolicy } from "../../src/modules/ledger/protocol/bitcoin/policy.ts";
import { varint } from "../../src/modules/ledger/protocol/bytes.ts";
import { appAndVersion, requireApp } from "../../src/modules/ledger/protocol/device.ts";
import {
  ethAddress,
  ethConfiguration,
  ethSignPersonalMessage,
  ethSignTransaction,
  ethSignTypedData,
} from "../../src/modules/ledger/protocol/ethereum.ts";
import {
  solanaAddress,
  solanaConfiguration,
  solanaSignOffchainMessage,
  solanaSignTransaction,
} from "../../src/modules/ledger/protocol/solana.ts";
import {
  tronAddress,
  tronConfiguration,
  tronSignPersonalMessage,
  tronSignTransaction,
  tronSignTypedDataHash,
} from "../../src/modules/ledger/protocol/tron.ts";
import { appsJson, hex, unhex } from "./record.ts";
import type { CaseDef } from "./record.ts";

export const ETH_PATH: ReadonlyArray<number> = [0x80_00_00_2c, 0x80_00_00_3c, 0x80_00_00_00, 0, 0];
export const SOL_PATH: ReadonlyArray<number> = [
  0x80_00_00_2c, 0x80_00_01_f5, 0x80_00_00_00, 0x80_00_00_00,
];
export const TRX_PATH: ReadonlyArray<number> = [0x80_00_00_2c, 0x80_00_00_c3, 0x80_00_00_00, 0, 0];

const chainsVectors = (file: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../../vectors/chains/${file}`, import.meta.url)),
      "utf8",
    ),
  );

const isTronDoc = (
  value: unknown,
): value is { transactions: Array<{ name: string; rawDataHex: string }> } =>
  typeof value === "object" &&
  value !== null &&
  "transactions" in value &&
  Array.isArray(value.transactions) &&
  value.transactions.every(
    (t: unknown) => typeof t === "object" && t !== null && "rawDataHex" in t && "name" in t,
  );

export const tronVector = (name: string): string => {
  const doc = chainsVectors("tron.json");
  if (!isTronDoc(doc)) {
    throw new Error("vectors/chains/tron.json has no transactions list");
  }
  const hit = doc.transactions.find((t) => t.name === name);
  if (hit === undefined) {
    throw new Error(`tron vector ${name} missing`);
  }
  return hit.rawDataHex;
};

export const MAIL: TypedDataInput = {
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
    from: {
      name: "Cow",
      wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
    },
    to: {
      name: "Bob",
      wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
    },
    contents: "Hello, Bob!",
  },
};

export const COMPLEX: TypedDataInput = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Item: [
      { name: "id", type: "uint256" },
      { name: "delta", type: "int256" },
      { name: "flag", type: "bool" },
      { name: "key", type: "bytes32" },
    ],
    Order: [
      { name: "items", type: "Item[]" },
      { name: "blob", type: "bytes" },
      { name: "note", type: "string" },
      { name: "owner", type: "address" },
    ],
  },
  primaryType: "Order",
  domain: {
    name: "Complex",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  message: {
    items: [
      { id: "7", delta: "-42", flag: true, key: `0x${"11".repeat(32)}` },
      { id: "8", delta: "-1", flag: false, key: `0x${"22".repeat(32)}` },
    ],
    blob: `0x${"ab".repeat(300)}`,
    note: "nested array of structs plus long bytes",
    owner: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
  },
};

/** Legacy tx whose payload length mod 255 falls inside the v‖r‖s tail (< 68 bytes). */
const chunkedLegacy = (): string => {
  for (let dataLen = 0; dataLen < 400; dataLen += 1) {
    const unsigned = serializeTransaction({
      type: "legacy",
      chainId: 1,
      nonce: 0,
      gasPrice: 2_000_000_000n,
      gas: 60_000n,
      to: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
      value: 1n,
      data: `0x${"ab".repeat(dataLen)}`,
    });
    if ((unhex(unsigned.slice(2)).length + 21) % 255 === 30) {
      return unsigned.slice(2);
    }
  }
  throw new Error("no length found");
};

const legacyTx = (data: string): string =>
  serializeTransaction({
    type: "legacy",
    chainId: 1,
    nonce: 0,
    gasPrice: 2_000_000_000n,
    gas: 21_000n,
    to: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
    value: 1_000_000_000_000_000_000n,
    data: `0x${data.slice(2)}`,
  }).slice(2);

const tx1559 = (data: string): string =>
  serializeTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: 1,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gas: 21_000n,
    to: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
    value: 2n,
    data: `0x${data.slice(2)}`,
  }).slice(2);

const tx2930 = (): string =>
  serializeTransaction({
    type: "eip2930",
    chainId: 1,
    nonce: 1,
    gasPrice: 3_000_000_000n,
    gas: 21_000n,
    to: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
    value: 2n,
    data: "0x",
    accessList: [
      {
        address: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
        storageKeys: [`0x${"00".repeat(32)}`],
      },
    ],
  }).slice(2);

const eip7702Tx = (): string =>
  serializeTransaction({
    type: "eip7702",
    chainId: 1,
    nonce: 0,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gas: 21_000n,
    to: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
    value: 0n,
    data: "0x",
    authorizationList: [
      {
        address: "0x4cd241e8d1510e30b2076397afc7508ae59c66c9",
        chainId: 1,
        nonce: 0,
        r: `0x${"11".repeat(32)}`,
        s: `0x${"22".repeat(32)}`,
        yParity: 0,
      },
    ],
  }).slice(2);

const compactU16 = (n: number): number[] => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);

const SYSTEM_PROGRAM = new Uint8Array(32); // 11111111111111111111111111111111

/** Legacy or v0 message: header ‖ compact(accts) ‖ accts ‖ blockhash ‖ compact(instrs) ‖ instrs. */
const solanaMessage = (
  versioned: boolean,
  accounts: Uint8Array[],
  programIdx: number,
  instrAccounts: number[],
  data: number[],
): Uint8Array => {
  const head = [...(versioned ? [0x80] : []), 1, 0, 1];
  const blockhash = new Uint8Array(32).fill(3);
  const instr = [
    programIdx,
    ...compactU16(instrAccounts.length),
    ...instrAccounts,
    ...compactU16(data.length),
    ...data,
  ];
  const tail = versioned ? [0] : []; // address lookup table count
  const out = new Uint8Array(
    head.length + 1 + accounts.length * 32 + 32 + 1 + instr.length + tail.length,
  );
  let o = 0;
  out.set(head, o);
  o += head.length;
  out.set(compactU16(accounts.length), o);
  o += 1;
  for (const a of accounts) {
    out.set(a, o);
    o += 32;
  }
  out.set(blockhash, o);
  o += 32;
  out.set(compactU16(1), o);
  o += 1;
  out.set(instr, o);
  o += instr.length;
  out.set(tail, o);
  return out;
};

/** System transfer of `lamports` from the device signer to a fixed address (clear-signed). */
const solanaTransfer = (signer: Uint8Array, lamports: number, versioned = false): Uint8Array => {
  const data = [2, 0, 0, 0]; // system instruction 2 = Transfer, u32le
  for (let i = 0; i < 8; i += 1) {
    data.push((lamports >> (8 * i)) & 0xff);
  }
  const dest = new Uint8Array(32).fill(5);
  return solanaMessage(versioned, [signer, dest, SYSTEM_PROGRAM], 2, [0, 1], data);
};

/** Instruction on an unrecognized program id → the app requires blind signing. */
const solanaUnknown = (signer: Uint8Array, pad: number): Uint8Array =>
  solanaMessage(
    false,
    [signer, new Uint8Array(32).fill(2)],
    1,
    [],
    Array.from({ length: pad }, () => 7),
  );

/**
 * V0 off-chain message: ff‖"solana offchain" ‖ 00 ‖ appDomain ‖ format ‖ nSigners ‖ keys ‖ u16le ‖
 * body.
 */
const solanaOffchain = (signer: Uint8Array, body: Uint8Array): Uint8Array => {
  const domain = new Uint8Array(16);
  domain[0] = 0xff;
  domain.set(new TextEncoder().encode("solana offchain"), 1);
  const appDomain = keccak_256(new TextEncoder().encode("qntx.speculos"));
  const out = new Uint8Array(16 + 1 + 32 + 1 + 1 + 32 + 2 + body.length);
  let o = 0;
  out.set(domain, o);
  o += 16;
  out[o] = 0;
  o += 1; // version V0
  out.set(appDomain, o);
  o += 32;
  out[o] = 0;
  o += 1; // format RestrictedAscii
  out[o] = 1;
  o += 1;
  out.set(signer, o);
  o += 32;
  out[o] = body.length & 0xff;
  out[o + 1] = body.length >> 8;
  o += 2;
  out.set(body, o);
  return out;
};

const sigResult = (bytes: Uint8Array): string => hex(bytes);

const settle = async (job: Promise<unknown>): Promise<void> => {
  try {
    await job;
  } catch {
    // the loser may still reject after Promise.all decided — mark it handled
  }
};

/**
 * Runs an APDU job and its screen navigation concurrently; the first failure wins. The loser is
 * always awaited so a still-pressing navigation cannot bleed button events into the next case.
 */
const drive = async <T>(job: Promise<T>, nav: Promise<void>): Promise<T> => {
  try {
    const [out] = await Promise.all([job, nav]);
    return out;
  } finally {
    await settle(nav);
  }
};

/**
 * Nano S Plus blind-signing interstitial: "Blind signing ahead — To accept risk, press both
 * buttons" (src/nbgl/ui_blind_signing.c); confirm it and keep navigating to the real finish page.
 */
const BLIND = /blind signing ahead|press both buttons/i;

/** App home/menu screens — navigation must not press buttons until the review has left these. */
const MENU = /app is ready|app settings|app info|quit app/i;
const addrResult = (r: { publicKey: Uint8Array; address: string }): unknown => ({
  publicKey: hex(r.publicKey),
  address: r.address,
});

export const ETHEREUM_CASES: CaseDef[] = [
  {
    name: "app-and-version",
    call: { fn: "device" },
    run: async (ex) => {
      const info = await appAndVersion(ex);
      requireApp(info, "ethereum");
      return { name: info.name, version: info.version, flags: hex(info.flags) };
    },
  },
  {
    name: "address",
    call: { fn: "ethAddress", path: ETH_PATH, display: false },
    run: async (ex) => addrResult(await ethAddress(ex, ETH_PATH, false)),
  },
  {
    name: "address-display",
    call: { fn: "ethAddress", path: ETH_PATH, display: true },
    run: async (ex, screen) => {
      const out = await drive(
        ethAddress(ex, ETH_PATH, true),
        screen.approve(/confirm|approve/i, { maxSteps: 20, leave: MENU }),
      );
      return addrResult(out);
    },
  },
  {
    name: "tx-legacy",
    call: { fn: "ethSignTransaction", path: ETH_PATH, unsigned: legacyTx("0x") },
    run: async (ex, screen) => {
      const out = await drive(
        ethSignTransaction(ex, ETH_PATH, unhex(legacyTx("0x"))),
        screen.approve(/accept|sign transaction/i, { maxSteps: 40, through: BLIND, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tx-legacy-chunked",
    setting: { label: "Blind signing", enabled: true },
    call: { fn: "ethSignTransaction", path: ETH_PATH, unsigned: chunkedLegacy() },
    run: async (ex, screen) => {
      const raw = chunkedLegacy();
      const out = await drive(
        ethSignTransaction(ex, ETH_PATH, unhex(raw)),
        screen.approve(/accept|sign transaction|sign typed message|sign message/i, {
          maxSteps: 60,
          through: BLIND,
          leave: MENU,
        }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tx-eip2930",
    call: { fn: "ethSignTransaction", path: ETH_PATH, unsigned: tx2930() },
    run: async (ex, screen) => {
      const out = await drive(
        ethSignTransaction(ex, ETH_PATH, unhex(tx2930())),
        screen.approve(/accept|sign transaction|sign typed message|sign message/i, {
          maxSteps: 60,
          through: BLIND,
          leave: MENU,
        }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tx-eip1559",
    call: { fn: "ethSignTransaction", path: ETH_PATH, unsigned: tx1559("0x") },
    run: async (ex, screen) => {
      const out = await drive(
        ethSignTransaction(ex, ETH_PATH, unhex(tx1559("0x"))),
        screen.approve(/accept|sign transaction/i, { maxSteps: 40, through: BLIND, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tx-eip1559-calldata-blind-off",
    setting: { label: "Blind signing", enabled: false },
    mayKillEmulator: true,
    call: {
      fn: "ethSignTransaction",
      path: ETH_PATH,
      unsigned: tx1559("0x600162000760"),
    },
    run: async (ex) =>
      sigResult(await ethSignTransaction(ex, ETH_PATH, unhex(tx1559("0x600162000760")))),
  },
  {
    name: "tx-eip1559-calldata-blind-on",
    setting: { label: "Blind signing", enabled: true },
    call: {
      fn: "ethSignTransaction",
      path: ETH_PATH,
      unsigned: tx1559("0x600162000760"),
    },
    run: async (ex, screen) => {
      const out = await drive(
        ethSignTransaction(ex, ETH_PATH, unhex(tx1559("0x600162000760"))),
        screen.approve(/accept|sign transaction|sign typed message|sign message/i, {
          maxSteps: 60,
          through: BLIND,
          leave: MENU,
        }),
      );
      return sigResult(out);
    },
  },
  {
    // EIP7702_SUPPORT defaults to 0 in the pinned build (makefile_conf/features.mk), so the type-4
    // transaction is rejected during parsing — before any review UI is shown.
    name: "tx-eip7702",
    mayKillEmulator: true,
    call: { fn: "ethSignTransaction", path: ETH_PATH, unsigned: eip7702Tx() },
    run: async (ex) => sigResult(await ethSignTransaction(ex, ETH_PATH, unhex(eip7702Tx()))),
  },
  {
    name: "personal-short",
    call: {
      fn: "ethSignPersonalMessage",
      path: ETH_PATH,
      message: hex(new TextEncoder().encode("hello world")),
    },
    run: async (ex, screen) => {
      const message = new TextEncoder().encode("hello world");
      const out = await drive(
        ethSignPersonalMessage(ex, ETH_PATH, message),
        screen.approve(/sign message/i, { maxSteps: 30, through: BLIND, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "personal-long",
    call: {
      fn: "ethSignPersonalMessage",
      path: ETH_PATH,
      message: hex(new Uint8Array(300).map((_, i) => i & 0xff)),
    },
    run: async (ex, screen) => {
      const message = new Uint8Array(300).map((_, i) => i & 0xff);
      const out = await drive(
        ethSignPersonalMessage(ex, ETH_PATH, message),
        screen.approve(/sign message/i, { maxSteps: 60, through: BLIND, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "eip712-mail",
    setting: { label: "Blind signing", enabled: true },
    call: { fn: "ethSignTypedData", path: ETH_PATH, typedData: MAIL },
    run: async (ex, screen) => {
      const out = await drive(
        ethSignTypedData(ex, ETH_PATH, MAIL),
        screen.approve(/accept|sign transaction|sign typed message|sign message/i, {
          maxSteps: 60,
          through: BLIND,
          leave: MENU,
        }),
      );
      return sigResult(out);
    },
  },
  {
    name: "eip712-complex",
    setting: { label: "Blind signing", enabled: true },
    call: { fn: "ethSignTypedData", path: ETH_PATH, typedData: COMPLEX },
    run: async (ex, screen) => {
      const out = await drive(
        ethSignTypedData(ex, ETH_PATH, COMPLEX),
        screen.approve(/accept|sign transaction|sign typed message|sign message/i, {
          maxSteps: 80,
          through: BLIND,
          leave: MENU,
        }),
      );
      return sigResult(out);
    },
  },
  {
    name: "eip712-blind-off",
    setting: { label: "Blind signing", enabled: false },
    mayKillEmulator: true,
    call: { fn: "ethSignTypedData", path: ETH_PATH, typedData: MAIL },
    run: async (ex) => sigResult(await ethSignTypedData(ex, ETH_PATH, MAIL)),
  },
  {
    name: "reject-personal",
    setting: { label: "Blind signing", enabled: false },
    call: {
      fn: "ethSignPersonalMessage",
      path: ETH_PATH,
      message: hex(new TextEncoder().encode("do not sign")),
    },
    run: async (ex, screen) => {
      const out = await drive(
        ethSignPersonalMessage(ex, ETH_PATH, new TextEncoder().encode("do not sign")),
        screen.reject(/^reject/i, { maxSteps: 30, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "configuration",
    call: { fn: "ethConfiguration" },
    run: async (ex) => ethConfiguration(ex),
  },
];

export const SOLANA_CASES: CaseDef[] = [
  {
    name: "app-and-version",
    call: { fn: "device" },
    run: async (ex) => {
      const info = await appAndVersion(ex);
      requireApp(info, "solana");
      return { name: info.name, version: info.version, flags: hex(info.flags) };
    },
  },
  {
    name: "address",
    call: { fn: "solanaAddress", path: SOL_PATH, display: false },
    run: async (ex) => hex(await solanaAddress(ex, SOL_PATH, false)),
  },
  {
    name: "address-display",
    call: { fn: "solanaAddress", path: SOL_PATH, display: true },
    run: async (ex, screen) => {
      const out = await drive(
        solanaAddress(ex, SOL_PATH, true),
        screen.approve(/confirm|approve/i, { maxSteps: 20, leave: MENU }),
      );
      return hex(out);
    },
  },
  {
    name: "tx-legacy",
    call: { fn: "solanaSignTransaction", path: SOL_PATH },
    run: async (ex, screen, def) => {
      const message = solanaTransfer(await solanaAddress(ex, SOL_PATH, false), 1000);
      def.call["message"] = hex(message);
      const out = await drive(
        solanaSignTransaction(ex, SOL_PATH, message),
        screen.approve(/accept|sign transaction|sign message/i, { maxSteps: 40, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tx-v0",
    call: { fn: "solanaSignTransaction", path: SOL_PATH },
    run: async (ex, screen, def) => {
      const message = solanaTransfer(await solanaAddress(ex, SOL_PATH, false), 2000, true);
      def.call["message"] = hex(message);
      const out = await drive(
        solanaSignTransaction(ex, SOL_PATH, message),
        screen.approve(/accept|sign transaction|sign message/i, { maxSteps: 40, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tx-unknown-blind-off",
    setting: { label: "Blind signing", enabled: false },
    call: { fn: "solanaSignTransaction", path: SOL_PATH },
    run: async (ex, _screen, def) => {
      const message = solanaUnknown(await solanaAddress(ex, SOL_PATH, false), 4);
      def.call["message"] = hex(message);
      return sigResult(await solanaSignTransaction(ex, SOL_PATH, message));
    },
  },
  {
    name: "tx-unknown-blind-on",
    setting: { label: "Blind signing", enabled: true },
    call: { fn: "solanaSignTransaction", path: SOL_PATH },
    run: async (ex, screen, def) => {
      const message = solanaUnknown(await solanaAddress(ex, SOL_PATH, false), 4);
      def.call["message"] = hex(message);
      const out = await drive(
        solanaSignTransaction(ex, SOL_PATH, message),
        screen.approve(/accept|sign transaction|sign message/i, {
          maxSteps: 40,
          through: BLIND,
          leave: MENU,
        }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tx-big",
    setting: { label: "Blind signing", enabled: true },
    call: { fn: "solanaSignTransaction", path: SOL_PATH },
    run: async (ex, screen, def) => {
      const message = solanaUnknown(await solanaAddress(ex, SOL_PATH, false), 300);
      def.call["message"] = hex(message);
      const out = await drive(
        solanaSignTransaction(ex, SOL_PATH, message),
        screen.approve(/accept|sign transaction|sign message/i, {
          maxSteps: 50,
          through: BLIND,
          leave: MENU,
        }),
      );
      return sigResult(out);
    },
  },
  {
    name: "offchain",
    call: { fn: "solanaSignOffchainMessage", path: SOL_PATH, body: "Hello Ledger!" },
    run: async (ex, screen, def) => {
      const signer = await solanaAddress(ex, SOL_PATH, false);
      const message = solanaOffchain(signer, new TextEncoder().encode("Hello Ledger!"));
      def.call["message"] = hex(message);
      const out = await drive(
        solanaSignOffchainMessage(ex, SOL_PATH, message),
        screen.approve(/accept|sign transaction|sign message/i, { maxSteps: 40, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "reject",
    call: { fn: "solanaSignTransaction", path: SOL_PATH },
    run: async (ex, screen, def) => {
      const message = solanaTransfer(await solanaAddress(ex, SOL_PATH, false), 1000);
      def.call["message"] = hex(message);
      const out = await drive(
        solanaSignTransaction(ex, SOL_PATH, message),
        screen.reject(/reject/i, { maxSteps: 40, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "configuration",
    call: { fn: "solanaConfiguration" },
    run: async (ex) => solanaConfiguration(ex),
  },
];

export const TRON_CASES: CaseDef[] = [
  {
    name: "app-and-version",
    call: { fn: "device" },
    run: async (ex) => {
      const info = await appAndVersion(ex);
      requireApp(info, "tron");
      return { name: info.name, version: info.version, flags: hex(info.flags) };
    },
  },
  {
    name: "address",
    call: { fn: "tronAddress", path: TRX_PATH, display: false },
    run: async (ex) => addrResult(await tronAddress(ex, TRX_PATH, false)),
  },
  {
    name: "address-display",
    call: { fn: "tronAddress", path: TRX_PATH, display: true },
    run: async (ex, screen) => {
      const out = await drive(
        tronAddress(ex, TRX_PATH, true),
        screen.approve(/confirm|approve/i, { maxSteps: 20, leave: MENU }),
      );
      return addrResult(out);
    },
  },
  {
    name: "tx-transfer",
    call: { fn: "tronSignTransaction", path: TRX_PATH, rawData: tronVector("trx-transfer") },
    run: async (ex, screen) => {
      const out = await drive(
        tronSignTransaction(ex, TRX_PATH, unhex(tronVector("trx-transfer"))),
        screen.approve(/^sign transaction/i, { maxSteps: 40, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tx-trc20",
    call: { fn: "tronSignTransaction", path: TRX_PATH, rawData: tronVector("trc20-transfer") },
    run: async (ex, screen) => {
      const out = await drive(
        tronSignTransaction(ex, TRX_PATH, unhex(tronVector("trc20-transfer"))),
        screen.approve(/^sign transaction|accept/i, { maxSteps: 50, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tx-big",
    call: {
      fn: "tronSignTransaction",
      path: TRX_PATH,
      rawData: tronVector("trc20-approve-unlimited"),
    },
    run: async (ex, screen) => {
      const out = await drive(
        tronSignTransaction(ex, TRX_PATH, unhex(tronVector("trc20-approve-unlimited"))),
        screen.approve(/^sign transaction|accept/i, { maxSteps: 60, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "personal-short",
    setting: { label: "Blind signing", enabled: true },
    call: {
      fn: "tronSignPersonalMessage",
      path: TRX_PATH,
      message: hex(new TextEncoder().encode("hello tron")),
    },
    run: async (ex, screen) => {
      const out = await drive(
        tronSignPersonalMessage(ex, TRX_PATH, new TextEncoder().encode("hello tron")),
        screen.approve(/^sign message/i, { maxSteps: 30, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "personal-long",
    call: {
      fn: "tronSignPersonalMessage",
      path: TRX_PATH,
      message: hex(new Uint8Array(300).map((_, i) => i & 0xff)),
    },
    run: async (ex, screen) => {
      const out = await drive(
        tronSignPersonalMessage(
          ex,
          TRX_PATH,
          new Uint8Array(300).map((_, i) => i & 0xff),
        ),
        screen.approve(/^sign message/i, { maxSteps: 60, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "tip712-hash-off",
    setting: { label: "Blind signing", enabled: false },
    call: {
      fn: "tronSignTypedDataHash",
      path: TRX_PATH,
      domainHash: "11".repeat(32),
      messageHash: "22".repeat(32),
    },
    run: async (ex) =>
      sigResult(
        await tronSignTypedDataHash(ex, TRX_PATH, unhex("11".repeat(32)), unhex("22".repeat(32))),
      ),
  },
  {
    name: "tip712-hash-on",
    setting: { label: "Blind signing", enabled: true },
    call: {
      fn: "tronSignTypedDataHash",
      path: TRX_PATH,
      domainHash: "11".repeat(32),
      messageHash: "22".repeat(32),
    },
    run: async (ex, screen) => {
      const out = await drive(
        tronSignTypedDataHash(ex, TRX_PATH, unhex("11".repeat(32)), unhex("22".repeat(32))),
        screen.approve(/^sign message/i, { maxSteps: 40, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "reject",
    setting: { label: "Blind signing", enabled: true },
    call: {
      fn: "tronSignPersonalMessage",
      path: TRX_PATH,
      message: hex(new TextEncoder().encode("reject me")),
    },
    run: async (ex, screen) => {
      const out = await drive(
        tronSignPersonalMessage(ex, TRX_PATH, new TextEncoder().encode("reject me")),
        screen.reject(/reject/i, { maxSteps: 30, leave: MENU }),
      );
      return sigResult(out);
    },
  },
  {
    name: "configuration",
    call: { fn: "tronConfiguration" },
    run: async (ex) => tronConfiguration(ex),
  },
];

const H32 = 0x80_00_00_00;
const BTC_SEED = mnemonicToSeedSync(appsJson().seed);
const BTC_ROOT = HDKey.fromMasterSeed(BTC_SEED);

/** `m/p'/0'/0'` — the account paths the default policies bind to. */
const btcAcct = (purpose: number): ReadonlyArray<number> => [H32 + purpose, H32, H32];
const pathStr = (path: ReadonlyArray<number>): string =>
  `m/${path.map((s) => (s >= H32 ? `${String(s - H32)}'` : String(s))).join("/")}`;
const btcNode = (path: ReadonlyArray<number>): HDKey => BTC_ROOT.derive(pathStr(path));
const pubOf = (path: ReadonlyArray<number>): Uint8Array => {
  const pub = btcNode(path).publicKey;
  if (!(pub instanceof Uint8Array)) {
    throw new TypeError("derive failed");
  }
  return pub;
};
const fprNum = (fpr: Uint8Array): number => new DataView(fpr.buffer, fpr.byteOffset).getUint32(0);

const TEMPLATE_PURPOSE = {
  pkh: { purpose: 44, template: "btc.bip44" },
  "sh-wpkh": { purpose: 49, template: "btc.bip49" },
  wpkh: { purpose: 84, template: "btc.bip84" },
  tr: { purpose: 86, template: "btc.bip86" },
} as const satisfies Record<string, { purpose: number; template: BitcoinTemplate }>;

const btcPolicy = (kind: keyof typeof TEMPLATE_PURPOSE, fpr: Uint8Array): BitcoinPolicy => {
  const spec = TEMPLATE_PURPOSE[kind];
  const acct = btcAcct(spec.purpose);
  return defaultPolicy(spec.template, fpr, acct, btcNode(acct).publicExtendedKey);
};

const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93"; // genesis-hash CAIP-2 (networks.ts)
const TXID = "11".repeat(32); // arbitrary prevout — only the P2PKH case needs a real prev tx
const EXT_ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"; // BIP-173 example (valid)

type InSpec = { kind: keyof typeof TEMPLATE_PURPOSE; change: 0 | 1; index: number };

/** One input owned by the `kind` policy at `change`/`index`, with full derivation info. */
const inputFor = (spec: InSpec, amount: bigint, fpr: Uint8Array): Record<string, unknown> => {
  const { purpose } = TEMPLATE_PURPOSE[spec.kind];
  const path = [...btcAcct(purpose), spec.change, spec.index];
  const pub = pubOf(path);
  const fp = fprNum(fpr);
  if (spec.kind === "tr") {
    const xonly = pub.slice(1);
    return {
      txid: TXID,
      index: 0,
      witnessUtxo: { script: p2tr(xonly).script, amount },
      tapInternalKey: xonly,
      tapBip32Derivation: [[xonly, { hashes: [], der: { fingerprint: fp, path } }]],
    };
  }
  const inner = p2wpkh(pub);
  if (spec.kind === "sh-wpkh") {
    return {
      txid: TXID,
      index: 0,
      witnessUtxo: { script: p2sh(inner).script, amount },
      redeemScript: inner.script,
      bip32Derivation: [[pub, { fingerprint: fp, path }]],
    };
  }
  if (spec.kind === "wpkh") {
    return {
      txid: TXID,
      index: 0,
      witnessUtxo: { script: inner.script, amount },
      bip32Derivation: [[pub, { fingerprint: fp, path }]],
    };
  }
  const fund = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
  fund.addInput({ txid: TXID, index: 0 });
  fund.addOutput({ script: p2pkh(pub).script, amount });
  return {
    txid: fund.id,
    index: 0,
    nonWitnessUtxo: fund.toBytes(),
    bip32Derivation: [[pub, { fingerprint: fp, path }]],
  };
};

/** The change output of `kind` at 1/`index`, carrying derivation info the wallet recognizes. */
const changeOut = (
  kind: keyof typeof TEMPLATE_PURPOSE,
  index: number,
  amount: bigint,
  fpr: Uint8Array,
): Record<string, unknown> => {
  const { purpose } = TEMPLATE_PURPOSE[kind];
  const path = [...btcAcct(purpose), 1, index];
  const pub = pubOf(path);
  const fp = fprNum(fpr);
  if (kind === "tr") {
    const xonly = pub.slice(1);
    return {
      script: p2tr(xonly).script,
      amount,
      tapInternalKey: xonly,
      tapBip32Derivation: [[xonly, { hashes: [], der: { fingerprint: fp, path } }]],
    };
  }
  const script =
    kind === "pkh"
      ? p2pkh(pub).script
      : kind === "sh-wpkh"
        ? p2sh(p2wpkh(pub)).script
        : p2wpkh(pub).script;
  return { script, amount, bip32Derivation: [[pub, { fingerprint: fp, path }]] };
};

/** `inputs` spend to EXT_ADDR with an optional owned change output; returns PSBTv2 bytes. */
const btcPsbt = (
  kind: keyof typeof TEMPLATE_PURPOSE,
  inputs: InSpec[],
  amount: bigint,
  fpr: Uint8Array,
  withChange: boolean,
): Uint8Array => {
  const tx = new Transaction({
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
  const total = BigInt(inputs.length) * amount;
  const spend = (total * 2n) / 3n;
  for (const spec of inputs) {
    tx.addInput(inputFor(spec, amount, fpr));
  }
  tx.addOutputAddress(EXT_ADDR, spend);
  if (withChange) {
    tx.addOutput(changeOut(kind, 0, total - spend, fpr));
  }
  return tx.toPSBT(2);
};

/** Sign-psbt shared body: fetch fpr, build policy+psbt, record both on def.call, sign (with UI). */
const signPsbt = async (
  ex: Parameters<CaseDef["run"]>[0],
  screen: Parameters<CaseDef["run"]>[1],
  def: CaseDef,
  kind: keyof typeof TEMPLATE_PURPOSE,
  inputs: InSpec[],
  withChange: boolean,
): Promise<unknown> => {
  const fpr = await btcMasterFingerprint(ex);
  const policy = btcPolicy(kind, fpr);
  const psbt = btcPsbt(kind, inputs, 100_000n, fpr, withChange);
  def.call["policy"] = policy;
  def.call["psbt"] = hex(psbt);
  const out = await drive(
    btcSignPsbt(ex, psbt, policy),
    screen.approve(/^sign transaction$/i, {
      maxSteps: 80,
      through: /continue anyway/i,
      leave: MENU,
    }),
  );
  if (out.length !== inputs.length) {
    throw new Error("the device did not yield a signature for every input");
  }
  // Signature oracle: place each yield into the PSBT — ECDSA yields are the derivation pubkey
  // with a partialSig, taproot key-path yields go to the keyless tapKeySig — then verify against
  // the account xpub (BIP-143/legacy/taproot sighashes via verifyBitcoinPsbtSignatures) and make
  // sure the PSBT finalizes and extracts.
  const signed = Transaction.fromPSBT(psbt, {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
  for (const y of out) {
    if (y.publicKey.length === 32) {
      signed.updateInput(y.input, { tapKeySig: y.signature });
    } else {
      signed.updateInput(y.input, { partialSig: [[y.publicKey, y.signature]] });
    }
  }
  if (
    !verifyBitcoinPsbtSignatures(
      signed.toPSBT(2),
      out.map((y) => y.input),
      btcNode(btcAcct(TEMPLATE_PURPOSE[kind].purpose)).publicExtendedKey,
      TEMPLATE_PURPOSE[kind].template,
      BTC_MAINNET,
    )
  ) {
    throw new Error("a yielded signature does not verify");
  }
  signed.finalize();
  signed.extract();
  return out.map((y) => ({
    input: y.input,
    publicKey: hex(y.publicKey),
    signature: hex(y.signature),
  }));
};

/**
 * BIP-137 (bitcoin/bitcoin src/util/message.cpp MessageHash): the device signs the double-SHA256 of
 * `"\x18Bitcoin Signed Message:\n" ‖ varint(len) ‖ message` — 0x18 is the compactsize length of the
 * prefix string — and returns `header ‖ compact r‖s` with header = 27 + recid (+4 for a compressed
 * key, the range 31..34 the pinned app produces).
 */
const MSG_PREFIX = new TextEncoder().encode("\u0018Bitcoin Signed Message:\n");
const btcMessageHash = (message: Uint8Array): Uint8Array => {
  const len = varint(message.length);
  const preimage = new Uint8Array(MSG_PREFIX.length + len.length + message.length);
  preimage.set(MSG_PREFIX);
  preimage.set(len, MSG_PREFIX.length);
  preimage.set(message, MSG_PREFIX.length + len.length);
  return sha256(sha256(preimage));
};

/** Recover the signing key from the compact signature and compare it to the seed key at `path`. */
const checkMessageSignature = (
  header: number,
  signature: Uint8Array,
  message: Uint8Array,
  path: ReadonlyArray<number>,
): void => {
  const recovered = secp256k1.recoverPublicKey(
    Uint8Array.of((header - 27) % 4, ...signature),
    btcMessageHash(message),
    { prehash: false },
  );
  const pub = secp256k1.Point.fromBytes(recovered).toBytes(true);
  if (!equalBytes(pub, pubOf(path))) {
    throw new Error("the message signature recovers a different key");
  }
};

const MSG_PATH: ReadonlyArray<number> = [...btcAcct(44), 0, 0];

export const BITCOIN_CASES: CaseDef[] = [
  {
    name: "app-and-version",
    call: { fn: "device" },
    run: async (ex) => {
      const info = await appAndVersion(ex);
      requireApp(info, "bitcoin");
      return { name: info.name, version: info.version, flags: hex(info.flags) };
    },
  },
  {
    name: "fingerprint",
    call: { fn: "btcMasterFingerprint" },
    run: async (ex) => {
      const fpr = await btcMasterFingerprint(ex);
      if (fprNum(fpr) !== BTC_ROOT.fingerprint) {
        throw new Error("device fingerprint differs from the seed");
      }
      return hex(fpr);
    },
  },
  {
    name: "xpub",
    call: { fn: "btcExtendedPublicKey", path: btcAcct(84), display: false },
    run: async (ex) => {
      const xpub = await btcExtendedPublicKey(ex, btcAcct(84), false);
      if (xpub !== btcNode(btcAcct(84)).publicExtendedKey) {
        throw new Error("xpub mismatch");
      }
      return xpub;
    },
  },
  {
    name: "xpub-display",
    call: { fn: "btcExtendedPublicKey", path: btcAcct(84), display: true },
    run: async (ex, screen) => {
      const xpub = await drive(
        btcExtendedPublicKey(ex, btcAcct(84), true),
        screen.approve(/approve/i, { maxSteps: 30, leave: MENU }),
      );
      if (xpub !== btcNode(btcAcct(84)).publicExtendedKey) {
        throw new Error("xpub mismatch");
      }
      return xpub;
    },
  },
  {
    // m/0' fails is_path_safe_for_pubkey_export (get_extended_pubkey.c) → SW_NOT_SUPPORTED, no UI.
    name: "xpub-nonstandard",
    call: { fn: "btcExtendedPublicKey", path: [H32], display: false },
    run: async (ex) => btcExtendedPublicKey(ex, [H32], false),
  },
  ...(["pkh", "sh-wpkh", "wpkh", "tr"] as const).map((kind): CaseDef => {
    const index = kind === "wpkh" ? 5 : 3;
    const change = kind === "tr" ? 1 : 0;
    return {
      name: `addr-${kind}`,
      call: { fn: "btcWalletAddress", kind, change, index, display: false },
      run: async (ex, _screen, def) => {
        const fpr = await btcMasterFingerprint(ex);
        const policy = btcPolicy(kind, fpr);
        def.call["policy"] = policy;
        return btcWalletAddress(ex, policy, change, index, false);
      },
    };
  }),
  {
    name: "addr-display",
    call: { fn: "btcWalletAddress", kind: "wpkh", change: 0, index: 2, display: true },
    run: async (ex, screen, def) => {
      const fpr = await btcMasterFingerprint(ex);
      const policy = btcPolicy("wpkh", fpr);
      def.call["policy"] = policy;
      return drive(
        btcWalletAddress(ex, policy, 0, 2, true),
        screen.approve(/approve|confirm/i, { maxSteps: 30, leave: MENU }),
      );
    },
  },
  {
    name: "sign-psbt-wpkh",
    call: { fn: "btcSignPsbt", kind: "wpkh" },
    run: async (ex, screen, def) =>
      signPsbt(ex, screen, def, "wpkh", [{ kind: "wpkh", change: 0, index: 0 }], true),
  },
  {
    name: "sign-psbt-tr",
    call: { fn: "btcSignPsbt", kind: "tr" },
    volatileSignature: true,
    run: async (ex, screen, def) =>
      signPsbt(ex, screen, def, "tr", [{ kind: "tr", change: 0, index: 0 }], true),
  },
  {
    name: "sign-psbt-sh-wpkh",
    call: { fn: "btcSignPsbt", kind: "sh-wpkh" },
    run: async (ex, screen, def) =>
      signPsbt(ex, screen, def, "sh-wpkh", [{ kind: "sh-wpkh", change: 0, index: 0 }], true),
  },
  {
    name: "sign-psbt-pkh",
    call: { fn: "btcSignPsbt", kind: "pkh" },
    run: async (ex, screen, def) =>
      signPsbt(ex, screen, def, "pkh", [{ kind: "pkh", change: 0, index: 0 }], true),
  },
  {
    name: "sign-psbt-wpkh-2in",
    call: { fn: "btcSignPsbt", kind: "wpkh" },
    run: async (ex, screen, def) =>
      signPsbt(
        ex,
        screen,
        def,
        "wpkh",
        [
          { kind: "wpkh", change: 0, index: 0 },
          { kind: "wpkh", change: 0, index: 1 },
        ],
        true,
      ),
  },
  {
    name: "sign-psbt-8in",
    call: { fn: "btcSignPsbt", kind: "wpkh" },
    run: async (ex, screen, def) =>
      signPsbt(
        ex,
        screen,
        def,
        "wpkh",
        Array.from({ length: 8 }, (_, i) => ({ kind: "wpkh", change: 0, index: i })),
        true,
      ),
  },
  {
    name: "sign-psbt-rejected",
    call: { fn: "btcSignPsbt", kind: "wpkh" },
    run: async (ex, screen, def) => {
      const fpr = await btcMasterFingerprint(ex);
      const policy = btcPolicy("wpkh", fpr);
      const psbt = btcPsbt("wpkh", [{ kind: "wpkh", change: 0, index: 0 }], 100_000n, fpr, true);
      def.call["policy"] = policy;
      def.call["psbt"] = hex(psbt);
      const job = btcSignPsbt(ex, psbt, policy);
      // oxlint-disable-next-line promise/prefer-await-to-then -- the rejection lands on the returned promise below
      void job.catch(() => undefined);
      await screen.reject(/back to safety|reject/i, { maxSteps: 80, leave: MENU });
      return job;
    },
  },
  {
    name: "sign-message",
    call: { fn: "btcSignMessage", path: MSG_PATH },
    run: async (ex, screen, def) => {
      const msg = new TextEncoder().encode("Hello Ledger Bitcoin!");
      def.call["message"] = hex(msg);
      const out = await drive(
        btcSignMessage(ex, MSG_PATH, msg),
        screen.approve(/^sign message/i, { maxSteps: 30, leave: MENU }),
      );
      checkMessageSignature(out.header, out.signature, msg, MSG_PATH);
      return { header: out.header, signature: hex(out.signature) };
    },
  },
  {
    name: "sign-message-binary",
    call: { fn: "btcSignMessage", path: MSG_PATH },
    run: async (ex, screen, def) => {
      const msg = Uint8Array.from({ length: 200 }, (_, i) => (i * 37 + 11) & 0xff);
      def.call["message"] = hex(msg);
      const out = await drive(
        btcSignMessage(ex, MSG_PATH, msg),
        screen.approve(/^sign message/i, { maxSteps: 40, leave: MENU }),
      );
      checkMessageSignature(out.header, out.signature, msg, MSG_PATH);
      return { header: out.header, signature: hex(out.signature) };
    },
  },
];
