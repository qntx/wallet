/**
 * Solana chain reads. Token accounts, mints and stake authorities are enumerated on the primary at
 * slot S (`context.slot` of the account scan); the corroborator re-reads the same objects with
 * `minContextSlot: S`, so its answer is never older than the state it is asked to confirm. Token,
 * close and mint authorities are chain-enumerated (the view's `exhaustive` kinds); stake accounts
 * are found by the `stake:` seed scan plus local candidates — known-only.
 */
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { PROGRAM_IDS, solanaTokenTable } from "@qntx/wallet-chains/solana";

import type { NetworkController, SolanaRpc } from "../networks/controller.ts";
import { mapPool } from "../pool.ts";
import { stakePositions } from "../staking/index.ts";
import { parseStakeAccount } from "../transactions/solana.ts";
import { corroborate } from "./corroborate.ts";
import type { ReadResult } from "./corroborate.ts";
import type { ChainResult } from "./evm.ts";
import { assessRow } from "./risk.ts";
import type { GatheredCandidate } from "./sources.ts";
import { candidateKey } from "./sources.ts";
import type { ApprovalKind, ApprovalRow } from "./types.ts";

export type SolanaReadDeps = {
  readonly networks: Pick<NetworkController, "solanaRpc" | "independentSolanaRpc">;
  /** The engine's known Solana addresses — address book + paid recipients. */
  readonly known: () => ReadonlyArray<string>;
};

const PROBE_CONCURRENCY = 6;
const MULTI_BATCH = 100;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

type TokenAccount = {
  readonly mint: string;
  readonly state?: string;
  readonly balance: bigint;
  readonly decimals: number;
  readonly delegate?: string;
  readonly delegated?: bigint;
  readonly closeAuthority?: string;
  readonly program: "token" | "token-2022";
};

type AccountsSnapshot = {
  readonly slot: number;
  readonly accounts: ReadonlyMap<string, TokenAccount>;
};

const TOKEN_PROGRAMS: ReadonlyArray<{
  readonly programId: string;
  readonly key: "token" | "token-2022";
}> = [
  { programId: TOKEN_PROGRAM_ADDRESS, key: "token" },
  { programId: PROGRAM_IDS.token2022, key: "token-2022" },
];

const parseTokenAccount = (pubkey: unknown, account: unknown, program: "token" | "token-2022") => {
  const key = str(pubkey);
  const info = obj(obj(obj(obj(account)?.["data"])?.["parsed"])?.["info"]);
  const mint = str(info?.["mint"]);
  const tokenAmount = obj(info?.["tokenAmount"]);
  const amount = str(tokenAmount?.["amount"]);
  const decimals = tokenAmount?.["decimals"];
  const delegated = str(obj(info?.["delegatedAmount"])?.["amount"]);
  if (
    key === undefined ||
    info === undefined ||
    mint === undefined ||
    amount === undefined ||
    typeof decimals !== "number"
  ) {
    return undefined;
  }
  const delegate = str(info["delegate"]);
  const closeAuthority = str(info["closeAuthority"]);
  const state = str(info["state"]);
  return {
    key,
    account: {
      mint,
      ...(state === undefined ? {} : { state }),
      balance: BigInt(amount),
      decimals,
      ...(delegate === undefined ? {} : { delegate }),
      ...(delegated === undefined ? {} : { delegated: BigInt(delegated) }),
      ...(closeAuthority === undefined ? {} : { closeAuthority }),
      program,
    },
  };
};

/** Both token programs' accounts for `owner`; `minSlot` bounds how old the answer may be. */
const readTokenAccounts = async (
  rpc: SolanaRpc,
  owner: string,
  minSlot?: number,
): Promise<AccountsSnapshot> => {
  const config =
    minSlot === undefined
      ? { encoding: "jsonParsed", commitment: "confirmed" }
      : { encoding: "jsonParsed", commitment: "confirmed", minContextSlot: minSlot };
  let slot = 0;
  const accounts = new Map<string, TokenAccount>();
  await Promise.all(
    TOKEN_PROGRAMS.map(async ({ programId, key }) => {
      const response = await rpc.call("getTokenAccountsByOwner", [owner, { programId }, config]);
      const context = obj(obj(response)?.["context"]);
      const contextSlot = context?.["slot"];
      if (typeof contextSlot === "number" && contextSlot > slot) {
        slot = contextSlot;
      }
      for (const entry of arr(obj(response)?.["value"])) {
        const parsed = parseTokenAccount(obj(entry)?.["pubkey"], obj(entry)?.["account"], key);
        if (parsed !== undefined) {
          accounts.set(parsed.key, parsed.account);
        }
      }
    }),
  );
  if (slot === 0) {
    throw new Error("getTokenAccountsByOwner returned no context slot");
  }
  return { slot, accounts };
};

