/**
 * The sessions module's method table: `session-key` records — a secp256k1 key the kernel generates,
 * stores under the vault, and uses to sign the document its scheme defines on behalf of one HD
 * account. The wire types are generic strings; the per-scheme types live in `SessionSchemes`.
 *
 * The kernel validates the scheme's params strictly inside `sessions.sign` — a params-layer
 * validation failure answers `integrity` (the protocol-wide rule for a malformed envelope), while
 * malformed params are a domain check that must answer `invalid-input` — the same split
 * `wallet.importMnemonic` uses for a bad mnemonic.
 */
import type { HyperliquidL1Params, HyperliquidNetwork } from "@qntx/wallet-chains/evm";

import type { MethodSpec, VerifyFactor } from "./core.ts";
import { groupIndex, safeTime, verifier, walletId } from "./core.ts";
import type { NullValue, ProtocolValue, Validator } from "./validate.ts";
import { arr, bool, bytes, nullValue, obj, str } from "./validate.ts";

/* The Hyperliquid L1 wire types live in @qntx/wallet-chains/evm — the one definition the kernel's
   scheme encoder and the chain decoders share; protocol re-exports them so the method table's
   names stay stable. */
export type {
  HyperliquidL1Action,
  HyperliquidL1Order,
  HyperliquidL1Params,
  HyperliquidNetwork,
} from "@qntx/wallet-chains/evm";

/**
 * The canonical grammar of a session record's `spent` — the decimal the kernel's meter produces.
 * The scheme's `positive` params grammar admits at most eight fractional digits, so an
 * order-notional charge (price × size) is exact at sixteen; the integer part is bounded by the
 * ~1e15 notional budget `spent` can never exceed. The kernel's record parser and the `SessionInfo`
 * validator share this one grammar so a value the kernel seals always parses.
 */
// oxlint-disable-next-line typescript/no-inferrable-types -- isolatedDeclarations requires the annotation
export const SESSION_SPENT: RegExp = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{0,15}[1-9])?$/;

/**
 * The limits a `hyperliquid-l1-agent` session is approved under — the cumulative sum of order price
 * × size (`notional`; perp ids are quoted in USDC, spot ids in each pair's own quote token), the
 * leverage cap (`maxLeverage`) and the asset-id allow-list (`assets`, ascending, distinct, each
 * below 100000 — builder-deployed HIP-3 perps start there and stay out of scope). The kernel
 * strictly validates them at create and charges every signed order's notional against `spent`; past
 * the budget it answers `limit-exceeded`.
 */
export type HyperliquidAgentLimits = {
  /** Canonical positive decimal (the scheme's `positive` grammar), at most 1e15. */
  readonly notional: string;
  readonly maxLeverage: number;
  readonly assets: ReadonlyArray<number>;
};

/**
 * The session schemes this kernel knows — its key set equals the kernel's `SESSION_SCHEMES` table:
 * a missing or extra entry fails the table's mapped-type emit.
 */
export type SessionSchemes = {
  readonly "hyperliquid-l1-agent": {
    readonly scope: HyperliquidNetwork;
    readonly params: HyperliquidL1Params;
    readonly limits: HyperliquidAgentLimits;
  };
};
export type SessionSchemeId = keyof SessionSchemes;

export type SessionInfo = {
  /** EIP-55 address of the session key. */
  readonly address: string;
  /** The record's scheme — possibly one this build does not know. */
  readonly scheme: string;
  /** Whether this build's kernel can sign with the record's scheme. */
  readonly supported: boolean;
  readonly walletId: string;
  readonly groupIndex: number;
  /** EIP-55 address of the HD account at m/44'/60'/0'/0/groupIndex the session signs for. */
  readonly owner: string;
  /** The scheme's opaque scope (a `HyperliquidNetwork` for hyperliquid-l1-agent). */
  readonly scope: string;
  readonly name: string;
  /** Wall-clock ms after which the kernel refuses to sign; the platform enforces it too. */
  readonly validUntil: number;
  readonly createdAt: number;
  /**
   * The limits the session was approved under — the scheme's canonical JSON object for metered
   * schemes, `null` when the record carries none (a scheme this build does not know, or one that
   * declares no metering).
   */
  readonly limits: ProtocolValue;
  /** Cumulative notional charged against `limits`, in the `SESSION_SPENT` grammar. */
  readonly spent: string;
};

