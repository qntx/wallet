import type { FeeModel, GasPricing, NetworkInfo } from "@qntx/wallet-engine";

/** What a network charges beyond execution gas: nothing, an L1 data fee, or data plus operator fee. */
export function describeExtraFee(
  network: NetworkInfo,
): "none" | "l1-data" | "l1-data-and-operator" {
  const model: FeeModel | undefined = network.feeModel;
  switch (model?.kind) {
    case "scroll":
      return "l1-data";
    case "op-stack":
      return model.operatorFee ? "l1-data-and-operator" : "l1-data";
    default:
      return "none";
  }
}

/** Chains priced "legacy" sign a type-0 transaction at eth_gasPrice; EIP-1559 chains use fee caps. */
export function buildsLegacy(network: NetworkInfo): boolean {
  const pricing: GasPricing = network.feeModel?.pricing ?? "eip1559";
  return pricing === "legacy";
}
