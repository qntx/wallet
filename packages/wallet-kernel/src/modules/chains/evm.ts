/** EVM signing for `chain.sign` — derive, normalize, decode, then sign or return the intent. */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";

import type { DisplayIntent } from "@qntx/wallet-chains";
import {
  decodeEvm,
  evmAddressFromPublicKey,
  fiat24SessionMessage,
  networkChainId,
  normalizeEvm,
} from "@qntx/wallet-chains/evm";
import {
  signEvmPersonalMessage,
  signEvmTransaction,
  signEvmTypedData,
} from "@qntx/wallet-chains/evm/sign";

import { KernelError } from "../../errors.ts";
import type { EvmKeySource, EvmRequest, ExecuteResult } from "./shared.ts";
import { deepEqual, mapChainError } from "./shared.ts";

/* A Fiat24 session grant signs only with time left: the API's twenty-minute window minus slack,
   and never an already-past deadline. `now` is the kernel wall clock in milliseconds; the check
   runs on every pass so a prompt that outlives the window is refused on the sign pass too. */
const FIAT24_SESSION_WINDOW = 1200;

const assertFiat24Deadline = (request: EvmRequest, now: number): void => {
  if (request.kind !== "evm.fiat24-session") {
    return;
  }
  const left = request.deadline - Math.floor(now / 1000);
  if (!(left > 0 && left <= FIAT24_SESSION_WINDOW)) {
    throw new KernelError("invalid-input", "fiat24 session deadline out of range");
  }
};

export const executeEvm = (
  request: EvmRequest,
  source: EvmKeySource,
  intentOnly: boolean,
  now: number,
): ExecuteResult => {
  assertFiat24Deadline(request, now);
  if (source.kind === "imported") {
    /* The record's plaintext is the private key; `chainSign` wipes the opened copy. */
    const priv = source.secret;
    const signer = evmAddressFromPublicKey(secp256k1.getPublicKey(priv, true));
    return evmBody(request, priv, signer, intentOnly);
  }
  const master = HDKey.fromMasterSeed(source.seed);
  try {
    const child = master.derive(`m/44'/60'/0'/0/${source.account.groupIndex}`);
    try {
      const priv = child.privateKey;
      const pub = child.publicKey;
      if (priv === null || pub === null) {
        throw new KernelError("integrity", "no private key at account path");
      }
      const signer = evmAddressFromPublicKey(pub);
      return evmBody(request, priv, signer, intentOnly);
    } finally {
      child.wipePrivateData();
    }
  } finally {
    master.wipePrivateData();
  }
};

const evmBody = (
  request: EvmRequest,
  priv: Uint8Array,
  signer: string,
  intentOnly: boolean,
): ExecuteResult => {
  let normalized;
  try {
    normalized = normalizeEvm(request);
  } catch (error) {
    mapChainError(error);
  }
  if (!deepEqual(normalized, request)) {
    throw new KernelError("invalid-input", "request is not normalized");
  }
  let intent: DisplayIntent;
  try {
    intent = decodeEvm(request, signer);
  } catch (error) {
    mapChainError(error);
  }
  if (intentOnly) {
    return { prompt: intent, signer };
  }
  if (request.kind === "evm.transaction") {
    return {
      kind: "evm.transaction",
      signedTransaction: signEvmTransaction(request.tx, priv),
    };
  }
  if (request.kind === "evm.personal-message") {
    return {
      kind: "evm.personal-message",
      signature: signEvmPersonalMessage(request.message, priv),
    };
  }
  if (request.kind === "evm.fiat24-session") {
    return {
      kind: "evm.fiat24-session",
      signature: signEvmPersonalMessage(
        utf8ToBytes(
          fiat24SessionMessage(networkChainId(request.network), request.tokenId, request.deadline),
        ),
        priv,
      ),
    };
  }
  return {
    kind: "evm.typed-data",
    signature: signEvmTypedData(request.typedData, priv),
  };
};
