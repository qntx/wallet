/**
 * Which own-key outputs a signing prompt may hide as change. An output on this group's keys is
 * discoverable only when the wallet's gap-limited scan can reach it — anything else is shown as a
 * send to the caller's own address at an unusual path, with a warning.
 */

/**
 * BIP-44 §Address gap limit — the trailing run of unused addresses a wallet scans.
 * (https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki#address-gap-limit)
 */
export const BITCOIN_GAP_LIMIT = 20;

/** The `change`/`index` tail of an account path `m/purpose'/coin'/group'/change/index`. */
export type BitcoinPathTail = {
  readonly purpose: number;
  readonly change: number;
  readonly index: number;
};

/**
 * The own-key outputs of a PSBT, classified by the caller that independently verified them:
 * `change` maps script hex to nothing — it is hidden from the prompt; `unusual` maps script hex to
 * the output's `m/…` path text — it is shown as an outflow to the caller's own address.
 */
export type BitcoinOwn = {
  readonly change: ReadonlySet<string>;
  readonly unusual: ReadonlyMap<string, string>;
};

export const EMPTY_BITCOIN_OWN: BitcoinOwn = { change: new Set(), unusual: new Map() };

/**
 * An output is discoverable change only on the change chain (`/1/i`), under a purpose at least one
 * signed input shares, at an index inside what the gap-limited scan reaches: the highest proven
 * change index among the same-purpose signed inputs plus the gap limit.
 */
export const isDiscoverableChange = (
  output: BitcoinPathTail,
  signed: ReadonlyArray<BitcoinPathTail>,
): boolean => {
  if (output.change !== 1) {
    return false;
  }
  let samePurpose = false;
  let highest = -1;
  for (const input of signed) {
    if (input.purpose !== output.purpose) {
      continue;
    }
    samePurpose = true;
    if (input.change === 1 && input.index > highest) {
      highest = input.index;
    }
  }
  return samePurpose && output.index <= Math.max(0, highest) + BITCOIN_GAP_LIMIT;
};
