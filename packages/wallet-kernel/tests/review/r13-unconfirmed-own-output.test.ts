/**
 * Review PoC R13-01: the kernel's Bitcoin own-output classification (`bitcoinOwn` in
 * src/modules/chains/bitcoin.ts) resolves every output's derivation path through the pinned
 * hardware material without consulting `material.confirmed`. An output paying a key derived
 * under an UNCONFIRMED — possibly foreign — pinned account node is therefore rendered as
 * "Send … to your own address <addr> at unusual path m/…", the strongest self-payment phrasing
 * the prompt has, with no indication the serving entry was never verified on the device. Here a
 * compromised transport substitutes a foreign seed's xpub for the bip44 account node during the
 * pair transcript; `wallet.accounts` then reports btc.bip44 `confirmed: false`, yet a PSBT
 * output to that node's change key still binds as "own". These tests assert today's faulty
 * behaviour so they pass on the current tree and fail once own-output classification treats
 * unconfirmed entries as foreign.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { Address, OutScript, p2pkh, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinNetwork, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { pathToString } from "../../src/derive/pinned.ts";
import { LEDGER_DRIVER } from "../../src/modules/signers/ledger/driver.ts";
import { LEDGER_APPS } from "../../src/modules/signers/ledger/protocol/device.ts";
import { ONEKEY_DRIVER } from "../../src/modules/signers/onekey/driver.ts";
import type { KeystorePrompt } from "../../src/platform.ts";
import { createHarness } from "../harness.ts";
import type { Harness, KernelResponse } from "../harness.ts";
import { fakeKeystore } from "../keystore.ts";
import type { KeystoreCall } from "../keystore.ts";
import { masterFingerprint } from "../signers-fake.ts";
import {
  hex,
  ok as okHex,
  SEED,
  unhex,
  utf8Hex,
  vectorCase,
  xpubAt,
} from "../signers-ledger-fake.ts";

const H = 0x80_00_00_00;
const SEED_B = new Uint8Array(64).fill(0xb0);
const FINGERPRINT = unhex(vectorCase("bitcoin", "fingerprint").result as string);
const MFP = masterFingerprint(SEED);
const MFP_NUMBER = new DataView(MFP.buffer, MFP.byteOffset, MFP.byteLength).getUint32(0);
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const HARDWARE = { kind: "hardware" } as const;

const ACCOUNT_44 = [H + 44, H, H] as const;
const ACCOUNT_84 = [H + 84, H, H] as const;

const hdAt = (seed: Uint8Array, path: ReadonlyArray<number>): HDKey =>
  HDKey.fromMasterSeed(seed).derive(pathToString([...path]));
const xpubAtSeed = (seed: Uint8Array, path: ReadonlyArray<number>): string =>
  hdAt(seed, path).publicExtendedKey;
const pubAt = (seed: Uint8Array, path: ReadonlyArray<number>): Uint8Array => {
  const { publicKey } = hdAt(seed, path);
  if (publicKey === null) {
    throw new Error("no public key");
  }
  return publicKey;
};

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
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

const presencePrompts = (calls: ReadonlyArray<KeystoreCall>): KeystorePrompt[] =>
  calls.flatMap((call) =>
    call.op === "open" && call.protection === "presence" && call.prompt !== undefined
      ? [call.prompt]
      : [],
  );

const lv = (text: string): string => {
  const data = utf8Hex(text);
  return `${(data.length / 2).toString(16).padStart(2, "0")}${data}`;
};
const appAndVersionStep = (app: keyof typeof LEDGER_APPS): string =>
  okHex(`01${lv(LEDGER_APPS[app].name)}${lv(LEDGER_APPS[app].minimum.join("."))}00`);

/** Answers a begin/step operation's `message` exchanges from the queued APDU responses. */
const runOp = async (
  h: Harness,
  session: string,
  begin: KernelResponse,
  responses: string[],
): Promise<ProtocolValue> => {
  const queue = [...responses];
  const opId = strField(ok(begin), "opId");
  let step = field(ok(begin), "step");
  for (let guard = 0; strField(step, "kind") === "exchange" && guard < 64; guard++) {
    const request = field(step, "request");
    if (strField(request, "kind") !== "message") {
      throw new Error(`expected a message request, got ${JSON.stringify(request)}`);
    }
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unscripted exchange ${hex(bytesField(request, "data"))}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- the coroutine advances one turn per step
    const res = await h.call(
      "hardware.step",
      { opId, response: { kind: "message", data: unhex(next) } },
      session,
    );
    if ("err" in res) {
      throw new Error(`hardware.step failed: ${JSON.stringify(res.err)}`);
    }
    step = res.ok;
  }
  expect(queue).toHaveLength(0);
  if (strField(step, "kind") !== "done") {
    throw new Error("the operation did not finish");
  }
  return field(step, "result");
};

