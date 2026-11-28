/**
 * Which own-key outputs a signing prompt may hide as change. An output on this group's keys is
 * discoverable only when the wallet's gap-limited scan can reach it — anything else is shown as a
 * send to the caller's own address at an unusual path, with a warning. The reach bound comes from
 * the kernel's sealed change mark, never from the PSBT: a signed input can name any path, so inputs
 * never raise the mark. An `internal` request — one the wallet itself built — seals the change
 * indexes its discoverable own outputs reached, hidden or unconfirmed alike — the signed bytes pay
 * those addresses, so the wallet must scan that far; an external request still hides change inside
 * the window — the scan reaches it either way — but commits nothing.
 */

/**
 * BIP-44 §Address gap limit — the trailing run of unused addresses a wallet scans.
 * (https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki#address-gap-limit)
 */
export const BITCOIN_GAP_LIMIT = 20;

/** The highest change-chain index a scan may reach — a hard bound on scan work. */
export const BITCOIN_SCAN_LIMIT = 2000;

/**
 * Who built a `bitcoin.psbt` request: the wallet engine itself (`internal`), or an outside caller
 * (`external`). Only an internal request may seal the change indexes it hid into the mark; signed
 * inputs raise it for neither origin.
 */
export type BitcoinRequestOrigin = "internal" | "external";

/** The `change`/`index` tail of an account path `m/purpose'/coin'/group'/change/index`. */
export type BitcoinPathTail = {
  readonly purpose: number;
  readonly change: number;
  readonly index: number;
};

/**
 * The own-key outputs of a PSBT, classified by the caller that independently verified them:
 * `change` maps script hex to nothing — it is hidden from the prompt; `unusual` maps script hex to
 * the output's `m/…` path text — it is shown as an outflow to the caller's own address;
 * `unconfirmed` holds script hexes whose key sits on an entry the signer never confirmed on the
 * device — shown as a plain send with a danger warning, never as "your own address"; an internal
 * request's discoverable unconfirmed output still raises the mark, which only widens the wallet's
 * own scan.
 */
export type BitcoinOwn = {
  readonly change: ReadonlySet<string>;
  readonly unusual: ReadonlyMap<string, string>;
  readonly unconfirmed: ReadonlySet<string>;
};

export const EMPTY_BITCOIN_OWN: BitcoinOwn = {
  change: new Set(),
  unusual: new Map(),
  unconfirmed: new Set(),
};

/**
 * An output is discoverable change only on the change chain (`/1/i`), under a purpose at least one
 * signed input shares, at an index inside what the gap-limited scan reaches: the sealed change mark
 * `mark` plus the gap limit, bounded by the scan limit. `mark` is always the kernel-sealed value —
 * signed inputs never widen it.
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
