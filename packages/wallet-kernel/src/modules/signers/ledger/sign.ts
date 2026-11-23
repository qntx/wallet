/**
 * Ledger signing: what the device is sent for one plan stage and the admission checks on what comes
 * back. The device payload is always recomputed from the request — never trusted from the plan —
 * and checked against the task digest (`expectDigest`) before any APDU leaves, so a kernel-side
 * inconsistency fails closed. Requests the device can only blind-sign first read the app's
 * configuration: the required setting off means `blind-signing-disabled` before the device is even
 * asked. Bitcoin PSBT yields are released only when they match the plan — the yielded input, the
 * yielded key and the sighash byte must all agree, and yields outside the plan are ignored.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { bitcoinNetwork, legacyMessageHash } from "@qntx/wallet-chains/bitcoin";
import {
  evmSigningPreimage,
  fiat24SessionMessage,
  networkChainId,
  parseTypedData,
  planEvm,
} from "@qntx/wallet-chains/evm";
import {
  parseTronTypedData,
  tronMessageDigest,
  tronTypedDataHashes,
} from "@qntx/wallet-chains/tron";
import type { ChainSignRequest } from "@qntx/wallet/protocol";

import { KernelError } from "../../../errors.ts";
import type { ChainPlan } from "../../chains/run.ts";
import type { Exchange } from "../../ledger/protocol/apdu.ts";
import { btcSignMessage, btcSignPsbt } from "../../ledger/protocol/bitcoin/index.ts";
import { defaultPolicy } from "../../ledger/protocol/bitcoin/policy.ts";
import {
  ethConfiguration,
  ethSignPersonalMessage,
  ethSignTransaction,
  ethSignTypedData,
} from "../../ledger/protocol/ethereum.ts";
import {
  solanaConfiguration,
  solanaSignOffchainMessage,
  solanaSignTransaction,
} from "../../ledger/protocol/solana.ts";
import {
  tronConfiguration,
  tronSignPersonalMessage,
  tronSignTransaction,
  tronSignTypedDataHash,
} from "../../ledger/protocol/tron.ts";
import type { DeviceLink, SignContext } from "../driver.ts";
import { pinnedMaterial } from "../material.ts";
import { solanaClears, solanaOffchain, tronSettings } from "./display.ts";
import { call } from "./errors.ts";
import { apduExchange, requiredApp } from "./link.ts";

function integrity(): never {
  throw new KernelError("integrity", "malformed device sign exchange");
}

const blind = (): KernelError =>
  new KernelError("blind-signing-disabled", "the device setting required to sign is off");

const expectDigest = (computed: Uint8Array, task: { readonly digest: Uint8Array }): void => {
  if (!equalBytes(computed, task.digest)) {
    integrity();
  }
};

/** The EIP-191 digest of `message` — what a personal-message task must equal. */
const personalDigest = (message: Uint8Array): Uint8Array =>
  keccak_256(
    concatBytes(utf8ToBytes(`\u0019Ethereum Signed Message:\n${message.length}`), message),
  );

const evmBlind = (tx: { readonly data: string; readonly to?: string }): boolean =>
  tx.to === undefined || (tx.data !== "0x" && tx.data !== "");

