/**
 * Solana signing over the OneKey V1 schema. The compiled transaction message is handed to the
 * device as `raw_tx` — the device parses it itself, decides between the described and blind
 * screens, and ed25519-signs those bytes (firmware-pro core/src/apps/solana/sign_tx.py
 * `ed25519.sign(node.private_key(), msg.raw_tx)`, firmware-classic1s legacy/firmware/solana.c
 * `ed25519_sign(msg->raw_tx.bytes, msg->raw_tx.size, …)`). Raw messages go through
 * SolanaSignUnsafeMessage, which both firmwares refuse when the bytes parse as a transaction
 * message (a raw signature over them would authorise the transaction).
 */
import { ChainError } from "@qntx/wallet-chains";
import { mayBeTransactionMessage, parseCompiledMessage } from "@qntx/wallet-chains/solana";

import { OneKeyError } from "./errors.ts";
import {
  SolanaMessageSignature,
  SolanaSignedTx,
  SolanaSignTx,
  SolanaSignUnsafeMessage,
} from "./messages.ts";
import { call } from "./session.ts";
import type { Exchange } from "./session.ts";

const fault = (message: string): OneKeyError => new OneKeyError("device-fault", message);
const invalid = (message: string): OneKeyError => new OneKeyError("invalid-input", message);
const unsupported = (message: string): OneKeyError => new OneKeyError("unsupported", message);

const HARDENED = 0x80_00_00_00;

// Failure_DataError (common/protob/messages-common.proto FailureType = 3): the firmwares raise it
// for a message they cannot parse (Pro "Invalid message …"), one too long for the device buffer
// (Pro "Message overflow", MAX_DATA_SIZE 1168 at constents.py:23), a signer the message does not
// require (Pro "Invalid signer used", Classic "Invalid params") and — Classic only — a
// blind-sign-only message while the Solana coin switch is off ("Please confirm the BlindSign
// enabled", legacy/firmware/solana.c:98).
const FAILURE_DATA_ERROR = 3;

// firmware-pro core/src/apps/solana/sign_tx.py CURRENT_ALLOWED_PROGRAM_IDS: the program ids the
// device renders instruction-by-instruction; anything else (and every versioned message) gets the
// blind hash screen. The Classic 1S clear set is wider (libsol also prints Stake, Vote and Serum
// assert-owner instructions), so the Pro set is the safe intersection.
const CLEAR_PROGRAM_IDS: ReadonlySet<string> = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "ComputeBudget111111111111111111111111111111",
]);

function checkPath(path: ReadonlyArray<number>): void {
  if (path.length === 0) {
    throw invalid("derivation path is empty");
  }
  for (const element of path) {
    if (!Number.isInteger(element) || element < HARDENED) {
      throw invalid("solana path elements must be hardened");
    }
  }
}

function dataError(error: unknown): OneKeyError {
  if (
    error instanceof OneKeyError &&
    error.code === "device-error" &&
    error.failure === FAILURE_DATA_ERROR
  ) {
    if (error.deviceMessage?.includes("BlindSign") === true) {
      return unsupported("device has blind signing disabled");
    }
    return invalid("device rejected the message");
  }
  if (error instanceof OneKeyError) {
    return error;
  }
  throw error;
}

/**
 * Sign a compiled transaction message. The message must parse (`parseCompiledMessage` — the same
 * bound the network applies) and be legacy or v0: both firmwares refuse version 1 — Pro at
 * Message.deserialize ("Expected versioned message with version 0", sign_tx.py:57 via
 * message.py:70), the Classic 1S by misreading the shifted v1 layout so its signer check never
 * finds the key — so the refusal is made before any exchange.
 */
export async function signSolanaTransaction(
  exchange: Exchange,
  path: ReadonlyArray<number>,
  message: Uint8Array,
): Promise<Uint8Array> {
  checkPath(path);
  let version: "legacy" | number;
  try {
    ({ version } = parseCompiledMessage(message));
  } catch (error) {
    if (error instanceof ChainError && error.code === "unsupported") {
      throw unsupported(error.message);
    }
    throw invalid("solana message failed to parse");
  }
  if (version !== "legacy" && version !== 0) {
    throw unsupported("firmware does not sign version-1 Solana messages");
  }
  try {
    const response = await call(
      exchange,
      { def: SolanaSignTx, value: { addressN: [...path], rawTx: message } },
      SolanaSignedTx,
    );
    if (response.signature.length !== 64) {
      throw fault("solana signature is not 64 bytes");
    }
    return response.signature;
  } catch (error) {
    throw dataError(error);
  }
}

/**
 * Sign a raw message (SolanaSignUnsafeMessage). A message that parses as a transaction is refused
 * before the exchange — the signature would authorise it (`mayBeTransactionMessage`, mirroring both
 * firmwares' own check: sign_unsafe_message.py sanitize_message, fsm_msg_solana.h "Valid
 * transaction message format is not allowed").
 */
export async function signSolanaRawMessage(
  exchange: Exchange,
  path: ReadonlyArray<number>,
  message: Uint8Array,
): Promise<Uint8Array> {
  checkPath(path);
  if (mayBeTransactionMessage(message)) {
    throw invalid("solana message is a transaction message");
  }
  try {
    const response = await call(
      exchange,
      { def: SolanaSignUnsafeMessage, value: { addressN: [...path], message } },
      SolanaMessageSignature,
    );
    if (response.signature.length !== 64) {
      throw fault("solana message signature is not 64 bytes");
    }
    return response.signature;
  } catch (error) {
    throw dataError(error);
  }
}

export type SolanaDisplayRequest =
  | { readonly kind: "solana.transaction"; readonly message: Uint8Array }
  | { readonly kind: "solana.message"; readonly message: Uint8Array };

const utf8 = new TextDecoder("utf-8", { fatal: true });

/* Pro shows the message as text when it decodes as UTF-8 without disallowed control characters
 * and holds at least one printable ASCII (signverify.py is_non_printable/decode_message, then
 * confirm_sol_message); Classic's is_printable (legacy/util.c) applies the same test for
 * layoutSignMessage. Otherwise both fall back to a hex dump, which is blind. */
function showsText(message: Uint8Array): boolean {
  let text: string;
  try {
    text = utf8.decode(message);
  } catch {
    return false;
  }
  let printable = false;
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if ((code < 0x20 && c !== "\t" && c !== "\n" && c !== "\r") || code === 0x7f) {
      return false;
    }
    if (code >= 0x20 && code <= 0x7e) {
      printable = true;
    }
  }
  return printable;
}

/**
 * "clear" when the device renders the request's semantics, "blind" when it shows a hash or hex.
 * Transactions: only an unversioned (legacy) message whose every instruction runs one of the
 * program ids the Pro firmware renders (CURRENT_ALLOWED_PROGRAM_IDS — the Classic set is a
 * superset). Raw messages: only printable text both firmwares show in full.
 */
export function solanaDisplay(request: SolanaDisplayRequest): "clear" | "blind" {
  if (request.kind === "solana.message") {
    return showsText(request.message) ? "clear" : "blind";
  }
  let parsed;
  try {
    parsed = parseCompiledMessage(request.message);
  } catch {
    return "blind";
  }
  if (parsed.version !== "legacy") {
    return "blind";
  }
  return parsed.instructions.every((ix) =>
    CLEAR_PROGRAM_IDS.has(parsed.staticAccounts[ix.programAddressIndex] ?? ""),
  )
    ? "clear"
    : "blind";
}
