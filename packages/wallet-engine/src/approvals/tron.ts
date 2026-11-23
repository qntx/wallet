/**
 * TRON chain reads. TRC-20 allowances answer through `triggerconstantcontract` and account
 * permissions through `/wallet/getaccount` — both at-or-after the head `headNumber` reported first
 * (TRON's node API takes no height; a node behind the stated head simply answers stale, which the
 * corroborating endpoint then disputes, never invents). Permissions are chain-enumerated (the
 * view's `exhaustive` kind); TRC-20 rows come from candidates only.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { MAX_UINT256 } from "@qntx/wallet-chains/evm";
import { isTronAddress, tronAddressFromHex, tronAddressToEvm } from "@qntx/wallet-chains/tron";

import { account, constantCall, headNumber, tronLogAddress } from "../chains/tron.ts";
import type { TronApi } from "../chains/tron.ts";
import type { TronAccount } from "../gateway/contract/index.ts";
import type { NetworkController } from "../networks/controller.ts";
import { mapPool } from "../pool.ts";
import { corroborate } from "./corroborate.ts";
import type { ReadResult } from "./corroborate.ts";
import type { ChainResult } from "./evm.ts";
import { assessRow } from "./risk.ts";
import type { GatheredCandidate } from "./sources.ts";
import { candidateKey } from "./sources.ts";
import type { ApprovalRisk, ApprovalRow, TokenRef } from "./types.ts";

export type TronReadDeps = {
  readonly networks: Pick<NetworkController, "tronApi" | "independentTronApi">;
  /** Token display metadata — built-in table, then the host's read; `{}` on failure. */
  readonly token: (address: string) => Promise<Pick<TokenRef, "symbol" | "decimals">>;
  /** The engine's known TRON addresses — address book + paid recipients. */
  readonly known: () => ReadonlyArray<string>;
};

const PROBE_CONCURRENCY = 6;
const ALLOWANCE_OF = "dd62ed3e";
const BALANCE_OF = "70a08231";

/** An address in the base58 `T…` form rows display; `undefined` when it cannot normalize. */
const normalizeAddress = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (isTronAddress(value)) {
    return value;
  }
  if (/^[0-9a-fA-F]{42}$/.test(value)) {
    try {
      return tronAddressFromHex(value);
    } catch {
      return undefined;
    }
  }
  return tronLogAddress(value);
};

const pad32 = (address: string): string => tronAddressToEvm(address).slice(2).padStart(64, "0");

const word = (result: Uint8Array): bigint =>
  result.length === 0 ? 0n : BigInt(`0x${bytesToHex(result)}`);

const callWord = async (api: TronApi, owner: string, contract: string, data: string) => {
  const outcome = await constantCall(api, {
    owner,
    contract,
    data: hexToBytes(data),
  });
  if (!outcome.ok) {
    throw new Error(`constant call refused: ${outcome.message ?? "reverted"}`);
  }
  return word(outcome.result);
};

type Trc20Read = { readonly allowance: bigint; readonly balance: bigint };

const readTrc20 = async (
  api: TronApi,
  owner: string,
  token: string,
  spender: string,
): Promise<ReadResult<Trc20Read>> => {
  const [allowance, balance] = await Promise.all([
    callWord(api, owner, token, `${ALLOWANCE_OF}${pad32(owner)}${pad32(spender)}`),
    callWord(api, owner, token, `${BALANCE_OF}${pad32(owner)}`),
  ]);
  return allowance === 0n
    ? { kind: "inactive" }
    : { kind: "active", value: { allowance, balance } };
};

type PermissionValue = {
  readonly name: string;
  readonly threshold: string;
  readonly keys: ReadonlyArray<{ readonly address: string; readonly weight: string }>;
};

type PermissionSlot = {
  readonly permission: "owner" | "active" | "witness";
  readonly index: number;
};

/** The account's permission slots — owner, each active entry, witness. */
const permissionSlots = (account: TronAccount | undefined) => {
  const slots: Array<{
    readonly slot: PermissionSlot;
    readonly permission: NonNullable<TronAccount["owner_permission"]>;
  }> = [];
  if (account?.owner_permission !== undefined) {
    slots.push({
      slot: { permission: "owner", index: 0 },
      permission: account.owner_permission,
    });
  }
  for (const [index, permission] of (account?.active_permission ?? []).entries()) {
    slots.push({ slot: { permission: "active", index }, permission });
  }
  if (account?.witness_permission !== undefined) {
    slots.push({
      slot: { permission: "witness", index: 0 },
      permission: account.witness_permission,
    });
  }
  return slots;
};