const evm = async (
  exchange: Exchange,
  request: Extract<ChainSignRequest, { kind: `evm.${string}` }>,
  stage: Extract<ChainPlan, { kind: `evm.${string}` }>,
): Promise<Uint8Array> => {
  await requiredApp(exchange, "ethereum");
  const [task] = stage.tasks;
  if (stage.kind === "evm.transaction") {
    if (request.kind !== "evm.transaction") {
      integrity();
    }
    const { tx } = request;
    if (tx.type === "eip7702") {
      integrity(); // display refused it before the prompt
    }
    const preimage = evmSigningPreimage(tx);
    expectDigest(keccak_256(preimage), task);
    if (evmBlind(tx)) {
      const config = await call(async () => ethConfiguration(exchange));
      if (!config.blindSigning) {
        throw blind();
      }
    }
    return call(async () => ethSignTransaction(exchange, task.path, preimage));
  }
  if (stage.kind === "evm.typed-data") {
    if (request.kind !== "evm.typed-data") {
      integrity();
    }
    // The digest is an EIP-712 hash, not a hash of the JSON sent — re-plan the same request and
    // require the same task so the JSON the device signs is provably the one that was planned.
    const replanned = planEvm(request, { path: task.path, publicKey: task.publicKey });
    expectDigest(replanned.tasks[0].digest, task);
    const config = await call(async () => ethConfiguration(exchange));
    if (!config.blindSigning) {
      throw blind();
    }
    return call(async () =>
      ethSignTypedData(exchange, task.path, parseTypedData(request.typedData).json),
    );
  }
  if (request.kind !== stage.kind) {
    integrity();
  }
  const signData =
    request.kind === "evm.fiat24-session"
      ? utf8ToBytes(
          fiat24SessionMessage(networkChainId(request.network), request.tokenId, request.deadline),
        )
      : request.message;
  expectDigest(personalDigest(signData), task);
  return call(async () => ethSignPersonalMessage(exchange, task.path, signData));
};

const tron = async (
  exchange: Exchange,
  request: Extract<ChainSignRequest, { kind: `tron.${string}` }>,
  stage: Extract<ChainPlan, { kind: `tron.${string}` }>,
): Promise<Uint8Array> => {
  await requiredApp(exchange, "tron");
  const [task] = stage.tasks;
  if (request.kind === "tron.transaction" && stage.kind === "tron.transaction") {
    const { rawData } = request;
    expectDigest(sha256(rawData), task);
    const needs = tronSettings(rawData);
    if (needs.dataAllowed || needs.customContracts || needs.signByHash) {
      const config = await call(async () => tronConfiguration(exchange));
      if (
        (needs.dataAllowed && !config.dataAllowed) ||
        (needs.customContracts && !config.customContracts) ||
        (needs.signByHash && !config.signByHash)
      ) {
        throw blind();
      }
    }
    return call(async () => tronSignTransaction(exchange, task.path, rawData));
  }
  if (request.kind === "tron.message" && stage.kind === "tron.message") {
    expectDigest(tronMessageDigest(request.message), task);
    // The pinned app hash-signs personal messages behind "Blind signing" (sign_personal_message.c).
    const config = await call(async () => tronConfiguration(exchange));
    if (!config.signByHash) {
      throw blind();
    }
    return call(async () => tronSignPersonalMessage(exchange, task.path, request.message));
  }
  if (request.kind === "tron.typed-data" && stage.kind === "tron.typed-data") {
    const { json } = parseTronTypedData(request.typedData);
    const { domain, message } = tronTypedDataHashes(json);
    expectDigest(keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domain, message)), task);
    const config = await call(async () => tronConfiguration(exchange));
    if (!config.signByHash) {
      throw blind();
    }
    return call(async () => tronSignTypedDataHash(exchange, task.path, domain, message));
  }
  return integrity();
};

const solana = async (
  exchange: Exchange,
  request: Extract<ChainSignRequest, { kind: `solana.${string}` }>,
  stage: Extract<ChainPlan, { kind: `solana.${string}` }>,
): Promise<Uint8Array> => {
  await requiredApp(exchange, "solana");
  const [task] = stage.tasks;
  if (!equalBytes(request.message, task.message)) {
    integrity();
  }
  if (request.kind === "solana.transaction") {
    if (!solanaClears(request.message)) {
      const config = await call(async () => solanaConfiguration(exchange));
      if (!config.blindSigning) {
        throw blind();
      }
    }
    return call(async () => solanaSignTransaction(exchange, task.path, request.message));
  }
  // `solana.message` — display required the formal v0 off-chain document.
  const offchain = solanaOffchain(request.message);
  if (offchain === undefined) {
    integrity();
  }
  if (offchain === "utf8") {
    const config = await call(async () => solanaConfiguration(exchange));
    if (!config.blindSigning) {
      throw blind();
    }
  }
  return call(async () => solanaSignOffchainMessage(exchange, task.path, request.message));
};

