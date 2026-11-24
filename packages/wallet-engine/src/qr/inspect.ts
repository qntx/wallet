/**
 * `inspectQrRequest` — wallet-free inspection of a decoded QR sign request: the display the host
 * can render plus the digests a signing device would show. The digests prove the meaning of the
 * scanned bytes, not that the desktop sent the same bytes to the device — compare the digest shown
 * on the device.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import * as TypedData from "ox/TypedData";

import type { AccountRef, DisplayIntent, SignRequest, TaskKey } from "@qntx/wallet-chains";
import { decodeBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm, parseTypedData, planEvm } from "@qntx/wallet-chains/evm";
import { decodeSolana } from "@qntx/wallet-chains/solana";
import { decodeTron, tronMessageDigest } from "@qntx/wallet-chains/tron";

import { QrError } from "./errors.ts";
import type { QrRequest } from "./request.ts";

export type QrDigestKind =
  | "evm-transaction-hash"
  | "eip712-domain-hash"
  | "eip712-message-hash"
  | "eip712-digest"
  | "eip191-digest"
  | "solana-message-hash"
  | "tron-txid"
  | "tron-message-digest";

export type QrDigest = {
  readonly kind: QrDigestKind;
  readonly value: string;
  readonly shownBy: ReadonlyArray<"ledger-ethereum" | "ledger-solana">;
};

export type QrInspection = {
  readonly request: QrRequest;
  readonly display?: DisplayIntent;
  readonly digests: ReadonlyArray<QrDigest>;
};

const hex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;

/**
 * `planEvm` only copies the task key into the plan — the digest depends on the request bytes alone
 * — so inspection runs with the request path and a fixed placeholder point.
 */
const probeKey = (request: { readonly path: ReadonlyArray<number> }): TaskKey => ({
  path: request.path,
  publicKey: hexToBytes(`02${"00".repeat(32)}`),
});

const account: AccountRef = {
  kind: "hd",
  walletId: "",
  groupIndex: 0,
  template: "",
};

const evmNetwork = (request: Extract<QrRequest, { family: "evm" }>): string => {
  const chainId = request.kind === "transaction" ? request.tx.chainId : request.chainId;
  return `eip155:${chainId ?? 1}`;
};

const solanaProbe = (
  request: Extract<QrRequest, { family: "solana" }>,
): Extract<SignRequest, { kind: "solana.transaction" | "solana.message" }> =>
  request.kind === "transaction"
    ? {
        kind: "solana.transaction",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        account,
        message: request.data,
      }
    : {
        kind: "solana.message",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        account,
        message: request.data,
        format: "raw",
      };

const tronProbe = (
  request: Extract<QrRequest, { family: "tron" }>,
): Extract<SignRequest, { kind: "tron.transaction" | "tron.message" }> =>
  request.kind === "transaction"
    ? {
        kind: "tron.transaction",
        network: "tron:728126428",
        account,
        rawData: request.data,
      }
    : {
        kind: "tron.message",
        network: "tron:728126428",
        account,
        message: request.data,
      };

const bitcoinProbe = (
  request: Extract<QrRequest, { family: "bitcoin" }>,
): Extract<SignRequest, { kind: "bitcoin.psbt" }> => ({
  // A PSBT carries no declared network; the mainnet coder frames the outputs.
  kind: "bitcoin.psbt",
  network: "bip122:000000000019d6689c085ae165831e93",
  account: { kind: "hd", walletId: "", groupIndex: 0 },
  psbt: request.psbt,
  sign: [],
});

/** A normalized `chain.sign` request for the decoders/plans; account fields are never read. */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
const probe = (request: QrRequest): SignRequest => {
  switch (request.family) {
    case "evm": {
      const network = evmNetwork(request);
      return request.kind === "transaction"
        ? { kind: "evm.transaction", network, account, tx: request.tx }
        : request.kind === "typed-data"
          ? { kind: "evm.typed-data", network, account, typedData: request.typedData }
          : { kind: "evm.personal-message", network, account, message: request.message };
    }
    case "solana":
      return solanaProbe(request);
    case "tron":
      return tronProbe(request);
    case "bitcoin":
      return bitcoinProbe(request);
  }
};

