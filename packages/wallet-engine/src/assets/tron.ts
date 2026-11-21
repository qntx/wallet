/**
 * TRON balances: the liquid TRX plus TRC-20/TRC-10 rows and the stake-resource view.
 *
 * There is no canonical TRON Multicall contract — every TRC-20 read is its own
 * `triggerconstantcontract`, so built-in balances are read with bounded concurrency (4) and
 * metadata reads are capped per refresh like Solana's mint inspection. The TronGrid
 * `/v1/accounts/account` indexer is the only discovery source, and it is display-only.
 *
 * Node int64 fields can exceed 2^53 — `parseTronJson` carries them as `bigint`, so amounts stay
 * exact end to end and convert straight through `BigInt`.
 */
import { isTronAddress, tronAddressFromHex, tronAddressToHex } from "@qntx/wallet-chains/tron";

import { account, constantCall, resources, reward, tronLogAddress } from "../chains/tron.ts";
import type { TronApi, TronResources } from "../chains/tron.ts";
import { parseWith, tronAssetIssueResponse } from "../gateway/contract/index.ts";
import type { TronAccount } from "../gateway/contract/index.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const utf8 = new TextDecoder();

/** `constant_result[0]` is a 32-byte ABI word — its uint value. */
const word = (result: Uint8Array | undefined): bigint | undefined =>
  result !== undefined && result.length >= 32
    ? BigInt(
        `0x${[...result.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      )
    : undefined;

const BALANCE_OF = "70a08231";
const DECIMALS = "313ce567";
const SYMBOL = "95d89b41";
const NAME = "06fdde03";

const callData = (selector: string, address?: string): Uint8Array => {
  const tail = address === undefined ? "" : tronAddressToHex(address).slice(2).padStart(64, "0");
  return new Uint8Array(
    `${selector}${tail}`.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? [],
  );
};

const call = async (api: TronApi, owner: string, contract: string, data: Uint8Array) => {
  const outcome = await constantCall(api, { owner, contract, data });
  return outcome.ok ? outcome.result : undefined;
};

/**
 * `balanceOf(owner)` on a TRC-20 contract. A failed call throws — like an eth_call error on the EVM
 * path — so a misbehaving node or contract never displays as a zero balance.
 */
export const tronBalanceOf = async (
  api: TronApi,
  owner: string,
  contract: string,
): Promise<bigint> => {
  const outcome = await constantCall(api, {
    owner,
    contract,
    data: callData(BALANCE_OF, owner),
  });
  const value = outcome.ok ? word(outcome.result) : undefined;
  if (value === undefined) {
    throw new TypeError(`balanceOf on ${contract} failed`);
  }
  return value;
};

const textOf = (r: Uint8Array | undefined): string | undefined =>
  r === undefined ? undefined : decodeText(r);

/** A `string`/`bytes32` return — ABI-encoded `string` or a right-padded bytes32. */
const decodeText = (result: Uint8Array): string | undefined => {
  if (result.length === 32) {
    const end = result.indexOf(0);
    const text = utf8.decode(result.subarray(0, end === -1 ? 32 : end));
    return text === "" ? undefined : text;
  }
  if (result.length >= 64) {
    const length = Number(word(result.subarray(32)));
    const text = utf8.decode(result.subarray(64, 64 + length));
    return text === "" ? undefined : text;
  }
  return undefined;
};

export type TronTokenMeta = {
  readonly symbol: string | undefined;
  readonly name: string | undefined;
  readonly decimals: number;
};

/**
 * `decimals()`/`symbol()`/`name()` on a TRC-20 — `undefined` when decimals cannot be read (the
 * engine never assumes a precision, so the token is omitted, like an unreadable ERC-20).
 */
export const tronTokenMeta = async (
  api: TronApi,
  owner: string,
  contract: string,
): Promise<TronTokenMeta | undefined> => {
  const decimals = word(await call(api, owner, contract, callData(DECIMALS)));
  if (decimals === undefined || decimals > 255n) {
    return undefined;
  }
  const [symbol, name] = await Promise.all([
    call(api, owner, contract, callData(SYMBOL)).then(textOf),
    call(api, owner, contract, callData(NAME)).then(textOf),
  ]);
  return { symbol, name, decimals: Number(decimals) };
};

/**
 * The indexer's `/v1/accounts/account` answer → TRC-20 contract → raw balance. `data[0].trc20` rows
 * look like `[{"<contract>": "<balance>"}]`; junk is ignored — this is display-only.
 */
export const tronDiscoveredTokens = async (
  api: TronApi,
  address: string,
): Promise<Map<string, bigint>> => {
  const body: unknown = await api.post("/v1/accounts/account", { address });
  const found = new Map<string, bigint>();
  const data = isObject(body) ? body["data"] : undefined;
  const first: unknown = Array.isArray(data) ? data[0] : undefined;
  const trc20 = isObject(first) ? first["trc20"] : undefined;
  for (const row of Array.isArray(trc20) ? trc20 : []) {
    if (!isObject(row)) {
      continue;
    }
    for (const [contract, balance] of Object.entries(row)) {
      if (!isTronAddress(contract) || typeof balance !== "string" || !/^\d+$/.test(balance)) {
        continue;
      }
      const amount = BigInt(balance);
      if (amount > 0n) {
        found.set(contract, amount);
      }
    }
  }
  return found;
};

/** Non-zero `assetV2` rows: `{address: <decimal id>, balance}` in the TokenBalance shape. */
export const trc10Balances = (
  row: TronAccount,
): ReadonlyArray<{ readonly id: string; readonly balance: bigint }> =>
  (row.assetV2 ?? [])
    .filter((a) => /^\d+$/.test(a.key) && a.value > 0)
    .map((a) => ({ id: a.key, balance: BigInt(a.value) }));

const hexText = (hex: string | undefined): string | undefined => {
  if (hex === undefined || !/^([0-9a-fA-F]{2})+$/.test(hex)) {
    return undefined;
  }
  const bytes = new Uint8Array(hex.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? []);
  const text = utf8.decode(bytes).replaceAll("\0", "").trim();
  return text === "" ? undefined : text;
};

/** TRC-10 metadata via `getassetissuebyid` — `name`/`abbr` are hex-encoded per the node. */
export const tronTrc10Meta = async (
  api: TronApi,
  id: string,
): Promise<TronTokenMeta | undefined> => {
  const path = "/wallet/getassetissuebyid";
  const body = parseWith(tronAssetIssueResponse, await api.post(path, { value: Number(id) }));
  if (body === undefined) {
    return undefined;
  }
  return {
    symbol: hexText(body.abbr),
    name: hexText(body.name),
    decimals: body.precision ?? 0,
  };
};

/** A frozen/unfrozen `type` enum name or number; absent means BANDWIDTH (enum 0). */
const resource = (type: string | number | undefined): "bandwidth" | "energy" =>
  type === "ENERGY" || type === 1 ? "energy" : "bandwidth";

const sun = (n: number | bigint | undefined): string => BigInt(n ?? 0).toString(10);

/** The stake-resource view the account screen shows for a TRON account. */
export type TronAccountView = {
  /** TRX staked per resource, in sun. */
  readonly frozen: { readonly bandwidth: string; readonly energy: string };
  readonly unfreezing: ReadonlyArray<{
    readonly resource: "bandwidth" | "energy";
    readonly amount: string;
    readonly expiresAt: number;
  }>;
  /** This account's delegations out (delegated_frozenV2 fields) and in (acquired_*). */
  readonly delegatedOut: { readonly bandwidth: string; readonly energy: string };
  readonly delegatedIn: { readonly bandwidth: string; readonly energy: string };
  readonly votes: ReadonlyArray<{ readonly witness: string; readonly count: string }>;
  /** Withdrawable voting reward, in sun. */
  readonly reward: string;
  readonly bandwidth: {
    readonly free: { readonly limit: string; readonly used: string };
    readonly staked: { readonly limit: string; readonly used: string };
  };
  readonly energy: { readonly limit: string; readonly used: string };
  readonly tronPower: { readonly limit: string; readonly used: string };
};

/** `vote_address` is a `41…` hex or `T…` string — normalized to base58 for display. */
const witnessAddress = (raw: string | undefined): string | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  if (/^41[0-9a-fA-F]{40}$/.test(raw)) {
    return tronAddressFromHex(raw);
  }
  return isTronAddress(raw) ? raw : tronLogAddress(raw);
};

export const tronAccountView = (
  row: TronAccount,
  res: TronResources,
  rewardSun: bigint,
): TronAccountView => {
  const frozen = { bandwidth: 0n, energy: 0n };
  for (const f of row.frozenV2 ?? []) {
    frozen[resource(f.type)] += BigInt(f.amount ?? 0);
  }
  const unfreezing = (row.unfrozenV2 ?? [])
    .filter((u) => u.unfreeze_expire_time !== undefined)
    .map((u) => ({
      resource: resource(u.type),
      amount: sun(u.unfreeze_amount),
      expiresAt: Math.trunc(u.unfreeze_expire_time ?? 0),
    }));
  const votes = (row.votes ?? [])
    .map((v) => ({ witness: witnessAddress(v.vote_address), count: v.vote_count }))
    .filter((v): v is { witness: string; count: number } => v.witness !== undefined)
    .map((v) => ({ witness: v.witness, count: Math.trunc(v.count).toString(10) }));
  return {
    frozen: { bandwidth: frozen.bandwidth.toString(10), energy: frozen.energy.toString(10) },
    unfreezing,
    delegatedOut: {
      bandwidth: sun(row.delegated_frozenV2_balance_for_bandwidth),
      energy: sun(row.account_resource?.delegated_frozenV2_balance_for_energy),
    },
    delegatedIn: {
      bandwidth: sun(row.acquired_delegated_frozenV2_balance_for_bandwidth),
      energy: sun(row.account_resource?.acquired_delegated_frozenV2_balance_for_energy),
    },
    votes,
    reward: rewardSun.toString(10),
    bandwidth: {
      free: { limit: res.freeNetLimit.toString(10), used: res.freeNetUsed.toString(10) },
      staked: { limit: res.netLimit.toString(10), used: res.netUsed.toString(10) },
    },
    energy: { limit: res.energyLimit.toString(10), used: res.energyUsed.toString(10) },
    tronPower: { limit: res.tronPowerLimit.toString(10), used: res.tronPowerUsed.toString(10) },
  };
};

/** Reads the whole resource view: account, account resource and reward for one address. */
export const tronResourcesView = async (
  api: TronApi,
  address: string,
): Promise<{ readonly account: TronAccount | undefined; readonly view: TronAccountView }> => {
  const row = await account(api, address);
  if (row === undefined) {
    return {
      account: undefined,
      view: tronAccountView(
        {},
        {
          freeNetLimit: 0,
          freeNetUsed: 0,
          netLimit: 0,
          netUsed: 0,
          energyLimit: 0,
          energyUsed: 0,
          tronPowerLimit: 0,
          tronPowerUsed: 0,
        },
        0n,
      ),
    };
  }
  const [res, rew] = await Promise.all([resources(api, address), reward(api, address)]);
  return { account: row, view: tronAccountView(row, res, rew) };
};

/** Bounded parallelism — at most `n` in-flight reads. */
export const mapPool = async <T, R>(
  items: ReadonlyArray<T>,
  n: number,
  run: (t: T) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
  const out: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the cursor bounds it: current < items.length
        const item = items[current] as T;
        // oxlint-disable-next-line eslint/no-await-in-loop -- the shared cursor serializes each worker's steps.
        out[current] = await run(item);
      }
    }),
  );
  return out;
};
