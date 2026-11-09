import { ChainError } from "@qntx/wallet-chains";
import { EVM_NATIVE_ASSET } from "@qntx/wallet-chains/evm";

import type { SimulationOutcome } from "../requests/simulation.ts";

export type AcrossBridgeQuote = {
  readonly provider: "across";
  readonly inputToken: string;
  readonly outputToken: string;
  readonly inputAmount: bigint;
  readonly outputAmount: bigint;
  readonly destinationNetwork: string;
  readonly quoteTimestamp: number;
  readonly fillDeadline: number;
  readonly exclusiveRelayer: string;
  readonly exclusivityParameter: number;
  readonly spokePool: string;
  readonly taker: string;
  readonly fetchedAt: number;
};

/** The deposit status Across reports for an origin transaction — display only. */
export type AcrossBridgeStatus = {
  readonly status: "pending" | "filled" | "expired" | "refunded" | "failed" | "unknown";
  readonly fillTxHash?: string;
};

/**
 * Asserts the origin-chain simulation keeps the deposit's terms: the input asset loses at most
 * `inputAmount` (plus the fee for a native deposit, whose gas pays in the same asset — the
 * simulation's native diff already includes it) and no other asset decreases. The destination leg
 * is invisible to an origin-chain simulation — the relayer fills it.
 */
export const assertBridgeSimulation = (
  quote: AcrossBridgeQuote,
  simulation: SimulationOutcome | undefined,
  gasCost: bigint,
): void => {
  if (simulation?.status !== "success") {
    throw new ChainError(
      "invalid-request",
      `the bridge simulation ${simulation?.status === "reverted" ? "reverted" : "is unavailable"}`,
    );
  }
  const total = (asset: string): bigint =>
    simulation.changes
      .filter((c) => c.asset.toLowerCase() === asset.toLowerCase())
      .reduce((sum, c) => sum + BigInt(c.amount), 0n);
  const nativeIn = quote.inputToken === EVM_NATIVE_ASSET;
  const floor = nativeIn ? -quote.inputAmount - gasCost : -gasCost;
  if (total(EVM_NATIVE_ASSET) < floor) {
    throw new ChainError("invalid-request", "the simulation loses more than the input amount");
  }
  if (!nativeIn && total(quote.inputToken) < -quote.inputAmount) {
    throw new ChainError("invalid-request", "the simulation loses more than the input amount");
  }
  for (const change of simulation.changes) {
    if (
      change.asset.toLowerCase() !== quote.inputToken.toLowerCase() &&
      change.asset !== EVM_NATIVE_ASSET &&
      BigInt(change.amount) < 0n
    ) {
      throw new ChainError("invalid-request", "the simulation loses an unrelated asset");
    }
  }
};
