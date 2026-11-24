import { ed25519 } from "@noble/curves/ed25519.js";
/**
 * Hardware signing end to end: `hardware.begin`/`step` drive the fake device through the same
 * prepare→prompt→stage→assemble pipeline `chain.sign` runs, so every family's artefact is
 * byte-identical to the software wallet's on the same seed (schnorr aux-randomness aside — that one
 * is verified, not compared). The hostile cases — a wrong key, a flipped bit, a wrong count, a
 * wrong length — are all refused at assemble; an unsupported display refuses before the
 * verification prompt exists.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2pkh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinNetwork, verifyBitcoinPsbtSignatures } from "@qntx/wallet-chains/bitcoin";
import { EVM_DELEGATOR, normalizeEvm } from "@qntx/wallet-chains/evm";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { ONEKEY_DRIVER } from "../src/modules/signers/onekey/driver.ts";
import { devicePromptLine } from "../src/modules/signers/prompt.ts";
import { promptFits, PROMPT_BOUNDS } from "../src/prompts.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";
import { fakeDevice } from "./signers-fake.ts";
import type { FakeDeviceOptions } from "./signers-fake.ts";

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
const BAD_PASSKEY = (): unknown => ({
  kind: "passkey",
  credentialId: new Uint8Array(CREDENTIAL_ID),
  prf: new Uint8Array(32).fill(0x51),
});

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

const opens = (calls: ReadonlyArray<KeystoreCall>) =>
  calls.flatMap((call) => (call.op === "open" && call.prompt !== undefined ? [call.prompt] : []));

type Boot = {
  readonly h: Harness;
  readonly session: string;
  /** The software wallet on the same seed — the local-signing oracle. */
  readonly walletId: string;
  /** The paired hardware wallet id. */
  readonly hwId: string;
};

const boot = async (
  opts?: FakeDeviceOptions,
): Promise<Boot & { device: ReturnType<typeof fakeDevice> }> => {
  const device = fakeDevice(SEED, opts);
  const h = createHarness({
    drivers: { keystone: device.driver, ledger: device.driver, onekey: ONEKEY_DRIVER },
  });
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
    await h.call("hardware.begin", { op: { kind: "pair", device: "keystone" } }, session),
  );
  const done = ok(
    await h.call(
      "hardware.step",
      {
        opId: strField(begin, "opId"),
        response: { kind: "qr", ur: { type: "fake-accounts", cbor: new Uint8Array([7]) } },
      },
      session,
    ),
  );
  const hwId = strField(field(field(done, "result"), "wallet"), "walletId");
  return { h, session, walletId, hwId, device };
};

const hd = (walletId: string, template: string) => ({
  kind: "hd",
  walletId,
  groupIndex: 0,
  template,
});

/** The software oracle: `chain.sign` against the imported mnemonic. */
const signLocal = async (h: Harness, session: string, request: unknown) =>
  ok(await h.call("chain.sign", { request, verify: PASSKEY() }, session));

/** Steps a hardware sign through every exchange the driver makes; returns the final result. */
const signOnDevice = async (
  h: Harness,
  session: string,
  request: unknown,
  verify: unknown = PASSKEY(),
): Promise<KernelResponse> => {
  const begin = await h.call("hardware.begin", { op: { kind: "sign", request }, verify }, session);
  if ("err" in begin) {
    return begin;
  }
  const opId = strField(begin.ok, "opId");
  let step = field(begin.ok, "step");
  for (let guard = 0; strField(step, "kind") === "exchange" && guard < 16; guard++) {
    const deviceRequest = field(step, "request");
    const response =
      strField(deviceRequest, "kind") === "qr"
        ? { kind: "qr", ur: { type: "fake-sign", cbor: new Uint8Array([9]) } }
        : strField(deviceRequest, "kind") === "compare"
          ? { kind: "compare", matched: true }
          : { kind: "message", data: new Uint8Array([0xaa]) };
    // oxlint-disable-next-line no-await-in-loop -- the coroutine advances one turn per step
    const next = await h.call("hardware.step", { opId, response }, session);
    if ("err" in next) {
      return next;
    }
    step = next.ok;
  }
  if (strField(step, "kind") !== "done") {
    throw new Error("sign did not finish");
  }
  // The done step carries a HardwareResult — `{kind:"sign", result: SignResult}`.
  return { id: 0, ok: field(field(step, "result"), "result") };
};

