/**
 * DApp PSBTs (Bitcoin Wallet Standard `signTransaction`): a dApp-built PSBT carries no derivation
 * data, so the engine adds it for the inputs it was asked to sign — and only for inputs whose
 * prevout script is one of the account's scanned addresses, under the template the sign entry
 * names. Outputs to the group's own scripts get the same binding so the kernel marks them as
 * change-like. The kernel re-derives and checks every entry; nothing added here is trusted.
 */
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";

import { ChainError } from "@qntx/wallet-chains";
import {
  bitcoinAddressFromXpub,
  bitcoinNetwork,
  bitcoinPubkeyFromXpub,
  normalizeBitcoin,
} from "@qntx/wallet-chains/bitcoin";
import type { ChainsApi } from "@qntx/wallet/chains";

import type {
  BitcoinAccount,
  BitcoinGroup,
  BitcoinPsbtInput,
  BitcoinSigHash,
  PreparedBitcoinPsbt,
} from "../requests/types.ts";
import { accountPath, broadcastPsbt } from "../transactions/bitcoin.ts";
import type { SignResult } from "../transactions/route.ts";
import { scanChain, scriptPubKey } from "./bitcoin-scan.ts";
import type { Esplora } from "./bitcoin.ts";

const SIGHASH_ALL = 1;
const SIGHASH_DEFAULT = 0;
const SIGHASH_SINGLE_ANYONECANPAY = 0x83;

const invalid = (message: string): ChainError => new ChainError("invalid-request", message);

type Input = ReturnType<Transaction["getInput"]>;

/** The script of the output an input spends — `witnessUtxo`, else the `nonWitnessUtxo` output. */
const prevoutOf = (input: Input): { script: Uint8Array; amount: bigint } | undefined => {
  if (input.witnessUtxo !== undefined) {
    return input.witnessUtxo;
  }
  const outputs: ReadonlyArray<{ script?: Uint8Array; amount?: bigint }> =
    input.nonWitnessUtxo === undefined ? [] : input.nonWitnessUtxo.outputs;
  const output = input.index === undefined ? undefined : outputs[input.index];
  const script = output?.script;
  const amount = output?.amount;
  return script === undefined || amount === undefined ? undefined : { script, amount };
};

/**
 * The sighash the input will be signed with: a PSBT that already names one must agree with the
 * request (`ALL` also accepts taproot's `DEFAULT`); one that names none gets 0x83 written for a
 * listing and stays unset for `ALL`.
 */
const sighashFor = (
  existing: number | undefined,
  requested: BitcoinSigHash,
  taproot: boolean,
  index: number,
): number | undefined => {
  if (requested === "SINGLE|ANYONECANPAY") {
    if (existing !== undefined && existing !== SIGHASH_SINGLE_ANYONECANPAY) {
      throw invalid(`input ${index} already has a different sighash than requested`);
    }
    return SIGHASH_SINGLE_ANYONECANPAY;
  }
  if (
    existing !== undefined &&
    existing !== SIGHASH_ALL &&
    !(taproot && existing === SIGHASH_DEFAULT)
  ) {
    throw invalid(`input ${index} already has a different sighash than requested`);
  }
  return existing;
};

type TemplateDerive = {
  readonly xpub: string;
  readonly fp: number;
  readonly base: ReadonlyArray<number>;
};

const DAPP_TEMPLATES: ReadonlyArray<BitcoinAccount["template"]> = ["btc.bip84", "btc.bip86"];

/**
 * Enriches and normalizes each dApp PSBT for `group`: a sign entry's prevout script must be a
 * scanned address of the template the entry names (a template with no inputs to sign contributes
 * only its fixed 0/0 address), gets that address's derivation, and agrees on the sighash. Outputs
 * to any own script get the same derivation binding.
 */
