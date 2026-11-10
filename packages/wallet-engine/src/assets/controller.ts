/**
 * EVM balances per (account address, network). Native via eth_getBalance; token balanceOf calls go
 * through the network's Multicall3 (one aggregate eth_call) when the registry declares it,
 * otherwise one eth_call per token. Custom tokens persist in the EngineStore as unverified until a
 * built-in-table merge marks them otherwise. State values are display-only: transaction build
 * always re-reads the chain.
 */
import { encodeFunctionData, decodeFunctionResult, isAddress, isHex } from "viem";
import type { PublicClient } from "viem";

import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import { evmTokenTable } from "@qntx/wallet-chains/evm";

import { BtcUtxoStore, scanChain, scanUtxos } from "../chains/bitcoin-scan.ts";
import { isFrozen } from "../chains/bitcoin.ts";
import { ERC20_ABI, evmRpcHex } from "../chains/evm.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { NetworkController } from "../networks/controller.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";

const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);

const arr = (v: unknown): v is ReadonlyArray<unknown> => Array.isArray(v);

const COLLECTION = "assets-custom-tokens";
const POLL_MS = 60_000;

export type TokenBalance = {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly balance: string;
  /** False for user-added tokens until they appear in the built-in table. */
  readonly verified: boolean;
};

export type AccountBalances = {
  readonly native: string;
  readonly tokens: ReadonlyArray<TokenBalance>;
  /** Bitcoin only — confirmed + own unconfirmed change; frozen 546/330-sat UTXOs shown apart. */
  readonly unconfirmed?: string;
  readonly frozen?: string;
};

export type AssetsControllerState = {
  readonly balances: Record<string, AccountBalances>;
};

type Options = {
  readonly networks: NetworkController;
  readonly openStore: () => Promise<EngineStore>;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly logger: EngineLogger;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const checked = (v: string): `0x${string}` => {
  if (!isAddress(v)) {
    throw new TypeError(`malformed evm address: ${v}`);
  }
  return v;
};

const key = (network: string, address: string): string => `${network}:${address}`;

export const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
    stateMutability: "payable",
  },
] as const;

