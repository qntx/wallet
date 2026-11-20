/**
 * Recognition of Hyperliquid user-signed actions: EIP-712 documents under the
 * `HyperliquidSignTransaction` domain (version "1", zero verifying contract) whose only struct is
 * one `HyperliquidTransaction:<X>` type with exactly the field list nktkas's `<X>Types` constants
 * declare (`src/api/exchange/_methods/*.ts` in @nktkas/hyperliquid 0.33.3; python `signing.py`'s
 * `*_SIGN_TYPES` agree). Every signed field must parse strictly, else the document is left
 * unclaimed and the family table blinds it as `typed-data-variant`.
 *
 * The user-signed types left unclaimed on purpose — all blind `typed-data-variant` via the
 * "Hyperliquid" family row:
 *
 * - `ConvertToMultiSigUser` — hands account authority to a signer set given as JSON text (nktkas
 *   convertToMultiSigUser.ts:124)
 * - `LinkStakingUser` (linkStakingUser.ts:106) and `StakingLinkDisableTradingUser`
 *   (stakingLinkDisableTradingUser.ts:105) — rebind trading authority to another address
 * - `SendToEvmWithData` — carries an arbitrary `data` call (sendToEvmWithData.ts:110)
 * - `UserDexAbstraction` (userDexAbstraction.ts:100), `UserPortfolioMargin`
 *   (userPortfolioMargin.ts:98) and `UserSetAbstraction` (userSetAbstraction.ts:101) — change how
 *   the account's orders and transfers are routed
 * - `SendMultiSig` — the envelope signs only a bytes32 hash of the real action (python signing.py
 *   `MULTI_SIG_ENVELOPE_SIGN_TYPES`), the same commitment problem as L1
 * - Any type with `payloadMultiSigUser`/`outerSigner` injected for inner multi-sig signatures — the
 *   field-list check fails (nktkas _userSigned.ts `signUserSignedInner`)
 *
 * The L1 trading actions are not user-signed data: they sign `Agent{source,connectionId}` under the
 * `Exchange` domain where `connectionId` is a keccak of the msgpack action (nktkas _l1.ts) — a
 * commitment no prompt can bound, blind `typed-data-commitment` via the "Hyperliquid L1" row.
 */
import { displayExcerpt } from "../display.ts";
import type {
  AssetFlow,
  BlindReason,
  HyperliquidAction,
  HyperliquidChain,
  IntentSummary,
  IntentWarning,
  Verifiability,
} from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { domainChainId, sameFields, typedDataAddress, typedDataUint } from "./typed-data.ts";
import type { TypedDataInput, TypedDataMessage } from "./typed-data.ts";