const sameKeys = (a: PermissionValue["keys"], b: PermissionValue["keys"]): boolean =>
  a.length === b.length &&
  a.every((key, i) => key.address === b[i]?.address && key.weight === b[i]?.weight);

const sorted = (rows: ReadonlyArray<ApprovalRow>): ApprovalRow[] =>
  [...rows].sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1));

/**
 * The TRON half of the view. `candidates` carries only `trc20` keys; permission rows are enumerated
 * from the account read, never from a discovery source.
 */
export const tronApprovals = async (
  deps: TronReadDeps,
  network: string,
  owner: string,
  candidates: ReadonlyArray<GatheredCandidate>,
): Promise<ChainResult> => {
  const primary = deps.networks.tronApi(network);
  const independent = deps.networks.independentTronApi(network);
  const head = await headNumber(primary);
  const at = { height: String(head) };

  const primaryAccount = await account(primary, owner);
  let secondaryAccount: TronAccount | undefined;
  let independentFailed = independent.kind === "unavailable";
  if (independent.kind === "available") {
    try {
      secondaryAccount = await account(independent.client, owner);
    } catch {
      independentFailed = true;
    }
  }
  const independentOption = independentFailed ? { kind: "unavailable" as const } : independent;

  const rows: ApprovalRow[] = [];
  const keep: string[] = [];
  let dropped = 0;
  let disputed = 0;
  let unread = 0;
  let unverified = 0;

  /* Permissions: a foreign key in any permission is a grant on the whole account. The
     corroborate calls compare already-fetched account reads, so slots resolve in parallel. */
  const permissionVerdicts = await Promise.all(
    permissionSlots(primaryAccount).map(async ({ slot, permission }) => {
      const keys = (permission.keys ?? [])
        .map((key) => ({
          address: normalizeAddress(key.address),
          weight: (key.weight ?? 0n).toString(10),
        }))
        .filter((key): key is { address: string; weight: string } => key.address !== undefined);
      if (!keys.some((key) => key.address !== owner)) {
        return { slot, verdict: undefined };
      }
      const slice = (acct: TronAccount | undefined): ReadResult<PermissionValue> => {
        const found = permissionSlots(acct).find(
          (entry) =>
            entry.slot.permission === slot.permission &&
            (slot.permission !== "active" ||
              entry.permission.permission_name === permission.permission_name),
        );
        if (found === undefined) {
          return { kind: "inactive" };
        }
        const foundKeys = (found.permission.keys ?? [])
          .map((key) => ({
            address: normalizeAddress(key.address),
            weight: (key.weight ?? 0n).toString(10),
          }))
          .filter((key): key is { address: string; weight: string } => key.address !== undefined);
        return foundKeys.some((key) => key.address !== owner)
          ? {
              kind: "active",
              value: {
                name:
                  found.permission.permission_name ??
                  (slot.permission === "owner"
                    ? "owner"
                    : slot.permission === "witness"
                      ? "witness"
                      : `active ${slot.index}`),
                threshold: (found.permission.threshold ?? 0n).toString(10),
                keys: foundKeys,
              },
            }
          : { kind: "inactive" };
      };
      const verdict = await corroborate(
        independentOption,
        () => slice(primaryAccount),
        () => slice(secondaryAccount),
        (a, b) =>
          a.threshold === b.threshold && a.name === b.name && sameKeys(a.keys, b.keys)
            ? a
            : undefined,
      );
      return { slot, verdict };
    }),
  );
  for (const { slot, verdict } of permissionVerdicts) {
    if (verdict === undefined) {
      continue;
    }
    if (verdict.kind === "shown") {
      if (!verdict.verified) {
        unverified += 1;
      }
      const risk: ApprovalRisk[] = [];
      for (const key of verdict.value.keys) {
        if (key.address !== owner) {
          for (const flag of assessRow({
            family: "tron",
            grantee: key.address,
            known: deps.known(),
          })) {
            if (!risk.includes(flag)) {
              risk.push(flag);
            }
          }
        }
      }
      rows.push({
        id: `tron-permission:${slot.permission}:${slot.index}:${verdict.value.name}`,
        network,
        risk,
        verified: verdict.verified,
        sources: ["chain"],
        revoke: "none",
        kind: "tron-permission",
        permission: slot.permission,
        name: verdict.value.name,
        threshold: verdict.value.threshold,
        keys: verdict.value.keys,
      });
    } else if (verdict.kind === "disputed") {
      disputed += 1;
    } else if (verdict.kind === "unread") {
      unread += 1;
    }
  }

  /* TRC-20 candidates through the corroborate rule — the constant calls settle it. */
  const trc20 = candidates.filter((gathered) => gathered.candidate.kind === "trc20");
  const results = await mapPool(trc20, PROBE_CONCURRENCY, async (gathered) => {
    if (gathered.candidate.kind !== "trc20") {
      return { gathered, verdict: { kind: "dropped" as const } } as const;
    }
    const { token, spender } = gathered.candidate;
    const verdict = await corroborate(
      independentOption,
      async () => readTrc20(primary, owner, token, spender),
      async (client) => readTrc20(client, owner, token, spender),
      (a, b) => ({
        allowance: a.allowance < b.allowance ? a.allowance : b.allowance,
        balance: a.balance < b.balance ? a.balance : b.balance,
      }),
    );
    return { gathered, verdict } as const;
  });

  const shownTokens = new Set<string>();
  const shownSpenders = new Set<string>();
  for (const { gathered, verdict } of results) {
    if (verdict.kind === "shown" && gathered.candidate.kind === "trc20") {
      shownTokens.add(gathered.candidate.token);
      shownSpenders.add(gathered.candidate.spender);
    }
  }
  /* Token metadata and spender probes run together; probes are primary-only display hints. */
  const [metadata, probes] = await Promise.all([
    mapPool([...shownTokens], PROBE_CONCURRENCY, async (address) => ({
      address,
      meta: await deps.token(address),
    })),
    mapPool([...shownSpenders], PROBE_CONCURRENCY, async (spender) => {
      let probe: "eoa" | "no-code" | "contract" | "unknown";
      try {
        const spenderAccount = await account(primary, spender);
        probe =
          spenderAccount === undefined
            ? "no-code"
            : spenderAccount.type === "Contract"
              ? "contract"
              : "eoa";
      } catch {
        probe = "unknown";
      }
      return { spender, probe };
    }),
  ]);
  const metaBy = new Map<string, Pick<TokenRef, "symbol" | "decimals">>(
    metadata.map((m) => [m.address, m.meta] as const),
  );
  const probeBy = new Map(probes.map((entry) => [entry.spender, entry.probe]));

  for (const { gathered, verdict } of results) {
    if (gathered.candidate.kind !== "trc20") {
      continue;
    }
    const { candidate } = gathered;
    if (verdict.kind === "dropped") {
      dropped += 1;
      continue;
    }
    keep.push(candidateKey(candidate));
    if (verdict.kind === "disputed") {
      disputed += 1;
      continue;
    }
    if (verdict.kind === "unread") {
      unread += 1;
      continue;
    }
    if (!verdict.verified) {
      unverified += 1;
    }
    const probe = probeBy.get(candidate.spender) ?? "unknown";
    const unlimited = verdict.value.allowance === MAX_UINT256;
    rows.push({
      id: `trc20:${candidate.token}:${candidate.spender}`,
      network,
      risk: [
        ...new Set([
          ...assessRow({
            family: "tron",
            grantee: candidate.spender,
            unlimited,
            known: deps.known(),
          }),
          ...assessRow({ family: "tron", spenderProbe: probe, known: deps.known() }),
        ]),
      ],
      verified: verdict.verified,
      sources: [...gathered.sources].sort(),
      revoke: "single",
      kind: "trc20",
      token: { address: candidate.token, ...metaBy.get(candidate.token) },
      spender: candidate.spender,
      amount: verdict.value.allowance.toString(10),
      unlimited,
      exposure: (verdict.value.allowance < verdict.value.balance
        ? verdict.value.allowance
        : verdict.value.balance
      ).toString(10),
    });
  }

  return {
    rows: sorted(rows),
    at,
    exhaustive: ["tron-permission"],
    dropped,
    disputed,
    unread,
    unverified,
    keep,
  };
};
