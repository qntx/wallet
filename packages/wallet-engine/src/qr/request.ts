import { bytesToHex } from "@noble/hashes/utils.js";
/**
 * `readQrRequest` — a scanned sign-request UR payload to the engine's `QrRequest`: strictly decoded
 * through `@qntx/ur`'s interop codecs (Keystone layout only for TRON), with every foreign failure
 * folded into `QrError`. The result is still untrusted: the kernel re-normalizes whatever sign
 * request the pipeline builds from it.
 */
import { base58 } from "@scure/base";
import { parseTransaction } from "viem";

import {
  ethSignRequestCodec,
  solSignRequestCodec,
  tronSignRequestCodec,
  oneKeyTronSignRequestCodec,
} from "@qntx/ur/interop";
import type { Keypath, TronSignRequest } from "@qntx/ur/interop";
import { cryptoPsbtCodec, psbtCodec } from "@qntx/ur/registry";
import { Ur, fromUr } from "@qntx/ur/typed";
import type { UrCodec } from "@qntx/ur/typed";
import type { EvmTransaction, KeyPath } from "@qntx/wallet-chains";
import { evmSigningPreimage } from "@qntx/wallet-chains/evm";
import { isTronAddress, tronAddressFromBytes } from "@qntx/wallet-chains/tron";
import type { QrPayload } from "@qntx/wallet/hardware";

import { safeDisplayText } from "../display.ts";
import { QrError, malformed, qrGuard, unsupported } from "./errors.ts";

const HARDENED = 0x80000000;

type QrBase = {
  readonly requestId?: Uint8Array;
  readonly path: KeyPath;
  readonly xfp: number;
  readonly declared?: string;
};

export type QrRequest =
  | (QrBase & {
      readonly family: "evm";
      readonly kind: "transaction";
      readonly chainId?: number;
      readonly address?: string;
      readonly tx: EvmTransaction;
      readonly data: Uint8Array;
    })
  | (QrBase & {
      readonly family: "evm";
      readonly kind: "typed-data";
      readonly chainId?: number;
      readonly address?: string;
      readonly typedData: string;
    })
  | (QrBase & {
      readonly family: "evm";
      readonly kind: "personal-message";
      readonly chainId?: number;
      readonly address?: string;
      readonly message: Uint8Array;
    })
  | (QrBase & {
      readonly family: "solana";
      readonly kind: "transaction" | "message";
      readonly address?: string;
      readonly data: Uint8Array;
    })
  | (QrBase & {
      readonly family: "tron";
      readonly kind: "transaction" | "message";
      readonly address?: string;
      readonly data: Uint8Array;
    })
  | {
      readonly family: "bitcoin";
      readonly kind: "psbt";
      readonly urType: "crypto-psbt" | "psbt";
      readonly psbt: Uint8Array;
    };

/** `ur`'s body decoded by `codec`; the codec's own tag must name the payload type. */
const decode = <T>(payload: QrPayload, codec: UrCodec<T>): T =>
  qrGuard("malformed", () => fromUr(Ur.fromCborData(payload.type, payload.cbor), codec));

/** A BIP-32 keypath as the kernel's KeyPath numbers; wildcards and ranges are refused. */
const base = (path: Keypath, origin?: string): Omit<QrBase, "requestId"> => {
  if (path.components.length === 0) {
    malformed("empty derivation path");
  }
  const steps: number[] = [];
  for (const component of path.components) {
    if (component.kind !== "index") {
      malformed("non-concrete derivation path");
    }
    steps.push(component.index + (component.hardened ? HARDENED : 0));
  }
  if (path.sourceFingerprint === undefined) {
    throw new QrError("fingerprint-missing", "request carries no source fingerprint");
  }
  const declared = origin === undefined ? undefined : safeDisplayText(origin, 64);
  return {
    path: steps,
    xfp: path.sourceFingerprint,
    ...(declared === undefined ? {} : { declared }),
  };
};

