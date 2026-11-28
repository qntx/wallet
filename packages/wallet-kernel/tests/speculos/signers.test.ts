// oxlint-disable vitest/no-conditional-in-test -- device-setting mutation cases exercise guard branches
/**
 * The Ledger driver end to end on Speculos through the real kernel flow: `hardware.begin` /
 * `hardware.step` run the driver, and the host loop forwards every `{ kind: "message", data }`
 * exchange to the APDU port of the speculos container running the app the step needs, while a
 * `Screen` approves (or rejects, where a case says so) review screens the same way the recorded
 * protocol cases do. The speculos seed is the wallet's device: pairing must return its master
 * fingerprint, and every signature the kernel assembles is checked by an oracle outside the kernel
 * (viem recovery, noble ed25519, btc-signer verify + finalize).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { p2pkh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import {
  getAddress,
  hashMessage,
  hashTypedData,
  recoverAddress,
  recoverTransactionAddress,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { bitcoinNetwork, verifyBitcoinPsbtSignatures } from "@qntx/wallet-chains/bitcoin";
import { normalizeEvm } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import {
  buildTronRawData,
  tronAddressFromPublicKey,
  tronMessageDigest,
} from "@qntx/wallet-chains/tron";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { devicePromptLine } from "../../src/modules/signers/prompt.ts";
import { createHarness } from "../harness.ts";
import type { Harness, KernelResponse } from "../harness.ts";
import { fakeKeystore } from "../keystore.ts";
import type { KeystoreCall } from "../keystore.ts";
import { MNEMONIC, SEED, hex, unhex } from "../signers-ledger-fake.ts";
import { Screen, exchange } from "./harness.ts";
import { MAIL } from "./ledger-cases.ts";
import { setSetting } from "./record.ts";

const UP = existsSync(
  fileURLToPath(new URL("../../../../.cache/ledger/endpoints.json", import.meta.url)),
);

const EVM_NETWORK = "eip155:1";
const TRON_NETWORK = "tron:728126428";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";

type LedgerApp = "bitcoin" | "ethereum" | "solana" | "tron";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Screen vocabulary, same words the recorded cases navigate by (tests/speculos/ledger-cases.ts).
const MENU = /app is ready|app settings|app info|quit app/i;
const THROUGH = /blind signing ahead|press both buttons|continue anyway/i;
const APPROVE =
  /accept|approve public key|confirm|sign transaction|sign typed message|sign message/i;
const REJECT = /^reject|^deny|^cancel/i;

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`no ${what}`);
  }
  return value;
};

// Independent oracles: every key the device is asked to use derives from the speculos seed.
const root = HDKey.fromMasterSeed(SEED);
const slip = Slip10.fromMasterSeed(SEED);
const pubAt = (path: string): Uint8Array => must(root.derive(path).publicKey, path);
const slipAt = (path: string): Uint8Array => slip.derive(path).publicKey.subarray(1);
const ethAddress0 = getAddress(mnemonicToAccount(MNEMONIC).address);
const tronAddress0 = tronAddressFromPublicKey(pubAt("m/44'/195'/0'/0/0"));
const tronTail = ((): `0x${string}` => {
  const uncompressed = secp256k1.Point.fromBytes(pubAt("m/44'/195'/0'/0/0")).toBytes(false);
  return getAddress(`0x${hex(keccak_256(uncompressed.slice(1)).slice(12))}`);
})();
const solPub0 = slipAt("m/44'/501'/0'/0'");
const solAddress0 = solanaAddressFromPublicKey(solPub0);
const btcParams = bitcoinNetwork(BTC_NETWORK).params;
const btc44Address0 = p2pkh(pubAt("m/44'/0'/0'/0/0"), btcParams).address;

const ok = (response: KernelResponse): ProtocolValue => {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
};

const errCode = (response: KernelResponse): string | undefined =>
  "err" in response ? response.err.code : undefined;

const field = (value: ProtocolValue, key: string): ProtocolValue => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error(`expected object, got ${String(value)}`);
  }
  const v = (value as Record<string, ProtocolValue>)[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
};

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

type Review = "approve" | "reject" | undefined;

/** Every APDU the signer host loop sends, in order — hostile cases assert what never went out. */
const apduLog: string[] = [];

/**
 * One `message` exchange over the speculos link. A non-interactive APDU answers in milliseconds;
 * when `review` is set and the device is still silent after the grace period the exchange is held
 * by an on-screen review — navigate it.
 */
