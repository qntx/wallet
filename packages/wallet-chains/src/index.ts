/**
 * @qntx/wallet-chains — shared chain semantics for the wallet.
 * Types here are wire-safe: values crossing the main↔kernel protocol are
 * Uint8Array, safe integers, strings, booleans, arrays and plain objects.
 * Quantities are canonical `0x` hex (lowercase, no leading zeros, `0x0` for
 * zero), token amounts are decimal strings of the smallest unit.
 */

import { isHexRendering, isReadableText } from "./display.ts";
import { parseSignIn } from "./sign-in.ts";
import type { SignInParse } from "./sign-in.ts";

export { displayExcerpt, isHexRendering, isReadableText, isUnsafeCodePoint } from "./display.ts";
export type { DisplayExcerpt } from "./display.ts";
export { parseSignIn } from "./sign-in.ts";
export type { SignInClaim, SignInParse } from "./sign-in.ts";

export type ChainFamily = "evm" | "solana" | "bitcoin" | "tron";

export type AccountRef =
  | {
      readonly kind: "hd";
      readonly walletId: string;
      readonly groupIndex: number;
      readonly template: string;
    }
  | { readonly kind: "imported"; readonly keyId: string; readonly family: ChainFamily };

/** The BIP-44/49/84/86 account-level templates a bitcoin.psbt input may sign under. */
export type BitcoinTemplate = "btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86";

export type SignRequest =
  | {
      readonly kind: "bitcoin.psbt";
      readonly network: string;
      /** The wallet group whose keys sign; each signed input names its template. */
      readonly account: {
        readonly kind: "hd";
        readonly walletId: string;
        readonly groupIndex: number;
      };
      readonly psbt: Uint8Array;
      /** Inputs to sign — non-empty, unique, ascending by index, in range; each with its template. */
      readonly sign: ReadonlyArray<{ readonly index: number; readonly template: BitcoinTemplate }>;
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
    }
  | {
      readonly kind: "tron.transaction";
      readonly network: string;
      readonly account: AccountRef;
      /** `Transaction.raw` wire bytes — the only thing a TRON signature authorises. */
      readonly rawData: Uint8Array;
    }
  | {
      readonly kind: "tron.message";
      readonly network: string;
      readonly account: AccountRef;
      readonly message: Uint8Array;
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
    })
  | (Omit<EvmTransactionBase, "to"> & {
      readonly type: "eip7702";
      readonly to: string;
      readonly accessList: ReadonlyArray<EvmAccessListEntry>;
      readonly maxFeePerGas: string;
      readonly maxPriorityFeePerGas: string;
      /**
       * One self-sponsored authorization: its chain id is the transaction's chain id and its nonce
       * is `tx.nonce + 1`, so multi-tuple or nonce-mismatched authorizations are unrepresentable.
       * The zero address revokes an existing delegation.
       */
      readonly authorization: { readonly address: string };
    });

export type Verifiability = "full" | "partial" | "opaque";

/** Why a request is blind: the signer can neither show it nor bound what it authorises. */
export type BlindReason =
  // message content that is not readable text: non-UTF-8 bytes, a message of exactly 32 bytes
  // (digest length), text with an unsafe code point other than TAB/LF/CR, or text that is the hex
  // rendering of ≥ 32 bytes
  | "message-bytes"
  | "typed-data-commitment" // typed data whose every leaf is a commitment (a hash or opaque bytes)
  // typed data a recognised family claims, in a shape the decoder does not recognise
  | "typed-data-variant"
  // typed data that cannot be shown in full: an unrecognised document over the leaf budget, or a
  // recognised Seaport order with more offer or consideration items than the prompt shows
  | "typed-data-oversize"
  | "token-function" // an unrecognised function of a built-in-table token
  | "account-code" // calldata to the signing account itself (its own, possibly delegated, code)
  | "safe-delegatecall" // a Safe delegatecall to anything but canonical MultiSendCallOnly entries
  | "safe-refund-unbounded" // a SafeTx with gasPrice > 0: the refund total depends on executor gas
  // an undecoded instruction of a core Solana program (System, Token, Token-2022, Stake, Associated
  // Token) that the signer takes part in
  | "core-instruction"
  // a TRON contract type the wallet does not describe (unsupported or unknown enum value)
  | "tron-contract"
  // TRON raw/contract/value fields the decoder cannot bound, or an enum out of the modeled range
  | "tron-field"
  // a TRON permission update: decoded in full, but it hands account control to other keys
  | "tron-permission-update";