type MintAuthorities = {
  readonly freeze?: string;
  readonly permanentDelegate?: string;
};

/** Freeze and permanent-delegate authorities of mints — batch `getMultipleAccounts`. */
const readMints = async (
  rpc: SolanaRpc,
  mints: ReadonlyArray<string>,
  minSlot: number,
): Promise<ReadonlyMap<string, MintAuthorities | undefined>> => {
  const out = new Map<string, MintAuthorities | undefined>();
  for (let from = 0; from < mints.length; from += MULTI_BATCH) {
    const chunk = mints.slice(from, from + MULTI_BATCH);
    // oxlint-disable-next-line eslint/no-await-in-loop -- batches are sequential by design
    const response = await rpc.call("getMultipleAccounts", [
      chunk,
      { encoding: "jsonParsed", commitment: "confirmed", minContextSlot: minSlot },
    ]);
    const values = arr(obj(response)?.["value"]);
    for (const [i, mint] of chunk.entries()) {
      const parsed = obj(obj(values[i])?.["data"])?.["parsed"];
      const info = obj(obj(parsed)?.["info"]);
      if (info === undefined) {
        out.set(mint, undefined);
        continue;
      }
      let permanentDelegate: string | undefined;
      for (const entry of arr(info["extensions"])) {
        if (obj(entry)?.["extension"] === "permanentDelegate") {
          permanentDelegate = str(obj(obj(entry)?.["state"])?.["delegate"]) ?? permanentDelegate;
        }
      }
      const freeze = str(info["freezeAuthority"]);
      out.set(mint, {
        ...(freeze === undefined ? {} : { freeze }),
        ...(permanentDelegate === undefined ? {} : { permanentDelegate }),
      });
    }
  }
  return out;
};

/** Stake authorities of the given accounts at `minSlot` or later; missing parse → undefined. */
const readStakeAccounts = async (
  rpc: SolanaRpc,
  accounts: ReadonlyArray<string>,
  minSlot: number,
): Promise<
  ReadonlyMap<string, { readonly staker?: string; readonly withdrawer?: string } | undefined>
> => {
  const out = new Map<
    string,
    { readonly staker?: string; readonly withdrawer?: string } | undefined
  >();
  for (let from = 0; from < accounts.length; from += MULTI_BATCH) {
    const chunk = accounts.slice(from, from + MULTI_BATCH);
    // oxlint-disable-next-line eslint/no-await-in-loop -- batches are sequential by design
    const response = await rpc.call("getMultipleAccounts", [
      chunk,
      { encoding: "jsonParsed", commitment: "confirmed", minContextSlot: minSlot },
    ]);
    const values = arr(obj(response)?.["value"]);
    for (const [i, key] of chunk.entries()) {
      const parsed = parseStakeAccount(values[i]);
      out.set(
        key,
        parsed === undefined
          ? undefined
          : {
              ...(parsed.staker === undefined ? {} : { staker: parsed.staker }),
              ...(parsed.withdrawer === undefined ? {} : { withdrawer: parsed.withdrawer }),
            },
      );
    }
  }
  return out;
};

const sorted = (rows: ReadonlyArray<ApprovalRow>): ApprovalRow[] =>
  [...rows].sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1));

/**
 * The Solana half of the view. `candidates` carries only `stake` keys — every other row comes from
 * enumeration, so no gateway input ever reaches it.
 */
