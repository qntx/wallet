/**
 * Review PoC R15-01 (kernel side): an internal send ratchets the sealed change mark by the full gap
 * limit without any far input ever existing. `prepareBitcoinPsbt` raises the mark to the highest
 * hidden change index, and `isDiscoverableChange` reaches `mark + BITCOIN_GAP_LIMIT` — so a change
 * output parked exactly at the scan reach is hidden _and_ sealed, moving the reach one gap limit
 * further out. Three consecutive internal sends walk the sealed mark 0 → 20 → 40 → 60 on
 * receive-chain inputs alone; each send legitimizes a change index the previous state could not
 * scan to.
 *
 * Asserts today's behaviour — the test passes now and fails once a hidden change output can no
 * longer raise the sealed mark past the request's own evidence.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "@qntx/wallet-chains";
import { bitcoinNetwork, changeScanReach, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { Harness, KernelResponse } from "../harness.ts";
import { createHarness } from "../harness.ts";
import { loadVectors } from "../helpers.ts";

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
function strField(value: ProtocolValue, key: string): string {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`field ${key}: not a string`);
  }
  return v;
}
function numField(value: ProtocolValue, key: string): number {
  const v = field(value, key);
  if (typeof v !== "number") {
    throw new TypeError(`field ${key}: not a number`);
  }
  return v;
}

const vectors = loadVectors("templates/chains.json") as {
  mnemonic: string;
  master: { fingerprint: string };
};

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = new Uint8Array(32).fill(1);
const PASSKEY = () => ({
  kind: "passkey",
  credentialId: new Uint8Array(CREDENTIAL_ID),
  prf: new Uint8Array(PRF_VAULT),
});
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const MASTER_FP = 0x73c5da0a;
const HARDENED = 0x80000000;

const seed = mnemonicToSeedSync(vectors.mnemonic);
const childOf = (purpose: number, change: number, index: number, coin = 0): HDKey =>
  HDKey.fromMasterSeed(seed).derive(`m/${purpose}'/${coin}'/0'/${change}/${index}`);
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
const PAYEE_SCRIPT = p2wpkh(
  HDKey.fromMasterSeed(new Uint8Array(64).fill(3)).derive("m/0/0").publicKey!,
  bitcoinNetwork(BTC_NETWORK).params,
).script;

/** A PSBT spending one receive-chain key to a payee plus each listed own output. */
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
  }>,
  coin = 0,
): Uint8Array => {
  const purposeOf: Readonly<Record<string, number>> = {
    "btc.bip44": 44,
    "btc.bip49": 49,
    "btc.bip84": 84,
    "btc.bip86": 86,
  };
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  for (const [i, spec] of inputs.entries()) {
    const purpose = purposeOf[spec.template] ?? 84;
    const change = spec.change ?? 0;
    const index = spec.index ?? 0;
    const pub = childOf(purpose, change, index, coin).publicKey!;
    const script = scriptFor(purpose, pub);
    const path = [purpose + HARDENED, coin + HARDENED, HARDENED, change, index];
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({
      txid: hex((i + 16).toString(16).padStart(4, "0").repeat(16)),
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
      bip32Derivation: [[pub, { fingerprint: MASTER_FP, path }]],
    });
  }
  tx.addOutput({ script: PAYEE_SCRIPT, amount: 90_000n });
  for (const spec of outputs) {
    const pub = childOf(spec.purpose, spec.change, spec.index, coin).publicKey!;
    const path = [spec.purpose + HARDENED, coin + HARDENED, HARDENED, spec.change, spec.index];
    tx.addOutput({ script: scriptFor(spec.purpose, pub), amount: 1000n });
    tx.updateOutput(tx.outputsLength - 1, {
      bip32Derivation: [[pub, { fingerprint: MASTER_FP, path }]],
    });
  }
  return tx.toPSBT(0);
};

const psbtRequest = (
  walletId: string,
  origin: "internal" | "external",
  inputs: Parameters<typeof ownPsbt>[0],
  outputs: Parameters<typeof ownPsbt>[1],
  groupIndex = 0,
): SignRequest =>
  normalizeBitcoin({
    kind: "bitcoin.psbt",
    origin,
    network: BTC_NETWORK,
    account: { kind: "hd", walletId, groupIndex },
    psbt: ownPsbt(inputs, outputs),
    sign: inputs.map((input, index) => ({ index, template: input.template })),
  });

const setup = async (opts?: Parameters<typeof createHarness>[0]) => {
  const h = createHarness(opts);
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(vectors.mnemonic),
      factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
    }),
  );
  const session = strField(res, "session");
  ok(await h.call("vault.setBlindSigning", { enabled: true, verify: PASSKEY() }, session));
  return { h, session, walletId: strField(field(res, "wallet"), "walletId") };
};

const sign = async (h: Harness, session: string, request: SignRequest): Promise<KernelResponse> =>
  h.call("chain.sign", { request, verify: PASSKEY() }, session);

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

describe("R15-01 kernel: one internal send seals +20 into the change mark", () => {
  it("three internal sends walk the sealed mark 0 → 20 → 40 → 60 on receive inputs alone", async () => {
    const { h, session, walletId } = await setup();
    await expect(accountMark(h, session, walletId)).resolves.toBe(0);

    // Every send: a receive-chain input (change = 0, so `requestChangeMark` contributes nothing)
    // and a change output parked exactly at `changeScanReach(mark)`. The output is hidden as
    // change by `isDiscoverableChange`, and the same index is then sealed as the raise — the
    // scan's own window becomes the evidence for extending it.
    const marks: number[] = [];
    for (let step = 0; step < 3; step += 1) {
      const mark = step * 20;
      const request = psbtRequest(
        walletId,
        "internal",
        [{ template: "btc.bip84" }],
        [{ purpose: 84, change: 1, index: changeScanReach(mark) }],
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- each send must seal before the next builds on it
      ok(await sign(h, session, request));
      // oxlint-disable-next-line eslint/no-await-in-loop -- reads the mark the previous send sealed
      marks.push(await accountMark(h, session, walletId));
    }
    expect(marks).toStrictEqual([20, 40, 60]);
  });

  it("control: an external request hides the same output but seals no raise", async () => {
    const { h, session, walletId } = await setup();
    const request = psbtRequest(
      walletId,
      "external",
      [{ template: "btc.bip84" }],
      [{ purpose: 84, change: 1, index: changeScanReach(0) }],
    );
    ok(await sign(h, session, request));
    await expect(accountMark(h, session, walletId)).resolves.toBe(0);
  });
});