/** What a recognized app document produces; `blind` stays unset for Hyperliquid. */
export type HyperliquidRecognition = {
  readonly content: { readonly hyperliquid: HyperliquidAction };
  readonly summary: IntentSummary;
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly warnings: ReadonlyArray<IntentWarning>;
  readonly verifiability: Verifiability;
  readonly blind?: BlindReason;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_UINT64 = 2n ** 64n - 1n;

/* The domain both SDKs build (nktkas _userSigned.ts signUserSignedAction; python signing.py
   user_signed_payload) — name "HyperliquidSignTransaction", version "1", chainId =
   signatureChainId, zero verifyingContract. */
const EIP712_DOMAIN = [
  "string name",
  "string version",
  "uint256 chainId",
  "address verifyingContract",
];

const PREFIX = "HyperliquidTransaction:";

/* Decimal amounts are kept and shown verbatim — no sign, exponent or suffix, so
   usdClassTransfer's `"1 subaccount:0x…"` form (docs exchange-endpoint §Transfer from Spot
   account to Perp account) does not parse. Tighter than the SDK's normalized UnsignedDecimal
   (nktkas _schemas.ts). */
const AMOUNT = /^[0-9]{1,15}(\.[0-9]{1,8})?$/;
/* Address values inside `string` fields are lowercase hex only — the SDK's canonical form
   (nktkas _schemas.ts Address lowercases); checksummed for display. */
const STRING_ADDRESS = /^0x[0-9a-f]{40}$/;
/* sendAsset token is `"NAME:0x<tokenId>"` (docs exchange-endpoint §Send Asset). */
const TOKEN = /^[A-Za-z0-9]{1,16}:0x[0-9a-f]{32}$/;
/* DEX names: `""` is perps, `"spot"` is spot, anything else a builder DEX (docs §Send Asset). */
const DEX_NAME = /^[A-Za-z0-9]{0,16}$/;
/* approveBuilderFee maxFeeRate is a percent string (nktkas _schemas.ts Percent). */
const FEE_RATE = /^[0-9]{1,3}(\.[0-9]{1,6})?%$/;
/* approveAgent agentName may end with ` valid_until <ms>` (docs exchange-endpoint §Approve an
   API wallet; nktkas approveAgent.ts `/ valid_until \d+$/`). */
const AGENT_EXPIRY = / valid_until (\d{1,16})$/;

const amount = (value: unknown): string | undefined =>
  typeof value === "string" && AMOUNT.test(value) ? value : undefined;

const stringAddress = (value: unknown): string | undefined =>
  typeof value === "string" && STRING_ADDRESS.test(value) ? checksumEvmAddress(value) : undefined;

const token = (value: unknown): string | undefined =>
  typeof value === "string" && TOKEN.test(value) ? value : undefined;

const dexName = (value: unknown): string | undefined =>
  typeof value === "string" && DEX_NAME.test(value) ? value : undefined;

const uint64 = (value: unknown): bigint | undefined => typedDataUint(value, MAX_UINT64);

const boolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/**
 * The agent name with its ` valid_until <ms>` suffix split off. The base must fit on one safe line
 * — it is shown verbatim — at most 16 code points (the exchange's limit), free of unsafe code
 * points and without "valid_until" inside it; `""` is a valid unnamed agent.
 */
const agentName = (value: unknown): { name: string; validUntil?: number } | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const expiry = AGENT_EXPIRY.exec(value);
  const base = expiry === null ? value : value.slice(0, expiry.index);
  const excerpt = displayExcerpt(base, 1, 16);
  if (excerpt.omitted !== 0 || (excerpt.lines[0] ?? "") !== base || base.includes("valid_until")) {
    return undefined;
  }
  if (expiry === null) {
    return { name: base };
  }
  const validUntil = Number(expiry[1]);
  return validUntil <= Number.MAX_SAFE_INTEGER ? { name: base, validUntil } : undefined;
};

type Described = {
  readonly suffix: string;
  /** The canonical field list in declaration order — equivalent to the type hash matching. */
  readonly fields: ReadonlyArray<string>;
  readonly summary: IntentSummary;
  readonly verifiability: Verifiability;
  readonly build: (
    chain: HyperliquidChain,
    message: TypedDataMessage,
  ) => HyperliquidAction | undefined;
};

const transferFields = (
  chain: HyperliquidChain,
  message: TypedDataMessage,
  kind: "usd-send" | "withdraw",
): HyperliquidAction | undefined => {
  const destination = stringAddress(message["destination"]);
  const value = amount(message["amount"]);
  return destination === undefined || value === undefined || uint64(message["time"]) === undefined
    ? undefined
    : { kind, chain, destination, amount: value };
};

const stakingFields = (
  chain: HyperliquidChain,
  message: TypedDataMessage,
  kind: "staking-deposit" | "staking-withdraw",
): HyperliquidAction | undefined => {
  const wei = uint64(message["wei"]);
  return wei === undefined || uint64(message["nonce"]) === undefined
    ? undefined
    : { kind, chain, wei: wei.toString(10) };
};

/* Field lists verbatim from nktkas 0.33.3 `…Types` (file:line per entry); every one starts with
   `string hyperliquidChain`, the replay-domain key (python signing.py sign_user_signed_action). */