const send = async (
  app: LedgerApp,
  apdu: Uint8Array,
  screen: Screen,
  review: Review,
): Promise<Uint8Array> => {
  apduLog.push(hex(apdu));
  const pending = exchange(app, apdu);
  if (review !== undefined) {
    const early = await Promise.race([pending, sleep(500).then((): undefined => undefined)]);
    if (early === undefined) {
      // Keep the in-flight rejection observed while navigation is still pressing.
      void pending.catch(() => undefined);
      await (review === "approve"
        ? screen.approve(APPROVE, { through: THROUGH, leave: MENU, maxSteps: 80 })
        : screen.reject(REJECT, { maxSteps: 80, leave: MENU }));
    }
  }
  return pending;
};

/**
 * The host loop: `hardware.begin` starts the driver, then every `exchange` step is one APDU on the
 * app's speculos port until the `done` step. `app` is the routing decision — passing the wrong
 * container is exactly how "the wrong app is open" is exercised. Returns the kernel response; the
 * done step and the sign op's display classification are readable from it.
 */
const runOp = async (
  h: Harness,
  session: string,
  app: LedgerApp,
  params: Record<string, unknown>,
  screen: Screen,
  review: Review,
): Promise<KernelResponse> => {
  const begin = await h.call("hardware.begin", params, session);
  if ("err" in begin) {
    return begin;
  }
  const opId = strField(begin.ok, "opId");
  let step = field(begin.ok, "step");
  for (let guard = 0; strField(step, "kind") === "exchange" && guard < 600; guard += 1) {
    const request = field(step, "request");
    if (strField(request, "kind") !== "message") {
      throw new Error(`expected a message exchange, got ${JSON.stringify(request)}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- exchanges are sequential by definition
    const rapdu = await send(app, bytesField(request, "data"), screen, review);
    // oxlint-disable-next-line eslint/no-await-in-loop -- the coroutine advances one turn per step
    const next = await h.call(
      "hardware.step",
      { opId, response: { kind: "message", data: rapdu } },
      session,
    );
    if ("err" in next) {
      return next;
    }
    step = next.ok;
  }
  if (strField(step, "kind") !== "done") {
    throw new Error("the operation did not finish");
  }
  return { id: 0, ok: step };
};

const opens = (calls: ReadonlyArray<KeystoreCall>) =>
  calls.flatMap((call) => (call.op === "open" && call.prompt !== undefined ? [call.prompt] : []));

const hd = (walletId: string, template: string) => ({
  kind: "hd",
  walletId,
  groupIndex: 0,
  template,
});

/** The `{kind:"done"}` step's operation payload (`{kind:"sign"|"accounts"|…, …}`). */
const donePayload = (step: ProtocolValue): ProtocolValue => field(step, "result");

const first = (rows: ProtocolValue): ProtocolValue => {
  if (!Array.isArray(rows) || rows[0] === undefined) {
    throw new Error("expected at least one row");
  }
  return rows[0];
};

const EXT_ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"; // BIP-173 example payee

/**
 * A one-input PSBT spending the device account's `m/{84|86}'/0'/0'/0/0` key to an external address.
 * Non-taproot inputs must carry `nonWitnessUtxo` — the kernel's normalizer requires the full
 * previous transaction (a BIP-143 signature commits to its own input's amount only) — so a
 * fabricated funding tx supplies it, its txid the input's prevout.
 */
const psbtFor = (template: "btc.bip84" | "btc.bip86"): Uint8Array => {
  const purpose = template === "btc.bip84" ? 84 : 86;
  const pub = pubAt(`m/${purpose}'/0'/0'/0/0`);
  const path = [purpose + 0x80000000, 0x80000000, 0x80000000, 0, 0];
  const input: Record<string, unknown> = { index: 0, sequence: 0xfffffffd };
  if (purpose === 86) {
    const xonly = pub.slice(1);
    input["txid"] = "07".repeat(32);
    input["witnessUtxo"] = { script: p2tr(xonly).script, amount: 100_000n };
    input["tapInternalKey"] = xonly;
    input["tapBip32Derivation"] = [
      [xonly, { hashes: [], der: { fingerprint: root.fingerprint, path } }],
    ];
  } else {
    const spend = p2wpkh(pub);
    const prev = new Transaction({
      version: 2,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    prev.addInput({ txid: "11".repeat(32), index: 0 });
    prev.addOutput({ script: spend.script, amount: 100_000n });
    input["txid"] = prev.id;
    input["witnessUtxo"] = { script: spend.script, amount: 100_000n };
    input["nonWitnessUtxo"] = prev.toBytes(true, false);
    input["bip32Derivation"] = [[pub, { fingerprint: root.fingerprint, path }]];
  }
  const tx = new Transaction({
    version: 2,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
  tx.addInput(input);
  tx.addOutputAddress(EXT_ADDR, 90_000n);
  return tx.toPSBT(0);
};

/**
 * A bip84 PSBT like {@link psbtFor} on the group's account with a second output bound to its `…/1/3`
 * key — an own key the pin serves but the device never confirmed. Its address is the same every
 * run, so the test can look for it on the review screens.
 */
const psbtWithUnconfirmedOutput = (group: number): Uint8Array => {
  const pub = pubAt(`m/84'/0'/${group}'/0/0`);
  const spend = p2wpkh(pub);
  const prev = new Transaction({
    version: 2,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
  prev.addInput({ txid: "12".repeat(32), index: 0 });
  prev.addOutput({ script: spend.script, amount: 100_000n });
  const outPub = pubAt(`m/84'/0'/${group}'/1/3`);
  const account = group + 0x80000000;
  const path0 = [84 + 0x80000000, 0x80000000, account, 0, 0];
  const path13 = [84 + 0x80000000, 0x80000000, account, 1, 3];
  const tx = new Transaction({
    version: 2,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
  tx.addInput({
    txid: prev.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: spend.script, amount: 100_000n },
    nonWitnessUtxo: prev.toBytes(true, false),
    bip32Derivation: [[pub, { fingerprint: root.fingerprint, path: path0 }]],
  });
  tx.addOutputAddress(EXT_ADDR, 89_000n);
  tx.addOutput({ script: p2wpkh(outPub).script, amount: 1000n });
  tx.updateOutput(tx.outputsLength - 1, {
    bip32Derivation: [[outPub, { fingerprint: root.fingerprint, path: path13 }]],
  });
  return tx.toPSBT(0);
};

/** Tron oracle: the chain's address is the keccak tail of the uncompressed key, base58'd. */
const MSG_PREFIX = utf8ToBytes("Bitcoin Signed Message:\n");
const varint = (n: number): Uint8Array => {
  if (n < 0xfd) {
    return new Uint8Array([n]);
  }
  const out = new Uint8Array(3);
  out[0] = 0xfd;
  new DataView(out.buffer).setUint16(1, n, true);
  return out;
};
const btcMessageHash = (message: Uint8Array): Uint8Array => {
  const len = varint(message.length);
  const preimage = new Uint8Array(MSG_PREFIX.length + len.length + message.length);
  preimage.set(MSG_PREFIX);
  preimage.set(len, MSG_PREFIX.length);
  preimage.set(message, MSG_PREFIX.length + len.length);
  return sha256(sha256(preimage));
};

const rsv = (signature: Uint8Array): { r: `0x${string}`; s: `0x${string}`; v: bigint } => ({
  r: `0x${hex(signature.subarray(0, 32))}`,
  s: `0x${hex(signature.subarray(32, 64))}`,
  v: BigInt(signature[64] ?? 0),
});

describe.skipIf(!UP)("ledger signers on speculos", () => {
  let h: Harness;
  let session: string;
  let hwId: string;
  let keystore: ReturnType<typeof fakeKeystore>;
  const screens: Record<LedgerApp, Screen> = {
    bitcoin: new Screen("bitcoin"),
    ethereum: new Screen("ethereum"),
    solana: new Screen("solana"),
    tron: new Screen("tron"),
  };
  const screen = (app: LedgerApp): Screen => screens[app];

  beforeAll(async () => {
    keystore = fakeKeystore();
    h = createHarness({ keystore: keystore.keystore });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    session = strField(res, "session");
    ok(
      await h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: { kind: "hardware" } },
        session,
      ),
    );
  }, 60_000);

  it("pairs on the bitcoin app and records the seed's fingerprint", async () => {
    const done = ok(
      await runOp(
        h,
        session,
        "bitcoin",
        { op: { kind: "pair", device: "ledger" }, verify: { kind: "hardware" } },
        screen("bitcoin"),
        undefined,
      ),
    );
    const wallet = field(donePayload(done), "wallet");
    hwId = strField(wallet, "walletId");
    const expectFp = new Uint8Array(4);
    new DataView(expectFp.buffer).setUint32(0, root.fingerprint);
    expect(unhex(strField(wallet, "fingerprint"))).toStrictEqual(expectFp);
    expect(strField(wallet, "firmware")).toMatch(/^Bitcoin /);
  }, 300_000);

  it("fetches one account group per family", async () => {
    const cases: ReadonlyArray<readonly [LedgerApp, string, string, string]> = [
      ["ethereum", "evm.bip44", EVM_NETWORK, ethAddress0],
      ["tron", "tron.bip44", TRON_NETWORK, tronAddress0],
      ["solana", "solana.bip44-change", SOLANA_NETWORK, solAddress0],
    ];
    for (const [app, template, network, want] of cases) {
      const done = ok(
        // oxlint-disable-next-line eslint/no-await-in-loop -- one family's app at a time
        await runOp(
          h,
          session,
          app,
          {
            op: {
              kind: "accounts",
              walletId: hwId,
              groupIndex: 0,
              templates: [template],
              network,
            },
            verify: { kind: "hardware" },
          },
          screen(app),
          undefined,
        ),
      );
      expect(strField(first(field(donePayload(done), "accounts")), "address")).toBe(want);
    }
    // A second bitcoin group exercises btcExtendedPublicKey outside the pair set.
    const done = ok(
      await runOp(
        h,
        session,
        "bitcoin",
        {
          op: {
            kind: "accounts",
            walletId: hwId,
            groupIndex: 1,
            templates: ["btc.bip84"],
            network: BTC_NETWORK,
          },
          verify: { kind: "hardware" },
        },
        screen("bitcoin"),
        undefined,
      ),
    );
    // The bitcoin account row carries the account xpub, not a single address.
    const btc = first(field(donePayload(done), "accounts"));
    expect(strField(btc, "xpub")).toBe(root.derive("m/84'/0'/1'").publicExtendedKey);
    expect(strField(btc, "fingerprint")).toBe(root.fingerprint.toString(16).padStart(8, "0"));
  }, 300_000);

  it("answers device-app-closed when the routed app does not match", async () => {
    // Verify-address always talks to the device. Routing the btc link to the ethereum container:
    // appAndVersion answers "Ethereum" where the driver asked for "Bitcoin".
    const res = await runOp(
      h,
      session,
      "ethereum",
      {
        op: {
          kind: "verify-address",
          walletId: hwId,
          groupIndex: 0,
          template: "btc.bip84",
          network: BTC_NETWORK,
          index: 0,
        },
      },
      screen("ethereum"),
      undefined,
    );
    expect(errCode(res)).toBe("device-app-closed");
  }, 120_000);

  it("verifies one address per family on the device screen", async () => {
    const cases: ReadonlyArray<readonly [LedgerApp, Record<string, unknown>]> = [
      [
        "ethereum",
        {
          kind: "verify-address",
          walletId: hwId,
          groupIndex: 0,
          template: "evm.bip44",
          network: EVM_NETWORK,
        },
      ],
      [
        "tron",
        {
          kind: "verify-address",
          walletId: hwId,
          groupIndex: 0,
          template: "tron.bip44",
          network: TRON_NETWORK,
        },
      ],
      [
        "solana",
        {
          kind: "verify-address",
          walletId: hwId,
          groupIndex: 0,
          template: "solana.bip44-change",
          network: SOLANA_NETWORK,
        },
      ],
      [
        "bitcoin",
        {
          kind: "verify-address",
          walletId: hwId,
          groupIndex: 0,
          template: "btc.bip84",
          network: BTC_NETWORK,
          index: 0,
        },
      ],
    ];
    const wants = [
      ethAddress0,
      tronAddress0,
      solAddress0,
      p2wpkh(pubAt("m/84'/0'/0'/0/0"), btcParams).address,
    ];
    for (const [i, [app, op]] of cases.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one verification at a time
      const done = ok(await runOp(h, session, app, { op }, screen(app), "approve"));
      const result = donePayload(done);
      expect(strField(result, "method")).toBe("device");
      expect(strField(result, "address")).toBe(must(wants[i], "address"));
    }
  }, 300_000);

  it("maps a device-side address rejection to device-rejected", async () => {
    const res = await runOp(
      h,
      session,
      "solana",
      {
        op: {
          kind: "verify-address",
          walletId: hwId,
          groupIndex: 0,
          template: "solana.bip44-change",
          network: SOLANA_NETWORK,
        },
      },
      screen("solana"),
      "reject",
    );
    expect(errCode(res)).toBe("device-rejected");
  }, 120_000);

  const sign = async (
    app: LedgerApp,
    request: unknown,
    review: Review = "approve",
    descriptors?: unknown,
  ): Promise<KernelResponse> =>
    runOp(
      h,
      session,
      app,
      {
        op: {
          kind: "sign",
          request,
          ...(descriptors === undefined ? {} : { descriptors }),
        },
        verify: { kind: "hardware" },
      },
      screen(app),
      review,
    );

  const signResult = (done: ProtocolValue): ProtocolValue => field(donePayload(done), "result");

  const promptsSince = (from: number): string[] =>
    opens(keystore.calls.slice(from)).map((p) => `${p.title}\n${p.description}`);

  it("signs a clear eip1559 transfer the device displays", async () => {
    const request = {
      kind: "evm.transaction",
      network: EVM_NETWORK,
      account: hd(hwId, "evm.bip44"),
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        value: "0xde0b6b3a7640000",
        data: "0x",
        to: "0x00000000000000000000000000000000deadbeef",
        accessList: [],
      },
    };
    const before = keystore.calls.length;
    const done = ok(await sign("ethereum", normalizeEvm(request)));
    const signed = `0x${hex(bytesField(signResult(done), "signedTransaction"))}`;
    // Oracle: recover the sender out of the signed transaction itself.
    await expect(
      recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` }),
    ).resolves.toBe(ethAddress0);
    expect(
      promptsSince(before).some((d) => d.includes(devicePromptLine("en", "clear", "ledger"))),
    ).toBe(true);
    console.log("clear eip1559 screens:", JSON.stringify(screen("ethereum").texts.slice(-10)));
  }, 300_000);

  it("refuses calldata while the app's Blind signing is off, then signs it on", async () => {
    const request = {
      kind: "evm.transaction",
      network: EVM_NETWORK,
      account: hd(hwId, "evm.bip44"),
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 1,
        gas: "0x5208",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        value: "0x0",
        data: "0xa9059cbb00000000000000000000000000000000000000000000000000000000deadbeef0000000000000000000000000000000000000000000000000000000000000001",
        to: "0x00000000000000000000000000000000c0ffee01",
        accessList: [],
      },
    };
    const ethScreen = screen("ethereum");
    await setSetting(ethScreen, "Blind signing", false);
    const off = await sign("ethereum", normalizeEvm(request));
    expect(errCode(off)).toBe("blind-signing-disabled");
    await setSetting(ethScreen, "Blind signing", true);
    const before = keystore.calls.length;
    const done = ok(await sign("ethereum", normalizeEvm(request)));
    const signed = `0x${hex(bytesField(signResult(done), "signedTransaction"))}`;
    await expect(
      recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` }),
    ).resolves.toBe(ethAddress0);
    expect(
      promptsSince(before).some((d) => d.includes(devicePromptLine("en", "blind", "ledger"))),
    ).toBe(true);
    console.log("blind calldata screens:", JSON.stringify(ethScreen.texts.slice(-10)));
  }, 300_000);

  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const TOKEN_WORD = "00000000000000000000000000000000deadbeef".padStart(64, "0");
  const transferData = `0xa9059cbb${TOKEN_WORD}${(1234567).toString(16).padStart(64, "0")}`;
  const approveData = `0x095ea7b3${TOKEN_WORD}${"f".repeat(64)}`;

  const calToken = (chainId: number, address: string): Uint8Array => {
    const parsed: unknown = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../vectors/ledger/cal/tokens.json", import.meta.url)),
        "utf8",
      ),
    );
    if (typeof parsed !== "object" || parsed === null || !("tokens" in parsed)) {
      throw new Error("CAL token vector has no tokens");
    }
    const rows = parsed.tokens as ReadonlyArray<{
      chainId: number;
      address: string;
      descriptor: string;
    }>;
    const row = rows.find((entry) => entry.chainId === chainId && entry.address === address);
    if (row === undefined) {
      throw new Error(`missing CAL row ${String(chainId)} ${address}`);
    }
    return unhex(row.descriptor);
  };

  const usdcPayload = (): Uint8Array => calToken(1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  const usdtPayload = (): Uint8Array => calToken(1, "0xdac17f958d2ee523a2206206994597c13d831ec7");

  const tokenTx = (data: string, nonce: number, to = USDC) =>
    normalizeEvm({
      kind: "evm.transaction",
      network: EVM_NETWORK,
      account: hd(hwId, "evm.bip44"),
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce,
        gas: "0x5208",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        value: "0x0",
        data,
        to,
        accessList: [],
      },
    });

  const textSince = (app: LedgerApp, from: number): string =>
    screen(app).texts.slice(from).join("\n");

  const mutate = (payload: Uint8Array, offset: number, value: number): Uint8Array => {
    const out = Uint8Array.from(payload);
    out[offset] = value;
    return out;
  };

  it("clear-signs a USDC transfer and unlimited approve with Blind signing off", async () => {
    const ethScreen = screen("ethereum");
    await setSetting(ethScreen, "Blind signing", false);
    const usdc = { tokens: [usdcPayload()] };

    let before = keystore.calls.length;
    let screensBefore = ethScreen.texts.length;
    const transferDone = ok(await sign("ethereum", tokenTx(transferData, 10), "approve", usdc));
    const transferSigned = `0x${hex(bytesField(signResult(transferDone), "signedTransaction"))}`;
    await expect(
      recoverTransactionAddress({ serializedTransaction: transferSigned as `0x02${string}` }),
    ).resolves.toBe(ethAddress0);
    expect(
      promptsSince(before).some((d) => d.includes(devicePromptLine("en", "clear", "ledger"))),
    ).toBe(true);
    const transferText = textSince("ethereum", screensBefore);
    expect(transferText).toMatch(/send/i);
    expect(transferText).toMatch(/1\.234567\s*USDC/);
    expect(transferText).toMatch(/dea\s*dbeef/i);
    console.log(
      "clear USDC transfer screens:",
      JSON.stringify(ethScreen.texts.slice(screensBefore)),
    );

    before = keystore.calls.length;
    screensBefore = ethScreen.texts.length;
    const approveDone = ok(await sign("ethereum", tokenTx(approveData, 11), "approve", usdc));
    const approveSigned = `0x${hex(bytesField(signResult(approveDone), "signedTransaction"))}`;
    await expect(
      recoverTransactionAddress({ serializedTransaction: approveSigned as `0x02${string}` }),
    ).resolves.toBe(ethAddress0);
    expect(
      promptsSince(before).some((d) => d.includes(devicePromptLine("en", "clear", "ledger"))),
    ).toBe(true);
    const approveText = textSince("ethereum", screensBefore);
    expect(approveText).toMatch(/approve/i);
    expect(approveText).toMatch(/unlimited\s+USDC/i);
    expect(approveText).toMatch(/dea\s*dbeef/i);
    console.log(
      "clear USDC approve screens:",
      JSON.stringify(ethScreen.texts.slice(screensBefore)),
    );
  }, 300_000);

  it("drops hostile token descriptors before any PROVIDE TOKEN APDU", async () => {
    const ethScreen = screen("ethereum");
    await setSetting(ethScreen, "Blind signing", false);
    const usdc = usdcPayload();
    const chainAt = 1 + (usdc[0] ?? 0) + 20 + 4;
    const decimalsLowAt = 1 + (usdc[0] ?? 0) + 20 + 3;
    const cases: ReadonlyArray<{ readonly name: string; readonly payload: Uint8Array }> = [
      { name: "usdt-for-usdc", payload: usdtPayload() },
      { name: "wrong-chain", payload: mutate(usdc, chainAt + 3, 2) },
      { name: "decimals-tampered", payload: mutate(usdc, decimalsLowAt, 7) },
    ];
    for (const [index, hostile] of cases.entries()) {
      const sentBefore = apduLog.length;
      // oxlint-disable-next-line eslint/no-await-in-loop -- each case starts from the prior screen state
      const res = await sign("ethereum", tokenTx(transferData, 20 + index), "approve", {
        tokens: [hostile.payload],
      });
      expect(errCode(res)).toBe("blind-signing-disabled");
      expect(apduLog.slice(sentBefore).some((apdu) => apdu.startsWith("e00a0000"))).toBe(false);
    }
  }, 300_000);

  it("forwards an unlisted forged token payload and the device refuses it without a signature", async () => {
    const ethScreen = screen("ethereum");
    await setSetting(ethScreen, "Blind signing", false);
    const forged = mutate(usdcPayload(), 1 + 4, 0x42);
    forged.fill(0x42, 1 + 4, 1 + 4 + 20);
    const target = `0x${"42".repeat(20)}`;
    const sentBefore = apduLog.length;
    const res = await sign("ethereum", tokenTx(transferData, 30, target), "approve", {
      tokens: [forged],
    });
    expect(errCode(res)).toBe("unsupported");
    const sent = apduLog.slice(sentBefore);
    expect(sent.some((apdu) => apdu.startsWith("e00a0000"))).toBe(true);
    expect(sent.some((apdu) => apdu.startsWith("e0040000"))).toBe(false);
  }, 300_000);

  it("signs a personal message and typed data", async () => {
    const ethScreen = screen("ethereum");
    await setSetting(ethScreen, "Blind signing", true); // typed data signs behind it
    const message = utf8ToBytes("hello ledger");
    const personal = ok(
      await sign("ethereum", {
        kind: "evm.personal-message",
        network: EVM_NETWORK,
        account: hd(hwId, "evm.bip44"),
        message,
      }),
    );
    const signature = bytesField(signResult(personal), "signature");
    await expect(
      recoverAddress({ hash: hashMessage({ raw: message }), signature: rsv(signature) }),
    ).resolves.toBe(ethAddress0);

    const typed = ok(
      await sign("ethereum", {
        kind: "evm.typed-data",
        network: EVM_NETWORK,
        account: hd(hwId, "evm.bip44"),
        typedData: JSON.stringify(MAIL),
      }),
    );
    const sig2 = bytesField(signResult(typed), "signature");
    await expect(recoverAddress({ hash: hashTypedData(MAIL), signature: rsv(sig2) })).resolves.toBe(
      ethAddress0,
    );
  }, 300_000);

  it("signs a tron transfer and a tron message", async () => {
    const rawData = buildTronRawData(
      {
        refBlock: { number: 1, id: "a".repeat(64) },
        expiration: 1_800_000_000_000,
        timestamp: 1_799_999_000_000,
      },
      {
        type: "TransferContract",
        owner: tronAddress0,
        to: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6",
        amount: 1n,
      },
    );
    const txDone = ok(
      await sign("tron", {
        kind: "tron.transaction",
        network: TRON_NETWORK,
        account: hd(hwId, "tron.bip44"),
        rawData,
      }),
    );
    const txSig = bytesField(signResult(txDone), "signature");
    await expect(
      recoverAddress({ hash: `0x${hex(sha256(rawData))}`, signature: rsv(txSig) }),
    ).resolves.toBe(tronTail);

    // The pinned app hash-signs personal messages behind "Blind signing" — it must refuse while
    // off, then sign once the setting is on.
    const tronScreen = screen("tron");
    const message = utf8ToBytes("hello tron");
    const msgRequest = {
      kind: "tron.message",
      network: TRON_NETWORK,
      account: hd(hwId, "tron.bip44"),
      message,
    } as const;
    await setSetting(tronScreen, "Blind signing", false);
    expect(errCode(await sign("tron", msgRequest))).toBe("blind-signing-disabled");
    await setSetting(tronScreen, "Blind signing", true);
    const before = keystore.calls.length;
    const msgDone = ok(await sign("tron", msgRequest));
    const msgSig = bytesField(signResult(msgDone), "signature");
    expect(
      promptsSince(before).some((d) => d.includes(devicePromptLine("en", "blind", "ledger"))),
    ).toBe(true);
    await expect(
      recoverAddress({ hash: `0x${hex(tronMessageDigest(message))}`, signature: rsv(msgSig) }),
    ).resolves.toBe(tronTail);
  }, 300_000);

  it("signs a solana transfer and an off-chain ascii message", async () => {
    const dest = new Uint8Array(32).fill(0x22);
    // The SystemProgram id "11111111111111111111111111111111" is all-zero bytes.
    const system = new Uint8Array(32);
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
      ...solPub0,
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
    const txDone = ok(
      await sign("solana", {
        kind: "solana.transaction",
        network: SOLANA_NETWORK,
        account: hd(hwId, "solana.bip44-change"),
        message,
      }),
    );
    const txSig = bytesField(signResult(txDone), "signature");
    expect(ed25519.verify(txSig, message, solPub0)).toBe(true);

    // v0 off-chain document: ff‖"solana offchain"‖00‖appDomain‖00 ascii‖nSigners‖key‖u16le‖body.
    const body = utf8ToBytes("hello ledger");
    const doc = new Uint8Array(16 + 1 + 32 + 1 + 1 + 32 + 2 + body.length);
    doc[0] = 0xff;
    doc.set(utf8ToBytes("solana offchain"), 1);
    doc[16] = 0;
    doc.set(keccak_256(utf8ToBytes("qntx.speculos")), 17);
    doc[49] = 0;
    doc[50] = 1;
    doc.set(solPub0, 51);
    new DataView(doc.buffer).setUint16(83, body.length, true);
    doc.set(body, 85);
    const msgDone = ok(
      await sign("solana", {
        kind: "solana.message",
        network: SOLANA_NETWORK,
        account: hd(hwId, "solana.bip44-change"),
        message: doc,
        format: "raw",
      }),
    );
    const msgSig = bytesField(signResult(msgDone), "signature");
    expect(ed25519.verify(msgSig, doc, solPub0)).toBe(true);
  }, 300_000);

  it("signs the recorded wpkh and taproot psbts", async () => {
    const cases = [
      ["btc.bip84", "m/84'/0'/0'"],
      ["btc.bip86", "m/86'/0'/0'"],
    ] as const;
    for (const [template, accountPath] of cases) {
      const psbt = psbtFor(template);
      // oxlint-disable-next-line eslint/no-await-in-loop -- one psbt review at a time
      const res = await sign("bitcoin", {
        kind: "bitcoin.psbt",
        origin: "internal",
        network: BTC_NETWORK,
        account: { kind: "hd", walletId: hwId, groupIndex: 0 },
        psbt,
        sign: [{ index: 0, template }],
      });
      const done = ok(res);
      const signed = bytesField(signResult(done), "signedPsbt");
      const xpub = root.derive(accountPath).publicExtendedKey;
      expect(verifyBitcoinPsbtSignatures(signed, [0], xpub, template, BTC_NETWORK)).toBe(true);
      // The signed PSBT must finalize into a spendable transaction.
      const tx = Transaction.fromPSBT(signed, {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
        disableScriptCheck: true,
      });
      tx.finalize();
      expect(tx.extract().length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("shows an unconfirmed-served output's address — the device never hides it as change", async () => {
    /* A group fetched but never verify-address'd pins entries the kernel serves without the
       confirmed seal: an output bound to its /1/3 key decodes as a plain send. The kernel strips
       that output's wallet derivation for the device, so the review must display its address like
       any other payee — app-bitcoin-new hides outputs still carrying the wallet's change
       derivation. */
    ok(
      await runOp(
        h,
        session,
        "bitcoin",
        {
          op: {
            kind: "accounts",
            walletId: hwId,
            groupIndex: 2,
            templates: ["btc.bip84"],
            network: BTC_NETWORK,
          },
          verify: { kind: "hardware" },
        },
        screen("bitcoin"),
        undefined,
      ),
    );
    const done = ok(
      await runOp(
        h,
        session,
        "bitcoin",
        {
          op: {
            kind: "sign",
            request: {
              kind: "bitcoin.psbt",
              origin: "internal",
              network: BTC_NETWORK,
              account: { kind: "hd", walletId: hwId, groupIndex: 2 },
              psbt: psbtWithUnconfirmedOutput(2),
              sign: [{ index: 0, template: "btc.bip84" }],
            },
            acknowledgeUnconfirmed: true,
          },
          verify: { kind: "hardware" },
        },
        screen("bitcoin"),
        "approve",
      ),
    );
    expect(bytesField(signResult(done), "signedPsbt")).toBeInstanceOf(Uint8Array);
    const shown = p2wpkh(pubAt("m/84'/0'/2'/1/3"), btcParams).address;
    // The review chunks the address with spaces — compare without them.
    const flat = screen("bitcoin").texts.map((text) => text.replaceAll(" ", ""));
    expect(flat.some((text) => text.includes(shown))).toBe(true);
  }, 300_000);

  it("signs a legacy bitcoin message", async () => {
    const message = "Hello Ledger Bitcoin!";
    const done = ok(
      await sign("bitcoin", {
        kind: "bitcoin.message",
        network: BTC_NETWORK,
        account: hd(hwId, "btc.bip44"),
        address: btc44Address0,
        message,
        format: "legacy",
        change: 0,
        index: 0,
      }),
    );
    const signature = strField(signResult(done), "signature");
    // BIP-137 compact signature — recover the key and compare it to the seed's m/44'/0'/0'/0/0.
    const compact = new Uint8Array(Buffer.from(signature, "base64"));
    expect(compact).toHaveLength(65);
    const header = must(compact[0], "header");
    const recovered = secp256k1.recoverPublicKey(
      Uint8Array.of((header - 27) % 4, ...compact.subarray(1)),
      btcMessageHash(utf8ToBytes(message)),
      { prehash: false },
    );
    expect(hex(secp256k1.Point.fromBytes(recovered).toBytes(true))).toBe(
      hex(pubAt("m/44'/0'/0'/0/0")),
    );
  }, 300_000);
});
