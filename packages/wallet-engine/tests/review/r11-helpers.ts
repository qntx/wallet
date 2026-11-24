/**
 * Minimal EVM request-pipeline world for the review PoCs — the `evmWorld` of tests/requests.test.ts
 * reduced to what a message sign needs: real NetworkController, TransactionController and
 * RequestController over a stub RPC, a chains api whose account answers a fixed address and whose
 * sign returns canned artefacts.
 */
/* oxlint-disable typescript/require-await -- test stubs resolve immediately. */
import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../../src/networks/controller.ts";
import { RequestController } from "../../src/requests/controller.ts";
import type { EvmSignInput } from "../../src/requests/controller.ts";
import type { SparkController } from "../../src/spark/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import {
  bookDeps,
  fakeSignedEvm,
  idleNetworkDeps,
  simulateSolanaStub,
  tokensStub,
} from "../send-helpers.ts";
import { manualTimers } from "../support/timers.ts";

export const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
export const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
export const SEPOLIA = "eip155:11155111";
export const VERIFY = { kind: "password" as const, password: "pw" };

const HOST = "https://host.test/evm";
const logger = { warn: () => undefined };

const BASE: Record<string, unknown> = {
  eth_chainId: "0xaa36a7",
  eth_blockNumber: "0x1",
  eth_call: `0x${"00".repeat(32)}`,
  eth_getTransactionCount: "0x0",
  eth_estimateGas: "0x5208",
  eth_feeHistory: {
    baseFeePerGas: ["0x64", "0x64"],
    reward: [
      ["0x1", "0x2", "0x3"],
      ["0x1", "0x2", "0x3"],
    ],
  },
  eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
  eth_getTransactionReceipt: {
    status: "0x1",
    blockNumber: "0x1",
    blockHash: `0x${"11".repeat(32)}`,
  },
  eth_getBlockByNumber: { number: "0x2" },
};

/** The canned signature `apis.sign` returns for a personal message. */
export const SIGNATURE = new Uint8Array(65).fill(7);

const rpcMethod = (init: RequestInit | undefined): string => {
  const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  return typeof body === "object" &&
    body !== null &&
    "method" in body &&
    typeof body.method === "string"
    ? body.method
    : "";
};

export const evmWorld = (): {
  readonly networks: NetworkController;
  readonly requests: RequestController;
  readonly transactions: TransactionController;
  readonly calls: ReadonlyArray<{ url: string; method: string }>;
  readonly start: () => Promise<void>;
} => {
  const calls: Array<{ url: string; method: string }> = [];
  const timers = manualTimers();
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = rpcMethod(init);
    calls.push({ url, method });
    return method in BASE
      ? Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: BASE[method] }))
      : Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32601, message: `method not found: ${method}` },
          }),
        );
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [SEPOLIA]: [HOST] },
    openStore: async () => createMemoryEngineStore(),
    logger,
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stub covers account and sign only.
  const apis = {
    account: async () => ({ template: "evm.bip44", network: SEPOLIA, address: ADDR }),
    sign: async ({ request }: { request: SignRequest }) =>
      request.kind === "evm.personal-message"
        ? { kind: "evm.personal-message" as const, signature: SIGNATURE }
        : fakeSignedEvm(request),
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the world never reads wallet fields.
    wallet: {} as Wallet,
    networks,
    openStore: async () => createMemoryEngineStore(),
    random: (n) => new Uint8Array(n).fill(9),
    setTimer: timers.setTimer,
    now: () => 0,
    logger,
    pollMs: 1,
    chains: apis,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stub covers createInvoice and quoteExit only.
    spark: {
      createInvoice: async () => ({
        id: "inv-1",
        invoice: "lnbc1fake",
        paymentHash: new Uint8Array(32),
        amountSats: 100,
        expiresAtMs: 999,
      }),
      quoteExit: async (_r: unknown, p: { amountSats: number }) => ({
        feeSats: 1,
        exitSats: p.amountSats + 1,
      }),
    } as unknown as SparkController,
    nostrSign: async () => {
      throw new Error("nostr-sign is not wired in this test");
    },
    bitcoinPrepare: async () => {
      throw new Error("unused");
    },
    bitcoinSignPsbts: async () => {
      throw new Error("unused");
    },
    bitcoinSign: async () => {
      throw new Error("unused");
    },
    solanaSign: async () => {
      throw new Error("solana-sign is not wired in this test");
    },
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(9),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  const start = async () => {
    await networks.init();
    await transactions.init();
    await requests.init();
  };
  return { networks, requests, transactions, calls, start };
};

export const evmSign = (request: SignRequest): EvmSignInput => ({
  method: "evm-sign",
  account: ACCOUNT,
  network: request.network,
  request,
});
