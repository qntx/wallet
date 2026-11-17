/**
 * How well a backup password resists guessing. The backup envelope leaves the device, so its
 * password is attacked offline with no rate limit; Argon2id makes each guess expensive, and this
 * estimate keeps the number of guesses an attacker needs out of reach. The estimator and its
 * dictionaries load on first use and stay out of the engine's initial bundle.
 */

/** Zxcvbn's top score: at least 10^10 guesses. */
const REQUIRED_SCORE = 4;

export type BackupPasswordStrength = {
  /** 0 (trivially guessed) to 4 (at least 10^10 guesses). */
  readonly score: 0 | 1 | 2 | 3 | 4;
  /** Whether `backup.enable` accepts the password. */
  readonly acceptable: boolean;
};

export async function backupPasswordStrength(password: string): Promise<BackupPasswordStrength> {
  const [{ ZxcvbnFactory }, common] = await Promise.all([
    import("@zxcvbn-ts/core"),
    import("@zxcvbn-ts/language-common"),
  ]);
  const estimator = new ZxcvbnFactory({
    dictionary: common.dictionary,
    graphs: common.adjacencyGraphs,
  });
  const { score } = estimator.check(password);
  return { score, acceptable: score >= REQUIRED_SCORE };
}