type EvmProbe = Parameters<typeof planEvm>[0];

const evmProbe = (request: Extract<QrRequest, { family: "evm" }>): EvmProbe => {
  const network = evmNetwork(request);
  return request.kind === "transaction"
    ? { kind: "evm.transaction", network, account, tx: request.tx }
    : request.kind === "typed-data"
      ? { kind: "evm.typed-data", network, account, typedData: request.typedData }
      : { kind: "evm.personal-message", network, account, message: request.message };
};

const evmDigests = (request: Extract<QrRequest, { family: "evm" }>): ReadonlyArray<QrDigest> => {
  if (request.kind === "transaction") {
    return [
      {
        kind: "evm-transaction-hash",
        value: hex(planEvm(evmProbe(request), probeKey(request)).tasks[0].digest),
        shownBy: ["ledger-ethereum"],
      },
    ];
  }
  if (request.kind === "typed-data") {
    const { json } = parseTypedData(request.typedData);
    return [
      {
        kind: "eip712-domain-hash",
        value: TypedData.hashDomain({
          domain: json.domain,
          types: json.types,
        }),
        shownBy: ["ledger-ethereum"],
      },
      {
        kind: "eip712-message-hash",
        value: TypedData.hashStruct({
          data: json.message,
          primaryType: json.primaryType,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parseTypedData validated the shape
          types: json.types as TypedData.TypedData,
        }),
        shownBy: ["ledger-ethereum"],
      },
      {
        kind: "eip712-digest",
        value: hex(planEvm(evmProbe(request), probeKey(request)).tasks[0].digest),
        shownBy: ["ledger-ethereum"],
      },
    ];
  }
  return [
    {
      kind: "eip191-digest",
      value: hex(planEvm(evmProbe(request), probeKey(request)).tasks[0].digest),
      shownBy: ["ledger-ethereum"],
    },
  ];
};

/** The display decode, or `undefined` when the request lacks what a decoder needs. */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
const display = (request: QrRequest): DisplayIntent | undefined => {
  if (request.family !== "bitcoin" && request.address === undefined) {
    return undefined;
  }
  try {
    switch (request.family) {
      case "evm": {
        const probe_ = probe(request);
        if (request.address === undefined) {
          return undefined;
        }
        return decodeEvm(probe_, request.address);
      }
      case "solana": {
        if (request.kind !== "transaction" || request.address === undefined) {
          return undefined;
        }
        const probed = solanaProbe(request);
        if (probed.kind !== "solana.transaction") {
          return undefined;
        }
        return decodeSolana(probed, request.address);
      }

      case "tron":
        if (request.address === undefined) {
          return undefined;
        }
        return decodeTron(probe(request), request.address);

      case "bitcoin":
        return decodeBitcoinPsbt(bitcoinProbe(request));
    }
  } catch {
    return undefined;
  }
};

const displayed = (request: QrRequest): { readonly display?: DisplayIntent } => {
  const intent = display(request);
  return intent === undefined ? {} : { display: intent };
};

// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export const inspectQrRequest = (request: QrRequest): QrInspection => {
  try {
    switch (request.family) {
      case "evm":
        return { request, ...displayed(request), digests: evmDigests(request) };
      case "solana":
        return {
          request,
          ...displayed(request),
          digests: [
            {
              kind: "solana-message-hash",
              value: base58.encode(sha256(request.data)),
              shownBy: ["ledger-solana"],
            },
          ],
        };
      case "tron":
        return {
          request,
          ...displayed(request),
          digests: [
            request.kind === "transaction"
              ? { kind: "tron-txid" as const, value: hex(sha256(request.data)), shownBy: [] }
              : {
                  kind: "tron-message-digest" as const,
                  value: hex(tronMessageDigest(request.data)),
                  shownBy: [],
                },
          ],
        };
      case "bitcoin":
        return { request, ...displayed(request), digests: [] };
    }
  } catch (error) {
    if (error instanceof QrError) {
      throw error;
    }
    throw new QrError("malformed", error instanceof Error ? error.message : "inspect failed");
  }
};
