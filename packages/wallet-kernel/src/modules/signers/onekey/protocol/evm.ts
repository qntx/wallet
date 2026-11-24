/**
 * EVM signing over the OneKey V1 schema: legacy and EIP-1559/7702 transactions with data chunking
 * and personal messages. Message mapping mirrors the SDK's `api/evm/latest/signTransaction.ts`
 * (minimal big-endian integer fields, first ≤1024-byte chunk in the sign message, `dataLength`
 * rounds answered with `EthereumTxAckOneKey`); EIP-712 lives in evm-typed-data.ts.
 */
import { hexToBytes } from "@noble/hashes/utils.js";

import type { EvmTransaction } from "@qntx/wallet-chains";

import { supports } from "./device.ts";
import type { DeviceInfo } from "./device.ts";
import { OneKeyError } from "./errors.ts";
import { typedDataMode } from "./evm-typed-data.ts";
import {
  EthereumMessageSignatureOneKey,
  EthereumSignMessageOneKey,
  EthereumSignTxEIP1559OneKey,
  EthereumSignTxEIP7702OneKey,
  EthereumSignTxOneKey,
  EthereumTxAckOneKey,
  EthereumTxRequestOneKey,
} from "./messages.ts";
import type { EthereumTxRequestOneKeyFields } from "./messages.ts";
import type { Decoded } from "./proto.ts";
import { call } from "./session.ts";
import type { Exchange } from "./session.ts";

const fault = (message: string): OneKeyError => new OneKeyError("device-fault", message);
const invalid = (message: string): OneKeyError => new OneKeyError("invalid-input", message);
const unsupported = (message: string): OneKeyError => new OneKeyError("unsupported", message);

const UINT32_MAX = 0xff_ff_ff_ff;
const CHUNK = 1024;

// Failure_DataError (common/protob/messages-common.proto FailureType = 3): the firmware refuses
// an unregistered EIP-7702 delegator with it (sign_tx_eip7702.py validate_delegate,
// ethereum_onekey.c "Unregistered delegator").
const FAILURE_DATA_ERROR = 3;

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

/** The minimal big-endian byte string of a non-negative integer; zero encodes empty. */
function minimalBytes(value: bigint): Uint8Array {
  if (value < 0n) {
    throw invalid("negative quantity");
  }
  if (value === 0n) {
    return new Uint8Array(0);
  }
  const out: number[] = [];
  for (let v = value; v > 0n; v /= 256n) {
    out.push(Number(v % 256n));
  }
  return new Uint8Array(out.reverse());
}

const quantity = (hex: string): Uint8Array => minimalBytes(BigInt(hex));

const hexBytes = (hex: string): Uint8Array => {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  try {
    return hexToBytes(body);
  } catch {
    throw invalid("malformed hex data");
  }
};

type TxRequest = Decoded<EthereumTxRequestOneKeyFields>;

/** One EIP-7702 authorization signature as the wire record carries it (yParity ‖ r ‖ s). */
export type EvmAuthorizationSignature = {
  readonly yParity: 0 | 1;
  readonly r: Uint8Array;
  readonly s: Uint8Array;
};

/**
 * Drives the TxRequest/TxAck loop after the sign message is sent: each dataLength request must ask
 * for 1..min(remaining, 1024) bytes (the schema caps chunks at 1024), and a signature may only
 * arrive when nothing is left to send. `r`/`s` are exactly 32 bytes; an `eip7702` response must
 * carry exactly one authorization signature, others must carry none.
 */
