import { evmTokenTable, lookupEvmToken } from "@qntx/wallet-chains/evm";

import { assessRecipients, impersonatesBuiltIn } from "../requests/risk.ts";
import type { HistoryFlag } from "./types.ts";

/**
 * Token-symbol flags for an unlisted EVM token. Built-in table tokens never get flags: their symbol
 * is trusted. Two shapes: a name borrowed from a different built-in token of the same chain
 * (impersonation), and a symbol that cannot be a real ticker — odd characters or a domain-looking
 * suffix like `claim-usdc.com`.
 */
export const tokenFlags = (
  chainId: number,
  contract: string,
  symbol: string | undefined,
): ReadonlyArray<HistoryFlag> => {
  if (lookupEvmToken(evmTokenTable, chainId, contract) !== undefined || symbol === undefined) {
    return [];
  }
  const flags: HistoryFlag[] = [];
  if (impersonatesBuiltIn(chainId, contract, symbol)) {
    flags.push("token-impersonation");
  }
  if (!/^[A-Za-z0-9$+._-]{1,16}$/.test(symbol) || /\.[a-z]{2,}/i.test(symbol)) {
    flags.push("suspicious-token-symbol");
  }
  return flags;
};

/**
 * True when some counterparty looks like an address the wallet already knows — the request
 * pipeline's own `address-poisoning` rule, reused rather than reimplemented.
 */
export const lookalike = (
  family: string,
  counterparties: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
): boolean =>
  counterparties.some((counterparty) =>
    assessRecipients(family, [counterparty], known).some((f) => f.code === "address-poisoning"),
  );
