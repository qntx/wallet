/**
 * The approvals inventory: every authority a wallet account has handed out, as rows a host can
 * list, value and (for the revocable kinds) act on. Every row's content comes from a chain read at
 * a stated height through the engine's corroborated read path — discovery sources contribute
 * candidate keys only and never write a row themselves.
 */
import type { SessionInfo } from "@qntx/wallet/protocol";

/** The authority forms a row can take, by chain. */
export type ApprovalKind =
  | "erc20"
  | "permit2"
  | "operator"
  | "nft"
  | "delegation"
  | "spl-delegate"
  | "spl-close-authority"
  | "spl-mint-authority"
  | "stake-authority"
  | "trc20"
  | "tron-permission";

/** What makes a row dangerous to leave standing. */
export type ApprovalRisk =
  /** The grantee may take the full balance, now and as it grows. */
  | "unlimited"
  /** The spender key is an externally owned account, not a contract. */
  | "eoa-spender"
  /** The spender address holds no code and has never transacted — a dead or unborn grantee. */
  | "spender-no-code"
  /** The grantee shares its first and last characters with a known address — a lookalike. */
  | "address-poisoning"
  /** The account's 7702 delegation points at a contract that is not this wallet's delegator. */
  | "foreign-delegation";

/** Where the candidate key that produced a row came from. `chain`: the chain enumerated it. */
export type ApprovalSource = "gateway" | "local" | "chain";

/** A token a row names; display metadata only, resolved best-effort and never trusted. */
export type TokenRef = {
  readonly address: string;
  readonly symbol?: string;
  readonly decimals?: number;
};

type RowBase = {
  /** Stable id inside its view — e.g. `erc20:<token>:<spender>` (lowercase EVM addresses). */
  readonly id: string;
  readonly network: string;
  /** Every applicable risk flag. */
  readonly risk: ReadonlyArray<ApprovalRisk>;
  /**
   * True only when the corroborating upstream agreed with the primary read (or no second upstream
   * was needed). An unverified row is shown but marked.
   */
  readonly verified: boolean;
  /** The sources whose candidate produced this row; `chain` when the chain enumerates the kind. */
  readonly sources: ReadonlyArray<ApprovalSource>;
  /**
   * How the row can be revoked from this wallet: `single` — one transaction per row; `batchable` —
   * alone or inside a multicall batch; `none` — not revocable here.
   */
  readonly revoke: "single" | "batchable" | "none";
};

/**
 * One standing authority. `amount`/`exposure` are base-unit decimal strings read at the view's
 * height; `exposure` is what the grantee can take right now (allowance bounded by balance and, for
 * Permit2, by the token's allowance to Permit2 itself).
 */
export type ApprovalRow = RowBase &
  (
    | {
        readonly kind: "erc20" | "trc20";
        readonly token: TokenRef;
        readonly spender: string;
        readonly amount: string;
        readonly unlimited: boolean;
        readonly exposure?: string;
      }
    | {
        readonly kind: "permit2";
        readonly token: TokenRef;
        readonly spender: string;
        readonly amount: string;
        /** Unix seconds; Permit2 allowances always carry one. */
        readonly expiration: number;
        readonly unlimited: boolean;
        readonly exposure?: string;
      }
    | {
        /** ERC-721/1155 `setApprovalForAll`: `operator` may move every token of `contract`. */
        readonly kind: "operator";
        readonly contract: string;
        readonly operator: string;
      }
    | {
        /** ERC-721 `approve`: `spender` (the chain's answer, not the candidate's) holds `tokenId`. */
        readonly kind: "nft";
        readonly contract: string;
        readonly tokenId: string;
        readonly spender: string;
      }
    | {
        /** EIP-7702: `address` runs as the account's code; `ours` names this wallet's delegator. */
        readonly kind: "delegation";
        readonly address: string;
        readonly ours: boolean;
      }
    | {
        /** An SPL token account's delegate and its remaining allowance. */
        readonly kind: "spl-delegate";
        readonly tokenAccount: string;
        /** The mint the token account holds. */
        readonly token: TokenRef;
        readonly delegate: string;
        readonly amount: string;
        readonly exposure?: string;
        readonly program: "token" | "token-2022";
      }
    | {
        /** A close authority on the token account other than the owner. */
        readonly kind: "spl-close-authority";
        readonly tokenAccount: string;
        readonly mint: string;
        readonly authority: string;
      }
    | {
        /** A mint's freeze authority, or a Token-2022 permanent delegate. */
        readonly kind: "spl-mint-authority";
        readonly mint: string;
        readonly role: "freeze" | "permanent-delegate";
        readonly authority: string;
      }
    | {
        /** A stake account role held by a key other than the owner. */
        readonly kind: "stake-authority";
        readonly stakeAccount: string;
        readonly role: "staker" | "withdrawer";
        readonly authority: string;
      }
    | {
        /** A TRON account permission containing a key other than the owner's. */
        readonly kind: "tron-permission";
        readonly permission: "owner" | "active" | "witness";
        readonly name: string;
        /** Threshold and weights as decimal strings. */
        readonly threshold: string;
        readonly keys: ReadonlyArray<{ readonly address: string; readonly weight: string }>;
      }
  );

/** How one candidate source fared during the last refresh. */
export type ApprovalSourceState = {
  readonly source: "gateway" | "local";
  /**
   * `ok`: answered; `truncated`: answered but could not carry every candidate; `failed`: error or
   * malformed; `unsupported`: the gateway has no coverage here; `unavailable`: no gateway or no
   * gateway-first indexer path exists.
   */
  readonly status: "ok" | "truncated" | "failed" | "unsupported" | "unavailable";
  /** Unix ms of the last successful answer. */
  readonly at?: number;
  /** The block head the gateway scanned to (EVM only). */
  readonly toBlock?: string;
};

/**
 * A kernel session key signing for this view's owner — linked, never duplicated: it is revoked
 * through the app that owns the scheme, not through this list.
 */
export type SessionLink = Pick<
  SessionInfo,
  "address" | "scheme" | "name" | "validUntil" | "supported"
>;

/**
 * One account's approvals on one network. `rows` holds every standing authority found; the counters
 * say how the refresh went for what is not in `rows`: `dropped` — candidates the chain proved
 * inactive; `disputed` — primary and corroborator disagreed (never shown); `unread` — candidates
 * that could not be read; `unverified` — rows shown without a corroborating read.
 */
export type ApprovalsView = {
  readonly key: string;
  readonly network: string;
  readonly owner: string;
  readonly status: "loading" | "ready" | "failed";
  /** The height every row was read at: an EVM block, a Solana slot, a TRON head. */
  readonly at?: { readonly height: string; readonly time?: number };
  readonly rows: ReadonlyArray<ApprovalRow>;
  /**
   * The kinds the chain enumerates for this view (EVM delegation; the SPL account reads; TRON
   * permissions) — for every other kind the list is "known approvals" only.
   */
  readonly exhaustive: ReadonlyArray<ApprovalKind>;
  readonly sources: ReadonlyArray<ApprovalSourceState>;
  readonly dropped: number;
  readonly disputed: number;
  readonly unread: number;
  readonly unverified: number;
  /** Kernel session keys signing for this owner — link targets, not rows. */
  readonly sessions: ReadonlyArray<SessionLink>;
  readonly updatedAt?: number;
  readonly error?: string;
};

export type ApprovalsState = {
  readonly views: Readonly<Record<string, ApprovalsView>>;
};
