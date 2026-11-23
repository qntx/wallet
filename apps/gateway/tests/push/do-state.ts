// oxlint-disable typescript/no-restricted-types -- node:sqlite binds and the DO alarm API are
// null-sentinel APIs; the fake mirrors them.
/**
 * A `DurableObjectState` fake whose `storage.sql`/`transactionSync`/`alarm` talk to an in-memory
 * `node:sqlite` database, so `PushObject` runs unmodified in tests.
 */
import { DatabaseSync } from "node:sqlite";

import type { SqlValue } from "../../src/push/store.ts";
import { nodeSql } from "./sql.ts";

export type FakeState = {
  readonly state: DurableObjectState;
  readonly database: DatabaseSync;
  readonly alarmAt: () => number | null;
  /** `ctx.waitUntil` captures — await before asserting alarm side effects. */
  readonly pending: () => Promise<unknown>;
};

export function pushObjectState(): FakeState {
  const database = new DatabaseSync(":memory:");
  const waits: Array<Promise<unknown>> = [];
  let alarm: number | null = null;
  const sql = nodeSql(database);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a structural fake for the DO state
  const state = {
    storage: {
      sql: {
        exec: (query: string, ...bindings: SqlValue[]) => sql.exec(query, ...bindings),
      },
      transactionSync: <T>(fn: () => T): T => sql.transaction(fn),
      getAlarm: async (): Promise<number | null> => {
        await Promise.resolve();
        return alarm;
      },
      setAlarm: async (at: number): Promise<void> => {
        await Promise.resolve();
        alarm = at;
      },
      deleteAlarm: async (): Promise<void> => {
        await Promise.resolve();
        alarm = null;
      },
    },
    waitUntil: (promise: Promise<unknown>): void => {
      waits.push(promise);
    },
  } as unknown as DurableObjectState;
  return {
    state,
    database,
    alarmAt: () => alarm,
    pending: async () => Promise.allSettled(waits.splice(0)),
  };
}