const bitcoinPsbt = async (
  exchange: Exchange,
  context: SignContext,
  request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }>,
  stage: Extract<ChainPlan, { kind: "bitcoin.psbt" }>,
): Promise<ReadonlyArray<Uint8Array>> => {
  await requiredApp(exchange, "bitcoin");
  const templates = new Set(request.sign.map((s) => s.template));
  if (templates.size !== 1) {
    integrity(); // display refused a mixed-template request before the prompt
  }
  const [template] = templates;
  const [firstTask] = stage.tasks;
  if (template === undefined || firstTask === undefined) {
    integrity();
  }
  const account = firstTask.path.slice(0, 3);
  const net = bitcoinNetwork(request.network);
  const xpub = await pinnedMaterial(context.pin).extendedPublicKey(account, net.bip32);
  const policy = defaultPolicy(template, context.pin.fingerprint, account, xpub);
  const yielded = await call(async () => btcSignPsbt(exchange, stage.psbt, policy));
  return stage.tasks.map((task, index) => {
    const planned = stage.inputs[index];
    if (planned === undefined) {
      return integrity();
    }
    const hit = yielded.find((y) => y.input === planned.index);
    if (hit === undefined) {
      return integrity();
    }
    if (task.scheme === "bip340") {
      if (!equalBytes(hit.publicKey, task.publicKey)) {
        return integrity();
      }
      const { signature } = hit;
      if (signature.length !== (planned.sighash === 0 ? 64 : 65)) {
        return integrity();
      }
      if (signature.length === 65 && signature[64] !== planned.sighash) {
        return integrity();
      }
      return signature.subarray(0, 64);
    }
    if (!equalBytes(hit.publicKey, task.publicKey)) {
      return integrity();
    }
    const der = hit.signature;
    if (der.at(-1) !== planned.sighash) {
      return integrity();
    }
    // The protocol layer already parsed `der.subarray(0, -1)` as DER when yielding it.
    return secp256k1.Signature.fromBytes(der.subarray(0, -1), "der").toBytes();
  });
};

const bitcoinMessage = async (
  exchange: Exchange,
  request: Extract<ChainSignRequest, { kind: "bitcoin.message" }>,
  stage: Extract<ChainPlan, { kind: "bitcoin.message" }>,
): Promise<Uint8Array> => {
  await requiredApp(exchange, "bitcoin");
  const [task] = stage.tasks;
  if (
    request.format !== "legacy" ||
    stage.format !== "legacy" ||
    task.scheme !== "ecdsa-secp256k1"
  ) {
    integrity();
  }
  expectDigest(legacyMessageHash(request.message), task);
  const signed = await call(async () =>
    btcSignMessage(exchange, task.path, utf8ToBytes(request.message)),
  );
  return signed.signature;
};

export const sign = async (
  link: DeviceLink,
  context: SignContext,
): Promise<ReadonlyArray<Uint8Array>> => {
  const { request, stage } = context;
  const exchange = apduExchange(link);
  if (
    stage.kind === "evm.transaction" ||
    stage.kind === "evm.personal-message" ||
    stage.kind === "evm.fiat24-session" ||
    stage.kind === "evm.typed-data"
  ) {
    if (request.kind !== stage.kind) {
      return integrity();
    }
    return [await evm(exchange, request, stage)];
  }
  if (
    stage.kind === "tron.transaction" ||
    stage.kind === "tron.message" ||
    stage.kind === "tron.typed-data"
  ) {
    if (request.kind !== stage.kind) {
      return integrity();
    }
    return [await tron(exchange, request, stage)];
  }
  if (stage.kind === "solana.transaction" || stage.kind === "solana.message") {
    if (request.kind !== "solana.transaction" && request.kind !== "solana.message") {
      return integrity();
    }
    return [await solana(exchange, request, stage)];
  }
  if (stage.kind === "bitcoin.psbt") {
    if (request.kind !== "bitcoin.psbt") {
      return integrity();
    }
    return bitcoinPsbt(exchange, context, request, stage);
  }
  if (stage.kind === "bitcoin.message") {
    if (request.kind !== "bitcoin.message") {
      return integrity();
    }
    return [await bitcoinMessage(exchange, request, stage)];
  }
  return integrity();
};
