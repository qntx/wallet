import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
/**
 * Offline replay of the live Classic 1S emulator recording (vectors/onekey/emulator-classic1s.json,
 * produced by scripts/vectors/onekey-emulator.ts against a v3.21.0 debug build): the replay
 * exchange asserts the client writes byte-identical requests and serves the recorded answers.
 */
import { describe, expect, it } from "vite-plus/test";

import { initialize } from "../src/modules/onekey/protocol/device.ts";
import { OneKeyError } from "../src/modules/onekey/protocol/errors.ts";
import { decodeMessage } from "../src/modules/onekey/protocol/frame.ts";
import {
  address,
  evmPublicNode,
  publicNode,
  solanaPublicKey,
} from "../src/modules/onekey/protocol/keys.ts";
import type { DeviceNode } from "../src/modules/onekey/protocol/keys.ts";
import { call } from "../src/modules/onekey/protocol/session.ts";
import type { Exchange } from "../src/modules/onekey/protocol/session.ts";
import { loadVectors } from "./helpers.ts";
import {
  LoadDevice,
  TEST_MNEMONIC,
  replayExchange,
  Success,
  transcriptSession,
} from "./onekey-emulator/index.ts";
import type { Transcript } from "./onekey-emulator/index.ts";

const transcript = loadVectors("onekey/emulator-classic1s.json") as Transcript;
const proTranscript = loadVectors("onekey/emulator-pro.json") as Transcript;

function session(name: string): Exchange {
  return replayExchange(transcriptSession(transcript, name));
}

function proSession(name: string): Exchange {
  return replayExchange(transcriptSession(proTranscript, name));
}

// Independent oracles: vectors/templates/chains.json was produced by the chains package, and the
// node expectations below are re-derived here from the mnemonic with @scure/bip32 / slip10.
const chains = loadVectors("templates/chains.json") as {
  master: { fingerprint: string };
  evm: { accounts: ReadonlyArray<{ groupIndex: number; address: string }> };
  solana: { accounts: ReadonlyArray<{ groupIndex: number; address: string }> };
  tron: { accounts: ReadonlyArray<{ groupIndex: number; address: string }> };
};

const seed = mnemonicToSeedSync(TEST_MNEMONIC);
const master = HDKey.fromMasterSeed(seed);
const slip10 = Slip10.fromMasterSeed(seed);

const H = 0x80_00_00_00;

const u32be = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

function expectNode(node: DeviceNode, path: string): void {
  const expected = master.derive(path);
  if (expected.publicKey === null || expected.chainCode === null) {
    throw new Error("oracle derivation produced no public node");
  }
  expect(node.publicKey).toStrictEqual(expected.publicKey);
  expect(node.chainCode).toStrictEqual(expected.chainCode);
  expect(node.parent).toStrictEqual(u32be(expected.parentFingerprint));
}