/** One leaf of an unrecognised typed-data document, as a display line. */
export type TypedDataLeaf = { readonly path: string; readonly value: string };

export type IntentSummary =
  | "transfer"
  | "approve"
  | "contract-call"
  | "swap"
  | "message"
  | "authorization"
  | "batch"
  | "stake"
  | "bridge";

export type AssetAmount = {
  readonly asset: string;
  readonly amount: string;
  readonly decimals?: number;
  readonly symbol?: string;
  /** NFT flows only: the decimal token id; `amount` is then the unit count. */
  readonly tokenId?: string;
};

export type AssetFlow = {
  readonly to: string;
  readonly amount: AssetAmount;
  readonly verified: boolean;
  /**
   * The output is provably unspendable (a Bitcoin script that starts with OP_RETURN or exceeds the
   * 10,000-byte script limit): `amount` is destroyed and `to` is the script hex.
   */
  readonly burn?: true;
  /** The ENS name the recipient was resolved from; attached by the engine, never decoded. */
  readonly name?: string;
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
      readonly via?: "permit2" | "allowance-holder";
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
    }
  | {
      /**
       * A Solana stake account's staker or withdrawer role handed to a key other than the signer —
       * by an `Authorize`/`AuthorizeChecked` instruction, or by `Initialize` naming a non-signer.
       */
      readonly kind: "stake-authority";
      /** The stake account the role applies to. */
      readonly account: string;
      readonly role: "staker" | "withdrawer";
      /** The key receiving the role. */
      readonly authority: string;
      readonly verified: false;
    };

/** The TRON resource a freeze/delegate acts on (ResourceCode 0/1/2). */
export type TronResource = "bandwidth" | "energy" | "tron-power";

/** A decoded TRON account permission; `operations` is the 32-byte bitmap hex, actives only. */
export type TronPermission = {
  readonly type: "owner" | "witness" | "active";
  readonly id: number;
  readonly name: string;
  /** Decimal string. */
  readonly threshold: string;
  readonly parentId: number;
  readonly operations?: string;
  readonly keys: ReadonlyArray<{ readonly address: string; readonly weight: string }>;
};

/** One staking operation shown on the signing surface. */
export type StakeAction =
  | { readonly kind: "create"; readonly account: string; readonly lamports: string }
  | { readonly kind: "delegate"; readonly account: string; readonly validator: string }
  | { readonly kind: "deactivate"; readonly account: string }
  | {
      readonly kind: "withdraw";
      readonly account: string;
      readonly to: string;
      readonly lamports: string;
    }
  /** Lido `submit` on Ethereum mainnet: ETH in, approximately `receive` stETH back. */
  | { readonly kind: "lido-submit"; readonly amount: AssetAmount; readonly receive: AssetAmount }
  /** Lido withdrawal request on Ethereum mainnet; `owner` gets the claim NFT. */
  | {
      readonly kind: "lido-request";
      readonly token: string;
      readonly amount: AssetAmount;
      readonly owner: string;
    }
  /** Lido claim of finalised withdrawal requests on Ethereum mainnet (ETH to the caller). */
  | { readonly kind: "lido-claim"; readonly requestIds: ReadonlyArray<string> }
  /** FreezeBalanceV2 / UnfreezeBalanceV2. */
  | {
      readonly kind: "tron-freeze" | "tron-unfreeze";
      readonly amount: AssetAmount;
      readonly resource: TronResource;
    }
  /** DelegateResourceContract; `lock` present only when the lock flag is set. */
  | {
      readonly kind: "tron-delegate";
      readonly receiver: string;
      readonly amount: AssetAmount;
      readonly resource: TronResource;
      readonly lock?: { readonly blocks: string };
    }
  /** UnDelegateResourceContract. */
  | {
      readonly kind: "tron-undelegate";
      readonly receiver: string;
      readonly amount: AssetAmount;
      readonly resource: TronResource;
    }
  | { readonly kind: "tron-withdraw-unfrozen" }
  | { readonly kind: "tron-cancel-unfreeze" }
  /** WithdrawBalanceContract — claims the SR-voting reward balance. */
  | { readonly kind: "tron-claim-rewards" }
  | {
      readonly kind: "tron-vote";
      readonly votes: ReadonlyArray<{ readonly witness: string; readonly count: string }>;
    };

