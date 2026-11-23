import { isRecord, requestBase } from "../account-ref.ts";
import { ChainError } from "../index.ts";
import type { SignRequest } from "../index.ts";
import { SOLANA_NETWORKS, isSolanaAddress } from "./ids.ts";
import { mayBeTransactionMessage, parseCompiledMessage, validateLookupTables } from "./message.ts";

export {
  PROGRAM_IDS,
  SOLANA_NETWORKS,
  isSolanaAddress,
  solanaAddressFromPublicKey,
} from "./ids.ts";
export {
  PROGRAM_AUTHORITY_ACCOUNTS,
  decodeSolana,
  namedTableAccounts,
  verifiabilitySolana,
} from "./decode.ts";
export { EXT, parseMintExtensions, netAfterTransferFee } from "./token2022.ts";
export type { MintExtensionSummary } from "./token2022.ts";
export { SOLANA_NATIVE_ASSET } from "./assets.ts";
export { associatedTokenAddress } from "./ata.ts";
export { MPL_CORE_PROGRAM, decodeCoreIx } from "./core.ts";
export { JUPITER_PROGRAM, WSOL_MINT } from "./jupiter.ts";
export { isWritableIndex, mayBeTransactionMessage, parseCompiledMessage } from "./message.ts";
export type { NamedAccounts } from "./message.ts";
export type { LookupReference, ParsedSolanaMessage, SolanaTransactionConfig } from "./message.ts";
export { addSolanaSignature, decodeSolanaTransaction } from "./transaction.ts";
export type { SolanaTransactionForSigner } from "./transaction.ts";
export { verifySolanaSignature } from "./verify.ts";
export type { SolanaTokenTable } from "./tokens.ts";
export { solanaTokenTable } from "./tokens.ts";
export { planSolana } from "./plan.ts";
export { assembleSolana } from "./assemble.ts";
export type { SolanaSignPlan } from "./plan.ts";

const solanaNetwork = (network: string): void => {
  if (!SOLANA_NETWORKS.includes(network)) {
    throw new ChainError("unsupported", `unknown Solana network: ${network}`);
  }
};

type LookupTable = {
  readonly address: string;
  readonly addresses: ReadonlyArray<string>;
};

const validateLookupTablesRaw = (tables: unknown): ReadonlyArray<LookupTable> | undefined => {
  if (tables === undefined) {
    return undefined;
  }
  if (!Array.isArray(tables)) {
    throw new ChainError("unknown-field", "lookupTables must be an array");
  }
  const parsed = tables.map((t): LookupTable => {
    if (!isRecord(t) || typeof t["address"] !== "string" || !Array.isArray(t["addresses"])) {
      throw new ChainError("unknown-field", "lookupTables entries must be { address, addresses }");
    }
    const addresses = t["addresses"].map((a): string => {
      if (typeof a !== "string") {
        throw new ChainError("invalid-address", "lookup table addresses must be strings");
      }
      return a;
    });
    return { address: t["address"], addresses };
  });
  validateLookupTables(parsed);
  return parsed;
};

/**
 * Normalizes a Solana sign request. `signer` is a required signer the wallet is about to sign for —
 * the message must declare it among the first `numRequiredSignatures` static accounts.
 * `lookupTables` may only accompany a v0 message — v1 has no address lookup tables (SIMD-0385). A
 * raw `solana.message` must not decode as a transaction message (chains.mdx rule — a bytes-to-sign
 * path that produces a transaction signature is a wallet-drainer): bytes a cluster could accept as
 * a transaction message of any version are never signed as a raw message. Idempotent.
 */
export const normalizeSolana = (request: unknown, signer: string): SignRequest => {
  if (!isRecord(request) || typeof request["kind"] !== "string") {
    throw new ChainError("invalid-request", "request must be an object with a kind");
  }
  const { network, account } = requestBase(request);
  solanaNetwork(network);
  if (!isSolanaAddress(signer)) {
    throw new ChainError("invalid-address", "signer is not a base58 address");
  }
  const { message } = request;
  if (!(message instanceof Uint8Array)) {
    throw new ChainError("invalid-request", "message must be bytes");
  }
  if (request["kind"] === "solana.transaction") {
    const lookupTables = validateLookupTablesRaw(request["lookupTables"]);
    const parsed = parseCompiledMessage(message);
    if (parsed.version === 1 && lookupTables !== undefined) {
      throw new ChainError("invalid-request", "a v1 transaction has no address lookup tables");
    }
    if (!parsed.staticAccounts.slice(0, parsed.numRequiredSignatures).includes(signer)) {
      throw new ChainError("invalid-request", "signer is not a required signer of the transaction");
    }
    return {
      kind: "solana.transaction",
      network,
      account,
      message,
      ...(lookupTables === undefined
        ? {}
        : {
            lookupTables: (
              lookupTables as ReadonlyArray<{
                readonly address: string;
                readonly addresses: ReadonlyArray<string>;
              }>
            ).map((t) => ({ address: t.address, addresses: [...t.addresses] })),
          }),
    };
  }
  if (request["kind"] === "solana.message") {
    const { format } = request;
    if (format !== "raw") {
      throw new ChainError(
        "unsupported",
        `solana.message format ${String(format)} is not supported`,
      );
    }
    if (mayBeTransactionMessage(message)) {
      throw new ChainError(
        "invalid-request",
        "solana.message payload could be a transaction message — use solana.transaction",
      );
    }
    return { kind: "solana.message", network, account, message, format };
  }
  throw new ChainError("unsupported", `unsupported sign request kind: ${request["kind"]}`);
};
