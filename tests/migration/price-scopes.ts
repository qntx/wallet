import { PRICE_FAMILIES, priceAssetFamily, pricesPath } from "@qntx/wallet-engine/gateway/contract";
import type { PriceFamily } from "@qntx/wallet-engine/gateway/contract";

/**
 * A proxy or allow-list in front of the gateway forwards one price route per chain family; the
 * single `POST /v1/prices` route is gone.
 */
export const priceRoutes: ReadonlyArray<string> = PRICE_FAMILIES.map((family) =>
  pricesPath(family),
);

/**
 * A client that asks for prices itself sends one request per family, each under that family's own
 * client id; the gateway refuses a body naming another family's asset with `400 invalid-request`.
 */
export function priceBatches(assets: ReadonlyArray<string>): ReadonlyMap<PriceFamily, string[]> {
  const batches = new Map<PriceFamily, string[]>();
  for (const asset of assets) {
    const family = priceAssetFamily(asset);
    if (family !== undefined) {
      batches.set(family, [...(batches.get(family) ?? []), asset]);
    }
  }
  return batches;
}