export type IntentWarning = {
  readonly kind: string;
  readonly message: string;
};

/** One item a Seaport order offers or requests; recognized from EIP-712 `itemType` 0–5. */
export type SeaportItem = {
  readonly kind: "native" | "erc20" | "erc721" | "erc1155" | "erc721-criteria" | "erc1155-criteria";
  /** The item's contract (EIP-55 checksummed; the zero address for `native`). */
  readonly token: string;
  /** `identifierOrCriteria` as a decimal string; a criteria root for the criteria kinds. */
  readonly identifier: string;
  readonly startAmount: AssetAmount;
  readonly endAmount: AssetAmount;
};

/** A recognized Seaport `OrderComponents` message. */
export type SeaportOrder = {
  readonly offerer: string;
  readonly zone: string;
  readonly startTime: number | undefined;
  readonly endTime: number | undefined;
  readonly offer: ReadonlyArray<SeaportItem>;
  readonly consideration: ReadonlyArray<SeaportItem & { readonly recipient: string }>;
};

/** A recognized Safe `SafeTx` message. */
export type SafeTransaction = {
  readonly safe: string;
  /** The Safe nonce as a decimal string. */
  readonly nonce: string;
  readonly operation: "call" | "delegatecall";
  readonly to: string;
  /** Wei, decimal. */
  readonly value: string;
  readonly data: string;
  /** The inner call(s) decoded with the transaction rules (no fee); one per MultiSend entry. */
  readonly calls: ReadonlyArray<DisplayIntent>;
  /**
   * The gas refund the Safe pays when `gasPrice` is not zero: `(gasUsed + baseGas) × gasPrice` of
   * the gas token, where `gasUsed` is at most `safeTxGas` for the call plus the call's own
   * overhead, which the executor can raise — so the total is not bounded by the signed fields.
   */
  readonly refund?: {
    /** `refundReceiver`; absent when it is the zero address, which pays whoever executes. */
    readonly receiver?: string;
    /** The price per gas unit, in the gas token (the native asset for the zero address). */
    readonly gasPrice: AssetAmount;
    /** `(baseGas + safeTxGas) × gasPrice`: the refund before the call's overhead gas. */
    readonly amount: AssetAmount;
  };
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
      /** A recognized Seaport order; only the exact `OrderComponents` shape populates it. */
      readonly seaport?: SeaportOrder;
      /** A recognized Safe transaction; only the exact `SafeTx` shape populates it. */
      readonly safe?: SafeTransaction;
      /**
       * Every leaf of an unrecognised document that fits the display budget; absent for a
       * recognized shape and for one too large to show in full. Present even when the document is
       * blind (`typed-data-commitment`), so the prompt can still show the leaves it signs.
       */
      readonly fields?: ReadonlyArray<TypedDataLeaf>;
    };

const utf8 = new TextDecoder("utf-8", { fatal: true });

