/**
 * `qrResponse` — a verified `chain.sign` result as the UR signature the watching wallet expects.
 * Before anything is encoded the result is re-verified against the request's own bytes (recovered
 * signer for EVM/TRON, ed25519 verify for Solana, unchanged-PSBT-plus-new-signature for Bitcoin),
 * so a wrong result ends in `result-mismatch` and produces no payload.
 */
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { parseTransaction } from "viem";

import { ethSignatureCodec, solSignatureCodec, tronSignatureCodec } from "@qntx/ur/interop";
import { cryptoPsbtCodec, psbtCodec } from "@qntx/ur/registry";
import { toUr } from "@qntx/ur/typed";
import type { UrCodec } from "@qntx/ur/typed";
import type { EvmTransaction, SignRequest } from "@qntx/wallet-chains";
import { samePsbtContent } from "@qntx/wallet-chains/bitcoin";
import { recoverEvmSigner } from "@qntx/wallet-chains/evm";
import { verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { recoverTronMessageSigner, recoverTronTransactionSigner } from "@qntx/wallet-chains/tron";
import type { QrPayload } from "@qntx/wallet/hardware";
import type { ChainSignResult } from "@qntx/wallet/protocol";

import { qrGuard, resultMismatch as mismatch } from "./errors.ts";
import type { QrRequest } from "./request.ts";

/** The account the response claims — the request's address is untrusted, the caller's is not. */
export type QrSigner = { readonly address: string };

const encode = <T>(type: string, value: T, codec: UrCodec<T>): QrPayload =>
  qrGuard("result-mismatch", () => ({
    type,
    cbor: toUr(value, codec).toCborData(),
  }));

const fixed32 = (value: `0x${string}` | undefined): Uint8Array => {
  const bytes = hexToBytes((value ?? "0x").slice(2).padStart(64, "0"));
  if (bytes.length !== 32) {
    mismatch("signature component is not 32 bytes");
  }
  return bytes;
};

/** Big-endian, leading-zero-free — the minimal `v` Keystone firmware writes for legacy txs. */
const minimalInt = (value: number): Uint8Array => {
  const hex = value.toString(16);
  return hexToBytes(hex.length % 2 === 0 ? hex : `0${hex}`);
};

/** The evm fields a probe reads — both `QrRequest` and the counterpart's `QrSignInput` fit. */
export type EvmProbeInput =
  | { readonly kind: "transaction"; readonly tx: EvmTransaction; readonly chainId?: number }
  | { readonly kind: "typed-data"; readonly typedData: string; readonly chainId?: number }
  | { readonly kind: "personal-message"; readonly message: Uint8Array; readonly chainId?: number };

/** A `chain.sign`-shaped request for `recoverEvmSigner`; account/network fields are unused there. */
export const evmProbe = (request: EvmProbeInput): SignRequest => {
  const chainId = request.kind === "transaction" ? request.tx.chainId : request.chainId;
  const network = `eip155:${chainId ?? 1}`;
  const account = { kind: "hd" as const, walletId: "", groupIndex: 0, template: "evm.bip44" };
  if (request.kind === "transaction") {
    return { kind: "evm.transaction", network, account, tx: request.tx };
  }
  if (request.kind === "typed-data") {
    return { kind: "evm.typed-data", network, account, typedData: request.typedData };
  }
  return { kind: "evm.personal-message", network, account, message: request.message };
};

const evmResponse = (request: QrRequest, result: ChainSignResult, signer: QrSigner): QrPayload => {
  if (request.family !== "evm") {
    mismatch("not an evm request");
  }
  let signature: Uint8Array;
  if (request.kind === "transaction") {
    if (result.kind !== "evm.transaction") {
      mismatch("expected an evm.transaction result");
    }
    const parsed = qrGuard("result-mismatch", () =>
      parseTransaction(`0x${bytesToHex(result.signedTransaction)}`),
    );
    if (parsed.r === undefined || parsed.s === undefined || parsed.yParity === undefined) {
      mismatch("the signed envelope carries no signature");
    }
    const recovered = qrGuard("result-mismatch", () =>
      recoverEvmSigner(evmProbe(request), { signedTransaction: result.signedTransaction }),
    );
    if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
      mismatch("signature does not recover to the signer");
    }
    const v =
      request.tx.type === "legacy"
        ? minimalInt(parsed.yParity + 27 + request.tx.chainId * 2 + 8)
        : new Uint8Array([parsed.yParity]);
    signature = concatBytes(fixed32(parsed.r), fixed32(parsed.s), v);
  } else {
    if (result.kind !== "evm.typed-data" && result.kind !== "evm.personal-message") {
      mismatch("expected an evm signature result");
    }
    if (result.signature.length !== 65) {
      mismatch("expected a 65-byte signature");
    }
    const recovered = qrGuard("result-mismatch", () =>
      recoverEvmSigner(evmProbe(request), { signature: result.signature }),
    );
    if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
      mismatch("signature does not recover to the signer");
    }
    const [last] = result.signature.subarray(64);
    if (last === undefined) {
      mismatch("unexpected recovery id");
    }
    const recid = last - 27;
    if (recid !== 0 && recid !== 1) {
      mismatch("unexpected recovery id");
    }
    signature = concatBytes(result.signature.subarray(0, 64), new Uint8Array([recid + 27]));
  }
  return encode(
    "eth-signature",
    {
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      signature,
    },
    ethSignatureCodec,
  );
};

