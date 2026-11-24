/**
 * The watch-only side of the QR channel: a Web wallet holds no keys — `readQrExport` turns the
 * phone's `crypto-multi-accounts` export into per-family `QrLink`s, `qrSignRequest` writes the UR
 * request our own `readQrRequest` accepts and binds, and `readQrSignature` verifies the phone's UR
 * answer against what was sent. Every hop is frames; nothing here touches a wallet.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { Transaction } from "@scure/btc-signer/transaction.js";
import * as Hex from "ox/Hex";
import * as PublicKey from "ox/PublicKey";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";

import {
  cryptoMultiAccountsCodec,
  ethSignRequestCodec,
  ethSignatureCodec,
  solSignRequestCodec,
  solSignatureCodec,
  tronSignRequestCodec,
  tronSignatureCodec,
} from "@qntx/ur/interop";
import type {
  EthSignRequest,
  Keypath,
  MultiAccountsKey,
  SolSignRequest,
  TronSignRequest,
} from "@qntx/ur/interop";
import { cryptoPsbtCodec } from "@qntx/ur/registry";
import { Ur, fromUr, toUr } from "@qntx/ur/typed";
import type { UrCodec } from "@qntx/ur/typed";
import type { EvmTransaction, SignRequest } from "@qntx/wallet-chains";
import {
  bitcoinAddressFromXpub,
  bitcoinNetwork,
  samePsbtContent,
} from "@qntx/wallet-chains/bitcoin";
import {
  assembleEvm,
  evmAddressFromPublicKey,
  evmSigningPreimage,
  planEvm,
  recoverEvmSigner,
} from "@qntx/wallet-chains/evm";
import type { EvmSignPlan } from "@qntx/wallet-chains/evm";
import {
  parseCompiledMessage,
  solanaAddressFromPublicKey,
  verifySolanaSignature,
} from "@qntx/wallet-chains/solana";
import {
  recoverTronMessageSigner,
  recoverTronTransactionSigner,
  tronAddressFromPublicKey,
  tronAddressToBytes,
} from "@qntx/wallet-chains/tron";
import type { QrPayload } from "@qntx/wallet/hardware";

import { inputEntries } from "./bind.ts";
import { QrError, malformed, qrGuard, resultMismatch as mismatch, unsupported } from "./errors.ts";
import {
  BITCOIN_MAINNET,
  BITCOIN_TESTNET,
  PURPOSE_TEMPLATE,
  QR_FINGERPRINT,
  keypath,
  pathComponents,
  qrLinkPath,
} from "./link.ts";
import { evmProbe } from "./response.ts";

/** One phone account a watch-only wallet signs through, read from the phone's export. */
export type QrLink = {
  readonly family: "evm" | "solana" | "tron" | "bitcoin";
  /** Master fingerprint, 8 lowercase hex. */
  readonly fingerprint: string;
  /** The signing key's path: the leaf for evm/tron/solana, the account for bitcoin. */
  readonly path: string;
  /** Evm/tron/solana: the leaf's address; bitcoin: the account's first receive address (0/0). */
  readonly address: string;
  /** Bitcoin only: the account xpub (version bytes for its network/purpose). */
  readonly xpub?: string;
};

export type QrSignInput =
  | { readonly family: "evm"; readonly kind: "transaction"; readonly tx: EvmTransaction }
  | {
      readonly family: "evm";
      readonly kind: "typed-data";
      readonly typedData: string;
      readonly chainId?: number;
    }
  | {
      readonly family: "evm";
      readonly kind: "personal-message";
      readonly message: Uint8Array;
      readonly chainId?: number;
    }
  | {
      readonly family: "solana";
      readonly kind: "transaction" | "message";
      readonly data: Uint8Array;
    }
  | {
      readonly family: "tron";
      readonly kind: "transaction" | "message";
      readonly data: Uint8Array;
    }
  | { readonly family: "bitcoin"; readonly kind: "psbt"; readonly psbt: Uint8Array };

