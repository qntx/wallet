/* The scheme's meter — a signature is charged to the approved limits: each order's asset must sit
   in the allow-list and `s` accumulates into that asset's size meter — buys, sells and reduce-only
   alike, because the kernel cannot know a market price and a sell's `p` never bounds what it fills
   at; a BUY additionally charges max(p, triggerPx) × s into the notional meter. Cancels are free
   but allow-listed — an off-list cancel could strip stops on positions the session never approved;
   the main key can always cancel. Worst case of a stolen key: buys lose at most `notional`;
   sells/shorts dispose of at most `size` of each listed asset at any price the exchange accepts —
   its "too far from oracle"/"from reference price" band
   (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses) is
   unverified in magnitude and spot coverage, so the kernel relies on none; add the market risk of
   a position that size at the leverage cap. */
import type {
  HyperliquidAgentLimits,
  HyperliquidAgentSpent,
  HyperliquidL1Order,
  HyperliquidL1Params,
} from "@qntx/wallet/protocol";

import { DECIMAL_SCALE, decimalToUnits, unitsToDecimal } from "../../../../decimal.ts";
import { KernelError } from "../../../../errors.ts";

/** One order's buy charge in 1e-16 units — a trigger order is charged at its worse price. */
const orderNotional = (order: HyperliquidL1Order): bigint => {
  const trigger = "trigger" in order.t ? decimalToUnits(order.t.trigger.triggerPx) : 0n;
  const price = decimalToUnits(order.p);
  return ((trigger > price ? trigger : price) * decimalToUnits(order.s)) / DECIMAL_SCALE;
};

/** The limits slot of an asset, or KernelError `limit-exceeded` when it is not allow-listed. */
const slotOf = (limits: HyperliquidAgentLimits, asset: number): number => {
  const index = limits.assets.findIndex((entry) => entry.asset === asset);
  if (index === -1) {
    throw new KernelError("limit-exceeded", "the asset is outside the session's allow-list");
  }
  return index;
};

/**
 * The session's new `spent` after this action — or KernelError `limit-exceeded` when the signature
 * would exceed an approved budget. `spent` is the record's current parsed value; the exact boundary
 * `spent + charge == cap` still signs.
 */
export function meterHyperliquid(
  params: HyperliquidL1Params,
  limits: HyperliquidAgentLimits,
  spent: HyperliquidAgentSpent,
): HyperliquidAgentSpent {
  const { action } = params;
  const sizes = spent.size.map(decimalToUnits);
  const caps = limits.assets.map((entry) => decimalToUnits(entry.size));
  let notional = decimalToUnits(spent.notional);
  const charge = (order: HyperliquidL1Order): void => {
    const index = slotOf(limits, order.a);
    const size = (sizes[index] ?? 0n) + decimalToUnits(order.s);
    if (size > (caps[index] ?? 0n)) {
      throw new KernelError("limit-exceeded", "the asset's size budget is exhausted");
    }
    sizes[index] = size;
    if (order.b) {
      notional += orderNotional(order);
    }
  };
  switch (action.type) {
    case "order":
      for (const order of action.orders) {
        charge(order);
      }
      break;
    case "modify":
      charge(action.order);
      break;
    case "batchModify":
      for (const entry of action.modifies) {
        charge(entry.order);
      }
      break;
    case "updateLeverage":
      slotOf(limits, action.asset);
      if (action.leverage > limits.maxLeverage) {
        throw new KernelError("limit-exceeded", "leverage is above the session's cap");
      }
      break;
    case "cancel":
    case "cancelByCloid":
      for (const cancel of action.cancels) {
        slotOf(limits, "a" in cancel ? cancel.a : cancel.asset);
      }
      break;
    case "updateIsolatedMargin":
    case "twapCancel":
      slotOf(limits, "asset" in action ? action.asset : action.a);
      break;
  }
  if (notional > decimalToUnits(limits.notional)) {
    throw new KernelError("limit-exceeded", "the session's notional budget is exhausted");
  }
  return { notional: unitsToDecimal(notional), size: sizes.map(unitsToDecimal) };
}
