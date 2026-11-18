import type { FiatCurrency, Valuation, WalletEngine } from "@qntx/wallet-engine";

/** Prices poll only while the host says it is visible; wire it to the app's foreground state. */
export function followVisibility(
  engine: WalletEngine,
  onVisibilityChange: (listener: (visible: boolean) => void) => () => void,
): () => void {
  engine.prices.setVisible(true);
  return onVisibilityChange((visible) => {
    engine.prices.setVisible(visible);
  });
}

/** The quote currency is persisted per vault; switching drops every quote and refetches. */
export async function chooseCurrency(engine: WalletEngine, currency: FiatCurrency): Promise<void> {
  await engine.prices.setCurrency(currency);
}

/** Exact decimal strings: format them for display, never parse them into floats for arithmetic. */
export async function groupTotal(
  engine: WalletEngine,
  group: { readonly walletId: string; readonly groupIndex: number },
): Promise<{ readonly total: string; readonly partial: boolean }> {
  const valuation: Valuation = await engine.portfolio.group(group);
  return { total: valuation.total, partial: valuation.stale || valuation.unpriced > 0 };
}
