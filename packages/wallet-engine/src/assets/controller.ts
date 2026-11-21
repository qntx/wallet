/**
 * Balances per (account address, network). EVM native via eth_getBalance; Solana native via
 * getBalance. The shown token set is the built-in table plus the user's custom tokens plus — on
 * networks with a Multicall3 and a gateway token list — list tokens discovered with a non-zero
 * balance; on Solana every held mint, known or not, appears.
 *
 * RPC budget per refresh: EVM spends 1 eth_getBalance plus ceil(T/300) aggregate3 eth_calls with T
 * = table + custom + held-discovered; a discovery poll (first read of an unlock, then every
 * {@link DISCOVERY_MS}) reads ceil((T+L)/300) instead, L the network's list size. Chain metadata
 * costs one extra aggregate3 per network per unlock, only when new tokens appear. Solana spends the
 * native balance call plus two getTokenAccountsByOwner scans, and at most one getMultipleAccounts
 * per refresh while uninspected mints remain — each mint inspected once per unlock.
 *
 * Decimals are never assumed: a token whose decimals cannot be read is omitted from the refresh,
 * not shown with a guess. `verified` is decided at read time — built-in table entries, or list
 * entries whose on-chain decimals equal the list's. Spam reasons are computed for unverified tokens
 * only, and `hidden` follows the persisted visibility record plus the spam verdict.
 */
import { address as solanaAddress } from "@solana/kit";
import { isAddress } from "viem";
import type { PublicClient } from "viem";

import { evmTokenTable } from "@qntx/wallet-chains/evm";
import { solanaTokenTable } from "@qntx/wallet-chains/solana";
import type { ChainsApi } from "@qntx/wallet/chains";

import { BITCOIN_TEMPLATES } from "../chains/bitcoin-scan.ts";
import type { BitcoinSource } from "../chains/bitcoin-scan.ts";
import { evmRpcHex } from "../chains/evm.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { GatewayConfig } from "../gateway/client.ts";
import type { NetworkController } from "../networks/controller.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import { repeat } from "../timer.ts";
import { bitcoinBalances, readBitcoin } from "./bitcoin.ts";
import type { BitcoinSourceKey, BitcoinTotals, BitcoinUtxoView } from "./bitcoin.ts";
import { callToken, readEvmBalances, readEvmMetadata } from "./evm.ts";
import type { EvmTokenMetadata } from "./evm.ts";
import { inspectMints, solanaTokenHoldings } from "./solana.ts";
import type { MintFacts } from "./solana.ts";
import { spamReasons, symbolOwners } from "./spam.ts";
import type { SpamReason } from "./spam.ts";
import { TokenLists } from "./token-lists.ts";

const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);

const COLLECTION = "assets-custom-tokens";
const POLL_MS = 60_000;
const DISCOVERY_MS = 10 * 60_000;
const INSPECT_PER_REFRESH = 50;
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type TokenBalance = {
  readonly address: string;
  readonly symbol: string;
  readonly name?: string;
  readonly decimals: number;
  readonly balance: string;
  /** Solana only, present when non-zero — a frozen token account cannot be moved until thawed. */
  readonly frozen?: string;
  /** Built-in table entry, or a list token whose on-chain decimals match the list's. */
  readonly verified: boolean;
  /** Display-time spam verdict; always empty on a verified token. */
  readonly spam: ReadonlyArray<SpamReason>;
  /** Hidden by the user, or flagged spam without an explicit keep. */
  readonly hidden: boolean;
};

