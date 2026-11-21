import { isRecord, requestBase } from "../account-ref.ts";
import { domainChainId } from "../evm/typed-data.ts";
import { ChainError } from "../index.ts";
import type { SignRequest } from "../index.ts";
import { BUILT_IN_NETWORKS } from "../networks.ts";
import { mayBeTronTransaction } from "./message.ts";
import { decodeTronRawData } from "./raw.ts";
import { parseTronTypedData } from "./typed-data.ts";

export { TRON_NATIVE_ASSET } from "./assets.ts";
export {
  TRON_ADDRESS_PREFIX,
  isTronAddress,
  tronAddressToBytes,
  tronAddressFromBytes,
  tronAddressToHex,
  tronAddressFromHex,
  tronAddressToEvm,
  tronAddressFromEvm,
  tronAddressFromPublicKey,
} from "./address.ts";
export { TRON_CONTRACT_TYPES, tronContractType, tronTypeUrl } from "./contract-types.ts";
export type { TronContractTreatment } from "./contract-types.ts";
export { decodeTronContract, encodeTronContract } from "./contracts.ts";
export type { TronContract, TronPermissionWire, TronVote } from "./contracts.ts";
export {
  decodeTronRawData,
  encodeTronRawData,
  encodeTronTransaction,
  tronTransactionId,
} from "./raw.ts";
export type { TronContractSlot, TronRawData } from "./raw.ts";
export {
  TRON_MEMO_MAX_BYTES,
  buildTronRawData,
  trc20ApproveContract,
  trc20TransferContract,
  tronMemoBytes,
} from "./builders.ts";
export type { TronBlockRef, TronTransactionHeader } from "./builders.ts";
export { lookupTronToken, tronTokenTable } from "./tokens.ts";
export type { TronToken, TronTokenTable } from "./tokens.ts";
export { mayBeTronTransaction, TRON_MESSAGE_PREFIX, tronMessageDigest } from "./message.ts";
export { TRON_PERMIT2 } from "./permit2.ts";
export { tronRawDataFromJson } from "./json.ts";
export {
  parseTronTypedData,
  tronTypedDataBase58,
  tronTypedDataDigest,
  tronTypedDataFromArgs,
  tronTypedDataLeaf,
  tronTypedDataToEvm,
} from "./typed-data.ts";
export { decodeTron } from "./decode.ts";
export {
  recoverTronMessageSigner,
  recoverTronTransactionSigner,
  recoverTronTypedDataSigner,
  verifyTronMessageSignature,
  verifyTronTransactionSignature,
  verifyTronTypedDataSignature,
} from "./verify.ts";

/** The TRON network ids in `BUILT_IN_NETWORKS` — mainnet plus the Shasta and Nile testnets. */
export const TRON_NETWORKS: ReadonlyArray<string> = Object.freeze(
  BUILT_IN_NETWORKS.filter((n) => n.family === "tron").map((n) => n.id),
);

/**
 * Validates an untrusted request into a `SignRequest`: the network is a known TRON network (decimal
 * CAIP-2 only — `tron:0x…` is rejected like any other unknown id), `tron.transaction` carries
 * raw_data that decodes under the strict reader (a bare 32-byte txid is refused), and
 * `tron.message` carries non-empty bytes that could not be a transaction.
 */
export const normalizeTron = (request: unknown): SignRequest => {
  if (!isRecord(request) || typeof request["kind"] !== "string") {
    throw new ChainError("invalid-request", "request must be an object with a kind");
  }
  const { network, account } = requestBase(request);
  if (!TRON_NETWORKS.includes(network)) {
    throw new ChainError("invalid-request", `${network} is not a TRON network`);
  }
  if (request["kind"] === "tron.transaction") {
    const { rawData } = request;
    if (!(rawData instanceof Uint8Array)) {
      throw new ChainError("invalid-request", "tron.transaction payload must be raw_data bytes");
    }
    if (rawData.length === 32) {
      throw new ChainError("invalid-request", "a bare 32-byte digest is not a TRON transaction");
    }
    decodeTronRawData(rawData);
    return { kind: "tron.transaction", network, account, rawData };
  }
  if (request["kind"] === "tron.typed-data") {
    const { typedData } = request;
    if (typeof typedData !== "string") {
      throw new ChainError(
        "invalid-request",
        "tron.typed-data payload must be the canonical JSON source string",
      );
    }
    const { json } = parseTronTypedData(typedData);
    const domainChain = domainChainId(json.domain);
    const networkChain = BUILT_IN_NETWORKS.find((n) => n.id === network)?.chainId;
    if (domainChain !== undefined && domainChain !== networkChain) {
      throw new ChainError(
        "chain-id-mismatch",
        `typed-data domain.chainId ${domainChain} does not match network ${network}`,
      );
    }
    return { kind: "tron.typed-data", network, account, typedData };
  }
  if (request["kind"] === "tron.message") {
    const { message } = request;
    if (!(message instanceof Uint8Array) || message.length === 0) {
      throw new ChainError("invalid-request", "tron.message payload must be non-empty bytes");
    }
    if (mayBeTronTransaction(message)) {
      throw new ChainError(
        "invalid-request",
        "tron.message payload could be a transaction — use tron.transaction",
      );
    }
    return { kind: "tron.message", network, account, message };
  }
  throw new ChainError("unsupported", `${request["kind"]} is not a TRON request kind`);
};
