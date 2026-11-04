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
