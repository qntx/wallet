/**
 * The `PushObject` SQLite layer over an injected cursor/transaction pair — the Durable Object
 * adapter binds `ctx.storage.sql` and `ctx.storage.transactionSync`, the tests bind `node:sqlite`.
 * Every read validates its row with zod; a corrupt row is deleted (by rowid, so a corrupt primary
 * key is deletable too) and skipped — storage decay never throws through an alarm.
 */
import * as z from "zod/mini";

import { PUSH_EVENT_KINDS } from "@qntx/wallet-engine/gateway/contract";
import type { PushTransfer } from "@qntx/wallet-engine/gateway/contract";

import { RECORD_TTL_MS } from "./rules.ts";
import type { PushRecord } from "./rules.ts";

// oxlint-disable-next-line typescript/no-restricted-types -- sqlite's own shape: null columns
export type SqlValue = string | number | null | ArrayBuffer;
export type SqlRow = Record<string, SqlValue>;
export type Sql = {
  readonly exec: (
    query: string,
    ...bindings: SqlValue[]
  ) => { toArray: () => Array<Record<string, SqlValue>> };
  readonly transaction: <T>(fn: () => T) => T;
};

export type SubscriptionRow = {
  readonly id: string;
  readonly sealed: string;
  readonly networks: ReadonlyArray<string>;
  readonly expires: number;
};

export type OutboxRow = {
  readonly id: number;
  readonly subscription: string;
  readonly event: string;
  readonly c: string;
  readonly attempts: number;
  readonly nextAt: number;
  readonly expires: number;
};

export type DueRecord = { readonly subscription: string; readonly record: PushRecord };
export type RecordKey = {
  readonly subscription: string;
  readonly network: string;
  readonly hash: string;
};

const SCHEMA = [
  `create table if not exists meta (k text primary key, v text not null)`,
  `create table if not exists subscriptions (
    id text primary key, sealed text not null, networks text not null, expires integer not null)`,
  `create table if not exists addresses (
    network text not null, address text not null, subscription text not null,
    primary key (network, address, subscription))`,
  `create index if not exists addresses_subscription on addresses (subscription)`,
  `create table if not exists records (
    subscription text not null, network text not null, hash text not null,
    data text not null, next_check integer, created integer not null,
    primary key (subscription, network, hash))`,
  `create index if not exists records_due on records (next_check)`,
  `create table if not exists outbox (
    id integer primary key, subscription text not null, event text not null, c text not null,
    attempts integer not null, next_at integer not null, expires integer not null)`,
  `create index if not exists outbox_due on outbox (next_at)`,
];

/* SQLite integers may surface as bigint on some drivers — both coerce to a plain number. */
const num = (value: unknown): number | undefined =>
  typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const subscriptionSchema = z.strictObject({
  id: z.string(),
  sealed: z.string(),
  networks: z.array(z.string()),
  expires: z.number(),
});

const transferSchema = z.strictObject({
  q: z.string(),
  d: z.optional(z.number()),
  s: z.optional(z.string()),
  c: z.optional(z.string()),
});

const recordSchema = z.strictObject({
  network: z.string(),
  hash: z.string(),
  direction: z.enum(["in", "out"]),
  address: z.optional(z.string()),
  transfer: z.optional(transferSchema),
  tids: z.array(z.string()),
  status: z.enum(["pending", "included", "gone", "final"]),
  notified: z.optional(z.enum(PUSH_EVENT_KINDS)),
  generation: z.number(),
  block: z.optional(z.number()),
  absent: z.number(),
  checks: z.number(),
  created: z.number(),
  nextCheck: z.optional(z.number()),
});

const outboxSchema = z.strictObject({
  id: z.number(),
  subscription: z.string(),
  event: z.string(),
  c: z.string(),
  attempts: z.number(),
  nextAt: z.number(),
  expires: z.number(),
});

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const count = (rows: ReadonlyArray<SqlRow>): number => {
  const value = rows[0]?.["n"];
  return num(value) ?? 0;
};

type StoredTransfer = z.infer<typeof transferSchema>;
type StoredRecord = z.infer<typeof recordSchema>;

const toTransfer = (row: StoredTransfer): PushTransfer => ({
  q: row.q,
  ...(row.d === undefined ? {} : { d: row.d }),
  ...(row.s === undefined ? {} : { s: row.s }),
  ...(row.c === undefined ? {} : { c: row.c }),
});

const toRecord = (row: StoredRecord): PushRecord => ({
  network: row.network,
  hash: row.hash,
  direction: row.direction,
  address: row.address,
  transfer: row.transfer === undefined ? undefined : toTransfer(row.transfer),
  tids: row.tids,
  status: row.status,
  notified: row.notified,
  generation: row.generation,
  block: row.block,
  absent: row.absent,
  checks: row.checks,
  created: row.created,
  nextCheck: row.nextCheck,
});

export type PushStore = ReturnType<typeof pushStore>;

