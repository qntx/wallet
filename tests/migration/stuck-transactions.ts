import type { TrackedTransaction } from "@qntx/wallet-engine";

export type StuckRemedy = "speed-up" | "cancel";

/**
 * A transaction the network does not know is never declared `dropped` by a timer anymore: EVM and
 * Bitcoin keep it `submitted`, still holding its nonce or inputs, and mark it `stuck` once no
 * endpoint has known it for thirty minutes — the moment to offer `speed-up` or `cancel`, not to
 * send again. `dropped` now only comes from a proof: the nonce or an input consumed without the
 * transaction landing, or an expiry a chain enforces (TRON `raw_data.expiration`, Solana blockhash
 * / durable nonce — proof-based as before). A row recovered from a broadcast whose outcome never
 * settled carries `rebroadcast: false`: the wallet watches it but never resends those bytes — the
 * remedies below are the way out there too.
 */
export function remediesOf(tx: TrackedTransaction): StuckRemedy[] {
  const familyHasRemedies = tx.family === "evm" || tx.family === "bitcoin";
  return familyHasRemedies && tx.state === "submitted" && tx.stuck === true
    ? ["speed-up", "cancel"]
    : [];
}

/**
 * Display text for a live transaction: `stuck` rows carry the tracker's own note in `error`;
 * anything else submitted is just pending.
 */
export function liveNote(tx: TrackedTransaction): string | undefined {
  return tx.state === "submitted" ? tx.error : undefined;
}
