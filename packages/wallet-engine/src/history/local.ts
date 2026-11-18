import { base64 } from "@scure/base";

import { decodeSolanaTransaction } from "@qntx/wallet-chains/solana";

import type { TrackedTransaction, TxState } from "../transactions/route.ts";
import type { HistoryChange, HistoryEntry, HistoryFlag, HistoryStatus } from "./types.ts";

/** The group's own addresses by family, resolved by the controller at load time. */
export type GroupAddresses = {
  evm?: string;
  solana?: string;
  /** Every scanned own Bitcoin address — the set grows while the Bitcoin source runs. */
  readonly bitcoin: Set<string>;
};

export type HistoryGroup = {
  readonly walletId: string;
  readonly groupIndex: number;
};

const SKIP_STATES: ReadonlySet<TxState> = new Set(["draft", "rejected"]);

const LOCAL_STATUS: Readonly<Record<string, HistoryStatus>> = {
  signed: "pending",
  submitted: "pending",
  pending: "pending",
  confirmed: "confirmed",
  failed: "failed",
  dropped: "dropped",
  replaced: "replaced",
};

const belongs = (tx: TrackedTransaction, group: HistoryGroup, own: GroupAddresses): boolean => {
  if (tx.account !== group.walletId || tx.hash === undefined || SKIP_STATES.has(tx.state)) {
    return false;
  }
  if (tx.family === "evm") {
    return own.evm !== undefined && tx.evm?.from.toLowerCase() === own.evm.toLowerCase();
  }
  if (tx.family === "solana") {
    if (own.solana === undefined || tx.raw === undefined) {
      return false;
    }
    try {
      decodeSolanaTransaction(base64.decode(tx.raw), own.solana);
      return true;
    } catch {
      return false;
    }
  }
  // bitcoin
  return tx.btc?.inputs.some((input) => own.bitcoin.has(input.address)) === true;
};

const ownAddress = (own: GroupAddresses, address: string): boolean =>
  address.toLowerCase() === own.evm?.toLowerCase() ||
  address === own.solana ||
  own.bitcoin.has(address);

/**
 * The group's tracked send as a history entry: present the moment it is signed, `pending` until the
 * chain read it. `verified` is false — the local record is this wallet's own claim.
 */
export const localEntry = (
  tx: TrackedTransaction,
  group: HistoryGroup,
  own: GroupAddresses,
): HistoryEntry | undefined => {
  if (!belongs(tx, group, own)) {
    return undefined;
  }
  const outflows = tx.intent?.outflows ?? [];
  const changes: HistoryChange[] = outflows.map((flow) => ({
    direction: "out",
    asset: flow.amount.asset,
    amount: flow.amount.amount,
    ...(flow.amount.decimals === undefined ? {} : { decimals: flow.amount.decimals }),
    ...(flow.amount.symbol === undefined ? {} : { symbol: flow.amount.symbol }),
    ...(flow.amount.tokenId === undefined ? {} : { tokenId: flow.amount.tokenId }),
    listed: flow.verified,
  }));
  const flags: HistoryFlag[] = [];
  if (changes.some((change) => change.amount === "0")) {
    flags.push("zero-value-transfer");
  }
  return {
    id: `${tx.network}:${tx.hash ?? ""}`,
    family: tx.family,
    network: tx.network,
    hash: tx.hash ?? "",
    direction: changes.length === 0 ? "self" : "out",
    counterparties: [
      ...new Set(outflows.map((flow) => flow.to).filter((to) => !ownAddress(own, to))),
    ].slice(0, 100),
    changes,
    ...(tx.family === "bitcoin" && tx.btc !== undefined ? { fee: String(tx.btc.fee) } : {}),
    status: LOCAL_STATUS[tx.state] ?? "pending",
    timestamp: tx.submittedAt,
    verified: false,
    origin: "local",
    flags,
    localTxId: tx.id,
  };
};
