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
import type { BitcoinTemplate } from "@qntx/wallet-chains";
import {
  bitcoinAddressFromXpub,
  bitcoinNetwork,
  bitcoinPubkeyFromXpub,
  changeScanReach,
  isDiscoverableChange,
  normalizeBitcoin,
  requestChangeMark,
} from "@qntx/wallet-chains/bitcoin";
import type { BitcoinOwn, BitcoinPathTail } from "@qntx/wallet-chains/bitcoin";
import type { ChainsApi } from "@qntx/wallet/chains";

import type {
  BitcoinGroup,
  BitcoinPsbtInput,
  BitcoinSigHash,
  PreparedBitcoinPsbt,
} from "../requests/types.ts";
import { accountPath, fetchRawTxes } from "../transactions/bitcoin.ts";
import { submitInOrder } from "../transactions/broadcast.ts";
import type { SubmittedBatch } from "../transactions/broadcast.ts";
import type { SignResult } from "../transactions/route.ts";
import { scanChain, scriptPubKey } from "./bitcoin-scan.ts";
import type { Esplora } from "./bitcoin.ts";

const SIGHASH_ALL = 1;
const SIGHASH_DEFAULT = 0;
const SIGHASH_SINGLE_ANYONECANPAY = 0x83;
const HARDENED = 0x80_00_00_00;

const PURPOSE_OF: Readonly<Record<BitcoinTemplate, number>> = {
  "btc.bip44": 44,
  "btc.bip49": 49,
  "btc.bip84": 84,
  "btc.bip86": 86,
};

const invalid = (message: string): ChainError => new ChainError("invalid-request", message);

/** `m/…` notation of a derivation path — hardened indices print with `'`. */
const pathText = (path: ReadonlyArray<number>): string =>
  `m${path.map((i) => (i >= HARDENED ? `/${i - HARDENED}'` : `/${i}`)).join("")}`;

const isPath = (path: unknown): path is number[] =>
  Array.isArray(path) && path.every((p) => typeof p === "number");

/**
 * The path tail of an output carrying a derivation entry this group verifies: the entry claims the
 * template's fingerprint and a path of the account-leaf shape, and the output's script is the
 * key's. Mirrors the kernel's own-output check — tap entries only for bip86, bip32 for the rest —
 * so the engine display agrees with the kernel prompt.
 */
const ownOutputTail = (
  output: {
    readonly script?: Uint8Array;
    readonly bip32Derivation?: ReadonlyArray<
      readonly [Uint8Array, { readonly fingerprint: number; readonly path: unknown }]
    >;
    readonly tapBip32Derivation?: ReadonlyArray<
      readonly [
        Uint8Array,
        {
          readonly hashes: unknown;
          readonly der: { readonly fingerprint: number; readonly path: unknown };
        },
      ]
    >;
  },
  derives: ReadonlyMap<BitcoinTemplate, TemplateDerive>,
  network: string,
  params: Parameters<typeof scriptPubKey>[1],
):
  | {
      readonly tail: BitcoinPathTail;
      readonly path: ReadonlyArray<number>;
      readonly template: BitcoinTemplate;
    }
  | undefined => {
  if (output.script === undefined) {
    return undefined;
  }
  const scriptHex = hex.encode(output.script);
  for (const [template, d] of derives) {
    const path =
      template === "btc.bip86"
        ? output.tapBip32Derivation?.find(([, v]) => v.der.fingerprint === d.fp)?.[1].der.path
        : output.bip32Derivation?.find(([, v]) => v.fingerprint === d.fp)?.[1].path;
    if (!isPath(path)) {
      continue;
    }
    const [purpose, coin, group, change, index] = path;
    if (
      path.length !== 5 ||
      purpose !== d.base[0] ||
      coin !== d.base[1] ||
      group !== d.base[2] ||
      (change !== 0 && change !== 1) ||
      index === undefined ||
      index < 0 ||
      index >= HARDENED
    ) {
      continue;
    }
    const script = hex.encode(
      scriptPubKey(bitcoinAddressFromXpub(d.xpub, template, network, change, index), params),
    );
    if (script === scriptHex) {
      return { tail: { purpose: PURPOSE_OF[template], change, index }, path, template };
    }
  }
  return undefined;
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
  readonly mark: number;
  readonly confirmed: boolean;
};

/**
 * Every template of the group a PSBT input may be under — a QR counterpart may name bip44/49/86
 * where a dApp only requests the two dApp-facing ones.
 */
