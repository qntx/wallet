/**
 * `evm-revoke`/`solana-revoke` through the request pipeline: a prepared request carries the
 * revocation approvals as its display intent, raises no approval-grant risk findings for the
 * authority being removed, and the sign log accepts both method labels.
 */
import { describe, expect, it } from "vite-plus/test";

import type { DisplayIntent } from "@qntx/wallet-chains";
import { checksumEvmAddress } from "@qntx/wallet-chains/evm";

import { AddressBookController } from "../src/addresses/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import { createSignLog } from "../src/requests/sign-log.ts";
import type { SignLogEntry } from "../src/requests/sign-log.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type { PreparedRequest } from "../src/transactions/route.ts";
import { simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const SEPOLIA = "eip155:11155111";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const FROM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const TOKEN = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x3333333333333333333333333333333333333333";
const TA = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "0a".repeat(8),
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const SOL_ACCOUNT = { ...ACCOUNT, template: "solana.bip44-change" as const };

const evmRevokeIntent: DisplayIntent = {
  family: "evm",
  network: SEPOLIA,
  summary: "approve",
  outflows: [],
  approvals: [
    {
      kind: "allowance",
      spender: checksumEvmAddress(SPENDER),
      amount: { asset: checksumEvmAddress(TOKEN), amount: "0" },
      change: "set",
      unlimited: false,
      verified: false,
    },
  ],
  fee: undefined,
  warnings: [],
  verifiability: "full",
};

const solanaRevokeIntent: DisplayIntent = {
  family: "solana",
  network: SOL_NET,
  summary: "approve",
  outflows: [],
  approvals: [{ kind: "delegate-revoked", account: TA, verified: false }],
  fee: undefined,
  warnings: [],
  verifiability: "full",
};

const prepared = (intent: DisplayIntent): PreparedRequest => ({
  txId: "tx-1",
  account: ACCOUNT,
  network: intent.network,
  intent,
  signer: FROM,
  checks: [],
  staleReason: () => undefined,
  submit: async () => Promise.reject(new Error("unused")),
  release: () => undefined,
});

const world = () => {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const openStore = async () => Promise.resolve(createMemoryEngineStore(backing));
  const logger = { warn: () => undefined };
  const transactions = {
    getState: () => ({ txs: {} }),
    prepareEvmInternal: async () => Promise.resolve(prepared(evmRevokeIntent)),
    prepareSolanaRevoke: async () => Promise.resolve(prepared(solanaRevokeIntent)),
  } as unknown as TransactionController;
  const addressBook = new AddressBookController({
    openStore,
    random: (n) => new Uint8Array(n),
    now: () => 0,
    logger,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    tokens: tokensStub,
    simulateSolana: simulateSolanaStub,
    transactions,
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    addressBook,
    openStore,
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(1),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  return { requests, addressBook };
};

describe("revocation requests", () => {
  it("evm-revoke prepares a pending request whose display carries the revocation", async () => {
    const w = world();
    await w.addressBook.init();
    await w.requests.init();
    const request = await w.requests.prepare({
      method: "evm-revoke",
      account: ACCOUNT,
      network: SEPOLIA,
      targets: [{ kind: "erc20", token: TOKEN, spender: SPENDER }],
      fee: "normal",
    });
    expect(request.display).toMatchObject({ approvals: evmRevokeIntent.approvals });
    /* A revocation grants nothing: no allowance/operator/permit findings may appear. */
    expect(request.risk.map((r) => r.code)).toStrictEqual([]);
    expect(request.origin).toStrictEqual({ kind: "internal" });
  });

  it("solana-revoke prepares a pending request whose display carries the revoked delegates", async () => {
    const w = world();
    await w.addressBook.init();
    await w.requests.init();
    const request = await w.requests.prepare({
      method: "solana-revoke",
      account: SOL_ACCOUNT,
      network: SOL_NET,
      tokenAccounts: [TA],
      fee: "normal",
    });
    expect(request.display).toMatchObject({
      approvals: [{ kind: "delegate-revoked", account: TA }],
    });
    expect(request.risk.map((r) => r.code)).toStrictEqual([]);
    expect(request.origin).toStrictEqual({ kind: "internal" });
  });
});

describe("revocation sign-log labels", () => {
  it("evm-revoke and solana-revoke entries round-trip", async () => {
    const store = createMemoryEngineStore();
    const log = createSignLog({ warn: () => undefined });
    log.open(store);
    const base: SignLogEntry = {
      id: "req-rev",
      at: 1,
      origin: { kind: "internal" },
      method: "evm-revoke",
      account: ACCOUNT,
      network: SEPOLIA,
      summary: "approve",
      verification: "verified",
      checks: [],
      risk: [],
      outcome: "submitted",
    };
    await log.append(base);
    await log.append({
      ...base,
      id: "req-rev-sol",
      at: 2,
      method: "solana-revoke",
      account: SOL_ACCOUNT,
      network: SOL_NET,
      summary: "approve",
    });
    const entries = await log.list();
    expect(entries.map((e) => e.method)).toStrictEqual(["solana-revoke", "evm-revoke"]);
    log.close();
  });
});