const requestId = (bytes: Uint8Array | undefined): Uint8Array | undefined => {
  if (bytes === undefined) {
    return undefined;
  }
  if (bytes.length !== 16) {
    malformed("requestId must be a 16-byte UUID");
  }
  return bytes;
};

const ethChainId = (value: number | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    malformed("chainId must be a safe integer in [1, 2^53)");
  }
  return value;
};

const evmAddress = (bytes: Uint8Array | undefined): string | undefined => {
  if (bytes === undefined) {
    return undefined;
  }
  if (bytes.length !== 20) {
    malformed("address must be 20 bytes");
  }
  return `0x${bytesToHex(bytes)}`;
};

const accessList = (
  list: ReadonlyArray<{ address: string; storageKeys: ReadonlyArray<`0x${string}`> }> | undefined,
): ReadonlyArray<{ address: string; storageKeys: ReadonlyArray<string> }> =>
  (list ?? []).map((entry) => ({ address: entry.address, storageKeys: [...entry.storageKeys] }));

const bigintField = (value: bigint | undefined, name: string): string => {
  if (value === undefined) {
    malformed(`transaction is missing ${name}`);
  }
  // `EvmTransaction` quantities are canonical-hex strings, not decimals.
  return `0x${value.toString(16)}`;
};

const evmTx = (signData: Uint8Array): { tx: EvmTransaction; typeByte: "legacy" | number } => {
  const [first] = signData;
  if (first === 0x04) {
    unsupported("eip7702 envelopes are not accepted over QR");
  }
  const parsed = qrGuard("malformed", () => parseTransaction(`0x${bytesToHex(signData)}`));
  const type = parsed.type ?? "legacy";
  if (type !== "legacy" && type !== "eip2930" && type !== "eip1559") {
    unsupported(`envelope type ${type}`);
  }
  if (type === "legacy" && parsed.chainId === undefined) {
    unsupported("a legacy transaction without an EIP-155 chain id is replayable");
  }
  const shared = {
    chainId: parsed.chainId ?? malformed("typed transaction is missing chainId"),
    nonce: parsed.nonce ?? malformed("transaction is missing nonce"),
    gas: bigintField(parsed.gas, "gas"),
    value: `0x${(parsed.value ?? 0n).toString(16)}`,
    data: parsed.data ?? "0x",
    ...(parsed.to === undefined || parsed.to === null ? {} : { to: parsed.to }),
  };
  const tx: EvmTransaction =
    type === "legacy"
      ? { ...shared, type, gasPrice: bigintField(parsed.gasPrice, "gasPrice") }
      : type === "eip2930"
        ? {
            ...shared,
            type,
            gasPrice: bigintField(parsed.gasPrice, "gasPrice"),
            accessList: accessList(parsed.accessList),
          }
        : {
            ...shared,
            type,
            accessList: accessList(parsed.accessList),
            maxFeePerGas: bigintField(parsed.maxFeePerGas, "maxFeePerGas"),
            maxPriorityFeePerGas: bigintField(parsed.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
          };
  return { tx, typeByte: type === "legacy" ? "legacy" : (first ?? 0) };
};

const utf8 = (bytes: Uint8Array): string =>
  qrGuard("malformed", () => new TextDecoder("utf-8", { fatal: true }).decode(bytes));

const nonEmpty = (bytes: Uint8Array, what: string): Uint8Array => {
  if (bytes.length === 0) {
    malformed(`${what} must not be empty`);
  }
  return bytes;
};

const readEth = (payload: QrPayload): QrRequest => {
  const req = decode(payload, ethSignRequestCodec);
  nonEmpty(req.signData, "signData");
  const head = base(req.derivationPath, req.origin);
  const id = requestId(req.requestId);
  const address = evmAddress(req.address);
  const chainId = ethChainId(req.chainId);
  const tail = {
    ...(id === undefined ? {} : { requestId: id }),
    ...(chainId === undefined ? {} : { chainId }),
    ...(address === undefined ? {} : { address }),
  };
  if (req.dataType === "transaction" || req.dataType === "typedTransaction") {
    const { tx } = evmTx(req.signData);
    if (bytesToHex(evmSigningPreimage(tx)) !== bytesToHex(req.signData)) {
      malformed("transaction does not re-serialize to the signed bytes");
    }
    return { ...head, ...tail, family: "evm", kind: "transaction", tx, data: req.signData };
  }
  if (req.dataType === "typedData") {
    return { ...head, ...tail, family: "evm", kind: "typed-data", typedData: utf8(req.signData) };
  }
  return {
    ...head,
    ...tail,
    family: "evm",
    kind: "personal-message",
    message: req.signData,
  };
};

const solanaAddress = (bytes: Uint8Array | undefined): string | undefined => {
  if (bytes === undefined) {
    return undefined;
  }
  if (bytes.length === 32) {
    return base58.encode(bytes);
  }
  const text = qrGuard("malformed", () => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
    malformed("solana address is neither 32 bytes nor base58 text");
  }
  return text;
};

const readSol = (payload: QrPayload): QrRequest => {
  const req = decode(payload, solSignRequestCodec);
  if (req.signType !== "transaction" && req.signType !== "message") {
    unsupported(`solana signType ${req.signType}`);
  }
  nonEmpty(req.signData, "signData");
  const id = requestId(req.requestId);
  const address = solanaAddress(req.address);
  return {
    ...base(req.derivationPath, req.origin),
    ...(id === undefined ? {} : { requestId: id }),
    ...(address === undefined ? {} : { address }),
    family: "solana",
    kind: req.signType === "transaction" ? "transaction" : "message",
    data: req.signData,
  };
};

const tronAddress = (bytes: Uint8Array | undefined): string | undefined => {
  if (bytes === undefined) {
    return undefined;
  }
  if (bytes.length === 21 && bytes[0] === 0x41) {
    return tronAddressFromBytes(bytes);
  }
  const text = qrGuard("malformed", () => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isTronAddress(text)) {
    malformed("tron address is neither 21 raw bytes nor base58check text");
  }
  return text;
};

const readTron = (payload: QrPayload): QrRequest => {
  let req: TronSignRequest;
  try {
    req = decode(payload, tronSignRequestCodec);
  } catch (error) {
    // A payload only OneKey's layout reads is refused as unsupported, not malformed.
    if (error instanceof QrError && error.code === "malformed") {
      try {
        decode(payload, oneKeyTronSignRequestCodec);
      } catch {
        throw error;
      }
      return unsupported("OneKey tron-sign-request layout");
    }
    throw error;
  }
  if (req.dataType === "messageV1") {
    unsupported("tron messageV1");
  }
  nonEmpty(req.signData, "signData");
  const id = requestId(req.requestId);
  const address = tronAddress(req.address);
  return {
    ...base(req.derivationPath, req.origin),
    ...(id === undefined ? {} : { requestId: id }),
    ...(address === undefined ? {} : { address }),
    family: "tron",
    kind: req.dataType === "transaction" ? "transaction" : "message",
    data: req.signData,
  };
};

const readPsbt = (payload: QrPayload): QrRequest => {
  const codec = payload.type === "crypto-psbt" ? cryptoPsbtCodec : psbtCodec;
  const { bytes } = decode(payload, codec as UrCodec<{ readonly bytes: Uint8Array }>);
  return {
    family: "bitcoin",
    kind: "psbt",
    urType: payload.type === "crypto-psbt" ? "crypto-psbt" : "psbt",
    psbt: bytes,
  };
};

export const readQrRequest = (payload: QrPayload): QrRequest => {
  switch (payload.type) {
    case "eth-sign-request":
      return readEth(payload);
    case "sol-sign-request":
      return readSol(payload);
    case "tron-sign-request":
      return readTron(payload);
    case "crypto-psbt":
    case "psbt":
      return readPsbt(payload);
    default:
      return unsupported(`UR type ${payload.type} is not a sign request`);
  }
};