export type QrSentRequest = {
  readonly link: QrLink;
  readonly input: QrSignInput;
  readonly requestId?: Uint8Array;
  readonly payload: QrPayload;
};

export type QrSignature =
  | { readonly kind: "evm.transaction"; readonly signedTransaction: Uint8Array }
  | { readonly kind: "evm.signature"; readonly signature: Uint8Array }
  | { readonly kind: "solana.signature"; readonly signature: Uint8Array }
  | { readonly kind: "tron.signature"; readonly signature: Uint8Array }
  | { readonly kind: "bitcoin.psbt"; readonly psbt: Uint8Array };

const HARDENED = 0x80000000;

const pathString = (components: Keypath["components"]): string =>
  `m/${components.map((c) => (c.kind === "index" ? `${c.index}${c.hardened ? "'" : ""}` : "*")).join("/")}`;

const fingerprintHex = (n: number): string => n.toString(16).padStart(8, "0");

/* --- readQrExport -------------------------------------------------------- */

/** An exported key as the link its family shape makes it, or `unsupported`. */
const keyLink = (key: MultiAccountsKey, mfp: number): QrLink => {
  const { origin } = key.key;
  if (origin === undefined || origin.components.length === 0) {
    malformed("an exported key carries no derivation path");
  }
  if (origin.sourceFingerprint !== mfp) {
    malformed("an exported key's fingerprint is not the export's");
  }
  const path = pathString(origin.components);
  const fingerprint = fingerprintHex(mfp);
  const secp = key.curve === "secp256k1" ? key.key.keyData : undefined;
  const ed = key.curve === "ed25519" ? key.key.keyData : undefined;
  const secp33 = (what: string): Uint8Array => {
    if (secp === undefined) {
      malformed(`${what} must be a secp256k1 key`);
    }
    return secp;
  };
  const leaf = (family: "evm" | "tron" | "solana", address: string): QrLink => ({
    family,
    fingerprint,
    path,
    address: qrGuard("malformed", () => address),
  });
  // m/44'/60'/0'/0/i
  if (qrLinkPath("evm", path)) {
    return leaf("evm", evmAddressFromPublicKey(secp33("an evm leaf")));
  }
  // m/44'/195'/0'/0/i
  if (qrLinkPath("tron", path)) {
    return leaf("tron", tronAddressFromPublicKey(secp33("a tron leaf")));
  }
  // m/44'/501'/i'/0'
  if (qrLinkPath("solana", path)) {
    if (ed === undefined) {
      malformed("a solana leaf must be an ed25519 key");
    }
    return leaf("solana", solanaAddressFromPublicKey(ed));
  }
  // m/{44,49,84,86}'/{0,1}'/i'
  if (!qrLinkPath("bitcoin", path)) {
    return unsupported(`path ${path} is not a signing key the phone exports`);
  }
  const steps = pathComponents(path) ?? malformed("unreadable derivation path");
  const purpose = steps[0]?.index ?? 0;
  const coin = steps[1]?.index ?? -1;
  const template = PURPOSE_TEMPLATE[purpose];
  if (template === undefined) {
    return unsupported(`path ${path} is not a signing key the phone exports`);
  }
  const pubkey = secp33("a bitcoin account");
  const { chainCode } = key.key;
  const { parentFingerprint } = key.key;
  if (chainCode === undefined) {
    malformed("a bitcoin account carries no chain code");
  }
  if (parentFingerprint === undefined) {
    malformed("a bitcoin account carries no parent fingerprint");
  }
  const network = coin === 0 ? BITCOIN_MAINNET : BITCOIN_TESTNET;
  const version = bitcoinNetwork(network).bip32.public;
  const xpub = qrGuard(
    "malformed",
    () =>
      new HDKey({
        versions: { private: version, public: version },
        depth: steps.length,
        parentFingerprint,
        index: (steps[2]?.index ?? 0) + HARDENED,
        chainCode,
        publicKey: pubkey,
      }).publicExtendedKey,
  );
  return {
    family: "bitcoin",
    fingerprint,
    path,
    address: qrGuard("malformed", () => bitcoinAddressFromXpub(xpub, template, network, 0, 0)),
    xpub,
  };
};

