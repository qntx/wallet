import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

import type {
  AccountAuthority,
  AssetFlow,
  Fiat24Action,
  HyperliquidAction,
  MessageContent,
  OffchainOrder,
  PolymarketContent,
  SafeTransaction,
  SeaportOrder,
  StakeAction,
  TokenAuthorization,
} from "@qntx/wallet-chains";
import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";

import { AddressBookController } from "../src/addresses/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { RequestInput } from "../src/requests/controller.ts";
import { assessIntentRecipients, intentRecipients } from "../src/requests/risk.ts";
import type { PreparedBitcoinPsbt } from "../src/requests/types.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type {
  AccountRef,
  DisplayIntent,
  PreparedRequest,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const SEPOLIA = "eip155:11155111";
const SOLANA_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON_NET = "tron:728126428";
const BITCOIN_NET = "bip122:000000000019d6689c085ae165831e93";
const ORIGIN = { kind: "browser", origin: "https://app.example" } as const;

const EVM_ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44",
};
const TRON_ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "tron.bip44",
};
const SOL_ACCOUNT = { walletId: "w", groupIndex: 0, address: "11111111111111111111111111111112" };
const BTC_ACCOUNT_REF: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "btc.bip84",
};

/** EVM lookalike of a saved contact: same first/last four characters, different address. */
const EVM_SIGNER = "0x4D2A422dB44144996E855ce15FB581a477dbB947";
const EVM_KNOWN = "0x52908400098527886E0F7030069857D2E4169EE7";
const EVM_LOOKALIKE = "0x5290aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9EE7";
const TRON_SIGNER = "TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ";
const TRON_KNOWN = `TCLB${"9".repeat(26)}QCLQ`;
const TRON_LOOKALIKE = `TCLB${"8".repeat(26)}QCLQ`;
const SOL_DEST = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const SOL_KNOWN = `8qbH${"9".repeat(36)}VfeR`;

const baseIntent = (family: DisplayIntent["family"], network: string): DisplayIntent =>
  ({
    family,
    network,
    summary: "contract-call",
    outflows: [],
    approvals: [],
    fee: undefined,
    warnings: [],
    verifiability: "full",
  }) as unknown as DisplayIntent;

const evmIntentTo = (to: string): DisplayIntent => ({
  ...baseIntent("evm", SEPOLIA),
  summary: "transfer",
  outflows: [{ to, amount: { asset: "native", amount: "1", decimals: 18 }, verified: true }],
});

const tronIntentTo = (to: string): DisplayIntent => ({
  ...baseIntent("tron", TRON_NET),
  summary: "transfer",
  outflows: [{ to, amount: { asset: "trx", amount: "1000000", decimals: 6 }, verified: true }],
});

const solIntentTo = (to: string): DisplayIntent => ({
  ...baseIntent("solana", SOLANA_NET),
  summary: "transfer",
  outflows: [{ to, amount: { asset: "lamports", amount: "1000000", decimals: 9 }, verified: true }],
});

const btcIntentTo = (to: string): DisplayIntent => ({
  ...baseIntent("bitcoin", BITCOIN_NET),
  summary: "transfer",
  outflows: [{ to, amount: { asset: "sats", amount: "1000", decimals: 8 }, verified: true }],
});

/** A typed-data intent whose `message` carries the given recognized document slot. */
const typedIntent = (
  family: "evm" | "tron",
  network: string,
  slot: Record<string, unknown>,
): DisplayIntent => ({
  ...baseIntent(family, network),
  summary: "message",
  message: { kind: "typed-data", primaryType: "Doc", domain: {}, data: {}, ...slot },
});

const trackedTo = (
  family: DisplayIntent["family"],
  network: string,
  to: string,
): TrackedTransaction => {
  const intent =
    family === "evm"
      ? evmIntentTo(to)
      : family === "tron"
        ? tronIntentTo(to)
        : family === "solana"
          ? solIntentTo(to)
          : btcIntentTo(to);
  return {
    id: "t-known",
    family,
    network,
    account: "w",
    hash: "h",
    state: "confirmed",
    intent,
    nonce: 0,
    submittedAt: 0,
    error: undefined,
  };
};

/** A legacy Solana transaction: System Program transfer of 1_000_000 lamports signer → `to`. */
const solanaTx = (signer: string, to: string): Uint8Array => {
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
              { address: address(signer), role: AccountRole.WRITABLE_SIGNER },
              { address: address(to), role: AccountRole.WRITABLE },
            ],
            data,
          },
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: address("11111111111111111111111111111111"),
              lastValidBlockHeight: 1000n,
            } as never,
            setTransactionMessageFeePayer(
              address(signer),
              createTransactionMessage({ version: "legacy" }),
            ),
          ),
        ),
      ),
    ),
  );
  return new Uint8Array([1, ...new Uint8Array(64), ...message]);
};

const emptyPrepared = (
  account: AccountRef,
  network: string,
  intent: DisplayIntent,
  signer?: string,
): PreparedRequest => ({
  txId: "tx-prepared",
  account,
  network,
  intent,
  checks: [],
  ...(signer === undefined ? {} : { signer }),
  staleReason: () => undefined,
  submit: async () => Promise.reject(new Error("not submitted in this test")),
  release: () => undefined,
});

