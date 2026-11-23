/**
 * Request method and origin types shared by the request controller and its sign log — kept in a
 * leaf module so persistence code can name them without importing the controller. The pipeline's
 * error classes live here too so the connect layer's provider-error mapping can test them without
 * importing the controller either.
 */
import type { SignRequest } from "@qntx/wallet-chains";

import { APP_ID } from "../gateway/contract/eligibility.ts";

export type ChainRequestMethod =
  | "send"
  | "speed-up"
  | "cancel"
  | "cpfp"
  | "evm-delegation"
  | "evm-batch"
  | "evm-approve"
  | "evm-revoke"
  | "evm-cctp"
  | "evm-swap"
  | "evm-bridge"
  | "evm-nft-send"
  | "solana-nft-send"
  | "evm-lido"
  | "solana-stake"
  | "solana-revoke"
  | "solana-swap"
  | "tron-stake"
  | "tron-approve";

/** A web page; `origin` is `scheme://host[:port]`, computed by the host from the top-level URL. */
export type BrowserOrigin = { readonly kind: "browser"; readonly origin: string };

export type WalletConnectVerify = {
  readonly validation: "VALID" | "INVALID" | "UNKNOWN";
  readonly isScam: boolean;
};

/** A WalletConnect peer. `origin` is the session key `walletconnect:<topic>` — never a URL. */
export type WalletConnectOrigin = {
  readonly kind: "walletconnect";
  readonly origin: string;
  readonly topic: string;
  /** The peer's self-declared metadata URL reduced to its origin — display only, never verified. */
  readonly url: string;
  readonly name: string;
  readonly verify: WalletConnectVerify;
};

export type DappOrigin = BrowserOrigin | WalletConnectOrigin;

/** A request an in-engine application (Hyperliquid, …) opened — core never enumerates app ids. */
export type AppOrigin = { readonly kind: "app"; readonly id: string };

export type RequestOrigin = { readonly kind: "internal" } | AppOrigin | DappOrigin;

/** The URL a dApp origin's phishing and sign-in checks run against. */
export const dappUrl = (origin: DappOrigin): string =>
  origin.kind === "browser" ? origin.origin : origin.url;

