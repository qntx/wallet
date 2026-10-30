import { ChainError } from "../index.ts";
import type { AccountRef, SignRequest } from "../index.ts";
import { SOLANA_NETWORKS, isSolanaAddress } from "./ids.ts";
import { parseCompiledMessage, validateLookupTables } from "./message.ts";

export { PROGRAM_IDS, SOLANA_NETWORKS, isSolanaAddress } from "./ids.ts";
export { decodeSolana, verifiabilitySolana } from "./decode.ts";
export { parseCompiledMessage } from "./message.ts";
export type { SolanaTokenTable } from "./tokens.ts";
export { solanaTokenTable } from "./tokens.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAccountRef = (value: unknown): value is AccountRef => {
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    return false;
  }
  if (value["kind"] === "hd") {
    return (
      typeof value["walletId"] === "string" &&
      typeof value["groupIndex"] === "number" &&
      typeof value["template"] === "string"
    );
  }
  return (
    value["kind"] === "imported" &&
    typeof value["keyId"] === "string" &&
    typeof value["family"] === "string"
  );
};

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
 * Normalizes a Solana sign request. `signer` is the fee payer the wallet is about to sign for — the
 * message must declare it as the first static account. A raw `solana.message` must not decode as a
 * transaction message (chains.mdx rule — a bytes-to-sign path that produces a transaction signature
 * is a wallet-drainer). Idempotent.
 */
export const normalizeSolana = (request: unknown, signer: string): SignRequest => {
  if (!isRecord(request) || typeof request["kind"] !== "string") {
    throw new ChainError("invalid-request", "request must be an object with a kind");
  }
  const { network } = request;
  const { account } = request;
  if (typeof network !== "string") {
    throw new ChainError("invalid-request", "request.network must be a string");
  }
  if (!isAccountRef(account)) {
    throw new ChainError("invalid-request", "request.account must be an AccountRef");
  }
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
    const [feePayer] = parsed.staticAccounts;
    if (feePayer === undefined || feePayer !== signer) {
      throw new ChainError("fee-payer-mismatch", "signer is not the transaction fee payer");
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
    let decodesAsTransaction = true;
    try {
      parseCompiledMessage(message);
    } catch {
      decodesAsTransaction = false;
    }
    if (decodesAsTransaction) {
      throw new ChainError(
        "invalid-request",
        "solana.message payload decodes as a transaction message — use solana.transaction",
      );
    }
    return { kind: "solana.message", network, account, message, format };
  }
  throw new ChainError("unsupported", `unsupported sign request kind: ${request["kind"]}`);
};
