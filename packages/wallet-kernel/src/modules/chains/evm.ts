/** EVM signing for `chain.sign` — derive, normalize, decode, then sign or return the intent. */
import { HDKey } from "@scure/bip32";

import type { DisplayIntent } from "@qntx/wallet-chains";
import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";
import {
  signEvmPersonalMessage,
  signEvmTransaction,
  signEvmTypedData,
} from "@qntx/wallet-chains/evm/sign";

import { KernelError } from "../../errors.ts";
import type { EvmRequest, ExecuteResult, HdAccount } from "./shared.ts";
import { deepEqual, mapChainError } from "./shared.ts";

export const executeEvm = (
  request: EvmRequest,
  account: HdAccount,
  seed: Uint8Array,
  intentOnly: boolean,
): ExecuteResult => {
  const master = HDKey.fromMasterSeed(seed);
  try {
    const child = master.derive(`m/44'/60'/0'/0/${account.groupIndex}`);
    try {
      const priv = child.privateKey;
      if (priv === null) {
        throw new KernelError("integrity", "no private key at account path");
      }
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
        intent = decodeEvm(request);
      } catch (error) {
        mapChainError(error);
      }
      if (intentOnly) {
        return { prompt: intent };
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
      return {
        kind: "evm.typed-data",
        signature: signEvmTypedData(request.typedData, priv),
      };
    } finally {
      child.wipePrivateData();
    }
  } finally {
    master.wipePrivateData();
  }
};