export const solanaApprovals = async (
  deps: SolanaReadDeps,
  network: string,
  owner: string,
  candidates: ReadonlyArray<GatheredCandidate>,
): Promise<ChainResult> => {
  const primary = deps.networks.solanaRpc(network);
  const independent = deps.networks.independentSolanaRpc(network);

  const primarySnapshot = await readTokenAccounts(primary, owner);
  const { slot } = primarySnapshot;
  const at = { height: String(slot) };

  let secondaryAccounts: AccountsSnapshot | undefined;
  let independentFailed = independent.kind === "unavailable";
  if (independent.kind === "available") {
    try {
      secondaryAccounts = await readTokenAccounts(independent.client, owner, slot);
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

  /* Token accounts: delegate and close-authority rows, one corroborated verdict each. The
     corroborate calls inspect already-fetched snapshots, so every account resolves in parallel. */
  const accountVerdicts = await Promise.all(
    [...primarySnapshot.accounts].map(async ([pubkey, account]) => {
      const delegateSlice = (
        snapshot: AccountsSnapshot | undefined,
      ): ReadResult<{ delegate: string; delegated: bigint; balance: bigint }> => {
        const entry = snapshot?.accounts.get(pubkey);
        return entry?.delegate === undefined || (entry.delegated ?? 0n) === 0n
          ? { kind: "inactive" }
          : {
              kind: "active",
              value: {
                delegate: entry.delegate,
                delegated: entry.delegated ?? 0n,
                balance: entry.balance,
              },
            };
      };
      const closeSlice = (snapshot: AccountsSnapshot | undefined): ReadResult<string> => {
        const entry = snapshot?.accounts.get(pubkey);
        return entry?.closeAuthority === undefined || entry.closeAuthority === owner
          ? { kind: "inactive" }
          : { kind: "active", value: entry.closeAuthority };
      };
      const delegateVerdict =
        account.delegate !== undefined && (account.delegated ?? 0n) !== 0n
          ? await corroborate(
              independentOption,
              () => delegateSlice(primarySnapshot),
              () => delegateSlice(secondaryAccounts),
              (a, b) =>
                a.delegate === b.delegate
                  ? {
                      delegate: a.delegate,
                      delegated: a.delegated < b.delegated ? a.delegated : b.delegated,
                      balance: a.balance < b.balance ? a.balance : b.balance,
                    }
                  : undefined,
            )
          : undefined;
      const closeVerdict =
        account.closeAuthority !== undefined && account.closeAuthority !== owner
          ? await corroborate(
              independentOption,
              () => closeSlice(primarySnapshot),
              () => closeSlice(secondaryAccounts),
              (a, b) => (a === b ? a : undefined),
            )
          : undefined;
      return { pubkey, account, delegateVerdict, closeVerdict };
    }),
  );
  for (const { pubkey, account, delegateVerdict, closeVerdict } of accountVerdicts) {
    if (delegateVerdict !== undefined) {
      if (delegateVerdict.kind === "shown") {
        if (!delegateVerdict.verified) {
          unverified += 1;
        }
        const token = solanaTokenTable[network]?.[account.mint];
        rows.push({
          id: `spl-delegate:${pubkey}`,
          network,
          risk: assessRow({
            family: "solana",
            grantee: delegateVerdict.value.delegate,
            known: deps.known(),
          }),
          verified: delegateVerdict.verified,
          sources: ["chain"],
          revoke: "batchable",
          kind: "spl-delegate",
          tokenAccount: pubkey,
          token: {
            address: account.mint,
            ...(token ?? { decimals: account.decimals }),
          },
          delegate: delegateVerdict.value.delegate,
          amount: delegateVerdict.value.delegated.toString(10),
          exposure: (delegateVerdict.value.delegated < delegateVerdict.value.balance
            ? delegateVerdict.value.delegated
            : delegateVerdict.value.balance
          ).toString(10),
          program: account.program,
        });
      } else if (delegateVerdict.kind === "disputed") {
        disputed += 1;
      } else if (delegateVerdict.kind === "unread") {
        unread += 1;
      }
    }

    if (closeVerdict !== undefined) {
      if (closeVerdict.kind === "shown") {
        if (!closeVerdict.verified) {
          unverified += 1;
        }
        rows.push({
          id: `spl-close-authority:${pubkey}`,
          network,
          risk: assessRow({
            family: "solana",
            grantee: closeVerdict.value,
            known: deps.known(),
          }),
          verified: closeVerdict.verified,
          sources: ["chain"],
          revoke: "none",
          kind: "spl-close-authority",
          tokenAccount: pubkey,
          mint: account.mint,
          authority: closeVerdict.value,
        });
      } else if (closeVerdict.kind === "disputed") {
        disputed += 1;
      } else if (closeVerdict.kind === "unread") {
        unread += 1;
      }
    }
  }

  /* Mint authorities: freeze and Token-2022 permanent delegate, over funded mints only. */
  const mints = [
    ...new Set(
      [...primarySnapshot.accounts.values()].filter((a) => a.balance > 0n).map((a) => a.mint),
    ),
  ];
  const primaryMints = await readMints(primary, mints, slot);
  let secondaryMints: ReadonlyMap<string, MintAuthorities | undefined> | undefined;
  if (independent.kind === "available" && !independentFailed) {
    try {
      secondaryMints = await readMints(independent.client, mints, slot);
    } catch {
      independentFailed = true;
    }
  }
  const mintOption =
    independentFailed || secondaryMints === undefined
      ? { kind: "unavailable" as const }
      : independent;
  const mintJobs: Array<{
    readonly mint: string;
    readonly role: "freeze" | "permanent-delegate";
    readonly authority: string;
  }> = [];
  for (const [mint, authorities] of primaryMints) {
    for (const { role, authority } of [
      { role: "freeze" as const, authority: authorities?.freeze },
      { role: "permanent-delegate" as const, authority: authorities?.permanentDelegate },
    ]) {
      if (authority !== undefined && authority !== owner) {
        mintJobs.push({ mint, role, authority });
      }
    }
  }
  const mintVerdicts = await Promise.all(
    mintJobs.map(async ({ mint, role }) => {
      const slice = (
        map: ReadonlyMap<string, MintAuthorities | undefined> | undefined,
      ): ReadResult<string> => {
        const value = map?.get(mint);
        const found = role === "freeze" ? value?.freeze : value?.permanentDelegate;
        return found === undefined || found === owner
          ? { kind: "inactive" }
          : { kind: "active", value: found };
      };
      const verdict = await corroborate(
        mintOption,
        () => slice(primaryMints),
        () => slice(secondaryMints),
        (a, b) => (a === b ? a : undefined),
      );
      return { mint, role, verdict };
    }),
  );
  for (const { mint, role, verdict } of mintVerdicts) {
    if (verdict.kind === "shown") {
      if (!verdict.verified) {
        unverified += 1;
      }
      rows.push({
        id: `spl-mint-authority:${role}:${mint}`,
        network,
        risk: assessRow({
          family: "solana",
          grantee: verdict.value,
          known: deps.known(),
        }),
        verified: verdict.verified,
        sources: ["chain"],
        revoke: "none",
        kind: "spl-mint-authority",
        mint,
        role,
        authority: verdict.value,
      });
    } else if (verdict.kind === "disputed") {
      disputed += 1;
    } else if (verdict.kind === "unread") {
      unread += 1;
    }
  }

  /* Stake: seed-scan discovery, then slot reads on both endpoints. Known-only — not exhaustive. */
  const stakeKeys = new Set<string>();
  try {
    for (const position of await stakePositions(primary, owner)) {
      stakeKeys.add(position.address);
    }
  } catch {
    // The seed scan is discovery: its failure only loses candidates, never invents rows.
  }
  for (const { candidate } of candidates) {
    if (candidate.kind === "stake") {
      stakeKeys.add(candidate.account);
    }
  }
  const stakeAccounts = [...stakeKeys];
  const primaryStake = await readStakeAccounts(primary, stakeAccounts, slot);
  let secondaryStake: typeof primaryStake | undefined;
  if (independent.kind === "available" && !independentFailed) {
    try {
      secondaryStake = await readStakeAccounts(independent.client, stakeAccounts, slot);
    } catch {
      independentFailed = true;
    }
  }
  const stakeOption =
    independentFailed || secondaryStake === undefined
      ? { kind: "unavailable" as const }
      : independent;
  const stakeResults = await mapPool(stakeAccounts, PROBE_CONCURRENCY, async (account) => {
    const slice =
      (role: "staker" | "withdrawer") =>
      (
        map: ReadonlyMap<
          string,
          { readonly staker?: string; readonly withdrawer?: string } | undefined
        >,
      ): ReadResult<string> => {
        const entry = map.get(account);
        const authority = role === "staker" ? entry?.staker : entry?.withdrawer;
        return authority === undefined || authority === owner
          ? { kind: "inactive" }
          : { kind: "active", value: authority };
      };
    return Promise.all(
      (["staker", "withdrawer"] as const).map(async (role) => ({
        account,
        role,
        verdict: await corroborate(
          stakeOption,
          () => slice(role)(primaryStake),
          () => slice(role)(secondaryStake ?? new Map()),
          (a, b) => (a === b ? a : undefined),
        ),
      })),
    );
  });
  for (const list of stakeResults) {
    for (const { account, role, verdict } of list) {
      const candidate = candidates.find(
        (c) => c.candidate.kind === "stake" && c.candidate.account === account,
      );
      const sources: ReadonlyArray<"gateway" | "local" | "chain"> =
        candidate === undefined ? ["chain"] : [...candidate.sources].sort();
      const key = candidate === undefined ? undefined : candidateKey(candidate.candidate);
      if (verdict.kind === "dropped") {
        dropped += 1;
        continue;
      }
      if (key !== undefined) {
        keep.push(key);
      }
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
      rows.push({
        id: `stake-authority:${role}:${account}`,
        network,
        risk: assessRow({
          family: "solana",
          grantee: verdict.value,
          known: deps.known(),
        }),
        verified: verdict.verified,
        sources,
        revoke: "none",
        kind: "stake-authority",
        stakeAccount: account,
        role,
        authority: verdict.value,
      });
    }
  }

  const exhaustive: ApprovalKind[] = ["spl-delegate", "spl-close-authority", "spl-mint-authority"];

  return {
    rows: sorted(rows),
    at,
    exhaustive,
    dropped,
    disputed,
    unread,
    unverified,
    keep,
  };
};
