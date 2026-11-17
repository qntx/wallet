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
 */
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import type { SolanaRpc } from "../networks/controller.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const DECIMAL = /^\d+$/;

export type SolanaTokenHolding = {
  readonly balance: bigint;
  readonly frozen: bigint;
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
