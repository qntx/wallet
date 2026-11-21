// oxlint-disable eslint/no-bitwise -- makerTraits is a bit field decoded per MakerTraitsLib

import type { OffchainOrder } from "../index.ts";
import { MAX_UINT256 } from "./approval.ts";
import { orderAmount } from "./order.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { domainChainId, sameFields, typedDataAddress, typedDataUint } from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

/**
 * Decoding of 1inch Limit Order Protocol v4 orders signed at an Aggregation Router v6. The `Order`
 * type is verbatim from `refs/1inch-lop-4.0.0/contracts/OrderLib.sol` (tag 4.0.0); the router
 * domains `{name: "1inch Aggregation Router", version: "6", chainId, verifyingContract}` were
 * verified by on-chain `eip712Domain()` (`evidence/onchain/out{1,2}.json`).
 *
 * `makerTraits` (bit layout in `contracts/libraries/MakerTraitsLib.sol`) decides whether anything
 * unsigned can change the order's bounds. Rejected — anything set makes the document a near miss:
 * HAS_EXTENSION (249) and PRE_/POST_INTERACTION_CALL (252/251), which let an extension hidden in
 * `salt` run arbitrary code (Fusion orders always carry an extension, so they stay blind);
 * UNWRAP_WETH (247), which changes what the receiver actually gets; the spare bit 253 and the
 * undefined range 200..246. The remaining flags (NO_PARTIAL_FILLS, ALLOW_MULTIPLE_FILLS,
 * NEED_CHECK_EPOCH_MANAGER, USE_PERMIT2) only constrain how the order fills, not its bounds.
 */

/** `Order`'s field list, verbatim from OrderLib.sol. */
const ORDER_FIELDS = [
  "uint256 salt",
  "address maker",
  "address receiver",
  "address makerAsset",
  "address takerAsset",
  "uint256 makingAmount",
  "uint256 takingAmount",
  "uint256 makerTraits",
] as const;

/* The verified Aggregation Router v6 deployments (`evidence/onchain/out{1,2}.json`). */
export const V6_ROUTER = "0x111111125421ca6dc452d289314280a0f8842a65";
export const V6_ZKSYNC_ROUTER = "0x6fd4383cb451173d5f9304f041c7bcbf27d561ff";
export const V6_CHAINS: ReadonlySet<number> = new Set([
  1, 10, 25, 56, 100, 130, 137, 143, 146, 8217, 8453, 42161, 43114, 59144,
]);
const v6Router = (chainId: number): string | undefined =>
  chainId === 324 ? V6_ZKSYNC_ROUTER : V6_CHAINS.has(chainId) ? V6_ROUTER : undefined;

/* MakerTraitsLib bit positions: rejected when set. */
const UNWRAP_WETH = 1n << 247n;
const HAS_EXTENSION = 1n << 249n;
const POST_INTERACTION_CALL = 1n << 251n;
const PRE_INTERACTION_CALL = 1n << 252n;
const SPARE_BIT_253 = 1n << 253n;
const UNDEFINED_200_246 = ((1n << 47n) - 1n) << 200n;
const REJECTED =
  UNWRAP_WETH |
  HAS_EXTENSION |
  POST_INTERACTION_CALL |
  PRE_INTERACTION_CALL |
  SPARE_BIT_253 |
  UNDEFINED_200_246;

const NO_PARTIAL_FILLS = 1n << 255n;
const ALLOWED_SENDER = (1n << 80n) - 1n;
const EXPIRATION = ((1n << 40n) - 1n) << 80n;

const ZERO = "0x0000000000000000000000000000000000000000";

/** The order under the exact Aggregation Router v6 domain, or `undefined` — a near miss. */
export const recognizeOneinch = (
  json: TypedDataInput,
  chainId: number,
  table: EvmTokenTable,
): OffchainOrder | undefined => {
  const { domain, types, primaryType, message } = json;
  const verifying = typedDataAddress(domain["verifyingContract"]);
  const router = v6Router(chainId);
  if (
    domain["name"] !== "1inch Aggregation Router" ||
    domain["version"] !== "6" ||
    domainChainId(domain) !== chainId ||
    router === undefined ||
    verifying === undefined ||
    verifying.toLowerCase() !== router ||
    primaryType !== "Order" ||
    Object.keys(types).length !== 2 ||
    !sameFields(types, "EIP712Domain", [
      "string name",
      "string version",
      "uint256 chainId",
      "address verifyingContract",
    ]) ||
    !sameFields(types, "Order", ORDER_FIELDS)
  ) {
    return undefined;
  }
  const maker = typedDataAddress(message["maker"]);
  const receiver = typedDataAddress(message["receiver"]);
  const makerAsset = typedDataAddress(message["makerAsset"]);
  const takerAsset = typedDataAddress(message["takerAsset"]);
  const makingAmount = typedDataUint(message["makingAmount"], MAX_UINT256);
  const takingAmount = typedDataUint(message["takingAmount"], MAX_UINT256);
  const traits = typedDataUint(message["makerTraits"], MAX_UINT256);
  if (
    maker === undefined ||
    receiver === undefined ||
    makerAsset === undefined ||
    takerAsset === undefined ||
    makingAmount === undefined ||
    takingAmount === undefined ||
    traits === undefined ||
    typedDataUint(message["salt"], MAX_UINT256) === undefined ||
    (traits & REJECTED) !== 0n
  ) {
    return undefined;
  }
  const expiry = (traits & EXPIRATION) >> 80n;
  const allowed = traits & ALLOWED_SENDER;
  return {
    protocol: "1inch",
    maker,
    give: orderAmount(makerAsset, makingAmount, chainId, table),
    receive: [
      {
        /* receiver 0 means the maker keeps the proceeds (OrderLib.sol). */
        recipient: receiver.toLowerCase() === ZERO ? maker : receiver,
        amount: orderAmount(takerAsset, takingAmount, chainId, table),
      },
    ],
    ...(expiry === 0n ? {} : { expiry: Number(expiry) }),
    partialFill: (traits & NO_PARTIAL_FILLS) === 0n,
    ...(allowed === 0n ? {} : { allowedSender: `0x${allowed.toString(16).padStart(20, "0")}` }),
  };
};
