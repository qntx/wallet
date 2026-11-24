/**
 * Keystone signing: what the device is shown for each request kind, the QR sign request for one
 * plan stage, and the admission checks on the signature UR that comes back. The payload sent is
 * always recomputed from the request — never trusted from the plan — and re-checked against the
 * task digest before the QR is shown, so a kernel-side inconsistency fails closed (`integrity`). A
 * response is admitted only when its request id equals the one this exchange generated
 * (`wrong-device` otherwise: a stale or foreign answer), its UR type matches, and its signature has
 * the exact shape the task needs; recovery bits never leave this module — only `r‖s` is returned
 * per task and the chain assemblers re-derive `v`.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer/transaction.js";

import type { UrCodec } from "@qntx/ur/interop";
import { ethSignatureCodec, solSignatureCodec, tronSignatureCodec } from "@qntx/ur/interop";
import { cryptoPsbtCodec } from "@qntx/ur/registry";
import { legacyMessageHash, samePsbtContent } from "@qntx/wallet-chains/bitcoin";
import {
  evmSigningPreimage,
  fiat24SessionMessage,
  networkChainId,
  planEvm,
} from "@qntx/wallet-chains/evm";
import { tronMessageDigest } from "@qntx/wallet-chains/tron";
import type { ChainSignRequest, DeviceDisplay } from "@qntx/wallet/protocol";

import { KernelError } from "../../../errors.ts";
import type { ChainPlan } from "../../chains/run.ts";
import type { DeviceIdentity, DeviceLink, SignContext } from "../driver.ts";
import {
  btcSignRequest,
  btcSignatureCodec,
  cryptoPsbt,
  decodeRegistry,
  ethSignRequest,
  solSignRequest,
  tronSignRequest,
} from "./registry.ts";

const ORIGIN = "qntx";

function integrity(): never {
  throw new KernelError("integrity", "malformed device sign exchange");
}

function wrongDevice(): never {
  throw new KernelError("wrong-device", "the signature answers a different request");
}

/** The device's display for a request: `clear` what firmware renders, refuse the rest. */
export const display = (
  _request: ChainSignRequest,
  plan: ChainPlan,
  _identity: DeviceIdentity,
): DeviceDisplay | "unsupported" => {
  switch (plan.kind) {
    case "evm.transaction":
      return plan.tx.type === "legacy" || plan.tx.type === "eip1559" ? "clear" : "unsupported";
    case "evm.personal-message":
    case "evm.fiat24-session":
    case "evm.typed-data":
    case "tron.transaction":
    case "tron.message":
    case "solana.transaction":
    case "solana.message":
    case "bitcoin.psbt":
      return "clear";
    case "bitcoin.message":
      return plan.format === "legacy" ? "clear" : "unsupported";
    default:
      return "unsupported";
  }
};

/**
 * Sends the prepared UR and reads the device's answer: a `qr` response of exactly `type` whose CBOR
 * decodes under `codec` — anything else, including a well-formed payload under the wrong type or a
 * library rejection, is `integrity`.
 */
const exchange = async <T>(
  link: DeviceLink,
  show: { readonly type: string; readonly cbor: Uint8Array },
  type: string,
  codec: UrCodec<T>,
): Promise<T> => {
  const response = await link.exchange({ kind: "qr", show, scan: [type] });
  if (response.kind !== "qr" || response.ur.type !== type) {
    integrity();
  }
  return decodeRegistry(response.ur.cbor, codec);
};

/** A signature answer must name the request id this exchange minted. */
const checkRequestId = (returned: Uint8Array | undefined, sent: Uint8Array): void => {
  if (returned === undefined || !equalBytes(returned, sent)) {
    wrongDevice();
  }
};

const compactSecp256k1 = (
  signature: { readonly requestId?: Uint8Array; readonly signature: Uint8Array },
  requestId: Uint8Array,
  length: number,
): Uint8Array => {
  checkRequestId(signature.requestId, requestId);
  if (signature.signature.length !== length) {
    integrity();
  }
  return signature.signature.subarray(0, 64);
};

/** The EIP-191 digest of `message` — what a personal-message task must equal. */
const personalDigest = (message: Uint8Array): Uint8Array =>
  keccak_256(
    concatBytes(utf8ToBytes(`\u0019Ethereum Signed Message:\n${message.length}`), message),
  );