export const prepareDappPsbts = async (
  apis: Pick<ChainsApi, "account">,
  es: Esplora,
  group: BitcoinGroup,
  network: string,
  psbts: ReadonlyArray<BitcoinPsbtInput>,
): Promise<ReadonlyArray<PreparedBitcoinPsbt>> => {
  const net = bitcoinNetwork(network);
  const signing = new Set(psbts.flatMap((p) => p.sign.map((s) => s.template)));
  const derives = new Map<BitcoinAccount["template"], TemplateDerive>();
  // script hex → owning template and its address path tail.
  const own = new Map<
    string,
    { template: BitcoinAccount["template"]; chain: 0 | 1; index: number }
  >();
  await Promise.all(
    DAPP_TEMPLATES.map(async (template) => {
      const derived = await apis.account({
        walletId: group.walletId,
        groupIndex: group.groupIndex,
        template,
        network,
      });
      if (!("xpub" in derived) || derived.xpub === undefined) {
        throw new Error("bitcoin account carries no xpub");
      }
      const { xpub, fingerprint, path } = derived;
      derives.set(template, {
        xpub,
        fp: Number.parseInt(fingerprint, 16),
        base: accountPath(path),
      });
      // Scan only templates the batch signs; every template binds its fixed 0/0 address.
      const scanned = signing.has(template)
        ? [
            ...(await scanChain(es, xpub, template, network, net.params, 0)),
            ...(await scanChain(es, xpub, template, network, net.params, 1)),
          ]
        : [
            {
              chain: 0 as const,
              index: 0,
              address: bitcoinAddressFromXpub(xpub, template, network, 0, 0),
              used: false,
            },
          ];
      for (const a of scanned) {
        own.set(hex.encode(scriptPubKey(a.address, net.params)), {
          template,
          chain: a.chain,
          index: a.index,
        });
      }
    }),
  );
  const ownScripts = new Set(own.keys());

  const derivation = (
    template: BitcoinAccount["template"],
    chain: 0 | 1,
    index: number,
  ): { pubkey: Uint8Array; der: { fingerprint: number; path: number[] } } => {
    const d = derives.get(template);
    if (d === undefined) {
      throw new Error(`no account derived for ${template}`);
    }
    return {
      pubkey: bitcoinPubkeyFromXpub(d.xpub, template, network, chain, index),
      der: { fingerprint: d.fp, path: [...d.base, chain, index] },
    };
  };

  return psbts.map((entry): PreparedBitcoinPsbt => {
    let tx: Transaction;
    try {
      tx = Transaction.fromPSBT(entry.psbt, { strictPrevoutValidation: true });
    } catch {
      throw invalid("PSBT failed to decode");
    }
    const inputs: Array<{
      index: number;
      value: number;
      sigHash: BitcoinSigHash;
      template: BitcoinAccount["template"];
    }> = [];
    for (const { index, sigHash, template } of entry.sign) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= tx.inputsLength) {
        throw invalid(`input ${String(index)} is out of range`);
      }
      const input = tx.getInput(index);
      const prevout = prevoutOf(input);
      const spend = prevout === undefined ? undefined : own.get(hex.encode(prevout.script));
      if (prevout === undefined || spend === undefined || spend.template !== template) {
        throw invalid(`input ${String(index)} is not this account's`);
      }
      const sighashType = sighashFor(input.sighashType, sigHash, template === "btc.bip86", index);
      const { pubkey, der } = derivation(template, spend.chain, spend.index);
      tx.updateInput(
        index,
        {
          ...(sighashType === undefined ? {} : { sighashType }),
          ...(template === "btc.bip86"
            ? { tapInternalKey: pubkey, tapBip32Derivation: [[pubkey, { hashes: [], der }]] }
            : { bip32Derivation: [[pubkey, der]] }),
        },
        true,
      );
      inputs.push({ index, value: Number(prevout.amount), sigHash, template });
    }
    // Outputs to the group's own scripts are bound as change: the kernel prompt and the
    // engine display agree they are not outflows.
    for (let i = 0; i < tx.outputsLength; i++) {
      const output = tx.getOutput(i);
      const bound = output.script === undefined ? undefined : own.get(hex.encode(output.script));
      if (bound === undefined) {
        continue;
      }
      const { pubkey, der } = derivation(bound.template, bound.chain, bound.index);
      tx.updateOutput(
        i,
        bound.template === "btc.bip86"
          ? { tapInternalKey: pubkey, tapBip32Derivation: [[pubkey, { hashes: [], der }]] }
          : { bip32Derivation: [[pubkey, der]] },
        true,
      );
    }
    const request = normalizeBitcoin({
      kind: "bitcoin.psbt",
      network,
      account: { kind: "hd", walletId: group.walletId, groupIndex: group.groupIndex },
      psbt: tx.toPSBT(0),
      sign: inputs.map(({ index, template }) => ({ index, template })),
    });
    if (request.kind !== "bitcoin.psbt") {
      throw invalid("unexpected request kind");
    }
    return { request, ownScripts, inputs };
  });
};

/**
 * Signs the prepared PSBTs one after another (each prompts). With `send`, every signed PSBT must
 * finalize — a PSBT with inputs this wallet did not sign cannot be broadcast — before any is
 * broadcast.
 */
export const signDappPsbts = async (
  apis: Pick<ChainsApi, "sign">,
  es: Pick<Esplora, "post">,
  prepared: ReadonlyArray<PreparedBitcoinPsbt>,
  send: boolean,
  verify: Parameters<ChainsApi["sign"]>[0]["verify"],
): Promise<{ signedPsbts: Uint8Array[]; txids: string[] }> => {
  const results: SignResult[] = [];
  for (const { request } of prepared) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- signing is sequential: each prompts.
    const result = await apis.sign({ request, verify });
    if (result.kind !== "bitcoin.psbt" || !(result.signedPsbt instanceof Uint8Array)) {
      throw new Error("unexpected bitcoin sign result");
    }
    results.push(result);
  }
  const signedPsbts = results.map((r) =>
    r.kind === "bitcoin.psbt" ? r.signedPsbt : new Uint8Array(),
  );
  if (!send) {
    return { signedPsbts, txids: [] };
  }
  for (const [n, signed] of signedPsbts.entries()) {
    try {
      Transaction.fromPSBT(signed).finalize();
    } catch {
      throw new Error(
        `PSBT ${String(n)} has inputs that cannot be finalized, so it cannot be sent`,
      );
    }
  }
  const txids: string[] = [];
  for (const result of results) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- broadcast is sequential per PSBT.
    txids.push(await broadcastPsbt(es, result));
  }
  return { signedPsbts, txids };
};
