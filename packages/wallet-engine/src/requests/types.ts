/**
 * Request method and origin types shared by the request controller and its sign log — kept in a
 * leaf module so persistence code can name them without importing the controller.
 */
import type { SignRequest } from "@qntx/wallet-chains";

import type { ChainRequestMethod } from "../transactions/route.ts";

/** A web page; `origin` is `scheme://host[:port]`, computed by the host from the top-level URL. */
export type BrowserOrigin = { readonly kind: "browser"; readonly origin: string };

export type RequestOrigin = { readonly kind: "internal" } | BrowserOrigin;

export type RequestMethod =
  | ChainRequestMethod
  | "pay"
  | "zap"
  | "evm-sign"
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

/** The sighash a dApp asks for per input; anything else is refused before it reaches a request. */
export type BitcoinSigHash = "ALL" | "SINGLE|ANYONECANPAY";

/** One dApp PSBT and the inputs it asks the wallet to sign. */
export type BitcoinPsbtInput = {
  readonly psbt: Uint8Array;
  readonly sign: ReadonlyArray<{ readonly index: number; readonly sigHash: BitcoinSigHash }>;
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
  }>;
};
