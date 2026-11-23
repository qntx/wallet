/**
 * Chain-side NFT reads: the standard, owner and balances a displayed item has on the ledger, from
 * the wallet's own RPC — never from the gateway. The inventory is display-only; these reads are how
 * a send can be re-checked after the item's tx confirms and how the transfer routes (a later layer)
 * verify ownership.
 */
import { base58, base64 } from "@scure/base";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { BaseError, ContractFunctionRevertedError, isAddress } from "viem";
import { readContract } from "viem/actions";

import { MPL_CORE_PROGRAM, PROGRAM_IDS, associatedTokenAddress } from "@qntx/wallet-chains/solana";

import type { SolanaRpc } from "../networks/controller.ts";

type ViemClient = Parameters<typeof readContract>[0];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

/* --- EVM --- */

export const ERC165_ABI = [
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const ERC721_INTERFACE = "0x80ac58cd";
export const ERC1155_INTERFACE = "0xd9b67a26";

const ERC721_OWNER_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const ERC1155_BATCH_ABI = [
  {
    type: "function",
    name: "balanceOfBatch",
    stateMutability: "view",
    inputs: [
      { name: "accounts", type: "address[]" },
      { name: "ids", type: "uint256[]" },
    ],
    outputs: [{ name: "", type: "uint256[]" }],
  },
] as const;

/** Narrow a string to an EVM address — chain reads take only well-formed 20-byte hex. */
const evmAddress = (value: string): `0x${string}` => {
  if (!isAddress(value, { strict: false })) {
    throw new TypeError(`invalid EVM address ${value}`);
  }
  return value;
};

/** The error walks to a contract revert — the call is legal, the contract just refused it. */
const reverted = (error: unknown): boolean =>
  error instanceof BaseError &&
  error.walk((e) => e instanceof ContractFunctionRevertedError) !== undefined;

const supportsInterface = async (
  client: ViemClient,
  contract: `0x${string}`,
  interfaceId: `0x${string}`,
): Promise<boolean> => {
  try {
    return await readContract(client, {
      address: contract,
      abi: ERC165_ABI,
      functionName: "supportsInterface",
      args: [interfaceId],
    });
  } catch (error) {
    if (reverted(error)) {
      return false;
    }
    throw error;
  }
};

/** The ERC standard `contract` answers to, or `undefined` when it claims neither. */
export const evmNftStandard = async (
  client: ViemClient,
  contract: string,
): Promise<"erc721" | "erc1155" | undefined> => {
  const c = evmAddress(contract);
  if (await supportsInterface(client, c, ERC721_INTERFACE)) {
    return "erc721";
  }
  if (await supportsInterface(client, c, ERC1155_INTERFACE)) {
    return "erc1155";
  }
  return undefined;
};

/** The holder of `tokenId`, or `undefined` when the contract has none for it. */
export const evmNftOwner = async (
  client: ViemClient,
  contract: string,
  tokenId: bigint,
): Promise<string | undefined> => {
  try {
    return await readContract(client, {
      address: evmAddress(contract),
      abi: ERC721_OWNER_ABI,
      functionName: "ownerOf",
      args: [tokenId],
    });
  } catch (error) {
    if (reverted(error)) {
      return undefined;
    }
    throw error;
  }
};

/** `owner`'s balance of every id in `ids`, ERC-1155 — the answer must name each id once. */
export const evmNftBalances = async (
  client: ViemClient,
  contract: string,
  owner: string,
  ids: ReadonlyArray<bigint>,
): Promise<ReadonlyArray<bigint>> => {
  const answer = await readContract(client, {
    address: evmAddress(contract),
    abi: ERC1155_BATCH_ABI,
    functionName: "balanceOfBatch",
    args: [ids.map(() => evmAddress(owner)), [...ids]],
  });
  if (answer.length !== ids.length) {
    throw new Error("balanceOfBatch answered the wrong number of balances");
  }
  return answer;
};

/**
 * `owner`'s units of `tokenId`: an ERC-721 owner read answers 0 or 1, an ERC-1155 balance read its
 * real count. A contract that claims neither standard — or has no owner for the id — reads 0.
 */
export const evmNftBalance = async (
  client: ViemClient,
  contract: string,
  tokenId: bigint,
  owner: string,
): Promise<bigint> => {
  const standard = await evmNftStandard(client, contract);
  if (standard === "erc721") {
    const holder = await evmNftOwner(client, contract, tokenId);
    return holder !== undefined && holder.toLowerCase() === owner.toLowerCase() ? 1n : 0n;
  }
  if (standard === "erc1155") {
    const [balance] = await evmNftBalances(client, contract, owner, [tokenId]);
    return balance ?? 0n;
  }
  return 0n;
};

/* --- Solana --- */

const METAPLEX_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/** Mpl-core AssetV1 discriminators. */
export const CORE_KEY_ASSET_V1 = 1;
export const CORE_UPDATE_AUTHORITY_COLLECTION = 2;

/** The Metaplex metadata PDA of `mint`: seeds `["metadata", program, mint]` under the program. */
export const metaplexMetadataAddress = async (mint: string): Promise<string> => {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(METAPLEX_METADATA_PROGRAM),
    seeds: [
      "metadata",
      encoder.encode(address(METAPLEX_METADATA_PROGRAM)),
      encoder.encode(address(mint)),
    ],
  });
  return pda;
};

