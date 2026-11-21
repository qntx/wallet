/**
 * The apps module's method table: Hyperliquid L1 agent keys (design.md §协议, research.md §H2). An
 * agent is a secp256k1 key the kernel generates, stores under the vault, and uses to sign
 * Hyperliquid L1 actions (the phantom-agent `Agent` typed data) on behalf of one HD account.
 *
 * `hyperliquidL1Action` is the strict wire validator for the ten allow-listed action schemas
 * (research H2-T). It is exported for the kernel's signL1 handler, not used in `params`: a
 * params-layer validation failure answers `integrity` (the protocol-wide rule for a malformed
 * envelope), while a malformed action is a domain check that must answer `invalid-input` — the same
 * split `wallet.importMnemonic` uses for a bad mnemonic.
 */
import type { MethodSpec } from "./core.ts";
import { groupIndex, safeTime, walletId } from "./core.ts";
import type { NullValue, Validator } from "./validate.ts";
import { arr, bool, bytes, int, literal, nullValue, obj, opt, str, union } from "./validate.ts";

export type HyperliquidNetwork = "Mainnet" | "Testnet";

export type HyperliquidAgentInfo = {
  /** EIP-55 address of the agent key. */
  readonly address: string;
  /** EIP-55 address of the HD account at m/44'/60'/0'/0/groupIndex the agent signs for. */
  readonly owner: string;
  readonly walletId: string;
  readonly groupIndex: number;
  readonly network: HyperliquidNetwork;
  readonly name: string;
  /** Wall-clock ms after which the kernel refuses to sign; Hyperliquid enforces it too. */
  readonly validUntil: number;
  readonly createdAt: number;
};

const hyperliquidNetwork: Validator<HyperliquidNetwork> = union(
  literal("Mainnet"),
  literal("Testnet"),
);

const evmAddress = str(42, /^0x[0-9a-fA-F]{40}$/);
const lowerAddress = str(42, /^0x[0-9a-f]{40}$/);

/** A positive canonical decimal (nktkas's normalised output) — prices, sizes, trigger prices. */
const positive = str(24, /^(?:[1-9][0-9]{0,14}(?:\.[0-9]{0,7}[1-9])?|0\.[0-9]{0,7}[1-9])$/);
const cloid = str(34, /^0x[0-9a-f]{32}$/);
const asset = int(0, 4294967295);
const id = int(0, 9007199254740991);

const orderType = union(
  obj({
    limit: obj({
      tif: union(literal("Gtc"), literal("Ioc"), literal("Alo"), literal("FrontendMarket")),
    }),
  }),
  obj({
    trigger: obj({
      isMarket: bool,
      triggerPx: positive,
      tpsl: union(literal("tp"), literal("sl")),
    }),
  }),
);

export type HyperliquidL1Order = {
  readonly a: number;
  readonly b: boolean;
  readonly p: string;
  readonly s: string;
  readonly r: boolean;
  readonly t:
    | { readonly limit: { readonly tif: "Gtc" | "Ioc" | "Alo" | "FrontendMarket" } }
    | {
        readonly trigger: {
          readonly isMarket: boolean;
          readonly triggerPx: string;
          readonly tpsl: "tp" | "sl";
        };
      };
  readonly c?: string;
};

const orderWire: Validator<HyperliquidL1Order> = obj({
  a: asset,
  b: bool,
  p: positive,
  s: positive,
  r: bool,
  t: orderType,
  c: opt(cloid),
});

const oid = union(id, cloid);

/** The ten allow-listed L1 actions (research H2-T), in the table's order. */
export type HyperliquidL1Action =
  | {
      readonly type: "order";
      readonly orders: ReadonlyArray<HyperliquidL1Order>;
      readonly grouping: "na" | "normalTpsl" | "positionTpsl";
      readonly builder?: { readonly b: string; readonly f: number };
    }
  | {
      readonly type: "cancel";
      readonly cancels: ReadonlyArray<{ readonly a: number; readonly o: number }>;
      readonly f?: true;
    }
  | {
      readonly type: "cancelByCloid";
      readonly cancels: ReadonlyArray<{ readonly asset: number; readonly cloid: string }>;
      readonly f?: true;
    }
  | {
      readonly type: "modify";
      readonly oid: number | string;
      readonly order: HyperliquidL1Order;
      readonly a?: true;
    }
  | {
      readonly type: "batchModify";
      readonly modifies: ReadonlyArray<{
        readonly oid: number | string;
        readonly order: HyperliquidL1Order;
      }>;
      readonly a?: true;
    }
  | { readonly type: "scheduleCancel"; readonly time?: number }
  | {
      readonly type: "updateLeverage";
      readonly asset: number;
      readonly isCross: boolean;
      readonly leverage: number;
    }
  | {
      readonly type: "updateIsolatedMargin";
      readonly asset: number;
      readonly isBuy: boolean;
      readonly ntli: number;
    }
  | {
      readonly type: "twapOrder";
      readonly twap: {
        readonly a: number;
        readonly b: boolean;
        readonly s: string;
        readonly r: boolean;
        readonly m: number;
        readonly t: boolean;
      };
    }
  | { readonly type: "twapCancel"; readonly a: number; readonly t: number };

