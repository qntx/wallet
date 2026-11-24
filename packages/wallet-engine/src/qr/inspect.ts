/**
 * `inspectQrRequest` — wallet-free inspection of a decoded QR sign request: the display the host
 * can render plus the digests a signing device would show. The digests prove the meaning of the
 * scanned bytes, not that the desktop sent the same bytes to the device — compare the digest shown
 * on the device.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import * as TypedData from "ox/TypedData";

import type { AccountRef, DisplayIntent, SignRequest, TaskKey } from "@qntx/wallet-chains";
import { BITCOIN_NETWORKS, decodeBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm, parseTypedData, planEvm } from "@qntx/wallet-chains/evm";
import { decodeSolana } from "@qntx/wallet-chains/solana";
import { decodeTron, tronMessageDigest } from "@qntx/wallet-chains/tron";

import { inputEntries } from "./bind.ts";
import { QrError, qrGuard } from "./errors.ts";
import { BITCOIN_MAINNET } from "./link.ts";
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

/**
 * One decoded view of the request: `networks` names every network the address encoding serves —
 * several when one bech32 prefix covers them (a coin-type-1' PSBT shows its `tb1…` outputs for
 * testnet and signet alike, so one intent is labelled by both; regtest's `bcrt1…` is a separate
 * entry). `intent.network` is the id the decode ran under — always a member of `networks`.
 */
export type QrDisplay = {
  readonly networks: ReadonlyArray<string>;
  readonly intent: DisplayIntent;
};

export type QrInspection = {
  readonly request: QrRequest;
  /**
   * One decoded intent per output encoding the request permits — a single entry for every request
   * but a coin-type-1' PSBT, which carries both the `tb1…` and `bcrt1…` decodings. Absent when the
   * request lacks what a decoder needs (a missing counterpart address) or every decode failed.
   */
  readonly displays?: ReadonlyArray<QrDisplay>;
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

/* The coin-type-1' encodings from @qntx/wallet-chains' bitcoin network table, one CAIP-2 id
   group per bech32 prefix: testnet and signet share `tb1…` (one display serves both); regtest's
   `bcrt1…` is its own display. */
const COIN1_ENCODINGS: ReadonlyArray<ReadonlyArray<string>> = (() => {
  const groups = new Map<string, string[]>();
  for (const network of Object.values(BITCOIN_NETWORKS)) {
    if (network.coinType !== 1) {
      continue;
    }
    const list = groups.get(network.params.bech32) ?? [];
    list.push(network.caip2);
    groups.set(network.params.bech32, list);
  }
  return [...groups.values()];
})();

const HARDENED = 0x80000000;

/**
 * The network labels a PSBT's derivations permit, one entry per address encoding: coin type 0' is
 * mainnet alone; coin type 1' is ambiguous between the `tb1…` test networks and regtest's `bcrt1…`,
 * so both encodings are returned. A derivation with no hardened coin type, a coin type this wallet
 * never serves, derivations across several coin types, or no derivations at all leave the network
 * unreadable — refuse rather than show outputs on a guessed one (the same `network-ambiguous`
 * `bindQrRequest` raises).
 */
const psbtEncodings = (psbt: Uint8Array): ReadonlyArray<ReadonlyArray<string>> => {
  const tx = qrGuard("malformed", () => Transaction.fromPSBT(psbt));
  const coins = new Set<number>();
  const collect = (
    io: Parameters<typeof inputEntries>[0],
    side: "input" | "output",
    index: number,
  ): void => {
    for (const entry of inputEntries(io)) {
      const [, coin] = entry.path;
      if (entry.path.length < 2 || coin === undefined || coin < HARDENED) {
        throw new QrError(
          "network-ambiguous",
          `a ${side} ${index} derivation carries no coin type`,
        );
      }
      coins.add(coin - HARDENED);
    }
  };
  for (let index = 0; index < tx.inputsLength; index += 1) {
    collect(
      qrGuard("malformed", () => tx.getInput(index)),
      "input",
      index,
    );
  }
  for (let index = 0; index < tx.outputsLength; index += 1) {
    collect(
      qrGuard("malformed", () => tx.getOutput(index)),
      "output",
      index,
    );
  }
  if (coins.size !== 1) {
    throw new QrError(
      "network-ambiguous",
      coins.size === 0
        ? "the PSBT carries no derivation to read a network from"
        : "the derivations span several bitcoin coin types",
    );
  }
  const [coin] = coins;
  if (coin === 0) {
    return [[BITCOIN_MAINNET]];
  }
  if (coin === 1) {
    return COIN1_ENCODINGS;
  }
  throw new QrError(
    "network-ambiguous",
    `coin type ${coin ?? "unknown"}' is not a bitcoin network we serve`,
  );
};

const bitcoinProbe = (
  request: Extract<QrRequest, { family: "bitcoin" }>,
  network: string,
): Extract<SignRequest, { kind: "bitcoin.psbt" }> => ({
  kind: "bitcoin.psbt",
  network,
  account: { kind: "hd", walletId: "", groupIndex: 0 },
  psbt: request.psbt,
  sign: [],
});

/** A normalized `chain.sign` request for the decoders; account fields are never read. */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
const probe = (request: Extract<QrRequest, { family: "evm" | "solana" | "tron" }>): SignRequest => {
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
        /* Ledger app-ethereum ≥ 1.14.0 shows the transaction hash in the blind-signing flow —
           https://github.com/LedgerHQ/app-ethereum/blob/master/CHANGELOG.md §1.14.0 "Changed". */
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
        /* Ledger app-ethereum ≥ 1.18.0 shows the EIP-712 domain and message hashes —
           https://github.com/LedgerHQ/app-ethereum/blob/master/CHANGELOG.md §1.18.0. */
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
        // Same app-ethereum ≥ 1.18.0 source as the domain hash above.
        shownBy: ["ledger-ethereum"],
      },
      {
        kind: "eip712-digest",
        value: hex(planEvm(evmProbe(request), probeKey(request)).tasks[0].digest),
        /* No source says the device shows the final digest — compare only the domain and message
           hashes above. */
        shownBy: [],
      },
    ];
  }
  return [
    {
      kind: "eip191-digest",
      value: hex(planEvm(evmProbe(request), probeKey(request)).tasks[0].digest),
      // No primary source shows which hash app-ethereum displays for a personal message.
      shownBy: [],
    },
  ];
};

