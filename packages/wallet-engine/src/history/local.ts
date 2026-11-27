import { base64 } from "@scure/base";

import { decodeSolanaTransaction } from "@qntx/wallet-chains/solana";

import type { TrackedTransaction, TxState } from "../transactions/route.ts";
import type { HistoryChange, HistoryEntry, HistoryFlag, HistoryStatus } from "./types.ts";

/** The group's own addresses by family, resolved by the controller at load time. */
export type GroupAddresses = {
  evm?: string;
  solana?: string;
  tron?: string;
  /**
   * The scanned own Bitcoin address parties — confirmed templates share the first, each unconfirmed
   * template its own — appended while the Bitcoin source runs.
   */
  readonly bitcoin: Array<Set<string>>;
  /**
   * The own addresses a device-unconfirmed entry serves — material the device never confirmed
   * on-screen. They stay own for local-send membership (a send to one is still not self), and they
   * stay lookalike references so a counterparty imitating one keeps its poisoning flag — but they
   * never vouch for themselves: the exempt set takes only confirmed material.
   */
  readonly unconfirmed: Set<string>;
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

/** The own-address party a send's inputs sit in — the view its counterparties are read from. */
const bitcoinParty = (tx: TrackedTransaction, own: GroupAddresses): Set<string> | undefined =>
  own.bitcoin.find((party) => tx.btc?.inputs.some((input) => party.has(input.address)) === true);

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
  if (tx.family === "tron") {
    return own.tron !== undefined && tx.tron?.from === own.tron;
  }
  // bitcoin
  return bitcoinParty(tx, own) !== undefined;
};

/**
 * `to` is own when it sits in the party the send was computed from — a send to an address of
 * another party (a key the device never confirmed) is a counterparty, never self.
 */
const ownAddress = (
  own: GroupAddresses,
  address: string,
  party: Set<string> | undefined,
): boolean =>
  address.toLowerCase() === own.evm?.toLowerCase() ||
  address === own.solana ||
  address === own.tron ||
  party?.has(address) === true;

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
  const party = tx.family === "bitcoin" ? bitcoinParty(tx, own) : undefined;
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
      ...new Set(outflows.map((flow) => flow.to).filter((to) => !ownAddress(own, to, party))),
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
