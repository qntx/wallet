/**
 * Which own-key outputs a signing prompt may hide as change. An output on this group's keys is
 * discoverable only when the wallet's gap-limited scan can reach it — anything else is shown as a
 * send to the caller's own address at an unusual path, with a warning. The reach bound comes from
 * the kernel's sealed change mark, never from the PSBT: an untrusted request can name any input
 * path, so signed inputs may raise the mark only for requests the wallet itself built
 * (`origin: "internal"`).
 */

/**
 * BIP-44 §Address gap limit — the trailing run of unused addresses a wallet scans.
 * (https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki#address-gap-limit)
 */
export const BITCOIN_GAP_LIMIT = 20;

/** The highest change-chain index a scan may reach — a hard bound on scan work. */
export const BITCOIN_SCAN_LIMIT = 2000;

/** Who built a `bitcoin.psbt` request: the wallet engine itself, or an outside caller. */
export type BitcoinRequestOrigin = "internal" | "external";

/** The `change`/`index` tail of an account path `m/purpose'/coin'/group'/change/index`. */
export type BitcoinPathTail = {
  readonly purpose: number;
  readonly change: number;
  readonly index: number;
};

/**
 * The kernel-sealed change mark for the next classification: `stored`, raised to the highest
 * change-chain index among the same-purpose signed inputs — but only for a request the wallet
 * itself built. An external request can name any input path, so its inputs never raise the mark.
 */
export const requestChangeMark = (
  stored: number,
  purpose: number,
  signed: ReadonlyArray<BitcoinPathTail>,
  origin: BitcoinRequestOrigin,
): number => {
  let mark = stored;
  if (origin === "internal") {
    for (const input of signed) {
      if (input.purpose === purpose && input.change === 1 && input.index > mark) {
        mark = input.index;
      }
    }
  }
  return mark;
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
 * signed input shares, at an index inside what the gap-limited scan reaches: the sealed change
 * mark plus the gap limit, bounded by the scan limit.
 */
export const isDiscoverableChange = (
  output: BitcoinPathTail,
  signed: ReadonlyArray<BitcoinPathTail>,
  mark: number,
): boolean =>
  output.change === 1 &&
  signed.some((input) => input.purpose === output.purpose) &&
  output.index <= mark + BITCOIN_GAP_LIMIT &&
  output.index < BITCOIN_SCAN_LIMIT;

/** The last change-chain index the gap-limited scan covers for a sealed mark. */
export const changeScanReach = (mark: number): number =>
  Math.min(mark + BITCOIN_GAP_LIMIT, BITCOIN_SCAN_LIMIT - 1);
