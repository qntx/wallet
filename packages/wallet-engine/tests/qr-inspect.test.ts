/**
 * `inspectQrRequest` labelling — every `shownBy` names a device a primary source credits with
 * showing that digest (R11-06), and a PSBT is framed by the coin types its derivations carry, never
 * a guessed network (R11-07): coin type 0' is mainnet, coin type 1' shows both the `tb1…`
 * test-network and `bcrt1…` regtest encodings, anything else is `network-ambiguous`.
 */
import { Address, NETWORK, OutScript, Transaction } from "@scure/btc-signer";
import { TEST_NETWORK } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { evmSigningPreimage } from "@qntx/wallet-chains/evm";

import { QrError } from "../src/qr/errors.ts";
import { inspectQrRequest } from "../src/qr/index.ts";
import type { QrRequest } from "../src/qr/index.ts";

const HARDENED = 0x80000000;
const PATH = [44 + HARDENED, 60 + HARDENED, HARDENED, 0, 0];
const XFP = 0x73c5da0a;
const TYPED_DATA = JSON.stringify({
  types: {
    EIP712Domain: [{ name: "name", type: "string" }],
    Mail: [{ name: "contents", type: "string" }],
  },
  primaryType: "Mail",
  domain: { name: "Test" },
  message: { contents: "hello" },
});

const digest = (request: QrRequest, kind: string) =>
  inspectQrRequest(request).digests.find((d) => d.kind === kind);

describe("inspectQrRequest labels only the digests a source says a device shows", () => {
  it("eip712-digest carries no device label beside the two sourced hashes", () => {
    const request: QrRequest = {
      family: "evm",
      kind: "typed-data",
      path: PATH,
      xfp: XFP,
      typedData: TYPED_DATA,
    };
    const inspection = inspectQrRequest(request);
    expect(inspection.digests.map((d) => d.kind)).toStrictEqual([
      "eip712-domain-hash",
      "eip712-message-hash",
      "eip712-digest",
    ]);
    expect(digest(request, "eip712-domain-hash")?.shownBy).toStrictEqual(["ledger-ethereum"]);
    expect(digest(request, "eip712-message-hash")?.shownBy).toStrictEqual(["ledger-ethereum"]);
    expect(digest(request, "eip712-digest")?.shownBy).toStrictEqual([]);
  });

  it("eip191-digest carries no device label; the transaction hash keeps its source", () => {
    const personal: QrRequest = {
      family: "evm",
      kind: "personal-message",
      path: PATH,
      xfp: XFP,
      message: new TextEncoder().encode("hello"),
    };
    expect(digest(personal, "eip191-digest")?.shownBy).toStrictEqual([]);

    const tx = {
      type: "eip1559" as const,
      chainId: 1,
      nonce: 0,
      to: "0x0000000000000000000000000000000000000001",
      value: "1",
      data: "0x",
      gas: "21000",
      accessList: [],
      maxFeePerGas: "1",
      maxPriorityFeePerGas: "1",
    };
    const transaction: QrRequest = {
      family: "evm",
      kind: "transaction",
      path: PATH,
      xfp: XFP,
      tx,
      data: evmSigningPreimage(tx),
    };
    expect(digest(transaction, "evm-transaction-hash")?.shownBy).toStrictEqual(["ledger-ethereum"]);
  });
});

const derivation = (coin: number) => ({
  bip32Derivation: [
    [
      new Uint8Array(33).fill(2),
      { fingerprint: XFP, path: [84 + HARDENED, coin + HARDENED, HARDENED, 0, 0] },
    ],
  ] as Array<[Uint8Array, { fingerprint: number; path: number[] }]>,
});

/** A one-input PSBT paying a p2wpkh output; `coin` drives the input derivations. */
const psbt = (options: {
  readonly inputCoin?: number;
  readonly outputCoin?: number;
  readonly derivations?: boolean;
}): Uint8Array => {
  const spent = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x02)]);
  const payee = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x03)]);
  const tx = new Transaction();
  tx.addInput({
    txid: new Uint8Array(32).fill(0x07),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: spent, amount: 100_000n },
    ...(options.derivations === false || options.inputCoin === undefined
      ? {}
      : derivation(options.inputCoin)),
  });
  tx.addOutput({
    script: payee,
    amount: 90_000n,
    ...(options.derivations === false || options.outputCoin === undefined
      ? {}
      : derivation(options.outputCoin)),
  });
  return tx.toPSBT(0);
};

const request = (bytes: Uint8Array): QrRequest => ({
  family: "bitcoin",
  kind: "psbt",
  urType: "psbt",
  psbt: bytes,
});

describe("inspectQrRequest frames a PSBT by its derivation coin types", () => {
  it("a coin-type-0' PSBT shows one mainnet display", () => {
    const out = inspectQrRequest(request(psbt({ inputCoin: 0 })));
    expect(out.displays).toHaveLength(1);
    const [only] = out.displays!;
    expect(only?.networks).toStrictEqual(["bip122:000000000019d6689c085ae165831e93"]);
    const script = Transaction.fromPSBT(psbt({ inputCoin: 0 })).getOutput(0).script!;
    expect(only?.intent.outflows[0]?.to).toBe(Address(NETWORK).encode(OutScript.decode(script)));
  });

  it("a coin-type-1' PSBT shows the tb1 test networks and the bcrt1 regtest encoding", () => {
    const bytes = psbt({ inputCoin: 1 });
    const out = inspectQrRequest(request(bytes));
    expect(out.displays).toHaveLength(2);

    const script = Transaction.fromPSBT(bytes).getOutput(0).script!;
    const decoded = OutScript.decode(script);

    const [tb, bcrt] = out.displays!;
    expect(tb?.networks).toStrictEqual([
      "bip122:00000000da84f2bafbbc53dee25a72ae",
      "bip122:00000008819873e925422c1ff0f99f7c",
    ]);
    expect(tb?.intent.outflows[0]?.to).toBe(Address(TEST_NETWORK).encode(decoded));

    expect(bcrt?.networks).toStrictEqual(["bip122:0f9188f13cb7b2c71f2a335e3a4fc328"]);
    expect(bcrt?.intent.outflows[0]?.to).toBe(
      Address({ ...TEST_NETWORK, bech32: "bcrt" }).encode(decoded),
    );
  });

  const ambiguous = (bytes: Uint8Array): string => {
    try {
      inspectQrRequest(request(bytes));
    } catch (error) {
      return error instanceof QrError ? error.code : `unexpected:${String(error)}`;
    }
    return "no-error";
  };

  it("an output derivation counts toward the coin types too", () => {
    const out = inspectQrRequest(request(psbt({ inputCoin: 1, outputCoin: 1 })));
    expect(out.displays).toHaveLength(2);
    expect(ambiguous(psbt({ inputCoin: 0, outputCoin: 1 }))).toBe("network-ambiguous");
  });

  it("mixed input coin types are refused as ambiguous", () => {
    const tx = new Transaction();
    const spent = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x02)]);
    for (const [index, coin] of [0, 1].entries()) {
      tx.addInput({
        txid: new Uint8Array(32).fill(0x07 + index),
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script: spent, amount: 100_000n },
        bip32Derivation: derivation(coin).bip32Derivation,
      });
    }
    tx.addOutput({
      script: new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x03)]),
      amount: 90_000n,
    });
    expect(ambiguous(tx.toPSBT(0))).toBe("network-ambiguous");
  });

  it("a PSBT with no derivations is refused as ambiguous", () => {
    expect(ambiguous(psbt({ derivations: false }))).toBe("network-ambiguous");
  });
});