/**
 * Opens the schema and returns the typed accessors. `transaction` wraps multi-statement writes so a
 * subscription's rows move as one.
 */
// oxlint-disable-next-line typescript/explicit-module-boundary-types -- PushStore is ReturnType<typeof pushStore>; a named annotation would be circular
export function pushStore(sql: Sql) {
  for (const statement of SCHEMA) {
    sql.exec(statement);
  }

  const rows = (query: string, ...bindings: SqlValue[]): SqlRow[] =>
    sql.exec(query, ...bindings).toArray();

  const deleteRow = (
    table: "subscriptions" | "addresses" | "records" | "outbox",
    rowid: SqlValue | undefined,
  ) => {
    if (rowid === undefined) {
      return;
    }
    sql.exec(`delete from ${table} where rowid = ?`, rowid);
  };

  const deleteSubscriptionCascade = (id: string): void => {
    sql.exec(`delete from addresses where subscription = ?`, id);
    sql.exec(`delete from records where subscription = ?`, id);
    sql.exec(`delete from outbox where subscription = ?`, id);
    sql.exec(`delete from subscriptions where id = ?`, id);
  };

  return {
    family(): string | undefined {
      const [row] = rows(`select v from meta where k = 'family'`);
      return row === undefined ? undefined : str(row["v"]);
    },

    /** First call wins and persists; the returned value is what the object serves. */
    claimFamily(family: string): string {
      const existing = this.family();
      if (existing !== undefined) {
        return existing;
      }
      sql.exec(`insert into meta (k, v) values ('family', ?)`, family);
      return family;
    },

    subscription(id: string): SubscriptionRow | undefined {
      const [row] = rows(`select rowid as rid, * from subscriptions where id = ?`, id);
      if (row === undefined) {
        return undefined;
      }
      const parsed = z.safeParse(subscriptionSchema, {
        id: row["id"],
        sealed: row["sealed"],
        networks: json(str(row["networks"]) ?? ""),
        expires: num(row["expires"]),
      });
      if (!parsed.success) {
        deleteRow("subscriptions", row["rid"]);
        const id = str(row["id"]);
        if (id !== undefined) {
          deleteSubscriptionCascade(id);
        }
        return undefined;
      }
      return parsed.data;
    },

    putSubscription(row: SubscriptionRow): void {
      sql.exec(
        `insert or replace into subscriptions (id, sealed, networks, expires) values (?, ?, ?, ?)`,
        row.id,
        row.sealed,
        JSON.stringify(row.networks),
        row.expires,
      );
    },

    subscriptionCount(): number {
      return count(rows(`select count(*) as n from subscriptions`));
    },

    expiredSubscriptions(now: number): string[] {
      return rows(`select id from subscriptions where expires <= ?`, now)
        .map((row) => str(row["id"]))
        .filter((id): id is string => id !== undefined);
    },

    deleteSubscriptionCascade,

    replaceAddresses(id: string, pairs: ReadonlyArray<{ network: string; address: string }>): void {
      sql.exec(`delete from addresses where subscription = ?`, id);
      for (const { network, address } of pairs) {
        sql.exec(
          `insert into addresses (network, address, subscription) values (?, ?, ?)`,
          network,
          address,
          id,
        );
      }
    },

    /** The subscription's normalized address set (all networks) for the `from` membership check. */
    addressSet(id: string): ReadonlySet<string> {
      return new Set(
        rows(`select address from addresses where subscription = ?`, id)
          .map((row) => str(row["address"]))
          .filter((address): address is string => address !== undefined),
      );
    },

    /** Subscriptions watching this (network, normalized address) pair. */
    watching(network: string, address: string): string[] {
      return rows(
        `select subscription from addresses where network = ? and address = ?`,
        network,
        address,
      )
        .map((row) => str(row["subscription"]))
        .filter((id): id is string => id !== undefined);
    },

    /** Distinct (network, address) pairs watched object-wide — the abuse cap. */
    watchedCount(): number {
      return count(
        rows(`select count(*) as n from (select distinct network, address from addresses)`),
      );
    },

    pairWatched(network: string, address: string): boolean {
      return (
        rows(
          `select 1 as n from addresses where network = ? and address = ? limit 1`,
          network,
          address,
        ).length > 0
      );
    },

    record(subscription: string, network: string, hash: string): PushRecord | undefined {
      const [row] = rows(
        `select rowid as rid, data from records where subscription = ? and network = ? and hash = ?`,
        subscription,
        network,
        hash,
      );
      if (row === undefined) {
        return undefined;
      }
      const parsed = z.safeParse(recordSchema, json(str(row["data"]) ?? ""));
      if (!parsed.success) {
        deleteRow("records", row["rid"]);
        return undefined;
      }
      return toRecord(parsed.data);
    },

    putRecord(subscription: string, record: PushRecord): void {
      sql.exec(
        `insert or replace into records (subscription, network, hash, data, next_check, created)
         values (?, ?, ?, ?, ?, ?)`,
        subscription,
        record.network,
        record.hash,
        JSON.stringify(record),
        record.nextCheck ?? null,
        record.created,
      );
    },

    deleteRecord(subscription: string, network: string, hash: string): void {
      sql.exec(
        `delete from records where subscription = ? and network = ? and hash = ?`,
        subscription,
        network,
        hash,
      );
    },

    /** Records still occupying the per-subscription cap — pending, included, gone or final. */
    recordCount(subscription: string): number {
      return count(rows(`select count(*) as n from records where subscription = ?`, subscription));
    },

    /**
     * Up to `limit` records due for a receipt check, oldest first. Corrupt rows are deleted and the
     * scan continues until `limit` valid rows are collected or none remain due.
     */
    dueRecords(now: number, limit: number): DueRecord[] {
      const found: DueRecord[] = [];
      for (;;) {
        const rowsDue = rows(
          `select rowid as rid, subscription, data from records
           where next_check is not null and next_check <= ? order by next_check limit ?`,
          now,
          limit + 8,
        );
        if (rowsDue.length === 0 || found.length >= limit) {
          return found;
        }
        for (const row of rowsDue) {
          const subscription = str(row["subscription"]);
          const parsed = z.safeParse(recordSchema, json(str(row["data"]) ?? ""));
          if (subscription === undefined || !parsed.success) {
            deleteRow("records", row["rid"]);
            continue;
          }
          if (found.length < limit) {
            found.push({ subscription, record: toRecord(parsed.data) });
          }
        }
        if (rowsDue.length < limit + 8 || found.length >= limit) {
          return found;
        }
      }
    },

    /** Record keys past their retention window. */
    expiredRecords(now: number): RecordKey[] {
      return rows(
        `select subscription, network, hash from records where created <= ?`,
        now - RECORD_TTL_MS,
      )
        .map((row) => ({
          subscription: str(row["subscription"]),
          network: str(row["network"]),
          hash: str(row["hash"]),
        }))
        .filter(
          (key): key is RecordKey =>
            key.subscription !== undefined && key.network !== undefined && key.hash !== undefined,
        );
    },

    insertDelivery(row: Omit<OutboxRow, "id">): number {
      const created = rows(
        `insert into outbox (subscription, event, c, attempts, next_at, expires)
         values (?, ?, ?, ?, ?, ?) returning id`,
        row.subscription,
        row.event,
        row.c,
        row.attempts,
        row.nextAt,
        row.expires,
      );
      return num(created[0]?.["id"]) ?? 0;
    },

    /** Due deliveries, oldest first; corrupt rows are deleted as they are met. */
    dueDeliveries(now: number, limit: number): OutboxRow[] {
      const found: OutboxRow[] = [];
      for (;;) {
        const rowsDue = rows(
          `select rowid as rid, id, subscription, event, c, attempts, next_at, expires
           from outbox where next_at <= ? order by next_at limit ?`,
          now,
          limit + 8,
        );
        if (rowsDue.length === 0 || found.length >= limit) {
          return found;
        }
        for (const row of rowsDue) {
          const parsed = z.safeParse(outboxSchema, {
            id: num(row["id"]),
            subscription: row["subscription"],
            event: row["event"],
            c: row["c"],
            attempts: num(row["attempts"]),
            nextAt: num(row["next_at"]),
            expires: num(row["expires"]),
          });
          if (!parsed.success) {
            deleteRow("outbox", row["rid"]);
            continue;
          }
          if (found.length < limit) {
            found.push(parsed.data);
          }
        }
        if (rowsDue.length < limit + 8 || found.length >= limit) {
          return found;
        }
      }
    },

    updateDelivery(id: number, attempts: number, nextAt: number): void {
      sql.exec(`update outbox set attempts = ?, next_at = ? where id = ?`, attempts, nextAt, id);
    },

    deleteDelivery(id: number): void {
      sql.exec(`delete from outbox where id = ?`, id);
    },

    expiredDeliveries(now: number): number[] {
      return rows(`select id from outbox where expires <= ?`, now)
        .map((row) => num(row["id"]))
        .filter((id): id is number => id !== undefined);
    },

    /** The earliest moment anything needs the alarm, or `undefined` when nothing is pending. */
    nextWake(): number | undefined {
      const recordCheck = num(rows(`select min(next_check) as n from records`)[0]?.["n"]);
      const delivery = num(rows(`select min(next_at) as n from outbox`)[0]?.["n"]);
      const subscription = num(rows(`select min(expires) as n from subscriptions`)[0]?.["n"]);
      const oldest = num(rows(`select min(created) as n from records`)[0]?.["n"]);
      const retention = oldest === undefined ? undefined : oldest + RECORD_TTL_MS;
      const times = [recordCheck, delivery, subscription, retention].filter(
        (value): value is number => value !== undefined,
      );
      return times.length === 0 ? undefined : Math.min(...times);
    },
  };
}
