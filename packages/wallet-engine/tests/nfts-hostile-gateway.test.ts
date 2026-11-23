// oxlint-disable vitest/no-conditional-in-test -- the fake gateway fetch is inherently conditional
import { describe, expect, it } from "vite-plus/test";

/**
 * The gateway is display-only and untrusted: an inventory it invents must never move value. Every
 * send it suggests goes through the request pipeline's own chain reads — agreeing with an invented
 * owner fails verification before anything is signed, and a gateway that is the only configured
 * endpoint answers with `reads-unverified`, never silently trusted.
 */
import type { Wallet } from "@qntx/wallet";
import type { chains } from "@qntx/wallet/chains";

import { NftTransferError } from "../src/errors.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { NftController } from "../src/nfts/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const GW = "https://gateway.test.invalid";
const HOST = "https://host.test.invalid";
const EVM = "eip155:1";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ADDR = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x9999999999999999999999999999999999999999";
const CONTRACT = "0x3333333333333333333333333333333333333333";
const TO = "0x4444444444444444444444444444444444444444";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const SOL_ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change" as const,
};

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const addrWord = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

const CLIENT_IDS = {
  evm: "a".repeat(32),
  solana: "a".repeat(32),
  bitcoin: "a".repeat(32),
  tron: "a".repeat(32),
  service: "a".repeat(32),
};

const evmItem = {
  contract: CONTRACT,
  tokenId: "1",
  standard: "erc721",
  balance: "1",
  name: null,
  image: null,
  animation: null,
  collection: null,
  spam: false,
};

const solanaItem = {
  contract: MINT,
  tokenId: null,
  standard: "metaplex",
  balance: "1",
  name: null,
  image: null,
  animation: null,
  collection: null,
  spam: false,
};

type RpcFn = (method: string, params: ReadonlyArray<unknown> | undefined) => unknown;

/** The chain answers every endpoint gives; `invented` items come only from the gateway page. */
const world = (o: {
  readonly rpc: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly networks: ReadonlyArray<string>;
  readonly page?: ReadonlyArray<Record<string, unknown>>;
  readonly answer: RpcFn;
}) => {
  const calls: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GW}/v1/networks`) {
      return Response.json({ networks: o.networks });
    }
    if (url.startsWith(`${GW}/v1/nfts/items/`)) {
      return Response.json({ items: o.page ?? [], cursor: null });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: ReadonlyArray<unknown>;
    };
    calls.push(body.method);
    return Response.json({ jsonrpc: "2.0", id: 1, result: o.answer(body.method, body.params) });
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: o.rpc,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway: { url: GW, clientIds: CLIENT_IDS },
  });
  const signedRequests: unknown[] = [];
  const apis = {
    account: async () => Promise.resolve({ template: "evm.bip44", network: EVM, address: ADDR }),
    sign: async (params: { request: unknown }) => {
      signedRequests.push(params.request);
      return Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array(1) });
    },
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    wallet: {} as Wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: (n) => new Uint8Array(n).fill(3),
    setTimer: () => () => undefined,
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
    spark: {} as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: fetchImpl,
    random: (n) => new Uint8Array(n).fill(4),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  const nfts = new NftController({
    gateway: { url: GW, clientIds: CLIENT_IDS },
    fetch: fetchImpl,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: () => () => undefined,
    now: () => 0,
    logger,
    networks,
    balances: () => ({}),
    activity: () => ({ entries: [], txs: Object.values(transactions.getState().txs) }),
    onActivityChange: () => () => undefined,
    onConfirmed: () => () => undefined,
  });
  return {
    requests,
    transactions,
    networks,
    nfts,
    calls,
    signedRequests,
    start: async () => {
      await networks.init();
      await transactions.init();
      await requests.init();
      await nfts.init();
    },
  };
};

const evmAnswer = (owner: string): RpcFn => {
  return (method, params) => {
    if (method === "eth_call") {
      const data = ((params?.[0] as { data?: string } | undefined)?.data ?? "").toLowerCase();
      if (data.startsWith("0x01ffc9a7")) {
        return word(data.slice(10, 18) === "80ac58cd" ? 1n : 0n);
      }
      if (data.startsWith("0x6352211e")) {
        return addrWord(owner);
      }
      return word(0n);
    }
    const base: Record<string, unknown> = {
      eth_chainId: "0x1",
      eth_blockNumber: "0x1",
      eth_getTransactionCount: "0x0",
      eth_estimateGas: "0x5208",
      eth_feeHistory: { baseFeePerGas: ["0x64"], reward: [["0x1", "0x1", "0x1"]] },
    };
    return method in base ? base[method] : null;
  };
};

describe("a hostile gateway's invented inventory", () => {
  it("displays but cannot spend an ERC-721 the chain says a stranger owns", async () => {
    const w = world({
      rpc: { [EVM]: [HOST] },
      networks: [EVM],
      page: [evmItem],
      answer: evmAnswer(STRANGER),
    });
    await w.start();
    const inventory = await w.nfts.load(ADDR, EVM);
    expect(inventory.items).toHaveLength(1);
    await expect(
      w.requests.prepare({
        method: "evm-nft-send",
        account: ACCOUNT,
        network: EVM,
        contract: CONTRACT,
        items: [{ tokenId: 1n }],
        to: TO,
        fee: "normal",
      }),
    ).rejects.toBeInstanceOf(NftTransferError);
    expect(w.signedRequests).toHaveLength(0);
    expect(Object.keys(w.transactions.getState().txs)).toHaveLength(0);
  });

  it("displays but cannot spend an invented Solana mint the chain has never seen", async () => {
    const w = world({
      rpc: { [SOL_NET]: [HOST] },
      networks: [SOL_NET],
      page: [solanaItem],
      answer: (method) => (method === "getAccountInfo" ? { value: null } : null),
    });
    await w.start();
    const inventory = await w.nfts.load("9Xx76WpEjfwhvuTcXiXBHgVPzXsJ8aAaSBTLjdFyf9DL", SOL_NET);
    expect(inventory.items).toHaveLength(1);
    await expect(
      w.requests.prepare({
        method: "solana-nft-send",
        account: SOL_ACCOUNT,
        network: SOL_NET,
        asset: MINT,
        to: "5SN2S9fjnSDNFyzFrky2CuiY5bHKYdNkF8rgRwP3YTi8",
        fee: "normal",
      }),
    ).rejects.toBeInstanceOf(NftTransferError);
    expect(w.signedRequests).toHaveLength(0);
    expect(Object.keys(w.transactions.getState().txs)).toHaveLength(0);
  });

  it("flags reads-unverified when the lying gateway is the only endpoint", async () => {
    const w = world({
      rpc: {},
      networks: [EVM],
      page: [evmItem],
      answer: evmAnswer(ADDR),
    });
    await w.start();
    const prepared = await w.requests.prepare({
      method: "evm-nft-send",
      account: ACCOUNT,
      network: EVM,
      contract: CONTRACT,
      items: [{ tokenId: 1n }],
      to: TO,
      fee: "normal",
    });
    expect(prepared.stage).toBe("awaiting-approval");
    expect(prepared.checks).toContain("reads-unverified");
  });
});