const expectDigest = (computed: Uint8Array, task: { readonly digest: Uint8Array }): void => {
  if (!equalBytes(computed, task.digest)) {
    integrity();
  }
};

const evm = async (
  link: DeviceLink,
  context: SignContext,
  request: Extract<ChainSignRequest, { kind: `evm.${string}` }>,
  stage: Extract<ChainPlan, { kind: `evm.${string}` }>,
): Promise<Uint8Array> => {
  const [task] = stage.tasks;
  const requestId = context.random(16);
  let signData: Uint8Array;
  let dataType: 1 | 2 | 3 | 4;
  let chainId: number | undefined;
  if (stage.kind === "evm.transaction") {
    if (request.kind !== "evm.transaction") {
      integrity();
    }
    const { tx } = request;
    signData = evmSigningPreimage(tx);
    const { chainId: txChainId } = tx;
    if (tx.type === "legacy") {
      dataType = 1;
      chainId = txChainId;
    } else if (tx.type === "eip1559") {
      dataType = 4;
      chainId = txChainId;
    } else {
      // `display` refused these before the prompt — reaching them is a kernel inconsistency.
      integrity();
    }
    expectDigest(keccak_256(signData), task);
  } else if (stage.kind === "evm.typed-data") {
    if (request.kind !== "evm.typed-data") {
      integrity();
    }
    signData = utf8ToBytes(request.typedData);
    dataType = 2;
    // The digest is an EIP-712 hash, not a hash of the JSON sent — re-plan the same request and
    // require the same task so the JSON the device signs is provably the one that was planned.
    const replanned = planEvm(request, { path: task.path, publicKey: task.publicKey });
    expectDigest(replanned.tasks[0].digest, task);
  } else {
    if (request.kind !== stage.kind) {
      integrity();
    }
    signData =
      request.kind === "evm.fiat24-session"
        ? utf8ToBytes(
            fiat24SessionMessage(
              networkChainId(request.network),
              request.tokenId,
              request.deadline,
            ),
          )
        : request.message;
    dataType = 3;
    expectDigest(personalDigest(signData), task);
  }
  const cbor = ethSignRequest({
    requestId,
    signData,
    dataType,
    ...(chainId === undefined ? {} : { chainId }),
    path: task.path,
    fingerprint: context.pin.fingerprint,
    origin: ORIGIN,
  });
  const answer = await exchange(
    link,
    { type: "eth-sign-request", cbor },
    "eth-signature",
    ethSignatureCodec,
  );
  return compactSecp256k1(answer, requestId, 65);
};

const tron = async (
  link: DeviceLink,
  context: SignContext,
  request: Extract<ChainSignRequest, { kind: `tron.${string}` }>,
  stage: Extract<ChainPlan, { kind: `tron.${string}` }>,
): Promise<Uint8Array> => {
  const [task] = stage.tasks;
  const requestId = context.random(16);
  let signData: Uint8Array;
  let dataType: 1 | 2;
  if (request.kind === "tron.transaction" && stage.kind === "tron.transaction") {
    signData = request.rawData;
    dataType = 1;
    expectDigest(sha256(signData), task);
  } else if (request.kind === "tron.message" && stage.kind === "tron.message") {
    signData = request.message;
    dataType = 2;
    expectDigest(tronMessageDigest(signData), task);
  } else {
    integrity();
  }
  const cbor = tronSignRequest({
    requestId,
    signData,
    dataType,
    path: task.path,
    fingerprint: context.pin.fingerprint,
    origin: ORIGIN,
  });
  const answer = await exchange(
    link,
    { type: "tron-sign-request", cbor },
    "tron-signature",
    tronSignatureCodec,
  );
  return compactSecp256k1(answer, requestId, 65);
};

const solana = async (
  link: DeviceLink,
  context: SignContext,
  request: Extract<ChainSignRequest, { kind: `solana.${string}` }>,
  stage: Extract<ChainPlan, { kind: `solana.${string}` }>,
): Promise<Uint8Array> => {
  const [task] = stage.tasks;
  if (request.kind !== stage.kind) {
    integrity();
  }
  const signData = request.message;
  if (!equalBytes(signData, task.message)) {
    integrity();
  }
  const requestId = context.random(16);
  const cbor = solSignRequest({
    requestId,
    signData,
    signType: request.kind === "solana.transaction" ? 1 : 2,
    path: task.path,
    fingerprint: context.pin.fingerprint,
    origin: ORIGIN,
  });
  const answer = await exchange(
    link,
    { type: "sol-sign-request", cbor },
    "sol-signature",
    solSignatureCodec,
  );
  checkRequestId(answer.requestId, requestId);
  if (answer.signature.length !== 64) {
    integrity();
  }
  return answer.signature;
};