export class AssetsController extends Controller<AssetsControllerState> {
  private readonly options: Options;
  private engineStore: EngineStore | undefined;
  private readonly bitcoinUtxos = new BtcUtxoStore();
  private visible = false;
  private cancelPoll: (() => void) | undefined;
  private readonly customTokens = new Map<
    string,
    ReadonlyArray<{ address: string; verified: boolean }>
  >();
  /** State key → the `refresh` arguments that produced it (the address is the xpub for BTC). */
  private readonly tracked = new Map<
    string,
    { readonly network: string; readonly address: string }
  >();

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
              isObject(t) && typeof t["address"] === "string" && typeof t["verified"] === "boolean"
                ? [{ address: t["address"], verified: t["verified"] }]
                : [],
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
    await Promise.all(
      [...this.tracked.values()].map(async ({ network, address }) =>
        this.refresh(address, network),
      ),
    );
  }

  /** Writes `balances` under `stateKey` and remembers how to refresh it. */
  private record(
    stateKey: string,
    network: string,
    address: string,
    balances: AccountBalances,
  ): AccountBalances {
    this.tracked.set(stateKey, { network, address });
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
      return this.refreshBitcoin(address, network);
    }
    const client = this.options.networks.client(network);
    const native = BigInt(
      await evmRpcHex(client, "eth_getBalance", [address, "latest"]),
    ).toString();
    const custom = this.customTokens.get(network) ?? [];
    const tokens = await this.readTokens(
      client,
      info.multicall3,
      address,
      custom.map((t) => ({ address: t.address, verified: t.verified })),
    );
    return this.record(key(network, address), network, address, { native, tokens });
  }

  /** SOL via getBalance; SPL via getTokenAccountsByOwner (jsonParsed) for known mints. */
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
    const custom = this.customTokens.get(network) ?? [];
    const tokens = await Promise.all(
      custom.map(async (t) => {
        const accounts = obj(
          await rpc.call("getTokenAccountsByOwner", [
            owner,
            { mint: t.address },
            { encoding: "jsonParsed" },
          ]),
        );
        const first = arr(accounts?.["value"]) ? accounts?.["value"][0] : undefined;
        const parsed = obj(obj(obj(obj(obj(first)?.["account"])?.["data"])?.["parsed"])?.["info"]);
        const amount = obj(parsed?.["tokenAmount"]);
        const mintInfo = obj(
          await rpc.call("getAccountInfo", [t.address, { encoding: "jsonParsed" }]),
        );
        const mintParsed = obj(obj(obj(obj(mintInfo?.["value"])?.["data"])?.["parsed"])?.["info"]);
        return {
          address: t.address,
          symbol: "?",
          decimals: typeof mintParsed?.["decimals"] === "number" ? mintParsed["decimals"] : 9,
          balance: typeof amount?.["amount"] === "string" ? amount["amount"] : "0",
          verified: t.verified,
        };
      }),
    );
    return this.record(key(network, owner), network, owner, { native, tokens });
  }

  private async readTokens(
    client: PublicClient,
    multicall3: string | undefined,
    owner: string,
    tokens: ReadonlyArray<{ address: string; verified: boolean }>,
  ): Promise<ReadonlyArray<TokenBalance>> {
    if (tokens.length === 0) {
      return [];
    }
    const balances =
      multicall3 === undefined
        ? await Promise.all(tokens.map(async (t) => this.balanceOf(client, t.address, owner)))
        : await this.balanceOfBatch(
            client,
            multicall3,
            owner,
            tokens.map((t) => t.address),
          );
    return Promise.all(
      tokens.map(async (t, i) => ({
        address: t.address,
        symbol: (await this.callToken(client, t.address, "symbol")) ?? "?",
        decimals: (await this.callToken(client, t.address, "decimals")) ?? 18,
        balance: balances[i]?.toString() ?? "0",
        verified: t.verified,
      })),
    );
  }

  private async balanceOfBatch(
    client: PublicClient,
    multicall3: string,
    owner: string,
    tokens: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<bigint | undefined>> {
    const data = encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      args: [
        tokens.map((token) => ({
          target: checked(token),
          allowFailure: true,
          callData: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [checked(owner)],
          }),
        })),
      ],
    });
    const result = await evmRpcHex(client, "eth_call", [{ to: multicall3, data }, "latest"]);
    if (!isHex(result)) {
      throw new TypeError("eth_call returned malformed data");
    }
    const decoded = decodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      data: result,
    });
    return decoded.map((r) =>
      r.success
        ? decodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "balanceOf",
            data: r.returnData,
          })
        : undefined,
    );
  }

  private async balanceOf(
    client: PublicClient,
    token: string,
    owner: string,
  ): Promise<bigint | undefined> {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [checked(owner)],
    });
    const result = await evmRpcHex(client, "eth_call", [{ to: token, data }, "latest"]);
    if (!isHex(result)) {
      throw new TypeError("eth_call returned malformed data");
    }
    return decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      data: result,
    });
  }

  private async callToken(
    client: PublicClient,
    token: string,
    fn: "symbol",
  ): Promise<string | undefined>;
  private async callToken(
    client: PublicClient,
    token: string,
    fn: "decimals",
  ): Promise<number | undefined>;
  private async callToken(
    client: PublicClient,
    token: string,
    fn: "symbol" | "decimals",
  ): Promise<string | number | undefined> {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: fn });
    const result = await evmRpcHex(client, "eth_call", [{ to: token, data }, "latest"]);
    if (!isHex(result)) {
      return undefined;
    }
    try {
      return decodeFunctionResult({ abi: ERC20_ABI, functionName: fn, data: result });
    } catch {
      return undefined;
    }
  }

  /** Whether `address` is in the built-in token table of `network` or among the custom tokens. */
  isTracked(network: string, address: string): boolean {
    const wanted = address.toLowerCase();
    const builtIn = Object.keys(
      evmTokenTable[String(this.options.networks.info(network).chainId)] ?? {},
    );
    return (
      builtIn.some((known) => known.toLowerCase() === wanted) ||
      (this.customTokens.get(network) ?? []).some((t) => t.address.toLowerCase() === wanted)
    );
  }

  /** The token's own `symbol` and `decimals` (EVM only); throws when either read fails. */
  async tokenMetadata(
    network: string,
    address: string,
  ): Promise<{ readonly symbol: string; readonly decimals: number }> {
    const client = this.options.networks.client(network);
    const symbol = await this.callToken(client, address, "symbol");
    const decimals = await this.callToken(client, address, "decimals");
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
    await this.callToken(client, address, "symbol");
    await this.callToken(client, address, "decimals");
    await this.persistToken(network, address);
  }

  private async persistToken(network: string, address: string): Promise<void> {
    const existing = this.customTokens.get(network) ?? [];
    if (existing.some((t) => t.address === address)) {
      return;
    }
    const next = [...existing, { address, verified: false }];
    this.customTokens.set(network, next);
    if (this.engineStore !== undefined) {
      const merged: Record<string, ReadonlyArray<{ address: string; verified: boolean }>> = {
        [network]: next,
      };
      for (const [n, list] of this.customTokens) {
        if (n !== network) {
          merged[n] = list;
        }
      }
      await this.engineStore
        .collection(COLLECTION)
        .put("customTokens", new TextEncoder().encode(JSON.stringify(merged)));
    }
  }

  /** BTC balance = confirmed spendable + own unconfirmed change; frozen 546/330 shown separately. */
  async refreshBitcoin(xpub: string, network: string): Promise<AccountBalances> {
    const es = this.options.networks.esplora(network);
    const net = bitcoinNetwork(network);
    const template = "btc.bip84" as const;
    const receive = await scanChain(es, xpub, template, network, net.params, 0);
    const change = await scanChain(es, xpub, template, network, net.params, 1);
    const addresses = [...receive, ...change];
    const scanned = await scanUtxos(es, addresses, net.params);
    this.bitcoinUtxos.replace(scanned);
    const changeSet = new Set(change.map((a) => a.address));
    let confirmed = 0n;
    let ownUnconfirmed = 0n;
    let frozen = 0n;
    for (const u of this.bitcoinUtxos.all()) {
      const v = BigInt(u.value);
      if (isFrozen(u.value)) {
        frozen += v;
      } else if (u.height > 0) {
        confirmed += v;
      } else if (changeSet.has(u.address)) {
        ownUnconfirmed += v;
      }
    }
    return this.record(`${xpub}:${network}:BTC`, network, xpub, {
      native: confirmed.toString(),
      tokens: [],
      unconfirmed: ownUnconfirmed.toString(),
      frozen: frozen.toString(),
    });
  }
}
