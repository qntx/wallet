/**
 * /evm/plan — the serialisable signing plan of a normalized request: the digests each signing
 * backend must sign, and the transaction an EIP-7702 signature later re-enters. No key material.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import * as Authorization from "ox/Authorization";
import * as Hex from "ox/Hex";
import * as PersonalMessage from "ox/PersonalMessage";
import * as TypedData from "ox/TypedData";

import { ChainError } from "../index.ts";
import type { EcdsaTask, EvmTransaction, SignRequest, TaskKey } from "../index.ts";
import { evmAuthorization, evmEnvelope } from "./envelope.ts";
import { fiat24SessionMessage } from "./fiat24.ts";
import { networkChainId } from "./transaction.ts";
import { parseTypedData } from "./typed-data.ts";

/**
 * `authorization` is the 65-byte `r‖s‖v` of the stage-1 signature; it is present only on the
 * second-stage plan `assembleEvm` returns for an `eip7702` transaction.
 */
export type EvmSignPlan =
  | {
      readonly kind: "evm.transaction";
      readonly tx: EvmTransaction;
      readonly authorization?: Uint8Array;
      readonly tasks: readonly [EcdsaTask];
    }
  | {
      readonly kind: "evm.personal-message" | "evm.fiat24-session" | "evm.typed-data";
      readonly tasks: readonly [EcdsaTask];
    };

const ecdsa = (digest: Uint8Array, key: TaskKey): EcdsaTask => ({
  scheme: "ecdsa-secp256k1",
  path: key.path,
  publicKey: key.publicKey,
  digest,
});

const personalDigest = (message: Uint8Array): Uint8Array =>
  Hex.toBytes(PersonalMessage.getSignPayload(Hex.fromBytes(message)));

/**
 * The transaction plan. For `eip7702` the task covers the authorization digest; `assembleEvm`
 * then returns a stage-2 plan whose task is the envelope digest of the authorized transaction.
 */
export const planEvmTransaction = (tx: EvmTransaction, key: TaskKey): EvmSignPlan => ({
  kind: "evm.transaction",
  tx,
  tasks: [
    ecdsa(
      Hex.toBytes(
        tx.type === "eip7702"
          ? Authorization.getSignPayload(evmAuthorization(tx))
          : evmEnvelope(tx).payload,
      ),
      key,
    ),
  ],
});

export const planEvmPersonalMessage = (message: Uint8Array, key: TaskKey): EvmSignPlan => ({
  kind: "evm.personal-message",
  tasks: [ecdsa(personalDigest(message), key)],
});

export const planEvmTypedData = (typedData: string, key: TaskKey): EvmSignPlan => {
  const { json } = parseTypedData(typedData);
  let payload: Hex.Hex;
  try {
    payload = TypedData.getSignPayload(json);
  } catch {
    throw new ChainError("invalid-typed-data", "typedData failed to encode");
  }
  return { kind: "evm.typed-data", tasks: [ecdsa(Hex.toBytes(payload), key)] };
};

/** The plan of a normalized request; the task keeps the request kind so the kernel can wrap it. */
export const planEvm = (
  request: Extract<
    SignRequest,
    { kind: "evm.transaction" | "evm.personal-message" | "evm.fiat24-session" | "evm.typed-data" }
  >,
  key: TaskKey,
): EvmSignPlan => {
  if (request.kind === "evm.transaction") {
    return planEvmTransaction(request.tx, key);
  }
  if (request.kind === "evm.personal-message") {
    return planEvmPersonalMessage(request.message, key);
  }
  if (request.kind === "evm.fiat24-session") {
    return {
      kind: "evm.fiat24-session",
      tasks: [
        ecdsa(
          personalDigest(
            utf8ToBytes(
              fiat24SessionMessage(
                networkChainId(request.network),
                request.tokenId,
                request.deadline,
              ),
            ),
          ),
          key,
        ),
      ],
    };
  }
  return planEvmTypedData(request.typedData, key);
};
