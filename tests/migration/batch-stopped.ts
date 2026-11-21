import type { SolanaSignResult } from "@qntx/wallet-engine";

/**
 * A sign-and-send batch that stops part-way reports `stopped`, replacing `refused`: `index` is the
 * input that did not go out and `error` is why. `reason` is `"refused"` only when the node itself
 * rejected that input's bytes — it and every later input were not sent — while `"not-sent"` means a
 * local failure kept it from being broadcast at all. The ids already submitted stay on `signatures`
 * (Solana) or `txids` (Bitcoin) — never resubmit them.
 */
export function stoppedAt(result: SolanaSignResult): number | undefined {
  if (result.kind !== "solana.transactions") {
    return undefined;
  }
  // @ts-expect-error -- `refused` is renamed `stopped` and carries a `reason`
  void result.refused;
  return result.stopped?.index;
}

/** The page-facing text for a stopped batch: name the cause, list what already went out. */
export function describeStopped(result: SolanaSignResult): string | undefined {
  if (result.kind !== "solana.transactions" || result.stopped === undefined) {
    return undefined;
  }
  const { index, reason, error } = result.stopped;
  const sent = (result.signatures ?? []).join(", ");
  return reason === "refused"
    ? `the network refused transaction ${index}: ${error}; already submitted: ${sent}`
    : `transaction ${index} was not sent: ${error}; already submitted: ${sent}`;
}
