/**
 * Pure QR request binding: a decoded `QrRequest` is matched against the selected account's
 * authenticated facts — fingerprint, derivation path, declared address, enabled networks — and
 * turned into candidate `RequestInput`s for the existing request pipeline. Solana and TRON
 * transactions produce one candidate per enabled network (mainnet first): a lifetime/cluster
 * binding failure there means trying the next candidate.
 *
 * No wallet I/O happens here — `QrAccountFacts` carries everything the wallet already proved.
 */
import { OutScript, Transaction } from "@scure/btc-signer";

import type { BitcoinTemplate, KeyPath } from "@qntx/wallet-chains";
import { parseTypedData } from "@qntx/wallet-chains/evm";
import { parseCompiledMessage } from "@qntx/wallet-chains/solana";

import type {
  BitcoinSignInput,
  EvmSignInput,
  SolanaSignInput,
  TronSignInput,
} from "../requests/controller.ts";
import type { BitcoinPsbtInput, BitcoinSigHash, QrOrigin } from "../requests/types.ts";
import type { AccountRef } from "../transactions/route.ts";
import { QrError, qrGuard } from "./errors.ts";
import { BITCOIN_MAINNET, PURPOSE_TEMPLATE } from "./link.ts";
import type { QrRequest } from "./request.ts";

/**
 * Everything binding checks against: the selected account's authenticated facts — the master
 * fingerprint (hardware's is authenticated device info; a vault's or card's comes from its Bitcoin
 * account), the resolved leaf addresses per family, and the enabled networks per family.
 */
export type QrAccountFacts = {
  readonly walletId: string;
  readonly groupIndex: number;
  /** The master key fingerprint as a number — what a UR request's `sourceFingerprint` carries. */
  readonly fingerprint: number;
  /** The resolved leaf address per family — only the request's own family is guaranteed present. */
  readonly addresses: {
    readonly evm?: string;
    readonly tron?: string;
    readonly solana?: string;
  };
  /** Enabled CAIP-2 ids per family; `solana`/`tron` are ordered mainnet first. */
  readonly networks: {
    readonly evm: ReadonlyArray<string>;
    readonly solana: ReadonlyArray<string>;
    readonly tron: ReadonlyArray<string>;
    readonly bitcoin: ReadonlyArray<string>;
  };
};

const HARDENED = 0x80_00_00_00;

/** The leaf path each family's account template derives at for `groupIndex`. */
const leafPath = (family: "evm" | "tron" | "solana", groupIndex: number): KeyPath =>
  family === "evm"
    ? [44 + HARDENED, 60 + HARDENED, HARDENED, 0, groupIndex]
    : family === "tron"
      ? [44 + HARDENED, 195 + HARDENED, HARDENED, 0, groupIndex]
      : [44 + HARDENED, 501 + HARDENED, groupIndex + HARDENED, HARDENED];

const samePath = (a: KeyPath, b: KeyPath): boolean =>
  a.length === b.length && a.every((step, index) => step === b[index]);

const mismatch = (what: string): QrError =>
  new QrError("account-mismatch", `the request's ${what} is not this account's`);

/**
 * The fingerprint, the leaf path and — when the request declares one — the address must all be the
 * selected account's, or the request was meant for another key entirely.
 */
const requireAccount = (
  request: { readonly path: KeyPath; readonly xfp: number; readonly address?: string },
  facts: QrAccountFacts,
  family: "evm" | "tron" | "solana",
): void => {
  if (request.xfp !== facts.fingerprint) {
    throw mismatch("fingerprint");
  }
  if (!samePath(request.path, leafPath(family, facts.groupIndex))) {
    throw mismatch("derivation path");
  }
  const { address } = request;
  if (address === undefined) {
    return;
  }
  const own = facts.addresses[family];
  if (family === "evm" ? address.toLowerCase() !== own?.toLowerCase() : address !== own) {
    throw mismatch("address");
  }
};

const qrOrigin = (declared: string | undefined): QrOrigin => ({
  kind: "qr",
  ...(declared === undefined ? {} : { declared }),
});

/** `domain.chainId` as a number, when present — the same reading wallet-chains' normalize uses. */
const typedDataChainId = (typedData: string): number | undefined => {
  const { json } = qrGuard("malformed", () => parseTypedData(typedData));
  const { chainId } = json.domain;
  if (chainId === undefined) {
    return undefined;
  }
  const numeric =
    typeof chainId === "number"
      ? chainId
      : typeof chainId === "string" && /^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(chainId)
        ? Number(chainId)
        : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new QrError("malformed", "typed-data domain.chainId is malformed");
  }
  return numeric;
};

