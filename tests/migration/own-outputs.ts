import type { AssetFlow, IntentWarning } from "@qntx/wallet-chains";
/**
 * Own-key Bitcoin outputs (section 33): `decodeBitcoinPsbt` takes a `BitcoinOwn` — the script hexes
 * of the group's own outputs split into discoverable `change` and `unusual` — and reports an
 * unusual own output as a verified outflow with `AssetFlow.ownPath` plus an `unusual-own-output`
 * `IntentWarning`, which the engine surfaces as `bitcoin-unusual-output`. `BITCOIN_GAP_LIMIT` (20)
 * bounds what counts as discoverable change. Compiled only.
 */
import { EMPTY_BITCOIN_OWN } from "@qntx/wallet-chains/bitcoin";
import type { BitcoinOwn } from "@qntx/wallet-chains/bitcoin";

/** Build the `own` argument: script hexes that are change, and unusual ones with their paths. */
export function ownOutputs(
  change: ReadonlySet<string>,
  unusual: ReadonlyMap<string, string>,
): BitcoinOwn {
  return { change, unusual };
}

/** No own-key outputs in the PSBT — the same decode as before. */
export function noOwnOutputs(): BitcoinOwn {
  return EMPTY_BITCOIN_OWN;
}

/** An unusual own output is a shown outflow with `ownPath`, never hidden change. */
export function unusualRow(flow: AssetFlow): string {
  return flow.ownPath === undefined ? "counterparty output" : `own output at ${flow.ownPath}`;
}

/** Map the warning to UX: the funds arrive but the wallet may not display them. */
export function unusualWarning(warning: IntentWarning): string | undefined {
  return warning.kind === "unusual-own-output" ? warning.message : undefined;
}

/** The bound the kernel hides change under, and the decoder's new two-argument shape. */
export { BITCOIN_GAP_LIMIT, decodeBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
