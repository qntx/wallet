/**
 * Audit A1 lane data-services — PoCs for what the engine's balance read path shows today. Each test
 * PASSES by asserting the current (defective) behaviour; a fix flips the assertion.
 */
import { HDKey } from "@scure/bip32";
import { NETWORK, p2tr, p2wpkh } from "@scure/btc-signer";
import { encodeFunctionData, encodeFunctionResult } from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { AssetsController, MULTICALL3_ABI } from "../src/assets/controller.ts";
import { scripthash } from "../src/chains/bitcoin-scan.ts";
import type { Esplora } from "../src/chains/bitcoin.ts";
import { ERC20_ABI } from "../src/chains/evm.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const logger = { warn: () => {} } as never;
const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_OWNER = "Owner1111111111111111111111111111111111111";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EVM_OWNER = "0x2222222222222222222222222222222222222222" as const;
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const make = (networks: unknown): AssetsController =>
  new AssetsController({
    networks: networks as never,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: () => () => {},
    logger,
  });

/** Esplora fake: per-scripthash txs and utxos; records every scripthash it is asked about. */
const esplora = (
  funded: Record<string, { txs: unknown[]; utxo: unknown[] }>,
  asked: string[],
): Esplora => ({
  get: async (path) => {
    const m = /^\/scripthash\/([0-9a-f]+)\/(txs|utxo)$/.exec(path);
    if (m === null) {
      return Promise.reject(new Error(`unmocked ${path}`));
    }
    const hash = m[1] ?? "";
    asked.push(hash);
    const entry = funded[hash];
    return Promise.resolve(m[2] === "txs" ? (entry?.txs ?? []) : (entry?.utxo ?? []));
  },
  post: async () => Promise.reject(new Error("unmocked")),
});

const btcNetworks = (es: Esplora) => ({
  info: () => ({ family: "bitcoin" }),
  esplora: () => es,
});

/** A BIP-86 account xpub and its first receive key as a taproot and as a P2WPKH address. */
const taprootFixture = () => {
  const account = HDKey.fromMasterSeed(new Uint8Array(64).fill(7)).derive("m/86'/0'/0'");
  const receive0 = account.derive("m/0/0").publicKey;
  if (receive0 === null) {
    throw new Error("no key");
  }
  return {
    xpub: account.publicExtendedKey,
    taprootAddress: p2tr(receive0.subarray(1), undefined, NETWORK).address ?? "",
    p2wpkhAddress: p2wpkh(receive0, NETWORK).address ?? "",
  };
};

describe("DS PoC — Bitcoin balance read", () => {
  it("DS-01: a watched Bitcoin address cannot be read — refresh treats it as an xpub", async () => {
    /* engine.ts:781-786 `watch.assets` → `assets.refresh(account.address, network)`;
       a bitcoin watch account stores a plain address (accounts/watch.ts:39-55). */
    const assets = make(btcNetworks(esplora({}, [])));
    await assets.init();
    await expect(
      assets.refresh("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", BTC_NET),
    ).rejects.toThrow(/xpub/);
  });

  it("DS-02: funds on BIP-86 (taproot) addresses read as 0 — refreshBitcoin hard-codes btc.bip84", async () => {
    const { xpub, taprootAddress, p2wpkhAddress } = taprootFixture();
    const funded = {
      [scripthash(taprootAddress, NETWORK)]: {
        txs: [{ txid: "aa".repeat(32) }],
        utxo: [
          { txid: "aa".repeat(32), vout: 0, value: 100_000, status: { block_height: 900_000 } },
        ],
      },
    };
    const asked: string[] = [];
    const assets = make(btcNetworks(esplora(funded, asked)));
    await assets.init();
    const balances = await assets.refresh(xpub, BTC_NET);
    expect(balances.native).toBe("0");
    expect(asked).toContain(scripthash(p2wpkhAddress, NETWORK));
    expect(asked).not.toContain(scripthash(taprootAddress, NETWORK));
  });
});

const solRpc = (handlers: Record<string, unknown>): SolanaRpc => ({
  call: async (method, params) => {
    const v = handlers[method];
    return method in handlers
      ? Promise.resolve(typeof v === "function" ? (v as (p?: unknown[]) => unknown)(params) : v)
      : Promise.reject(new Error(`unmocked ${method}`));
  },
});

const tokenAccount = (pubkey: string, amount: string) => ({
  pubkey,
  account: {
    owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    data: {
      parsed: {
        info: { mint: USDC_SOL, owner: SOL_OWNER, tokenAmount: { amount, decimals: 6 } },
        type: "account",
      },
      program: "spl-token",
    },
  },
});

