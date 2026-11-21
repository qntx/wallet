import type {
  AccountBalances,
  AccountRef,
  EngineOptions,
  GatewayConfig,
  GatewayScope,
  PendingRequest,
  TrackedTransaction,
  WalletEngine,
} from "@qntx/wallet-engine";

/**
 * TRON endpoints join `EngineOptions.rpc` like the other families: full-node HTTP base URLs,
 * ordered by preference — the engine appends `/wallet/*` and `/walletsolidity/*` itself.
 */
export const tronRpc: NonNullable<EngineOptions["rpc"]> = {
  "tron:728126428": ["https://api.trongrid.io"],
  "tron:3448148188": ["https://nile.trongrid.io"],
};

const account: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "tron.bip44",
};

/**
 * A TRON send goes through `requests.prepare` like every outflow. `PendingRequest.tronFee` is the
 * java-tron fee model — bandwidth source, activation charge, energy, expected and max burn — and
 * must be shown before approval.
 */
export async function sendTron(engine: WalletEngine, to: string, amount: bigint): Promise<string> {
  const pending = await engine.requests.prepare({
    method: "send",
    account,
    network: "tron:728126428",
    to,
    amount,
    fee: "normal",
  });
  return quoteForApproval(pending);
}

/** The fee block the approval screen renders for a TRON request. */
export function quoteForApproval(request: PendingRequest): string {
  const quote = request.tronFee;
  if (quote === undefined) {
    return "no tron fee";
  }
  return `expected ${quote.expected} sun, max ${quote.max} sun (${
    quote.warnings.join(", ") || "no warnings"
  })`;
}

/** `tron-stake` carries one java-tron actuator action — here a 10 TRX freeze for energy. */
export async function freezeEnergy(engine: WalletEngine): Promise<string> {
  const pending = await engine.requests.prepare({
    method: "tron-stake",
    account,
    network: "tron:728126428",
    action: { kind: "freeze", amount: 10_000_000n, resource: "energy" },
  });
  return pending.id;
}

/** `TrackedTransaction["family"]` gained `"tron"` — hosts switching on it must add the case. */
// eslint-disable-next-line typescript/consistent-return -- the switch is exhaustive; a new family fails typecheck
export function familyLabel(tx: TrackedTransaction): string {
  switch (tx.family) {
    case "evm":
      return "EVM";
    case "solana":
      return "Solana";
    case "bitcoin":
      return "Bitcoin";
    case "tron":
      return "TRON";
  }
}

/**
 * `GatewayScope` gained `"tron"`: a host that constructs `GatewayConfig.clientIds` by hand now
 * needs a fifth client id — the engine draws one per scope so traffic cannot be joined.
 */
// eslint-disable-next-line typescript/consistent-return -- the switch is exhaustive; a new scope fails typecheck
export function scopeClientId(config: GatewayConfig, scope: GatewayScope): string {
  switch (scope) {
    case "evm":
      return config.clientIds.evm;
    case "solana":
      return config.clientIds.solana;
    case "bitcoin":
      return config.clientIds.bitcoin;
    case "tron":
      return config.clientIds.tron;
    case "service":
      return config.clientIds.service;
  }
}

export function manualClientIds(randomHex16: () => string): GatewayConfig["clientIds"] {
  return {
    evm: randomHex16(),
    solana: randomHex16(),
    bitcoin: randomHex16(),
    tron: randomHex16(), // new scope — omitting it no longer type-checks
    service: randomHex16(),
  };
}

/**
 * `AccountBalances.tron` is the account's resource view: frozen/unfreezing/delegated per resource,
 * votes, the claimable reward, bandwidth and energy counters, and TRON power.
 */
export function energyView(balances: AccountBalances): string {
  const { tron } = balances;
  if (tron === undefined) {
    return "no tron view";
  }
  return `frozen energy ${tron.frozen.energy} sun, unfreezing ${tron.unfreezing.length}`;
}

/**
 * `TronFeeQuote`'s availability fields are `bigint`, not `number` — java-tron answers int64 and
 * resource counters pass 2^53, so the quote keeps them exact.
 */
export function stakedBandwidthBefore(request: PendingRequest): number {
  // @ts-expect-error -- stakedAvailable is a bigint, not a number
  return request.tronFee?.bandwidth.stakedAvailable ?? 0;
}
export function stakedBandwidth(request: PendingRequest): string {
  const quote = request.tronFee;
  if (quote === undefined) {
    return "no tron fee";
  }
  return `staked bandwidth ${quote.bandwidth.stakedAvailable.toString(10)}, energy available ${
    quote.energy?.available.toString(10) ?? "0"
  }`;
}

/**
 * `TronAccountView` counters are decimal strings, not numbers — parse with `BigInt` for arithmetic;
 * they already render for display.
 */
export function energyLimitBefore(balances: AccountBalances): number {
  // @ts-expect-error -- energy.limit is a string, not a number
  return balances.tron?.energy.limit ?? 0;
}
export function energyLimit(balances: AccountBalances): bigint {
  const view = balances.tron;
  return view === undefined ? 0n : BigInt(view.energy.limit);
}