const rig = (over: {
  readonly known?: ReadonlyArray<{
    family: DisplayIntent["family"];
    network: string;
    address: string;
  }>;
  readonly prepareDapp?: (
    account: AccountRef,
    request: unknown,
  ) => Promise<Record<string, unknown>>;
  readonly prepareDappTron?: (
    account: AccountRef,
    request: unknown,
  ) => Promise<Record<string, unknown>>;
  readonly prepareSend?: (p: { to: string }, requestId: string) => Promise<PreparedRequest>;
  readonly prepareEvmInternal?: (input: unknown, requestId: string) => Promise<PreparedRequest>;
  readonly prepareSolanaSwap?: (input: unknown, requestId: string) => Promise<PreparedRequest>;
}) => {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const openStore = async () => Promise.resolve(createMemoryEngineStore(backing));
  const logger = { warn: () => undefined };
  const unwired = (name: string) => async () => Promise.reject(new Error(`${name} not wired`));
  const transactions = {
    getState: () => ({
      txs: Object.fromEntries(
        (over.known ?? []).map((k) => ["t", trackedTo(k.family, k.network, k.address)]),
      ),
    }),
    prepareDapp: over.prepareDapp ?? unwired("evm-sign"),
    prepareDappTron: over.prepareDappTron ?? unwired("tron-sign"),
    prepareSend: over.prepareSend ?? unwired("send"),
    prepareEvmInternal: over.prepareEvmInternal ?? unwired("internal"),
    prepareSolanaSwap: over.prepareSolanaSwap ?? unwired("solana-swap"),
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
    bitcoinPrepare: async (_a: unknown, _n: unknown, psbts: ReadonlyArray<{ psbt: Uint8Array }>) =>
      Promise.resolve(
        psbts.map(({ psbt }): PreparedBitcoinPsbt => ({
          request: {
            kind: "bitcoin.psbt",
            network: BITCOIN_NET,
            account: BTC_ACCOUNT_REF,
            psbt,
            sign: [{ index: 0, template: "btc.bip84" }],
          },
          ownScripts: new Set(),
          inputs: [],
        })),
      ),
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

const codes = (request: { risk: ReadonlyArray<{ code: string }> }): ReadonlyArray<string> =>
  request.risk.map((r) => r.code);

const RECIPIENT_FINDINGS = new Set(["address-poisoning", "first-recipient"]);

const recipientFindings = (request: {
  risk: ReadonlyArray<{ code: string }>;
}): ReadonlyArray<string> => codes(request).filter((c) => RECIPIENT_FINDINGS.has(c));

describe("every decoded recipient is assessed", () => {
  it("an evm-sign transaction paying a lookalike of a known address is flagged", async () => {
    const { requests } = rig({
      known: [{ family: "evm", network: SEPOLIA, address: EVM_KNOWN }],
      prepareDapp: async (account) =>
        Promise.resolve({
          ...emptyPrepared(account, SEPOLIA, evmIntentTo(EVM_LOOKALIKE), EVM_SIGNER),
          txId: "tx-evm",
        }),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "evm-sign",
      origin: ORIGIN,
      account: EVM_ACCOUNT,
      network: SEPOLIA,
      request: {
        kind: "evm.transaction",
        network: SEPOLIA,
        account: EVM_ACCOUNT,
        tx: {
          type: "legacy",
          chainId: 11155111,
          nonce: 0,
          gas: "0x5208",
          gasPrice: "0x1",
          value: "0x1",
          data: "0x",
          to: EVM_LOOKALIKE,
        },
      },
    });
    expect(codes(request)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });

  it("an evm-sign transaction paying the signer is not flagged", async () => {
    const { requests } = rig({
      prepareDapp: async (account) =>
        Promise.resolve({
          ...emptyPrepared(account, SEPOLIA, evmIntentTo(EVM_SIGNER), EVM_SIGNER),
          txId: "tx-evm",
        }),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "evm-sign",
      origin: ORIGIN,
      account: EVM_ACCOUNT,
      network: SEPOLIA,
      request: {
        kind: "evm.transaction",
        network: SEPOLIA,
        account: EVM_ACCOUNT,
        tx: {
          type: "legacy",
          chainId: 11155111,
          nonce: 0,
          gas: "0x5208",
          gasPrice: "0x1",
          value: "0x1",
          data: "0x",
          to: EVM_SIGNER,
        },
      },
    });
    expect(recipientFindings(request)).toStrictEqual([]);
  });

  it("a tron-sign transaction paying a lookalike of a known address is flagged", async () => {
    const { requests } = rig({
      known: [{ family: "tron", network: TRON_NET, address: TRON_KNOWN }],
      prepareDappTron: async (ref) =>
        Promise.resolve(emptyPrepared(ref, TRON_NET, tronIntentTo(TRON_LOOKALIKE), TRON_SIGNER)),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "tron-sign",
      origin: ORIGIN,
      account: TRON_ACCOUNT,
      network: TRON_NET,
      request: {
        kind: "tron.transaction",
        network: TRON_NET,
        account: TRON_ACCOUNT,
        rawData: new Uint8Array(8),
      },
    });
    expect(codes(request)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });

  it("an order's receive recipient on evm typed data is flagged", async () => {
    const { requests } = rig({
      known: [{ family: "evm", network: SEPOLIA, address: EVM_KNOWN }],
      prepareDapp: async (account) =>
        Promise.resolve({
          account,
          network: SEPOLIA,
          signer: EVM_SIGNER,
          intent: typedIntent("evm", SEPOLIA, {
            order: {
              protocol: "0x",
              maker: EVM_SIGNER,
              give: { asset: "0xa", amount: "1" },
              receive: [{ recipient: EVM_LOOKALIKE, amount: { asset: "0xb", amount: "1" } }],
              partialFill: false,
            },
          }),
          checks: [],
          staleReason: () => undefined,
          release: () => undefined,
          submit: async () =>
            Promise.resolve({ kind: "evm.typed-data" as const, signature: "0x1234" }),
        }),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "evm-sign",
      origin: ORIGIN,
      account: EVM_ACCOUNT,
      network: SEPOLIA,
      request: {
        kind: "evm.typed-data",
        network: SEPOLIA,
        account: EVM_ACCOUNT,
        typedData: "{}",
      },
    });
    expect(codes(request)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });

  it("an order naming the signer as its receive recipient is not flagged", async () => {
    const { requests } = rig({
      prepareDapp: async (account) =>
        Promise.resolve({
          account,
          network: SEPOLIA,
          signer: EVM_SIGNER,
          intent: typedIntent("evm", SEPOLIA, {
            order: {
              protocol: "0x",
              maker: EVM_SIGNER,
              give: { asset: "0xa", amount: "1" },
              receive: [{ recipient: EVM_SIGNER, amount: { asset: "0xb", amount: "1" } }],
              partialFill: false,
            },
          }),
          checks: [],
          staleReason: () => undefined,
          release: () => undefined,
          submit: async () =>
            Promise.resolve({ kind: "evm.typed-data" as const, signature: "0x1234" }),
        }),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "evm-sign",
      origin: ORIGIN,
      account: EVM_ACCOUNT,
      network: SEPOLIA,
      request: {
        kind: "evm.typed-data",
        network: SEPOLIA,
        account: EVM_ACCOUNT,
        typedData: "{}",
      },
    });
    expect(recipientFindings(request)).toStrictEqual([]);
  });

  it("a seaport consideration recipient on evm typed data is flagged", async () => {
    const { requests } = rig({
      known: [{ family: "evm", network: SEPOLIA, address: EVM_KNOWN }],
      prepareDapp: async (account) =>
        Promise.resolve({
          account,
          network: SEPOLIA,
          signer: EVM_SIGNER,
          intent: typedIntent("evm", SEPOLIA, {
            seaport: {
              offerer: EVM_SIGNER,
              zone: "0x0",
              startTime: 1,
              endTime: 2,
              offer: [
                {
                  kind: "native",
                  token: "0x0000000000000000000000000000000000000000",
                  identifier: "0",
                  startAmount: { asset: "native", amount: "1" },
                  endAmount: { asset: "native", amount: "1" },
                },
              ],
              consideration: [
                {
                  kind: "native",
                  token: "0x0000000000000000000000000000000000000000",
                  identifier: "0",
                  startAmount: { asset: "native", amount: "1" },
                  endAmount: { asset: "native", amount: "1" },
                  recipient: EVM_LOOKALIKE,
                },
                {
                  kind: "erc20",
                  token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
                  identifier: "0",
                  startAmount: { asset: "0x1c", amount: "1" },
                  endAmount: { asset: "0x1c", amount: "1" },
                  recipient: EVM_SIGNER,
                },
              ],
            },
          }),
          checks: [],
          staleReason: () => undefined,
          release: () => undefined,
          submit: async () =>
            Promise.resolve({ kind: "evm.typed-data" as const, signature: "0x1234" }),
        }),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "evm-sign",
      origin: ORIGIN,
      account: EVM_ACCOUNT,
      network: SEPOLIA,
      request: {
        kind: "evm.typed-data",
        network: SEPOLIA,
        account: EVM_ACCOUNT,
        typedData: "{}",
      },
    });
    expect(codes(request)).toContain("address-poisoning");
    expect(codes(request)).toContain("first-recipient");
  });

  it("a hyperliquid usd-send destination on evm typed data is flagged", async () => {
    const { requests } = rig({
      known: [{ family: "evm", network: SEPOLIA, address: EVM_KNOWN }],
      prepareDapp: async (account) =>
        Promise.resolve({
          account,
          network: SEPOLIA,
          signer: EVM_SIGNER,
          intent: typedIntent("evm", SEPOLIA, {
            hyperliquid: {
              kind: "usd-send",
              chain: "Mainnet",
              destination: EVM_LOOKALIKE,
              amount: "1",
            },
          }),
          checks: [],
          staleReason: () => undefined,
          release: () => undefined,
          submit: async () =>
            Promise.resolve({ kind: "evm.typed-data" as const, signature: "0x1234" }),
        }),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "evm-sign",
      origin: ORIGIN,
      account: EVM_ACCOUNT,
      network: SEPOLIA,
      request: {
        kind: "evm.typed-data",
        network: SEPOLIA,
        account: EVM_ACCOUNT,
        typedData: "{}",
      },
    });
    expect(codes(request)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });

  it("an order's receive recipient on tron typed data is flagged", async () => {
    const { requests } = rig({
      known: [{ family: "tron", network: TRON_NET, address: TRON_KNOWN }],
      prepareDappTron: async (ref) =>
        Promise.resolve({
          account: ref,
          network: TRON_NET,
          signer: TRON_SIGNER,
          intent: typedIntent("tron", TRON_NET, {
            order: {
              protocol: "0x",
              maker: TRON_SIGNER,
              give: { asset: "t", amount: "1" },
              receive: [{ recipient: TRON_LOOKALIKE, amount: { asset: "u", amount: "1" } }],
              partialFill: false,
            },
          }),
          checks: [],
          staleReason: () => undefined,
          release: () => undefined,
          submit: async () =>
            Promise.resolve({ kind: "tron.typed-data" as const, signature: new Uint8Array(65) }),
        }),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "tron-sign",
      origin: ORIGIN,
      account: TRON_ACCOUNT,
      network: TRON_NET,
      request: {
        kind: "tron.typed-data",
        network: TRON_NET,
        account: TRON_ACCOUNT,
        typedData: "{}",
      },
    });
    expect(codes(request)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });

  it("a solana-sign transaction paying a lookalike of a known address is flagged", async () => {
    const { requests } = rig({
      known: [{ family: "solana", network: SOLANA_NET, address: SOL_KNOWN }],
    });
    await requests.init();
    const request = await requests.prepare({
      method: "solana-sign",
      origin: ORIGIN,
      account: SOL_ACCOUNT,
      network: SOLANA_NET,
      request: {
        kind: "transactions",
        transactions: [solanaTx(SOL_ACCOUNT.address, SOL_DEST)],
        send: true,
      },
    });
    expect(codes(request)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });

  it("a solana-sign transaction paying the signer is not flagged", async () => {
    const { requests } = rig({});
    await requests.init();
    const request = await requests.prepare({
      method: "solana-sign",
      origin: ORIGIN,
      account: SOL_ACCOUNT,
      network: SOLANA_NET,
      request: {
        kind: "transactions",
        transactions: [solanaTx(SOL_ACCOUNT.address, SOL_ACCOUNT.address)],
        send: false,
      },
    });
    expect(recipientFindings(request)).toStrictEqual([]);
  });

  it("a send to a lookalike of a known address is flagged", async () => {
    const { requests } = rig({
      known: [{ family: "evm", network: SEPOLIA, address: EVM_KNOWN }],
      prepareSend: async (p, _requestId) =>
        Promise.resolve(emptyPrepared(EVM_ACCOUNT, SEPOLIA, evmIntentTo(p.to))),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "send",
      account: EVM_ACCOUNT,
      network: SEPOLIA,
      to: EVM_LOOKALIKE,
      amount: 1n,
      fee: "normal",
    });
    expect(codes(request)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });

  it("a send to the signer's own address is not flagged", async () => {
    const { requests } = rig({
      prepareSend: async (p, _requestId) =>
        Promise.resolve(emptyPrepared(EVM_ACCOUNT, SEPOLIA, evmIntentTo(p.to), EVM_SIGNER)),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "send",
      account: EVM_ACCOUNT,
      network: SEPOLIA,
      to: EVM_SIGNER,
      amount: 1n,
      fee: "normal",
    });
    expect(recipientFindings(request)).toStrictEqual([]);
  });

  it("a burned output names no recipient", async () => {
    const burned = {
      ...baseIntent("bitcoin", BITCOIN_NET),
      summary: "transfer",
      outflows: [
        {
          to: "6a24aa21a9ed",
          amount: { asset: "sats", amount: "546", decimals: 8 },
          verified: true,
          burn: true as const,
        },
      ],
    } as DisplayIntent;
    const { requests } = rig({
      prepareSend: async (_p, _requestId) =>
        Promise.resolve(emptyPrepared(BTC_ACCOUNT_REF, BITCOIN_NET, burned)),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "send",
      account: BTC_ACCOUNT_REF,
      network: BITCOIN_NET,
      to: "bc1qexample",
      amount: 1n,
      fee: "normal",
    });
    expect(recipientFindings(request)).toStrictEqual([]);
  });

  it("an internal method paying a lookalike of a known address is flagged", async () => {
    const { requests } = rig({
      known: [{ family: "evm", network: SEPOLIA, address: EVM_KNOWN }],
      prepareEvmInternal: async (_input, _requestId) =>
        Promise.resolve(emptyPrepared(EVM_ACCOUNT, SEPOLIA, evmIntentTo(EVM_LOOKALIKE))),
    });
    await requests.init();
    const request = await requests.prepare({
      method: "evm-batch",
      account: EVM_ACCOUNT,
      network: SEPOLIA,
      calls: [{ to: EVM_LOOKALIKE, value: 1n, data: "0x" }],
      fee: "normal",
    });
    expect(codes(request)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });
});

/* ---------------------------------------------------------------------------
 * The structural guard: every slot of a decoded intent is classified once —
 * either it can name a recipient of value, or it cannot. Adding a field or
 * action kind without classifying it is a compile error; marking it
 * "recipient" without a fixture below is one too.
 * ------------------------------------------------------------------------ */

type Slot = "recipient" | "none";

const INTENT_SLOTS = {
  family: "none",
  network: "none",
  summary: "none",
  outflows: "recipient",
  approvals: "none",
  minimumReceived: "recipient",
  fee: "none",
  staking: "recipient",
  bridge: "recipient",
  hyperliquidDeposit: "recipient",
  fiat24: "none",
  warnings: "none",
  message: "recipient",
  verifiability: "none",
  delegation: "none",
  calls: "recipient",
  contract: "none",
  programs: "none",
  programAuthority: "none",
  tron: "none",
  blind: "none",
} satisfies Record<keyof DisplayIntent, Slot>;

const MESSAGE_SLOTS = {
  kind: "none",
  primaryType: "none",
  domain: "none",
  data: "none",
  seaport: "recipient",
  order: "recipient",
  safe: "recipient",
  hyperliquid: "recipient",
  polymarket: "recipient",
  authorization: "recipient",
  authority: "none",
  farcaster: "none",
  fields: "none",
} satisfies Record<keyof Extract<MessageContent, { kind: "typed-data" }>, Slot>;

const STAKE_SLOTS = {
  create: "none",
  delegate: "none",
  deactivate: "none",
  withdraw: "recipient",
  split: "none",
  "lido-submit": "none",
  "lido-request": "recipient",
  "lido-claim": "none",
  "tron-freeze": "none",
  "tron-unfreeze": "none",
  "tron-delegate": "recipient",
  "tron-undelegate": "none",
  "tron-withdraw-unfrozen": "none",
  "tron-cancel-unfreeze": "none",
  "tron-claim-rewards": "none",
  "tron-vote": "none",
} satisfies Record<StakeAction["kind"], Slot>;

const HYPERLIQUID_SLOTS = {
  "usd-send": "recipient",
  withdraw: "recipient",
  "spot-send": "recipient",
  "usd-class-transfer": "none",
  "send-asset": "recipient",
  "staking-deposit": "none",
  "staking-withdraw": "none",
  "token-delegate": "none",
  "approve-agent": "none",
  "approve-builder-fee": "none",
} satisfies Record<HyperliquidAction["kind"], Slot>;

const POLYMARKET_SLOTS = {
  order: "none",
  auth: "none",
  batch: "recipient",
} satisfies Record<PolymarketContent["kind"], Slot>;

const AUTHORIZATION_SLOTS = {
  transfer: "recipient",
  receive: "recipient",
  cancel: "none",
} satisfies Record<TokenAuthorization["kind"], Slot>;

const FIAT24_SLOTS = {
  exchange: "none",
  payout: "none",
  "top-up": "none",
  "open-account": "none",
  "session-grant": "none",
} satisfies Record<Fiat24Action["kind"], Slot>;

const AUTHORITY_SLOTS = {
  morpho: "none",
  "aave-credit": "none",
  "snapshot-alias": "none",
} satisfies Record<AccountAuthority["kind"], Slot>;

const ORDER_SLOTS = {
  protocol: "none",
  maker: "none",
  give: "none",
  receive: "recipient",
  expiry: "none",
  partialFill: "none",
  allowedSender: "none",
  exclusiveFiller: "none",
} satisfies Record<keyof OffchainOrder, Slot>;

const SEAPORT_SLOTS = {
  offerer: "none",
  zone: "none",
  startTime: "none",
  endTime: "none",
  offer: "none",
  consideration: "recipient",
} satisfies Record<keyof SeaportOrder, Slot>;

const SAFE_SLOTS = {
  safe: "none",
  nonce: "none",
  operation: "none",
  to: "recipient",
  value: "none",
  data: "none",
  calls: "recipient",
  refund: "recipient",
} satisfies Record<keyof SafeTransaction, Slot>;

const FLOW_SLOTS = {
  to: "recipient",
  amount: "none",
  verified: "none",
  burn: "none",
  tokenAccount: "none",
  fiat24: "recipient",
  name: "none",
} satisfies Record<keyof AssetFlow, Slot>;

/**
 * Every request method either runs recipient assessment or provably names no recipient: pay/zap
 * move value inside prepared Spark actions (the Spark receiver itself is assessed), Lightning and
 * exits name no recipient to check, and replacements replay the already-assessed original intent.
 */
const REQUEST_METHODS = {
  send: "assessed",
  "speed-up": "no-recipient",
  cancel: "no-recipient",
  cpfp: "no-recipient",
  "evm-delegation": "assessed",
  "evm-batch": "assessed",
  "evm-approve": "assessed",
  "evm-cctp": "assessed",
  "evm-swap": "assessed",
  "evm-bridge": "assessed",
  "evm-nft-send": "assessed",
  "solana-core-send": "assessed",
  "evm-lido": "assessed",
  "solana-stake": "assessed",
  "solana-swap": "assessed",
  "tron-stake": "assessed",
  "tron-approve": "assessed",
  pay: "assessed",
  zap: "no-recipient",
  "evm-sign": "assessed",
  "tron-sign": "assessed",
  "nostr-sign": "no-recipient",
  "webln-invoice": "no-recipient",
  "watch-asset": "no-recipient",
  "solana-sign": "assessed",
  "bitcoin-sign": "assessed",
  "spark-deposit": "no-recipient",
  "spark-exit": "no-recipient",
} satisfies Record<RequestInput["method"], "assessed" | "no-recipient">;

type RecipientSlots<T extends Record<string, Slot>> = keyof {
  [K in keyof T as T[K] extends "recipient" ? K : never]: 0;
};

type SlotFixture = {
  readonly build: (to: string) => DisplayIntent;
  /** False where the slot's recipient is not address-shaped (a Fiat24 id never looks alike). */
  readonly poisoning?: boolean;
};

const AMT = { asset: "0xasset", amount: "1" };

const typedSlot = (slot: Record<string, unknown>): DisplayIntent => ({
  ...baseIntent("evm", SEPOLIA),
  summary: "message",
  message: { kind: "typed-data", primaryType: "Doc", domain: {}, data: {}, ...slot },
});

const orderSlot = (order: OffchainOrder): DisplayIntent => typedSlot({ order });
const seaportSlot = (seaport: SeaportOrder): DisplayIntent => typedSlot({ seaport });
const safeSlot = (safe: SafeTransaction): DisplayIntent => typedSlot({ safe });
const hyperliquidSlot = (hyperliquid: HyperliquidAction): DisplayIntent =>
  typedSlot({ hyperliquid });
const polymarketSlot = (polymarket: PolymarketContent): DisplayIntent => typedSlot({ polymarket });
const authorizationSlot = (authorization: TokenAuthorization): DisplayIntent =>
  typedSlot({ authorization });

const order = (receive: OffchainOrder["receive"]): OffchainOrder => ({
  protocol: "0x",
  maker: EVM_SIGNER,
  give: AMT,
  receive,
  partialFill: false,
});

const seaportItem = (recipient: string): SeaportOrder["consideration"][number] => ({
  kind: "erc20",
  token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  identifier: "0",
  startAmount: AMT,
  endAmount: AMT,
  recipient,
});

const seaportOrder = (consideration: SeaportOrder["consideration"] = []): SeaportOrder => ({
  offerer: EVM_SIGNER,
  zone: EVM_SIGNER,
  startTime: 1,
  endTime: 2,
  offer: [
    {
      kind: "erc20",
      token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      identifier: "0",
      startAmount: AMT,
      endAmount: AMT,
    },
  ],
  consideration,
});

const safeTx = (over: Partial<SafeTransaction>): SafeTransaction => ({
  safe: EVM_SIGNER,
  nonce: "0",
  operation: "call",
  to: EVM_SIGNER,
  value: "0",
  data: "0x",
  calls: [],
  ...over,
});

const INTENT_FIXTURES: Record<RecipientSlots<typeof INTENT_SLOTS>, SlotFixture> = {
  outflows: { build: (to) => evmIntentTo(to) },
  minimumReceived: {
    build: (to) => ({
      ...baseIntent("evm", SEPOLIA),
      minimumReceived: [{ to, amount: AMT }],
    }),
  },
  bridge: {
    build: (to) => ({
      ...baseIntent("evm", SEPOLIA),
      bridge: { destinationNetwork: "eip155:1", fillDeadline: 1, refundTo: to },
    }),
  },
  hyperliquidDeposit: {
    build: (to) => ({
      ...baseIntent("evm", SEPOLIA),
      hyperliquidDeposit: { recipient: to, dex: "perps", maxFee: AMT },
    }),
  },
  staking: {
    build: (to) => ({
      ...baseIntent("evm", SEPOLIA),
      staking: [{ kind: "withdraw", account: "a", to, lamports: "1" }],
    }),
  },
  message: { build: (to) => orderSlot(order([{ recipient: to, amount: AMT }])) },
  calls: { build: (to) => ({ ...baseIntent("evm", SEPOLIA), calls: [evmIntentTo(to)] }) },
};

const MESSAGE_FIXTURES: Record<RecipientSlots<typeof MESSAGE_SLOTS>, SlotFixture> = {
  order: { build: (to) => orderSlot(order([{ recipient: to, amount: AMT }])) },
  seaport: { build: (to) => seaportSlot(seaportOrder([seaportItem(to)])) },
  safe: { build: (to) => safeSlot(safeTx({ to, value: "1" })) },
  hyperliquid: {
    build: (to) =>
      hyperliquidSlot({ kind: "usd-send", chain: "Mainnet", destination: to, amount: "1" }),
  },
  polymarket: {
    build: (to) =>
      polymarketSlot({
        kind: "batch",
        wallet: EVM_SIGNER,
        nonce: "0",
        deadline: 1,
        calls: [evmIntentTo(to)],
      }),
  },
  authorization: {
    build: (to) => authorizationSlot({ kind: "transfer", to, amount: AMT, validAfter: 0 }),
  },
};

const STAKE_FIXTURES: Record<RecipientSlots<typeof STAKE_SLOTS>, SlotFixture> = {
  withdraw: {
    build: (to) => ({
      ...baseIntent("solana", SOLANA_NET),
      staking: [{ kind: "withdraw", account: "a", to, lamports: "1" }],
    }),
  },
  "lido-request": {
    build: (to) => ({
      ...baseIntent("evm", SEPOLIA),
      staking: [{ kind: "lido-request", token: "0xt", amount: AMT, owner: to }],
    }),
  },
  "tron-delegate": {
    build: (to) => ({
      ...baseIntent("tron", TRON_NET),
      staking: [{ kind: "tron-delegate", receiver: to, amount: AMT, resource: "energy" }],
    }),
  },
};

const HYPERLIQUID_FIXTURES: Record<RecipientSlots<typeof HYPERLIQUID_SLOTS>, SlotFixture> = {
  "usd-send": {
    build: (to) =>
      hyperliquidSlot({ kind: "usd-send", chain: "Mainnet", destination: to, amount: "1" }),
  },
  withdraw: {
    build: (to) =>
      hyperliquidSlot({ kind: "withdraw", chain: "Mainnet", destination: to, amount: "1" }),
  },
  "spot-send": {
    build: (to) =>
      hyperliquidSlot({
        kind: "spot-send",
        chain: "Mainnet",
        destination: to,
        token: "PURR:0x1",
        amount: "1",
      }),
  },
  "send-asset": {
    build: (to) =>
      hyperliquidSlot({
        kind: "send-asset",
        chain: "Mainnet",
        destination: to,
        sourceDex: "",
        destinationDex: "spot",
        token: "HYPE",
        amount: "1",
      }),
  },
};

const POLYMARKET_FIXTURES: Record<RecipientSlots<typeof POLYMARKET_SLOTS>, SlotFixture> = {
  batch: {
    build: (to) =>
      polymarketSlot({
        kind: "batch",
        wallet: EVM_SIGNER,
        nonce: "0",
        deadline: 1,
        calls: [evmIntentTo(to)],
      }),
  },
};

const AUTHORIZATION_FIXTURES: Record<RecipientSlots<typeof AUTHORIZATION_SLOTS>, SlotFixture> = {
  transfer: {
    build: (to) => authorizationSlot({ kind: "transfer", to, amount: AMT, validAfter: 0 }),
  },
  receive: {
    build: (to) => authorizationSlot({ kind: "receive", to, amount: AMT, validAfter: 0 }),
  },
};

const ORDER_FIXTURES: Record<RecipientSlots<typeof ORDER_SLOTS>, SlotFixture> = {
  receive: { build: (to) => orderSlot(order([{ recipient: to, amount: AMT }])) },
};

const SEAPORT_FIXTURES: Record<RecipientSlots<typeof SEAPORT_SLOTS>, SlotFixture> = {
  consideration: { build: (to) => seaportSlot(seaportOrder([seaportItem(to)])) },
};

const SAFE_FIXTURES: Record<RecipientSlots<typeof SAFE_SLOTS>, SlotFixture> = {
  to: { build: (to) => safeSlot(safeTx({ to, value: "1" })) },
  calls: { build: (to) => safeSlot(safeTx({ calls: [evmIntentTo(to)] })) },
  refund: {
    build: (to) => safeSlot(safeTx({ refund: { receiver: to, gasPrice: AMT, amount: AMT } })),
  },
};

const FLOW_FIXTURES: Record<RecipientSlots<typeof FLOW_SLOTS>, SlotFixture> = {
  to: { build: (to) => evmIntentTo(to) },
  fiat24: {
    build: (to) => ({
      ...baseIntent("evm", SEPOLIA),
      outflows: [{ to: "0xusdc", amount: AMT, verified: true, fiat24: { account: to } }],
    }),
    poisoning: false,
  },
};

const ALL_FIXTURES: ReadonlyArray<readonly [string, Record<string, SlotFixture>]> = [
  ["intent", INTENT_FIXTURES],
  ["message", MESSAGE_FIXTURES],
  ["staking", STAKE_FIXTURES],
  ["hyperliquid", HYPERLIQUID_FIXTURES],
  ["polymarket", POLYMARKET_FIXTURES],
  ["authorization", AUTHORIZATION_FIXTURES],
  ["order", ORDER_FIXTURES],
  ["seaport", SEAPORT_FIXTURES],
  ["safe", SAFE_FIXTURES],
  ["flow", FLOW_FIXTURES],
];

const recipientCodes = (intent: DisplayIntent, self: string | undefined = EVM_SIGNER) =>
  assessIntentRecipients(intent, self, [EVM_KNOWN]).map((f) => f.code);

const CASES = ALL_FIXTURES.flatMap(([table, fixtures]) =>
  Object.entries(fixtures).map(([slot, fixture]) => ({
    name: `${table}.${slot}`,
    build: fixture.build,
    expected:
      fixture.poisoning === false
        ? (["first-recipient"] as const)
        : (["address-poisoning", "first-recipient"] as const),
    selfSafe: fixture.poisoning !== false,
  })),
);

describe("every recipient slot is assessed", () => {
  it.each(CASES)("%s: a lookalike of a known address is flagged", (c) => {
    expect(recipientCodes(c.build(EVM_LOOKALIKE))).toStrictEqual([...c.expected]);
  });

  it.each(CASES.filter((c) => c.selfSafe))("%s: the signer's own address is not flagged", (c) => {
    expect(recipientCodes(c.build(EVM_SIGNER))).toStrictEqual([]);
  });

  it("the request-method table marks every assessed method", () => {
    const assessed = Object.entries(REQUEST_METHODS)
      .filter(([, kind]) => kind === "assessed")
      .map(([method]) => method)
      .toSorted();
    expect(assessed).toStrictEqual(
      [
        "bitcoin-sign",
        "evm-approve",
        "evm-batch",
        "evm-bridge",
        "evm-cctp",
        "evm-delegation",
        "evm-lido",
        "evm-nft-send",
        "evm-sign",
        "evm-swap",
        "pay",
        "send",
        "solana-core-send",
        "solana-sign",
        "solana-stake",
        "solana-swap",
        "tron-approve",
        "tron-sign",
        "tron-stake",
      ].toSorted(),
    );
  });

  it("a fiat24 flow's recipient is the account it names, not the token contract", () => {
    const intent = {
      ...baseIntent("evm", SEPOLIA),
      outflows: [{ to: "0xusdc", amount: AMT, verified: true, fiat24: { account: "42" } }],
    } as DisplayIntent;
    expect(intentRecipients(intent)).toStrictEqual(["fiat24:account:42"]);
    expect(assessIntentRecipients(intent, EVM_SIGNER, ["fiat24:account:42"])).toStrictEqual([]);
  });

  it("fiat24 actions and authority grants name no value recipient", () => {
    expect(Object.values(FIAT24_SLOTS)).toStrictEqual(["none", "none", "none", "none", "none"]);
    expect(Object.values(AUTHORITY_SLOTS)).toStrictEqual(["none", "none", "none"]);
  });

  it("an outflow flagged burn names no recipient", () => {
    const intent = {
      ...baseIntent("bitcoin", BITCOIN_NET),
      outflows: [
        { to: "6a24aa21a9ed", amount: AMT, verified: true },
        { to: "6a24aa21a9ed", amount: AMT, verified: true, burn: true as const },
      ],
    } as DisplayIntent;
    expect(intentRecipients(intent)).toStrictEqual(["6a24aa21a9ed"]);
  });

  it("a cancel authorization and a zero-value Safe call name no recipient", () => {
    const intent = typedSlot({
      authorization: { kind: "cancel", token: "0xt", nonce: `0x${"0".repeat(64)}` },
      safe: safeTx({ to: EVM_LOOKALIKE, value: "0" }),
      hyperliquid: {
        kind: "approve-agent",
        chain: "Mainnet",
        agent: EVM_LOOKALIKE,
        name: "bot",
      },
    });
    expect(intentRecipients(intent)).toStrictEqual([]);
  });

  it("an undelegate's receiver and a split's target name no recipient", () => {
    const intent = {
      ...baseIntent("tron", TRON_NET),
      staking: [
        { kind: "tron-undelegate", receiver: EVM_LOOKALIKE, amount: AMT, resource: "energy" },
        { kind: "split", account: "a", to: EVM_LOOKALIKE, lamports: "1" },
      ],
    } as DisplayIntent;
    expect(intentRecipients(intent)).toStrictEqual([]);
  });
});

describe("a real off-chain order decode is assessed", () => {
  const zeroxDoc = (recipient: string): string => {
    const vectors = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../../vectors/chains/evm-zerox-gasless.json"),
        "utf8",
      ),
    ) as { real: { data: { message: { slippageAndActions: { recipient: string } } & object } } };
    const data = structuredClone(vectors.real.data);
    data.message.slippageAndActions.recipient = recipient;
    return JSON.stringify(data);
  };

  const signTyped = (network: string, typedData: string) => ({
    method: "evm-sign" as const,
    origin: ORIGIN,
    account: EVM_ACCOUNT,
    network,
    request: {
      kind: "evm.typed-data" as const,
      network,
      account: EVM_ACCOUNT,
      typedData,
    },
  });

  const rigWithBook = () => {
    const { requests, addressBook } = rig({
      prepareDapp: async (account, request) => {
        const normalized = normalizeEvm(request);
        return Promise.resolve({
          account,
          network: normalized.network,
          signer: EVM_SIGNER,
          intent: decodeEvm(normalized, EVM_SIGNER),
          checks: [],
          staleReason: () => undefined,
          release: () => undefined,
          submit: async () => Promise.resolve({ kind: normalized.kind, signature: "0x1234" }),
        });
      },
    });
    return { requests, addressBook };
  };

  it("a 0x MetaTxn paying a lookalike of a saved contact is flagged", async () => {
    const { requests, addressBook } = rigWithBook();
    await requests.init();
    await addressBook.init();
    await addressBook.add({
      name: "Alice",
      family: "evm",
      address: EVM_KNOWN,
    });
    const request = await requests.prepare(signTyped("eip155:8453", zeroxDoc(EVM_LOOKALIKE)));
    const intent = request.display as DisplayIntent;
    expect(intent.message?.kind).toBe("typed-data");
    expect(intent.outflows).toStrictEqual([]);
    expect(codes(request)).toContain("address-poisoning");
    expect(codes(request)).toContain("first-recipient");
  });

  it("the same MetaTxn naming the signer is not flagged", async () => {
    const { requests } = rigWithBook();
    await requests.init();
    const request = await requests.prepare(signTyped("eip155:8453", zeroxDoc(EVM_SIGNER)));
    expect(recipientFindings(request)).toStrictEqual([]);
  });
});
