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

import type { MethodSpec } from "./core.ts";
import { groupIndex, safeTime, walletId } from "./core.ts";
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
 * The session schemes this kernel knows — its key set equals the kernel's `SESSION_SCHEMES` table:
 * a missing or extra entry fails the table's mapped-type emit.
 */
export type SessionSchemes = {
  readonly "hyperliquid-l1-agent": {
    readonly scope: HyperliquidNetwork;
    readonly params: HyperliquidL1Params;
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
};

const schemeId = str(32, /^[a-z][a-z0-9-]{1,31}$/);
const scope = str(64, /^[A-Za-z0-9._:-]{1,64}$/);
const evmAddress = str(42, /^0x[0-9a-fA-F]{40}$/);

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
});

/* Pass-through for `sessions.sign`'s `params`: the strict check is the scheme's params validator
   inside the kernel's handler, where malformed params answer `invalid-input`; a params-layer
   rejection would answer `integrity`. The envelope's isProtocolValue gate already certified the
   value, so the pass-through is sound. */
const paramsValue: Validator<ProtocolValue> = (value) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the comment above
  value as ProtocolValue;

export const SESSIONS_METHODS: {
  readonly "sessions.create": MethodSpec<
    {
      readonly scheme: string;
      readonly owner: { readonly walletId: string; readonly groupIndex: number };
      readonly scope: string;
      readonly name: string;
      readonly validUntil: number;
    },
    { readonly address: string }
  >;
  readonly "sessions.list": MethodSpec<NullValue, ReadonlyArray<SessionInfo>>;
  readonly "sessions.delete": MethodSpec<{ readonly address: string }, NullValue>;
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
    params: obj({
      scheme: schemeId,
      owner: obj({ walletId, groupIndex }),
      scope,
      name: str(16, /^[A-Za-z0-9._-]{1,16}$/),
      validUntil: safeTime,
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
