/**
 * @qntx/wallet-chains — shared chain semantics for the wallet.
 * Types here are wire-safe: values crossing the main↔kernel protocol are
 * Uint8Array, safe integers, strings, booleans, arrays and plain objects.
 * Quantities are canonical `0x` hex (lowercase, no leading zeros, `0x0` for
 * zero), token amounts are decimal strings of the smallest unit.
 */

import type { SignInParse } from "./sign-in.ts";

export { parseSignIn } from "./sign-in.ts";
export type { SignInParse } from "./sign-in.ts";

export type ChainFamily = "evm" | "solana" | "bitcoin";

export type AccountRef =
  | {
      readonly kind: "hd";
      readonly walletId: string;
      readonly groupIndex: number;
      readonly template: string;
    }
  | { readonly kind: "imported"; readonly keyId: string; readonly family: ChainFamily };

export type SignRequest =
  | {
      readonly kind: "bitcoin.psbt";
      readonly network: string;
      readonly account: AccountRef;
      readonly psbt: Uint8Array;
      /** Input indices to sign — non-empty, unique, ascending, in range. */
      readonly sign: ReadonlyArray<number>;
    }
  | {
      readonly kind: "bitcoin.message";
      readonly network: string;
      readonly account: AccountRef;
      readonly address: string;
      readonly message: string;
      readonly format: "bip322-simple" | "legacy";
      /** Account change chain and index the address is derived at (0 = receive, 1 = change). */
      readonly change: 0 | 1;
      readonly index: number;
    }
  | {
      readonly kind: "solana.transaction";
      readonly network: string;
      readonly account: AccountRef;
      /** Compiled wire message (legacy or v0). */
      readonly message: Uint8Array;
      readonly lookupTables?: ReadonlyArray<{
        readonly address: string;
        readonly addresses: ReadonlyArray<string>;
      }>;
    }
  | {
      readonly kind: "solana.message";
      readonly network: string;
      readonly account: AccountRef;
      readonly message: Uint8Array;
      /** Only "raw" exists in this layer; offchain formats land with C7. */
      readonly format: "raw";
    }
  | {
      readonly kind: "evm.transaction";
      readonly network: string;
      readonly account: AccountRef;
      readonly tx: EvmTransaction;
    }
  | {
      readonly kind: "evm.personal-message";
      readonly network: string;
      readonly account: AccountRef;
      readonly message: Uint8Array;
    }
  | {
      readonly kind: "evm.typed-data";
      readonly network: string;
      readonly account: AccountRef;
      readonly typedData: string;
    };

export type EvmAccessListEntry = {
  readonly address: string;
  readonly storageKeys: ReadonlyArray<string>;
};

type EvmTransactionBase = {
  readonly chainId: number;
  readonly nonce: number;
  readonly gas: string;
  readonly value: string;
  readonly data: string;
  readonly to?: string;
};

/**
 * A complete transaction — every field the signer needs is present; `to` absent means contract
 * creation.
 */
export type EvmTransaction =
  | (EvmTransactionBase & { readonly type: "legacy"; readonly gasPrice: string })
  | (EvmTransactionBase & {
      readonly type: "eip2930";
      readonly gasPrice: string;
      readonly accessList: ReadonlyArray<EvmAccessListEntry>;
    })
  | (EvmTransactionBase & {
      readonly type: "eip1559";
      readonly accessList: ReadonlyArray<EvmAccessListEntry>;
      readonly maxFeePerGas: string;
      readonly maxPriorityFeePerGas: string;
    });

export type Verifiability = "full" | "partial" | "opaque";

export type IntentSummary =
  | "transfer"
  | "approve"
  | "contract-call"
  | "swap"
  | "message"
  | "authorization"
  | "batch";

export type AssetAmount = {
  readonly asset: string;
  readonly amount: string;
  readonly decimals?: number;
  readonly symbol?: string;
};

export type AssetFlow = {
  readonly to: string;
  readonly amount: AssetAmount;
  readonly verified: boolean;
};

export type ApprovalChange =
  | {
      /** A fungible-token allowance: on the token itself, or on Permit2 when `via` is "permit2". */
      readonly kind: "allowance";
      readonly spender: string;
      /** The token and amount (base units); symbol/decimals when the token is in the built-in table. */
      readonly amount: AssetAmount;
      /**
       * `set`: the allowance becomes `amount`; `increase`/`decrease`: it changes by `amount`;
       * `transfer`: a one-time right to take up to `amount` before `expiration` (Permit2
       * SignatureTransfer).
       */
      readonly change: "set" | "increase" | "decrease" | "transfer";
      /** `amount` is the type's maximum (uint256; uint160 for Permit2). */
      readonly unlimited: boolean;
      /** Unix seconds after which the allowance lapses (Permit2), when it has one. */
      readonly expiration?: number;
      readonly via?: "permit2";
      /** The token is in the built-in table. */
      readonly verified: boolean;
    }
  | {
      /** ERC-721/1155 `setApprovalForAll`: `spender` may move every token of `asset`. */
      readonly kind: "operator";
      readonly asset: string;
      readonly spender: string;
      /** `false` revokes. */
      readonly approved: boolean;
      readonly verified: false;
    };

export type IntentWarning = {
  readonly kind: string;
  readonly message: string;
};

/** The EIP-712 domain fields a wallet shows. */
export type TypedDataDomain = {
  readonly name?: string;
  readonly version?: string;
  readonly chainId?: number;
  /** EIP-55 checksummed. */
  readonly verifyingContract?: string;
  readonly salt?: string;
};

/** What a message request signs. */
export type MessageContent =
  | { readonly kind: "text"; readonly text: string; readonly signIn?: SignInParse }
  | { readonly kind: "bytes"; readonly hex: string }
  | {
      readonly kind: "typed-data";
      readonly primaryType: string;
      readonly domain: TypedDataDomain;
      readonly data: Readonly<Record<string, unknown>>;
    };

export type DisplayIntent = {
  readonly family: ChainFamily;
  readonly network: string;
  readonly summary: IntentSummary;
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly approvals: ReadonlyArray<ApprovalChange>;
  /**
   * `l1Data`: OP Stack L1 data fee plus operator fee, estimated by the engine and charged on top of
   * `max`; not decodable from the transaction, so the kernel's own decode never sets it.
   */
  readonly fee: { readonly max: AssetAmount; readonly l1Data?: AssetAmount } | undefined;
  readonly warnings: ReadonlyArray<IntentWarning>;
  /** What a message request signs; absent for transactions. */
  readonly message?: MessageContent;
  readonly verifiability: Verifiability;
};

export type ChainErrorCode =
  | "unknown-field"
  | "chain-id-mismatch"
  | "fee-payer-mismatch"
  | "invalid-quantity"
  | "invalid-address"
  | "invalid-typed-data"
  | "invalid-request"
  | "unsupported";

export class ChainError extends Error {
  readonly code: ChainErrorCode;
  constructor(code: ChainErrorCode, message: string) {
    super(message);
    this.name = "ChainError";
    this.code = code;
  }
}
