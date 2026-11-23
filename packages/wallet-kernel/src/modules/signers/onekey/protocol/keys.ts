/**
 * Pinned public material: BIP-32 account nodes and first-hop addresses the caller pins a device to.
 * Every response field is verified against the request — the node echoes the derivation path (depth
 * and child number), the xpub serialization must carry the same depth, parent fingerprint, child
 * number, chain code and public key, and keys must be on-curve points of the exact wire size.
 * Anything that fails is `device-fault`; anything the caller got wrong is `invalid-input`. The
 * shapes deliberately mirror the signer foundation's PinnedNode/PinnedEd25519 without importing
 * it.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, createBase58check } from "@scure/base";

import { OneKeyError } from "./errors.ts";
import {
  Address,
  EthereumAddressOneKey,
  EthereumGetAddressOneKey,
  EthereumGetPublicKeyOneKey,
  EthereumPublicKeyOneKey,
  GetAddress,
  GetPublicKey,
  PublicKey,
  SolanaAddress,
  SolanaGetAddress,
  TronAddress,
  TronGetAddress,
} from "./messages.ts";
import type { HDNodeFields } from "./messages.ts";
import type { Decoded } from "./proto.ts";
import { call } from "./session.ts";
import type { Exchange } from "./session.ts";

const base58check = createBase58check(sha256);

const HARDENED = 0x80_00_00_00;
const UINT32_MAX = 0xff_ff_ff_ff;
const XPUB_PAYLOAD = 78;
const MAX_ADDRESS = 128;

const fault = (message: string): OneKeyError => new OneKeyError("device-fault", message);
const invalid = (message: string): OneKeyError => new OneKeyError("invalid-input", message);

type HDNode = Decoded<HDNodeFields>;

/** A BIP-32 node the device proved it holds, verified against the request and its xpub. */
export type DeviceNode = {
  readonly path: ReadonlyArray<number>;
  readonly publicKey: Uint8Array;
  readonly chainCode: Uint8Array;
  /** The parent node's 4-byte fingerprint as serialized in the xpub. */
  readonly parent: Uint8Array;
};

/** A bitcoin GetPublicKey node; `rootFingerprint` is the master fingerprint when the device sets it. */
export type PublicNode = DeviceNode & { readonly rootFingerprint: Uint8Array | undefined };

export type AddressFamily = "bitcoin" | "evm" | "solana" | "tron";

function checkPath(path: ReadonlyArray<number>): void {
  if (path.length === 0) {
    throw invalid("derivation path is empty");
  }
  for (const element of path) {
    if (!Number.isInteger(element) || element < 0 || element > UINT32_MAX) {
      throw invalid("derivation path element out of range");
    }
  }
}

/** InputScriptType (messages-bitcoin.proto) has values 0..5; anything else is a caller bug. */
function checkScriptType(scriptType: number): void {
  if (!Number.isInteger(scriptType) || scriptType < 0 || scriptType > 5) {
    throw invalid("script type out of range");
  }
}

function checkNode(path: ReadonlyArray<number>, node: HDNode): HDNode {
  if (node.depth !== path.length) {
    throw fault("node depth does not match the requested path");
  }
  if (node.childNum !== path.at(-1)) {
    throw fault("node child number does not match the requested path");
  }
  if (node.privateKey !== undefined) {
    throw fault("device returned private key material");
  }
  if (node.chainCode.length !== 32) {
    throw fault("chain code is not 32 bytes");
  }
  if (
    node.publicKey.length !== 33 ||
    (node.publicKey[0] !== 2 && node.publicKey[0] !== 3) ||
    !validPoint(node.publicKey)
  ) {
    throw fault("public key is not a compressed secp256k1 point");
  }
  return node;
}

