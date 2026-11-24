/**
 * The hyperliquid-l1-agent meter: every value-moving action a session signs is charged against the
 * approved limits — an order's notional (p × s, a trigger order at max(p, triggerPx)) accumulates
 * into the record's `spent`, `updateLeverage` respects the cap, and every charged action's asset
 * must sit in the limits' allow-list. Cancels are free and need no allow-list membership: they
 * release nothing and move no value.
 */
import type {
  HyperliquidAgentLimits,
  HyperliquidL1Order,
  HyperliquidL1Params,
} from "@qntx/wallet/protocol";

import { DECIMAL_SCALE, decimalToUnits, unitsToDecimal } from "../../../../decimal.ts";
import { KernelError } from "../../../../errors.ts";

/** The notional of one order in 1e-16 units — a trigger order is charged at its worse price. */
const orderNotional = (order: HyperliquidL1Order): bigint => {
  let price = decimalToUnits(order.p);
  if ("trigger" in order.t) {
    const trigger = decimalToUnits(order.t.trigger.triggerPx);
    if (trigger > price) {
      price = trigger;
    }
  }
  return (price * decimalToUnits(order.s)) / DECIMAL_SCALE;
};

const inAllowList = (limits: HyperliquidAgentLimits, asset: number): void => {
  if (!limits.assets.includes(asset)) {
    throw new KernelError("limit-exceeded", "the asset is outside the session's allow-list");
  }
};

/**
 * The session's new `spent` after this action — or KernelError `limit-exceeded` when the signature
 * would exceed the approved budget. `spent` is the record's current value; the exact boundary
 * `spent + notional == notional limit` still signs.
 */
export function meterHyperliquid(
  params: HyperliquidL1Params,
  limits: HyperliquidAgentLimits,
  spent: string,
): string {
  const { action } = params;
  let charge = 0n;
  switch (action.type) {
    case "order":
      for (const order of action.orders) {
        inAllowList(limits, order.a);
        charge += orderNotional(order);
      }
      break;
    case "modify":
      inAllowList(limits, action.order.a);
      charge = orderNotional(action.order);
      break;
    case "batchModify":
      for (const entry of action.modifies) {
        inAllowList(limits, entry.order.a);
        charge += orderNotional(entry.order);
      }
      break;
    case "updateLeverage":
      inAllowList(limits, action.asset);
      if (action.leverage > limits.maxLeverage) {
        throw new KernelError("limit-exceeded", "leverage is above the session's cap");
      }
      break;
    case "updateIsolatedMargin":
      inAllowList(limits, action.asset);
      break;
    case "cancel":
    case "cancelByCloid":
    case "scheduleCancel":
    case "twapCancel":
      /* Free actions: nothing is charged and no asset check applies — refusing a cancel because
         its asset is outside the list would trap the user into an unwanted position. */
      break;
  }
  const next = decimalToUnits(spent) + charge;
  if (next > decimalToUnits(limits.notional)) {
    throw new KernelError("limit-exceeded", "the session's notional budget is exhausted");
  }
  return unitsToDecimal(next);
}
