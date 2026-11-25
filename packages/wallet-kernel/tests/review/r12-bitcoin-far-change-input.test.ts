/**
 * Review PoC: `isDiscoverableChange` (packages/wallet-chains/src/bitcoin/own.ts) takes the change
 * index of each signed input from the PSBT's bip32 derivation entry at face value and hides an
 * own change output at any index up to (highest signed change index + 20). An attacker who first
 * dusts the wallet's key at a far change index the gap-20 scan never reaches (e.g. /1/1000000)
 * can have the wallet co-sign a PSBT spending that dust together with a normal UTXO; a change
 * output at /1/1000020 then falls inside the inflated bound, is classified as discoverable
 * change, and disappears from the signing prompt entirely — no outflow row, no
 * `unusual-own-output` warning — while the transaction still signs. These tests assert today's
 * faulty behaviour so they pass on the current tree and fail once the bound is fixed.
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "@qntx/wallet-chains";
import { bitcoinNetwork, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";

import { prepareBitcoin } from "../../src/modules/chains/bitcoin.ts";
import { seedKeys } from "../../src/modules/chains/keys.ts";
import { chainPrompt } from "../../src/modules/chains/prompt.ts";
import { signPlan, taskSignerFor } from "../../src/modules/chains/run.ts";
import { loadVectors } from "../helpers.ts";

const vectors = loadVectors("templates/chains.json") as {
  mnemonic: string;
  master: { fingerprint: string };
  bitcoin: Array<{
    template: string;
    network: string;
    path: string;
    xpub: string;
    receive: string[];
    change: string[];
  }>;
};

const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const MASTER_FP = 0x73c5da0a;
const HARDENED = 0x80000000;
const BTC_PURPOSE_T: Readonly<Record<string, number>> = {
  "btc.bip44": 44,
  "btc.bip49": 49,
  "btc.bip84": 84,
  "btc.bip86": 86,
};

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const PAYEE = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const PAYEE_SCRIPT = OutScript.encode(Address(bitcoinNetwork(BTC_NETWORK).params).decode(PAYEE));

const asPsbt = (r: SignRequest): Extract<SignRequest, { kind: "bitcoin.psbt" }> => {
  if (r.kind !== "bitcoin.psbt") {
    throw new Error("expected bitcoin.psbt");
  }
  return r;
};

const seed = mnemonicToSeedSync(vectors.mnemonic);
const rng = () => new Uint8Array(32);
const account = { kind: "hd" as const, walletId: "w", groupIndex: 0 };

const scriptFor = (purpose: number, pub: Uint8Array): Uint8Array =>
  purpose === 86
    ? p2tr(pub.slice(1)).script
    : purpose === 49
      ? p2sh(p2wpkh(pub)).script
      : purpose === 44
        ? p2pkh(pub).script
        : p2wpkh(pub).script;
const childOf = (purpose: number, change: number, index: number): HDKey =>
  HDKey.fromMasterSeed(seed).derive(`m/${purpose}'/0'/0'/${change}/${index}`);
const btcChild = (template: string, change: number, index: number): HDKey =>
  childOf(BTC_PURPOSE_T[template] ?? 84, change, index);
const addrOf = (purpose: number, change: number, index: number): string =>
  Address(bitcoinNetwork(BTC_NETWORK).params).encode(
    OutScript.decode(scriptFor(purpose, childOf(purpose, change, index).publicKey!)),
  );

/** Same crafted-PSBT builder as the own-output suite in tests/chains.test.ts. */
const ownPsbt = (
  inputs: ReadonlyArray<{
    readonly template: string;
    readonly change?: number;
    readonly index?: number;
  }>,
  outputs: ReadonlyArray<{
    readonly purpose: number;
    readonly change: number;
    readonly index: number;
    readonly amount?: bigint;
  }>,
): Uint8Array => {
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  for (const [i, spec] of inputs.entries()) {
    const purpose = BTC_PURPOSE_T[spec.template] ?? 84;
    const change = spec.change ?? 0;
    const index = spec.index ?? 0;
    const pub = btcChild(spec.template, change, index).publicKey!;
    const script = scriptFor(purpose, pub);
    const path = [purpose + HARDENED, HARDENED, HARDENED, change, index];
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({
      txid: hex((i + 16).toString(16).padStart(4, "0").repeat(16)),
      index: 0,
      sequence: 0xffffffff,
    });
    prev.addOutput({ script, amount: 100_000n });
    const entry: Record<string, unknown> = {
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script, amount: 100_000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [[pub, { fingerprint: MASTER_FP, path }]],
    };
    tx.addInput(entry);
  }
  tx.addOutput({ script: PAYEE_SCRIPT, amount: 90_000n });
  for (const spec of outputs) {
    const pub = childOf(spec.purpose, spec.change, spec.index).publicKey!;
    const path = [spec.purpose + HARDENED, HARDENED, HARDENED, spec.change, spec.index];
    tx.addOutput({ script: scriptFor(spec.purpose, pub), amount: spec.amount ?? 1000n });
    tx.updateOutput(tx.outputsLength - 1, {
      bip32Derivation: [[pub, { fingerprint: MASTER_FP, path }]],
    });
  }
  return tx.toPSBT(0);
};