const bytesContent = (bytes: Uint8Array): MessageContent => ({
  kind: "bytes",
  hex: `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
});

/**
 * Strict UTF-8 readable text with any sign-in recognition for `family`, else the raw bytes as hex.
 * A message of exactly 32 bytes is bytes, not text: Safe's eth_sign path (`v > 30`) and EIP-191
 * digest verifiers sign `"\x19Ethereum Signed Message:\n32" ‖ digest`, and only a 32-byte message
 * has that preimage — no display can tell a 32-byte text from a digest that happens to be UTF-8 (≈1
 * in 7×10⁷ keccak outputs are; grindable in minutes).
 */
export const messageContent = (
  bytes: Uint8Array,
  family: "evm" | "solana" | "tron",
): MessageContent => {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return bytesContent(bytes);
  }
  if (bytes.length === 32 || !isReadableText(text)) {
    return bytesContent(bytes);
  }
  const signIn = parseSignIn(text, family);
  return signIn === undefined ? { kind: "text", text } : { kind: "text", text, signIn };
};

export type DisplayIntent = {
  readonly family: ChainFamily;
  readonly network: string;
  readonly summary: IntentSummary;
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly approvals: ReadonlyArray<ApprovalChange>;
  /**
   * The minimums the settlement contracts enforce on-chain for recognised swaps — each
   * `minAmountOut` a Settler requires its own balance to reach before paying the recipient, not an
   * estimate. Present only when non-empty; a batch concatenates its calls' lists like the others.
   */
  readonly minimumReceived?: ReadonlyArray<{
    readonly to: string;
    readonly amount: AssetAmount;
  }>;
  /**
   * `l1Data`: OP Stack L1 data fee plus operator fee, estimated by the engine and charged on top of
   * `max`; not decodable from the transaction, so the kernel's own decode never sets it.
   */
  readonly fee: { readonly max: AssetAmount; readonly l1Data?: AssetAmount } | undefined;
  /**
   * Recognized Solana stake operations — create, delegate, deactivate, withdraw — one per
   * instruction, in order. Present only when non-empty.
   */
  readonly staking?: ReadonlyArray<StakeAction>;
  /**
   * A recognized Across SpokePool deposit: the calldata-stated destination chain, the fill deadline
   * after which an unfilled deposit refunds `refundTo` on this chain.
   */
  readonly bridge?: {
    readonly destinationNetwork: string;
    readonly fillDeadline: number;
    readonly refundTo: string;
  };
  readonly warnings: ReadonlyArray<IntentWarning>;
  /** What a message request signs; absent for transactions. */
  readonly message?: MessageContent;
  readonly verifiability: Verifiability;
  /** Present iff the transaction carries an EIP-7702 authorization. */
  readonly delegation?:
    | {
        readonly kind: "set";
        readonly delegator: string;
        readonly name: string;
        readonly version: string;
      }
    | { readonly kind: "revoke" };
  /** The decoded inner calls of a recognized ERC-7821 batch execute. */
  readonly calls?: ReadonlyArray<DisplayIntent>;
  /** The contract an EVM call with calldata runs: the callee, or the address a creation deploys. */
  readonly contract?: {
    readonly address: string;
    readonly created: boolean;
    /** `data`'s first four bytes (all of it when shorter); absent on a creation. */
    readonly selector?: string;
    /** The built-in token table's symbol, when the callee is a listed token. */
    readonly symbol?: string;
  };
  /**
   * Solana only: the program ids of instructions the decoder does not recognise, de-duplicated in
   * first-appearance order; present iff non-empty (so iff a Solana transaction is `opaque`).
   */
  readonly programs?: ReadonlyArray<string>;
  /** TRON transaction fields the prompt shows on every request. */
  readonly tron?: {
    readonly contractType: string;
    /** Unix ms. */
    readonly expiration: number;
    /** Present only when the contract's Permission_id is non-zero. */
    readonly permissionId?: number;
    readonly memo?:
      | { readonly kind: "text"; readonly text: string }
      | { readonly kind: "bytes"; readonly hex: string };
    /** Full permission content of an AccountPermissionUpdateContract. */
    readonly permissionUpdate?: {
      readonly owner: TronPermission;
      readonly witness?: TronPermission;
      readonly actives: ReadonlyArray<TronPermission>;
    };
  };
  /** Why the request is blind — the signer can neither show it nor bound what it authorises. */
  readonly blind?: BlindReason;
};

/**
 * A request is blind exactly when the decoder set `blind` — what the prompt prints does not bound
 * what the signature authorises. A request the decoder can describe in full but not verify (an
 * `opaque` call, an unrecognised but fully listed typed-data document whose leaves are readable
 * values) is not blind; one whose every leaf is a commitment, or which a decoded family claims in
 * an unrecognised shape, is.
 */
export const isBlindIntent = (intent: Pick<DisplayIntent, "blind">): boolean =>
  intent.blind !== undefined;

/**
 * Why a message is blind. `bytes` always is — no prompt can show it. `text` is blind when its UTF-8
 * length is 32 (a digest has the same EIP-191 preimage — see `messageContent`), when it holds an
 * unsafe code point other than TAB/LF/CR, or when it is only the hex rendering of ≥ 32 bytes: the
 * owner sees the rendering, not the bytes it encodes. Checking the content again here gives callers
 * that build `{ kind: "text" }` themselves the same verdict.
 */
export const messageBlindReason = (message: MessageContent): BlindReason | undefined =>
  message.kind === "bytes"
    ? "message-bytes"
    : message.kind === "text" &&
        (new TextEncoder().encode(message.text).length === 32 ||
          !isReadableText(message.text) ||
          isHexRendering(message.text))
      ? "message-bytes"
      : undefined;

export type ChainErrorCode =
  | "unknown-field"
  | "chain-id-mismatch"
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