const schemeId = str(32, /^[a-z][a-z0-9-]{1,31}$/);
const scope = str(64, /^[A-Za-z0-9._:-]{1,64}$/);
const evmAddress = str(42, /^0x[0-9a-fA-F]{40}$/);

/* Pass-through for `sessions.sign`'s `params`, `sessions.create`'s `limits` and the `limits` a
   session record reports: the strict check is the scheme's validator inside the kernel's handler,
   where malformed values answer `invalid-input`; a params-layer rejection would answer
   `integrity`. The envelope's isProtocolValue gate already certified the value, so the
   pass-through is sound. */
const paramsValue: Validator<ProtocolValue> = (value) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the comment above
  value as ProtocolValue;

const sessionInfo: Validator<SessionInfo> = obj({
  address: evmAddress,
  scheme: schemeId,
  supported: bool,
  walletId,
  groupIndex,
  owner: evmAddress,
  scope,
  name: str(16, /^[A-Za-z0-9._-]{1,16}$/),
  validUntil: safeTime,
  createdAt: safeTime,
  /* Opaque across schemes — the kernel revalidates it against the scheme's limits grammar before
     it is stored, so an arbitrary JSON value (or null) is safe to surface here. */
  limits: paramsValue,
  spent: str(32, SESSION_SPENT),
});

export const SESSIONS_METHODS: {
  readonly "sessions.create": MethodSpec<
    {
      readonly scheme: string;
      readonly owner: { readonly walletId: string; readonly groupIndex: number };
      readonly scope: string;
      readonly name: string;
      readonly validUntil: number;
      readonly limits: ProtocolValue;
      readonly verify: VerifyFactor;
    },
    { readonly address: string }
  >;
  readonly "sessions.list": MethodSpec<NullValue, ReadonlyArray<SessionInfo>>;
  readonly "sessions.delete": MethodSpec<{ readonly address: string }, NullValue>;
  readonly "sessions.open": MethodSpec<
    { readonly address: string; readonly verify: VerifyFactor },
    NullValue
  >;
  readonly "sessions.sign": MethodSpec<
    {
      readonly scheme: string;
      readonly address: string;
      readonly params: ProtocolValue;
    },
    { readonly signature: Uint8Array }
  >;
} = {
  "sessions.create": {
    session: true,
    presence: true,
    /* `limits` passes through like `params` — the scheme's own strict validator runs inside the
       kernel, where a malformed value answers `invalid-input`, not `integrity`. */
    params: obj({
      scheme: schemeId,
      owner: obj({ walletId, groupIndex }),
      scope,
      name: str(16, /^[A-Za-z0-9._-]{1,16}$/),
      validUntil: safeTime,
      limits: paramsValue,
      verify: verifier,
    }),
    result: obj({ address: evmAddress }),
  },
  "sessions.list": {
    session: true,
    presence: false,
    params: nullValue,
    result: arr(sessionInfo, 64),
  },
  "sessions.delete": {
    session: true,
    presence: true,
    params: obj({ address: evmAddress }),
    result: nullValue,
  },
  "sessions.open": {
    session: true,
    presence: true,
    params: obj({ address: evmAddress, verify: verifier }),
    result: nullValue,
  },
  "sessions.sign": {
    session: true,
    /* Deliberately not presence-bearing: a compromised main runtime must not be able to keep the
       vault unlocked forever by placing orders (design.md §协议). */
    presence: false,
    params: obj({
      scheme: schemeId,
      address: evmAddress,
      params: paramsValue,
    }),
    result: obj({ signature: bytes(65, 65) }),
  },
};
