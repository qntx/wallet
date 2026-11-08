import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NETWORK, p2tr, p2wpkh, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import type { ChainAccount } from "@qntx/wallet/chains";

import { prepareDappPsbts } from "../src/chains/bitcoin-dapp.ts";
import type { Esplora } from "../src/chains/bitcoin.ts";
import type { BitcoinPsbtInput } from "../src/requests/types.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MAINNET = "bip122:000000000019d6689c085ae165831e93";
const PAYEE_SCRIPT = p2wpkh(
  HDKey.fromMasterSeed(new Uint8Array(64).fill(3)).derive("m/0/0").publicKey!,
  NETWORK,
).script;

const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const nodeOf = (template: BitcoinAccountTemplate, chain: number, index: number) =>
  master.derive(`m/${template === "btc.bip86" ? 86 : 84}'/0'/0'/${chain}/${index}`);
const scriptOf = (template: BitcoinAccountTemplate, chain = 0, index = 0): Uint8Array =>
  template === "btc.bip86"
    ? p2tr(nodeOf(template, chain, index).publicKey!.slice(1)).script
    : p2wpkh(nodeOf(template, chain, index).publicKey!).script;

const accountFor = (template: BitcoinAccountTemplate): ChainAccount => ({
  template,
  network: MAINNET,
  xpub: master.derive(`m/${template === "btc.bip86" ? 86 : 84}'/0'/0'`).publicExtendedKey,
  fingerprint: master.fingerprint.toString(16).padStart(8, "0"),
  path: `m/${template === "btc.bip86" ? 86 : 84}'/0'/0'`,
});

/** A dApp PSBT: prevouts carry no derivation — the engine is expected to add it. */
const dappPsbt = (
  inputs: ReadonlyArray<{ script: Uint8Array; amount: bigint }>,
  outputs: ReadonlyArray<{ script: Uint8Array; amount: bigint }>,
): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  for (const [i, input] of inputs.entries()) {
    tx.addInput({
      txid: new Uint8Array(32).fill(i + 1),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: input,
    });
  }
  for (const output of outputs) {
    tx.addOutput(output);
  }
  return tx.toPSBT(0);
};

const rig = () => {
  const calls: string[] = [];
  const es: Esplora = {
    get: async (path: string) => {
      calls.push(path);
      return Promise.resolve([]);
    },
    post: async () => Promise.resolve(""),
  };
  const apis = {
    account: async (params: { template: string }): Promise<ChainAccount> =>
      Promise.resolve(
        params.template === "btc.bip84" || params.template === "btc.bip86"
          ? accountFor(params.template)
          : { template: "evm.bip44", network: "eip155:1", address: "0x0" },
      ),
  };
  return { es, apis, calls };
};

const GROUP = { walletId: "w", groupIndex: 0 };
const signEntry = (
  index: number,
  template: "btc.bip84" | "btc.bip86",
): BitcoinPsbtInput["sign"][number] => ({ index, sigHash: "ALL", template });

describe("prepareDappPsbts", () => {
  it(
    "binds each input to its own template and marks own outputs in one mixed PSBT",
    { timeout: 20_000 },
    async () => {
      const { es, apis } = rig();
      const psbt = dappPsbt(
        [
          { script: scriptOf("btc.bip84"), amount: 100000n },
          { script: scriptOf("btc.bip86"), amount: 30000n },
        ],
        [
          { script: PAYEE_SCRIPT, amount: 90000n },
          { script: scriptOf("btc.bip86"), amount: 30000n },
        ],
      );
      const [prepared] = await prepareDappPsbts(apis, es, GROUP, MAINNET, [
        { psbt, sign: [signEntry(0, "btc.bip84"), signEntry(1, "btc.bip86")] },
      ]);
      expect(prepared).toBeDefined();
      const tx = Transaction.fromPSBT(prepared!.request.psbt);
      expect(tx.getInput(0).bip32Derivation?.[0]?.[1].path.join(",")).toBe(
        "2147483732,2147483648,2147483648,0,0",
      );
      const outDer = tx.getOutput(1).tapBip32Derivation;
      expect(outDer).toBeDefined();
      // The ordinals output is the group's own: it stays out of the outflow set.
      expect(prepared!.ownScripts.has(Buffer.from(scriptOf("btc.bip86")).toString("hex"))).toBe(
        true,
      );
      expect(prepared!.request.account).toStrictEqual({
        kind: "hd",
        walletId: "w",
        groupIndex: 0,
      });
      expect(prepared!.request.sign).toStrictEqual([
        { index: 0, template: "btc.bip84" },
        { index: 1, template: "btc.bip86" },
      ]);
    },
  );

  it(
    "refuses an entry whose template disagrees with the prevout's owning template",
    { timeout: 20_000 },
    async () => {
      const { es, apis } = rig();
      const psbt = dappPsbt(
        [{ script: scriptOf("btc.bip86"), amount: 30000n }],
        [{ script: PAYEE_SCRIPT, amount: 29000n }],
      );
      await expect(
        prepareDappPsbts(apis, es, GROUP, MAINNET, [{ psbt, sign: [signEntry(0, "btc.bip84")] }]),
      ).rejects.toMatchObject({
        code: "invalid-request",
        message: "input 0 is not this account's",
      });
      await expect(
        prepareDappPsbts(apis, es, GROUP, MAINNET, [{ psbt, sign: [signEntry(0, "btc.bip86")] }]),
      ).resolves.toBeDefined();
    },
  );

  it("scans only templates the batch signs", { timeout: 20_000 }, async () => {
    const { es, apis, calls } = rig();
    const psbt = dappPsbt(
      [{ script: scriptOf("btc.bip84"), amount: 100000n }],
      [{ script: PAYEE_SCRIPT, amount: 90000n }],
    );
    await prepareDappPsbts(apis, es, GROUP, MAINNET, [{ psbt, sign: [signEntry(0, "btc.bip84")] }]);
    const paymentOnly = calls.length;
    expect(paymentOnly).toBe(40);

    calls.length = 0;
    const both = dappPsbt(
      [
        { script: scriptOf("btc.bip84"), amount: 100000n },
        { script: scriptOf("btc.bip86"), amount: 30000n },
      ],
      [{ script: PAYEE_SCRIPT, amount: 120000n }],
    );
    await prepareDappPsbts(apis, es, GROUP, MAINNET, [
      { psbt: both, sign: [signEntry(0, "btc.bip84"), signEntry(1, "btc.bip86")] },
    ]);
    expect(calls).toHaveLength(80);
  });
});