async function finishTransaction(
  exchange: Exchange,
  request: TxRequest,
  data: Uint8Array,
  sent: number,
  expectAuthorization: boolean,
): Promise<{ signature: Uint8Array; authorization?: EvmAuthorizationSignature }> {
  const want = request.dataLength;
  if (want === undefined || want === 0) {
    if (sent < data.length) {
      throw fault("device signed before consuming the payload");
    }
    const { signatureV, signatureR, signatureS } = request;
    if (signatureV === undefined || signatureR === undefined || signatureS === undefined) {
      throw fault("signature fields missing from the transaction request");
    }
    if (signatureR.length !== 32 || signatureS.length !== 32) {
      throw fault("signature r/s are not 32 bytes");
    }
    const signatures = request.authorizationSignatures ?? [];
    if (expectAuthorization) {
      if (signatures.length !== 1) {
        throw fault("expected exactly one authorization signature");
      }
      const [auth] = signatures;
      if (auth === undefined) {
        throw fault("expected exactly one authorization signature");
      }
      if (auth.yParity !== 0 && auth.yParity !== 1) {
        throw fault("authorization yParity is not 0 or 1");
      }
      if (auth.r.length !== 32 || auth.s.length !== 32) {
        throw fault("authorization r/s are not 32 bytes");
      }
      return {
        signature: concat(signatureR, signatureS),
        authorization: { yParity: auth.yParity, r: auth.r, s: auth.s },
      };
    }
    if (signatures.length > 0) {
      throw fault("unexpected authorization signatures");
    }
    return { signature: concat(signatureR, signatureS) };
  }
  const remaining = data.length - sent;
  if (want > remaining || want > CHUNK) {
    throw fault("device requested more payload than remains");
  }
  const next = await call(
    exchange,
    { def: EthereumTxAckOneKey, value: { dataChunk: data.subarray(sent, sent + want) } },
    EthereumTxRequestOneKey,
  );
  return finishTransaction(exchange, next, data, sent + want, expectAuthorization);
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export type EvmTransactionOptions = {
  /**
   * Stage-2 call of a two-stage EIP-7702 plan: the stage-1 authorization signature to embed in the
   * authorization tuple — feed the previous call's `authorization` result straight back. Both
   * firmwares skip re-signing and echo it back (sign_tx_eip7702.py sign_authorization,
   * ethereum_onekey.c sign_authorization_list).
   */
  readonly authorization?: EvmAuthorizationSignature;
};

/**
 * Signs an EVM transaction. eip2930 has no OneKey message and is `unsupported` before any exchange;
 * eip7702 needs `evm-7702` and an unregistered delegator refusal (Failure_DataError) maps to
 * `unsupported` as well.
 */
// oxlint-disable-next-line typescript/consistent-return -- every transaction kind returns above
export async function signEvmTransaction(
  exchange: Exchange,
  info: DeviceInfo,
  path: ReadonlyArray<number>,
  tx: EvmTransaction,
  options?: EvmTransactionOptions,
): Promise<{ signature: Uint8Array; authorization?: EvmAuthorizationSignature }> {
  checkPath(path);
  const data = hexBytes(tx.data);
  const initialChunk = data.subarray(0, CHUNK);
  try {
    switch (tx.type) {
      case "legacy": {
        const value = {
          addressN: [...path],
          nonce: minimalBytes(BigInt(tx.nonce)),
          gasPrice: quantity(tx.gasPrice),
          gasLimit: quantity(tx.gas),
          ...(tx.to === undefined ? {} : { to: tx.to }),
          value: quantity(tx.value),
          chainId: BigInt(tx.chainId),
          ...(data.length === 0 ? {} : { dataInitialChunk: initialChunk, dataLength: data.length }),
        };
        const first = await call(
          exchange,
          { def: EthereumSignTxOneKey, value },
          EthereumTxRequestOneKey,
        );
        return await finishTransaction(
          exchange,
          first,
          data.subarray(initialChunk.length),
          0,
          false,
        );
      }
      case "eip2930":
        throw unsupported("eip2930 transactions have no OneKey message");
      case "eip1559": {
        const value = {
          addressN: [...path],
          nonce: minimalBytes(BigInt(tx.nonce)),
          maxGasFee: quantity(tx.maxFeePerGas),
          maxPriorityFee: quantity(tx.maxPriorityFeePerGas),
          gasLimit: quantity(tx.gas),
          ...(tx.to === undefined ? {} : { to: tx.to }),
          value: quantity(tx.value),
          dataInitialChunk: initialChunk,
          dataLength: data.length,
          chainId: BigInt(tx.chainId),
          accessList: tx.accessList.map((entry) => ({
            address: entry.address,
            storageKeys: entry.storageKeys.map(hexBytes),
          })),
        };
        const first = await call(
          exchange,
          { def: EthereumSignTxEIP1559OneKey, value },
          EthereumTxRequestOneKey,
        );
        return await finishTransaction(
          exchange,
          first,
          data.subarray(initialChunk.length),
          0,
          false,
        );
      }
      case "eip7702": {
        if (!supports(info, "evm-7702")) {
          throw unsupported("device firmware does not sign eip7702 transactions");
        }
        const supplied = options?.authorization;
        if (
          supplied !== undefined &&
          ((supplied.yParity !== 0 && supplied.yParity !== 1) ||
            supplied.r.length !== 32 ||
            supplied.s.length !== 32)
        ) {
          throw invalid("authorization signature must be { yParity: 0|1, r: 32B, s: 32B }");
        }
        const value = {
          addressN: [...path],
          nonce: minimalBytes(BigInt(tx.nonce)),
          maxGasFee: quantity(tx.maxFeePerGas),
          maxPriorityFee: quantity(tx.maxPriorityFeePerGas),
          gasLimit: quantity(tx.gas),
          to: tx.to,
          value: quantity(tx.value),
          dataInitialChunk: initialChunk,
          dataLength: data.length,
          chainId: BigInt(tx.chainId),
          accessList: tx.accessList.map((entry) => ({
            address: entry.address,
            storageKeys: entry.storageKeys.map(hexBytes),
          })),
          // The self-sponsored authorization the plan models: same path, the transaction's
          // chain id, nonce + 1; stage 2 supplies the stage-1 signature — both firmwares
          // refuse an item carrying address_n AND signature (sign_tx_eip7702.py
          // check_common_fields, ethereum_onekey.c ethereum_check_authorization_list).
          authorizationList: [
            {
              ...(supplied === undefined ? { addressN: [...path] } : {}),
              chainId: BigInt(tx.chainId),
              address: tx.authorization.address,
              nonce: minimalBytes(BigInt(tx.nonce) + 1n),
              ...(supplied === undefined ? {} : { signature: supplied }),
            },
          ],
        };
        const first = await call(
          exchange,
          { def: EthereumSignTxEIP7702OneKey, value },
          EthereumTxRequestOneKey,
        );
        return await finishTransaction(
          exchange,
          first,
          data.subarray(initialChunk.length),
          0,
          true,
        );
      }
    }
  } catch (error) {
    if (
      tx.type === "eip7702" &&
      error instanceof OneKeyError &&
      error.code === "device-error" &&
      error.failure === FAILURE_DATA_ERROR
    ) {
      throw unsupported("device refused the delegation");
    }
    throw error;
  }
}

/**
 * EIP-191 personal_sign. The device's 65-byte answer is r‖s‖v (`signature[1:] + signature[0:1]` in
 * sign_message.py); only r‖s returns — assemble recomputes the recovery id.
 */
export async function signEvmPersonalMessage(
  exchange: Exchange,
  path: ReadonlyArray<number>,
  message: Uint8Array,
  chainId?: bigint,
): Promise<Uint8Array> {
  checkPath(path);
  const response = await call(
    exchange,
    {
      def: EthereumSignMessageOneKey,
      value: {
        addressN: [...path],
        message,
        ...(chainId === undefined ? {} : { chainId }),
      },
    },
    EthereumMessageSignatureOneKey,
  );
  const { signature } = response;
  if (signature.length !== 65) {
    throw fault("personal-message signature is not 65 bytes");
  }
  return new Uint8Array(signature.subarray(0, 64));
}

export type EvmDisplayRequest =
  | { readonly kind: "evm.transaction"; readonly tx: EvmTransaction }
  | { readonly kind: "evm.personal-message" }
  | { readonly kind: "evm.typed-data"; readonly typedData: string };

// The ERC-20 selectors both firmwares special-case (Pro sign_tx.py handle_approve,
// Classic 1S ethereum_onekey.c is_erc20_approve): approve 0x095ea7b3 and
// increaseAllowance 0x39509351 — each renders spender, amount and the token contract even for
// unregistered tokens (Pro: ApproveInfo regardless of token lookup; Classic: the approve overview
// pages include the token-address screen). A plain `transfer` 0xa9059cbb stays blind: for
// unregistered tokens Classic's token page shows no contract screen (layout2.c only draws
// I__TOKEN_CONTRACT_COLON for NFT transfers) and Pro falls back to raw calldata.
const APPROVE_SELECTORS = new Set(["095ea7b3", "39509351"]);

/**
 * "clear" when the device renders the request's semantics, "blind" when it signs a digest or raw
 * bytes the user cannot fully verify on screen.
 */
// oxlint-disable-next-line typescript/consistent-return -- every request kind returns above
export function evmDisplay(
  info: DeviceInfo,
  request: EvmDisplayRequest,
): "clear" | "blind" | "unsupported" {
  switch (request.kind) {
    case "evm.personal-message":
      return "clear";
    case "evm.typed-data":
      return typedDataMode(info, request.typedData) === "stream" ? "clear" : "blind";
    case "evm.transaction": {
      const { tx } = request;
      if (tx.type === "eip2930") {
        return "unsupported";
      }
      if (tx.type === "eip7702") {
        // The device names a registered delegator and its delegation target on screen and
        // refuses anything else with Failure_DataError (mapped to `unsupported`), so the
        // delegation the user sees is always the one being signed.
        return supports(info, "evm-7702") ? "clear" : "unsupported";
      }
      const data = tx.data.startsWith("0x") ? tx.data.slice(2) : tx.data;
      if (data.length === 0) {
        return "clear";
      }
      if (data.length === 136 && APPROVE_SELECTORS.has(data.slice(0, 8))) {
        return "clear";
      }
      return "blind";
    }
  }
}