const evmCandidates = (
  request: QrRequest & { family: "evm" },
  facts: QrAccountFacts,
): EvmSignInput => {
  requireAccount(request, facts, "evm");
  const account: AccountRef = {
    kind: "hd",
    walletId: facts.walletId,
    groupIndex: facts.groupIndex,
    template: "evm.bip44",
  };
  const origin = qrOrigin(request.declared);
  if (request.kind === "transaction") {
    const { tx } = request;
    if (tx.type === "eip7702") {
      throw new QrError("unsupported", "an EIP-7702 authorization cannot be a QR request");
    }
    if (tx.to === undefined) {
      throw new QrError("contract-creation", "a QR request cannot create a contract");
    }
    if (request.chainId !== undefined && request.chainId !== tx.chainId) {
      throw new QrError("chain-mismatch", "the request's chain id is not its transaction's");
    }
    const network = `eip155:${tx.chainId}`;
    if (!facts.networks.evm.includes(network)) {
      throw new QrError("network-unknown", `network ${network} is not enabled`);
    }
    if (tx.data !== "0x" && tx.to.toLowerCase() === facts.addresses.evm?.toLowerCase()) {
      throw new QrError("self-call", "a QR request cannot call the signing account");
    }
    return {
      method: "evm-sign",
      origin,
      account,
      network,
      request: { kind: "evm.transaction", network, account, tx },
    };
  }
  if (request.kind === "typed-data") {
    const domainChain = typedDataChainId(request.typedData);
    if (
      domainChain !== undefined &&
      request.chainId !== undefined &&
      domainChain !== request.chainId
    ) {
      throw new QrError("chain-mismatch", "the request's chain id is not its domain's");
    }
    const bound = domainChain ?? request.chainId;
    /* A carried chain id binds the signature, so the network must be one the wallet serves;
       with no chain at all the network is a display label only. */
    const network = `eip155:${bound ?? 1}`;
    if (bound !== undefined && !facts.networks.evm.includes(network)) {
      throw new QrError("network-unknown", `network ${network} is not enabled`);
    }
    return {
      method: "evm-sign",
      origin,
      account,
      network,
      request: { kind: "evm.typed-data", network, account, typedData: request.typedData },
    };
  }
  const network = `eip155:${request.chainId ?? 1}`;
  return {
    method: "evm-sign",
    origin,
    account,
    network,
    request: { kind: "evm.personal-message", network, account, message: request.message },
  };
};

/** Bitcoin-style shortvec: 7-bit groups, low to high, continuation bit on all but the last. */
const shortvec = (n: number): Uint8Array => {
  const out: number[] = [];
  let rest = n;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) {
      byte += 128;
    }
    out.push(byte);
  } while (rest > 0);
  return new Uint8Array(out);
};

const solanaCandidates = (
  request: QrRequest & { family: "solana" },
  facts: QrAccountFacts,
): ReadonlyArray<SolanaSignInput> => {
  requireAccount(request, facts, "solana");
  const address = facts.addresses.solana;
  if (address === undefined) {
    /* `accountFacts` resolves the request's own family or already refused — never bind a
       signature slot against an empty address. */
    throw new QrError("wallet-unsupported", "the account has no solana address");
  }
  const account = { walletId: facts.walletId, groupIndex: facts.groupIndex, address };
  const origin = qrOrigin(request.declared);
  if (request.kind === "message") {
    const [network] = facts.networks.solana;
    if (network === undefined) {
      throw new QrError("network-unknown", "no solana network is enabled");
    }
    return [
      {
        method: "solana-sign",
        origin,
        account,
        network,
        request: { kind: "message", message: request.data },
      },
    ];
  }
  const parsed = qrGuard("malformed", () => parseCompiledMessage(request.data));
  /* The account must be a required signer of the message — else this request is not for it. */
  if (!parsed.staticAccounts.slice(0, parsed.numRequiredSignatures).includes(account.address)) {
    throw mismatch("signer");
  }
  /* `transactions` carries whole wires: the account's signature slot rides along zeroed. */
  const count = shortvec(parsed.numRequiredSignatures);
  const wire = new Uint8Array(
    count.length + 64 * parsed.numRequiredSignatures + request.data.length,
  );
  wire.set(count, 0);
  wire.set(request.data, count.length + 64 * parsed.numRequiredSignatures);
  return facts.networks.solana.map((network): SolanaSignInput => ({
    method: "solana-sign",
    origin,
    account,
    network,
    request: { kind: "transactions", transactions: [wire], send: false },
  }));
};

