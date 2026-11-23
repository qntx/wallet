import { requestBase } from "../account-ref.ts";
import { ChainError } from "../index.ts";
import type { SignRequest } from "../index.ts";
import { MAX_UINT256 } from "./approval.ts";
import { FIAT24_CHAIN } from "./fiat24.ts";
import { isRecord, networkChainId, normalizeEvmTransaction } from "./transaction.ts";
import { domainChainId, parseTypedData } from "./typed-data.ts";

export { EVM_NATIVE_ASSET } from "./assets.ts";
export { isEvmAddress, checksumEvmAddress, evmAddressFromPublicKey } from "./address.ts";
export {
  networkChainId,
  normalizeEvmTransaction,
  canonicalHex,
  isCanonicalHex,
} from "./transaction.ts";
export { MAX_UINT256, PERMIT2_ADDRESS } from "./approval.ts";
export { decodeEvm, verifiabilityEvm } from "./decode.ts";
export { DELEGATION_MANAGER, ENTRY_POINT_V08, assertNoExecutionGrant } from "./grants.ts";
export {
  EVM_DELEGATOR,
  EVM_DELEGATION_PREFIX,
  encodeBatchExecute,
  decodeBatchExecute,
} from "./delegation.ts";
export { SAFE_MULTISEND_CALL_ONLY } from "./safe.ts";
export { ORDER_ITEMS } from "./order.ts";
export { recoverEvmSigner } from "./recover.ts";
export { ALLOWANCE_HOLDER, ZEROX_CHAINS, isZeroExSettler, decodeZeroX } from "./zerox.ts";
export { ACROSS_SPOKEPOOLS, ACROSS_WRAPPED_NATIVE, decodeAcross } from "./across.ts";
export { CCTP_FORWARDERS, CCTP_MESSENGERS, CCTP_USDC, HYPERLIQUID_DOMAIN } from "./cctp.ts";
export { LIDO_CHAIN, LIDO_STETH, LIDO_WSTETH, LIDO_QUEUE } from "./lido.ts";
export {
  TYPED_FIELD_BUDGET,
  TYPED_FIELD_CODE_POINTS,
  parseTypedData,
  typedDataFields,
} from "./typed-data.ts";
export type { TypedDataInput } from "./typed-data.ts";
export { hyperliquidL1Document } from "./hyperliquid-l1.ts";
export type {
  HyperliquidL1Action,
  HyperliquidL1Order,
  HyperliquidL1Params,
  HyperliquidNetwork,
} from "./hyperliquid-l1.ts";
export { evmTokenTable, lookupEvmToken } from "./tokens.ts";
export { FIAT24_CHAIN, fiat24SessionMessage } from "./fiat24.ts";
export type { EvmToken, EvmTokenTable } from "./tokens.ts";
export { evmSigningPreimage } from "./envelope.ts";
export { planEvm } from "./plan.ts";
export { assembleEvm } from "./assemble.ts";
export type { EvmSignPlan } from "./plan.ts";

/**
 * Normalizes a SignRequest for the EVM family: exact key sets, chainId vs the CAIP-2 `network`,
 * canonical quantities and EIP-55 addresses. Idempotent.
 */
export const normalizeEvm = (request: unknown): SignRequest => {
  if (!isRecord(request) || typeof request["kind"] !== "string") {
    throw new ChainError("invalid-request", "request must be an object with a kind");
  }
  const { network, account } = requestBase(request);
  const chainId = networkChainId(network);
  if (request["kind"] === "evm.transaction") {
    const tx = normalizeEvmTransaction(request["tx"]);
    if (tx.chainId !== chainId) {
      throw new ChainError(
        "chain-id-mismatch",
        `tx.chainId ${tx.chainId} does not match network ${network}`,
      );
    }
    return { kind: "evm.transaction", network, account, tx };
  }
  if (request["kind"] === "evm.personal-message") {
    const { message } = request;
    if (!(message instanceof Uint8Array)) {
      throw new ChainError("invalid-request", "personal-message payload must be bytes");
    }
    return { kind: "evm.personal-message", network, account, message };
  }
  if (request["kind"] === "evm.fiat24-session") {
    /* Fiat24 grants live on Arbitrum One only; the session is bound to that network's account
       NFT. Exact key set: kind, network, account, tokenId, deadline. */
    if (chainId !== FIAT24_CHAIN) {
      throw new ChainError("unsupported", `fiat24 sessions exist only on eip155:${FIAT24_CHAIN}`);
    }
    const { tokenId, deadline } = request;
    if (
      typeof tokenId !== "string" ||
      !/^[1-9][0-9]*$/.test(tokenId) ||
      BigInt(tokenId) > MAX_UINT256
    ) {
      throw new ChainError("invalid-request", "fiat24-session tokenId is not a canonical id");
    }
    if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline < 1) {
      throw new ChainError("invalid-request", "fiat24-session deadline must be a positive integer");
    }
    return { kind: "evm.fiat24-session", network, account, tokenId, deadline };
  }
  if (request["kind"] === "evm.typed-data") {
    const { typedData } = request;
    if (typeof typedData !== "string") {
      throw new ChainError("invalid-request", "typed-data payload must be the JSON source string");
    }
    const { json } = parseTypedData(typedData);
    const domainChain = domainChainId(json.domain);
    if (domainChain !== undefined && domainChain !== chainId) {
      throw new ChainError(
        "chain-id-mismatch",
        `typed-data domain.chainId ${domainChain} does not match network ${network}`,
      );
    }
    return { kind: "evm.typed-data", network, account, typedData };
  }
  throw new ChainError("unsupported", `unsupported sign request kind: ${request["kind"]}`);
};
