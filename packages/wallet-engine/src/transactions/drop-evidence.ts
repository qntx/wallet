/**
 * Corroboration state for a terminal `dropped`/`reorged` proof that has no host endpoint: the first
 * poll observing the ending condition starts the streak, `since` marks when it began. Any poll that
 * does not observe it — an inclusion, an unfinished proof, a failed read — clears the row.
 */
export type DropEvidence = Map<string, { since: number; polls: number }>;

/** Polls corroborating a `dropped`/`reorged` proof without a host endpoint. */
const DROP_POLLS = 3;

/**
 * One poll observing the ending condition: returns whether it completes the proof. Without a host
 * endpoint the same single-upstream picture must hold for `DROP_POLLS` consecutive polls spanning
 * more than `spanMs` — so the answering upstream cannot merely lag behind a chain that knows the
 * transaction.
 */
export const corroborated = (
  now: number,
  evidence: DropEvidence,
  id: string,
  spanMs: number,
): boolean => {
  const streak = evidence.get(id) ?? { since: now, polls: 0 };
  streak.polls += 1;
  evidence.set(id, streak);
  return streak.polls >= DROP_POLLS && now - streak.since > spanMs;
};
