import type { OffchainOrder } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
/**
 * Decoding of a CoW Protocol `GPv2Order` (`Order` primary type). Recognised only when the domain is
 * exactly `{name: "Gnosis Protocol", version: "v2", chainId: <request chain>, verifyingContract:
 * GPv2Settlement}` on a chain where the deployment's `domainSeparator()` was verified — anything
 * else under the family claim is a near miss (`typed-data-variant`).
 *
 * The `appData` bytes32 leaf is a commitment the family names: it binds hooks and order metadata
 * the settlement contract does not interpret as value, so the order is described like every other
 * claimed protocol rather than blind.
 *
 * Sources: `refs/cow-contracts/src/contracts/libraries/GPv2Order.sol` (order fields, the
 * "sell"/"buy" kind markers, the "erc20"/"external"/"internal" balance markers,
 * RECEIVER_SAME_AS_OWNER, BUY_ETH_ADDRESS), `networks.json` + `evidence/onchain/out1.json`
 * (settlement address and the chains whose domain separator was verified).
 */
import { MAX_UINT256 } from "./approval.ts";
import { orderAmount } from "./order.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { domainChainId, sameFields, typedDataAddress, typedDataUint } from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

/** GPv2Settlement (`cow-contracts` `networks.json`), lowercase for a case-insensitive compare. */
export const GPV2_SETTLEMENT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41";

/** The chains the settlement's `domainSeparator()` was verified on (`evidence/onchain/out1.json`). */
export const GPV2_CHAINS: ReadonlySet<number> = new Set([
  1, 10, 56, 100, 130, 137, 143, 5000, 8453, 9745, 42161, 43114, 59144,
]);

/** `Order`'s field list, verbatim from `GPv2Order.sol`'s TYPE_HASH comment. */
const ORDER_FIELDS = [
  "address sellToken",
  "address buyToken",
  "address receiver",
  "uint256 sellAmount",
  "uint256 buyAmount",
  "uint32 validTo",
  "bytes32 appData",
  "uint256 feeAmount",
  "string kind",
  "bool partiallyFillable",
  "string sellTokenBalance",
  "string buyTokenBalance",
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";
const KINDS: ReadonlySet<string> = new Set(["sell", "buy"]);
const SELL_BALANCES: ReadonlySet<string> = new Set(["erc20", "external", "internal"]);
const BUY_BALANCES: ReadonlySet<string> = new Set(["erc20", "internal"]);

/** The order under the exact GPv2 signing domain, or `undefined` — a near miss of the claim. */
export const recognizeCow = (
  json: TypedDataInput,
  chainId: number,
  signer: string,
  table: EvmTokenTable,
): OffchainOrder | undefined => {
  const { domain, types, primaryType, message } = json;
  const verifying = typedDataAddress(domain["verifyingContract"]);
  if (
    domain["name"] !== "Gnosis Protocol" ||
    domain["version"] !== "v2" ||
    domainChainId(domain) !== chainId ||
    verifying === undefined ||
    verifying.toLowerCase() !== GPV2_SETTLEMENT ||
    !GPV2_CHAINS.has(chainId) ||
    primaryType !== "Order" ||
    Object.keys(types).length !== 2 ||
    !sameFields(types, "EIP712Domain", [
      "string name",
      "string version",
      "uint256 chainId",
      "address verifyingContract",
    ]) ||
    !sameFields(types, "Order", ORDER_FIELDS) ||
    typeof message["kind"] !== "string" ||
    !KINDS.has(message["kind"]) ||
    typeof message["sellTokenBalance"] !== "string" ||
    !SELL_BALANCES.has(message["sellTokenBalance"]) ||
    typeof message["buyTokenBalance"] !== "string" ||
    !BUY_BALANCES.has(message["buyTokenBalance"]) ||
    typeof message["partiallyFillable"] !== "boolean"
  ) {
    return undefined;
  }
  const sellToken = typedDataAddress(message["sellToken"]);
  const buyToken = typedDataAddress(message["buyToken"]);
  const receiver = typedDataAddress(message["receiver"]);
  const sellAmount = typedDataUint(message["sellAmount"], MAX_UINT256);
  const buyAmount = typedDataUint(message["buyAmount"], MAX_UINT256);
  const feeAmount = typedDataUint(message["feeAmount"], MAX_UINT256);
  const validTo = typedDataUint(message["validTo"], 2n ** 32n - 1n);
  if (
    sellToken === undefined ||
    buyToken === undefined ||
    receiver === undefined ||
    sellAmount === undefined ||
    buyAmount === undefined ||
    feeAmount === undefined ||
    validTo === undefined ||
    /* The order is bounded by sellAmount + feeAmount; it must not wrap around. */
    sellAmount + feeAmount > MAX_UINT256
  ) {
    return undefined;
  }
  return {
    protocol: "cow",
    maker: checksumEvmAddress(signer),
    give: orderAmount(sellToken, sellAmount + feeAmount, chainId, table),
    receive: [
      {
        /* RECEIVER_SAME_AS_OWNER: the zero receiver means the maker keeps the proceeds. */
        recipient: receiver.toLowerCase() === ZERO ? checksumEvmAddress(signer) : receiver,
        amount: orderAmount(buyToken, buyAmount, chainId, table),
      },
    ],
    expiry: Number(validTo),
    partialFill: message["partiallyFillable"],
  };
};