/* The pair transcript: fingerprint plus the four group-0 account xpubs, except the bip44 slot
   answers with the foreign SEED_B node — the transport's substitution. */
const PAIR_SCRIPT_SUBSTITUTED = [
  appAndVersionStep("bitcoin"),
  okHex(hex(FINGERPRINT)),
  okHex(utf8Hex(xpubAtSeed(SEED_B, ACCOUNT_44))), // substituted: foreign node, not xpubAt
  okHex(utf8Hex(xpubAt([H + 49, H, H]))),
  okHex(utf8Hex(xpubAt([...ACCOUNT_84]))),
  okHex(utf8Hex(xpubAt([H + 86, H, H]))),
];

/** A PSBT spending the paired wallet's m/84'/0'/0'/0/0 with an output to the foreign bip44
   change key m/44'/0'/0'/1/0 bound by a derivation under the pinned fingerprint. */
const foreignOwnPsbt = (): Uint8Array => {
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  const inPub = pubAt(SEED, [H + 84, H, H, 0, 0]);
  const inScript = p2wpkh(inPub).script;
  const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
  prev.addInput({
    txid: unhex("10".repeat(32)),
    index: 0,
    sequence: 0xffffffff,
  });
  prev.addOutput({ script: inScript, amount: 100_000n });
  tx.addInput({
    txid: prev.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: inScript, amount: 100_000n },
    nonWitnessUtxo: prev.toBytes(true, false),
    bip32Derivation: [
      [inPub, { fingerprint: MFP_NUMBER, path: [H + 84, H, H, 0, 0] }],
    ],
  });
  const payee = OutScript.encode(
    Address(bitcoinNetwork(BTC_NETWORK).params).decode(
      "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
    ),
  );
  tx.addOutput({ script: payee, amount: 90_000n });
  const foreignPub = pubAt(SEED_B, [H + 44, H, H, 1, 0]);
  tx.addOutput({ script: p2pkh(foreignPub).script, amount: 9_000n });
  tx.updateOutput(tx.outputsLength - 1, {
    bip32Derivation: [
      [foreignPub, { fingerprint: MFP_NUMBER, path: [H + 44, H, H, 1, 0] }],
    ],
  });
  return tx.toPSBT(0);
};

describe("an unconfirmed pinned entry binds own outputs with no unconfirmed warning", () => {
  it("a transport-substituted bip44 node pins unconfirmed, then pays 'your own address'", async () => {
    const fake = fakeKeystore();
    const h = createHarness({
      keystore: fake.keystore,
      drivers: { keystone: LEDGER_DRIVER, ledger: LEDGER_DRIVER, onekey: ONEKEY_DRIVER },
    });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const session = strField(res, "session");

    const paired = await runOp(
      h,
      session,
      await h.call(
        "hardware.begin",
        { op: { kind: "pair", device: "ledger" }, verify: HARDWARE },
        session,
      ),
      PAIR_SCRIPT_SUBSTITUTED,
    );
    const hwId = strField(field(paired, "wallet"), "walletId");

    /* The substituted node lands pinned but unconfirmed — it never faced the device. */
    const account = ok(
      await h.call(
        "wallet.accounts",
        { walletId: hwId, groupIndex: 0, template: "btc.bip44", network: BTC_NETWORK },
        session,
      ),
    );
    expect(strField(account, "xpub")).toBe(xpubAtSeed(SEED_B, ACCOUNT_44));
    expect(strField(account, "xpub")).not.toBe(xpubAt([...ACCOUNT_44]));
    expect(field(account, "confirmed")).toBe(false);

    /* A sign request paying that node's change key still classifies it own — shown as a send to
       the user's own address at an unusual path, with no unconfirmed wording anywhere. */
    const request = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "external",
      network: BTC_NETWORK,
      account: { kind: "hd", walletId: hwId, groupIndex: 0 },
      psbt: foreignOwnPsbt(),
      sign: [{ index: 0, template: "btc.bip84" }],
    });
    const before = fake.calls.length;
    const begin = await h.call(
      "hardware.begin",
      { op: { kind: "sign", request }, verify: HARDWARE },
      session,
    );
    const prompts = presencePrompts(fake.calls.slice(before));
    expect(prompts).toHaveLength(1);
    const description = prompts[0]!.description;
    const foreignAddress = Address(bitcoinNetwork(BTC_NETWORK).params).encode(
      OutScript.decode(p2pkh(pubAt(SEED_B, [H + 44, H, H, 1, 0])).script),
    );
    expect(description).toContain(`your own address ${foreignAddress}`);
    expect(description).toContain("m/44'/0'/0'/1/0");
    expect(description.toLowerCase()).not.toContain("unconfirmed");
    expect(description.toLowerCase()).not.toContain("not confirmed");
    expect(description.toLowerCase()).not.toContain("verify on the device");

    if ("ok" in begin) {
      const opId = strField(begin.ok, "opId");
      await h.call("hardware.cancel", { opId }, session);
    }
  });
});