const PSBT_TEMPLATES: ReadonlyArray<BitcoinTemplate> = [
  "btc.bip44",
  "btc.bip49",
  "btc.bip84",
  "btc.bip86",
];

/**
 * Enriches and normalizes each dApp or QR PSBT for `group`: a sign entry's prevout script must be a
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
  frozen: ReadonlySet<string>,
): Promise<ReadonlyArray<PreparedBitcoinPsbt>> => {
  const net = bitcoinNetwork(network);
  const signing = new Set(psbts.flatMap((p) => p.sign.map((s) => s.template)));
  const derives = new Map<BitcoinTemplate, TemplateDerive>();
  // script hex → owning template and its address path tail.
  const own = new Map<string, { template: BitcoinTemplate; chain: 0 | 1; index: number }>();
  await Promise.all(
    PSBT_TEMPLATES.map(async (template) => {
      const derived = await apis.account({
        walletId: group.walletId,
        groupIndex: group.groupIndex,
        template,
        network,
      });
      if (!("xpub" in derived) || derived.xpub === undefined) {
        throw new Error("bitcoin account carries no xpub");
      }
      const { xpub, fingerprint, path, changeMark, confirmed } = derived;
      derives.set(template, {
        xpub,
        fp: Number.parseInt(fingerprint, 16),
        base: accountPath(path),
        mark: changeMark,
        confirmed,
      });
      // Scan only templates the batch signs; every template binds its fixed 0/0 address.
      const scanned = signing.has(template)
        ? [
            ...(await scanChain(es, xpub, template, network, net.params, 0, -1)),
            ...(await scanChain(
              es,
              xpub,
              template,
              network,
              net.params,
              1,
              changeScanReach(changeMark),
            )),
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
  const derivation = (
    template: BitcoinTemplate,
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

  return Promise.all(
    psbts.map(async (entry): Promise<PreparedBitcoinPsbt> => {
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
        template: BitcoinTemplate;
        frozen: boolean;
      }> = [];
      // Validate every sign entry first; the previous transactions are then fetched in one call.
      const signed = entry.sign.map(({ index, sigHash, template }) => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= tx.inputsLength) {
          throw invalid(`input ${String(index)} is out of range`);
        }
        const input = tx.getInput(index);
        const { txid, index: vout } = input;
        if (txid === undefined || vout === undefined) {
          throw invalid(`input ${String(index)} is not this account's`);
        }
        return { index, sigHash, template, input, txidHex: hex.encode(txid), vout };
      });
      const raws = await fetchRawTxes(
        es,
        [...new Set(signed.map((s) => s.txidHex))].map((txid) => ({ txid })),
      );
      const signedTails: BitcoinPathTail[] = [];
      for (const { index, sigHash, template, input, txidHex, vout } of signed) {
        // The dApp's witnessUtxo is advisory: the prevout comes from the chain. bip84 signing
        // also carries the raw previous transaction so the kernel proves the amount.
        const raw = raws.get(txidHex);
        if (raw === undefined) {
          throw invalid(`input ${String(index)} is not this account's`);
        }
        const prevTx = Transaction.fromRaw(raw, { allowUnknownInputs: true });
        const prevOut = vout >= prevTx.outputsLength ? undefined : prevTx.getOutput(vout);
        const prev =
          prevOut?.script === undefined || prevOut.amount === undefined
            ? undefined
            : { script: prevOut.script, amount: prevOut.amount };
        if (prev === undefined) {
          throw invalid(`input ${String(index)} is not this account's`);
        }
        const declared = input.witnessUtxo;
        if (
          declared !== undefined &&
          (hex.encode(declared.script) !== hex.encode(prev.script) ||
            declared.amount !== prev.amount)
        ) {
          throw invalid(`input ${String(index)} amount or script does not match the chain`);
        }
        const spend = own.get(hex.encode(prev.script));
        if (spend === undefined || spend.template !== template) {
          throw invalid(`input ${String(index)} is not this account's`);
        }
        const sighashType = sighashFor(input.sighashType, sigHash, template === "btc.bip86", index);
        const { pubkey, der } = derivation(template, spend.chain, spend.index);
        tx.updateInput(
          index,
          {
            witnessUtxo: { script: prev.script, amount: prev.amount },
            /* Every non-taproot template carries the raw previous transaction so the kernel can
               prove the amount it signs for. */
            ...(template === "btc.bip86" ? {} : { nonWitnessUtxo: raw }),
            ...(sighashType === undefined ? {} : { sighashType }),
            ...(template === "btc.bip86"
              ? { tapInternalKey: pubkey, tapBip32Derivation: [[pubkey, { hashes: [], der }]] }
              : { bip32Derivation: [[pubkey, der]] }),
          },
          true,
        );
        inputs.push({
          index,
          value: Number(prev.amount),
          sigHash,
          template,
          frozen: frozen.has(`${txidHex}:${String(vout)}`),
        });
        signedTails.push({
          purpose: PURPOSE_OF[template],
          change: spend.chain,
          index: spend.index,
        });
      }
      // Outputs to the group's own scripts get their derivation bound so the kernel can verify
      // and classify them — discoverable change is hidden, the rest shown with its path.
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
        origin: "external",
        psbt: tx.toPSBT(0),
        sign: inputs.map(({ index, template }) => ({ index, template })),
      });
      if (request.kind !== "bitcoin.psbt") {
        throw invalid("unexpected request kind");
      }
      // The same classification the kernel applies to the request's verified own outputs: only
      // change the wallet can reach is hidden, outputs an unconfirmed entry serves are foreign,
      // and every other own-key output is shown with its path. The bound is the kernel-reported
      // mark under the external origin, never the PSBT's inputs.
      const markOf = (purpose: number): number => {
        for (const [template, d] of derives) {
          if (PURPOSE_OF[template] === purpose) {
            return requestChangeMark(d.mark, purpose, signedTails, "external");
          }
        }
        return 0;
      };
      const change = new Set<string>();
      const unusual = new Map<string, string>();
      const unconfirmed = new Set<string>();
      for (let i = 0; i < tx.outputsLength; i++) {
        const output = tx.getOutput(i);
        const found = ownOutputTail(output, derives, network, net.params);
        if (found === undefined || output.script === undefined) {
          continue;
        }
        /* An output a never-confirmed entry serves is not own — never hidden, never worded as
           "your own address"; the kernel prompt shows it as a send with the danger warning and
           demands the same acknowledgement export-account does. The derivation bound above
           stays: the kernel needs it to raise that warning. */
        if (derives.get(found.template)?.confirmed !== true) {
          unconfirmed.add(hex.encode(output.script));
        } else if (isDiscoverableChange(found.tail, signedTails, markOf(found.tail.purpose))) {
          change.add(hex.encode(output.script));
        } else {
          unusual.set(hex.encode(output.script), pathText(found.path));
        }
      }
      const classified: BitcoinOwn = { change, unusual, unconfirmed };
      return { request, own: classified, inputs };
    }),
  );
};