async function thrown(fn: () => Promise<unknown>): Promise<OneKeyError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof OneKeyError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("classic1s emulator replay", () => {
  it("fresh device initialize is not-initialized", async () => {
    const error = await thrown(async () => initialize(session("uninitialized")));
    expect(error.code).toBe("not-initialized");
  });

  it("replays LoadDevice with the button confirm round", async () => {
    const success = await call(
      session("load-device"),
      { def: LoadDevice, value: { mnemonics: [TEST_MNEMONIC], label: "OneKey" } },
      Success,
    );
    expect(success.message).toBe("Device loaded");
  });

  it("initialize returns the loaded classic1s DeviceInfo", async () => {
    const info = await initialize(session("initialized"));
    expect(info.model).toBe("classic1s");
    expect(info.firmware).toStrictEqual([3, 21, 0]);
    expect(info.pinProtection).toBe(false);
    expect(info.passphraseProtection).toBe(false);
    expect(info.unlocked).toBe(true);
    expect(info.bitcoinOnly).toBe(false);
    expect(info.deviceId).toBe("0D8A8E040824F2BDC7F7DDE0");
    expect(info.sessionId).toHaveLength(32);
  });

  it("records exactly the sessions the replay asserts", () => {
    expect(transcript.sessions.map((s) => s.name).toSorted()).toStrictEqual(
      [
        "uninitialized",
        "load-device",
        "initialized",
        "node-bip44",
        "node-bip49",
        "node-bip84",
        "node-bip86",
        "node-tron",
        "node-evm",
        "addr-bip84",
        "addr-evm",
        "addr-tron",
        "sol-account0",
        "sol-account1",
      ].toSorted(),
    );
  });

  it.each([
    ["node-bip44", [H + 44, H, H], { scriptType: 0 }, "m/44'/0'/0'"],
    ["node-bip49", [H + 49, H, H], { scriptType: 4 }, "m/49'/0'/0'"],
    ["node-bip84", [H + 84, H, H], { scriptType: 3 }, "m/84'/0'/0'"],
    ["node-bip86", [H + 86, H, H], { scriptType: 5 }, "m/86'/0'/0'"],
    ["node-tron", [H + 44, H + 195, H], undefined, "m/44'/195'/0'"],
  ] as const)("%s returns the derived account node", async (name, path, options, derive) => {
    const node = await publicNode(session(name), path, options);
    expectNode(node, derive);
    expect(node.path).toStrictEqual(path);
    expect(node.rootFingerprint).toStrictEqual(hexToBytes(chains.master.fingerprint));
  });

  it("node-evm returns the derived node with no root fingerprint", async () => {
    const node = await evmPublicNode(session("node-evm"), [H + 44, H + 60, H]);
    expectNode(node, "m/44'/60'/0'");
    expect("rootFingerprint" in node).toBe(false);
  });

  const bip84Receive0 = master.derive("m/84'/0'/0'/0/0").publicKey;
  if (bip84Receive0 === null) {
    throw new Error("oracle derivation produced no public key");
  }
  const evmExpected = chains.evm.accounts[0]?.address;
  if (evmExpected === undefined) {
    throw new Error("chains.json expectation missing");
  }
  const tronExpected = chains.tron.accounts[0]?.address;
  if (tronExpected === undefined) {
    throw new Error("chains.json expectation missing");
  }

  it.each([
    // chains.json covers only testnet bitcoin; the mainnet receive address is derived here.
    [
      "addr-bip84",
      "bitcoin",
      [H + 84, H, H, 0, 0],
      { showDisplay: false, scriptType: 3 },
      p2wpkh(bip84Receive0).address,
    ],
    [
      "addr-evm",
      "evm",
      [H + 44, H + 60, H, 0, 0],
      { showDisplay: false, chainId: 1n },
      evmExpected,
    ],
    ["addr-tron", "tron", [H + 44, H + 195, H, 0, 0], { showDisplay: false }, tronExpected],
  ] as const)("%s returns the published address", async (name, family, path, options, expected) => {
    await expect(address(session(name), family, path, options)).resolves.toBe(expected);
  });

  const solanaExpected = chains.solana.accounts[0]?.address;
  if (solanaExpected === undefined) {
    throw new Error("chains.json expectation missing");
  }
  const solanaDerived0 = slip10.derive("m/44'/501'/0'/0'").publicKey;
  if (solanaDerived0 === null) {
    throw new Error("oracle derivation produced no public key");
  }

  it("sol-account0 returns the pinned ed25519 key", async () => {
    const key = await solanaPublicKey(session("sol-account0"), [H + 44, H + 501, H, H], false);
    expect(key).toStrictEqual(base58.decode(solanaExpected));
    // slip10 carries a leading 0x00 marker byte; the device returns the raw 32-byte key.
    expect(key).toStrictEqual(solanaDerived0.subarray(1));
  });

  const solanaDerived1 = slip10.derive("m/44'/501'/1'/0'").publicKey;
  if (solanaDerived1 === null) {
    throw new Error("oracle derivation produced no public key");
  }

  it("sol-account1 returns the second account key", async () => {
    const key = await solanaPublicKey(session("sol-account1"), [H + 44, H + 501, H + 1, H], false);
    expect(key).toStrictEqual(solanaDerived1.subarray(1));
    expect(bytesToHex(key)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pro emulator replay", () => {
  it("fresh device initialize is not-initialized", async () => {
    const error = await thrown(async () => initialize(proSession("uninitialized")));
    expect(error.code).toBe("not-initialized");
  });

  it("replays LoadDevice with the button confirm round", async () => {
    const success = await call(
      proSession("load-device"),
      { def: LoadDevice, value: { mnemonics: [TEST_MNEMONIC], label: "OneKey" } },
      Success,
    );
    expect(success.message).toBe("Device loaded");
  });

  it("initialize returns the loaded pro DeviceInfo", async () => {
    const info = await initialize(proSession("initialized"));
    expect(info.model).toBe("pro");
    expect(info.firmware).toStrictEqual([4, 21, 0]);
    expect(info.pinProtection).toBe(false);
    expect(info.passphraseProtection).toBe(false);
    expect(info.unlocked).toBe(true);
    expect(info.bitcoinOnly).toBe(false);
    expect(info.deviceId).toBe("EA91F3434198CAFBAC94BB9C");
    expect(info.sessionId).toHaveLength(32);
  });

  it("records exactly the sessions the replay asserts", () => {
    expect(proTranscript.sessions.map((s) => s.name).toSorted()).toStrictEqual(
      [
        "uninitialized",
        "load-device",
        "initialized",
        "node-bip44",
        "node-bip49",
        "node-bip84",
        "node-bip86",
        "node-tron",
        "node-evm",
        "addr-bip84",
        "addr-evm",
        "addr-tron",
        "sol-account0",
        "sol-account1",
        "addr-bip84-show",
        "addr-evm-show",
        "addr-tron-show",
        "sol-account0-show",
      ].toSorted(),
    );
  });

  it.each([
    ["node-bip44", [H + 44, H, H], { scriptType: 0 }, "m/44'/0'/0'"],
    ["node-bip49", [H + 49, H, H], { scriptType: 4 }, "m/49'/0'/0'"],
    ["node-bip84", [H + 84, H, H], { scriptType: 3 }, "m/84'/0'/0'"],
    ["node-bip86", [H + 86, H, H], { scriptType: 5 }, "m/86'/0'/0'"],
    ["node-tron", [H + 44, H + 195, H], undefined, "m/44'/195'/0'"],
  ] as const)("%s returns the derived account node", async (name, path, options, derive) => {
    const node = await publicNode(proSession(name), path, options);
    expectNode(node, derive);
    expect(node.path).toStrictEqual(path);
    expect(node.rootFingerprint).toStrictEqual(hexToBytes(chains.master.fingerprint));
  });

  it("node-evm returns the derived node with no root fingerprint", async () => {
    const node = await evmPublicNode(proSession("node-evm"), [H + 44, H + 60, H]);
    expectNode(node, "m/44'/60'/0'");
    expect("rootFingerprint" in node).toBe(false);
  });

  const bip84Receive0 = master.derive("m/84'/0'/0'/0/0").publicKey;
  if (bip84Receive0 === null) {
    throw new Error("oracle derivation produced no public key");
  }
  const evmExpected = chains.evm.accounts[0]?.address;
  if (evmExpected === undefined) {
    throw new Error("chains.json expectation missing");
  }
  const tronExpected = chains.tron.accounts[0]?.address;
  if (tronExpected === undefined) {
    throw new Error("chains.json expectation missing");
  }

  it.each([
    [
      "addr-bip84",
      "bitcoin",
      [H + 84, H, H, 0, 0],
      { showDisplay: false, scriptType: 3 },
      p2wpkh(bip84Receive0).address,
    ],
    [
      "addr-evm",
      "evm",
      [H + 44, H + 60, H, 0, 0],
      { showDisplay: false, chainId: 1n },
      evmExpected,
    ],
    ["addr-tron", "tron", [H + 44, H + 195, H, 0, 0], { showDisplay: false }, tronExpected],
  ] as const)("%s returns the published address", async (name, family, path, options, expected) => {
    await expect(address(proSession(name), family, path, options)).resolves.toBe(expected);
  });

  const solanaExpected = chains.solana.accounts[0]?.address;
  if (solanaExpected === undefined) {
    throw new Error("chains.json expectation missing");
  }
  const solanaDerived0 = slip10.derive("m/44'/501'/0'/0'").publicKey;
  if (solanaDerived0 === null) {
    throw new Error("oracle derivation produced no public key");
  }

  it("sol-account0 returns the pinned ed25519 key", async () => {
    const key = await solanaPublicKey(proSession("sol-account0"), [H + 44, H + 501, H, H], false);
    expect(key).toStrictEqual(base58.decode(solanaExpected));
    // slip10 carries a leading 0x00 marker byte; the device returns the raw 32-byte key.
    expect(key).toStrictEqual(solanaDerived0.subarray(1));
  });

  const solanaDerived1 = slip10.derive("m/44'/501'/1'/0'").publicKey;
  if (solanaDerived1 === null) {
    throw new Error("oracle derivation produced no public key");
  }

  it("sol-account1 returns the second account key", async () => {
    const key = await solanaPublicKey(
      proSession("sol-account1"),
      [H + 44, H + 501, H + 1, H],
      false,
    );
    expect(key).toStrictEqual(solanaDerived1.subarray(1));
    expect(bytesToHex(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  // Rule 2: a first-use address must be confirmable on the device itself. The show sessions were
  // recorded with showDisplay: true and their type-26 responses prove the device asked; replay
  // asserts each produced at least one ButtonRequest round and the same address as the hidden call.
  const buttonRequests = (name: string): number =>
    transcriptSession(proTranscript, name).exchanges.filter(
      (exchange) => decodeMessage(hexToBytes(exchange.response)).type === 26,
    ).length;

  it.each([
    [
      "addr-bip84-show",
      "bitcoin",
      [H + 84, H, H, 0, 0],
      { showDisplay: true, scriptType: 3 },
      p2wpkh(bip84Receive0).address,
    ],
    [
      "addr-evm-show",
      "evm",
      [H + 44, H + 60, H, 0, 0],
      { showDisplay: true, chainId: 1n },
      evmExpected,
    ],
    ["addr-tron-show", "tron", [H + 44, H + 195, H, 0, 0], { showDisplay: true }, tronExpected],
  ] as const)(
    "%s asked the device and returned the same address",
    async (name, family, path, options, expected) => {
      await expect(address(proSession(name), family, path, options)).resolves.toBe(expected);
      expect(buttonRequests(name)).toBeGreaterThan(0);
    },
  );

  it("sol-account0-show asked the device and returned the same key", async () => {
    const key = await solanaPublicKey(
      proSession("sol-account0-show"),
      [H + 44, H + 501, H, H],
      true,
    );
    expect(key).toStrictEqual(solanaDerived0.subarray(1));
    expect(buttonRequests("sol-account0-show")).toBeGreaterThan(0);
  });
});
