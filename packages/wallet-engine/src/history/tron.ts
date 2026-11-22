/**
 * TRON history: the TronGrid-style indexer feeds (`/v1/accounts/transactions`,
 * `/v1/accounts/transactions/trc20`) are display-only claims — every entry is cross-checked against
 * `gettransactionbyid`/`gettransactioninfobyid` on an independent host when one is configured, and
 * marked `verified` only then. Poisoning defence: the indexer reports dust/zero TRC-20 transfers
 * from look-alike senders verbatim (TronLink's guidance at
 * https://support.tronlink.org/hc/en-us/articles/33319978680729, and SlowMist's zero-value
 * `transferFrom` report via https://tronorigin.io/learn/fake-usdt-and-drainers/), so legs carry
 * zero-value, impersonation and suspicious-symbol flags and only node-verified data is trusted.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  decodeTronContract,
  decodeTronRawData,
  isTronAddress,
  lookupTronToken,
  tronAddressFromHex,
  tronTokenTable,
} from "@qntx/wallet-chains/tron";
import type { TronContract } from "@qntx/wallet-chains/tron";

import { mapPool } from "../assets/tron.ts";
import type { TronApi } from "../chains/tron.ts";
import { transactionById, transactionInfo, tronLogAddress } from "../chains/tron.ts";
import {
  parseWith,
  tronBasePath,
  tronIndexerPageResponse,
  tronIndexerTransaction,
  tronIndexerTrc20,
} from "../gateway/contract/index.ts";
import type {
  TronIndexerPath,
  TronIndexerTransactionRow,
  TronLog,
} from "../gateway/contract/index.ts";
import type { NetworkController } from "../networks/controller.ts";
import { timeoutSignal } from "../timer.ts";
import type { SetTimer } from "../timer.ts";
import { tronTokenFlags } from "./flags.ts";
import type { Stream } from "./merge.ts";
import type { HistoryChange, HistoryEntry, HistoryFlag } from "./types.ts";

const PAGE_LIMIT = 25;
const REQUEST_TIMEOUT_MS = 10_000;
const VERIFY_CONCURRENCY = 4;

/** Keccak("Transfer(address,address,uint256)") — TRC-20 logs pin transfers by topic 0. */
const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type TronHistoryDeps = {
  readonly gateway: { readonly url: string; readonly fetch: typeof globalThis.fetch };
  readonly networks: Pick<NetworkController, "tronApi" | "independentTronApi">;
  readonly setTimer: SetTimer;
};

/** One indexer-claimed transfer leg. Addresses are canonical `T…` base58. */
type Leg =
  | { readonly kind: "trx"; readonly from: string; readonly to: string; readonly amount: bigint }
  | {
      readonly kind: "trc10";
      readonly from: string;
      readonly to: string;
      readonly assetId: string;
      readonly amount: bigint;
    }
  | {
      readonly kind: "trc20";
      readonly from: string;
      readonly to: string;
      readonly contract: string;
      readonly amount: bigint;
      readonly symbol: string | undefined;
      readonly decimals: number | undefined;
    };

/** A txid's merged claim: legs from both feeds plus the provider's block. */
type Group = {
  readonly txid: string;
  readonly timestamp: number;
  block: number | undefined;
  legs: Leg[];
};

/** A parsed feed row; `legs` empty means filtered — a contract type history ignores. */
type ParsedRow = {
  readonly txid: string;
  readonly timestamp: number;
  readonly block: number | undefined;
  readonly legs: Leg[];
};

/**
 * One feed's paging state. A group is emit-ready for this feed once the feed is exhausted or has
 * fetched strictly below the group's timestamp — an equal timestamp could still add rows on the
 * next page.
 */
type Feed = {
  readonly path: TronIndexerPath;
  readonly parse: (raw: unknown) => ParsedRow | "malformed";
  fingerprint: string | undefined;
  fetched: boolean;
  done: boolean;
  /** Smallest block_timestamp the feed has returned; rows below it can no longer join a group. */
  oldest: number;
};

