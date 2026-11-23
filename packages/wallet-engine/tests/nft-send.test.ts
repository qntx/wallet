// oxlint-disable vitest/no-conditional-in-test -- the mocked endpoints are inherently conditional
import { readFileSync } from "node:fs";

import { base64 } from "@scure/base";
import { getAddressEncoder, address } from "@solana/kit";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
} from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import {
  associatedTokenAddress,
  MPL_CORE_PROGRAM,
  parseCompiledMessage,
} from "@qntx/wallet-chains/solana";
import type { chains } from "@qntx/wallet/chains";

import { metaplexMetadataAddress } from "../src/chains/nfts.ts";
import { UNIVERSAL_RESOLVER } from "../src/names/ens.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { AccountRef } from "../src/transactions/route.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const ACCOUNTS = JSON.parse(
  readFileSync(new URL("fixtures/nfts/solana-mainnet-accounts.json", import.meta.url), "utf8"),
) as {
  readonly owner: string;
  readonly plain: Section;
  readonly programmable: Section;
  readonly frozen: Section;
};
type Section = {
  readonly mint: { readonly address: string; readonly response: unknown };
  readonly metadata: { readonly address: string; readonly response: unknown };
  readonly ata: { readonly address: string; readonly response: unknown };
};

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const GW = "https://gw.test";
const HOST = "https://host.test";
const HOST2 = "https://host2.test";
const ADDR = "0xcfae4ade5ae06d1730520809c8c3db9f6c7fe7e1";
const TO = "0x1234567890abcdef1234567890abcdef12345678";
const CONTRACT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const ACCOUNT: AccountRef = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" };
const word = (v: bigint | string): string =>
  `0x${(typeof v === "bigint" ? v : BigInt(v)).toString(16).padStart(64, "0")}`;
const addrWord = (a: string): string => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

const CALL_ABI = [
  {
    type: "function",
    name: "balanceOfBatch",
    stateMutability: "view",
    inputs: [
      { name: "accounts", type: "address[]" },
      { name: "ids", type: "uint256[]" },
    ],
    outputs: [{ name: "", type: "uint256[]" }],
  },
] as const;