const solanaResponse = (
  request: QrRequest,
  result: ChainSignResult,
  signer: QrSigner,
): QrPayload => {
  if (request.family !== "solana") {
    mismatch("not a solana request");
  }
  const want = request.kind === "transaction" ? "solana.transaction" : "solana.message";
  if (result.kind !== want) {
    mismatch(`expected a ${want} result`);
  }
  if (result.signature.length !== 64) {
    mismatch("expected a 64-byte signature");
  }
  if (!verifySolanaSignature(request.data, result.signature, signer.address)) {
    mismatch("signature does not verify under the signer");
  }
  return encode(
    "sol-signature",
    {
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      signature: result.signature,
    },
    solSignatureCodec,
  );
};

const tronResponse = (request: QrRequest, result: ChainSignResult, signer: QrSigner): QrPayload => {
  if (request.family !== "tron") {
    mismatch("not a tron request");
  }
  const want = request.kind === "transaction" ? "tron.transaction" : "tron.message";
  if (result.kind !== want) {
    mismatch(`expected a ${want} result`);
  }
  if (result.signature.length !== 65) {
    mismatch("expected a 65-byte signature");
  }
  const recovered =
    request.kind === "transaction"
      ? qrGuard("result-mismatch", () =>
          recoverTronTransactionSigner(request.data, result.signature),
        )
      : qrGuard("result-mismatch", () => recoverTronMessageSigner(request.data, result.signature));
  if (recovered !== signer.address) {
    mismatch("signature does not recover to the signer");
  }
  const [last] = result.signature.subarray(64);
  if (last === undefined) {
    mismatch("unexpected recovery id");
  }
  const recid = last - 27;
  if (recid !== 0 && recid !== 1) {
    mismatch("unexpected recovery id");
  }
  // Keystone firmware writes v = recid on transactions and v = recid + 27 on messages.
  const v = request.kind === "transaction" ? recid : recid + 27;
  return encode(
    "tron-signature",
    {
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      signature: concatBytes(result.signature.subarray(0, 64), new Uint8Array([v])),
    },
    tronSignatureCodec,
  );
};

const inputSignatures = (input: {
  tapKeySig?: Uint8Array;
  partialSig?: ReadonlyArray<unknown>;
  tapScriptSig?: ReadonlyArray<unknown>;
}): number =>
  (input.tapKeySig === undefined ? 0 : 1) +
  (input.partialSig?.length ?? 0) +
  (input.tapScriptSig?.length ?? 0);

const bitcoinResponse = (request: QrRequest, result: ChainSignResult): QrPayload => {
  if (request.family !== "bitcoin") {
    mismatch("not a bitcoin request");
  }
  if (result.kind !== "bitcoin.psbt") {
    mismatch("expected a bitcoin.psbt result");
  }
  if (!samePsbtContent(request.psbt, result.signedPsbt)) {
    mismatch("the signed PSBT does not match the request");
  }
  const [requested, signed] = qrGuard("result-mismatch", () => [
    Transaction.fromPSBT(request.psbt),
    Transaction.fromPSBT(result.signedPsbt),
  ]);
  let fresh = 0;
  for (let index = 0; index < signed.inputsLength; index += 1) {
    fresh += inputSignatures(signed.getInput(index)) - inputSignatures(requested.getInput(index));
  }
  if (fresh < 1) {
    mismatch("the signed PSBT carries no new signature");
  }
  return encode(
    request.urType,
    { bytes: result.signedPsbt },
    (request.urType === "crypto-psbt" ? cryptoPsbtCodec : psbtCodec) as UrCodec<{
      readonly bytes: Uint8Array;
    }>,
  );
};

// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export const qrResponse = (
  request: QrRequest,
  result: ChainSignResult,
  signer: QrSigner | undefined,
): QrPayload => {
  const signerOrThrow = (): QrSigner => {
    if (signer === undefined) {
      mismatch("the request bound no signer to verify against");
    }
    return signer;
  };
  switch (request.family) {
    case "evm":
      return evmResponse(request, result, signerOrThrow());
    case "solana":
      return solanaResponse(request, result, signerOrThrow());
    case "tron":
      return tronResponse(request, result, signerOrThrow());
    case "bitcoin":
      return bitcoinResponse(request, result);
  }
};
