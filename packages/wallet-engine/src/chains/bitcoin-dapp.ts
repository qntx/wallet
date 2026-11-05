/**
 * DApp PSBTs (Bitcoin Wallet Standard `signTransaction`): a dApp-built PSBT carries no derivation
 * data, so the engine adds it for the inputs it was asked to sign — and only for inputs whose
 * prevout script is one of this account's scanned addresses. The kernel re-derives and checks every
 * entry; nothing added here is trusted.
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

/**
 * Enriches and normalizes each dApp PSBT for `account`: the requested inputs must spend scanned
 * addresses of the account's template, get that address's derivation, and agree on the sighash.
 */
export const prepareDappPsbts = async (
  apis: Pick<ChainsApi, "account">,
  es: Esplora,
  account: BitcoinAccount,
  network: string,
  psbts: ReadonlyArray<BitcoinPsbtInput>,
): Promise<ReadonlyArray<PreparedBitcoinPsbt>> => {
  const { template } = account;
  const derived = await apis.account({
    walletId: account.walletId,
    groupIndex: account.groupIndex,
    template,
    network,
  });
  if (!("xpub" in derived) || derived.xpub === undefined) {
    throw new Error("bitcoin account carries no xpub");
  }
  const { xpub, fingerprint, path } = derived as {
    xpub: string;
    fingerprint: string;
    path: string;
  };
  const fp = Number.parseInt(fingerprint, 16);
  const net = bitcoinNetwork(network);
  const base = accountPath(path);
  const taproot = template === "btc.bip86";
  const scanned = [
    ...(await scanChain(es, xpub, template, network, net.params, 0)),
    ...(await scanChain(es, xpub, template, network, net.params, 1)),
  ];
  // The fixed address the dApp was handed is always the account's, scanned or not.
  const own = new Map<string, { chain: 0 | 1; index: number }>([
    ...scanned.map((a): [string, { chain: 0 | 1; index: number }] => [
      hex.encode(scriptPubKey(a.address, net.params)),
      { chain: a.chain, index: a.index },
    ]),
    [hex.encode(scriptPubKey(account.address, net.params)), { chain: 0, index: 0 }],
  ]);
  if (bitcoinAddressFromXpub(xpub, template, network, 0, 0) !== account.address) {
    throw invalid("the account address is not the wallet's address for this purpose");
  }
  const ownScripts = new Set(own.keys());

  return psbts.map((entry): PreparedBitcoinPsbt => {
    let tx: Transaction;
    try {
      tx = Transaction.fromPSBT(entry.psbt, { strictPrevoutValidation: true });
    } catch {
      throw invalid("PSBT failed to decode");
    }
    const inputs: Array<{ index: number; value: number; sigHash: BitcoinSigHash }> = [];
    for (const { index, sigHash } of entry.sign) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= tx.inputsLength) {
        throw invalid(`input ${String(index)} is out of range`);
      }
      const input = tx.getInput(index);
      const prevout = prevoutOf(input);
      const spend = prevout === undefined ? undefined : own.get(hex.encode(prevout.script));
      if (prevout === undefined || spend === undefined) {
        throw invalid(`input ${String(index)} is not this wallet's`);
      }
      const sighashType = sighashFor(input.sighashType, sigHash, taproot, index);
      const pubkey = bitcoinPubkeyFromXpub(xpub, template, network, spend.chain, spend.index);
      const der = { fingerprint: fp, path: [...base, spend.chain, spend.index] };
      tx.updateInput(
        index,
        {
          ...(sighashType === undefined ? {} : { sighashType }),
          ...(taproot
            ? { tapInternalKey: pubkey, tapBip32Derivation: [[pubkey, { hashes: [], der }]] }
            : { bip32Derivation: [[pubkey, der]] }),
        },
        true,
      );
      inputs.push({ index, value: Number(prevout.amount), sigHash });
    }
    const request = normalizeBitcoin({
      kind: "bitcoin.psbt",
      network,
      account: {
        kind: "hd",
        walletId: account.walletId,
        groupIndex: account.groupIndex,
        template,
      },
      psbt: tx.toPSBT(0),
      sign: inputs.map((i) => i.index).sort((a, b) => a - b),
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
  account: BitcoinAccount,
  es: Pick<Esplora, "post">,
  prepared: ReadonlyArray<PreparedBitcoinPsbt>,
  send: boolean,
  verify: Parameters<ChainsApi["sign"]>[0]["verify"],
): Promise<{ signedPsbts: Uint8Array[]; txids: string[] }> => {
  const results: SignResult[] = [];
  for (const { request } of prepared) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- signing is sequential: each prompts.
    const result = await apis.sign({
      request: {
        ...request,
        account: {
          kind: "hd",
          walletId: account.walletId,
          groupIndex: account.groupIndex,
          template: account.template,
        },
      },
      verify,
    });
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
