/**
 * Audit A1 / chains-signing PoCs: decoder → kernel prompt end to end, each case a request whose
 * prompt (and DisplayIntent) understates or misstates what the signed bytes do.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { isBlindIntent } from "@qntx/wallet-chains";
import { decodeBitcoinPsbt, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";

import { chainPrompt } from "../../src/modules/chains/prompt.ts";

const SIGNER = "0x00000000000000000000000000000000DeaDBeef";
const ATTACKER = "0xBAd0000000000000000000000000000000000Bad";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

const typed = (network: string, doc: unknown) =>
  normalizeEvm({
    kind: "evm.typed-data",
    network,
    account: ACCOUNT,
    typedData: JSON.stringify(doc),
  }) as Extract<ReturnType<typeof normalizeEvm>, { kind: "evm.typed-data" }>;

describe("CS-BTC: an OP_RETURN output carrying value is neither an outflow nor fee", () => {
  const NET = "bip122:000000000019d6689c085ae165831e93";
  const OWN = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xcd)]);
  const psbt = (): Uint8Array => {
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hexToBytes("07".repeat(32)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: OWN, amount: 100_000_000n });
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: OWN, amount: 100_000_000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [
          new Uint8Array(33).fill(2),
          { fingerprint: 1, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] },
        ],
      ],
    });
    tx.addOutput({
      script: new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]),
      amount: 1_000_000n,
    });
    // OP_RETURN "burn": 0.98 BTC destroyed (unspendable output, value is consensus-valid).
    tx.addOutput({ script: new Uint8Array([0x6a, 0x04, 0xde, 0xad, 0xbe, 0xef]), amount: 98_000_000n });
    return tx.toPSBT(0);
  };

  it("prompt shows a 0.01 BTC send and a 0.01 BTC fee, verifiability full; 0.98 BTC is burned", () => {
    const request = normalizeBitcoin({
      kind: "bitcoin.psbt",
      network: NET,
      account: { kind: "hd", walletId: "w", groupIndex: 0 },
      psbt: psbt(),
      sign: [{ index: 0, template: "btc.bip84" }],
    }) as Extract<ReturnType<typeof normalizeBitcoin>, { kind: "bitcoin.psbt" }>;
    const intent = decodeBitcoinPsbt(request, new Set());
    expect(intent.verifiability).toBe("full");
    expect(intent.outflows).toHaveLength(1);
    const text = chainPrompt("en", intent).description;
    expect(text).toBe(
      "Network: Bitcoin\nSend 0.01 BTC to bc1q4w46h2at4w46h2at4w46h2at4w46h2at25y74s\nMax fee 0.01 BTC",
    );
  });
});

const SAFE = "0x1234567890123456789012345678901234567890";
const safeDoc = (over: Record<string, unknown>) => ({
  types: {
    EIP712Domain: [
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  },
  primaryType: "SafeTx",
  domain: { chainId: 1, verifyingContract: SAFE },
  message: {
    to: SIGNER,
    value: "0",
    data: "0x",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: "7",
    ...over,
  },
});

describe("CS-SAFE: SafeTx recognition", () => {
  it("a delegatecall to an arbitrary contract is not blind (the blind-signing gate passes it)", () => {
    const request = typed("eip155:1", safeDoc({ to: ATTACKER, operation: 1 }));
    const intent = decodeEvm(request, SIGNER);
    expect(intent.message?.kind).toBe("typed-data");
    expect(intent.verifiability).toBe("opaque");
    expect(isBlindIntent(intent)).toBe(false);
    const text = chainPrompt("en", intent).description;
    expect(text).toContain(`Runs the code of ${ATTACKER} with the Safe's full authority`);
    // The delegatecall is rendered with the call rules: a verified native "send" of value 0,
    // whose amount is not even formatted (Safe inner calls skip withNativeAmountMeta).
    expect(text).toContain(`Send 0 base units of unverified token native to ${ATTACKER}`);
    expect(text).not.toContain("cannot be verified");
  });

  it("a gas refund of 10^30 base units of USDC to the attacker is shown without amount or token", () => {
    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const request = typed(
      "eip155:1",
      safeDoc({
        baseGas: "1000000",
        gasPrice: "1000000000000000000000000",
        gasToken: USDC,
        refundReceiver: ATTACKER,
      }),
    );
    const intent = decodeEvm(request, SIGNER);
    expect(isBlindIntent(intent)).toBe(false);
    expect(intent.outflows).toStrictEqual([]);
    const text = chainPrompt("en", intent).description;
    expect(text).toContain(`Refunds gas to ${ATTACKER}`);
    expect(text).not.toContain("USDC");
    expect(text).not.toContain("1000000000000000000000000");
    // The decoded SafeTransaction carries the terms; the prompt drops them.
    const safe = intent.message?.kind === "typed-data" ? intent.message.safe : undefined;
    expect(safe?.refund).toStrictEqual({
      gasPrice: "1000000000000000000000000",
      gasToken: USDC,
      refundReceiver: ATTACKER,
    });
  });
});

describe("CS-SAFE-AMOUNT: a Safe inner call's ETH value is not formatted", () => {
  it("1 ETH from the Safe renders as raw base units of an unverified token named native", () => {
    const request = typed("eip155:1", safeDoc({ to: ATTACKER, value: "1000000000000000000" }));
    const text = chainPrompt("en", decodeEvm(request, SIGNER)).description;
    expect(text).toContain(
      `Send 1000000000000000000 base units of unverified token native to ${ATTACKER}`,
    );
  });
});

describe("CS-SEAPORT: Seaport order rendering", () => {
  const NFT = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
  const ZERO = "0x0000000000000000000000000000000000000000";
  const ITEM = [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ];
  const order = (chainId: number) => ({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      OrderComponents: [
        { name: "offerer", type: "address" },
        { name: "zone", type: "address" },
        { name: "offer", type: "OfferItem[]" },
        { name: "consideration", type: "ConsiderationItem[]" },
        { name: "orderType", type: "uint8" },
        { name: "startTime", type: "uint256" },
        { name: "endTime", type: "uint256" },
        { name: "zoneHash", type: "bytes32" },
        { name: "salt", type: "uint256" },
        { name: "conduitKey", type: "bytes32" },
        { name: "counter", type: "uint256" },
      ],
      OfferItem: ITEM,
      ConsiderationItem: [...ITEM, { name: "recipient", type: "address" }],
    },
    primaryType: "OrderComponents",
    domain: {
      name: "Seaport",
      version: "1.6",
      chainId,
      verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
    },
    message: {
      offerer: SIGNER,
      zone: ZERO,
      offer: [
        { itemType: 2, token: NFT, identifierOrCriteria: "7090", startAmount: "1", endAmount: "1" },
      ],
      consideration: [
        {
          itemType: 0,
          token: ZERO,
          identifierOrCriteria: "0",
          startAmount: "100000000000000000000",
          endAmount: "100000000000000000000",
          recipient: SIGNER,
        },
      ],
      orderType: 0,
      startTime: "0",
      endTime: "2000000000",
      zoneHash: `0x${"00".repeat(32)}`,
      salt: "1",
      conduitKey: `0x${"00".repeat(32)}`,
      counter: "0",
    },
  });

  it("on Polygon the native consideration (POL) is rendered as ETH", () => {
    const intent = decodeEvm(typed("eip155:137", order(137)), SIGNER);
    expect(isBlindIntent(intent)).toBe(false);
    const text = chainPrompt("en", intent).description;
    expect(text).toContain("Network: Polygon");
    expect(text).toContain(`${SIGNER} receives 100 ETH`);
  });

  it("the offered NFT's token id is not rendered", () => {
    const intent = decodeEvm(typed("eip155:1", order(1)), SIGNER);
    const text = chainPrompt("en", intent).description;
    expect(text).toContain(`Give 1 base units of unverified token ${NFT}`);
    expect(text).not.toContain("7090");
  });
});

describe("CS-LIDO: native value on a WithdrawalQueue call is dropped", () => {
  it("requestWithdrawals with 5 ETH attached shows no ETH outflow", () => {
    const QUEUE = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";
    const pad = (h: string) => h.padStart(64, "0");
    // requestWithdrawals(uint256[] amounts=[1e18], address owner=signer)
    const data = `0xd6681042${pad("40")}${pad(SIGNER.slice(2).toLowerCase())}${pad("1")}${pad(
      (10n ** 18n).toString(16),
    )}`;
    const request = normalizeEvm({
      kind: "evm.transaction",
      network: "eip155:1",
      account: ACCOUNT,
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        to: QUEUE,
        value: `0x${(5n * 10n ** 18n).toString(16)}`,
        data,
        gas: "0x30000",
        maxFeePerGas: "0x3b9aca00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    });
    const intent = decodeEvm(request, SIGNER);
    expect(intent.summary).toBe("stake");
    expect(intent.outflows).toStrictEqual([]);
    const text = chainPrompt("en", intent).description;
    expect(text).not.toContain("5 ETH");
  });
});
