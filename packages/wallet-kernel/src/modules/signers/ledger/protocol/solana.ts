/**
 * Solana app client (CLA `0xE0`). Sources: refs/ledger-app-solana src/globals.h (`InsGetPubkey
 * 0x05`, `InsSignMessage 0x06`, `InsSignOffchainMessage 0x07`, `InsGetAppConfiguration 0x04`,
 * `P1_NON_CONFIRM 0x00`, `P2_EXTEND 0x01`, `P2_MORE 0x02`), src/main_application.c (configuration
 * reply layout) and doc/api.md (payload layouts).
 */
import { ed25519 } from "@noble/curves/ed25519.js";

import type { KeyPath } from "@qntx/wallet-chains";

import type { Command, Exchange } from "./apdu.ts";
import { transmit, transmitChunks } from "./apdu.ts";
import { encodePath, input, Reader } from "./bytes.ts";
import { LedgerError } from "./errors.ts";

const CLA = 0xe0;
const INS_GET_APP_CONFIGURATION = 0x04;
const INS_GET_PUBKEY = 0x05;
const INS_SIGN_MESSAGE = 0x06;
const INS_SIGN_OFFCHAIN_MESSAGE = 0x07;

const P1_CONFIRM = 0x01;
const P2_EXTEND = 0x01;
const P2_MORE = 0x02;

const MAX_PATH_DEPTH = 5;
const MAX_MESSAGE = 1232; // message size limit, doc/api.md
const CHUNK = 0xff;

const HARDENED = 0x80_00_00_00;

/** Solana derives hardened-only paths; depth 1..5 per the app docs. */
const path = (keyPath: KeyPath): Uint8Array => {
  for (const index of keyPath) {
    if (!Number.isSafeInteger(index) || index < HARDENED || index > 0xff_ff_ff_ff) {
      throw input("solana derivation path indices must all be hardened");
    }
  }
  return encodePath(keyPath, MAX_PATH_DEPTH);
};

/** `INS ‖ P1 ‖ P2 0x00` command. */
const command = (ins: number, p1: number, data: Uint8Array): Command => ({
  cla: CLA,
  ins,
  p1,
  p2: 0x00,
  data,
});

/** Exactly 64 bytes of ed25519 signature, or invalid-response. */
const signature64 = (data: Uint8Array): Uint8Array => {
  if (data.length !== 64) {
    throw new LedgerError("invalid-response", "solana signature is not 64 bytes");
  }
  return data;
};

/** `INS_05` → the 32-byte ed25519 public key, validated to decode as a curve point. */
export async function solanaAddress(
  exchange: Exchange,
  keyPath: KeyPath,
  display: boolean,
): Promise<Uint8Array> {
  const data = await transmit(
    exchange,
    "solana",
    command(INS_GET_PUBKEY, display ? P1_CONFIRM : 0x00, path(keyPath)),
  );
  if (data.length !== 32) {
    throw new LedgerError("invalid-response", "solana public key is not 32 bytes");
  }
  try {
    ed25519.Point.fromBytes(data);
  } catch {
    throw new LedgerError("invalid-response", "solana public key is not an ed25519 point");
  }
  return data;
}

/**
 * Chunks `payload` into ≤255-byte APDU data fields: the first chunk carries `P2 = 0`, continuations
 * `P2_EXTEND`, and every chunk but the last `P2_MORE` (globals.h).
 */
const signCommands = (ins: number, keyPath: KeyPath, message: Uint8Array): Command[] => {
  if (message.length === 0 || message.length > MAX_MESSAGE) {
    throw input("solana message is not 1..1232 bytes");
  }
  const prefix = path(keyPath);
  const payload = new Uint8Array(1 + prefix.length + message.length);
  payload[0] = 0x01; // number of signers, always 1 (doc/api.md)
  payload.set(prefix, 1);
  payload.set(message, 1 + prefix.length);
  const commands: Command[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const slice = payload.subarray(offset, offset + CHUNK);
    const p2 =
      (offset === 0 ? 0x00 : P2_EXTEND) + (offset + CHUNK < payload.length ? P2_MORE : 0x00);
    commands.push({ cla: CLA, ins, p1: P1_CONFIRM, p2, data: slice });
  }
  return commands;
};

/** `INS_06` — signs a serialized transaction message. */
export async function solanaSignTransaction(
  exchange: Exchange,
  keyPath: KeyPath,
  message: Uint8Array,
): Promise<Uint8Array> {
  return signature64(
    await transmitChunks(exchange, "solana", signCommands(INS_SIGN_MESSAGE, keyPath, message)),
  );
}

/** `INS_07` — signs a serialized off-chain message. */
export async function solanaSignOffchainMessage(
  exchange: Exchange,
  keyPath: KeyPath,
  message: Uint8Array,
): Promise<Uint8Array> {
  return signature64(
    await transmitChunks(
      exchange,
      "solana",
      signCommands(INS_SIGN_OFFCHAIN_MESSAGE, keyPath, message),
    ),
  );
}

/**
 * `INS_04` — `allow_blind_sign ‖ pubkey_display ‖ major ‖ minor ‖ patch`, exactly 5 bytes on the
 * pinned build: main_application.c `InsGetAppConfiguration` only appends `tx_check_opt_in ‖
 * tx_check_enable` under HAVE_TRANSACTION_CHECKS, which the pinned tag does not define.
 */
export async function solanaConfiguration(
  exchange: Exchange,
): Promise<{ readonly version: string; readonly blindSigning: boolean }> {
  const data = await transmit(
    exchange,
    "solana",
    command(INS_GET_APP_CONFIGURATION, 0x00, new Uint8Array(0)),
  );
  const reader = new Reader(data);
  const blindSigning = reader.u8() !== 0;
  reader.u8(); // pubkey display
  const major = reader.u8();
  const minor = reader.u8();
  const patch = reader.u8();
  reader.end();
  return { version: `${major}.${minor}.${patch}`, blindSigning };
}
