/**
 * PoC for finding R-2 (solana-sign-no-recipient-check).
 *
 * Property that should hold: recipient assessment (`assessRecipients` → `first-recipient` /
 * `address-poisoning`) applies to every request that pays a third-party destination — the wallet
 * `send` path runs it through `chainRisk`, and the `evm-sign` branches run it on intent outflows.
 *
 * Current behaviour pinned here: the `solana-sign` branch (src/requests/controller.ts ~L1223)
 * builds `risk` from sign-in risk + blind-signing risk + `assessApprovals` only — a dApp's
 * `solana-sign transactions` request paying an address that looks exactly like one the wallet
 * already paid yields no recipient findings at all, while the same recipient through `send` is
 * flagged `address-poisoning`.
 *
 * These assertions pin the buggy behaviour: they pass today and must be revisited by the fix.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { AddressBookController } from "../../src/addresses/controller.ts";
import { RequestController } from "../../src/requests/controller.ts";
import type { SparkController } from "../../src/spark/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import type { TransactionController } from "../../src/transactions/controller.ts";
import type {
  DisplayIntent,
  PreparedRequest,
  TrackedTransaction,
} from "../../src/transactions/route.ts";
import { tokensStub } from "../send-helpers.ts";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ORIGIN = { kind: "browser", origin: "https://app.example" } as const;
const SIGNER = "11111111111111111111111111111112";
const ACCOUNT = { walletId: "w", groupIndex: 0, address: SIGNER };
const ACCOUNT_REF = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change",
} as const;

/** The recipient the dApp's transaction pays — a real base58 Solana address. */
const DEST = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
/**
 * An address the wallet already paid (via a tracked send), sharing DEST's first and last four
 * characters — the `looksLike` poisoning shape. Only ever compared as a string, so it need not
 * decode.
 */
const KNOWN = `8qbH${"9".repeat(36)}VfeR`;

/** A legacy transaction: System Program transfer of 1_000_000 lamports SIGNER → DEST. */
const solanaTx = (): Uint8Array => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, 1_000_000n, true);
  const message = new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(
        appendTransactionMessageInstruction(
          {
            programAddress: address("11111111111111111111111111111111"),
            accounts: [
              { address: address(SIGNER), role: AccountRole.WRITABLE_SIGNER },
              { address: address(DEST), role: AccountRole.WRITABLE },
            ],
            data,
          },
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: address("11111111111111111111111111111111"),
              lastValidBlockHeight: 1000n,
            } as never,
            setTransactionMessageFeePayer(
              address(SIGNER),
              createTransactionMessage({ version: "legacy" }),
            ),
          ),
        ),
      ),
    ),
  );
  return new Uint8Array([1, ...new Uint8Array(64), ...message]);
};

const intentTo = (to: string): DisplayIntent =>
  ({
    family: "solana",
    network: NETWORK,
    summary: "transfer",
    outflows: [
      { to, amount: { asset: "lamports", amount: "1000000", decimals: 9 }, verified: true },
    ],
    approvals: [],
    fee: undefined,
    warnings: [],
    verifiability: "full",
  }) as unknown as DisplayIntent;

/** The wallet's history already holds a confirmed solana send to KNOWN. */
const trackedTo = (to: string): TrackedTransaction => ({
  id: "t-known",
  family: "solana",
  network: NETWORK,
  account: "w",
  hash: "sig",
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
    simulateSolana: async () => Promise.resolve({ status: "success" as const, changes: [] }),
    transactions,
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
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

const sign = (transactions: Uint8Array[]) => ({
  method: "solana-sign" as const,
  origin: ORIGIN,
  account: ACCOUNT,
  network: NETWORK,
  request: { kind: "transactions" as const, transactions, send: true },
});

describe("R-2: solana-sign recipients are never assessed", () => {
  it("a dApp solana-sign paying a lookalike of a known address yields no recipient risk", async () => {
    const { requests } = rig();
    await requests.init();
    const request = await requests.prepare(sign([solanaTx()]));
    // The transaction pays DEST, which looks exactly like the tracked recipient KNOWN —
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
