/**
 * Tron app client (CLA `0xE0`). Sources: refs/ledger-app-tron src/handlers/handlers.h
 * (`INS_GET_PUBLIC_KEY 0x02`, `INS_SIGN 0x04`, `INS_GET_APP_CONFIGURATION 0x06`,
 * `INS_SIGN_PERSONAL_MESSAGE 0x08`, `INS_SIGN_TIP_712_MESSAGE 0x0C`, P1 values 0x10 single / 0x00
 * first / 0x80 more / 0x90 last), src/handlers/*.c (payload and reply layouts) and src/app_errors.h
 * (status words — see status.ts).
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import type { KeyPath } from "@qntx/wallet-chains";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";

import type { Command, Exchange } from "./apdu.ts";
import { transmit, transmitChunks } from "./apdu.ts";
import { encodePath, input, Reader, u32 } from "./bytes.ts";
import { LedgerError } from "./errors.ts";

const CLA = 0xe0;
const INS_GET_PUBLIC_KEY = 0x02;
const INS_SIGN = 0x04;
const INS_GET_APP_CONFIGURATION = 0x06;
const INS_SIGN_PERSONAL_MESSAGE = 0x08;
const INS_SIGN_TIP_712_MESSAGE = 0x0c;

const P1_CONFIRM = 0x01;
const P1_SIGN = 0x10;
const P1_FIRST = 0x00;
const P1_MORE = 0x80;
const P1_LAST = 0x90;

const MAX_PATH_DEPTH = 10; // src/parse.h MAX_BIP32_PATH
const CHUNK = 0xff;

const secp256k1OnCurve = (bytes: Uint8Array): Uint8Array => {
  try {
    return secp256k1.Point.fromBytes(bytes).toBytes(true);
  } catch {
    throw new LedgerError("invalid-response", "the returned key is not a secp256k1 point");
  }
};

/** `r ‖ s` from the app's 65-byte `r ‖ s ‖ v` signature; v is recovered when the tx is assembled. */
const signature = (data: Uint8Array): Uint8Array => {
  if (data.length !== 65) {
    throw new LedgerError("invalid-response", "tron signature is not 65 bytes");
  }
  return data.subarray(0, 64);
};

/**
 * `INS_02` → `LV(65 uncompressed) ‖ LV(34 base58) ‖ [chain code 32 when P2 requests it]`. The
 * returned base58 address must be the one derived from the returned key — anything else means the
 * bytes in between are not the address the device signed for (docs/APDU.md).
 */
const publicNodeReply = (
  data: Uint8Array,
  chainCode: boolean,
): { publicKey: Uint8Array; address: string; chainCode?: Uint8Array } => {
  const reader = new Reader(data);
  const uncompressed = reader.lv();
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new LedgerError("invalid-response", "tron public key is not a 65-byte point");
  }
  const publicKey = secp256k1OnCurve(uncompressed);
  const addressBytes = reader.lv();
  if (addressBytes.length !== 34) {
    throw new LedgerError("invalid-response", "tron address is not 34 base58 characters");
  }
  let address: string;
  try {
    address = new TextDecoder("ascii", { fatal: true }).decode(addressBytes);
  } catch {
    throw new LedgerError("invalid-response", "tron address is not ASCII");
  }
  const code = chainCode ? reader.bytes(32) : undefined;
  reader.end();
  if (address !== tronAddressFromPublicKey(uncompressed)) {
    throw new LedgerError("invalid-response", "the address does not match the public key");
  }
  return { publicKey, address, ...(code === undefined ? {} : { chainCode: code }) };
};

/** `INS_02` (P2 `0x00`) → the key and address at `keyPath`; `display` asks the device to confirm. */
export async function tronAddress(
  exchange: Exchange,
  keyPath: KeyPath,
  display: boolean,
): Promise<{ readonly publicKey: Uint8Array; readonly address: string }> {
  const data = await transmit(exchange, "tron", {
    cla: CLA,
    ins: INS_GET_PUBLIC_KEY,
    p1: display ? P1_CONFIRM : 0x00,
    p2: 0x00,
    data: encodePath(keyPath, MAX_PATH_DEPTH),
  });
  const { publicKey, address } = publicNodeReply(data, false);
  return { publicKey, address };
}