const tronCandidates = (
  request: QrRequest & { family: "tron" },
  facts: QrAccountFacts,
): ReadonlyArray<TronSignInput> => {
  requireAccount(request, facts, "tron");
  const account: AccountRef = {
    kind: "hd",
    walletId: facts.walletId,
    groupIndex: facts.groupIndex,
    template: "tron.bip44",
  };
  const origin = qrOrigin(request.declared);
  if (request.kind === "message") {
    const [network] = facts.networks.tron;
    if (network === undefined) {
      throw new QrError("network-unknown", "no tron network is enabled");
    }
    return [
      {
        method: "tron-sign",
        origin,
        account,
        network,
        request: { kind: "tron.message", network, account, message: request.data },
      },
    ];
  }
  return facts.networks.tron.map((network): TronSignInput => ({
    method: "tron-sign",
    origin,
    account,
    network,
    request: { kind: "tron.transaction", network, account, rawData: request.data },
  }));
};

const SIGHASH_ALL = 1;
const SIGHASH_DEFAULT = 0;
const SIGHASH_SINGLE_ANYONECANPAY = 0x83;

/** The script type that template's prevout must carry — `OutScript.decode` names are lowercase. */
const PURPOSE_SCRIPT: Record<number, "pkh" | "sh" | "wpkh" | "tr"> = {
  44: "pkh",
  49: "sh",
  84: "wpkh",
  86: "tr",
};

export type PsbtEntry = {
  readonly fingerprint: number;
  readonly path: ReadonlyArray<number>;
  readonly tap: boolean;
  readonly leafHashes: number;
};

export const inputEntries = (input: {
  readonly bip32Derivation?: ReadonlyArray<
    readonly [Uint8Array, { readonly fingerprint: number; readonly path: ReadonlyArray<number> }]
  >;
  readonly tapBip32Derivation?: ReadonlyArray<
    readonly [
      Uint8Array,
      {
        readonly hashes: ReadonlyArray<Uint8Array>;
        readonly der: { readonly fingerprint: number; readonly path: ReadonlyArray<number> };
      },
    ]
  >;
}): ReadonlyArray<PsbtEntry> => [
  ...(input.bip32Derivation ?? []).map(([, der]) => ({
    fingerprint: der.fingerprint,
    path: der.path,
    tap: false,
    leafHashes: 0,
  })),
  ...(input.tapBip32Derivation ?? []).map(([, entry]) => ({
    fingerprint: entry.der.fingerprint,
    path: entry.der.path,
    tap: true,
    leafHashes: entry.hashes.length,
  })),
];

type PsbtInput = ReturnType<Transaction["getInput"]>;

/**
 * The prevout script a signable input spends: `witnessUtxo` when present, else the output its
 * `nonWitnessUtxo` (the decoded previous transaction) points at — needed to check the path's
 * purpose against the script type.
 */
const prevoutScript = (input: PsbtInput): Uint8Array | undefined => {
  const witness = input.witnessUtxo?.script;
  if (witness !== undefined) {
    return witness;
  }
  const prev = input.nonWitnessUtxo;
  const vout = input.index;
  if (prev === undefined || vout === undefined || vout >= prev.outputs.length) {
    return undefined;
  }
  const out = prev.outputs[vout];
  const script: unknown = out?.script;
  return script instanceof Uint8Array ? script : undefined;
};

const multisig = (why: string): QrError =>
  new QrError("multisig-unsupported", `the kernel signs single-sig only — ${why}`);

