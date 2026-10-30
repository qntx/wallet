/**
 * EVM balances per (account address, network). Native via eth_getBalance; token balanceOf calls go
 * through the network's Multicall3 (one aggregate eth_call) when the registry declares it,
 * otherwise one eth_call per token. Custom tokens persist in the EngineStore as unverified until a
 * built-in-table merge marks them otherwise. State values are display-only: transaction build
 * always re-reads the chain.
 */
import { encodeFunctionData, decodeFunctionResult, isAddress, isHex } from "viem";
import type { PublicClient } from "viem";

import { ERC20_ABI } from "../chains/evm.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { EngineStore } from "../store/port.ts";

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
  private visible = false;
  private cancelPoll: (() => void) | undefined;
  private readonly customTokens = new Map<
    string,
    ReadonlyArray<{ address: string; verified: boolean }>
  >();

  constructor(options: Options) {
    super({ name: "assets", defaultState: () => ({ balances: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    this.engineStore = await this.options.openStore();
    const listed = await this.engineStore.collection(COLLECTION).get("customTokens");
    if (listed !== undefined) {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(listed));
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
      Object.keys(this.getState().balances).flatMap((entry) => {
        const [network, address] = entry.split(":");
        return network === undefined || address === undefined
          ? []
          : [this.refresh(address, network)];
      }),
    );
  }

  async refresh(address: string, network: string): Promise<void> {
    const client = this.options.networks.client(network);
    const info = this.options.networks.info(network);
    const native = BigInt(
      await this.rpcHex(client, "eth_getBalance", [address, "latest"]),
    ).toString();
    const custom = this.customTokens.get(network) ?? [];
    const tokens = await this.readTokens(
      client,
      info.multicall3,
      address,
      custom.map((t) => ({ address: t.address, verified: t.verified })),
    );
    this.update((s) => ({
      balances: { ...s.balances, [key(network, address)]: { native, tokens } },
    }));
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
        symbol: (await this.callString(client, t.address, "symbol")) ?? "?",
        decimals: (await this.callNumber(client, t.address, "decimals")) ?? 18,
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
    const result = await this.rpcHex(client, "eth_call", [{ to: multicall3, data }, "latest"]);
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
    const result = await this.rpcHex(client, "eth_call", [{ to: token, data }, "latest"]);
    if (!isHex(result)) {
      throw new TypeError("eth_call returned malformed data");
    }
    return decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      data: result,
    });
  }

  private async callString(
    client: PublicClient,
    token: string,
    fn: "symbol",
  ): Promise<string | undefined> {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: fn });
    const result = await this.rpcHex(client, "eth_call", [{ to: token, data }, "latest"]);
    if (!isHex(result)) {
      return undefined;
    }
    try {
      return decodeFunctionResult({ abi: ERC20_ABI, functionName: fn, data: result });
    } catch {
      return undefined;
    }
  }

  private async callNumber(
    client: PublicClient,
    token: string,
    fn: "decimals",
  ): Promise<number | undefined> {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: fn });
    const result = await this.rpcHex(client, "eth_call", [{ to: token, data }, "latest"]);
    if (!isHex(result)) {
      return undefined;
    }
    try {
      return decodeFunctionResult({ abi: ERC20_ABI, functionName: fn, data: result });
    } catch {
      return undefined;
    }
  }

  /** Reads symbol/decimals on-chain, marks unverified, persists; throws when the calls fail. */
  async addToken(network: string, address: string): Promise<void> {
    const client = this.options.networks.client(network);
    await this.callString(client, address, "symbol");
    await this.callNumber(client, address, "decimals");
    const existing = this.customTokens.get(network) ?? [];
    if (existing.some((t) => t.address === address)) {
      return;
    }
    const next = [...existing, { address, verified: false }];
    this.customTokens.set(network, next);
    if (this.engineStore !== undefined) {
      await this.engineStore
        .collection(COLLECTION)
        .put("customTokens", new TextEncoder().encode(JSON.stringify({ [network]: next })));
    }
  }

  private async rpc(client: PublicClient, method: string, params: unknown[]): Promise<unknown> {
    return client.transport.request({ method, params });
  }

  private async rpcHex(client: PublicClient, method: string, params: unknown[]): Promise<string> {
    const result: unknown = await this.rpc(client, method, params);
    if (typeof result !== "string") {
      throw new TypeError(`${method} returned a malformed result`);
    }
    return result;
  }
}
