import { getU32Decoder, getU64Decoder } from "@solana/codecs";

import { associatedTokenAddress } from "./ata.ts";
import type { ParsedSolanaMessage } from "./message.ts";
import { resolveAccountIndex } from "./message.ts";

/** Raydium AMM v4 — raydium-io/raydium-amm program/src/lib.rs declare_id! */
export const RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
/** Raydium concentrated liquidity — raydium-io/raydium-clmm programs/amm/src/lib.rs declare_id! */
export const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
/** Raydium constant-product — raydium-io/raydium-cp-swap programs/cp-swap/src/lib.rs declare_id! */
export const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
/** Orca Whirlpool — orca-so/whirlpools programs/whirlpool/src/lib.rs declare_id! */
export const WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
/** Meteora DLMM — meteora-ag/dlmm-sdk, the lb_clmm program id in the IDL metadata. */
export const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

/** SPL Token — AMM v4 asserts its token program account equals this id (processor.rs check). */
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/* Anchor discriminators sha256("global:<name>")[0..8], computed locally. */
const SWAP_V2 = Uint8Array.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const SWAP_BASE_INPUT = Uint8Array.from([0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde]);
const DLMM_SWAP = Uint8Array.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]);
const DLMM_SWAP2 = Uint8Array.from([0x41, 0x4b, 0x3f, 0x4c, 0xeb, 0x5b, 0x5b, 0x88]);

const u32 = getU32Decoder();
const u64 = getU64Decoder();

const startsWith = (data: Uint8Array, prefix: Uint8Array): boolean =>
  data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

export type AmmSwap = {
  readonly program: string;
  readonly protocol:
    | "raydium-amm-v4"
    | "raydium-clmm"
    | "raydium-cpmm"
    | "orca-whirlpool"
    | "meteora-dlmm";
  /** The owner/authority slot that must be the signer. */
  readonly authority: string;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly sourceMint?: string | undefined;
  readonly destinationMint?: string | undefined;
  /** The destination mint's token program when the instruction names it. */
  readonly destinationTokenProgram?: string;
  /** The most the swap may take from the source account. */
  readonly maxIn: bigint;
  /** The least the swap must deliver to the destination account. */
  readonly minOut: bigint;
};

/**
 * AMM swap instructions whose account layout pins the signer's worst-case in/out. Anything that
 * does not match a documented shape exactly — tag, data length, account count, signer slot, the AMM
 * v4 token program — returns undefined and falls back to the program-authority rule.
 */