/**
 * The phone's `crypto-multi-accounts` export as one link per family. Strict: the fingerprint is
 * required, every key's path must be one of the shapes a `QrLink` declares, all keys share the
 * master fingerprint, and at most one key per family is accepted.
 */
export const readQrExport = (payload: QrPayload): ReadonlyArray<QrLink> => {
  if (payload.type !== "crypto-multi-accounts") {
    return unsupported(`UR type ${payload.type} is not an export the Web wallet reads`);
  }
  const accounts = qrGuard("malformed", () =>
    fromUr(Ur.fromCborData(payload.type, payload.cbor), cryptoMultiAccountsCodec),
  );
  /* The codec proves `masterFingerprint` a uint32 before any key is read. */
  const mfp = accounts.masterFingerprint;
  const links: QrLink[] = [];
  for (const key of accounts.keys) {
    const link = keyLink(key, mfp);
    if (links.some((l) => l.family === link.family)) {
      malformed(`the export carries two ${link.family} keys`);
    }
    links.push(link);
  }
  return links;
};

/* --- qrSignRequest ------------------------------------------------------- */

const requestKeypath = (link: QrLink): Keypath =>
  keypath(link.path, Number.parseInt(link.fingerprint, 16));

const encode = <T>(value: T, codec: UrCodec<T>): QrPayload =>
  qrGuard("malformed", () => {
    const ur = toUr(value, codec);
    return { type: ur.type, cbor: ur.toCborData() };
  });

const evmAddressBytes = (address: string): Uint8Array => {
  const bytes = hexToBytes(address.startsWith("0x") ? address.slice(2) : address);
  if (bytes.length !== 20) {
    malformed(`evm link address ${address} is not 20 bytes`);
  }
  return bytes;
};

/** A PSBT derivation `link` owns: its fingerprint, under its account path. */
const underLink = (
  entry: { readonly fingerprint: number; readonly path: ReadonlyArray<number> },
  linkPath: ReadonlyArray<number>,
  fp: number,
): boolean =>
  entry.fingerprint === fp &&
  entry.path.length >= linkPath.length &&
  linkPath.every((step, i) => entry.path[i] === step);

/** `link`'s numeric account path and fingerprint — the PSBT derivation match keys. */
const linkDerivation = (link: QrLink): { path: ReadonlyArray<number>; fp: number } => ({
  path: (pathComponents(link.path) ?? malformed(`bad link path ${link.path}`)).map(
    (s) => s.index + (s.hardened ? HARDENED : 0),
  ),
  fp: Number.parseInt(link.fingerprint, 16),
});

const psbtHasLinkInput = (psbt: Uint8Array, link: QrLink): boolean => {
  const tx = qrGuard("malformed", () => Transaction.fromPSBT(psbt));
  const { path, fp } = linkDerivation(link);
  for (let index = 0; index < tx.inputsLength; index += 1) {
    if (inputEntries(tx.getInput(index)).some((e) => underLink(e, path, fp))) {
      return true;
    }
  }
  return false;
};

const evmRequest = (
  link: QrLink,
  input: QrSignInput & { readonly family: "evm" },
  requestId: Uint8Array,
  origin: string | undefined,
): QrPayload => {
  const head = {
    requestId,
    derivationPath: requestKeypath(link),
    address: evmAddressBytes(link.address),
    ...(origin === undefined ? {} : { origin }),
  };
  if (input.kind === "transaction") {
    const { tx } = input;
    if (tx.type === "eip7702") {
      throw new QrError("unsupported", "an EIP-7702 authorization cannot be a QR request");
    }
    if (tx.to === undefined) {
      throw new QrError("contract-creation", "a QR request cannot create a contract");
    }
    const request: EthSignRequest = {
      ...head,
      signData: qrGuard("malformed", () => evmSigningPreimage(tx)),
      dataType: tx.type === "legacy" ? "transaction" : "typedTransaction",
      chainId: tx.chainId,
    };
    return encode(request, ethSignRequestCodec);
  }
  const request: EthSignRequest = {
    ...head,
    signData:
      input.kind === "typed-data" ? new TextEncoder().encode(input.typedData) : input.message,
    dataType: input.kind === "typed-data" ? "typedData" : "personalMessage",
    ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
  };
  return encode(request, ethSignRequestCodec);
};