export const walletConnectKey = (topic: string): string => `walletconnect:${topic}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const VERIFY_VALIDATIONS: ReadonlySet<unknown> = new Set(["VALID", "INVALID", "UNKNOWN"]);

/** The persisted shape of a dApp origin; the sign log and session store read them back with it. */
export const isDappOrigin = (value: unknown): value is DappOrigin => {
  if (!isObject(value)) {
    return false;
  }
  if (value["kind"] === "browser") {
    return typeof value["origin"] === "string";
  }
  const { verify } = value;
  return (
    value["kind"] === "walletconnect" &&
    typeof value["origin"] === "string" &&
    typeof value["topic"] === "string" &&
    typeof value["url"] === "string" &&
    typeof value["name"] === "string" &&
    isObject(verify) &&
    VERIFY_VALIDATIONS.has(verify["validation"]) &&
    typeof verify["isScam"] === "boolean"
  );
};

/** The dApp origin a request origin carries, if any — an app origin is never one. */
export const dappOf = (origin: RequestOrigin): DappOrigin | undefined =>
  origin.kind === "browser" || origin.kind === "walletconnect" ? origin : undefined;

/** The exact persisted shape of an app origin; `prepare` also validates an `AppOrigin` with it. */
export const isAppOrigin = (value: unknown): value is AppOrigin =>
  isObject(value) &&
  value["kind"] === "app" &&
  typeof value["id"] === "string" &&
  APP_ID.test(value["id"]) &&
  Object.keys(value).length === 2;

/** The persisted shape of a request origin. */
export const isRequestOrigin = (value: unknown): value is RequestOrigin => {
  if (!isObject(value)) {
    return false;
  }
  return value["kind"] === "internal" || isAppOrigin(value) || isDappOrigin(value);
};

export type RequestMethod =
  | ChainRequestMethod
  | "pay"
  | "zap"
  | "evm-sign"
  | "tron-sign"
  | "evm-delegation"
  | "evm-batch"
  | "nostr-sign"
  | "webln-invoice"
  | "watch-asset"
  | "solana-sign"
  | "bitcoin-sign"
  | "spark-deposit"
  | "spark-exit";

/** A Solana chain account the `solana-sign` request signs for. */
export type SolanaAccount = {
  readonly walletId: string;
  readonly groupIndex: number;
  readonly address: string;
};

/** A Bitcoin account the `bitcoin-sign` request signs for: the group's fixed dApp-facing address. */
export type BitcoinAccount = {
  readonly walletId: string;
  readonly groupIndex: number;
  readonly address: string;
  /** `btc.bip84` for the `payment` purpose, `btc.bip86` for `ordinals`. */
  readonly template: "btc.bip84" | "btc.bip86";
};

/**
 * The wallet group a `bitcoin-sign` PSBT request signs for: inputs of several dApp-facing templates
 * of the same group may mix in one PSBT — each sign entry names its own template.
 */
export type BitcoinGroup = {
  readonly walletId: string;
  readonly groupIndex: number;
};

/** The sighash a dApp asks for per input; anything else is refused before it reaches a request. */
export type BitcoinSigHash = "ALL" | "SINGLE|ANYONECANPAY";

/** One dApp PSBT and the inputs it asks the wallet to sign. */
export type BitcoinPsbtInput = {
  readonly psbt: Uint8Array;
  readonly sign: ReadonlyArray<{
    readonly index: number;
    readonly sigHash: BitcoinSigHash;
    readonly template: BitcoinAccount["template"];
  }>;
};

/**
 * A dApp PSBT after the engine enriched the requested inputs with this account's derivation data:
 * `request` is what the kernel signs, `ownScripts` the scripts verified as the account's, `inputs`
 * the signed inputs' prevout values and sighash (for risk).
 */
export type PreparedBitcoinPsbt = {
  readonly request: Extract<SignRequest, { kind: "bitcoin.psbt" }>;
  readonly ownScripts: ReadonlySet<string>;
  readonly inputs: ReadonlyArray<{
    readonly index: number;
    readonly value: number;
    readonly sigHash: BitcoinSigHash;
    readonly template: BitcoinAccount["template"];
    /** The user froze this outpoint — signing it is a danger finding. */
    readonly frozen: boolean;
  }>;
};

/** A token the page asked to watch whose on-chain metadata cannot be shown; the dApp's bad input. */
export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

/** A Sign-In with X message for another domain than the page that asked for the signature. */
export class SignInOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInOriginError";
  }
}

/** A request that ended without a result: `stage` says how, `message` is the failure if any. */
export class RequestEndedError extends Error {
  readonly stage: "rejected" | "failed" | "expired" | "invalidated";
  /**
   * Whether the request had reached the `signed` stage when it ended — `false` proves nothing it
   * produced was broadcast, `true` means a signature may already be out.
   */
  readonly signed: boolean;
  constructor(stage: RequestEndedError["stage"], message: string | undefined, signed: boolean) {
    super(message ?? `request ${stage}`);
    this.name = "RequestEndedError";
    this.stage = stage;
    this.signed = signed;
  }
}

/**
 * An app pinned the nonce its transaction must carry but the sender's next free nonce differs — the
 * request is refused before anything is shown rather than signed at a nonce that would sit
 * `unknown` forever.
 */
export class NonceConflictError extends Error {
  /** The nonce the caller requires the transaction to carry. */
  readonly expected: number;
  /** The sender's next free nonce as the engine sees it. */
  readonly next: number;
  constructor(expected: number, next: number) {
    super("the transaction must carry a nonce the sender cannot sign next");
    this.name = "NonceConflictError";
    this.expected = expected;
    this.next = next;
  }
}

/** The origin already has a request in flight; a dApp gets one at a time. */
export class OriginBusyError extends Error {
  constructor(origin: string) {
    super(`${origin} already has an unfinished request`);
    this.name = "OriginBusyError";
  }
}
