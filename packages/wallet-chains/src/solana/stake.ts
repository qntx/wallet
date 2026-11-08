import { sha256 } from "@noble/hashes/sha2.js";
import { address, getAddressEncoder } from "@solana/addresses";
import { getU32Decoder, getU64Decoder, getI64Decoder } from "@solana/codecs";

import { PROGRAM_IDS, solanaAddressFromPublicKey } from "./ids.ts";
import { resolveAccountIndex } from "./message.ts";
import type { ParsedSolanaMessage } from "./message.ts";

/** Sysvars the legacy stake account lists carry; post-SIMD-0490 forms omit them. */
export const SYSVAR_IDS: Readonly<{
  clock: string;
  rent: string;
  stakeHistory: string;
  stakeConfig: string;
}> = Object.freeze({
  clock: "SysvarC1ock11111111111111111111111111111111",
  rent: "SysvarRent111111111111111111111111111111111",
  stakeHistory: "SysvarStakeHistory1111111111111111111111111",
  stakeConfig: "StakeConfig11111111111111111111111111111111",
});

const ZERO_ADDRESS = "11111111111111111111111111111111";

const u32 = getU32Decoder();
const u64 = getU64Decoder();
const i64 = getI64Decoder();
const addr = getAddressEncoder();

const u32le = (data: Uint8Array, offset: number): number => u32.decode(data, offset);
const u64le = (data: Uint8Array, offset: number): bigint => u64.decode(data, offset);
const i64le = (data: Uint8Array, offset: number): bigint => i64.decode(data, offset);
const key = (data: Uint8Array, offset: number): string =>
  solanaAddressFromPublicKey(data.subarray(offset, offset + 32));

/** One recognized stake-program instruction (bincode data + both account-list forms). */
export type StakeIx =
  | {
      readonly kind: "initialize";
      readonly account: string;
      readonly staker: string;
      readonly withdrawer: string;
      readonly lockup: boolean;
    }
  | {
      readonly kind: "initialize-checked";
      readonly account: string;
      readonly staker: string;
      readonly withdrawer: string;
    }
  | { readonly kind: "delegate"; readonly account: string; readonly validator: string }
  | { readonly kind: "deactivate"; readonly account: string }
  | {
      readonly kind: "withdraw";
      readonly account: string;
      readonly to: string;
      readonly lamports: bigint;
    }
  | {
      readonly kind: "authorize";
      readonly account: string;
      readonly role: "staker" | "withdrawer";
      readonly authority: string;
    };

/** A system-program account creation whose owner is the Stake program. */
export type StakeCreate = {
  readonly kind: "create";
  readonly account: string;
  readonly from: string;
  readonly lamports: bigint;
};

const account = (
  parsed: ParsedSolanaMessage,
  ix: { readonly accountIndices: ReadonlyArray<number> },
  index: number,
  lookups: Parameters<typeof resolveAccountIndex>[2],
): string | undefined =>
  index < ix.accountIndices.length
    ? resolveAccountIndex(parsed, ix.accountIndices[index] ?? 0, lookups)
    : undefined;

const role = (data: Uint8Array, offset: number): "staker" | "withdrawer" | "other" => {
  const r = u32le(data, offset);
  return r === 0 ? "staker" : r === 1 ? "withdrawer" : "other";
};

/**
 * Decodes one Stake-program instruction — exact data length and an account list matching either the
 * current form or the legacy one (recognised by the sysvar it inserts at a fixed position).
 * Anything else is `undefined` → the whole transaction decodes `opaque`.
 */