/**
 * The watch-only wallet's sign request, encoded as the exact UR the phone accepts: Keystone layouts
 * (`eth`/`sol`/`tron` sign request, `crypto-psbt` for Bitcoin), the link's fingerprint and path, a
 * random 16-byte request id and — only when given — an origin. Inputs the phone would refuse anyway
 * are refused here with the same codes `bindQrRequest` raises.
 */
export const qrSignRequest = (
  link: QrLink,
  input: QrSignInput,
  options: { readonly random: (n: number) => Uint8Array; readonly origin?: string },
): QrSentRequest => {
  if (input.family !== link.family) {
    return malformed(`a ${input.family} input cannot sign through a ${link.family} link`);
  }
  if (!QR_FINGERPRINT.test(link.fingerprint)) {
    return malformed(`bad fingerprint ${link.fingerprint}`);
  }
  if (!qrLinkPath(link.family, link.path)) {
    return malformed(`path ${link.path} is not a ${link.family} signing path`);
  }
  const requestId = options.random(16);
  if (requestId.length !== 16) {
    return malformed("the random source must give 16 bytes");
  }
  const head = {
    requestId,
    derivationPath: requestKeypath(link),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  };
  let payload: QrPayload;
  if (input.family === "evm") {
    payload = evmRequest(link, input, requestId, options.origin);
  } else if (input.family === "solana") {
    if (input.kind === "transaction") {
      const parsed = qrGuard("malformed", () => parseCompiledMessage(input.data));
      if (!parsed.staticAccounts.slice(0, parsed.numRequiredSignatures).includes(link.address)) {
        throw new QrError("account-mismatch", "the request's signer is not this account's");
      }
    }
    const request: SolSignRequest = {
      ...head,
      signData: input.data,
      address: base58.decode(link.address),
      signType: input.kind,
    };
    payload = encode(request, solSignRequestCodec);
  } else if (input.family === "tron") {
    const request: TronSignRequest = {
      ...head,
      signData: input.data,
      dataType: input.kind === "transaction" ? "transaction" : "messageV2",
      address: tronAddressToBytes(link.address),
    };
    payload = encode(request, tronSignRequestCodec);
  } else {
    if (!psbtHasLinkInput(input.psbt, link)) {
      throw new QrError("nothing-to-sign", "no input carries this wallet's fingerprint");
    }
    payload = encode({ bytes: input.psbt }, cryptoPsbtCodec);
  }
  return { link, input, requestId, payload };
};

/* --- readQrSignature ----------------------------------------------------- */

const decode = <T>(payload: QrPayload, codec: UrCodec<T>): T =>
  qrGuard("result-mismatch", () => fromUr(Ur.fromCborData(payload.type, payload.cbor), codec));

const echoRequestId = (sent: QrSentRequest, got: Uint8Array | undefined): void => {
  const want = sent.requestId;
  if (
    want === undefined
      ? got === undefined
      : got !== undefined && bytesToHex(want) === bytesToHex(got)
  ) {
    return;
  }
  mismatch("the response's request id is not the request's");
};

/* The transaction half of a sign request as the plan's request shape — planEvm reads only
   `tx`; the head fields exist for the type, they name no account. */
const evmTxRequest = (tx: EvmTransaction): Extract<SignRequest, { kind: "evm.transaction" }> => ({
  kind: "evm.transaction",
  network: `eip155:${tx.chainId}`,
  account: { kind: "hd", walletId: "", groupIndex: 0, template: "" },
  tx,
});

