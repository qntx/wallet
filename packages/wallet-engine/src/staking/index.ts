/** Solana staking reads — display-only; nothing here influences a signed transaction. */
import { address, createAddressWithSeed } from "@solana/kit";

import { PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import type { SolanaRpc } from "../networks/controller.ts";
import { parseStakeAccount, STAKE_SEED_PREFIX } from "../transactions/solana.ts";

export type StakePosition = {
  readonly address: string;
  readonly seed: string;
  readonly lamports: bigint;
  /**
   * Display approximation of the activation state — warmup and cooldown are rate-limited, so an
   * "active" account can still be partially activating and a "deactivating" one partly liquid.
   */
  readonly state: "initialized" | "activating" | "active" | "deactivating" | "inactive";
  readonly validator?: string;
  readonly activationEpoch?: bigint;
  readonly deactivationEpoch?: bigint;
};

export type StakeValidator = {
  readonly vote: string;
  readonly node: string;
  readonly commission: number;
  readonly activatedStake: bigint;
};

const POSITION_SCAN_BATCH = 10;
const POSITION_SCAN_GAP = 5;
const U64_MAX = 18446744073709551615n;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : fallback;
const big = (v: unknown): bigint =>
  typeof v === "bigint" ? v : typeof v === "number" || typeof v === "string" ? BigInt(v) : 0n;

const epochOf = async (rpc: SolanaRpc): Promise<bigint> =>
  BigInt(num(obj(await rpc.call("getEpochInfo", [{ commitment: "confirmed" }]))?.["epoch"]));

/**
 * The account's stake accounts: `stake:<n>` seeds derived under the Stake program, scanned in
 * batches and stopped after five consecutive missing ones. Activation state is derived from the
 * parsed delegation and the current epoch (Agave 3.x dropped `getStakeActivation`).
 */
export const stakePositions = async (
  rpc: SolanaRpc,
  owner: string,
): Promise<ReadonlyArray<StakePosition>> => {
  const epoch = await epochOf(rpc);
  const positions: StakePosition[] = [];
  let missing = 0;
  for (let start = 0; missing < POSITION_SCAN_GAP; start += POSITION_SCAN_BATCH) {
    const seeds = Array.from(
      { length: POSITION_SCAN_BATCH },
      (_, i) => STAKE_SEED_PREFIX + (start + i),
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- each seed batch gates whether the next is fetched
    const derived = await Promise.all(
      seeds.map(async (seed) =>
        createAddressWithSeed({
          baseAddress: address(owner),
          programAddress: address(PROGRAM_IDS.stake),
          seed,
        }),
      ),
    );
    const result = obj(
      // oxlint-disable-next-line eslint/no-await-in-loop -- batch reads are sequential by design
      await rpc.call("getMultipleAccounts", [
        derived.map(String),
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]),
    );
    const list = arr(result?.["value"]) ?? [];
    for (const [i, stakeAddress] of derived.entries()) {
      const value = list[i];
      const parsed = value === null || value === undefined ? undefined : parseStakeAccount(value);
      if (parsed === undefined) {
        missing += 1;
        if (missing >= POSITION_SCAN_GAP) {
          break;
        }
        continue;
      }
      missing = 0;
      const { delegation } = parsed;
      const seed = seeds[i] ?? "";
      const base = {
        address: String(stakeAddress),
        seed,
        lamports: big(obj(value)?.["lamports"]),
      };
      if (delegation === undefined) {
        positions.push({ ...base, state: "initialized" });
        continue;
      }
      const { activationEpoch, deactivationEpoch, voter } = delegation;
      const state =
        deactivationEpoch === U64_MAX
          ? activationEpoch >= epoch
            ? "activating"
            : "active"
          : deactivationEpoch < epoch
            ? "inactive"
            : "deactivating";
      positions.push({
        ...base,
        state,
        validator: voter,
        activationEpoch,
        deactivationEpoch,
      });
    }
  }
  return positions;
};

/** Current (not delinquent) vote accounts, most activated stake first. Display only. */
export const stakeValidators = async (rpc: SolanaRpc): Promise<ReadonlyArray<StakeValidator>> => {
  const result = obj(await rpc.call("getVoteAccounts", [{ commitment: "confirmed" }]));
  return (arr(result?.["current"]) ?? [])
    .flatMap((v) => {
      const entry = obj(v);
      const vote = entry?.["votePubkey"];
      const node = entry?.["nodePubkey"];
      if (entry === undefined || typeof vote !== "string" || typeof node !== "string") {
        return [];
      }
      return [
        {
          vote,
          node,
          commission: num(entry["commission"]),
          activatedStake: BigInt(num(entry["activatedStake"])),
        },
      ];
    })
    .sort((a, b) =>
      b.activatedStake > a.activatedStake ? 1 : b.activatedStake < a.activatedStake ? -1 : 0,
    );
};