/**
 * Signs the prepared PSBTs one after another (each prompts). With `send`, every signed PSBT must
 * finalize — a PSBT with inputs this wallet did not sign cannot be broadcast — before any is
 * broadcast. Broadcasts run in order through `submitInOrder`: a stop past the first returns it as
 * `stopped` with the txids already out, since a later PSBT may depend on the unsent one.
 */
export const signDappPsbts = async (
  apis: Pick<ChainsApi, "sign">,
  prepared: ReadonlyArray<PreparedBitcoinPsbt>,
  send: boolean,
  verify: Parameters<ChainsApi["sign"]>[0]["verify"],
  commit: () => void,
  broadcast: (prepared: PreparedBitcoinPsbt, result: SignResult) => Promise<string>,
): Promise<{
  signedPsbts: Uint8Array[];
  txids: string[];
  stopped?: SubmittedBatch["stopped"];
}> => {
  const results: SignResult[] = [];
  for (const { request, own } of prepared) {
    /* A PSBT carrying an output an unconfirmed entry serves needs the acknowledgement — the
       approve step already gated on the danger finding, so it is always granted here. */
    // oxlint-disable-next-line eslint/no-await-in-loop -- signing is sequential: each prompts.
    const result = await apis.sign({
      request,
      verify,
      ...(own.unconfirmed.size > 0 ? { acknowledgeUnconfirmed: true } : {}),
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
  commit();
  const batch = await submitInOrder(results.length, async (n) => {
    const entry = prepared[n];
    const result = results[n];
    if (entry === undefined || result === undefined) {
      throw new Error("sign result without its prepared PSBT");
    }
    return broadcast(entry, result);
  });
  return {
    signedPsbts,
    txids: [...batch.ids],
    ...(batch.stopped === undefined ? {} : { stopped: batch.stopped }),
  };
};