/** Prepare the built PSBT under the vector seed, then sign its plan. */
const prepare = async (
  inputs: Parameters<typeof ownPsbt>[0],
  outputs: Parameters<typeof ownPsbt>[1],
) => {
  const keys = seedKeys(seed, rng);
  try {
    const request = asPsbt(
      normalizeBitcoin({
        kind: "bitcoin.psbt",
        network: BTC_NETWORK,
        account,
        psbt: ownPsbt(inputs, outputs),
        sign: inputs.map((i, index) => ({ index, template: i.template })),
      }),
    );
    const prepared = await prepareBitcoin(request, account, keys.material);
    const result = await signPlan(prepared.plan, keys.backend(taskSignerFor(prepared.plan)));
    return { prompt: prepared.prompt, result };
  } finally {
    keys.wipe();
  }
};

describe("bitcoin far change input inflates the hidden-change bound", () => {
  it("a dusted /1/1000000 input hides the change output at /1/1000020", async () => {
    const { prompt, result } = await prepare(
      [{ template: "btc.bip84" }, { template: "btc.bip84", change: 1, index: 1_000_000 }],
      [{ purpose: 84, change: 1, index: 1_000_020 }],
    );
    expect(prompt.outflows.filter((o) => o.ownPath !== undefined)).toHaveLength(0);
    expect(prompt.warnings?.filter((w) => w.kind === "unusual-own-output")).toHaveLength(0);
    const text = chainPrompt("en", prompt).description;
    expect(text).not.toContain("1000020");
    expect(text).not.toContain("m/84'/0'/0'/1/");
    expect("signedPsbt" in result).toBe(true);
  });

  it("a dusted /1/2147483600 input hides the change output at /1/2147483620", async () => {
    const { prompt, result } = await prepare(
      [{ template: "btc.bip84" }, { template: "btc.bip84", change: 1, index: 2_147_483_600 }],
      [{ purpose: 84, change: 1, index: 2_147_483_620 }],
    );
    expect(prompt.outflows.filter((o) => o.ownPath !== undefined)).toHaveLength(0);
    expect(prompt.warnings?.filter((w) => w.kind === "unusual-own-output")).toHaveLength(0);
    expect(chainPrompt("en", prompt).description).not.toContain("2147483620");
    expect("signedPsbt" in result).toBe(true);
  });

  it("control: without a far change input the same output is shown with a warning", async () => {
    const { prompt, result } = await prepare(
      [{ template: "btc.bip84" }],
      [{ purpose: 84, change: 1, index: 1_000_020 }],
    );
    const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
    expect(flow?.ownPath).toBe("m/84'/0'/0'/1/1000020");
    expect(flow?.to).toBe(addrOf(84, 1, 1_000_020));
    expect(prompt.warnings).toContainEqual({
      kind: "unusual-own-output",
      message: "m/84'/0'/0'/1/1000020",
    });
    expect("signedPsbt" in result).toBe(true);
  });
});
