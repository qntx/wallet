// oxlint-disable typescript/no-restricted-types -- node:sqlite binds and the DO alarm API are
// null-sentinel APIs; the fake mirrors them.
/**
 * `node:sqlite` bindings for the push modules — the `Sql` the store expects. The
 * `DurableObjectState` fake that runs `PushObject` on the same database lives in `do-state.ts` so
 * this file stays free of Cloudflare types.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Sql, SqlValue } from "../../src/push/store.ts";

type Bindable = null | number | bigint | string | Uint8Array;

const toBindable = (value: SqlValue): Bindable =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value;

const toValue = (value: unknown): SqlValue => {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value).buffer;
  }
  throw new TypeError("unexpected sqlite column type");
};

export function nodeSql(database: DatabaseSync): Sql {
  return {
    exec: (query, ...bindings) => {
      // The Durable Object's sql.exec runs eagerly — match it or DDL would never execute.
      const rows = database.prepare(query).all(...bindings.map(toBindable));
      return {
        toArray: () =>
          rows.map((row) => {
            const out: Record<string, SqlValue> = {};
            for (const [key, value] of Object.entries(row)) {
              out[key] = toValue(value);
            }
            return out;
          }),
      };
    },
    transaction: (fn) => {
      database.exec("begin");
      try {
        const value = fn();
        database.exec("commit");
        return value;
      } catch (error) {
        database.exec("rollback");
        throw error;
      }
    },
  };
}

const rowRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = field;
  }
  return out;
};

/** Every column of every table as text — the privacy scan's raw material. */
export const dumpText = (database: DatabaseSync): string[] => {
  const out: string[] = [];
  for (const table of database
    .prepare(`select name from sqlite_master where type = 'table'`)
    .all()) {
    const name = rowRecord(table)?.["name"];
    if (typeof name !== "string") {
      continue;
    }
    for (const row of database.prepare(`select * from ${name}`).all()) {
      const record = rowRecord(row);
      if (record === undefined) {
        continue;
      }
      for (const value of Object.values(record)) {
        out.push(String(value));
      }
    }
  }
  return out;
};
