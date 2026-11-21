/**
 * /tron/sign — deterministic (RFC 6979) ECDSA signing over the chain's canonical payloads: a
 * transaction signs sha256(raw_data), a message the TIP-191 digest. Inputs must already be
 * normalized: the kernel calls `normalizeTron` first and rejects on a ChainError. No key caching;
 * the caller wipes key bytes.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import * as Hex from "ox/Hex";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";

import { ChainError } from "../index.ts";
import { tronMessageDigest } from "./message.ts";
import { decodeTronRawData } from "./raw.ts";
import { parseTronTypedData, tronTypedDataDigest } from "./typed-data.ts";

const key = (privateKey: Uint8Array): `0x${string}` => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be 32 bytes");
  }
  return Hex.fromBytes(privateKey);
};

/** 65-byte r‖s‖v; `Signature.toBytes` emits v = 27 + yParity, the tronweb ECKeySign form. */
const sign = (payload: Uint8Array, privateKey: `0x${string}`): Uint8Array =>
  Signature.toBytes(
    Signature.from(Secp256k1.sign({ payload: Hex.fromBytes(payload), privateKey, as: "Object" })),
  );

/** Signs raw_data; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signTronTransaction = (rawData: Uint8Array, privateKey: Uint8Array): Uint8Array => {
  if (rawData.length === 32) {
    throw new ChainError("invalid-request", "a bare 32-byte digest is not a TRON transaction");
  }
  decodeTronRawData(rawData);
  return sign(sha256(rawData), key(privateKey));
};

/** TIP-191 message signing; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signTronMessage = (message: Uint8Array, privateKey: Uint8Array): Uint8Array => {
  if (message.length === 0) {
    throw new ChainError("invalid-request", "a TRON message is non-empty bytes");
  }
  return sign(tronMessageDigest(message), key(privateKey));
};

/** TIP-712 typed-data signing; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signTronTypedData = (typedData: string, privateKey: Uint8Array): Uint8Array =>
  sign(tronTypedDataDigest(parseTronTypedData(typedData).json), key(privateKey));
