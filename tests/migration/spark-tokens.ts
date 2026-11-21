import type { VerifyFactor } from "@qntx/wallet";
import type {
  SparkPaymentRecord,
  SparkPaymentState,
  SparkResult,
  SparkTokenBalance,
  WalletEngine,
} from "@qntx/wallet-engine";
import { requiredAcknowledgement } from "@qntx/wallet-engine";
import type { SparkAccountRef } from "@qntx/wallet/spark";

/** Token balances in base units, refreshed with the account; absent until the first read. */
export function tokenBalances(
  engine: WalletEngine,
  ref: SparkAccountRef,
): ReadonlyArray<SparkTokenBalance> {
  const key = `${ref.walletId}:${String(ref.groupIndex)}:${ref.network}`;
  return engine.spark.getState().accounts[key]?.tokens ?? [];
}

/** A token payment is a `pay` request to a plain Spark address, without `amountSats`. */
export async function payToken(
  engine: WalletEngine,
  account: SparkAccountRef,
  address: string,
  token: { readonly identifier: string; readonly amount: bigint },
  verify: VerifyFactor,
): Promise<SparkResult> {
  const request = await engine.requests.prepare({
    method: "pay",
    account,
    option: { kind: "spark", address },
    token,
  });
  return engine.requests.approve(request.id, "pay", {
    verify,
    acknowledged: requiredAcknowledgement(request),
  });
}

/**
 * `pending` means the response was lost after the payment may have committed: show it as in flight,
 * never as failed, and never pay again.
 */
export function describeSparkResult(result: SparkResult): "done" | "in-flight" {
  return result.kind === "pending" ? "in-flight" : "done";
}

/** The engine keeps following a pending payment: its record settles or fails in the account state. */
export function paymentState(
  engine: WalletEngine,
  ref: SparkAccountRef,
  payment: SparkPaymentRecord,
): SparkPaymentState | undefined {
  const key = `${ref.walletId}:${String(ref.groupIndex)}:${ref.network}`;
  return engine.spark.getState().accounts[key]?.payments?.[payment.id]?.state;
}

/**
 * Paying a Bitcoin address from Spark (cooperative exit): `amountSats` is what arrives, the exit
 * debits `amountSats + feeSats`, and `maxFeeSats` is required — a higher quote is refused at
 * prepare.
 */
export async function prepareExit(
  engine: WalletEngine,
  account: SparkAccountRef,
  address: string,
  amountSats: number,
  maxFeeSats: number,
): Promise<number | undefined> {
  const request = await engine.requests.prepare({
    method: "pay",
    account,
    option: { kind: "bitcoin", address },
    amountSats,
    maxFeeSats,
  });
  const { display } = request;
  return "feeSats" in display ? display.feeSats : undefined;
}