/** One decode per network the PSBT's derivations permit; a failed decode drops that entry. */
const bitcoinDisplays = (
  request: Extract<QrRequest, { family: "bitcoin" }>,
): ReadonlyArray<QrDisplay> | undefined => {
  const encodings = psbtEncodings(request.psbt);
  const out: QrDisplay[] = [];
  for (const networks of encodings) {
    const [network] = networks;
    if (network === undefined) {
      continue;
    }
    try {
      out.push({ networks, intent: decodeBitcoinPsbt(bitcoinProbe(request, network)) });
    } catch {
      /* An undecodable frame loses that encoding's display, not the inspection. */
    }
  }
  return out.length === 0 ? undefined : out;
};

/** The display decodes, or `undefined` when the request lacks what a decoder needs. */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
const displays = (request: QrRequest): ReadonlyArray<QrDisplay> | undefined => {
  if (request.family === "bitcoin") {
    return bitcoinDisplays(request);
  }
  if (request.address === undefined) {
    return undefined;
  }
  try {
    switch (request.family) {
      case "evm": {
        const intent = decodeEvm(probe(request), request.address);
        return [{ networks: [intent.network], intent }];
      }
      case "solana": {
        if (request.kind !== "transaction") {
          return undefined;
        }
        const probed = solanaProbe(request);
        if (probed.kind !== "solana.transaction") {
          return undefined;
        }
        const intent = decodeSolana(probed, request.address);
        return [{ networks: [intent.network], intent }];
      }
      case "tron": {
        const intent = decodeTron(probe(request), request.address);
        return [{ networks: [intent.network], intent }];
      }
    }
  } catch {
    return undefined;
  }
};

const displayed = (request: QrRequest): { readonly displays?: ReadonlyArray<QrDisplay> } => {
  const decoded = displays(request);
  return decoded === undefined ? {} : { displays: decoded };
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
              /* Ledger app-solana blind signing shows base58(sha256(message)) as "Message Hash" —
                 https://github.com/LedgerHQ/app-solana/blob/a19da6c/src/handle_sign_message.c
                 (cx_hash_sha256 over the message). */
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