const hexBytesOf = (hex: string): Uint8Array | undefined => {
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) {
    return undefined;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/** `41…` hex → canonical base58; `undefined` on anything malformed. */
const base58FromHex = (hex: string | undefined): string | undefined => {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{42}$/.test(hex)) {
    return undefined;
  }
  try {
    return tronAddressFromHex(hex.toLowerCase());
  } catch {
    return undefined;
  }
};

/**
 * A TRC-10 id the node renders as `asset_name`: the decimal id itself, or the proto string's hex
 * encoding whose UTF-8 bytes are the id ("31303032303030" → "1002000").
 */
const assetIdOf = (name: string | undefined): string | undefined => {
  if (name === undefined) {
    return undefined;
  }
  if (/^\d+$/.test(name)) {
    return name;
  }
  const bytes = hexBytesOf(name);
  if (bytes !== undefined) {
    const decoded = new TextDecoder().decode(bytes);
    return /^\d+$/.test(decoded) ? decoded : undefined;
  }
  return undefined;
};

/**
 * A `/v1/accounts/transactions` row → a `ParsedRow`; `"malformed"` when the schema or the transfer
 * fields fail. Non-transfer contract types stay valid rows (their timestamp still bounds paging)
 * with `leg === undefined`.
 */
const parseTxRow = (raw: unknown): ParsedRow | "malformed" => {
  const row = parseWith(tronIndexerTransaction, raw);
  if (row === undefined) {
    return "malformed";
  }
  const legs = txRowLegs(row);
  if (legs === "malformed") {
    return "malformed";
  }
  return { txid: row.txID, timestamp: row.block_timestamp, block: row.blockNumber, legs };
};

/** The transfer legs of one `/v1/accounts/transactions` row, `[]` for unmodeled types. */
const txRowLegs = (row: TronIndexerTransactionRow): Leg[] | "malformed" => {
  const contracts = row.raw_data.contract;
  if (contracts.length !== 1) {
    return [];
  }
  const [contract] = contracts;
  if (contract === undefined) {
    return [];
  }
  const { type, parameter } = contract;
  const { value } = parameter;
  if (type === "TransferContract" || type === "TransferAssetContract") {
    const from = base58FromHex(value.owner_address);
    const to = base58FromHex(value.to_address);
    if (from === undefined || to === undefined || value.amount === undefined) {
      return "malformed";
    }
    // The node reports JSON int64 imprecisely beyond 2^53 — the documented `amountField` limit.
    const amount = BigInt(value.amount);
    if (type === "TransferContract") {
      return [{ kind: "trx", from, to, amount }];
    }
    const assetId = assetIdOf(value.asset_name);
    if (assetId === undefined) {
      return "malformed";
    }
    return [{ kind: "trc10", from, to, assetId, amount }];
  }
  if (type === "TriggerSmartContract") {
    /* The row's value movements are the attached assets: `call_value` TRX and a
       `call_token_value` TRC-10 amount into the contract. */
    const { call_value: callValue, call_token_value: callTokenValue, token_id: tokenId } = value;
    const movesTrx = callValue !== undefined && BigInt(callValue) > 0n;
    const movesToken = callTokenValue !== undefined && BigInt(callTokenValue) > 0n;
    if (!movesTrx && !movesToken) {
      return [];
    }
    const from = base58FromHex(value.owner_address);
    const to = base58FromHex(value.contract_address);
    if (from === undefined || to === undefined) {
      return "malformed";
    }
    const legs: Leg[] = [];
    if (movesTrx) {
      legs.push({ kind: "trx", from, to, amount: BigInt(callValue) });
    }
    if (movesToken) {
      if (tokenId === undefined) {
        return "malformed"; // a token amount without its id can never bind the raw contract
      }
      legs.push({
        kind: "trc10",
        from,
        to,
        assetId: String(tokenId),
        amount: BigInt(callTokenValue),
      });
    }
    return legs;
  }
  return [];
};