const DESCRIBED: ReadonlyArray<Described> = [
  {
    suffix: "UsdSend", // nktkas usdSend.ts:98 (UsdSendTypes)
    fields: ["string hyperliquidChain", "string destination", "string amount", "uint64 time"],
    summary: "transfer",
    verifiability: "full",
    build: (chain, message) => transferFields(chain, message, "usd-send"),
  },
  {
    suffix: "Withdraw", // nktkas withdraw3.ts:98 (Withdraw3Types)
    fields: ["string hyperliquidChain", "string destination", "string amount", "uint64 time"],
    summary: "transfer",
    /* The protocol's withdrawal fee is charged at the bridge, not inside the signed fields. */
    verifiability: "partial",
    build: (chain, message) => transferFields(chain, message, "withdraw"),
  },
  {
    suffix: "SpotSend", // nktkas spotSend.ts:100 (SpotSendTypes)
    fields: [
      "string hyperliquidChain",
      "string destination",
      "string token",
      "string amount",
      "uint64 time",
    ],
    summary: "transfer",
    /* The token's name in `token` is requester text; only its id is verifiable. */
    verifiability: "partial",
    build: (chain, message) => {
      const destination = stringAddress(message["destination"]);
      const asset = token(message["token"]);
      const value = amount(message["amount"]);
      return destination === undefined ||
        asset === undefined ||
        value === undefined ||
        uint64(message["time"]) === undefined
        ? undefined
        : { kind: "spot-send", chain, destination, token: asset, amount: value };
    },
  },
  {
    suffix: "UsdClassTransfer", // nktkas usdClassTransfer.ts:109 (UsdClassTransferTypes)
    fields: ["string hyperliquidChain", "string amount", "bool toPerp", "uint64 nonce"],
    summary: "transfer",
    verifiability: "full",
    build: (chain, message) => {
      const value = amount(message["amount"]);
      const toPerp = boolean(message["toPerp"]);
      return value === undefined || toPerp === undefined || uint64(message["nonce"]) === undefined
        ? undefined
        : { kind: "usd-class-transfer", chain, amount: value, toPerp };
    },
  },
  {
    suffix: "SendAsset", // nktkas sendAsset.ts:112 (SendAssetTypes)
    fields: [
      "string hyperliquidChain",
      "string destination",
      "string sourceDex",
      "string destinationDex",
      "string token",
      "string amount",
      "string fromSubAccount",
      "uint64 nonce",
    ],
    summary: "transfer",
    verifiability: "partial",
    build: (chain, message) => {
      const destination = stringAddress(message["destination"]);
      const sourceDex = dexName(message["sourceDex"]);
      const destinationDex = dexName(message["destinationDex"]);
      const asset = token(message["token"]);
      const value = amount(message["amount"]);
      const subAccount = message["fromSubAccount"];
      const fromSubAccount = subAccount === "" ? "" : stringAddress(subAccount);
      return destination === undefined ||
        sourceDex === undefined ||
        destinationDex === undefined ||
        asset === undefined ||
        value === undefined ||
        fromSubAccount === undefined ||
        uint64(message["nonce"]) === undefined
        ? undefined
        : {
            kind: "send-asset",
            chain,
            destination,
            sourceDex,
            destinationDex,
            token: asset,
            amount: value,
            ...(fromSubAccount === "" ? {} : { fromSubAccount }),
          };
    },
  },
  {
    suffix: "CDeposit", // nktkas cDeposit.ts:96 (CDepositTypes)
    fields: ["string hyperliquidChain", "uint64 wei", "uint64 nonce"],
    summary: "stake",
    verifiability: "full",
    build: (chain, message) => stakingFields(chain, message, "staking-deposit"),
  },
  {
    suffix: "CWithdraw", // nktkas cWithdraw.ts:96 (CWithdrawTypes)
    fields: ["string hyperliquidChain", "uint64 wei", "uint64 nonce"],
    summary: "stake",
    verifiability: "full",
    build: (chain, message) => stakingFields(chain, message, "staking-withdraw"),
  },
  {
    suffix: "TokenDelegate", // nktkas tokenDelegate.ts:100 (TokenDelegateTypes)
    fields: [
      "string hyperliquidChain",
      "address validator",
      "uint64 wei",
      "bool isUndelegate",
      "uint64 nonce",
    ],
    summary: "stake",
    verifiability: "partial",
    build: (chain, message) => {
      const validator = typedDataAddress(message["validator"]);
      const wei = uint64(message["wei"]);
      const undelegate = boolean(message["isUndelegate"]);
      return validator === undefined ||
        wei === undefined ||
        undelegate === undefined ||
        uint64(message["nonce"]) === undefined
        ? undefined
        : { kind: "token-delegate", chain, validator, wei: wei.toString(10), undelegate };
    },
  },
  {
    suffix: "ApproveAgent", // nktkas approveAgent.ts:114 (ApproveAgentTypes)
    fields: ["string hyperliquidChain", "address agentAddress", "string agentName", "uint64 nonce"],
    summary: "approve",
    verifiability: "partial",
    build: (chain, message) => {
      const agent = typedDataAddress(message["agentAddress"]);
      const name = agentName(message["agentName"]);
      return agent === undefined || name === undefined || uint64(message["nonce"]) === undefined
        ? undefined
        : {
            kind: "approve-agent",
            chain,
            agent,
            name: name.name,
            ...(name.validUntil === undefined ? {} : { validUntil: name.validUntil }),
          };
    },
  },
  {
    suffix: "ApproveBuilderFee", // nktkas approveBuilderFee.ts:98 (ApproveBuilderFeeTypes)
    fields: ["string hyperliquidChain", "string maxFeeRate", "address builder", "uint64 nonce"],
    summary: "approve",
    verifiability: "partial",
    build: (chain, message) => {
      const { maxFeeRate } = message;
      const builder = typedDataAddress(message["builder"]);
      return typeof maxFeeRate !== "string" ||
        !FEE_RATE.test(maxFeeRate) ||
        builder === undefined ||
        uint64(message["nonce"]) === undefined
        ? undefined
        : { kind: "approve-builder-fee", chain, builder, maxFeeRate };
    },
  },
];

