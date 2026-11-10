import { base64 } from "@scure/base";
import { getAddressEncoder, address } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { MPL_CORE_PROGRAM } from "@qntx/wallet-chains/solana";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { AccountRef } from "../src/transactions/route.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const GW = "https://gw.test";
const HOST = "https://host.test";
const ADDR = "0xcfae4ade5ae06d1730520809c8c3db9f6c7fe7e1";
const TO = "0x1234567890abcdef1234567890abcdef12345678";
const CONTRACT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const ACCOUNT: AccountRef = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" };
const word = (v: bigint | string): string =>
  `0x${(typeof v === "bigint" ? v : BigInt(v)).toString(16).padStart(64, "0")}`;
const addrWord = (a: string): string => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

const evmWorld = (o: {
  readonly supports721?: boolean;
  readonly supports1155?: boolean;
  readonly owner?: string;
  readonly balance?: bigint;
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
      if (data.startsWith("0x6352211e")) {
        return reply(addrWord(o.owner ?? ADDR));
      }
      if (data.startsWith("0x00fdd58e")) {
        return reply(word(o.balance ?? 5n));
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
      eth_feeHistory: { baseFeePerGas: ["0x64"], reward: [["0x1"]] },
      eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
      eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x1", blockHash: "0x1" },
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
    rpc: { [net]: [HOST] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway: { url: GW, installId: "a".repeat(32) },
  });
  const apis = {
    account: async () => Promise.resolve({ template: "evm.bip44", network: net, address: ADDR }),
    sign: async () =>
      Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array(1) }),
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
    calls,
    start: async () => {
      await networks.init();
      await transactions.init();
      await requests.init();
    },
  };
};

const prepareNft = async (
  w: ReturnType<typeof evmWorld>,
  i: { contract?: string; tokenId?: bigint; to?: string; amount?: bigint } = {},
) =>
  w.requests.prepare({
    method: "evm-nft-send",
    account: ACCOUNT,
    network: "eip155:1",
    contract: i.contract ?? CONTRACT,
    tokenId: i.tokenId ?? 7n,
    to: i.to ?? TO,
    ...(i.amount === undefined ? {} : { amount: i.amount }),
    fee: "normal",
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

  it("ERC-1155: balance covers amount → safeTransferFrom(from,to,id,amount,0x)", async () => {
    const w = evmWorld({ supports1155: true, balance: 5n });
    await w.start();
    const p = await prepareNft(w, { amount: 3n });
    const display = p.display as {
      summary: string;
      outflows: ReadonlyArray<{ amount: { amount: string; tokenId?: string } }>;
    };
    expect(display.summary).toBe("transfer");
    expect(display.outflows[0]?.amount).toMatchObject({ tokenId: "7", amount: "3" });
  });

  it("a contract that is neither ERC-721 nor ERC-1155 refuses", async () => {
    const w = evmWorld({});
    await w.start();
    await expect(prepareNft(w)).rejects.toThrow("neither ERC-721 nor ERC-1155");
  });

  it("a token the account does not own refuses", async () => {
    const w = evmWorld({ supports721: true, owner: "0x9999999999999999999999999999999999999999" });
    await w.start();
    await expect(prepareNft(w)).rejects.toThrow("does not own the token");
  });

  it("an ERC-1155 balance below the amount refuses", async () => {
    const w = evmWorld({ supports1155: true, balance: 2n });
    await w.start();
    await expect(prepareNft(w, { amount: 3n })).rejects.toThrow("does not hold enough units");
  });

  it("an ERC-1155 amount below one refuses", async () => {
    const w = evmWorld({ supports1155: true });
    await w.start();
    await expect(prepareNft(w, { amount: 0n })).rejects.toThrow("at least one unit");
  });
});

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
}) => {
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
      case "getAccountInfo":
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
      case "sendTransaction":
        return reply(`sig${"a".repeat(80)}`);
      case "getSignatureStatuses":
        return reply({ value: [{ confirmationStatus: "finalized", err: null }] });
      case "getBlockHeight":
        return reply(1);
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
    gateway: { url: GW, installId: "a".repeat(32) },
  });
  const apis = {
    account: async () =>
      Promise.resolve({ template: "solana.bip44-change", network: SOL_NET, address: PAYER }),
    sign: async () =>
      Promise.resolve({ kind: "solana.transaction", signature: new Uint8Array(64) }),
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
    calls,
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
    method: "solana-core-send",
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
    network: SOL_NET,
    asset: i.asset ?? ASSET,
    to: i.to ?? NEW_OWNER,
    fee: "normal",
  });

describe("solana-nft-send via SPL", () => {
  it("a supply-1 decimals-0 SPL mint sends like any other token", async () => {
    const w = solanaWorld({ mint: { supply: 1n, decimals: 0 } });
    await w.start();
    const p = await w.requests.prepare({
      method: "send",
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
      network: SOL_NET,
      to: NEW_OWNER,
      amount: 1n,
      token: NFT_MINT,
      decimals: 0,
      fee: "normal",
    });
    expect((p.display as { summary: string }).summary).toBe("transfer");
  });
});

describe("solana-core-send", () => {
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
    await expect(prepareCore(w)).rejects.toThrow("not a Metaplex Core account");
  });

  it("an asset the account does not own refuses", async () => {
    const w = solanaWorld({
      asset: { owner: MPL_CORE_PROGRAM, data: coreAssetBytes(NEW_OWNER, 2) },
    });
    await w.start();
    await expect(prepareCore(w)).rejects.toThrow("does not own the asset");
  });

  it("a non-AssetV1 key refuses", async () => {
    const bad = new Uint8Array(66);
    bad[0] = 5;
    bad.set(toBytes(PAYER), 1);
    const w = solanaWorld({ asset: { owner: MPL_CORE_PROGRAM, data: base64.encode(bad) } });
    await w.start();
    await expect(prepareCore(w)).rejects.toThrow("not an mpl-core asset");
  });
});