describe("DS PoC — Solana SPL balance read", () => {
  it("DS-03: only the first token account per mint is counted; an empty one listed first hides the balance", async () => {
    /* Anyone can create a token account whose owner is the victim (InitializeAccount3 takes the
       owner as an argument); getTokenAccountsByOwner returns every one of them. */
    let accountInfo: unknown = {
      value: { data: { parsed: { info: { decimals: 6 } }, program: "spl-token" } },
    };
    const assets = make({
      info: () => ({ family: "solana" }),
      solanaRpc: () =>
        solRpc({
          getBalance: { value: 1 },
          getAccountInfo: () => accountInfo,
          getTokenAccountsByOwner: () => ({
            value: [tokenAccount("Dust111", "0"), tokenAccount("RealAta", "250000000")],
          }),
        }),
    });
    await assets.init();
    await assets.addToken(SOL_NET, USDC_SOL);
    const first = await assets.refresh(SOL_OWNER, SOL_NET);
    expect(first.tokens[0]?.balance).toBe("0");
    expect(first.tokens[0]?.symbol).toBe("?");

    /* DS-05 (Solana half): a mint read that does not parse silently becomes 9 decimals. */
    accountInfo = { value: null };
    const second = await assets.refresh(SOL_OWNER, SOL_NET);
    expect(second.tokens[0]?.decimals).toBe(9);
  });
});

const SYMBOL_CALL = encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" });
const DECIMALS_CALL = encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" });
const word = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;

/**
 * An EVM client for one ERC-20: native balance 0, `symbol`, `decimals()` from `decimals` (a raw hex
 * answer), and `balance` either through Multicall3 `aggregate3` or a plain `balanceOf`.
 */
const erc20Client = (token: {
  readonly symbol: string;
  readonly decimals: () => string;
  readonly balance: bigint;
  readonly multicall: boolean;
  readonly calls?: string[];
}): PublicClient =>
  ({
    transport: {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        token.calls?.push(method);
        if (method === "eth_getBalance") {
          return Promise.resolve("0x0");
        }
        const data = (params?.[0] as { data?: string } | undefined)?.data ?? "";
        if (data === SYMBOL_CALL) {
          return Promise.resolve(
            encodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", result: token.symbol }),
          );
        }
        if (data === DECIMALS_CALL) {
          return Promise.resolve(token.decimals());
        }
        return Promise.resolve(
          token.multicall
            ? encodeFunctionResult({
                abi: MULTICALL3_ABI,
                functionName: "aggregate3",
                result: [{ success: true, returnData: word(token.balance) as `0x${string}` }],
              })
            : word(token.balance),
        );
      },
    },
  }) as unknown as PublicClient;

describe("DS PoC — EVM balance read", () => {
  it("DS-04: a held built-in token (USDC) is not shown until the user adds it, and then reads unverified", async () => {
    const calls: string[] = [];
    const c = erc20Client({
      symbol: "USDC",
      decimals: () => word(6n),
      balance: 5_000_000n,
      multicall: true,
      calls,
    });
    const assets = make({
      client: () => c,
      info: () => ({ family: "evm", chainId: 1, multicall3: MULTICALL3 }),
    });
    await assets.init();
    expect(assets.isTracked("eip155:1", USDC_ETH)).toBe(true);
    const before = await assets.refresh(EVM_OWNER, "eip155:1");
    expect(before.tokens).toStrictEqual([]);
    expect(calls).toStrictEqual(["eth_getBalance"]);

    await assets.addToken("eip155:1", USDC_ETH);
    const after = await assets.refresh(EVM_OWNER, "eip155:1");
    expect(after.tokens[0]).toMatchObject({ symbol: "USDC", balance: "5000000", verified: false });
  });

  it("DS-05 (EVM half): a decimals() read that fails to decode is shown with 18 decimals", async () => {
    let decimalsAnswer = word(6n);
    const c = erc20Client({
      symbol: "TKN",
      decimals: () => decimalsAnswer,
      balance: 1_000_000n,
      multicall: false,
    });
    const assets = make({ client: () => c, info: () => ({ family: "evm", chainId: 1 }) });
    await assets.init();
    await assets.addToken("eip155:1", "0x1111111111111111111111111111111111111111");
    decimalsAnswer = "0x";
    const read = await assets.refresh(EVM_OWNER, "eip155:1");
    expect(read.tokens[0]).toMatchObject({ balance: "1000000", decimals: 18 });
  });
});

describe("DS PoC — Bitcoin refresh cost", () => {
  /**
   * Esplora calls one `refresh` makes for an account with `usedReceive`/`usedChange` used
   * addresses.
   */
  const callsFor = async (usedReceive: number, usedChange: number): Promise<number> => {
    const account = HDKey.fromMasterSeed(new Uint8Array(64).fill(9)).derive("m/84'/0'/0'");
    const funded: Record<string, { txs: unknown[]; utxo: unknown[] }> = {};
    const mark = (chain: 0 | 1, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const pub = account.derive(`m/${chain}/${i}`).publicKey;
        if (pub !== null) {
          funded[scripthash(p2wpkh(pub, NETWORK).address ?? "", NETWORK)] = {
            txs: [{ txid: "bb".repeat(32) }],
            utxo: [],
          };
        }
      }
    };
    mark(0, usedReceive);
    mark(1, usedChange);
    const asked: string[] = [];
    const assets = make(btcNetworks(esplora(funded, asked)));
    await assets.init();
    await assets.refresh(account.publicExtendedKey, BTC_NET);
    return asked.length;
  };

  it("DS-06: every 60 s poll re-walks the whole gap chain — 80 calls for an empty account, 260 for 60+40 used", async () => {
    await expect(callsFor(0, 0)).resolves.toBe(80);
    await expect(callsFor(60, 40)).resolves.toBe(260);
  });
});