/** A `/v1/accounts/transactions/trc20` row → a `ParsedRow`; non-Transfer rows are filtered. */
const parseTrc20Row = (raw: unknown): ParsedRow | "malformed" => {
  const row = parseWith(tronIndexerTrc20, raw);
  if (row === undefined) {
    return "malformed";
  }
  let leg: Leg | "malformed" | undefined;
  if (row.type === "Transfer") {
    const contract = row.token_info.address;
    leg =
      !isTronAddress(row.from) ||
      !isTronAddress(row.to) ||
      contract === undefined ||
      !isTronAddress(contract) ||
      !/^\d+$/.test(row.value)
        ? "malformed"
        : {
            kind: "trc20",
            from: row.from,
            to: row.to,
            contract,
            amount: BigInt(row.value),
            symbol: row.token_info.symbol,
            decimals: row.token_info.decimals,
          };
  }
  if (leg === "malformed") {
    return "malformed";
  }
  return {
    txid: row.transaction_id,
    timestamp: row.block_timestamp,
    block: undefined,
    legs: leg === undefined ? [] : [leg],
  };
};

/**
 * A TRON transaction carries exactly one contract, so the same TRX/TRC-10 row repeated across a
 * page boundary is one claim, not two. TRC-20 legs stay uncollapsed on purpose: each claim binds
 * one Transfer log, and a duplicated row with only one log is a `chain-mismatch`, not a dup.
 */
