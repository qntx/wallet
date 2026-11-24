/**
 * Proof of concept (asserts the current, flawed behaviour): `bitcoinOwnScripts` hides any output
 * whose bip32Derivation claims a path of the shape `m/{44,49,84,86}'/coin'/group'/{0,1}/i` with `i
 * < 2^31` — an index the account never derives (the engine's gap limit is 20). An output paying
 * `m/84'/0'/0'/1/2147483646`, or paying the same group's _bip44_ key while the input is bip84, is
 * treated as the user's own change and never reaches the signing prompt, so a drain can masquerade
 * as a fee-only transaction.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2pkh, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinNetwork, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { KeystorePrompt } from "../../src/platform.ts";
import { createHarness } from "../harness.ts";
import type { KernelResponse } from "../harness.ts";
import { fakeKeystore } from "../keystore.ts";
import type { KeystoreCall } from "../keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const HARDENED = 0x80000000;
const SEED = mnemonicToSeedSync(MNEMONIC);
const MASTER_FP = HDKey.fromMasterSeed(SEED).fingerprint;

const child = (purpose: number, change: number, index: number): HDKey =>
  HDKey.fromMasterSeed(SEED).derive(`m/${purpose}'/0'/0'/${change}/${index}`);

const lastPrompt = (calls: ReadonlyArray<KeystoreCall>): KeystorePrompt | undefined =>
  calls.findLast((c): c is KeystoreCall & { prompt?: KeystorePrompt } => "prompt" in c)?.prompt;

const ok = (response: KernelResponse): ProtocolValue => {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
};
const record = (value: ProtocolValue): Record<string, ProtocolValue> => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  return value;
};

const addressOf = (script: Uint8Array): string =>
  Address(bitcoinNetwork(BTC_NETWORK).params).encode(OutScript.decode(script));

/** The keystore harness: a device-factor vault signing under a hardware verify. */
const setup = async () => {
  const fake = fakeKeystore();
  const h = createHarness({ keystore: fake.keystore });
  await h.settle();
  const imported = record(
    ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    ),
  );
  return {
    fake,
    h,
    session: imported["session"] as string,
    walletId: record(imported["wallet"] as ProtocolValue)["walletId"] as string,
  };
};

/**
 * A bip84 spend of the account's own `m/84'/0'/0'/0/0` input with a single output at `script`,
 * attributed to this group by `derivation` — the `output` pair of script + bip32Derivation entry.
 */
const singleOutputPsbt = (output: {
  readonly script: Uint8Array;
  readonly pubkey: Uint8Array;
  readonly path: ReadonlyArray<number>;
}): Uint8Array => {
  const inputKey = child(84, 0, 0);
  const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
  prev.addInput({
    txid: new Uint8Array(32).fill(0x11),
    index: 0,
    sequence: 0xffffffff,
  });
  prev.addOutput({ script: p2wpkh(inputKey.publicKey!).script, amount: 100_000n });
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  tx.addInput({
    txid: prev.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: p2wpkh(inputKey.publicKey!).script, amount: 100_000n },
    nonWitnessUtxo: prev.toBytes(true, false),
    bip32Derivation: [
      [
        inputKey.publicKey!,
        { fingerprint: MASTER_FP, path: [84 + HARDENED, HARDENED, HARDENED, 0, 0] },
      ],
    ],
  });
  tx.addOutput({ script: output.script, amount: 90_000n });
  tx.updateOutput(0, {
    bip32Derivation: [[output.pubkey, { fingerprint: MASTER_FP, path: [...output.path] }]],
  });
  return tx.toPSBT(0);
};

const sign = async (
  h: ReturnType<typeof createHarness>,
  session: string,
  walletId: string,
  psbt: Uint8Array,
): Promise<KernelResponse> =>
  h.call(
    "chain.sign",
    {
      request: normalizeBitcoin({
        kind: "bitcoin.psbt",
        network: BTC_NETWORK,
        account: { kind: "hd", walletId, groupIndex: 0 },
        psbt,
        sign: [{ index: 0, template: "btc.bip84" }],
      }),
      verify: { kind: "hardware" },
    },
    session,
  );

describe("a change output at an index the account never derives is hidden from the prompt", () => {
  it("signs a pay-to-self-looking drain to m/84'/0'/0'/1/2147483646 with no send line", async () => {
    const { fake, h, session, walletId } = await setup();
    const far = child(84, 1, 2_147_483_646);
    const { script } = p2wpkh(far.publicKey!);
    const res = await sign(
      h,
      session,
      walletId,
      singleOutputPsbt({
        script,
        pubkey: far.publicKey!,
        path: [84 + HARDENED, HARDENED, HARDENED, 1, 2_147_483_646],
      }),
    );
    expect("err" in res).toBe(false);
    const prompt = lastPrompt(fake.calls);
    expect(prompt).toBeDefined();
    const description = String(prompt?.description);
    expect(description).not.toContain(addressOf(script));
    expect(description).not.toContain("Send");
  });

  it("also hides the same group's bip44 key at m/44'/0'/0'/0/5 under a bip84 input", async () => {
    const { fake, h, session, walletId } = await setup();
    const legacy = child(44, 0, 5);
    const { script } = p2pkh(legacy.publicKey!);
    const res = await sign(
      h,
      session,
      walletId,
      singleOutputPsbt({
        script,
        pubkey: legacy.publicKey!,
        path: [44 + HARDENED, HARDENED, HARDENED, 0, 5],
      }),
    );
    expect("err" in res).toBe(false);
    const prompt = lastPrompt(fake.calls);
    expect(prompt).toBeDefined();
    const description = String(prompt?.description);
    expect(description).not.toContain(addressOf(script));
    expect(description).not.toContain("Send");
  });
});