describe("hardware sign byte-identical to local signing", () => {
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

  it("evm legacy, eip1559 and eip7702 transactions", async () => {
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
      {
        ...evmTx("eip7702", {
          maxFeePerGas: "0x59682f00",
          maxPriorityFeePerGas: "0x1",
          accessList: [],
          authorization: { address: EVM_DELEGATOR.address },
        }),
        account: hd(walletId, "evm.bip44"),
      },
    ];
    for (const local of requests) {
      const hardware = {
        ...local,
        account: { ...hd(hwId, "evm.bip44") },
      };
      // The kernel rejects a non-canonical request — normalise before it goes on the wire.
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const sw = await signLocal(h, session, normalizeEvm(local));
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const hw = ok(await signOnDevice(h, session, normalizeEvm(hardware)));
      expect(hw).toStrictEqual(sw);
    }
  });

  it("evm personal message and typed data", async () => {
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
      {
        kind: "evm.personal-message",
        message: utf8ToBytes("hello"),
      },
      { kind: "evm.typed-data", typedData },
    ]) {
      const local = {
        ...partial,
        network: EVM_NETWORK,
        account: hd(walletId, "evm.bip44"),
      };
      const hardware = { ...local, account: hd(hwId, "evm.bip44") };
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const sw = await signLocal(h, session, local);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const hw = ok(await signOnDevice(h, session, hardware));
      expect(hw).toStrictEqual(sw);
    }
  });

  it("tron transaction, message and typed data", async () => {
    const { h, session, walletId, hwId } = await boot();
    // The owner address both wallets share — the hw pin derives it from the same account node.
    const accounts = ok(
      await h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "tron.bip44", network: TRON_NETWORK },
        session,
      ),
    );
    const owner = strField(accounts, "address");
    const { buildTronRawData } = await import("@qntx/wallet-chains/tron");
    const rawData = buildTronRawData(
      {
        refBlock: { number: 1, id: "a".repeat(64) },
        expiration: 1_700_000_000_000,
        timestamp: 1_699_999_000_000,
      },
      { type: "TransferContract", owner, to: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6", amount: 1n },
    );
    const requests = [
      {
        kind: "tron.transaction",
        network: TRON_NETWORK,
        rawData,
      },
      { kind: "tron.message", network: TRON_NETWORK, message: utf8ToBytes("hello tron") },
      {
        kind: "tron.typed-data",
        network: TRON_NETWORK,
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
      },
    ];
    for (const partial of requests) {
      const local = { ...partial, account: hd(walletId, "tron.bip44") };
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

  const hex = (s: string): Uint8Array => {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  };
  const MASTER_FP = 0x73c5da0a;
  const PAYEE_SCRIPT = OutScript.encode(
    Address(bitcoinNetwork(BTC_NETWORK).params).decode(
      "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
    ),
  );

  /** A one-input PSBT spending the wallet's `template` account-0 receive-0 key. */
  const psbt = (template: "btc.bip84" | "btc.bip86"): Uint8Array => {
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
      ...(purpose === 86
        ? {
            tapInternalKey: pub.subarray(1),
            tapBip32Derivation: [
              [pub.subarray(1), { hashes: [], der: { fingerprint: MASTER_FP, path } }],
            ],
          }
        : { bip32Derivation: [[pub, { fingerprint: MASTER_FP, path }]] }),
    };
    if (purpose !== 86) {
      // Non-taproot spends must carry the full previous transaction.
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

  it("bitcoin psbt (bip84) is byte-identical; taproot is verified, not compared", async () => {
    const { h, session, walletId, hwId } = await boot();
    const account = (id: string): { kind: "hd"; walletId: string; groupIndex: number } => ({
      kind: "hd",
      walletId: id,
      groupIndex: 0,
    });
    const bip84 = {
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      psbt: psbt("btc.bip84"),
      sign: [{ index: 0, template: "btc.bip84" }],
    };
    const sw84 = await signLocal(h, session, { ...bip84, account: account(walletId) });
    const hw84 = ok(await signOnDevice(h, session, { ...bip84, account: account(hwId) }));
    expect(hw84).toStrictEqual(sw84);

    const bip86 = {
      ...bip84,
      psbt: psbt("btc.bip86"),
      sign: [{ index: 0, template: "btc.bip86" }],
    };
    const hw86 = ok(await signOnDevice(h, session, { ...bip86, account: account(hwId) }));
    // BIP-340 aux randomness differs run to run — verify rather than compare bytes.
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
    // The legacy format signs from a P2PKH key only — bip44.
    const pub44 = HDKey.fromMasterSeed(SEED).derive("m/44'/0'/0'/0/0").publicKey!;
    const address44 = p2pkh(pub44, bitcoinNetwork(BTC_NETWORK).params).address;
    const partial = {
      kind: "bitcoin.message",
      network: BTC_NETWORK,
      address: address44,
      message: "sign this",
      format: "legacy" as const,
      change: 0 as const,
      index: 0,
    };
    const local = { ...partial, account: hd(walletId, "btc.bip44") };
    const hardware = { ...local, account: hd(hwId, "btc.bip44") };
    const sw = await signLocal(h, session, local);
    const hw = ok(await signOnDevice(h, session, hardware));
    expect(hw).toStrictEqual(sw);
  });
});

const HOSTILE: FakeDeviceOptions[] = [
  { signSeed: OTHER_SEED },
  {
    corrupt: (signatures: Uint8Array[]) => {
      const bad = signatures.map((s) => new Uint8Array(s));
      const [first] = bad;
      if (first !== undefined) {
        first[10] = (first[10] ?? 0) ^ 1;
      }
      return bad;
    },
  },
  { corrupt: (signatures: Uint8Array[]) => signatures.slice(1) },
  { corrupt: (signatures: Uint8Array[]) => signatures.map((s) => s.subarray(0, 63)) },
];

describe("hardware sign refusals", () => {
  const request = (walletId: string) => ({
    kind: "evm.personal-message",
    network: EVM_NETWORK,
    account: hd(walletId, "evm.bip44"),
    message: utf8ToBytes("hello"),
  });

  it("a wrong key, a flipped bit, a wrong count and a wrong length are all integrity", async () => {
    for (const opts of HOSTILE) {
      // oxlint-disable-next-line no-await-in-loop -- one device at a time
      const { h, session, hwId } = await boot(opts);
      // oxlint-disable-next-line no-await-in-loop -- one device at a time
      const res = await signOnDevice(h, session, request(hwId));
      expect(errCode(res)).toBe("integrity");
    }
  });

  it("an unsupported display refuses before the verification prompt exists", async () => {
    const { h, session, hwId } = await boot({ display: "unsupported" });
    // A wrong factor would answer wrong-passkey if verifyFactor ever ran — it must not.
    const res = await signOnDevice(h, session, request(hwId), BAD_PASSKEY());
    expect(errCode(res)).toBe("unsupported");
  });

  it("the verification prompt carries the device line", async () => {
    const fake = fakeKeystore();
    const device = fakeDevice(SEED);
    const h = createHarness({
      keystore: fake.keystore,
      drivers: { keystone: device.driver, ledger: device.driver, onekey: ONEKEY_DRIVER },
    });
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
    const begin = ok(
      await h.call("hardware.begin", { op: { kind: "pair", device: "keystone" } }, session),
    );
    ok(
      await h.call(
        "hardware.step",
        {
          opId: strField(begin, "opId"),
          response: { kind: "qr", ur: { type: "t", cbor: new Uint8Array([7]) } },
        },
        session,
      ),
    );
    const status = ok(await h.call("status", undefined, session));
    const wallets = field(status, "wallets") as ReadonlyArray<Record<string, ProtocolValue>>;
    const hwWallet = wallets.find((w) => w["custody"] === "hardware")!;
    const signRes = await signOnDevice(
      h,
      session,
      {
        kind: "evm.personal-message",
        network: EVM_NETWORK,
        account: hd(hwWallet["walletId"] as string, "evm.bip44"),
        message: utf8ToBytes("hello"),
      },
      { kind: "hardware" },
    );
    expect("err" in signRes).toBe(false);
    const descriptions = opens(fake.calls).map((p) => `${p.title}\n${p.description}`);
    expect(descriptions.some((d) => d.includes(devicePromptLine("en", "clear", "keystone")))).toBe(
      true,
    );
  });

  it("an oversize prompt fits the bound once the device line is appended", async () => {
    /* The phone dialog gets the chain bound shrunk by the device line's cost, so the verification
       prompt — body plus device line — still fits where the unshrunk body alone would overflow. */
    const fake = fakeKeystore();
    const device = fakeDevice(SEED);
    const h = createHarness({
      keystore: fake.keystore,
      drivers: { keystone: device.driver, ledger: device.driver, onekey: ONEKEY_DRIVER },
    });
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
    const begin = ok(
      await h.call("hardware.begin", { op: { kind: "pair", device: "keystone" } }, session),
    );
    ok(
      await h.call(
        "hardware.step",
        {
          opId: strField(begin, "opId"),
          response: { kind: "qr", ur: { type: "t", cbor: new Uint8Array([7]) } },
        },
        session,
      ),
    );
    const status = ok(await h.call("status", undefined, session));
    const wallets = field(status, "wallets") as ReadonlyArray<Record<string, ProtocolValue>>;
    const hwWallet = wallets.find((w) => w["custody"] === "hardware")!;
    const signRes = await signOnDevice(
      h,
      session,
      {
        kind: "evm.personal-message",
        network: EVM_NETWORK,
        account: hd(hwWallet["walletId"] as string, "evm.bip44"),
        message: utf8ToBytes(Array.from({ length: 40 }, (_, i) => `message line ${i}`).join("\n")),
      },
      { kind: "hardware" },
    );
    expect("err" in signRes).toBe(false);
    const prompt = opens(fake.calls).at(-1);
    expect(prompt?.description.endsWith(devicePromptLine("en", "clear", "keystone"))).toBe(true);
    expect(promptFits(prompt!, PROMPT_BOUNDS.ios)).toBe(true);
  });
});

const containsBytes = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
};

