import { base58 } from "@scure/base";
/**
 * `solana-revoke`: read-before-build and the decode guard for SPL `Revoke`. Every named token
 * account is re-read on both endpoints at `confirmed` (a disagreeing successful read refuses, a
 * failed corroborator degrades to `reads-unverified`), must be an owned Token or Token-2022 account
 * that still carries a delegate, and gets exactly one program-matched `Revoke`. The compiled
 * message must decode back to exactly those `delegate-revoked` approvals: no outflows, nothing
 * else.
 */
import { getRevokeInstruction } from "@solana-program/token";
import { getRevokeInstruction as getRevokeInstruction2022 } from "@solana-program/token-2022";
import { address, createNoopSigner } from "@solana/kit";

import { ChainError } from "@qntx/wallet-chains";
import type { ApprovalChange, DisplayIntent } from "@qntx/wallet-chains";
import { decodeSolana, PROGRAM_IDS } from "@qntx/wallet-chains/solana";
import { chains } from "@qntx/wallet/chains";

import { SolanaChainAdapter } from "../chains/solana.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import { accountAddressOf } from "./route.ts";
import type { ChainRequestInput, PreparedRequest, RouteContext } from "./route.ts";
import { finishPrepared } from "./solana.ts";

export const SOLANA_REVOKE_MAX = 10;

const solana = new SolanaChainAdapter();

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

type RevokeInput = Extract<ChainRequestInput, { method: "solana-revoke" }>;

/* The fields a revocation relies on from one `getMultipleAccounts` jsonParsed answer. */
type AccountState = {
  readonly program: string;
  readonly owner: string | undefined;
  readonly delegate: string | undefined;
};

const parseAccountState = (value: unknown): AccountState | undefined => {
  const parsed = obj(obj(obj(value)?.["data"])?.["parsed"]);
  const info = obj(parsed?.["info"]);
  if (parsed?.["type"] !== "account" || info === undefined) {
    return undefined;
  }
  return {
    program: str(obj(value)?.["owner"]) ?? "",
    owner: str(info["owner"]),
    delegate: str(info["delegate"]),
  };
};

const sameState = (a: AccountState | undefined, b: AccountState | undefined): boolean =>
  a?.program === b?.program && a?.owner === b?.owner && a?.delegate === b?.delegate;

/**
 * Read-before-build → encode → guard. 1..SOLANA_REVOKE_MAX distinct token accounts, each owned by
 * the signer and still carrying a delegate; the built message must decode back to exactly those
 * `delegate-revoked` approvals in order.
 */
export const prepareSolanaRevoke = async (
  ctx: RouteContext,
  input: RevokeInput,
): Promise<PreparedRequest> => {
  const { account, network, tokenAccounts, fee } = input;
  const rpc = ctx.options.networks.solanaRpc(network);
  const independent = ctx.options.networks.independentSolanaRpc(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const from = await accountAddressOf(ctx, account, "solana.bip44-change", network);

  if (tokenAccounts.length === 0 || tokenAccounts.length > SOLANA_REVOKE_MAX) {
    throw new ChainError(
      "invalid-request",
      `a revocation takes 1..${SOLANA_REVOKE_MAX.toString(10)} token accounts`,
    );
  }
  const seen = new Set<string>();
  for (const tokenAccount of tokenAccounts) {
    try {
      base58.decode(tokenAccount);
    } catch {
      throw new ChainError("invalid-request", `${tokenAccount} is not a base58 account`);
    }
    if (seen.has(tokenAccount)) {
      throw new ChainError("invalid-request", `duplicate token account: ${tokenAccount}`);
    }
    seen.add(tokenAccount);
  }

  const readStates = async (client: typeof rpc): Promise<Array<AccountState | undefined>> => {
    const res = await client.call("getMultipleAccounts", [
      [...tokenAccounts],
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    const values = arr(obj(res)?.["value"]) ?? [];
    return tokenAccounts.map((_, i) => parseAccountState(values[i]));
  };
  const primary = await readStates(rpc);
  const flags: Array<RequestCheckCode | undefined> = [];
  if (independent.kind === "available") {
    try {
      const other = await readStates(independent.client);
      const disagree = tokenAccounts.findIndex((_, i) => !sameState(primary[i], other[i]));
      if (disagree !== -1) {
        throw new ChainError(
          "invalid-request",
          `the two endpoints disagree on ${tokenAccounts[disagree] ?? "a token account"}`,
        );
      }
    } catch (error) {
      if (error instanceof ChainError) {
        throw error;
      }
      flags.push("reads-unverified");
    }
  }

  const instructions = tokenAccounts.map((tokenAccount, i) => {
    const state = primary[i];
    if (state === undefined || state.program === "") {
      throw new ChainError("invalid-request", `${tokenAccount} is not a token account`);
    }
    if (state.program !== PROGRAM_IDS.token && state.program !== PROGRAM_IDS.token2022) {
      throw new ChainError("invalid-request", `${tokenAccount} is not a token account`);
    }
    if (state.owner !== from) {
      throw new ChainError("invalid-request", `${tokenAccount} is not owned by this account`);
    }
    if (state.delegate === undefined) {
      throw new ChainError("invalid-request", `${tokenAccount} has no delegate to revoke`);
    }
    const args = {
      source: address(tokenAccount),
      owner: createNoopSigner(address(from)),
    };
    return state.program === PROGRAM_IDS.token2022
      ? getRevokeInstruction2022(args)
      : getRevokeInstruction(args);
  });

  const unsigned = await solana.build(rpc, network, from, {
    kind: "instructions",
    instructions,
  });
  return finishPrepared(ctx, {
    account,
    network,
    from,
    fee,
    unsigned,
    rpc,
    independent,
    apis,
    flags,
    intentOf: (request): DisplayIntent => {
      const intent = decodeSolana(request, from);
      const approvals = intent.approvals ?? [];
      const expected = (a: ApprovalChange | undefined, i: number): boolean =>
        a?.kind === "delegate-revoked" && a.account === tokenAccounts[i];
      if (
        intent.verifiability !== "full" ||
        intent.outflows.length > 0 ||
        approvals.length !== tokenAccounts.length ||
        !approvals.every(expected)
      ) {
        throw new ChainError(
          "invalid-request",
          "the built revocation does not decode to the requested revokes",
        );
      }
      return intent;
    },
  });
};