/* R‖s‖v as the phone writes it → the signed envelope assembled by the signing plan. The wire's v
   is inverted to the parity acceptEcdsa's signature form carries (legacy: EIP-155
   27 + 2·chainId + 8 + parity; typed: the parity itself); any other v is result-mismatch. The
   link names an address, not a key — the key is recovered over the plan's digest with that
   declared parity, verified inside assembleEvm, and the recovered sender is re-checked against
   the link below. */
const evmSignedTransaction = (tx: EvmTransaction, signature: Uint8Array): Uint8Array => {
  /* The eth-signature codec bounds the wire signature to exactly its min/max on decode, so a
     signature reaching this point is the right length — only the v remains to check. */
  const v = signature.subarray(64).reduce((acc, byte) => acc * 256 + byte, 0);
  const yParity = tx.type === "legacy" ? v - 27 - tx.chainId * 2 - 8 : v;
  if (yParity !== 0 && yParity !== 1) {
    mismatch("unexpected recovery id");
  }
  const plan = (publicKey: Uint8Array): EvmSignPlan =>
    planEvm(evmTxRequest(tx), { path: [], publicKey });
  const wire = qrGuard("result-mismatch", () =>
    Signature.from({
      r: Hex.fromBytes(signature.subarray(0, 32)),
      s: Hex.fromBytes(signature.subarray(32, 64)),
      yParity,
    }),
  );
  const publicKey = qrGuard("result-mismatch", () =>
    PublicKey.toBytes(
      PublicKey.compress(
        Secp256k1.recoverPublicKey({
          payload: Hex.fromBytes(plan(new Uint8Array(33)).tasks[0].digest),
          signature: wire,
        }),
      ),
    ),
  );
  const assembled = qrGuard("result-mismatch", () =>
    assembleEvm(plan(publicKey), [signature.subarray(0, 64)]),
  );
  if (assembled.kind !== "signed") {
    mismatch("the transaction plan did not sign");
  }
  return assembled.artefact;
};

const evmSignature = (sent: QrSentRequest, payload: QrPayload): QrSignature => {
  const { requestId, signature } = decode(payload, ethSignatureCodec);
  echoRequestId(sent, requestId);
  const { input } = sent;
  if (input.family !== "evm") {
    mismatch("not an evm request");
  }
  const signedTransaction =
    input.kind === "transaction" ? evmSignedTransaction(input.tx, signature) : undefined;
  const recovered = qrGuard("result-mismatch", () =>
    recoverEvmSigner(
      evmProbe(input),
      signedTransaction === undefined ? { signature } : { signedTransaction },
    ),
  );
  if (recovered.toLowerCase() !== sent.link.address.toLowerCase()) {
    mismatch("signature does not recover to the signer");
  }
  return signedTransaction === undefined
    ? { kind: "evm.signature", signature }
    : { kind: "evm.transaction", signedTransaction };
};

const solanaSignature = (sent: QrSentRequest, payload: QrPayload): QrSignature => {
  const { requestId, signature } = decode(payload, solSignatureCodec);
  echoRequestId(sent, requestId);
  const { input } = sent;
  if (input.family !== "solana") {
    mismatch("not a solana request");
  }
  if (signature.length !== 64 || !verifySolanaSignature(input.data, signature, sent.link.address)) {
    mismatch("signature does not verify under the signer");
  }
  return { kind: "solana.signature", signature };
};

const tronSignature = (sent: QrSentRequest, payload: QrPayload): QrSignature => {
  const { requestId, signature } = decode(payload, tronSignatureCodec);
  echoRequestId(sent, requestId);
  const { input } = sent;
  if (input.family !== "tron") {
    mismatch("not a tron request");
  }
  // The phone writes v = recid on transactions and recid + 27 on messages.
  const last = signature.at(-1);
  const normalized =
    input.kind === "transaction" && (last === 0 || last === 1)
      ? new Uint8Array([...signature.subarray(0, 64), last + 27])
      : signature;
  const recovered = qrGuard("result-mismatch", () =>
    input.kind === "transaction"
      ? recoverTronTransactionSigner(input.data, normalized)
      : recoverTronMessageSigner(input.data, normalized),
  );
  if (recovered !== sent.link.address) {
    mismatch("signature does not recover to the signer");
  }
  return { kind: "tron.signature", signature };
};

