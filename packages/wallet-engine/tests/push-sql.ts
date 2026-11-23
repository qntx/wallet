// oxlint-disable typescript/no-restricted-types -- node:sqlite binds null for SQL NULL.
/**
 * `node:sqlite` bindings for the gateway push store — the `Sql` shape `pushStore` expects, running
 * eagerly like the Durable Object's `sql.exec`. Mirrors `apps/gateway/tests/push/sql.ts` (its
 * `DurableObjectState` fake is not needed here).
 */
import type { DatabaseSync } from "node:sqlite";

import type { Sql, SqlValue } from "../../../apps/gateway/src/push/store.ts";

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
