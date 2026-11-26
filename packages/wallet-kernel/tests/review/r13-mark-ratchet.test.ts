/**
 * Review PoC R13-04 (low-severity DoS): the kernel commits `hidden` — the highest own-output
 * index classified as discoverable change — into the sealed change mark on every approved
 * `bitcoin.psbt` signature, whatever the request's origin (src/modules/chains/bitcoin.ts,
 * prepareBitcoinPsbt's `raises`). An external caller therefore ratchets the mark 20 indexes per
 * approved signature without any of its transactions ever being broadcast or hitting the chain:
 * k signatures hide outputs at /1/(20·k) and push the stored mark to 20·k. The engine's rescan
 * walks every index to `changeScanReach(mark)` on every refresh, so an unbounded ratchet
 * inflates scan work toward the 2000-entry cap at no cost to the attacker. These tests assert
 * today's faulty behaviour so they pass on the current tree and fail once external requests stop
 * committing hidden-index raises.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "@qntx/wallet-chains";
import { bitcoinNetwork, changeScanReach, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { KeystorePrompt } from "../../src/platform.ts";
import { createHarness } from "../harness.ts";
import type { Harness, KernelResponse } from "../harness.ts";
import { loadVectors } from "../helpers.ts";
import { fakeKeystore } from "../keystore.ts";
import type { KeystoreCall } from "../keystore.ts";

const vectors = loadVectors("templates/chains.json") as {
  mnemonic: string;
  master: { fingerprint: string };
};

const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const MASTER_FP = 0x73c5da0a;
const HARDENED = 0x80000000;

const seed = mnemonicToSeedSync(vectors.mnemonic);
const childOf = (purpose: number, change: number, index: number): HDKey =>
  HDKey.fromMasterSeed(seed).derive(`m/${purpose}'/0'/0'/${change}/${index}`);
const scriptFor = (purpose: number, pub: Uint8Array): Uint8Array =>
  purpose === 86
    ? p2tr(pub.slice(1)).script
    : purpose === 49
      ? p2sh(p2wpkh(pub)).script
      : purpose === 44
        ? p2pkh(pub).script
        : p2wpkh(pub).script;
const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
const PAYEE = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const PAYEE_SCRIPT = OutScript.encode(Address(bitcoinNetwork(BTC_NETWORK).params).decode(PAYEE));

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
  const v = value[key];
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
const numField = (value: ProtocolValue, key: string): number => {
  const v = field(value, key);
  if (typeof v !== "number") {
    throw new TypeError(`${key} is not a number`);
  }
  return v;
};

const openPrompts = (calls: ReadonlyArray<KeystoreCall>): KeystorePrompt[] =>
  calls.flatMap((call) =>
    call.op === "open" && call.protection === "presence" && call.prompt !== undefined
      ? [call.prompt]
      : [],
  );

/**
 * A PSBT spending one own bip84 receive input (/0/0) and paying one own output at
 * m/84'/0'/0'/1/{index} bound with its bip32 derivation — the same crafted-PSBT shape as
 * tests/change-marks.test.ts.
 */
const ratchetPsbt = (index: number): Uint8Array => {
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  const pub = childOf(84, 0, 0).publicKey!;
  const script = scriptFor(84, pub);
  const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
  prev.addInput({
    txid: hex("10".padStart(4, "0").repeat(16)),
    index: 0,
    sequence: 0xffffffff,
  });
  prev.addOutput({ script, amount: 100_000n });
  tx.addInput({
    txid: prev.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script, amount: 100_000n },
    nonWitnessUtxo: prev.toBytes(true, false),
    bip32Derivation: [[pub, { fingerprint: MASTER_FP, path: [HARDENED + 84, HARDENED, HARDENED, 0, 0] }]],
  });
  tx.addOutput({ script: PAYEE_SCRIPT, amount: 90_000n });
  const changePub = childOf(84, 1, index).publicKey!;
  const changePath = [HARDENED + 84, HARDENED, HARDENED, 1, index];
  tx.addOutput({ script: scriptFor(84, changePub), amount: 1000n });
  tx.updateOutput(tx.outputsLength - 1, {
    bip32Derivation: [[changePub, { fingerprint: MASTER_FP, path: changePath }]],
  });
  return tx.toPSBT(0);
};

const accountMark = async (h: Harness, session: string, walletId: string): Promise<number> =>
  numField(
    ok(
      await h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "btc.bip84", network: BTC_NETWORK },
        session,
      ),
    ),
    "changeMark",
  );

describe("external signatures ratchet the sealed change mark without broadcasting", () => {
  it("five external signs raise the mark to 100, hiding each output on the way", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: DEVICE,
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    await expect(accountMark(h, session, walletId)).resolves.toBe(0);

    for (let k = 1; k <= 5; k++) {
      const index = 20 * k;
      const request = normalizeBitcoin({
        kind: "bitcoin.psbt",
        origin: "external",
        network: BTC_NETWORK,
        account: { kind: "hd", walletId, groupIndex: 0 },
        psbt: ratchetPsbt(index),
        sign: [{ index: 0, template: "btc.bip84" }],
      }) as SignRequest;
      const before = fake.calls.length;
      // oxlint-disable-next-line no-await-in-loop -- each ratchet step needs the previous commit
      ok(await h.call("chain.sign", { request, verify: HARDWARE }, session));
      /* The /1/{index} output was classified discoverable change: the prompt showed only the
         payee — no "your own address" row names the hidden path. */
      const shown = openPrompts(fake.calls.slice(before)).at(-1);
      expect(shown?.description).toContain(PAYEE);
      expect(shown?.description).not.toContain("your own address");
      expect(shown?.description).not.toContain(`m/84'/0'/0'/1/${index}`);
      /* …and the sealed mark still jumped to the hidden index — nothing was broadcast. */
      // oxlint-disable-next-line no-await-in-loop -- same reason
      await expect(accountMark(h, session, walletId)).resolves.toBe(index);
    }
  });

  it("the engine's rescan reach follows the mark unbounded until the 2000 cap", () => {
    expect(changeScanReach(100)).toBe(120);
    expect(changeScanReach(5000)).toBe(1999);
  });
});