/** `address`'s confirmed account owner and bytes, or `undefined` when it does not exist. */
export const solanaAccountBytes = async (
  rpc: SolanaRpc,
  account: string,
): Promise<{ readonly owner: string; readonly data: Uint8Array } | undefined> => {
  const info = await rpc.call("getAccountInfo", [
    account,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const value = obj(info)?.["value"];
  if (value === null || value === undefined) {
    return undefined;
  }
  const owner = obj(value)?.["owner"];
  const raw = arr(obj(value)?.["data"])?.[0];
  if (typeof owner !== "string" || typeof raw !== "string") {
    return undefined;
  }
  return { owner, data: base64.decode(raw) };
};

const u64le = (data: Uint8Array, at: number): bigint =>
  new DataView(data.buffer, data.byteOffset + at, 8).getBigUint64(0, true);

/** The SPL mint layout: supply u64-LE at 36, decimals at 44, initialized at 45 — 82 bytes. */
export const parseMint = (
  data: Uint8Array,
):
  | { readonly supply: bigint; readonly decimals: number; readonly initialized: boolean }
  | undefined =>
  data.length === 82
    ? { supply: u64le(data, 36), decimals: data[44] ?? 0, initialized: data[45] === 1 }
    : undefined;

/**
 * The SPL token-account layout: mint at 0, owner at 32, amount u64-LE at 64, state at 108 — 165
 * bytes for the Token program; Token-2022 accounts may carry extensions after them, so they only
 * need to reach that last field.
 */
export const parseTokenAccount = (
  data: Uint8Array,
  owner: string,
):
  | {
      readonly mint: string;
      readonly owner: string;
      readonly amount: bigint;
      readonly state: "uninitialized" | "initialized" | "frozen";
    }
  | undefined => {
  if (data.length < 165 || (owner === PROGRAM_IDS.token && data.length !== 165)) {
    return undefined;
  }
  const state =
    data[108] === 0
      ? "uninitialized"
      : data[108] === 1
        ? "initialized"
        : data[108] === 2
          ? "frozen"
          : undefined;
  if (state === undefined) {
    return undefined;
  }
  return {
    mint: base58.encode(data.slice(0, 32)),
    owner: base58.encode(data.slice(32, 64)),
    amount: u64le(data, 64),
    state,
  };
};

/**
 * The `token_standard` of a Metaplex metadata account (0 = non-fungible, 4 = programmable NFT …),
 * read by a strict Borsh walk: any out-of-bounds field, an Option tag outside {0,1} or a standard
 * above the enum's 5 is `undefined` — never a guessed standard.
 */
export const metaplexTokenStandard = (data: Uint8Array, mint: string): number | undefined => {
  let o = 0;
  const u8 = (): number | undefined => {
    const v = o < data.length ? data[o] : undefined;
    o += 1;
    return v;
  };
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  const u16 = (): number | undefined => {
    if (o + 2 > data.length) {
      return undefined;
    }
    const v = view.getUint16(o, true);
    o += 2;
    return v;
  };
  const u32 = (): number | undefined => {
    if (o + 4 > data.length) {
      return undefined;
    }
    const v = view.getUint32(o, true);
    o += 4;
    return v;
  };
  const bytes = (n: number): Uint8Array | undefined => {
    if (n < 0 || o + n > data.length) {
      return undefined;
    }
    const v = data.slice(o, o + n);
    o += n;
    return v;
  };
  const text = (): Uint8Array | undefined => {
    const n = u32();
    return n === undefined ? undefined : bytes(n);
  };
  const option = (): 0 | 1 | undefined => {
    const tag = u8();
    return tag === 0 || tag === 1 ? tag : undefined;
  };

  // key u8, updateAuthority 32, mint 32 — the account must describe the asked mint.
  if (u8() === undefined || bytes(32) === undefined) {
    return undefined;
  }
  const accountMint = bytes(32);
  if (accountMint === undefined || base58.encode(accountMint) !== mint) {
    return undefined;
  }
  // Data: name, symbol, uri strings; seller_fee u16; creators Option<Vec<34>>.
  if (text() === undefined || text() === undefined || text() === undefined) {
    return undefined;
  }
  if (u16() === undefined) {
    return undefined;
  }
  const creators = option();
  if (creators === undefined) {
    return undefined;
  }
  if (creators === 1) {
    const count = u32();
    if (count === undefined || bytes(count * 34) === undefined) {
      return undefined;
    }
  }
  // primary_sale u8, is_mutable u8, edition_nonce Option<u8>, token_standard Option<u8>.
  if (u8() === undefined || u8() === undefined) {
    return undefined;
  }
  const nonce = option();
  if (nonce === undefined || (nonce === 1 && u8() === undefined)) {
    return undefined;
  }
  const tag = option();
  if (tag === undefined) {
    return undefined;
  }
  if (tag === 0) {
    return undefined;
  }
  const value = u8();
  return value === undefined || value > 5 ? undefined : value;
};

/**
 * `owner`'s units of `asset` on chain: a Core asset's owner field directly, an SPL/Token-2022 NFT
 * via its ATA (whose mint and owner must both match). Anything missing or unparseable reads 0.
 */
export const solanaNftBalance = async (
  rpc: SolanaRpc,
  asset: string,
  owner: string,
): Promise<bigint> => {
  const account = await solanaAccountBytes(rpc, asset);
  if (account === undefined) {
    return 0n;
  }
  if (account.owner === MPL_CORE_PROGRAM) {
    const { data } = account;
    return data.length >= 33 &&
      data[0] === CORE_KEY_ASSET_V1 &&
      base58.encode(data.slice(1, 33)) === owner
      ? 1n
      : 0n;
  }
  if (account.owner === PROGRAM_IDS.token || account.owner === PROGRAM_IDS.token2022) {
    const ata = associatedTokenAddress(owner, asset, account.owner);
    const holding = await solanaAccountBytes(rpc, ata);
    if (holding === undefined || holding.owner !== account.owner) {
      return 0n;
    }
    const parsed = parseTokenAccount(holding.data, holding.owner);
    return parsed !== undefined && parsed.mint === asset && parsed.owner === owner
      ? parsed.amount
      : 0n;
  }
  return 0n;
};