const collapseLegs = (legs: ReadonlyArray<Leg>): Leg[] => {
  const seen = new Set<string>();
  const out: Leg[] = [];
  for (const leg of legs) {
    if (leg.kind === "trc20") {
      out.push(leg);
      continue;
    }
    const key =
      leg.kind === "trc10"
        ? `trc10:${leg.from}:${leg.to}:${leg.assetId}:${leg.amount.toString()}`
        : `trx:${leg.from}:${leg.to}:${leg.amount.toString()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(leg);
  }
  return out;
};

const ready = (feed: Feed, timestamp: number): boolean =>
  feed.done || (feed.fetched && timestamp < feed.oldest);

/** The claimed direction like evm.ts: in when it reaches `address`, out when it leaves. */
const directionOf = (changes: ReadonlyArray<HistoryChange>): HistoryEntry["direction"] => {
  const ins = changes.some((c) => c.direction === "in");
  const outs = changes.some((c) => c.direction === "out");
  if (ins && outs) {
    return "self";
  }
  return ins ? "in" : "out";
};

/** The indexer claim as a `HistoryEntry` — `verified: false` until the node proves it. */
const tronHistoryEntry = (network: string, address: string, group: Group): HistoryEntry => {
  const changes: HistoryChange[] = [];
  const counterparties: string[] = [];
  const flags: HistoryFlag[] = [];
  let zero = false;
  for (const leg of collapseLegs(group.legs)) {
    const ownIn = leg.to === address;
    const ownOut = leg.from === address;
    if (ownIn === ownOut) {
      continue;
    }
    const direction = ownIn ? ("in" as const) : ("out" as const);
    const counterparty = ownIn ? leg.from : leg.to;
    if (!counterparties.includes(counterparty)) {
      counterparties.push(counterparty);
    }
    if (leg.amount === 0n) {
      zero = true;
    }
    if (leg.kind === "trx") {
      changes.push({ direction, asset: "sun", amount: leg.amount.toString(), listed: true });
    } else if (leg.kind === "trc10") {
      changes.push({
        direction,
        asset: `trc10:${leg.assetId}`,
        amount: leg.amount.toString(),
        listed: false,
      });
    } else {
      const listed = lookupTronToken(tronTokenTable, network, leg.contract);
      const decimals = listed?.decimals ?? leg.decimals;
      const symbol = listed?.symbol ?? leg.symbol;
      changes.push({
        direction,
        asset: leg.contract,
        amount: leg.amount.toString(),
        ...(decimals === undefined ? {} : { decimals }),
        ...(symbol === undefined ? {} : { symbol }),
        listed: listed !== undefined,
      });
      flags.push(...tronTokenFlags(network, leg.contract, leg.symbol));
    }
  }
  if (zero) {
    flags.push("zero-value-transfer");
  }
  return {
    id: `${network}:${group.txid}`,
    family: "tron",
    network,
    hash: group.txid,
    direction: directionOf(changes),
    counterparties,
    changes,
    status: "confirmed",
    timestamp: group.timestamp,
    ...(group.block === undefined ? {} : { block: group.block }),
    verified: false,
    origin: "provider",
    flags,
  };
};

/** A TRC-20 Transfer log decoded, or `undefined` for other events. */
const transferLog = (
  log: TronLog,
):
  | {
      readonly contract: string;
      readonly from: string;
      readonly to: string;
      readonly amount: bigint;
    }
  | undefined => {
  const { topics } = log;
  const first = topics?.[0];
  if (topics === undefined || first !== TRANSFER_TOPIC || topics.length < 3) {
    return undefined;
  }
  const contract = tronLogAddress(log.address);
  const from = tronLogAddress(topics[1]?.slice(-40));
  const to = tronLogAddress(topics[2]?.slice(-40));
  if (contract === undefined || from === undefined || to === undefined) {
    return undefined;
  }
  if (log.data !== undefined && log.data !== "" && !/^[0-9a-fA-F]{1,64}$/.test(log.data)) {
    return undefined; // a non-hex data word is not a decodable Transfer — classify, never throw
  }
  return {
    contract,
    from,
    to,
    amount: BigInt(`0x${log.data === undefined || log.data === "" ? "0" : log.data}`),
  };
};

type TransferLog = NonNullable<ReturnType<typeof transferLog>>;

const sameTransfer = (leg: Extract<Leg, { kind: "trc20" }>, log: TransferLog): boolean =>
  leg.contract === log.contract &&
  leg.from === log.from &&
  leg.to === log.to &&
  leg.amount === log.amount;

/** One transfer leg against the decoded raw contract — the transfer types it can claim. */
const transferMatches = (leg: Leg, contract: TronContract): boolean => {
  if (leg.kind === "trx" && contract.type === "TransferContract") {
    return contract.owner === leg.from && contract.to === leg.to && contract.amount === leg.amount;
  }
  if (leg.kind === "trc10" && contract.type === "TransferAssetContract") {
    return (
      contract.owner === leg.from &&
      contract.to === leg.to &&
      contract.assetId === leg.assetId &&
      contract.amount === leg.amount
    );
  }
  if (contract.type === "TriggerSmartContract") {
    if (leg.kind === "trx") {
      return (
        contract.owner === leg.from &&
        contract.contract === leg.to &&
        contract.callValue === leg.amount
      );
    }
    if (leg.kind === "trc10") {
      return (
        contract.owner === leg.from &&
        contract.contract === leg.to &&
        contract.tokenId === BigInt(leg.assetId) &&
        contract.callTokenValue === leg.amount
      );
    }
  }
  return false;
};

/**
 * Prove or disprove the claim on `api`. `verified` needs every leg matched and `trusted`; a
 * contradiction is `chain-mismatch`, missing evidence leaves the entry claimed-but-unverified.
 */
const verifyEntry = async (
  api: TronApi,
  address: string,
  entry: HistoryEntry,
  group: Group,
  trusted: boolean,
): Promise<HistoryEntry> => {
  const [body, info] = await Promise.all([
    transactionById(api, group.txid).catch(() => undefined),
    transactionInfo(api, group.txid, false).catch(() => undefined),
  ]);
  if (info === undefined) {
    return entry;
  }
  let checkable = true;
  let mismatch = false;
  const signer = base58FromHex(body?.raw_data?.contract[0]?.parameter.value.owner_address);

  const legs = collapseLegs(group.legs);
  const transfers = legs.filter((leg) => leg.kind !== "trc20");
  const trc20s = legs.filter((leg): leg is Extract<Leg, { kind: "trc20" }> => {
    return leg.kind === "trc20";
  });
  /* An entry verifies only on the pinned, decoded body — the sha256 pin + the phase-1 decoder
     make the contract check byte-for-byte, not field-shaped, and the completeness check below
     needs the contract. A missing body or undecodable bytes leave the entry
     claimed-but-unverified; a body whose sha256 is not the txid is provably wrong, legs or not. */
  let contract: TronContract | undefined;
  const raw = body?.raw_data_hex === undefined ? undefined : hexBytesOf(body.raw_data_hex);
  if (raw === undefined) {
    checkable = false;
  } else if (bytesToHex(sha256(raw)) === group.txid) {
    try {
      const slot = decodeTronRawData(raw).contract;
      contract = decodeTronContract(slot.typeId, slot.value)?.contract;
    } catch {
      contract = undefined;
    }
    const decoded = contract;
    if (decoded === undefined) {
      checkable = false;
    } else if (!transfers.every((leg) => transferMatches(leg, decoded))) {
      // One raw contract binds at most one claim: a second distinct leg mismatches on `.every`.
      mismatch = true;
    }
  } else {
    mismatch = true; // the body is provably not this txid's
  }
  /* The reverse direction: the wallet's own TriggerSmartContract moved `call_value` TRX or a
     `call_token_value` TRC-10 amount — an indexer that never reported the movement hides an
     outflow. A failed transaction moves nothing, so the check skips it. */
  if (
    contract !== undefined &&
    contract.type === "TriggerSmartContract" &&
    contract.owner === address &&
    !info.failed
  ) {
    const trxBound =
      contract.callValue === 0n ||
      transfers.some((leg) => leg.kind === "trx" && transferMatches(leg, contract));
    const trc10Bound =
      contract.callTokenValue === 0n ||
      transfers.some((leg) => leg.kind === "trc10" && transferMatches(leg, contract));
    if (!trxBound || !trc10Bound) {
      mismatch = true;
    }
  }
  if (trc20s.length > 0) {
    const logs: TransferLog[] = [];
    for (const log of info.logs) {
      const decoded = transferLog(log);
      if (decoded !== undefined) {
        logs.push(decoded);
      }
    }
    const used = new Set<number>();
    for (const leg of trc20s) {
      const found = logs.findIndex((l, i) => !used.has(i) && sameTransfer(leg, l));
      if (found === -1) {
        mismatch = true;
      } else {
        used.add(found);
      }
    }
    // A Transfer log touching the wallet that the indexer never reported is a hidden leg.
    for (const l of logs) {
      const touches = (l.from === address) !== (l.to === address);
      if (touches && !trc20s.some((leg) => sameTransfer(leg, l))) {
        mismatch = true;
      }
    }
  }

  const flags: ReadonlyArray<HistoryFlag> = mismatch
    ? entry.flags.includes("chain-mismatch")
      ? entry.flags
      : [...entry.flags, "chain-mismatch"]
    : entry.flags;
  return {
    ...entry,
    status: info.failed ? "failed" : "confirmed",
    block: info.blockNumber,
    timestamp: info.blockTimestamp,
    ...(signer === address && info.fee > 0 ? { fee: info.fee.toString() } : {}),
    verified: !mismatch && checkable && trusted,
    flags,
  };
};

/**
 * One stream per network merging the two indexer feeds. Both page newest-first by
 * `meta.fingerprint`; a txid's legs can split across a page boundary, so a group is held until both
 * feeds have paged past its timestamp (or ended), then emitted as one entry.
 */
export const tronHistoryStream = (
  options: TronHistoryDeps,
  network: string,
  address: string,
  cached: ReadonlyMap<string, HistoryEntry>,
  onTruncated: () => void,
): Stream<HistoryEntry> & { readonly skipped: () => number } => {
  const base = `${options.gateway.url.replace(/\/+$/, "")}${tronBasePath(network)}`;
  const independent = options.networks.independentTronApi(network);
  const api =
    independent.kind === "available" ? independent.client : options.networks.tronApi(network);
  const trusted = independent.kind !== "unavailable";
  const groups = new Map<string, Group>();
  const feeds: Feed[] = [
    {
      path: "/v1/accounts/transactions",
      parse: parseTxRow,
      fingerprint: undefined,
      fetched: false,
      done: false,
      oldest: Number.POSITIVE_INFINITY,
    },
    {
      path: "/v1/accounts/transactions/trc20",
      parse: parseTrc20Row,
      fingerprint: undefined,
      fetched: false,
      done: false,
      oldest: Number.POSITIVE_INFINITY,
    },
  ];
  /** Rows that failed their schema — counted, never thrown: the indexer is untrusted input. */
  let skipped = 0;

  const fetchPage = async (feed: Feed, signal: AbortSignal): Promise<void> => {
    const res = await options.gateway.fetch(`${base}${feed.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address,
        limit: PAGE_LIMIT,
        ...(feed.fingerprint === undefined ? {} : { fingerprint: feed.fingerprint }),
      }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`history ${network} ${feed.path}: status ${res.status}`);
    }
    const page = parseWith(tronIndexerPageResponse, await res.json());
    if (page === undefined) {
      // A malformed page is a gap in the listing, not a reason to kill the whole stream.
      onTruncated();
      feed.done = true;
      return;
    }
    feed.fetched = true;
    for (const raw of page.data) {
      const parsed = feed.parse(raw);
      if (parsed === "malformed") {
        skipped += 1;
        continue;
      }
      feed.oldest = Math.min(feed.oldest, parsed.timestamp);
      if (parsed.legs.length === 0) {
        continue;
      }
      const group = groups.get(parsed.txid) ?? {
        txid: parsed.txid,
        timestamp: parsed.timestamp,
        block: parsed.block,
        legs: [],
      };
      group.legs.push(...parsed.legs);
      group.block = group.block ?? parsed.block;
      groups.set(parsed.txid, group);
    }
    feed.fingerprint = page.meta.fingerprint;
    if (feed.fingerprint === undefined || page.data.length === 0) {
      feed.done = true;
    }
  };

  /** A group emits once every feed has paged strictly below its timestamp or ended. */
  const emitReady = (): Group[] => {
    const out = [...groups.values()].filter((group) =>
      feeds.every((feed) => ready(feed, group.timestamp)),
    );
    out.sort((a, b) => b.timestamp - a.timestamp || (a.txid < b.txid ? -1 : 1));
    return out;
  };

  const frontierOf = (feed: Feed): number =>
    feed.fetched ? feed.oldest : Number.NEGATIVE_INFINITY;

  /** The feed bounding emission — the smallest frontier among feeds still paging. */
  const boundedFeed = (): Feed | undefined => {
    let target: Feed | undefined;
    for (const feed of feeds) {
      if (feed.done) {
        continue;
      }
      if (target === undefined || frontierOf(feed) < frontierOf(target)) {
        target = feed;
      }
    }
    return target;
  };

  return {
    id: `tron:${network}`,
    skipped: () => skipped,
    next: async () => {
      const bound = timeoutSignal(REQUEST_TIMEOUT_MS, options.setTimer);
      try {
        let emit = emitReady();
        while (emit.length === 0) {
          const target = boundedFeed();
          if (target === undefined) {
            break;
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- the next group check needs this page.
          await fetchPage(target, bound.signal);
          emit = emitReady();
        }
        if (emit.length === 0) {
          return { items: [], done: feeds.every((feed) => feed.done) };
        }
        for (const group of emit) {
          groups.delete(group.txid);
        }
        const items = await mapPool(emit, VERIFY_CONCURRENCY, async (group) => {
          const entry = tronHistoryEntry(network, address, group);
          const hit = cached.get(entry.id);
          if (
            hit !== undefined &&
            hit.verified &&
            (entry.block === undefined || hit.block === entry.block)
          ) {
            return hit;
          }
          return verifyEntry(api, address, entry, group, trusted);
        });
        return { items, done: feeds.every((feed) => feed.done) && groups.size === 0 };
      } finally {
        bound.cancel();
      }
    },
  };
};