const bitcoinCandidates = (
  request: QrRequest & { family: "bitcoin" },
  facts: QrAccountFacts,
): ReadonlyArray<BitcoinSignInput> => {
  const tx = qrGuard("malformed", () => Transaction.fromPSBT(request.psbt));
  const sign: Array<{ index: number; sigHash: BitcoinSigHash; template: BitcoinTemplate }> = [];
  const coins = new Set<number>();
  for (let index = 0; index < tx.inputsLength; index += 1) {
    const input = tx.getInput(index);
    const ours = inputEntries(input).filter((entry) => entry.fingerprint === facts.fingerprint);
    if (ours.length === 0) {
      continue;
    }
    if (input.witnessScript !== undefined && input.witnessScript.length > 0) {
      throw multisig("a witness script on this input cannot be signed");
    }
    for (const entry of ours) {
      const [purpose, coin, group, change, i] = entry.path;
      /* This wallet's fingerprint under a path that is not the selected group's account leaf is
         not this account's material — refuse rather than skip. */
      if (
        entry.path.length !== 5 ||
        purpose === undefined ||
        coin === undefined ||
        group === undefined ||
        change === undefined ||
        i === undefined ||
        purpose < HARDENED ||
        coin < HARDENED ||
        coin - HARDENED > 1 ||
        group < HARDENED ||
        group - HARDENED !== facts.groupIndex ||
        change >= HARDENED ||
        change > 1 ||
        i >= HARDENED
      ) {
        throw mismatch("derivation path");
      }
      const p = purpose - HARDENED;
      const c = coin - HARDENED;
      const template = PURPOSE_TEMPLATE[p];
      if (template === undefined) {
        throw mismatch("derivation path");
      }
      if (entry.leafHashes > 0) {
        throw multisig("a taproot script-path entry cannot be signed");
      }
      const script = prevoutScript(input);
      const decoded =
        script === undefined ? undefined : qrGuard("malformed", () => OutScript.decode(script));
      if (decoded === undefined) {
        throw mismatch("script");
      }
      if (
        decoded.type === "ms" ||
        decoded.type === "wsh" ||
        decoded.type === "tr_ms" ||
        decoded.type === "tr_ns"
      ) {
        throw multisig("the input's script is not a single-key output");
      }
      if (decoded.type !== PURPOSE_SCRIPT[p]) {
        throw mismatch("script");
      }
      if (decoded.type === "sh") {
        /* Only the plain p2sh-wrapped p2wpkh is a single-sig template output — the PSBT parser
           already refused a redeem script anywhere else. */
        const redeem = input.redeemScript;
        const inner =
          redeem === undefined ? undefined : qrGuard("malformed", () => OutScript.decode(redeem));
        if (inner === undefined || inner.type !== "wpkh") {
          throw multisig("the redeem script is not a p2wpkh wrapper");
        }
      }
      const { sighashType } = input;
      const sigHash: BitcoinSigHash =
        sighashType === undefined ||
        sighashType === SIGHASH_ALL ||
        (sighashType === SIGHASH_DEFAULT && entry.tap)
          ? "ALL"
          : sighashType === SIGHASH_SINGLE_ANYONECANPAY
            ? "SINGLE|ANYONECANPAY"
            : (() => {
                throw new QrError(
                  "sighash-unsupported",
                  `input ${index} requests an unsupported sighash`,
                );
              })();
      coins.add(c);
      sign.push({ index, sigHash, template });
    }
  }
  if (sign.length === 0) {
    throw new QrError("nothing-to-sign", "no input carries this wallet's fingerprint");
  }
  const coinSet = [...coins];
  if (coinSet.length !== 1) {
    throw new QrError("network-ambiguous", "the inputs span several bitcoin networks");
  }
  const [coin] = coinSet;
  let network: string;
  if (coin === 0) {
    network = BITCOIN_MAINNET;
    if (!facts.networks.bitcoin.includes(network)) {
      throw new QrError("network-unknown", `network ${network} is not enabled`);
    }
  } else {
    const testnets = facts.networks.bitcoin.filter((n) => n !== BITCOIN_MAINNET);
    const [testnet] = testnets;
    if (testnets.length !== 1 || testnet === undefined) {
      throw new QrError(
        "network-ambiguous",
        "the inputs need a test network but none or several are enabled",
      );
    }
    network = testnet;
  }
  const input: BitcoinPsbtInput = { psbt: request.psbt, sign };
  return [
    {
      method: "bitcoin-sign",
      origin: qrOrigin(undefined),
      account: { walletId: facts.walletId, groupIndex: facts.groupIndex },
      network,
      request: { kind: "psbt", psbts: [input], send: false },
    },
  ];
};

/**
 * The candidate request inputs for a decoded QR request, in try order — one, except Solana and TRON
 * transactions which produce one per enabled network for the facade to try in order. All
 * account/chain/network checks happen here; the pipeline repeats the semantic ones.
 */
export const bindQrRequest = (
  request: QrRequest,
  facts: QrAccountFacts,
): ReadonlyArray<EvmSignInput | SolanaSignInput | TronSignInput | BitcoinSignInput> =>
  request.family === "evm"
    ? [evmCandidates(request, facts)]
    : request.family === "solana"
      ? solanaCandidates(request, facts)
      : request.family === "tron"
        ? tronCandidates(request, facts)
        : bitcoinCandidates(request, facts);