export const decodeStakeIx = (
  parsed: ParsedSolanaMessage,
  ix: { readonly accountIndices: ReadonlyArray<number>; readonly data: Uint8Array },
  lookups: Parameters<typeof resolveAccountIndex>[2],
): StakeIx | undefined => {
  const { data } = ix;
  const acc = (i: number): string | undefined => account(parsed, ix, i, lookups);
  const n = ix.accountIndices.length;
  if (data.length < 4) {
    return undefined;
  }
  switch (u32le(data, 0)) {
    case 0: {
      /* Initialize: [stake] or [stake, Rent]; staker/withdrawer/lockup in the data. */
      if (data.length !== 116 || !(n === 1 || (n === 2 && acc(1) === SYSVAR_IDS.rent))) {
        return undefined;
      }
      const stake = acc(0);
      if (stake === undefined) {
        return undefined;
      }
      const lockup =
        i64le(data, 68) !== 0n || u64le(data, 76) !== 0n || key(data, 84) !== ZERO_ADDRESS;
      return {
        kind: "initialize",
        account: stake,
        staker: key(data, 4),
        withdrawer: key(data, 36),
        lockup,
      };
    }
    case 1: {
      /* Authorize: newAuthority in the data; [stake, auth, (cust)] or [stake, Clock, auth, (cust)]. */
      if (data.length !== 40) {
        return undefined;
      }
      const r = role(data, 36);
      const legacy = acc(1) === SYSVAR_IDS.clock;
      const stake = acc(0);
      const count = legacy ? n === 3 || n === 4 : n === 2 || n === 3;
      if (r === "other" || stake === undefined || !count) {
        return undefined;
      }
      return { kind: "authorize", account: stake, role: r, authority: key(data, 4) };
    }
    case 2: {
      /* DelegateStake: [stake, vote, staker] or [stake, vote, Clock, StakeHistory, StakeConfig, staker]. */
      const legacy = acc(2) === SYSVAR_IDS.clock;
      const stake = acc(0);
      const vote = acc(1);
      if (
        data.length !== 4 ||
        stake === undefined ||
        vote === undefined ||
        !(
          n === 3 ||
          (n === 6 &&
            legacy &&
            acc(3) === SYSVAR_IDS.stakeHistory &&
            acc(4) === SYSVAR_IDS.stakeConfig)
        )
      ) {
        return undefined;
      }
      return { kind: "delegate", account: stake, validator: vote };
    }
    case 4: {
      /* Withdraw: [stake, to, withdrawer, (cust)] or [stake, to, Clock, StakeHistory, withdrawer, (cust)]. */
      const legacy = acc(2) === SYSVAR_IDS.clock && acc(3) === SYSVAR_IDS.stakeHistory;
      const stake = acc(0);
      const to = acc(1);
      if (
        data.length !== 12 ||
        stake === undefined ||
        to === undefined ||
        !(n === 3 || n === 4 || ((n === 5 || n === 6) && legacy))
      ) {
        return undefined;
      }
      return { kind: "withdraw", account: stake, to, lamports: u64le(data, 4) };
    }
    case 5: {
      /* Deactivate: [stake, staker] or [stake, Clock, staker]. */
      const stake = acc(0);
      if (
        data.length !== 4 ||
        stake === undefined ||
        !(n === 2 || (n === 3 && acc(1) === SYSVAR_IDS.clock))
      ) {
        return undefined;
      }
      return { kind: "deactivate", account: stake };
    }
    case 9: {
      /* InitializeChecked: authorities are accounts — [stake, staker, withdrawer] or [stake, Rent, staker, withdrawer]. */
      const legacy = acc(1) === SYSVAR_IDS.rent;
      const stake = acc(0);
      const staker = acc(legacy ? 2 : 1);
      const withdrawer = acc(legacy ? 3 : 2);
      if (
        data.length !== 4 ||
        stake === undefined ||
        staker === undefined ||
        withdrawer === undefined ||
        !(n === 3 || (n === 4 && legacy))
      ) {
        return undefined;
      }
      return { kind: "initialize-checked", account: stake, staker, withdrawer };
    }
    case 10: {
      /* AuthorizeChecked: role in the data; [stake, auth, newAuth, (cust)] or [stake, Clock, auth, newAuth, (cust)]. */
      if (data.length !== 8) {
        return undefined;
      }
      const r = role(data, 4);
      const legacy = acc(1) === SYSVAR_IDS.clock;
      const stake = acc(0);
      const authority = acc(legacy ? 3 : 2);
      const count = legacy ? n === 4 || n === 5 : n === 3 || n === 4;
      if (r === "other" || stake === undefined || authority === undefined || !count) {
        return undefined;
      }
      return { kind: "authorize", account: stake, role: r, authority };
    }
    default:
      return undefined;
  }
};

/**
 * A system-program `CreateAccount` (u32 0) or `CreateAccountWithSeed` (u32 3) whose owner is the
 * Stake program — `undefined` for other owners or any layout deviation. A with-seed creation is
 * only recognised when `to` is the sha256(base ‖ seed ‖ owner) derived address.
 */
export const decodeStakeCreate = (
  parsed: ParsedSolanaMessage,
  ix: { readonly accountIndices: ReadonlyArray<number>; readonly data: Uint8Array },
  lookups: Parameters<typeof resolveAccountIndex>[2],
): StakeCreate | "other" | undefined => {
  const { data } = ix;
  const acc = (i: number): string | undefined => account(parsed, ix, i, lookups);
  if (data.length < 4) {
    return "other";
  }
  if (u32le(data, 0) === 0) {
    if (data.length !== 52 || ix.accountIndices.length !== 2) {
      return "other";
    }
    const from = acc(0);
    const to = acc(1);
    if (from === undefined || to === undefined) {
      return "other";
    }
    if (key(data, 20) !== PROGRAM_IDS.stake) {
      return "other";
    }
    return { kind: "create", account: to, from, lamports: u64le(data, 4) };
  }
  if (u32le(data, 0) === 3) {
    /* base(32) + seed(len u64 + bytes) + lamports(8) + space(8) + owner(32). */
    const seedLen = data.length >= 44 ? Number(u64le(data, 36)) : -1;
    const end = 92 + seedLen;
    if (seedLen < 0 || seedLen > 32 || data.length !== end) {
      return "other";
    }
    const from = acc(0);
    const to = acc(1);
    if (
      from === undefined ||
      to === undefined ||
      !(ix.accountIndices.length === 2 || ix.accountIndices.length === 3)
    ) {
      return "other";
    }
    const base = key(data, 4);
    const owner = key(data, end - 32);
    if (owner !== PROGRAM_IDS.stake) {
      return "other";
    }
    if (ix.accountIndices.length === 3 && acc(2) !== base) {
      return "other";
    }
    if (ix.accountIndices.length === 2 && base !== from) {
      return "other";
    }
    const seed = data.subarray(44, 44 + seedLen);
    const derived = solanaAddressFromPublicKey(
      sha256(
        new Uint8Array([
          ...addr.encode(address(base)),
          ...seed,
          ...addr.encode(address(PROGRAM_IDS.stake)),
        ]),
      ),
    );
    return to === derived
      ? { kind: "create", account: to, from, lamports: u64le(data, 44 + seedLen) }
      : "other";
  }
  return undefined;
};
