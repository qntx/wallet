/**
 * Response layouts and card-output validation (protocol.md §9.2, §9.4–9.14). Every decoder checks
 * the response's exact structure and the semantics the design assigns the host; anything else is
 * `card-fault`. Decoders that take host inputs (a cardId, params) reject out-of-shape arguments
 * with `invalid-input`.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { HDKey } from "@scure/bip32";

import { validPoint } from "./bytes.ts";
import { checkOthers } from "./commands.ts";
import type { CreateParams } from "./commands.ts";
import { CardError } from "./errors.ts";
import { ACCESS_LIMITS } from "./status.ts";

export type CardStatus =
  | { readonly life: "blank"; readonly tries: 0 }
  | { readonly life: "loaded"; readonly tries: number };

/** `masterPublicKey ‖ origin ‖ c ‖ members` from CREATE, VERIFY or IMPORT (§9.2). */
export type WalletInfo = {
  readonly masterPublicKey: Uint8Array;
  readonly origin: "generated" | "imported";
  readonly members: ReadonlyArray<Uint8Array>;
};

const fault = (message: string): never => {
  throw new CardError("card-fault", message);
};

/** §9.3: `life ‖ tries` — `01 00` BLANK; `02` with `tries ∈ [0, L]` LOADED. */
function status(data: Uint8Array): CardStatus {
  if (data.length !== 2) {
    fault("STATUS response is not 2 bytes");
  }
  const bytes = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const life = bytes.getUint8(0);
  const tries = bytes.getUint8(1);
  if (life === 0x01 && tries === 0x00) {
    return { life: "blank", tries: 0 };
  }
  if (life === 0x02 && tries <= ACCESS_LIMITS.failures) {
    return { life: "loaded", tries };
  }
  return fault("STATUS response carries an unknown life or tries");
}

type ParsedWalletInfo = {
  readonly masterPublicKey: Uint8Array;
  readonly originByte: number;
  readonly members: ReadonlyArray<Uint8Array>;
};

function parseWalletInfo(data: Uint8Array): ParsedWalletInfo {
  if (data.length < 35 + 16 || (data.length - 35) % 16 !== 0) {
    fault("WalletInfo has an invalid length");
  }
  const bytes = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = bytes.getUint8(34);
  if (count < 1 || count > 3 || data.length !== 35 + 16 * count) {
    fault("WalletInfo member count is inconsistent");
  }
  const masterPublicKey = data.subarray(0, 33);
  if (!validPoint(masterPublicKey)) {
    fault("WalletInfo master key is not a valid point");
  }
  const origin = bytes.getUint8(33);
  if (origin !== 0x01 && origin !== 0x02) {
    fault("WalletInfo origin is neither generated nor imported");
  }
  const members: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    members.push(new Uint8Array(data.subarray(35 + 16 * i, 35 + 16 * (i + 1))));
  }
  for (const [i, id] of members.entries()) {
    if (members.slice(i + 1).some((other) => equalBytes(other, id))) {
      fault("WalletInfo member IDs are not pairwise distinct");
    }
  }
  return {
    masterPublicKey: new Uint8Array(masterPublicKey),
    originByte: origin,
    members,
  };
}

const originName = (byte: number): WalletInfo["origin"] =>
  byte === 0x01 ? "generated" : "imported";

function checkCardId(cardId: Uint8Array): void {
  if (cardId.length !== 16) {
    throw new CardError("invalid-input", "cardId is not 16 bytes");
  }
}

/** §9.2 WalletInfo; the session card's own `ID(A)` must be a member. */
function walletInfo(data: Uint8Array, cardId: Uint8Array): WalletInfo {
  checkCardId(cardId);
  const { masterPublicKey, originByte, members } = parseWalletInfo(data);
  if (!members.some((member) => equalBytes(member, cardId))) {
    fault("WalletInfo does not list this card as a member");
  }
  return { masterPublicKey, origin: originName(originByte), members };
}

/**
 * WalletInfo echoed by CREATE (§9.4): `members = ID(A) ‖ others` in order, `origin` matching the
 * mode, and for `import` the master public key recomputed from the host's seed.
 */
function created(data: Uint8Array, params: CreateParams, cardId: Uint8Array): WalletInfo {
  checkCardId(cardId);
  checkOthers(params.others);
  const { masterPublicKey, originByte, members } = parseWalletInfo(data);
  const expectedOrigin = params.mode === "generate" ? 0x01 : 0x02;
  if (originByte !== expectedOrigin) {
    fault("CREATE echoed a different origin than requested");
  }
  if (members.length !== 1 + params.others.length) {
    fault("CREATE echoed a different member count");
  }
  for (const [i, member] of members.entries()) {
    const expected = i === 0 ? cardId : params.others[i - 1];
    if (expected === undefined || !equalBytes(member, expected)) {
      fault("CREATE echoed the members in a different order");
    }
  }
  if (params.mode === "import") {
    let expected: Uint8Array | undefined;
    try {
      expected = HDKey.fromMasterSeed(params.seed).publicKey ?? undefined;
    } catch {
      expected = undefined;
    }
    if (expected === undefined || !equalBytes(expected, masterPublicKey)) {
      fault("CREATE echoed a different master public key");
    }
  }
  return { masterPublicKey, origin: originName(originByte), members };
}

/** §9.8 secp256k1 response: `publicKey(33) ‖ chainCode(32)`; the key must be a valid point. */
function publicKey(data: Uint8Array): PublicKeyResult {
  if (data.length !== 65) {
    fault("PUBLIC_KEY response is not 65 bytes");
  }
  const key = data.subarray(0, 33);
  if (!validPoint(key)) {
    fault("PUBLIC_KEY returned a point that is not on the curve");
  }
  return {
    publicKey: new Uint8Array(key),
    chainCode: new Uint8Array(data.subarray(33, 65)),
  };
}

/** Commands whose success response is empty. */
function empty(data: Uint8Array): void {
  if (data.length > 0) {
    fault("a command with an empty layout returned data");
  }
}

/** §9.13 `P1 = 0x01` response: `ct ‖ tag` — 160 bytes (c = 2) or 176 (c = 3). */
function exportPayload(data: Uint8Array): Uint8Array {
  if (data.length !== 160 && data.length !== 176) {
    fault("export payload is not 160 or 176 bytes");
  }
  return new Uint8Array(data);
}

export type PublicKeyResult = {
  readonly publicKey: Uint8Array;
  readonly chainCode: Uint8Array;
};

export type Decode = {
  readonly status: (data: Uint8Array) => CardStatus;
  readonly walletInfo: (data: Uint8Array, cardId: Uint8Array) => WalletInfo;
  readonly created: (data: Uint8Array, params: CreateParams, cardId: Uint8Array) => WalletInfo;
  readonly publicKey: (data: Uint8Array) => PublicKeyResult;
  readonly empty: (data: Uint8Array) => void;
  readonly exportPayload: (data: Uint8Array) => Uint8Array;
};

export const decode: Decode = {
  status,
  walletInfo,
  created,
  publicKey,
  empty,
  exportPayload,
};