/** Does any byte sequence or string in the message tree carry `needle`? */
const leaks = (value: ProtocolValue, needle: Uint8Array, text: string): boolean => {
  if (value instanceof Uint8Array) {
    return containsBytes(value, needle);
  }
  if (typeof value === "string") {
    return value.includes(text);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entries =
    Symbol.iterator in value
      ? [...(value as Iterable<ProtocolValue>)]
      : Object.values(value as Record<string, ProtocolValue>);
  return entries.some((entry) => leaks(entry, needle, text));
};

describe("no secret leaves the kernel over the wire", () => {
  it("pair, accounts, sign and verify-address post nothing carrying wallet secrets", async () => {
    const { h, session, hwId } = await boot();
    // accounts
    await h.call(
      "hardware.begin",
      {
        op: {
          kind: "accounts",
          walletId: hwId,
          groupIndex: 0,
          templates: ["tron.bip44"],
          network: TRON_NETWORK,
        },
      },
      session,
    );
    // sign
    ok(
      await signOnDevice(h, session, {
        kind: "evm.personal-message",
        network: EVM_NETWORK,
        account: { kind: "hd", walletId: hwId, groupIndex: 0, template: "evm.bip44" },
        message: utf8ToBytes("hello"),
      }),
    );
    // verify-address
    const begin = ok(
      await h.call(
        "hardware.begin",
        {
          op: {
            kind: "verify-address",
            walletId: hwId,
            groupIndex: 0,
            template: "evm.bip44",
            network: EVM_NETWORK,
          },
        },
        session,
      ),
    );
    ok(
      await h.call(
        "hardware.step",
        {
          opId: strField(begin, "opId"),
          response: { kind: "compare", matched: true },
        },
        session,
      ),
    );

    const secrets: ReadonlyArray<readonly [Uint8Array, string]> = [
      [utf8ToBytes(MNEMONIC), "the mnemonic"],
      [SEED, "the seed"],
      [HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'").privateKey!, "the bip32 account key"],
      [Slip10.fromMasterSeed(SEED).derive("m/44'/501'/0'/0'").privateKey, "the slip10 account key"],
    ];
    for (const [bytes, name] of secrets) {
      expect(bytes.length).toBeGreaterThan(0);
      const hit = h.posted.find((message) => leaks(message, bytes, MNEMONIC));
      expect(hit, `a posted message carries ${name}`).toBeUndefined();
    }
    // Positive controls: the scan finds the mnemonic in text and the seed inside bytes.
    expect(leaks(`seed: ${MNEMONIC}`, SEED, MNEMONIC)).toBe(true);
    expect(leaks(new Uint8Array([0, ...SEED, 0]), SEED, MNEMONIC)).toBe(true);
  });
});
