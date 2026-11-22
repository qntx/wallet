/**
 * PoC for finding R-3 (psbt-no-recipient-check).
 *
 * Property that should hold: recipient assessment (`assessRecipients` → `first-recipient` /
 * `address-poisoning`) applies to every request that pays a third-party destination — the wallet
 * `send` path runs it through `chainRisk` on intent outflows.
 *
 * Current behaviour pinned here: the `bitcoin-sign` psbt branch (src/requests/controller.ts ~L1295)
 * builds `risk` from `assessBitcoinPsbts` (sighash, frozen and inscription findings over the signed
 * inputs) + `blindRisk` only — a dApp PSBT paying an output to an address that looks exactly like
 * one the wallet already paid yields no recipient findings, while the same recipient through `send`
 * is flagged `address-poisoning`.
 *
 * These assertions pin the buggy behaviour: they pass today and must be revisited by the fix.
 */
import { OutScript } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { AddressBookController } from "../../src/addresses/controller.ts";
import { RequestController } from "../../src/requests/controller.ts";
import type { PreparedBitcoinPsbt } from "../../src/requests/types.ts";
import type { SparkController } from "../../src/spark/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import type { TransactionController } from "../../src/transactions/controller.ts";
import type {
  DisplayIntent,
  PreparedRequest,
  TrackedTransaction,
} from "../../src/transactions/route.ts";
import { tokensStub } from "../send-helpers.ts";

const NETWORK = "bip122:000000000019d6689c085ae165831e93";
const ORIGIN = { kind: "browser", origin: "https://app.example" } as const;
const ACCOUNT = { walletId: "w", groupIndex: 0 };
const ACCOUNT_REF = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "btc.bip84",
} as const;

/** The output the dApp's PSBT pays — a real mainnet address. */
const DEST = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
/**
 * An address the wallet already paid (via a tracked send), sharing DEST's first and last four
 * characters — the `looksLike` poisoning shape. Only ever compared as a string, so it need not
 * decode.
 */
const KNOWN = `bc1q${"z".repeat(34)}f3t4`;

/** A minimal PSBT: one segwit input (witnessUtxo so the decoder can type it), one output to DEST. */
const psbt = (): Uint8Array => {
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: "00".repeat(32),
    index: 0,
    witnessUtxo: {
      script: OutScript.encode({ type: "wpkh", hash: new Uint8Array(20).fill(1) }),
      amount: 10_000n,
    },
  });
  tx.addOutputAddress(DEST, 1000n);
  return tx.toPSBT(0);
};

const intentTo = (to: string): DisplayIntent =>
  ({
    family: "bitcoin",
    network: NETWORK,
    summary: "transfer",
    outflows: [{ to, amount: { asset: "sats", amount: "1000", decimals: 8 }, verified: true }],
    approvals: [],
    fee: undefined,
    warnings: [],
    verifiability: "full",
  }) as unknown as DisplayIntent;

/** The wallet's history already holds a confirmed bitcoin send to KNOWN. */
const trackedTo = (to: string): TrackedTransaction => ({
  id: "t-known",
  family: "bitcoin",
  network: NETWORK,
  account: "w",
  hash: "txid",
  state: "confirmed",
  intent: intentTo(to),
  nonce: 0,
  submittedAt: 0,
  error: undefined,
});

const rig = () => {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const openStore = async () => Promise.resolve(createMemoryEngineStore(backing));
  const logger = { warn: () => undefined };
  const transactions = {
    getState: () => ({ txs: { "t-known": trackedTo(KNOWN) } }),
    prepareSend: async (p: { to: string }, requestId: string): Promise<PreparedRequest> => {
      await Promise.resolve();
      return {
        txId: `tx-${requestId}`,
        account: ACCOUNT_REF,
        network: NETWORK,
        intent: intentTo(p.to),
        checks: [],
        staleReason: () => undefined,
        submit: async () => Promise.reject(new Error("not submitted in this test")),
        release: () => undefined,
      };
    },
  } as unknown as TransactionController;
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    tokens: tokensStub,
    simulateSolana: async () => Promise.reject(new Error("unused")),
    transactions,
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async (_account, _network, psbts) => {
      await Promise.resolve();
      return psbts.map(({ psbt: bytes }): PreparedBitcoinPsbt => ({
        request: {
          kind: "bitcoin.psbt",
          network: NETWORK,
          account: { kind: "hd", walletId: "w", groupIndex: 0 },
          psbt: bytes,
          sign: [{ index: 0, template: "btc.bip84" }],
        },
        ownScripts: new Set(),
        inputs: [],
      }));
    },
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    addressBook: new AddressBookController({
      openStore,
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger,
    }),
    openStore,
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(1),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  return { requests };
};

const sign = (psbts: Uint8Array[]) => ({
  method: "bitcoin-sign" as const,
  origin: ORIGIN,
  account: ACCOUNT,
  network: NETWORK,
  request: {
    kind: "psbt" as const,
    psbts: psbts.map((bytes) => ({
      psbt: bytes,
      sign: [{ index: 0, sigHash: "ALL" as const, template: "btc.bip84" as const }],
    })),
    send: false,
  },
});

describe("R-3: bitcoin-sign psbt recipients are never assessed", () => {
  it("a dApp psbt paying a lookalike of a known address yields no recipient risk", async () => {
    const { requests } = rig();
    await requests.init();
    const request = await requests.prepare(sign([psbt()]));
    // The PSBT's output pays DEST, which looks exactly like the tracked recipient KNOWN —
    // and the branch never runs assessRecipients at all.
    const codes = request.risk.map((r) => r.code);
    expect(codes).not.toContain("address-poisoning");
    expect(codes).not.toContain("first-recipient");
  });

  it("control: the same recipient through the wallet send path is flagged", async () => {
    const { requests } = rig();
    await requests.init();
    const request = await requests.prepare({
      method: "send",
      account: ACCOUNT_REF,
      network: NETWORK,
      to: DEST,
      amount: 1n,
      fee: "normal",
    });
    expect(request.risk).toStrictEqual([
      { code: "address-poisoning", level: "danger" },
      { code: "first-recipient", level: "warning" },
    ]);
  });
});