/** New signatures by a key whose derivation sits under `link`'s account path. */
const linkSignatures = (
  requested: ReturnType<Transaction["getInput"]>,
  signed: ReturnType<Transaction["getInput"]>,
  linkPath: ReadonlyArray<number>,
  fp: number,
): number => {
  const linkKeys = new Set<string>();
  for (const [pubkey, der] of signed.bip32Derivation ?? []) {
    if (underLink(der, linkPath, fp)) {
      linkKeys.add(bytesToHex(pubkey));
    }
  }
  let linkTap = false;
  for (const [pubkey, entry] of signed.tapBip32Derivation ?? []) {
    if (underLink(entry.der, linkPath, fp)) {
      linkKeys.add(bytesToHex(pubkey));
      linkTap = true;
    }
  }
  /* Only signatures by a link key count — a foreign signer's new signature is not progress. */
  const requestedKeys = new Set((requested.partialSig ?? []).map(([pubkey]) => bytesToHex(pubkey)));
  let fresh = 0;
  for (const [pubkey] of signed.partialSig ?? []) {
    if (linkKeys.has(bytesToHex(pubkey)) && !requestedKeys.has(bytesToHex(pubkey))) {
      fresh += 1;
    }
  }
  if (signed.tapKeySig !== undefined && requested.tapKeySig === undefined && linkTap) {
    fresh += 1;
  }
  return fresh;
};

const bitcoinSignature = (sent: QrSentRequest, payload: QrPayload): QrSignature => {
  const { input } = sent;
  if (input.family !== "bitcoin") {
    mismatch("not a bitcoin request");
  }
  const { bytes } = decode(payload, cryptoPsbtCodec);
  if (!samePsbtContent(input.psbt, bytes)) {
    mismatch("the signed PSBT does not match the request");
  }
  const { path: linkPath, fp } = linkDerivation(sent.link);
  const [requested, signed] = qrGuard("result-mismatch", () => [
    Transaction.fromPSBT(input.psbt),
    Transaction.fromPSBT(bytes),
  ]);
  let fresh = 0;
  for (let index = 0; index < signed.inputsLength; index += 1) {
    fresh += linkSignatures(requested.getInput(index), signed.getInput(index), linkPath, fp);
  }
  if (fresh < 1) {
    mismatch("the signed PSBT carries no new signature by this account");
  }
  return { kind: "bitcoin.psbt", psbt: bytes };
};

/**
 * The phone's UR answer verified against what this session sent: the payload type must be the
 * response type for the request, the request id must echo, and the signature must recover or verify
 * to `link.address` (a PSBT must carry unchanged content plus at least one new signature by a key
 * under the link). Anything else is `result-mismatch`.
 */
const RESPONSE_TYPES: Readonly<Record<QrLink["family"], string>> = {
  evm: "eth-signature",
  solana: "sol-signature",
  tron: "tron-signature",
  bitcoin: "crypto-psbt",
};

const VERIFY: Readonly<
  Record<QrLink["family"], (sent: QrSentRequest, payload: QrPayload) => QrSignature>
> = {
  evm: evmSignature,
  solana: solanaSignature,
  tron: tronSignature,
  bitcoin: bitcoinSignature,
};

export const readQrSignature = (sent: QrSentRequest, payload: QrPayload): QrSignature => {
  const expected = RESPONSE_TYPES[sent.input.family];
  if (payload.type !== expected) {
    mismatch(`the response type ${payload.type} is not the request's ${expected}`);
  }
  return VERIFY[sent.input.family](sent, payload);
};