const evmWorld = (o: {
  readonly supports721?: boolean;
  readonly supports1155?: boolean;
  readonly owner?: string;
  readonly balances?: ReadonlyArray<bigint>;
  readonly hostBalances?: ReadonlyArray<bigint>;
  readonly hostOwner?: string;
  readonly hostFails?: boolean;
  readonly ensResult?: string;
  readonly sim?: unknown;
}) => {
  const net = "eip155:1";
  const calls: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GW}/v1/networks`) {
      return Response.json({ networks: [net] });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    calls.push(body.method);
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    if (body.method === "eth_call") {
      const data = ((body.params?.[0] as { data?: string } | undefined)?.data ?? "").toLowerCase();
      if (data.startsWith("0x01ffc9a7")) {
        const iid = data.slice(10, 18);
        return reply(
          word(
            iid === "80ac58cd"
              ? o.supports721
                ? 1n
                : 0n
              : iid === "d9b67a26"
                ? o.supports1155
                  ? 1n
                  : 0n
                : 0n,
          ),
        );
      }
      const to = ((body.params?.[0] as { to?: string } | undefined)?.to ?? "").toLowerCase();
      if (to === UNIVERSAL_RESOLVER && o.ensResult !== undefined) {
        return reply(o.ensResult);
      }
      const host = url.startsWith(HOST2);
      if (host && o.hostFails === true) {
        return Promise.reject(new Error("socket reset"));
      }
      if (data.startsWith("0x6352211e")) {
        const owner = host ? (o.hostOwner ?? o.owner ?? ADDR) : (o.owner ?? ADDR);
        return reply(addrWord(owner));
      }
      if (data.startsWith("0x4e1273f4")) {
        const decoded = decodeFunctionData({ abi: CALL_ABI, data: data as `0x${string}` });
        const [, ids] = decoded.args;
        const balances = (host ? (o.hostBalances ?? o.balances) : o.balances) ?? [3n];
        return reply(
          `0x${word(32n).slice(2)}${word(BigInt(ids.length)).slice(2)}${ids
            .map((_id, i) => word(balances[i] ?? 0n).slice(2))
            .join("")}`,
        );
      }
      return reply(word(0n));
    }
    if (body.method === "eth_simulateV1") {
      return reply(
        o.sim ?? {
          status: "ok",
          blocks: [
            {
              calls: [{ status: "0x1", gasUsed: "0x5208", logs: [] }],
              assetChanges: [],
              balanceChanges: [],
            },
          ],
        },
      );
    }
    const base: Record<string, unknown> = {
      eth_chainId: "0x1",
      eth_blockNumber: "0x1",
      eth_getTransactionCount: "0x0",
      eth_estimateGas: "0x5208",
      eth_feeHistory: { baseFeePerGas: ["0x64"], reward: [["0x1", "0x1", "0x1"]] },
      eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
      eth_getTransactionReceipt: {
        status: "0x1",
        blockNumber: "0x1",
        blockHash: `0x${"11".repeat(32)}`,
      },
      eth_getBlockByNumber: { number: "0x2" },
      eth_getCode: "0x",
    };
    return body.method in base
      ? reply(base[body.method])
      : Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: `method not found: ${body.method}` },
        });
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [net]: [HOST2] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway: {
      url: GW,
      clientIds: {
        evm: "a".repeat(32),
        solana: "a".repeat(32),
        bitcoin: "a".repeat(32),
        tron: "a".repeat(32),
        service: "a".repeat(32),
      },
    },
  });
  const signedRequests: Array<{ tx: { data: string; to: string } }> = [];
  const apis = {
    account: async () => Promise.resolve({ template: "evm.bip44", network: net, address: ADDR }),
    sign: async (params: { request: { tx: { data: string; to: string } } }) => {
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
  return {
    requests,
    transactions,
    calls,
    signedRequests,
    start: async () => {
      await networks.init();
      await transactions.init();
      await requests.init();
    },
  };
};

const prepareNft = async (
  w: ReturnType<typeof evmWorld>,
  i: {
    contract?: string;
    items?: ReadonlyArray<{ readonly tokenId: bigint; readonly amount?: bigint }>;
    to?: string;
  } = {},
) =>
  w.requests.prepare({
    method: "evm-nft-send",
    account: ACCOUNT,
    network: "eip155:1",
    contract: i.contract ?? CONTRACT,
    items: i.items ?? [{ tokenId: 7n }],
    to: i.to ?? TO,
    fee: "normal",
  });

const item = (tokenId: bigint, amount?: bigint): { tokenId: bigint; amount?: bigint } => ({
  tokenId,
  ...(amount === undefined ? {} : { amount }),
});

describe("evm-nft-send", () => {
  it("ERC-721: owner-of passes → safeTransferFrom(from,to,id)", async () => {
    const w = evmWorld({ supports721: true });
    await w.start();
    const p = await prepareNft(w);
    const display = p.display as {
      summary: string;
      outflows: ReadonlyArray<{ to: string; amount: { asset: string; amount: string } }>;
    };
    expect(display.summary).toBe("transfer");
    expect(display.outflows[0]?.to.toLowerCase()).toBe(TO);
  });

  it("ERC-1155 single: balance covers amount → safeTransferFrom(from,to,id,amount,0x)", async () => {
    const w = evmWorld({ supports1155: true, balances: [5n] });
    await w.start();
    const p = await prepareNft(w, { items: [item(7n, 3n)] });
    const display = p.display as {
      summary: string;
      outflows: ReadonlyArray<{ amount: { amount: string; tokenId?: string } }>;
    };
    expect(display.summary).toBe("transfer");
    expect(display.outflows[0]?.amount).toMatchObject({ tokenId: "7", amount: "3" });
  });

  it("ERC-1155 batch: one outflow per id, calldata matches viem's encoding", async () => {
    const w = evmWorld({ supports1155: true, balances: [3n, 4n, 5n] });
    await w.start();
    const items = [item(7n), item(9n, 2n), item(11n, 5n)];
    const p = await w.requests.prepare({
      method: "evm-nft-send",
      account: ACCOUNT,
      network: "eip155:1",
      contract: CONTRACT,
      items,
      to: TO,
      fee: "normal",
    });
    const display = p.display as {
      summary: string;
      outflows: ReadonlyArray<{
        to: string;
        amount: { asset: string; amount: string; tokenId?: string };
      }>;
    };
    expect(display.summary).toBe("transfer");
    expect(display.outflows).toHaveLength(items.length);
    for (const [i, it] of items.entries()) {
      const outflow = display.outflows[i];
      expect(outflow?.to.toLowerCase()).toBe(TO);
      expect(outflow?.amount.tokenId).toBe(it.tokenId.toString(10));
      expect(outflow?.amount.amount).toBe((it.amount ?? 1n).toString(10));
    }
  });

  it("calldata equals viem's safeBatchTransferFrom encoding", async () => {
    const w = evmWorld({ supports1155: true, balances: [3n, 4n] });
    await w.start();
    const prepared = await w.transactions.prepareEvmInternal(
      {
        method: "evm-nft-send",
        account: ACCOUNT,
        network: "eip155:1",
        contract: CONTRACT,
        items: [item(7n), item(9n, 2n)],
        to: TO,
        fee: "normal",
      },
      "req-calldata",
    );
    const VERIFY = { kind: "password" as const, password: "pw" };
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.state).toBe("submitted");
    const [request] = w.signedRequests;
    expect(request?.tx.data).toBe(
      encodeFunctionData({
        abi: BATCH_ABI,
        functionName: "safeBatchTransferFrom",
        args: [ADDR as `0x${string}`, TO as `0x${string}`, [7n, 9n], [1n, 2n], "0x"],
      }),
    );
  });

  it("duplicate ids refuse as an input error", async () => {
    const w = evmWorld({ supports1155: true });
    await w.start();
    await expect(prepareNft(w, { items: [item(7n), item(7n)] })).rejects.toThrow(
      "cannot list an id twice",
    );
  });

  it("eleven items refuse as an input error", async () => {
    const w = evmWorld({ supports1155: true });
    await w.start();
    await expect(
      prepareNft(w, { items: Array.from({ length: 11 }, (_, i) => item(BigInt(i))) }),
    ).rejects.toThrow("at most");
  });

  it("an ERC-721 send with two items refuses as an input error", async () => {
    const w = evmWorld({ supports721: true });
    await w.start();
    await expect(prepareNft(w, { items: [item(7n), item(9n)] })).rejects.toThrow(
      "exactly one token once",
    );
  });

  it("an ERC-721 send with amount two refuses as an input error", async () => {
    const w = evmWorld({ supports721: true });
    await w.start();
    await expect(prepareNft(w, { items: [item(7n, 2n)] })).rejects.toThrow(
      "exactly one token once",
    );
  });

  it("a contract that is neither ERC-721 nor ERC-1155 refuses not-nft", async () => {
    const w = evmWorld({});
    await w.start();
    await expect(prepareNft(w)).rejects.toMatchObject({ reason: "not-nft" });
  });

  it("a token the account does not own refuses not-owned", async () => {
    const w = evmWorld({
      supports721: true,
      owner: "0x9999999999999999999999999999999999999999",
    });
    await w.start();
    await expect(prepareNft(w)).rejects.toMatchObject({ reason: "not-owned" });
  });

  it("a zero ERC-1155 balance refuses not-owned", async () => {
    const w = evmWorld({ supports1155: true, balances: [0n] });
    await w.start();
    await expect(prepareNft(w)).rejects.toMatchObject({ reason: "not-owned" });
  });

  it("an ERC-1155 balance below the amount refuses insufficient-balance", async () => {
    const w = evmWorld({ supports1155: true, balances: [2n] });
    await w.start();
    await expect(prepareNft(w, { items: [item(7n, 3n)] })).rejects.toMatchObject({
      reason: "insufficient-balance",
    });
  });

  it("an ERC-1155 amount below one refuses as an input error", async () => {
    const w = evmWorld({ supports1155: true });
    await w.start();
    await expect(prepareNft(w, { items: [item(7n, 0n)] })).rejects.toThrow("at least one unit");
  });

  it("endpoints disagreeing on the owner refuse", async () => {
    const w = evmWorld({
      supports721: true,
      hostOwner: "0x9999999999999999999999999999999999999999",
    });
    await w.start();
    await expect(prepareNft(w)).rejects.toThrow("disagree");
  });

  it("endpoints disagreeing on balanceOfBatch refuse", async () => {
    const w = evmWorld({ supports1155: true, balances: [3n], hostBalances: [9n] });
    await w.start();
    await expect(prepareNft(w)).rejects.toThrow("disagree");
  });

  it("a failing independent endpoint leaves the read unverified", async () => {
    const w = evmWorld({ supports721: true, hostFails: true });
    await w.start();
    const p = await prepareNft(w);
    expect(p.checks).toContain("reads-unverified");
  });

  it("sending to the contract itself flags token-contract-recipient", async () => {
    const w = evmWorld({ supports721: true });
    await w.start();
    const p = await prepareNft(w, { to: CONTRACT });
    expect(p.risk).toContainEqual({ code: "token-contract-recipient", level: "danger" });
  });

  it("an ENS recipient lands its name on the outflows", async () => {
    const w = evmWorld({ supports721: true, ensResult: ensResult(TO) });
    await w.start();
    const p = await prepareNft(w, { to: "name.eth" });
    expect(p.display).toMatchObject({ outflows: [{ name: "name.eth" }] });
    const flow = "outflows" in p.display ? p.display.outflows[0] : undefined;
    expect(flow?.to.toLowerCase()).toBe(TO);
  });
});

const BATCH_ABI = [
  {
    type: "function",
    name: "safeBatchTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "ids", type: "uint256[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** A `resolveWithGateways` result whose inner `addr` decodes to `address` for any coin type. */
const ensResult = (ensAddress: string): string =>
  encodeAbiParameters(parseAbiParameters("bytes, bytes"), [
    encodeAbiParameters(parseAbiParameters("bytes"), [ensAddress as `0x${string}`]),
    "0x",
  ]);

const PAYER = "HAgk14Jp9U1Y6YV7Qe8rJx9c4kXvF4w7Yf5tP2nY5K1n";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ASSET = "5SN2S9fjnSDNFyzFrky2CuiY5bHKYdNkF8rgRwP3YTi8";
const COLLECTION = "phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC";
const NEW_OWNER = "9Xx76WpEjfwhvuTcXiXBHgVPzXsJ8aAaSBTLjdFyf9DL";
const addrDec = getAddressEncoder();
const toBytes = (a: string) => Uint8Array.from(addrDec.encode(address(a)));

const coreAssetBytes = (owner: string, tag = 2): string => {
  const b = new Uint8Array(66);
  b[0] = 1;
  b.set(toBytes(owner), 1);
  b[33] = tag;
  if (tag === 2) {
    b.set(toBytes(COLLECTION), 34);
  }
  return base64.encode(b);
};

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const NFT_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const splMintBytes = (supply: bigint, decimals: number): string => {
  const b = new Uint8Array(82);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(36, supply, true);
  b[44] = decimals;
  b[45] = 1;
  return base64.encode(b);
};

const solanaWorld = (o: {
  readonly asset?: { owner?: string; data?: string } | null;
  readonly ownerTag?: number;
  readonly mint?: { supply: bigint; decimals: number } | null;
  readonly payer?: string;
  readonly accounts?: Readonly<Record<string, unknown>>;
  readonly hostAccounts?: Readonly<Record<string, unknown>>;
}) => {
  const payer = o.payer ?? PAYER;
  const calls: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GW}/v1/networks`) {
      return Response.json({ networks: [SOL_NET] });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method?: string;
      params?: ReadonlyArray<unknown>;
    };
    calls.push(body.method ?? "");
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    const err = (m: string) =>
      Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32_000, message: m } });
    switch (body.method) {
      case "getAccountInfo": {
        const asked = String(body.params?.[0] ?? "");
        const host = url.startsWith(HOST);
        const table = host ? (o.hostAccounts ?? o.accounts) : o.accounts;
        if (table !== undefined) {
          return reply(asked in table ? table[asked] : { value: null });
        }
        if (body.params?.[0] === ASSET) {
          if (o.asset === null) {
            return reply({ value: null });
          }
          return reply({
            value: {
              owner: o.asset?.owner ?? MPL_CORE_PROGRAM,
              data: [o.asset?.data ?? coreAssetBytes(PAYER, o.ownerTag ?? 2), "base64"],
              lamports: 1_500_000,
              executable: false,
            },
          });
        }
        if (body.params?.[0] === NFT_MINT) {
          if (o.mint === null) {
            return reply({ value: null });
          }
          const m = o.mint ?? { supply: 1n, decimals: 0 };
          return reply({
            value: {
              owner: TOKEN_PROGRAM,
              data: [splMintBytes(m.supply, m.decimals), "base64"],
              lamports: 1_500_000,
              executable: false,
            },
          });
        }
        return reply({ value: null });
      }

      case "getMultipleAccounts": {
        const addrs = (body.params?.[0] as ReadonlyArray<string>) ?? [];
        return reply({
          value: addrs.map((a) =>
            a === PAYER
              ? {
                  lamports: 50_000_000_000,
                  owner: "11111111111111111111111111111111",
                  data: ["", "base64"],
                }
              : null,
          ),
        });
      }
      case "getLatestBlockhash":
        return reply({
          value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100_000 },
        });
      case "simulateTransaction":
        return reply({ value: { err: null, logs: [], unitsConsumed: 21_000 } });
      case "getRecentPrioritizationFees":
        return reply([]);
      case "getGenesisHash":
        return reply("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
      case "isBlockhashValid":
        return reply({ context: { slot: 5000 }, value: true });
      case "sendTransaction":
        return reply(`sig${"a".repeat(80)}`);
      case "getSignatureStatuses":
        return reply({ value: [{ confirmationStatus: "finalized", err: null }] });
      case "getBlockHeight":
        return reply(1);
      case "getEpochInfo":
        return reply({ epoch: 1 });
      default:
        return err(`unexpected ${body.method ?? ""}`);
    }
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [SOL_NET]: [HOST] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway: {
      url: GW,
      clientIds: {
        evm: "a".repeat(32),
        solana: "a".repeat(32),
        bitcoin: "a".repeat(32),
        tron: "a".repeat(32),
        service: "a".repeat(32),
      },
    },
  });
  const signedRequests: Array<{ message: Uint8Array }> = [];
  const apis = {
    account: async () =>
      Promise.resolve({ template: "solana.bip44-change", network: SOL_NET, address: payer }),
    sign: async (params: { request: { message: Uint8Array } }) => {
      signedRequests.push(params.request);
      return Promise.resolve({ kind: "solana.transaction", signature: new Uint8Array(64) });
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
  return {
    requests,
    transactions,
    calls,
    signedRequests,
    start: async () => {
      await networks.init();
      await transactions.init();
      await requests.init();
    },
  };
};

const prepareCore = async (
  w: ReturnType<typeof solanaWorld>,
  i: { asset?: string; to?: string } = {},
) =>
  w.requests.prepare({
    method: "solana-nft-send",
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
    network: SOL_NET,
    asset: i.asset ?? ASSET,
    to: i.to ?? NEW_OWNER,
    fee: "normal",
  });

const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const solValue = (owner: string, data: string): unknown => ({
  context: { slot: 1 },
  value: { owner, data: [data, "base64"], lamports: 1_500_000, executable: false },
});

const tokenAccountBytes = (mint: string, owner: string, amount: bigint, state: number): string => {
  const b = new Uint8Array(165);
  b.set(toBytes(mint), 0);
  b.set(toBytes(owner), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  b[108] = state;
  return base64.encode(b);
};

/** The real captured accounts for one fixture NFT, keyed the way `getAccountInfo` asks. */
const splAccounts = async (
  name: "plain" | "programmable" | "frozen",
): Promise<Record<string, unknown>> => {
  const section = ACCOUNTS[name];
  return {
    [section.mint.address]: section.mint.response,
    [await metaplexMetadataAddress(section.mint.address)]: section.metadata.response,
    [section.ata.address]: section.ata.response,
  };
};

const prepareSpl = async (
  w: ReturnType<typeof solanaWorld>,
  asset: string,
): ReturnType<typeof w.requests.prepare> =>
  w.requests.prepare({
    method: "solana-nft-send",
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
    network: SOL_NET,
    asset,
    to: NEW_OWNER,
    fee: "normal",
  });

describe("solana-nft-send (SPL)", () => {
  it("a plain V1 NFT builds an idempotent-ATA + transferChecked(1,0) send", async () => {
    const w = solanaWorld({
      payer: ACCOUNTS.owner,
      accounts: await splAccounts("plain"),
    });
    await w.start();
    const prepared = await w.transactions.prepareSolanaNftSend(
      {
        method: "solana-nft-send",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
        network: SOL_NET,
        asset: ACCOUNTS.plain.mint.address,
        to: NEW_OWNER,
        fee: "normal",
      },
      "req-spl",
    );
    const tx = await prepared.submit({ kind: "password", password: "pw" }, () => undefined);
    expect(tx.state).toBe("submitted");
    expect(prepared.intent.outflows).toStrictEqual([
      {
        to: associatedTokenAddress(NEW_OWNER, ACCOUNTS.plain.mint.address, TOKEN_PROGRAM),
        amount: { asset: ACCOUNTS.plain.mint.address, amount: "1" },
        verified: false,
      },
    ]);
    const [request] = w.signedRequests;
    const compiled = parseCompiledMessage(request?.message ?? new Uint8Array());
    const programs = compiled.instructions.map(
      (ix) => compiled.staticAccounts[ix.programAddressIndex],
    );
    expect(programs).toContain(ATA_PROGRAM);
    const transfer = compiled.instructions.find(
      (ix) => compiled.staticAccounts[ix.programAddressIndex] === TOKEN_PROGRAM,
    );
    const data = transfer?.data ?? new Uint8Array();
    expect(data[0]).toBe(12);
    expect(Number(new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true))).toBe(1);
    expect(data[9]).toBe(0);
  });

  it("a programmable Mad Lads NFT refuses programmable", async () => {
    const w = solanaWorld({
      payer: ACCOUNTS.owner,
      accounts: await splAccounts("programmable"),
    });
    await w.start();
    await expect(prepareSpl(w, ACCOUNTS.programmable.mint.address)).rejects.toMatchObject({
      reason: "programmable",
    });
  });

  it("a frozen token account refuses frozen", async () => {
    const w = solanaWorld({
      payer: ACCOUNTS.owner,
      accounts: await splAccounts("frozen"),
    });
    await w.start();
    await expect(prepareSpl(w, ACCOUNTS.frozen.mint.address)).rejects.toMatchObject({
      reason: "frozen",
    });
  });

  it("a missing asset account refuses not-found", async () => {
    const w = solanaWorld({ payer: ACCOUNTS.owner, accounts: {} });
    await w.start();
    await expect(prepareSpl(w, ACCOUNTS.plain.mint.address)).rejects.toMatchObject({
      reason: "not-found",
    });
    await expect(prepareSpl(w, ACCOUNTS.plain.mint.address)).rejects.toThrow("compressed NFTs");
  });

  it("a fungible mint refuses not-nft", async () => {
    const w = solanaWorld({
      payer: ACCOUNTS.owner,
      accounts: {
        [ACCOUNTS.plain.mint.address]: solValue(TOKEN_PROGRAM, splMintBytes(1_000_000n, 6)),
      },
    });
    await w.start();
    await expect(prepareSpl(w, ACCOUNTS.plain.mint.address)).rejects.toMatchObject({
      reason: "not-nft",
    });
  });

  it("an ATA owned by someone else refuses not-owned", async () => {
    const section = ACCOUNTS.plain;
    const w = solanaWorld({
      payer: ACCOUNTS.owner,
      accounts: {
        [section.mint.address]: section.mint.response,
        [await metaplexMetadataAddress(section.mint.address)]: section.metadata.response,
        [section.ata.address]: solValue(
          TOKEN_PROGRAM,
          tokenAccountBytes(section.mint.address, NEW_OWNER, 1n, 1),
        ),
      },
    });
    await w.start();
    await expect(prepareSpl(w, section.mint.address)).rejects.toMatchObject({
      reason: "not-owned",
    });
  });

  it("corrupted metadata bytes refuse not-nft", async () => {
    const section = ACCOUNTS.plain;
    const w = solanaWorld({
      payer: ACCOUNTS.owner,
      accounts: {
        [section.mint.address]: section.mint.response,
        [await metaplexMetadataAddress(section.mint.address)]: solValue(
          "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
          base64.encode(new Uint8Array(607).fill(9)),
        ),
        [section.ata.address]: section.ata.response,
      },
    });
    await w.start();
    await expect(prepareSpl(w, section.mint.address)).rejects.toMatchObject({
      reason: "not-nft",
    });
  });

  it("a mint without a metadata account sends as a plain SPL NFT", async () => {
    const section = ACCOUNTS.plain;
    const w = solanaWorld({
      payer: ACCOUNTS.owner,
      accounts: {
        [section.mint.address]: section.mint.response,
        [section.ata.address]: section.ata.response,
      },
    });
    await w.start();
    const p = await prepareSpl(w, section.mint.address);
    expect(p.display).toMatchObject({ summary: "transfer" });
  });

  it("endpoints disagreeing on the asset account refuse", async () => {
    const accounts = await splAccounts("plain");
    const mint = ACCOUNTS.plain.mint.address;
    const w = solanaWorld({
      payer: ACCOUNTS.owner,
      accounts,
      hostAccounts: { ...accounts, [mint]: solValue(TOKEN_PROGRAM, splMintBytes(1n, 0)) },
    });
    await w.start();
    await expect(prepareSpl(w, mint)).rejects.toThrow("disagree");
  });
});

describe("solana-nft-send (Core)", () => {
  it("an owned asset with a Collection authority → TransferV1", async () => {
    const w = solanaWorld({});
    await w.start();
    const p = await prepareCore(w);
    const display = p.display as {
      summary: string;
      outflows: ReadonlyArray<{ to: string; amount: { asset: string; amount: string } }>;
    };
    expect(display.summary).toBe("transfer");
    expect(display.outflows[0]).toMatchObject({
      to: NEW_OWNER,
      amount: { asset: ASSET, amount: "1" },
    });
  });

  it("an account that is not a Core asset refuses", async () => {
    const w = solanaWorld({
      asset: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: "" },
    });
    await w.start();
    await expect(prepareCore(w)).rejects.toMatchObject({ reason: "not-nft" });
  });

  it("an asset the account does not own refuses", async () => {
    const w = solanaWorld({
      asset: { owner: MPL_CORE_PROGRAM, data: coreAssetBytes(NEW_OWNER, 2) },
    });
    await w.start();
    await expect(prepareCore(w)).rejects.toMatchObject({ reason: "not-owned" });
  });

  it("a non-AssetV1 key refuses", async () => {
    const bad = new Uint8Array(66);
    bad[0] = 5;
    bad.set(toBytes(PAYER), 1);
    const w = solanaWorld({ asset: { owner: MPL_CORE_PROGRAM, data: base64.encode(bad) } });
    await w.start();
    await expect(prepareCore(w)).rejects.toMatchObject({ reason: "not-nft" });
  });
});

describe("solana route commit", () => {
  it("a throwing commit prevents the broadcast", async () => {
    const w = solanaWorld({});
    await w.start();
    const prepared = await w.transactions.prepareSend(
      {
        account: {
          kind: "hd",
          walletId: "w",
          groupIndex: 0,
          template: "solana.bip44-change",
        },
        network: SOL_NET,
        to: NEW_OWNER,
        amount: 1_000_000n,
        fee: "normal",
      },
      "req-1",
    );
    await expect(
      prepared.submit({ kind: "password", password: "pw" }, () => {
        throw new Error("invalidated");
      }),
    ).rejects.toThrow("invalidated");
    expect(w.calls).not.toContain("sendTransaction");
    prepared.release();
  });
});
