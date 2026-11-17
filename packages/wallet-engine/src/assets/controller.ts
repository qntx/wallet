/**
 * Balances per (account address, network). EVM native via eth_getBalance; the tracked token set is
 * the built-in table (EVM `evmTokenTable[chainId]`, Solana `solanaTokenTable[network]`) plus the
 * user's custom tokens — `verified` is decided at read time, true exactly for table entries, and is
 * never persisted. Custom tokens persist in the EngineStore as `{ address }` records. State values
 * are display-only: transaction build always re-reads the chain.
 */
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
import { bitcoinBalances, readBitcoin } from "./bitcoin.ts";
import type { BitcoinSourceKey, BitcoinTotals, BitcoinUtxoView } from "./bitcoin.ts";
import { callToken, readEvmTokens } from "./evm.ts";
import type { EvmTokenSpec } from "./evm.ts";
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
    this.cancelPoll = this.options.setTimer(POLL_MS, () => {
      void (async () => {
        try {
          await this.refreshAll();
        } catch (error) {
          this.options.logger.warn("assets refresh failed", error);
        }
      })();
    });
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
    const tokens = await readEvmTokens(client, info.multicall3, address, this.evmTracked(network));
    return this.record(key(network, address), { native, tokens }, async () =>
      this.refresh(address, network),
    );
  }

  /**
   * Tracked tokens = built-in table entries in table order (metadata from the table), then custom
   * tokens not matching a table key — EVM addresses compare case-insensitively.
   */
  private evmTracked(network: string): ReadonlyArray<EvmTokenSpec> {
    const table = evmTokenTable[String(this.options.networks.info(network).chainId)] ?? {};
    const keys = Object.keys(table);
    const custom = (this.customTokens.get(network) ?? [])
      .filter((a) => !keys.some((k) => k.toLowerCase() === a.toLowerCase()))
      .map((address): EvmTokenSpec => ({ address }));
    return [
      ...Object.entries(table).map(([address, t]): EvmTokenSpec => ({
        address,
        known: { symbol: t.symbol, decimals: t.decimals },
      })),
      ...custom,
    ];
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
    const tokens = [
      ...builtin,
      ...(await Promise.all(
        custom.map(async (mint) => this.solanaToken(rpc, mint, holdings.get(mint))),
      )),
    ];
    return this.record(key(network, owner), { native, tokens }, async () =>
      this.refresh(owner, network),
    );
  }

  /** A custom mint's entry: balance/frozen from the holdings map, decimals from the mint read. */
  private async solanaToken(
    rpc: SolanaRpc,
    mint: string,
    held: SolanaTokenHolding | undefined,
  ): Promise<TokenBalance> {
    const mintInfo = obj(await rpc.call("getAccountInfo", [mint, { encoding: "jsonParsed" }]));
    const mintParsed = obj(obj(obj(obj(mintInfo?.["value"])?.["data"])?.["parsed"])?.["info"]);
    return solanaEntry(
      mint,
      "?",
      typeof mintParsed?.["decimals"] === "number" ? mintParsed["decimals"] : 9,
      held,
      false,
    );
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
      const rpc = this.options.networks.solanaRpc(network);
      const mint = obj(await rpc.call("getAccountInfo", [address, { encoding: "jsonParsed" }]));
      const decimals = obj(obj(obj(mint?.["value"])?.["data"])?.["parsed"])?.["info"];
      if (typeof obj(decimals)?.["decimals"] !== "number") {
        throw new TypeError(`${address} is not a readable SPL mint on ${network}`);
      }
      await this.persistToken(network, address);
      return;
    }
    const client = this.options.networks.client(network);
    await callToken(client, address, "symbol");
    await callToken(client, address, "decimals");
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