/**
 * The strict wire validator: every action is an exact-key object; unknown `type` or extra keys
 * fail. `grouping` admits only the free groupings — `{p}` is a priority fee of up to 100 % of
 * notional (nktkas order.ts:69-84) — and builder `s` splits are not accepted; twapOrder's optional
 * `details` is rejected too.
 */
export const hyperliquidL1Action: Validator<HyperliquidL1Action> = union(
  obj({
    type: literal("order"),
    orders: arr(orderWire, 64, 1),
    grouping: union(literal("na"), literal("normalTpsl"), literal("positionTpsl")),
    builder: opt(obj({ b: lowerAddress, f: int(0, 1000) })),
  }),
  obj({
    type: literal("cancel"),
    cancels: arr(obj({ a: asset, o: id }), 64, 1),
    f: opt(literal(true)),
  }),
  obj({
    type: literal("cancelByCloid"),
    cancels: arr(obj({ asset, cloid }), 64, 1),
    f: opt(literal(true)),
  }),
  obj({
    type: literal("modify"),
    oid,
    order: orderWire,
    a: opt(literal(true)),
  }),
  obj({
    type: literal("batchModify"),
    modifies: arr(obj({ oid, order: orderWire }), 64, 1),
    a: opt(literal(true)),
  }),
  obj({ type: literal("scheduleCancel"), time: opt(id) }),
  obj({ type: literal("updateLeverage"), asset, isCross: bool, leverage: int(1, 1000) }),
  obj({
    type: literal("updateIsolatedMargin"),
    asset,
    isBuy: bool,
    ntli: int(-9007199254740991, 9007199254740991),
  }),
  obj({
    type: literal("twapOrder"),
    twap: obj({ a: asset, b: bool, s: positive, r: bool, m: int(5, 1440), t: bool }),
  }),
  obj({ type: literal("twapCancel"), a: asset, t: id }),
);

/**
 * Pass-through for `signL1`'s `action`: the strict check is `hyperliquidL1Action` inside the
 * kernel's handler, where a malformed action answers `invalid-input`; a params-layer rejection
 * would answer `integrity`. The declared type still names the strict shape so host callers get
 * compile-time checking; the kernel revalidates what actually arrives.
 */
const actionValue: Validator<HyperliquidL1Action> = (value) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the doc above
  value as HyperliquidL1Action;

const agentInfo: Validator<HyperliquidAgentInfo> = obj({
  address: evmAddress,
  owner: evmAddress,
  walletId,
  groupIndex,
  network: hyperliquidNetwork,
  name: str(16, /^[A-Za-z0-9._-]{1,16}$/),
  validUntil: safeTime,
  createdAt: safeTime,
});

export const APPS_METHODS: {
  readonly "hyperliquid.createAgent": MethodSpec<
    {
      readonly owner: { readonly walletId: string; readonly groupIndex: number };
      readonly network: HyperliquidNetwork;
      readonly name: string;
      readonly validUntil: number;
    },
    { readonly address: string }
  >;
  readonly "hyperliquid.listAgents": MethodSpec<NullValue, ReadonlyArray<HyperliquidAgentInfo>>;
  readonly "hyperliquid.deleteAgent": MethodSpec<{ readonly address: string }, NullValue>;
  readonly "hyperliquid.signL1": MethodSpec<
    {
      readonly agent: string;
      readonly action: HyperliquidL1Action;
      readonly nonce: number;
      readonly vaultAddress?: string;
      readonly expiresAfter?: number;
    },
    { readonly signature: Uint8Array }
  >;
} = {
  "hyperliquid.createAgent": {
    session: true,
    presence: true,
    params: obj({
      owner: obj({ walletId, groupIndex }),
      network: hyperliquidNetwork,
      name: str(16, /^[A-Za-z0-9._-]{1,16}$/),
      validUntil: safeTime,
    }),
    result: obj({ address: evmAddress }),
  },
  "hyperliquid.listAgents": {
    session: true,
    presence: false,
    params: nullValue,
    result: arr(agentInfo, 16),
  },
  "hyperliquid.deleteAgent": {
    session: true,
    presence: true,
    params: obj({ address: evmAddress }),
    result: nullValue,
  },
  "hyperliquid.signL1": {
    session: true,
    /* Deliberately not presence-bearing: a compromised main runtime must not be able to keep the
       vault unlocked forever by placing orders (design.md §协议). */
    presence: false,
    params: obj({
      agent: evmAddress,
      /* Checked strictly by the kernel's signL1 handler (hyperliquidL1Action) so a malformed
         action answers invalid-input, not the params layer's integrity. The envelope's
         isProtocolValue gate already certified the shape, so this pass-through is sound. */
      action: actionValue,
      nonce: safeTime,
      vaultAddress: opt(lowerAddress),
      expiresAfter: opt(safeTime),
    }),
    result: obj({ signature: bytes(65, 65) }),
  },
};