function validPoint(bytes: Uint8Array): boolean {
  try {
    secp256k1.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses the device's xpub and returns the parent fingerprint it claims. The 4-byte version is not
 * checked — the magic varies by script type (xpub/ypub/zpub); the payload fields must equal the
 * node's.
 */
function checkXpub(xpub: string, node: HDNode): Uint8Array {
  let payload: Uint8Array;
  try {
    payload = base58check.decode(xpub);
  } catch {
    throw fault("xpub is not base58check");
  }
  if (payload.length !== XPUB_PAYLOAD) {
    throw fault("xpub payload is not 78 bytes");
  }
  if (payload[4] !== node.depth) {
    throw fault("xpub depth does not match the node");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  if (view.getUint32(5) !== node.fingerprint) {
    throw fault("xpub parent fingerprint does not match the node");
  }
  if (view.getUint32(9) !== node.childNum) {
    throw fault("xpub child number does not match the node");
  }
  if (!equal(payload.subarray(13, 45), node.chainCode)) {
    throw fault("xpub chain code does not match the node");
  }
  if (!equal(payload.subarray(45, 78), node.publicKey)) {
    throw fault("xpub public key does not match the node");
  }
  return new Uint8Array(payload.subarray(5, 9));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

const u32be = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

/**
 * The account node at `path` via bitcoin GetPublicKey (coin "Bitcoin"; `scriptType` only changes
 * the xpub version magic, which is not checked).
 */
export async function publicNode(
  exchange: Exchange,
  path: ReadonlyArray<number>,
  options?: { readonly scriptType?: number },
): Promise<PublicNode> {
  checkPath(path);
  if (options?.scriptType !== undefined) {
    checkScriptType(options.scriptType);
  }
  const response = await call(
    exchange,
    {
      def: GetPublicKey,
      value: {
        addressN: [...path],
        coinName: "Bitcoin",
        ...(options?.scriptType === undefined ? {} : { scriptType: options.scriptType }),
      },
    },
    PublicKey,
  );
  const node = checkNode(path, response.node);
  return {
    path: [...path],
    publicKey: new Uint8Array(node.publicKey),
    chainCode: new Uint8Array(node.chainCode),
    parent: checkXpub(response.xpub, node),
    rootFingerprint:
      response.rootFingerprint === undefined ? undefined : u32be(response.rootFingerprint),
  };
}

/** The account node at `path` via EthereumGetPublicKeyOneKey; same checks, no root fingerprint. */
export async function evmPublicNode(
  exchange: Exchange,
  path: ReadonlyArray<number>,
  chainId?: bigint,
): Promise<DeviceNode> {
  checkPath(path);
  const response = await call(
    exchange,
    {
      def: EthereumGetPublicKeyOneKey,
      value: { addressN: [...path], ...(chainId === undefined ? {} : { chainId }) },
    },
    EthereumPublicKeyOneKey,
  );
  const node = checkNode(path, response.node);
  return {
    path: [...path],
    publicKey: new Uint8Array(node.publicKey),
    chainCode: new Uint8Array(node.chainCode),
    parent: checkXpub(response.xpub, node),
  };
}

/**
 * The address string the device derives at `path` for the family. Only the wire format is checked
 * (non-empty printable ASCII within the message-size budget); the driver compares the value against
 * a locally derived address.
 */
export async function address(
  exchange: Exchange,
  family: AddressFamily,
  path: ReadonlyArray<number>,
  options: {
    readonly showDisplay: boolean;
    readonly scriptType?: number;
    readonly chainId?: bigint;
    /** The network the bitcoin address derives under — "Bitcoin" or "Testnet" on the wire. */
    readonly network?: "mainnet" | "testnet";
  },
): Promise<string> {
  checkPath(path);
  let value: string | undefined;
  switch (family) {
    case "bitcoin": {
      if (options.scriptType !== undefined) {
        checkScriptType(options.scriptType);
      }
      const response = await call(
        exchange,
        {
          def: GetAddress,
          value: {
            addressN: [...path],
            coinName: options.network === "testnet" ? "Testnet" : "Bitcoin",
            showDisplay: options.showDisplay,
            ...(options.scriptType === undefined ? {} : { scriptType: options.scriptType }),
          },
        },
        Address,
      );
      value = response.address;
      break;
    }
    case "evm": {
      const response = await call(
        exchange,
        {
          def: EthereumGetAddressOneKey,
          value: {
            addressN: [...path],
            showDisplay: options.showDisplay,
            ...(options.chainId === undefined ? {} : { chainId: options.chainId }),
          },
        },
        EthereumAddressOneKey,
      );
      value = response.address;
      break;
    }
    case "solana": {
      const response = await call(
        exchange,
        {
          def: SolanaGetAddress,
          value: { addressN: [...path], showDisplay: options.showDisplay },
        },
        SolanaAddress,
      );
      value = response.address;
      break;
    }
    case "tron": {
      const response = await call(
        exchange,
        {
          def: TronGetAddress,
          value: { addressN: [...path], showDisplay: options.showDisplay },
        },
        TronAddress,
      );
      value = response.address;
      break;
    }
  }
  if (value === undefined || value.length === 0 || value.length > MAX_ADDRESS) {
    throw fault("device returned no usable address");
  }
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || code < 0x21 || code > 0x7e) {
      throw fault("address is not printable ASCII");
    }
  }
  return value;
}

/**
 * The SLIP-10 ed25519 public key at `path`, carried in the base58 SolanaAddress. Every element must
 * be hardened — SLIP-10 has no public derivation — and the decoded point must be a valid 32-byte
 * ed25519 key.
 */
export async function solanaPublicKey(
  exchange: Exchange,
  path: ReadonlyArray<number>,
  showDisplay: boolean,
): Promise<Uint8Array> {
  checkPath(path);
  for (const element of path) {
    if (element < HARDENED) {
      throw invalid("solana path elements must be hardened");
    }
  }
  const response = await call(
    exchange,
    {
      def: SolanaGetAddress,
      value: { addressN: [...path], showDisplay },
    },
    SolanaAddress,
  );
  let key: Uint8Array;
  try {
    key = base58.decode(response.address);
  } catch {
    throw fault("solana address is not base58");
  }
  if (key.length !== 32) {
    throw fault("solana public key is not 32 bytes");
  }
  try {
    ed25519.Point.fromBytes(key);
  } catch {
    throw fault("solana public key is not an ed25519 point");
  }
  return key;
}