export const decodeAmmSwapIx = (
  parsed: ParsedSolanaMessage,
  ix: { readonly accountIndices: ReadonlyArray<number>; readonly data: Uint8Array },
  lookups: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }> | undefined,
  program: string,
): AmmSwap | undefined => {
  const { data } = ix;
  const account = (i: number): string | undefined => {
    const index = ix.accountIndices[i];
    return index === undefined ? undefined : resolveAccountIndex(parsed, index, lookups);
  };

  if (program === RAYDIUM_AMM_PROGRAM) {
    /* instruction.rs unpack: tag 9 SwapBaseIn{amount_in, minimum_amount_out}, tag 17
       SwapBaseOutV2{max_amount_in, amount_out}, tag 16 SwapBaseInV2 — the V2 tags carry the same
       payloads without the orderbook market accounts. Tag 11 (orderbook base-out) does not decode:
       no real mainnet transaction was found to pin its 17|18-account layout. The token program
       account must be SPL Token (processor.rs). */
    const tag = data.at(0);
    const baseIn = tag === 9 || tag === 16;
    const baseOut = tag === 17;
    if ((!baseIn && !baseOut) || data.length !== 17) {
      return undefined;
    }
    const n = ix.accountIndices.length;
    /* 17|18 accounts for the orderbook shapes (18 = optional target_orders at index 4),
       exactly 8 for the V2 shapes; user source, destination and owner are always the last three
       (instruction.rs swap_base_in / swap_base_out metas). */
    const expected = tag === 16 || tag === 17 ? 8 : null;
    if (expected === null ? n !== 17 && n !== 18 : n !== expected) {
      return undefined;
    }
    if (account(0) !== SPL_TOKEN) {
      return undefined;
    }
    const authority = account(n - 1);
    const sourceAccount = account(n - 3);
    const destinationAccount = account(n - 2);
    if (
      authority === undefined ||
      sourceAccount === undefined ||
      destinationAccount === undefined
    ) {
      return undefined;
    }
    return {
      program,
      protocol: "raydium-amm-v4",
      authority,
      sourceAccount,
      destinationAccount,
      /* Both payloads put the in-bound (amount_in / max_amount_in) first and the out-bound
         (minimum_amount_out / amount_out) second. */
      maxIn: u64.decode(data, 1),
      minOut: u64.decode(data, 9),
    };
  }

  if (program === RAYDIUM_CPMM_PROGRAM) {
    /* swap_base_input{amount_in u64, minimum_amount_out u64} /
       swap_base_output{max_amount_in u64, amount_out u64}: exactly 13 accounts — payer(signer),
       authority(PDA), amm_config, pool_state, input_token_account, output_token_account,
       input_vault, output_vault, input_token_program, output_token_program, input_token_mint,
       output_token_mint, observation_state (swap_base_input.rs). */
    /* swap_base_output does not decode: no real mainnet transaction was found to pin it. */
    if (
      !startsWith(data, SWAP_BASE_INPUT) ||
      data.length !== 24 ||
      ix.accountIndices.length !== 13
    ) {
      return undefined;
    }
    const authority = account(0);
    const sourceAccount = account(4);
    const destinationAccount = account(5);
    const sourceMint = account(10);
    const destinationMint = account(11);
    const destinationTokenProgram = account(9);
    if (
      authority === undefined ||
      sourceAccount === undefined ||
      destinationAccount === undefined ||
      sourceMint === undefined ||
      destinationMint === undefined ||
      destinationTokenProgram === undefined
    ) {
      return undefined;
    }
    return {
      program,
      protocol: "raydium-cpmm",
      authority,
      sourceAccount,
      destinationAccount,
      sourceMint,
      destinationMint,
      destinationTokenProgram,
      /* Both payloads put the in-bound first and the out-bound second. */
      maxIn: u64.decode(data, 8),
      minOut: u64.decode(data, 16),
    };
  }

  if (program === RAYDIUM_CLMM_PROGRAM) {
    /* swap_v2{amount u64, other_amount_threshold u64, sqrt_price_limit_x64 u128,
       is_base_input bool}: 41 bytes, ≥13 accounts — payer(signer), amm_config, pool_state,
       input_token_account, output_token_account, input_vault, output_vault, observation_state,
       token_program, token_program_2022, memo_program, input_vault_mint, output_vault_mint, then
       remaining tick arrays (swap_v2.rs). */
    if (!startsWith(data, SWAP_V2) || data.length !== 41 || ix.accountIndices.length < 13) {
      return undefined;
    }
    const authority = account(0);
    const sourceAccount = account(3);
    const destinationAccount = account(4);
    const sourceMint = account(11);
    const destinationMint = account(12);
    if (
      authority === undefined ||
      sourceAccount === undefined ||
      destinationAccount === undefined ||
      sourceMint === undefined ||
      destinationMint === undefined
    ) {
      return undefined;
    }
    /* Base-out swaps are not decoded: no real mainnet transaction with
       is_base_input = 0 was found to pin the layout. */
    if (data.at(40) !== 1) {
      return undefined;
    }
    return {
      program,
      protocol: "raydium-clmm",
      authority,
      sourceAccount,
      destinationAccount,
      sourceMint,
      destinationMint,
      maxIn: u64.decode(data, 8),
      minOut: u64.decode(data, 16),
    };
  }

  if (program === WHIRLPOOL_PROGRAM) {
    /* swap_v2{amount u64, other_amount_threshold u64, sqrt_price_limit u128,
       amount_specified_is_input bool, a_to_b bool, Option<RemainingAccountsInfo>}: ≥15 accounts —
       token_program_a, token_program_b, memo_program, token_authority(signer), whirlpool,
       token_mint_a, token_mint_b, token_owner_account_a, token_vault_a, token_owner_account_b,
       token_vault_b, tick_array_0..2, oracle, then remaining accounts (v2/swap.rs). */
    if (!startsWith(data, SWAP_V2) || data.length < 43 || ix.accountIndices.length < 15) {
      return undefined;
    }
    /* Option<RemainingAccountsInfo>: u8 tag; None is exactly 1 byte; Some is a u32 slice count
       plus 2-byte {accounts_type, length} slices — the option must consume to the last byte. */
    const option = data.at(42);
    if (option === 0) {
      if (data.length !== 43) {
        return undefined;
      }
    } else if (option === 1) {
      if (data.length < 47) {
        return undefined;
      }
      const slices = u32.decode(data, 43);
      if (data.length !== 47 + slices * 2) {
        return undefined;
      }
    } else {
      return undefined;
    }
    const authority = account(3);
    if (authority === undefined) {
      return undefined;
    }
    /* Exact-out swaps are not decoded: no real mainnet transaction with
       amount_specified_is_input = 0 was found to pin the layout. */
    const aToB = data.at(41);
    if ((aToB !== 0 && aToB !== 1) || data.at(40) !== 1) {
      return undefined;
    }
    const sourceIndex = aToB === 1 ? 7 : 9;
    const destinationIndex = aToB === 1 ? 9 : 7;
    const sourceAccount = account(sourceIndex);
    const destinationAccount = account(destinationIndex);
    const sourceMint = account(aToB === 1 ? 5 : 6);
    const destinationMint = account(aToB === 1 ? 6 : 5);
    const destinationTokenProgram = account(aToB === 1 ? 1 : 0);
    if (
      sourceAccount === undefined ||
      destinationAccount === undefined ||
      sourceMint === undefined ||
      destinationMint === undefined ||
      destinationTokenProgram === undefined
    ) {
      return undefined;
    }
    return {
      program,
      protocol: "orca-whirlpool",
      authority,
      sourceAccount,
      destinationAccount,
      sourceMint,
      destinationMint,
      destinationTokenProgram,
      maxIn: u64.decode(data, 8),
      minOut: u64.decode(data, 16),
    };
  }

  if (program === METEORA_DLMM_PROGRAM) {
    /* lb_clmm 0.12.0 IDL (meteora-ag/dlmm-sdk@1532e540 ts-client/src/dlmm/idl/idl.json):
       swap{amount_in u64, min_amount_out u64} — 15 accounts; swap2{…, remaining_accounts_info} —
       16, memo_program at 13. Account slots: user_token_in 4, user_token_out 5, token_x_mint 6,
       token_y_mint 7, user (authority, the signer) 10, token_x_program 11, token_y_program 12.
       swapExactOut / swapWithPriceImpact and their *2 forms do not decode: their amount fields
       carry the same names with inverted bounds. */
    const swap = startsWith(data, DLMM_SWAP);
    const swap2 = !swap && startsWith(data, DLMM_SWAP2);
    if ((!swap && !swap2) || data.length < 24 || ix.accountIndices.length < (swap ? 15 : 16)) {
      return undefined;
    }
    if (swap) {
      if (data.length !== 24) {
        return undefined;
      }
    } else {
      /* RemainingAccountsInfo: u32 slice count, then {AccountsType u8, u8 when tag 3
         (TransferHookMultiReward carries a u8), length u8} per slice — it must consume exactly
         to the end, trailing bytes mean a different layout. */
      if (data.length < 28) {
        return undefined;
      }
      const slices = u32.decode(data, 24);
      let offset = 28;
      for (let i = 0; i < slices; i++) {
        const tag = data.at(offset);
        if (tag === undefined || tag > 4) {
          return undefined;
        }
        offset += tag === 3 ? 2 : 1;
        if (data.at(offset) === undefined) {
          return undefined;
        }
        offset += 1;
      }
      if (offset !== data.length) {
        return undefined;
      }
    }
    const authority = account(10);
    const sourceAccount = account(4);
    const destinationAccount = account(5);
    const mintX = account(6);
    const mintY = account(7);
    const programX = account(11);
    const programY = account(12);
    if (
      authority === undefined ||
      sourceAccount === undefined ||
      destinationAccount === undefined ||
      mintX === undefined ||
      mintY === undefined ||
      programX === undefined ||
      programY === undefined
    ) {
      return undefined;
    }
    /* The mints are not named in the instruction — resolve them from the signer's token
       accounts: user_token_in is the signer's ATA of one mint and user_token_out of the other.
       A token account that is not the signer's ATA leaves its leg unresolved (the intent shows
       the token account); both legs resolving to one mint is a malformed layout, not a swap. */
    const ataX = associatedTokenAddress(authority, mintX, programX);
    const ataY = associatedTokenAddress(authority, mintY, programY);
    const sourceMint = sourceAccount === ataX ? mintX : sourceAccount === ataY ? mintY : undefined;
    const destinationMint =
      destinationAccount === ataX ? mintX : destinationAccount === ataY ? mintY : undefined;
    if (sourceMint !== undefined && sourceMint === destinationMint) {
      return undefined;
    }
    return {
      program,
      protocol: "meteora-dlmm",
      authority,
      sourceAccount,
      destinationAccount,
      sourceMint,
      destinationMint,
      ...(destinationMint === undefined
        ? {}
        : { destinationTokenProgram: destinationMint === mintX ? programX : programY }),
      maxIn: u64.decode(data, 8),
      minOut: u64.decode(data, 16),
    };
  }

  return undefined;
};