/** `INS_02` (P2 `0x01` P2_CHAINCODE) → the compressed key plus the 32-byte chain code. */
export async function tronPublicNode(
  exchange: Exchange,
  keyPath: KeyPath,
): Promise<{ readonly publicKey: Uint8Array; readonly chainCode: Uint8Array }> {
  const data = await transmit(exchange, "tron", {
    cla: CLA,
    ins: INS_GET_PUBLIC_KEY,
    p1: 0x00,
    p2: 0x01,
    data: encodePath(keyPath, MAX_PATH_DEPTH),
  });
  const { publicKey, chainCode } = publicNodeReply(data, true);
  if (chainCode === undefined) {
    throw new LedgerError("invalid-response", "tron reply carries no chain code");
  }
  return { publicKey, chainCode };
}

/**
 * Chunks `path ‖ body` for INS 04: a single chunk carries `P1_SIGN`, otherwise `P1_FIRST` /
 * `P1_MORE` / `P1_LAST` (src/handlers/sign.c).
 */
const signCommands = (
  ins: number,
  keyPath: KeyPath,
  body: Uint8Array,
  lastP1: number,
): Command[] => {
  const prefix = encodePath(keyPath, MAX_PATH_DEPTH);
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix);
  payload.set(body, prefix.length);
  const commands: Command[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const slice = payload.subarray(offset, offset + CHUNK);
    const first = offset === 0;
    const last = offset + CHUNK >= payload.length;
    commands.push({
      cla: CLA,
      ins,
      p1: first && last ? P1_SIGN : first ? P1_FIRST : last ? lastP1 : P1_MORE,
      p2: 0x00,
      data: slice,
    });
  }
  return commands;
};

/** `INS_04` — signs `raw_data` (the protobuf-encoded transaction content). */
export async function tronSignTransaction(
  exchange: Exchange,
  keyPath: KeyPath,
  rawData: Uint8Array,
): Promise<Uint8Array> {
  return signature(
    await transmitChunks(exchange, "tron", signCommands(INS_SIGN, keyPath, rawData, P1_LAST)),
  );
}

/**
 * `INS_08` — `path ‖ u32 length ‖ message`; chunks use `P1_SIGN` single, `P1_FIRST` then `P1_MORE`
 * for the rest — there is no distinct last flag, the app counts the declared message length down
 * (src/handlers/sign_personal_message.c).
 */
export async function tronSignPersonalMessage(
  exchange: Exchange,
  keyPath: KeyPath,
  message: Uint8Array,
): Promise<Uint8Array> {
  const body = new Uint8Array(4 + message.length);
  body.set(u32(message.length));
  body.set(message, 4);
  return signature(
    await transmitChunks(
      exchange,
      "tron",
      signCommands(INS_SIGN_PERSONAL_MESSAGE, keyPath, body, P1_MORE),
    ),
  );
}

/** `INS_0C` — `path ‖ domainHash(32) ‖ messageHash(32)` in a single APDU (requires Sign by hash). */
export async function tronSignTypedDataHash(
  exchange: Exchange,
  keyPath: KeyPath,
  domainHash: Uint8Array,
  messageHash: Uint8Array,
): Promise<Uint8Array> {
  if (domainHash.length !== 32 || messageHash.length !== 32) {
    throw input("TIP-712 hashes must be 32 bytes");
  }
  const path = encodePath(keyPath, MAX_PATH_DEPTH);
  const data = new Uint8Array(path.length + 64);
  data.set(path);
  data.set(domainHash, path.length);
  data.set(messageHash, path.length + 32);
  return signature(
    await transmit(exchange, "tron", {
      cla: CLA,
      ins: INS_SIGN_TIP_712_MESSAGE,
      p1: 0x00,
      p2: 0x00,
      data,
    }),
  );
}

/**
 * `INS_06` — `config ‖ major ‖ minor ‖ patch`, config bits: 0 data allowed, 1 custom contract, 3
 * sign by hash (src/handlers/get_app_configuration.c).
 */
export async function tronConfiguration(exchange: Exchange): Promise<{
  readonly version: string;
  readonly dataAllowed: boolean;
  readonly customContracts: boolean;
  readonly signByHash: boolean;
}> {
  const data = await transmit(exchange, "tron", {
    cla: CLA,
    ins: INS_GET_APP_CONFIGURATION,
    p1: 0x00,
    p2: 0x00,
    data: new Uint8Array(0),
  });
  const reader = new Reader(data);
  const flags = reader.u8();
  const major = reader.u8();
  const minor = reader.u8();
  const patch = reader.u8();
  reader.end();
  return {
    version: `${major}.${minor}.${patch}`,
    // oxlint-disable eslint/no-bitwise -- the configuration reply is a bitmask (handlers/get_app_configuration.c)
    dataAllowed: (flags & 0x01) !== 0,
    customContracts: (flags & 0x02) !== 0,
    signByHash: (flags & 0x08) !== 0,
    // oxlint-enable eslint/no-bitwise
  };
}
