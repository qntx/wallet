/**
 * Display-time spam heuristics for tokens the chain offers no trust signal for. A reason is only
 * ever computed for unverified tokens — a verified entry (built-in table, or a list token whose
 * on-chain decimals match) returns an empty array. Reasons are reported in the type's fixed order
 * so the same token always flags the same way.
 */
export type SpamReason =
  | "impersonation"
  | "suspicious-symbol"
  | "link-in-name"
  | "permanent-delegate"
  | "non-transferable";

/** A symbol that cannot be a real ticker — odd characters or a domain-looking suffix. */
export const suspiciousTokenSymbol = (symbol: string): boolean =>
  !/^[A-Za-z0-9$+._-]{1,16}$/.test(symbol) || /\.[a-z]{2,}/i.test(symbol);

/** A URL or bare domain smuggled into display text — airdrop phishing's favourite vehicle. */
const LINK_IN_NAME =
  /(?:https?:\/\/|www\.|t\.me\/|\b[a-z0-9-]+\.(?:com|io|net|org|xyz|app|fi|finance|site|online|top|vip|cc|me|gg|link|pro|club|info|live|gift|claims?)\b)/i;

/** The verified symbol owners of one network: lowercase symbol → canonical addresses holding it. */
export const symbolOwners = (
  tokens: ReadonlyArray<readonly [string, { readonly symbol: string }]>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const owners = new Map<string, Set<string>>();
  for (const [address, token] of tokens) {
    const key = token.symbol.toLowerCase();
    const set = owners.get(key) ?? new Set<string>();
    set.add(address);
    owners.set(key, set);
  }
  return owners;
};

/**
 * The spam reasons of one token, in fixed order:
 *
 * - `impersonation` — the symbol is owned by a verified token (table or list) at a DIFFERENT
 *   canonical `address` in `owners`; a token never impersonates itself.
 * - `suspicious-symbol` — the symbol cannot be a real ticker.
 * - `link-in-name` — symbol or name carries a URL or domain.
 * - `permanent-delegate` / `non-transferable` — Token-2022 extensions the mint carries.
 */
export function spamReasons(input: {
  readonly address: string;
  readonly symbol?: string | undefined;
  readonly name?: string | undefined;
  readonly owners: ReadonlyMap<string, ReadonlySet<string>>;
  readonly permanentDelegate?: boolean | undefined;
  readonly nonTransferable?: boolean | undefined;
}): ReadonlyArray<SpamReason> {
  const reasons: SpamReason[] = [];
  const owned =
    input.symbol === undefined ? undefined : input.owners.get(input.symbol.toLowerCase());
  if (owned !== undefined && !owned.has(input.address)) {
    reasons.push("impersonation");
  }
  if (input.symbol !== undefined && suspiciousTokenSymbol(input.symbol)) {
    reasons.push("suspicious-symbol");
  }
  if (
    (input.symbol !== undefined && LINK_IN_NAME.test(input.symbol)) ||
    (input.name !== undefined && LINK_IN_NAME.test(input.name))
  ) {
    reasons.push("link-in-name");
  }
  if (input.permanentDelegate === true) {
    reasons.push("permanent-delegate");
  }
  if (input.nonTransferable === true) {
    reasons.push("non-transferable");
  }
  return reasons;
}