const bitcoinPsbt = async (
  link: DeviceLink,
  stage: Extract<ChainPlan, { kind: "bitcoin.psbt" }>,
): Promise<ReadonlyArray<Uint8Array>> => {
  const cbor = cryptoPsbt(stage.psbt);
  const response = await exchange(
    link,
    { type: "crypto-psbt", cbor },
    "crypto-psbt",
    cryptoPsbtCodec,
  );
  const signed = response.bytes;
  if (!samePsbtContent(stage.psbt, signed)) {
    integrity();
  }
  let transaction: Transaction;
  try {
    transaction = Transaction.fromPSBT(signed);
  } catch {
    integrity();
  }
  return stage.tasks.map((task, index) => {
    const planned = stage.inputs[index];
    if (planned === undefined) {
      integrity();
    }
    const input = transaction.getInput(planned.index);
    if (task.scheme === "bip340") {
      const signature = input.tapKeySig;
      if (signature === undefined || signature.length !== (planned.sighash === 0 ? 64 : 65)) {
        integrity();
      }
      if (signature.length === 65 && signature[64] !== planned.sighash) {
        integrity();
      }
      return signature.subarray(0, 64);
    }
    const entry = (input.partialSig ?? []).find(([key]) => equalBytes(key, task.publicKey));
    if (entry === undefined) {
      integrity();
    }
    const [, der] = entry;
    if (der.length < 2 || der.at(-1) !== planned.sighash) {
      integrity();
    }
    let signature: Uint8Array;
    try {
      signature = secp256k1.Signature.fromBytes(der.subarray(0, -1), "der").toBytes();
    } catch {
      integrity();
    }
    return signature;
  });
};

const bitcoinMessage = async (
  link: DeviceLink,
  context: SignContext,
  request: Extract<ChainSignRequest, { kind: "bitcoin.message" }>,
  stage: Extract<ChainPlan, { kind: "bitcoin.message" }>,
): Promise<Uint8Array> => {
  const [task] = stage.tasks;
  if (
    request.format !== "legacy" ||
    stage.format !== "legacy" ||
    task.scheme !== "ecdsa-secp256k1"
  ) {
    integrity();
  }
  const signData = utf8ToBytes(request.message);
  expectDigest(legacyMessageHash(request.message), task);
  const requestId = context.random(16);
  const cbor = btcSignRequest({
    requestId,
    signData,
    paths: [task.path],
    fingerprint: context.pin.fingerprint,
    origin: ORIGIN,
  });
  const answer = await exchange(
    link,
    { type: "btc-sign-request", cbor },
    "btc-signature",
    btcSignatureCodec,
  );
  checkRequestId(answer.requestId, requestId);
  if (!equalBytes(answer.publicKey, task.publicKey)) {
    wrongDevice();
  }
  if (answer.signature.length !== 65) {
    integrity();
  }
  // The compact signature is header‖r‖s — the header byte never leaves the device exchange.
  return answer.signature.subarray(1);
};

export const sign = async (
  link: DeviceLink,
  context: SignContext,
): Promise<ReadonlyArray<Uint8Array>> => {
  const { request, stage } = context;
  switch (stage.kind) {
    case "evm.transaction":
    case "evm.personal-message":
    case "evm.fiat24-session":
    case "evm.typed-data":
      if (request.kind !== stage.kind) {
        integrity();
      }
      return [await evm(link, context, request, stage)];
    case "tron.transaction":
    case "tron.message":
      if (request.kind !== stage.kind) {
        integrity();
      }
      return [await tron(link, context, request, stage)];
    case "solana.transaction":
    case "solana.message":
      if (request.kind !== "solana.transaction" && request.kind !== "solana.message") {
        integrity();
      }
      return [await solana(link, context, request, stage)];
    case "bitcoin.psbt":
      if (request.kind !== "bitcoin.psbt") {
        integrity();
      }
      return bitcoinPsbt(link, stage);
    case "bitcoin.message":
      if (request.kind !== "bitcoin.message") {
        integrity();
      }
      return [await bitcoinMessage(link, context, request, stage)];
    default:
      throw new KernelError("unsupported", "keystone cannot sign this request");
  }
};
