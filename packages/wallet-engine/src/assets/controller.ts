/**
 * Balances per (account address, network). EVM native via eth_getBalance; the tracked token set is
 * the built-in table (EVM `evmTokenTable[chainId]`, Solana `solanaTokenTable[network]`) plus the
 * user's custom tokens — `verified` is decided at read time, true exactly for table entries, and is
 * never persisted. Custom tokens persist in the EngineStore as `{ address }` records. State values
 * are display-only: transaction build always re-reads the chain.
 */
import type { PublicClient } from "viem";

import { evmTokenTable } from "@qntx/wallet-chains/evm";
import { solanaTokenTable } from "@qntx/wallet-chains/solana";
import type { ChainsApi } from "@qntx/wallet/chains";

import { BITCOIN_TEMPLATES } from "../chains/bitcoin-scan.ts";
import type { BitcoinSource } from "../chains/bitcoin-scan.ts";
import { evmRpcHex } from "../chains/evm.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { NetworkController, SolanaRpc } from "../networks/controller.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import { repeat } from "../timer.ts";
import { bitcoinBalances, readBitcoin } from "./bitcoin.ts";
import type { BitcoinSourceKey, BitcoinTotals, BitcoinUtxoView } from "./bitcoin.ts";
import { callToken, readEvmBalances, readEvmMetadata } from "./evm.ts";
import type { EvmTokenMetadata } from "./evm.ts";
import { solanaTokenHoldings } from "./solana.ts";
import type { SolanaTokenHolding } from "./solana.ts";

const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);

const COLLECTION = "assets-custom-tokens";
const POLL_MS = 60_000;

export type TokenBalance = {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly balance: string;
  /** Solana only, present when non-zero — a frozen token account cannot be moved until thawed. */
  readonly frozen?: string;
  /** True exactly when the token is a built-in-table entry; computed at read time. */
  readonly verified: boolean;
};

export type AccountBalances = {
  readonly native: string;
  readonly tokens: ReadonlyArray<TokenBalance>;
  /** Bitcoin only — confirmed + own unconfirmed change; protected (inscription) UTXOs apart. */
  readonly unconfirmed?: string;
  readonly frozen?: string;
  /** Bitcoin only — the same totals split by the source they were read from. */
  readonly sources?: Readonly<Partial<Record<BitcoinSourceKey, BitcoinTotals>>>;
  /** Bitcoin only — every UTXO seen, with the source that produced it and its spend protection. */
  readonly utxos?: ReadonlyArray<BitcoinUtxoView>;
};

export type AssetsControllerState = {
  readonly balances: Record<string, AccountBalances>;
};

