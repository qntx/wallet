/**
 * Signing: `sign` proves the answering device holds the pinned material above the first task's path
 * (the account node re-fetched byte-for-byte, or the pinned ed25519 leaf key), refuses the exchange
 * when the live Features can no longer show the confirmed request, and dispatches each stage to its
 * family signer. `dispatch` returns one 64-byte r‖s per task, in order — the assembler re-derives
 * recovery bits; stage/request kind agreement is asserted per case: a mismatch is a kernel
 * inconsistency, never a device question.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import type { KeyPath } from "@qntx/wallet-chains";
import { fiat24SessionMessage, networkChainId } from "@qntx/wallet-chains/evm";

import { samePath } from "../../../derive/pinned.ts";
import { KernelError } from "../../../errors.ts";
import type { Driver, HardwarePin, SignContext } from "../driver.ts";
import { btcCoinName, psbtEntries, SCRIPT_TYPE } from "./bitcoin.ts";
import { displayFor } from "./display.ts";
import { integrity, kernelError, wrongDevice } from "./errors.ts";
import { exchangeOf } from "./link.ts";
import { ancestorOf } from "./pair.ts";
import {
  bitcoinPrepare,
  initialize,
  publicNode,
  signBitcoinMessage,
  signBitcoinTransaction,
  signEvmPersonalMessage,
  signEvmTransaction,
  signSolanaRawMessage,
  signSolanaTransaction,
  signTronMessage,
  signTronTransaction,
  signTypedData,
  solanaPublicKey,
} from "./protocol/index.ts";
import type { DeviceInfo, Exchange } from "./protocol/index.ts";

/**
 * Proof the answering device holds the pinned material: the account node above `path` must come
 * back byte-identical (`wrong-device` otherwise). A path no pinned node prefixes is a kernel
 * inconsistency — `prepare` could not have derived from the pin.
 */
const checkSecp256k1 = async (
  exchange: Exchange,
  pin: HardwarePin,
  path: KeyPath,
): Promise<void> => {
  const ancestor = ancestorOf(pin, path);
  if (ancestor === undefined) {
    integrity("no pinned account node covers the signing path");
  }
  const node = await publicNode(exchange, ancestor.path);
  if (
    !equalBytes(node.publicKey, ancestor.publicKey) ||
    !equalBytes(node.chainCode, ancestor.chainCode)
  ) {
    wrongDevice();
  }
};

const checkEd25519 = async (exchange: Exchange, pin: HardwarePin, path: KeyPath): Promise<void> => {
  const key = pin.ed25519.find((k) => samePath(k.path, path));
  if (key === undefined) {
    integrity("no pinned ed25519 key covers the signing path");
  }
  if (!equalBytes(await solanaPublicKey(exchange, path, false), key.publicKey)) {
    wrongDevice();
  }
};

/** The plan's stored stage-1 authorization: 65-byte r‖s‖v with v = 27 + yParity. */
const yParityOf = (authorization: Uint8Array): 0 | 1 => {
  const v = authorization.at(-1);
  if (authorization.length !== 65 || (v !== 27 && v !== 28)) {
    integrity("the planned authorization signature is not 65-byte r‖s‖v");
  }
  return v === 27 ? 0 : 1;
};

// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
const dispatch = async (
  exchange: Exchange,
  info: DeviceInfo,
  context: SignContext,
): Promise<ReadonlyArray<Uint8Array>> => {
  const { request, stage } = context;
  const [task] = stage.tasks;
  switch (stage.kind) {
    case "evm.transaction": {
      if (request.kind !== "evm.transaction" || task === undefined) {
        integrity("the request is not an evm transaction");
      }
      if (request.tx.type === "eip7702" && stage.authorization === undefined) {
        // Stage 1: the device signs authorization and transaction; only the authorization
        // signature answers the stage task.
        const { authorization } = await signEvmTransaction(exchange, info, task.path, request.tx);
        if (authorization === undefined) {
          integrity("the device signed no authorization");
        }
        return [concatBytes(authorization.r, authorization.s)];
      }
      const options =
        stage.authorization === undefined
          ? undefined
          : {
              authorization: {
                yParity: yParityOf(stage.authorization),
                r: stage.authorization.subarray(0, 32),
                s: stage.authorization.subarray(32, 64),
              },
            };
      const { signature } = await signEvmTransaction(
        exchange,
        info,
        task.path,
        request.tx,
        options,
      );
      return [signature];
    }
    case "evm.personal-message":
    case "evm.fiat24-session": {
      if (request.kind !== stage.kind || task === undefined) {
        integrity("the request and stage kinds disagree");
      }
      const message =
        request.kind === "evm.fiat24-session"
          ? utf8ToBytes(
              fiat24SessionMessage(
                networkChainId(request.network),
                request.tokenId,
                request.deadline,
              ),
            )
          : request.message;
      return [
        await signEvmPersonalMessage(
          exchange,
          task.path,
          message,
          BigInt(networkChainId(request.network)),
        ),
      ];
    }
    case "evm.typed-data":
      if (request.kind !== "evm.typed-data" || task === undefined) {
        integrity("the request is not evm typed data");
      }
      return [
        await signTypedData(
          exchange,
          info,
          task.path,
          request.typedData,
          BigInt(networkChainId(request.network)),
        ),
      ];

    case "solana.transaction":
      if (request.kind !== "solana.transaction" || task === undefined) {
        integrity("the request is not a solana transaction");
      }
      return [await signSolanaTransaction(exchange, task.path, request.message, task.publicKey)];

    case "solana.message":
      if (request.kind !== "solana.message" || task === undefined) {
        integrity("the request is not a solana message");
      }
      return [await signSolanaRawMessage(exchange, task.path, request.message)];

    case "tron.transaction":
      if (request.kind !== "tron.transaction" || task === undefined) {
        integrity("the request is not a tron transaction");
      }
      return [await signTronTransaction(exchange, task.path, request.rawData, task.publicKey)];

    case "tron.message":
      if (request.kind !== "tron.message" || task === undefined) {
        integrity("the request is not a tron message");
      }
      return [await signTronMessage(exchange, info, task.path, request.message)];

    case "bitcoin.psbt": {
      if (request.kind !== "bitcoin.psbt") {
        integrity("the request is not a bitcoin psbt");
      }
      const prepared = bitcoinPrepare(
        request.psbt,
        psbtEntries(request, stage),
        btcCoinName(request.network),
        // No change is declared: the device shows every output.
        [],
      );
      return signBitcoinTransaction(exchange, info, prepared);
    }
    case "bitcoin.message": {
      if (
        request.kind !== "bitcoin.message" ||
        request.format !== stage.format ||
        task === undefined
      ) {
        integrity("the request is not a matching bitcoin message");
      }
      const scriptType =
        request.account.kind === "hd" ? SCRIPT_TYPE[request.account.template] : undefined;
      if (scriptType === undefined) {
        integrity("a hardware bitcoin message signs under an hd account template");
      }
      return [
        await signBitcoinMessage(exchange, info, task.path, utf8ToBytes(request.message), {
          format: request.format,
          scriptType,
          network: btcCoinName(request.network),
        }),
      ];
    }
    default:
      // tron.typed-data and any future kind display refused — reaching one is a kernel bug.
      integrity("the stage kind cannot be signed");
  }
};

export const sign: Driver["sign"] = async (link, context) => {
  const exchange = exchangeOf(link);
  try {
    const info = await initialize(exchange);
    // Identity: the account material above the first task's path must re-derive identically.
    const [task] = context.stage.tasks;
    if (task === undefined) {
      integrity("the stage carries no signing task");
    }
    const check = task.scheme === "ed25519" ? checkEd25519 : checkSecp256k1;
    await check(exchange, context.pin, task.path);
    // The live Features must still show what the prompt promised — firmware that can no longer
    // display the confirmed request is refused before any signing exchange.
    const live = displayFor(context.request, context.stage, info);
    if (live !== context.display) {
      throw new KernelError("unsupported", "the device can no longer show the confirmed request");
    }
    return await dispatch(exchange, info, context);
  } catch (error) {
    throw kernelError(error);
  }
};