/**
 * The Hyperliquid user-signed action a typed-data document signs, or `undefined` when the document
 * is not exactly the described shape — every extra type, renamed or reordered field and unparsable
 * value rejects the whole document, so what is described is exactly what is hashed. Message keys
 * the type does not declare (the SDKs' `type`, `signatureChainId`) are not signed and are ignored
 * here.
 */
export function recognizeHyperliquid(json: TypedDataInput): HyperliquidRecognition | undefined {
  const { types, primaryType, domain, message } = json;
  if (
    domain["name"] !== "HyperliquidSignTransaction" ||
    domain["version"] !== "1" ||
    domainChainId(domain) === undefined ||
    typedDataAddress(domain["verifyingContract"])?.toLowerCase() !== ZERO_ADDRESS ||
    !sameFields(types, "EIP712Domain", EIP712_DOMAIN) ||
    Object.keys(types).length !== 2 ||
    types[primaryType] === undefined ||
    !primaryType.startsWith(PREFIX)
  ) {
    return undefined;
  }
  const described = DESCRIBED.find((entry) => entry.suffix === primaryType.slice(PREFIX.length));
  const chain = message["hyperliquidChain"];
  if (
    described === undefined ||
    !sameFields(types, primaryType, described.fields) ||
    (chain !== "Mainnet" && chain !== "Testnet")
  ) {
    return undefined;
  }
  const action = described.build(chain, message);
  return action === undefined
    ? undefined
    : {
        content: { hyperliquid: action },
        summary: described.summary,
        outflows: [],
        warnings: [],
        verifiability: described.verifiability,
      };
}