type Options = {
  readonly networks: NetworkController;
  readonly chains: Pick<ChainsApi, "account">;
  readonly openStore: () => Promise<EngineStore>;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly logger: EngineLogger;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const key = (network: string, address: string): string => `${network}:${address}`;

/** One mint's entry; `frozen` only appears when the holdings read counted frozen accounts. */
const solanaEntry = (
  mint: string,
  symbol: string,
  decimals: number,
  held: SolanaTokenHolding | undefined,
  verified: boolean,
): TokenBalance => {
  const frozen = held !== undefined && held.frozen > 0n ? held.frozen.toString() : undefined;
  return {
    address: mint,
    symbol,
    decimals,
    balance: held?.balance.toString() ?? "0",
    ...(frozen === undefined ? {} : { frozen }),
    verified,
  };
};

export class AssetsController extends Controller<AssetsControllerState> {
  private readonly options: Options;
  private engineStore: EngineStore | undefined;
  private visible = false;
  private cancelPoll: (() => void) | undefined;
  private readonly customTokens = new Map<string, ReadonlyArray<string>>();
  /**
   * Chain-read ERC-20 metadata per `network:lowercase-address` for this unlock; entries without
   * readable decimals are never cached so a later read can succeed.
   */
  private readonly meta = new Map<string, EvmTokenMetadata>();
  /** State key → the read that produced it, so a poll re-runs whichever entry was written. */
  private readonly tracked = new Map<string, () => Promise<AccountBalances>>();

  constructor(options: Options) {
    super({ name: "assets", defaultState: () => ({ balances: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    this.engineStore = await this.options.openStore();
    const listed = await this.engineStore.collection(COLLECTION).get("customTokens");
    if (listed !== undefined) {
      const parsed = readJson(listed);
      if (isObject(parsed)) {
        for (const [network, arr] of Object.entries(parsed)) {
          if (Array.isArray(arr)) {
            const tokens = arr.flatMap((t: unknown) =>
              isObject(t) && typeof t["address"] === "string" ? [t["address"]] : [],
            );
            this.customTokens.set(network, tokens);
          }
        }
      }
    }
    if (this.visible) {
      this.armPoll();
    }
  }

  lock(): void {
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    this.customTokens.clear();
    this.meta.clear();
    this.tracked.clear();
    this.engineStore = undefined;
    this.update(() => ({ balances: {} }));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.cancelPoll?.();
      this.cancelPoll = undefined;
      return;
    }
    this.armPoll();
  }

  private armPoll(): void {
    if (this.cancelPoll !== undefined) {
      return;
    }
    this.cancelPoll = repeat(
      this.options.setTimer,
      POLL_MS,
      async () => this.refreshAll(),
      (error) => {
        this.options.logger.warn("assets refresh failed", error);
      },
    );
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([...this.tracked.values()].map(async (read) => read()));
  }

  /** Writes `balances` under `stateKey` and remembers the read that produced it. */
  private record(
    stateKey: string,
    balances: AccountBalances,
    reread: () => Promise<AccountBalances>,
  ): AccountBalances {
    this.tracked.set(stateKey, reread);
    this.update((s) => ({ balances: { ...s.balances, [stateKey]: balances } }));
    return balances;
  }

  /** Reads the address's balances and returns exactly what it wrote under its state key. */
  async refresh(address: string, network: string): Promise<AccountBalances> {
    const info = this.options.networks.info(network);
    if (info.family === "solana") {
      return this.refreshSolana(address, network);
    }
    if (info.family === "bitcoin") {
      return this.refreshBitcoinAddress(address, network);
    }
    const client = this.options.networks.client(network);
    const native = BigInt(
      await evmRpcHex(client, "eth_getBalance", [address, "latest"]),
    ).toString();
    const tokens = await this.evmTokens(client, info.multicall3, address, network);
    return this.record(key(network, address), { native, tokens }, async () =>
      this.refresh(address, network),
    );
  }

  /**
   * The tracked tokens' balances: built-in table entries in table order (metadata from the table),
   * then custom tokens not matching a table key — EVM addresses compare case-insensitively. Custom
   * metadata comes from the chain via the per-unlock cache; a token whose decimals cannot be read
   * is omitted rather than shown with a guess.
   */
  private async evmTokens(
    client: PublicClient,
    multicall3: string | undefined,
    owner: string,
    network: string,
  ): Promise<ReadonlyArray<TokenBalance>> {
    const table = evmTokenTable[String(this.options.networks.info(network).chainId)] ?? {};
    const keys = Object.keys(table);
    const custom = (this.customTokens.get(network) ?? []).filter(
      (a) => !keys.some((k) => k.toLowerCase() === a.toLowerCase()),
    );
    const tracked = [...keys, ...custom];
    const balances = await readEvmBalances(client, multicall3, owner, tracked);
    await this.loadEvmMetadata(
      client,
      multicall3,
      network,
      custom.map((address) => ({ address, symbol: true })),
    );
    return tracked.flatMap((address, i): TokenBalance[] => {
      const known = table[address];
      if (known !== undefined) {
        return [
          {
            address,
            symbol: known.symbol,
            decimals: known.decimals,
            balance: (balances[i] ?? 0n).toString(),
            verified: true,
          },
        ];
      }
      const read = this.meta.get(`${network}:${address.toLowerCase()}`);
      if (read?.decimals === undefined) {
        return [];
      }
      return [
        {
          address,
          symbol: read.symbol ?? "?",
          decimals: read.decimals,
          balance: (balances[i] ?? 0n).toString(),
          verified: false,
        },
      ];
    });
  }

  /** Fills the per-unlock metadata cache for `wants` in one batched read; failures stay uncached. */
  private async loadEvmMetadata(
    client: PublicClient,
    multicall3: string | undefined,
    network: string,
    wants: ReadonlyArray<{ readonly address: string; readonly symbol: boolean }>,
  ): Promise<void> {
    const missing = wants.filter(
      (want) => this.meta.get(`${network}:${want.address.toLowerCase()}`) === undefined,
    );
    if (missing.length === 0) {
      return;
    }
    const read = await readEvmMetadata(client, multicall3, missing);
    for (const [i, want] of missing.entries()) {
      const got = read[i];
      if (got !== undefined && got.decimals !== undefined) {
        this.meta.set(`${network}:${want.address.toLowerCase()}`, got);
      }
    }
  }

  /** SOL via getBalance; SPL holdings summed per mint over both token programs. */
  private async refreshSolana(owner: string, network: string): Promise<AccountBalances> {
    const rpc = this.options.networks.solanaRpc(network);
    const bal = obj(await rpc.call("getBalance", [owner, { commitment: "confirmed" }]));
    const balValue = bal?.["value"];
    const native =
      typeof balValue === "string"
        ? balValue
        : typeof balValue === "number"
          ? String(balValue)
          : "0";
    const holdings = await solanaTokenHoldings(rpc, owner);
    const table = solanaTokenTable[network] ?? {};
    const builtin = Object.entries(table).map(([mint, t]) =>
      solanaEntry(mint, t.symbol, t.decimals, holdings.get(mint), true),
    );
    const custom = (this.customTokens.get(network) ?? []).filter(
      (mint) => table[mint] === undefined,
    );
    const customs = await Promise.all(
      custom.map(async (mint) => this.solanaToken(rpc, mint, holdings.get(mint))),
    );
    const tokens = [
      ...builtin,
      ...customs.flatMap((token) => (token === undefined ? [] : [token])),
    ];
    return this.record(key(network, owner), { native, tokens }, async () =>
      this.refresh(owner, network),
    );
  }

  /**
   * A custom mint's entry: balance/frozen from the holdings map, decimals from the counted token
   * accounts or the mint itself — `undefined` when neither can be read, and the mint is omitted
   * rather than shown with a guess.
   */
  private async solanaToken(
    rpc: SolanaRpc,
    mint: string,
    held: SolanaTokenHolding | undefined,
  ): Promise<TokenBalance | undefined> {
    const decimals = held?.decimals ?? (await this.mintDecimals(rpc, mint));
    return decimals === undefined ? undefined : solanaEntry(mint, "?", decimals, held, false);
  }

  /** The mint's `decimals` via a parsed mint read, or `undefined` when it cannot be read. */
  private async mintDecimals(rpc: SolanaRpc, mint: string): Promise<number | undefined> {
    const mintInfo = obj(await rpc.call("getAccountInfo", [mint, { encoding: "jsonParsed" }]));
    const parsed = obj(obj(obj(mintInfo?.["value"])?.["data"])?.["parsed"]);
    const decimals = obj(parsed?.["info"])?.["decimals"];
    return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0
      ? decimals
      : undefined;
  }

  /** Whether `address` is in the built-in token table of `network` or among the custom tokens. */
  isTracked(network: string, address: string): boolean {
    const info = this.options.networks.info(network);
    const custom = this.customTokens.get(network) ?? [];
    if (info.family === "solana") {
      return solanaTokenTable[network]?.[address] !== undefined || custom.includes(address);
    }
    const wanted = address.toLowerCase();
    const builtIn = Object.keys(evmTokenTable[String(info.chainId)] ?? {});
    return (
      builtIn.some((known) => known.toLowerCase() === wanted) ||
      custom.some((a) => a.toLowerCase() === wanted)
    );
  }

  /** The token's own `symbol` and `decimals` (EVM only); throws when either read fails. */
  async tokenMetadata(
    network: string,
    address: string,
  ): Promise<{ readonly symbol: string; readonly decimals: number }> {
    const client = this.options.networks.client(network);
    const symbol = await callToken(client, address, "symbol");
    const decimals = await callToken(client, address, "decimals");
    if (symbol === undefined || decimals === undefined) {
      throw new TypeError(`${address} is not a readable ERC-20 token on ${network}`);
    }
    return { symbol, decimals };
  }

  /** Reads symbol/decimals on-chain, marks unverified, persists; throws when the calls fail. */
  async addToken(network: string, address: string): Promise<void> {
    const info = this.options.networks.info(network);
    if (info.family === "solana") {
      if ((solanaTokenTable[network] ?? {})[address] !== undefined) {
        return;
      }
      const rpc = this.options.networks.solanaRpc(network);
      const mint = obj(await rpc.call("getAccountInfo", [address, { encoding: "jsonParsed" }]));
      const decimals = obj(obj(obj(mint?.["value"])?.["data"])?.["parsed"])?.["info"];
      if (typeof obj(decimals)?.["decimals"] !== "number") {
        throw new TypeError(`${address} is not a readable SPL mint on ${network}`);
      }
      await this.persistToken(network, address);
      return;
    }
    const table = evmTokenTable[String(info.chainId)] ?? {};
    if (Object.keys(table).some((a) => a.toLowerCase() === address.toLowerCase())) {
      return;
    }
    const meta = await this.tokenMetadata(network, address);
    this.meta.set(`${network}:${address.toLowerCase()}`, meta);
    await this.persistToken(network, address);
  }

  private async persistToken(network: string, address: string): Promise<void> {
    const existing = this.customTokens.get(network) ?? [];
    const evm = this.options.networks.info(network).family === "evm";
    const wanted = evm ? address.toLowerCase() : address;
    if (existing.some((a) => (evm ? a.toLowerCase() : a) === wanted)) {
      return;
    }
    const next = [...existing, address];
    this.customTokens.set(network, next);
    if (this.engineStore !== undefined) {
      const merged: Record<string, ReadonlyArray<{ address: string }>> = {
        [network]: next.map((a) => ({ address: a })),
      };
      for (const [n, list] of this.customTokens) {
        if (n !== network) {
          merged[n] = list.map((a) => ({ address: a }));
        }
      }
      await this.engineStore
        .collection(COLLECTION)
        .put("customTokens", new TextEncoder().encode(JSON.stringify(merged)));
    }
  }

  /** A watched Bitcoin address's balance, keyed `${network}:${address}` like the other families. */
  private async refreshBitcoinAddress(address: string, network: string): Promise<AccountBalances> {
    const es = this.options.networks.esplora(network);
    const source: BitcoinSource = { kind: "address", address };
    const read = await readBitcoin(es, network, [source]);
    return this.record(key(network, address), bitcoinBalances(read), async () =>
      this.refresh(address, network),
    );
  }

  /**
   * BTC balance of an account group = confirmed spendable + own unconfirmed change across every
   * account template's xpub; protected (inscription) UTXOs shown separately.
   */
  async refreshBitcoinGroup(
    group: { readonly walletId: string; readonly groupIndex: number },
    network: string,
  ): Promise<AccountBalances> {
    if (this.options.networks.info(network).family !== "bitcoin") {
      throw new TypeError(`${network} is not a bitcoin network`);
    }
    const es = this.options.networks.esplora(network);
    const sources = await Promise.all(
      BITCOIN_TEMPLATES.map(async (template): Promise<BitcoinSource> => {
        const account = await this.options.chains.account({ ...group, template, network });
        if (!("xpub" in account)) {
          throw new TypeError(`bitcoin account ${template} on ${network} has no xpub`);
        }
        return { kind: "xpub", template, xpub: account.xpub };
      }),
    );
    const read = await readBitcoin(es, network, sources);
    return this.record(
      `${network}:${group.walletId}:${group.groupIndex}`,
      bitcoinBalances(read),
      async () => this.refreshBitcoinGroup(group, network),
    );
  }
}
