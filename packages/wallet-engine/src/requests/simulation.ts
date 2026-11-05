import { errorMessage } from "../errors.ts";

/** Simulation result shapes, in a leaf module so routes and the request controller share them. */
export type AssetChange = {
  /** Same ids as `DisplayIntent`: EVM `native` or a token address; Solana `lamports` or a mint. */
  readonly asset: string;
  /** Signed decimal in the smallest unit; negative is an outflow. */
  readonly amount: string;
  readonly decimals?: number;
  readonly symbol?: string;
  /** True only when `decimals` and `symbol` come from the built-in token table. */
  readonly verified: boolean;
};

export type SimulationOutcome =
  | { readonly status: "success"; readonly changes: ReadonlyArray<AssetChange> }
  | { readonly status: "reverted"; readonly error: string }
  | { readonly status: "unavailable"; readonly error: string };

export const SIMULATION_TIMEOUT_MS = 10_000;

/** Asset ids compare by string, case-insensitively for EVM `0x` addresses. */
export const sameAsset = (a: string, b: string): boolean =>
  a === b || (a.startsWith("0x") && a.toLowerCase() === b.toLowerCase());

/** An asset amount that moved by more than this share of the old one is a changed simulation. */
export const SIMULATION_CHANGE_PERCENT = 5n;

const covers = (changes: ReadonlyArray<AssetChange>, other: ReadonlyArray<AssetChange>): boolean =>
  changes.every((c) => other.some((o) => sameAsset(o.asset, c.asset)));

const total = (changes: ReadonlyArray<AssetChange>, asset: string): bigint =>
  changes.filter((c) => sameAsset(c.asset, asset)).reduce((sum, c) => sum + BigInt(c.amount), 0n);

/**
 * Whether a re-simulation differs enough from the first outcome to be shown again: a different
 * status, an asset appearing or disappearing, or an amount that moved by more than
 * {@link SIMULATION_CHANGE_PERCENT} percent of the old one. Two outcomes failing or missing the
 * same way count as unchanged.
 */
export function simulationChanged(before: SimulationOutcome, after: SimulationOutcome): boolean {
  if (before.status !== after.status) {
    return true;
  }
  if (before.status !== "success" || after.status !== "success") {
    return false;
  }
  if (!covers(before.changes, after.changes) || !covers(after.changes, before.changes)) {
    return true;
  }
  return before.changes.some(({ asset }) => {
    const prior = total(before.changes, asset);
    const next = total(after.changes, asset);
    const diff = prior > next ? prior - next : next - prior;
    const base = prior < 0n ? -prior : prior;
    return diff * 100n > base * SIMULATION_CHANGE_PERCENT;
  });
}

const noop = (): void => undefined;

/**
 * Runs a simulation under the 10 s bound of the injected timer. A throw from `run` and the timeout
 * are `unavailable`; the timer is always cancelled.
 */
export async function boundedSimulation(
  run: () => Promise<SimulationOutcome>,
  setTimer: (ms: number, fn: () => unknown) => () => void,
): Promise<SimulationOutcome> {
  const stopTimer: { cancel: () => void } = { cancel: noop };
  const timeout = new Promise<SimulationOutcome>((resolve) => {
    stopTimer.cancel = setTimer(SIMULATION_TIMEOUT_MS, () => {
      resolve({ status: "unavailable", error: "timeout" });
    });
  });
  const bounded = async (): Promise<SimulationOutcome> => {
    try {
      return await run();
    } catch (error) {
      return { status: "unavailable", error: errorMessage(error) };
    }
  };
  try {
    return await Promise.race([bounded(), timeout]);
  } finally {
    stopTimer.cancel();
  }
}