export type AccountBalances = {
  readonly native: string;
  readonly tokens: ReadonlyArray<TokenBalance>;
  /** Bitcoin only — confirmed + own unconfirmed change; protected (inscription) UTXOs apart. */
  readonly unconfirmed?: string;
  /**
   * Bitcoin only — outputs protected as possible inscription or rune carriers, counted apart from
   * `native`. User freezes (`transactions.frozenUtxos`) are a separate list: a user-frozen coin
   * still counts in `native`/`unconfirmed`.
   */
  readonly protected?: string;
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
  /**
   * The txids of bitcoin transactions this wallet built — whose height-0 outputs count as own
   * unconfirmed change.
   */
  readonly ownBitcoinTxids: () => ReadonlySet<string>;
  /** The session EngineStore — the engine opens it once per unlock and closes it on lock. */
  readonly openStore: () => Promise<EngineStore>;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly logger: EngineLogger;
  readonly gateway: GatewayConfig | undefined;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const key = (network: string, address: string): string => `${network}:${address}`;

type Visibility = "hidden" | "shown";

export class AssetsController extends Controller<AssetsControllerState> {
  private readonly options: Options;
  private readonly lists: TokenLists;
  private engineStore: EngineStore | undefined;
  private visible = false;
  private cancelPoll: (() => void) | undefined;
  private readonly customTokens = new Map<string, ReadonlyArray<string>>();
  private readonly visibility = new Map<string, Map<string, Visibility>>();
  /**
   * Chain-read ERC-20 metadata per `network:lowercase-address` for this unlock; entries without
   * readable decimals are never cached so a later read can succeed.
   */
  private readonly meta = new Map<string, EvmTokenMetadata>();
  /** Mint facts per `network:mint` for this unlock — each mint is inspected at most once. */
  private readonly mints = new Map<string, MintFacts | "missing">();
  /** State key → the held list tokens found on the last discovery scan, and when it ran. */
  private readonly discovered = new Map<
    string,
    { readonly addresses: ReadonlySet<string>; readonly at: number }
  >();
  /** State key → the read that produced it, so a poll re-runs whichever entry was written. */
  private readonly tracked = new Map<string, () => Promise<AccountBalances>>();
  /** Bumped on lock: a read that resolved across it records nothing into the next session. */
  private generation = 0;

  constructor(options: Options) {
    super({ name: "assets", defaultState: () => ({ balances: {} }) });
    this.options = options;
    this.lists = new TokenLists({
      gateway: options.gateway,
      fetch: options.fetch,
      setTimer: options.setTimer,
      now: options.now,
      logger: options.logger,
    });
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
    const hidden = await this.engineStore.collection(COLLECTION).get("visibility");
    const parsed = hidden === undefined ? undefined : readJson(hidden);
    if (isObject(parsed)) {
      for (const [network, entries] of Object.entries(parsed)) {
        if (!isObject(entries)) {
          continue;
        }
        this.visibility.set(
          network,
          new Map(
            Object.entries(entries).flatMap(
              ([address, v]): ReadonlyArray<readonly [string, Visibility]> =>
                v === "hidden" || v === "shown" ? [[address, v]] : [],
            ),
          ),
        );
      }
    }
    await this.lists.load(this.engineStore);
    if (this.visible) {
      this.armPoll();
    }
  }

  lock(): void {
    this.generation += 1;
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    this.customTokens.clear();
    this.visibility.clear();
    this.meta.clear();
    this.mints.clear();
    this.discovered.clear();
    this.tracked.clear();
    this.lists.clear();
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

  /**
   * Writes `balances` under `stateKey` and remembers the read that produced it — unless the lock
   * generation moved since the read started, in which case the result is returned unwritten: a read
   * landing after `lock()` must not repopulate balances or re-arm its reread.
   */
  private record(
    stateKey: string,
    balances: AccountBalances,
    reread: () => Promise<AccountBalances>,
    generation: number,
  ): AccountBalances {
    if (generation !== this.generation) {
      return balances;
    }
    this.tracked.set(stateKey, reread);
    this.update((s) => ({ balances: { ...s.balances, [stateKey]: balances } }));
    return balances;
  }

  /**
   * The visibility verdict of one token: explicit `hidden` wins, explicit `shown` keeps even a
   * flagged token, and anything else hides exactly when it carries a spam reason.
   */
  private hiddenFor(network: string, canonical: string, spam: ReadonlyArray<SpamReason>): boolean {
    const verdict = this.visibility.get(network)?.get(canonical);
    return verdict === "hidden" || (verdict !== "shown" && spam.length > 0);
  }

  /** Reads the address's balances and returns exactly what it wrote under its state key. */
  async refresh(address: string, network: string): Promise<AccountBalances> {
    const { generation } = this;
    const info = this.options.networks.info(network);
    if (info.family === "solana") {
      return this.refreshSolana(address, network, generation);
    }
    if (info.family === "bitcoin") {
      return this.refreshBitcoinAddress(address, network, generation);
    }
    const client = this.options.networks.client(network);
    const native = BigInt(
      await evmRpcHex(client, "eth_getBalance", [address, "latest"]),
    ).toString();
    const tokens = await this.evmTokens(client, info.multicall3, address, network, generation);
    return this.record(
      key(network, address),
      { native, tokens },
      async () => this.refresh(address, network),
      generation,
    );
  }

  /**
   * The network's eligible list tokens keyed by canonical (lowercase) address: list entries whose
   * symbol does not impersonate a built-in table token at a different address — an impersonator is
   * never a verified entry, however it got on the list.
   */
  private async eligibleEvmList(
    network: string,
    table: Readonly<Record<string, { readonly symbol: string }>>,
  ): Promise<{
    readonly entries: ReadonlyMap<
      string,
      { readonly symbol: string; readonly name: string; readonly decimals: number }
    >;
    readonly owners: ReadonlyMap<string, ReadonlySet<string>>;
  }> {
    const list = await this.lists.entries(network);
    const tableSymbols = new Set(Object.values(table).map((token) => token.symbol.toLowerCase()));
    const tableAddresses = new Set(Object.keys(table).map((k) => k.toLowerCase()));
    const eligible = [...list].filter(
      ([address, entry]) =>
        tableAddresses.has(address) || !tableSymbols.has(entry.symbol.toLowerCase()),
    );
    const owners = symbolOwners([
      ...Object.entries(table).map(([address, token]) => [address.toLowerCase(), token] as const),
      ...eligible,
    ]);
    // Entries sharing a table address are table tokens — they are not "the rest".
    const entries = new Map(eligible.filter(([address]) => !tableAddresses.has(address)));
    return { entries, owners };
  }

  /**
   * The shown EVM tokens: table rows in table order, custom rows in add order, then discovered list
   * tokens by address. Discovery — reading every list token's balance — runs on the first poll of
   * an unlock and every {@link DISCOVERY_MS} after, and only when the network has a Multicall3;
   * between scans only the discovered (still held) list tokens are read. Decimals come from the
   * per-unlock cache, filled in one aggregate3 for the tokens still missing one.
   */
  private async evmTokens(
    client: PublicClient,
    multicall3: string | undefined,
    owner: string,
    network: string,
    generation: number,
  ): Promise<ReadonlyArray<TokenBalance>> {
    const info = this.options.networks.info(network);
    const table = evmTokenTable[String(info.chainId)] ?? {};
    const tableKeys = Object.keys(table);
    const tableByLower = new Map(tableKeys.map((k) => [k.toLowerCase(), k]));
    const custom = (this.customTokens.get(network) ?? []).filter(
      (a) => !tableByLower.has(a.toLowerCase()),
    );
    const customLower = new Set(custom.map((a) => a.toLowerCase()));
    const { entries: list, owners } = await this.eligibleEvmList(network, table);
    const listOnly = [...list.keys()].filter((a) => !customLower.has(a));

    const stateKey = key(network, owner);
    const scan = this.discovered.get(stateKey);
    const due =
      multicall3 !== undefined &&
      (scan === undefined || this.options.now() - scan.at >= DISCOVERY_MS);
    const wanted = due ? listOnly : [...(scan?.addresses ?? new Set<string>())];
    const tracked = [...tableKeys, ...custom];
    const targets = multicall3 === undefined ? tracked : [...tracked, ...wanted];
    const balances = await readEvmBalances(client, multicall3, owner, targets);

    const held = new Map<string, bigint>();
    for (const [i, address] of wanted.entries()) {
      const balance = balances[tracked.length + i];
      if (balance !== undefined && balance > 0n) {
        held.set(address, balance);
      }
    }
    if (multicall3 !== undefined && generation === this.generation) {
      this.discovered.set(stateKey, {
        addresses: new Set(held.keys()),
        at: due ? this.options.now() : (scan?.at ?? this.options.now()),
      });
    }

    await this.loadEvmMetadata(
      client,
      multicall3,
      network,
      [
        ...custom.map((address) => ({ address, symbol: true })),
        ...[...held.keys()].map((address) => ({ address, symbol: false })),
      ],
      generation,
    );

    const rows: TokenBalance[] = [];
    for (const [i, address] of tableKeys.entries()) {
      const known = table[address];
      if (known === undefined) {
        continue;
      }
      rows.push({
        address,
        symbol: known.symbol,
        ...(known.name === undefined ? {} : { name: known.name }),
        decimals: known.decimals,
        balance: (balances[i] ?? 0n).toString(),
        verified: true,
        spam: [],
        hidden: this.hiddenFor(network, address.toLowerCase(), []),
      });
    }
    for (const [j, address] of custom.entries()) {
      const canonical = address.toLowerCase();
      const read = this.meta.get(`${network}:${canonical}`);
      if (read?.decimals === undefined) {
        continue;
      }
      const balance = (balances[tableKeys.length + j] ?? 0n).toString();
      // A custom token that is an eligible list entry is a list token: list symbol and name,
      // chain decimals, verified when they match — still always shown in the custom position.
      const entry = list.get(canonical);
      if (entry !== undefined) {
        const verified = entry.decimals === read.decimals;
        const spam = verified
          ? []
          : spamReasons({
              address: canonical,
              symbol: entry.symbol,
              name: entry.name,
              owners,
            });
        rows.push({
          address,
          symbol: entry.symbol,
          name: entry.name,
          decimals: read.decimals,
          balance,
          verified,
          spam,
          hidden: this.hiddenFor(network, canonical, spam),
        });
        continue;
      }
      const spam = spamReasons({ address: canonical, symbol: read.symbol, owners });
      rows.push({
        address,
        symbol: read.symbol ?? "?",
        decimals: read.decimals,
        balance,
        verified: false,
        spam,
        hidden: this.hiddenFor(network, canonical, spam),
      });
    }
    for (const address of [...held.keys()].sort()) {
      const entry = list.get(address);
      const read = this.meta.get(`${network}:${address}`);
      if (entry === undefined || read?.decimals === undefined) {
        continue;
      }
      const verified = entry.decimals === read.decimals;
      const spam = verified
        ? []
        : spamReasons({ address, symbol: entry.symbol, name: entry.name, owners });
      rows.push({
        address,
        symbol: entry.symbol,
        name: entry.name,
        decimals: read.decimals,
        balance: (held.get(address) ?? 0n).toString(),
        verified,
        spam,
        hidden: this.hiddenFor(network, address, spam),
      });
    }
    return rows;
  }

  /** Fills the per-unlock metadata cache for `wants` in one batched read; failures stay uncached. */
  private async loadEvmMetadata(
    client: PublicClient,
    multicall3: string | undefined,
    network: string,
    wants: ReadonlyArray<{ readonly address: string; readonly symbol: boolean }>,
    generation: number,
  ): Promise<void> {
    const missing = wants.filter(
      (want) => this.meta.get(`${network}:${want.address.toLowerCase()}`) === undefined,
    );
    if (missing.length === 0) {
      return;
    }
    const read = await readEvmMetadata(client, multicall3, missing);
    if (generation !== this.generation) {
      return;
    }
    for (const [i, want] of missing.entries()) {
      const got = read[i];
      if (got !== undefined && got.decimals !== undefined) {
        this.meta.set(`${network}:${want.address.toLowerCase()}`, got);
      }
    }
  }

  /** SOL via getBalance; SPL holdings summed per mint over both token programs. */
  private async refreshSolana(
    owner: string,
    network: string,
    generation: number,
  ): Promise<AccountBalances> {
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
    const list = await this.lists.entries(network);
    const tableSymbols = new Set(Object.values(table).map((token) => token.symbol.toLowerCase()));
    const eligible = new Map(
      [...list].filter(
        ([mint, entry]) =>
          table[mint] !== undefined || !tableSymbols.has(entry.symbol.toLowerCase()),
      ),
    );
    const owners = symbolOwners([...Object.entries(table), ...eligible]);
    for (const mint of Object.keys(table)) {
      eligible.delete(mint);
    }
    const custom = (this.customTokens.get(network) ?? []).filter(
      (mint) => table[mint] === undefined,
    );
    const customSet = new Set(custom);
    const held = [...holdings.entries()].filter(
      ([, holding]) => holding.balance + holding.frozen > 0n,
    );

    // Inspection queue: custom and unverified held-list mints first (they may carry extensions),
    // then held unknown mints in mint order — at most 50 uncached per refresh.
    const cached = (mint: string): boolean => this.mints.has(`${network}:${mint}`);
    const heldUnknown = held
      .map(([mint]) => mint)
      .filter(
        (mint) =>
          table[mint] === undefined && !customSet.has(mint) && !eligible.has(mint) && !cached(mint),
      )
      .sort();
    const queue = [
      ...custom.filter((mint) => !cached(mint)),
      ...held
        .map(([mint]) => mint)
        .filter(
          (mint) =>
            eligible.has(mint) &&
            !customSet.has(mint) &&
            eligible.get(mint)?.decimals !== holdings.get(mint)?.decimals &&
            !cached(mint),
        )
        .sort(),
      ...heldUnknown,
    ];
    const wanted = queue.slice(0, INSPECT_PER_REFRESH);
    if (wanted.length > 0) {
      const inspected = await inspectMints(rpc, wanted);
      if (generation === this.generation) {
        for (const [mint, facts] of inspected) {
          this.mints.set(`${network}:${mint}`, facts);
        }
      }
    }
    const facts = (mint: string): MintFacts | "missing" | undefined =>
      this.mints.get(`${network}:${mint}`);

    const rows: TokenBalance[] = [];
    for (const [mint, known] of Object.entries(table)) {
      const holding = holdings.get(mint);
      rows.push({
        address: mint,
        symbol: known.symbol,
        ...(known.name === undefined ? {} : { name: known.name }),
        decimals: known.decimals,
        balance: holding?.balance.toString() ?? "0",
        ...(holding !== undefined && holding.frozen > 0n
          ? { frozen: holding.frozen.toString() }
          : {}),
        verified: true,
        spam: [],
        hidden: this.hiddenFor(network, mint, []),
      });
    }
    for (const mint of custom) {
      const read = facts(mint);
      if (read === undefined || read === "missing") {
        continue;
      }
      const holding = holdings.get(mint);
      const balance = holding?.balance.toString() ?? "0";
      const frozen =
        holding !== undefined && holding.frozen > 0n ? { frozen: holding.frozen.toString() } : {};
      // A custom mint that is an eligible list entry is a list token (see the EVM rule above).
      const entry = eligible.get(mint);
      if (entry !== undefined) {
        const verified = entry.decimals === read.decimals;
        const spam = verified
          ? []
          : spamReasons({
              address: mint,
              symbol: entry.symbol,
              name: entry.name,
              owners,
              permanentDelegate: read.permanentDelegate,
              nonTransferable: read.nonTransferable,
            });
        rows.push({
          address: mint,
          symbol: entry.symbol,
          name: entry.name,
          decimals: read.decimals,
          balance,
          ...frozen,
          verified,
          spam,
          hidden: this.hiddenFor(network, mint, spam),
        });
        continue;
      }
      const spam = spamReasons({
        address: mint,
        symbol: read.symbol,
        name: read.name,
        owners,
        permanentDelegate: read.permanentDelegate,
        nonTransferable: read.nonTransferable,
      });
      rows.push({
        address: mint,
        symbol: read.symbol ?? "?",
        ...(read.name === undefined ? {} : { name: read.name }),
        decimals: read.decimals,
        balance,
        ...frozen,
        verified: false,
        spam,
        hidden: this.hiddenFor(network, mint, spam),
      });
    }
    const rest = held
      .filter(([mint]) => table[mint] === undefined && !customSet.has(mint))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [mint, holding] of rest) {
      const entry = eligible.get(mint);
      if (entry !== undefined) {
        const verified = entry.decimals === holding.decimals;
        const read = facts(mint);
        const facts0 = read === undefined || read === "missing" ? undefined : read;
        const spam = verified
          ? []
          : spamReasons({
              address: mint,
              symbol: entry.symbol,
              name: entry.name,
              owners,
              permanentDelegate: facts0?.permanentDelegate,
              nonTransferable: facts0?.nonTransferable,
            });
        rows.push({
          address: mint,
          symbol: entry.symbol,
          name: entry.name,
          decimals: holding.decimals,
          balance: holding.balance.toString(),
          ...(holding.frozen > 0n ? { frozen: holding.frozen.toString() } : {}),
          verified,
          spam,
          hidden: this.hiddenFor(network, mint, spam),
        });
        continue;
      }
      const read = facts(mint);
      if (read === undefined || read === "missing") {
        continue;
      }
      if (read.decimals === 0 && read.supply === "1") {
        continue;
      }
      const spam = spamReasons({
        address: mint,
        symbol: read.symbol,
        name: read.name,
        owners,
        permanentDelegate: read.permanentDelegate,
        nonTransferable: read.nonTransferable,
      });
      rows.push({
        address: mint,
        symbol: read.symbol ?? "?",
        ...(read.name === undefined ? {} : { name: read.name }),
        decimals: read.decimals,
        balance: holding.balance.toString(),
        ...(holding.frozen > 0n ? { frozen: holding.frozen.toString() } : {}),
        verified: false,
        spam,
        hidden: this.hiddenFor(network, mint, spam),
      });
    }
    return this.record(
      key(network, owner),
      { native, tokens: rows },
      async () => this.refresh(owner, network),
      generation,
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

  /**
   * Persists the visibility verdict of one token — EVM addresses must be hex, Solana mints base58 —
   * and re-derives `hidden` on that network's state rows without touching the chain. The same
   * verdict applies on the next refresh: a flag stays hidden until explicitly shown.
   */
  async setTokenHidden(network: string, address: string, hidden: boolean): Promise<void> {
    if (this.engineStore === undefined) {
      throw new Error("assets require an unlocked vault");
    }
    const info = this.options.networks.info(network);
    let canonical: string;
    if (info.family === "evm") {
      if (!isAddress(address)) {
        throw new TypeError(`malformed evm address: ${address}`);
      }
      canonical = address.toLowerCase();
    } else if (info.family === "solana") {
      if (!SOLANA_MINT.test(address)) {
        throw new TypeError(`malformed solana mint: ${address}`);
      }
      canonical = solanaAddress(address);
    } else {
      throw new TypeError(`${network} has no tokens`);
    }
    const entries = this.visibility.get(network) ?? new Map<string, Visibility>();
    entries.set(canonical, hidden ? "hidden" : "shown");
    this.visibility.set(network, entries);
    await this.persistVisibility();
    const evm = info.family === "evm";
    this.update((state) => ({
      balances: Object.fromEntries(
        Object.entries(state.balances).map(([stateKey, balances]) => [
          stateKey,
          stateKey.startsWith(`${network}:`)
            ? {
                ...balances,
                tokens: balances.tokens.map((token) => ({
                  ...token,
                  hidden: this.hiddenFor(
                    network,
                    evm ? token.address.toLowerCase() : token.address,
                    token.spam,
                  ),
                })),
              }
            : balances,
        ]),
      ),
    }));
  }

  private async persistVisibility(): Promise<void> {
    const merged: Record<string, Record<string, Visibility>> = {};
    for (const [network, entries] of this.visibility) {
      merged[network] = Object.fromEntries(entries);
    }
    await this.engineStore
      ?.collection(COLLECTION)
      .put("visibility", new TextEncoder().encode(JSON.stringify(merged)));
  }

  /** Reads the mint on-chain, marks unverified, persists; throws when the read fails. */
  async addToken(network: string, address: string): Promise<void> {
    if (this.engineStore === undefined) {
      throw new Error("assets require an unlocked vault");
    }
    const { generation } = this;
    const info = this.options.networks.info(network);
    if (info.family === "solana") {
      if ((solanaTokenTable[network] ?? {})[address] !== undefined) {
        return;
      }
      const rpc = this.options.networks.solanaRpc(network);
      const inspected = await inspectMints(rpc, [address]);
      const facts = inspected.get(address);
      if (facts === undefined || facts === "missing") {
        throw new TypeError(`${address} is not a readable SPL mint on ${network}`);
      }
      if (generation !== this.generation) {
        return;
      }
      this.mints.set(`${network}:${address}`, facts);
      await this.persistToken(network, address, generation);
      return;
    }
    const table = evmTokenTable[String(info.chainId)] ?? {};
    if (Object.keys(table).some((a) => a.toLowerCase() === address.toLowerCase())) {
      return;
    }
    const meta = await this.tokenMetadata(network, address);
    if (generation !== this.generation) {
      return;
    }
    this.meta.set(`${network}:${address.toLowerCase()}`, meta);
    await this.persistToken(network, address, generation);
  }

  private async persistToken(network: string, address: string, generation: number): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
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
  private async refreshBitcoinAddress(
    address: string,
    network: string,
    generation: number,
  ): Promise<AccountBalances> {
    const es = this.options.networks.esplora(network);
    const source: BitcoinSource = { kind: "address", address };
    const read = await readBitcoin(es, network, [source], this.options.ownBitcoinTxids());
    return this.record(
      key(network, address),
      bitcoinBalances(read),
      async () => this.refresh(address, network),
      generation,
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
    const { generation } = this;
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
    const read = await readBitcoin(es, network, sources, this.options.ownBitcoinTxids());
    return this.record(
      `${network}:${group.walletId}:${group.groupIndex}`,
      bitcoinBalances(read),
      async () => this.refreshBitcoinGroup(group, network),
      generation,
    );
  }
}
