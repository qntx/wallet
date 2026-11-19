/**
 * Solana SPL holdings: every token account the owner holds, summed per mint across both the SPL
 * Token and Token-2022 programs — two `getTokenAccountsByOwner` calls per read regardless of how
 * many mints are tracked.
 *
 * Counting rules: an entry counts only when the account's program owner is the program queried, the
 * parsed `info.owner` is the holder, `info.mint` is a string, `tokenAmount.amount` is a
 * decimal-digit string and `tokenAmount.decimals` a non-negative integer — anything else is
 * ignored. `state === "initialized"` adds to `balance`; `state === "frozen"` to `frozen` (the owner
 * cannot move those funds until the mint thaws them); every other state is ignored. Delegated
 * amounts stay in `balance` — an allowance is an approval, not a holding. Closed accounts do not
 * exist on chain, so the RPC never returns them, and an empty account anyone can create for the
 * victim adds 0.
 *
 * Mint inspection ({@link inspectMints}) reads up to 50 mints per `getMultipleAccounts` call — the
 * mint plus its Metaplex metadata PDA — so a refresh pays at most one extra call while uninspected
 * mints remain, and each mint is read once per unlock (the caller caches). Display metadata never
 * falls back to a guess: a mint that does not parse as a mint is "missing", not decimal 9.
 */
import { base64 } from "@scure/base";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { address, getAddressEncoder, getProgramDerivedAddress, isAddress } from "@solana/kit";
import type { Address, ReadonlyUint8Array } from "@solana/kit";

import { PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import { parseWith, tokenName, tokenSymbol } from "../gateway/contract/index.ts";
import type { SolanaRpc } from "../networks/controller.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const DECIMAL = /^\d+$/;

export type SolanaTokenHolding = {
  readonly balance: bigint;
  readonly frozen: bigint;
  /** Decimals the counted token accounts report — the mint's own, never assumed. */
  readonly decimals: number;
};

const collect = (
  holdings: Map<string, SolanaTokenHolding>,
  response: unknown,
  programId: string,
  owner: string,
): void => {
  const value = isObject(response) ? response["value"] : undefined;
  for (const entry of Array.isArray(value) ? value : []) {
    const account = isObject(entry) ? entry["account"] : undefined;
    if (!isObject(account) || account["owner"] !== programId) {
      continue;
    }
    const parsed = isObject(account["data"]) ? account["data"]["parsed"] : undefined;
    const info = isObject(parsed) ? parsed["info"] : undefined;
    const tokenAmount = isObject(info) ? info["tokenAmount"] : undefined;
    if (
      !isObject(info) ||
      info["owner"] !== owner ||
      typeof info["mint"] !== "string" ||
      !isObject(tokenAmount) ||
      typeof tokenAmount["amount"] !== "string" ||
      !DECIMAL.test(tokenAmount["amount"]) ||
      typeof tokenAmount["decimals"] !== "number" ||
      !Number.isInteger(tokenAmount["decimals"]) ||
      tokenAmount["decimals"] < 0
    ) {
      continue;
    }
    const { mint } = info;
    const amount = BigInt(tokenAmount["amount"]);
    const held = holdings.get(mint) ?? {
      balance: 0n,
      frozen: 0n,
      decimals: tokenAmount["decimals"],
    };
    if (info["state"] === "initialized") {
      holdings.set(mint, { ...held, balance: held.balance + amount });
    } else if (info["state"] === "frozen") {
      holdings.set(mint, { ...held, frozen: held.frozen + amount });
    }
  }
};

/** The owner's per-mint holdings across both token programs; missing mints are absent. */
export const solanaTokenHoldings = async (
  rpc: SolanaRpc,
  owner: string,
): Promise<ReadonlyMap<string, SolanaTokenHolding>> => {
  const holdings = new Map<string, SolanaTokenHolding>();
  await Promise.all(
    [TOKEN_PROGRAM_ADDRESS, PROGRAM_IDS.token2022].map(async (programId) => {
      const response = await rpc.call("getTokenAccountsByOwner", [
        owner,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      collect(holdings, response, programId, owner);
    }),
  );
  return holdings;
};

const METAPLEX_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const INSPECT_BATCH = 50;

/** What one mint tells display: units, and the metadata/extensions it carries on-chain. */
export type MintFacts = {
  readonly decimals: number;
  readonly supply: string;
  readonly symbol?: string | undefined;
  readonly name?: string | undefined;
  readonly permanentDelegate: boolean;
  readonly nonTransferable: boolean;
};

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

/** A Metaplex metadata account's name/symbol, or `undefined` when it does not describe `mint`. */
const metaplexText = (
  account: unknown,
  mintBytes: ReadonlyUint8Array,
): { readonly symbol?: string; readonly name?: string } | undefined => {
  const acct = isObject(account) ? account : undefined;
  const data = isObject(acct) ? acct["data"] : undefined;
  if (
    acct?.["owner"] !== METAPLEX_METADATA_PROGRAM ||
    !Array.isArray(data) ||
    typeof data[0] !== "string" ||
    data[1] !== "base64"
  ) {
    return undefined;
  }
  const bytes = base64.decode(data[0]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // key u8, updateAuthority 32, mint 32 — the mint field must name the mint we asked for.
  const MINT_OFFSET = 33;
  if (bytes.length < MINT_OFFSET + 32 || !mintBytes.every((b, i) => bytes[MINT_OFFSET + i] === b)) {
    return undefined;
  }
  const text = (offset: number): { readonly value: string; readonly next: number } | undefined => {
    if (offset + 4 > bytes.length) {
      return undefined;
    }
    const length = view.getUint32(offset, true);
    const start = offset + 4;
    if (start + length > bytes.length) {
      return undefined;
    }
    const raw = new TextDecoder().decode(bytes.subarray(start, start + length));
    return { value: raw.replace(/\0+$/, "").trim(), next: start + length };
  };
  const name = text(MINT_OFFSET + 32);
  const symbol = name === undefined ? undefined : text(name.next);
  const validName = name === undefined ? undefined : parseWith(tokenName, name.value);
  const validSymbol = symbol === undefined ? undefined : parseWith(tokenSymbol, symbol.value);
  return {
    ...(validName === undefined ? {} : { name: validName }),
    ...(validSymbol === undefined ? {} : { symbol: validSymbol }),
  };
};

/** `text` as display metadata, dropped when it fails the contract's display-text schema. */
const displayText = (value: unknown, schema: typeof tokenSymbol): string | undefined =>
  typeof value === "string" ? parseWith(schema, value.trim()) : undefined;

/** One mint account's facts under jsonParsed, or `undefined` when it is not a mint. */
const mintFacts = (account: unknown): MintFacts | undefined => {
  const acct = isObject(account) ? account : undefined;
  const data = isObject(acct) ? acct["data"] : undefined;
  const parsed = isObject(data) ? data["parsed"] : undefined;
  const info = isObject(parsed) ? parsed["info"] : undefined;
  const isMint = acct?.["owner"] === PROGRAM_IDS.token || acct?.["owner"] === PROGRAM_IDS.token2022;
  if (
    !isMint ||
    !isObject(parsed) ||
    parsed["type"] !== "mint" ||
    !isObject(info) ||
    typeof info["decimals"] !== "number" ||
    !Number.isInteger(info["decimals"]) ||
    info["decimals"] < 0 ||
    typeof info["supply"] !== "string" ||
    !DECIMAL.test(info["supply"])
  ) {
    return undefined;
  }
  let symbol: string | undefined;
  let name: string | undefined;
  let permanentDelegate = false;
  let nonTransferable = false;
  const extensions = Array.isArray(info["extensions"]) ? info["extensions"] : [];
  for (const entry of extensions) {
    if (!isObject(entry)) {
      continue;
    }
    const state = isObject(entry["state"]) ? entry["state"] : undefined;
    if (entry["extension"] === "tokenMetadata") {
      symbol = displayText(state?.["symbol"], tokenSymbol) ?? symbol;
      name = displayText(state?.["name"], tokenName) ?? name;
    } else if (entry["extension"] === "permanentDelegate") {
      permanentDelegate = state?.["delegate"] !== undefined && state?.["delegate"] !== null;
    } else if (entry["extension"] === "nonTransferable") {
      nonTransferable = true;
    }
  }
  return {
    decimals: info["decimals"],
    supply: info["supply"],
    permanentDelegate,
    nonTransferable,
    ...(symbol === undefined ? {} : { symbol }),
    ...(name === undefined ? {} : { name }),
  };
};

/**
 * Facts for up to 50 mints per `getMultipleAccounts` call — each mint paired with its Metaplex
 * metadata PDA. A mint that is absent or does not parse as a mint is `"missing"`. Token-2022
 * `tokenMetadata` wins over the Metaplex account; either source's text that fails the display
 * schema is absent, never raw.
 */
export const inspectMints = async (
  rpc: SolanaRpc,
  mints: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, MintFacts | "missing">> => {
  const facts = new Map<string, MintFacts | "missing">();
  const encoder = getAddressEncoder();
  const valid = mints.filter((mint): mint is Address => isAddress(mint));
  for (const mint of mints) {
    if (!isAddress(mint)) {
      facts.set(mint, "missing");
    }
  }
  const chunks: Array<ReadonlyArray<Address>> = [];
  for (let from = 0; from < valid.length; from += INSPECT_BATCH) {
    chunks.push(valid.slice(from, from + INSPECT_BATCH));
  }
  const responses = await Promise.all(
    chunks.map(async (chunk) => {
      const pdas = await Promise.all(chunk.map(async (mint) => metaplexMetadataAddress(mint)));
      const keys = chunk.flatMap((mint, i) => [mint, pdas[i] ?? mint]);
      const raw = await rpc.call("getMultipleAccounts", [
        keys,
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      const value = isObject(raw) ? raw["value"] : undefined;
      // A malformed or short answer is an RPC failure, not evidence the mints are absent —
      // nothing is cached, so the next refresh asks again.
      if (!Array.isArray(value) || value.length !== keys.length) {
        throw new TypeError(
          `getMultipleAccounts returned a malformed value for ${String(keys.length)} keys`,
        );
      }
      const values: ReadonlyArray<unknown> = value;
      return values;
    }),
  );
  for (const [c, chunk] of chunks.entries()) {
    const values = responses[c] ?? [];
    for (const [i, mint] of chunk.entries()) {
      const mintAccount = values[2 * i];
      const parsed = mintFacts(mintAccount);
      if (parsed === undefined) {
        facts.set(mint, "missing");
        continue;
      }
      const meta = metaplexText(values[2 * i + 1], encoder.encode(address(mint)));
      facts.set(mint, {
        ...parsed,
        // Token-2022 metadata wins over Metaplex when both describe the mint.
        symbol: parsed.symbol ?? meta?.symbol,
        name: parsed.name ?? meta?.name,
      });
    }
  }
  return facts;
};
