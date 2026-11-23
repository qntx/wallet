// oxlint-disable vitest/no-conditional-in-test -- narrowing fixture and vector payloads
// is inherent to asserting on them.
/**
 * The dedup/reorg state machine: one test per rule — dedup of activity ids, notification direction,
 * the absent threshold, generation on re-inclusion, `final` stopping checks — plus a fast-check
 * model run asserting no emitted (kind, generation) ever repeats, `reverted` never precedes a real
 * notification and nothing emits after `final`.
 */
import {
  array,
  assert,
  boolean,
  constant,
  constantFrom,
  integer,
  oneof,
  property,
  record as arbRecord,
} from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  ABSENT_LIMIT,
  RECORD_TTL_MS,
  TIDS_MAX,
  applyCheck,
  checkDelay,
  expired,
  newWatchRecord,
  observe,
} from "../src/push/rules.ts";
import type { CheckResult, Observation, PushRecord } from "../src/push/rules.ts";

const NET = "eip155:1";
const HASH = "h1";
const OWN = "0xown";
const NOW = 1_000_000;

const obs = (overrides: Partial<Observation> = {}): Observation => ({
  direction: "in",
  address: OWN,
  tid: "t1",
  transfer: undefined,
  removed: false,
  ...overrides,
});

const included = (overrides: Partial<Extract<CheckResult, { kind: "included" }>> = {}) => ({
  kind: "included" as const,
  success: true,
  block: 100,
  final: false,
  from: OWN,
  ...overrides,
});

const freshRecord = (overrides: Partial<PushRecord> = {}): PushRecord => ({
  ...observe(undefined, obs(), NET, HASH, NOW),
  ...overrides,
});

const includedRecord = (overrides: Partial<PushRecord> = {}): PushRecord => {
  const outcome = applyCheck(freshRecord(), included(), NOW, new Set([OWN]));
  const { record } = outcome;
  if (record === undefined) {
    throw new TypeError("expected the record to survive inclusion");
  }
  return { ...record, ...overrides };
};

const own = new Set([OWN]);

describe("observe", () => {
  it("creates a pending record checked immediately, emitting nothing", () => {
    const record = freshRecord();
    expect(record.status).toBe("pending");
    expect(record.direction).toBe("in");
    expect(record.address).toBe(OWN);
    expect(record.tids).toStrictEqual(["t1"]);
    expect(record.nextCheck).toBe(NOW);
    expect(record.notified).toBeUndefined();
  });

  it("dedups repeated activity ids", () => {
    const first = freshRecord();
    const second = observe(first, obs({ tid: "t1" }), NET, HASH, NOW + 1);
    expect(second.tids).toStrictEqual(["t1"]);
  });

  it("keeps the first activity's transfer as the display", () => {
    const first = observe(undefined, obs({ transfer: { q: "5" } }), NET, HASH, NOW);
    const second = observe(first, obs({ tid: "t2", transfer: { q: "9" } }), NET, HASH, NOW);
    expect(second.tids).toStrictEqual(["t1", "t2"]);
    expect(second.transfer).toStrictEqual({ q: "5" });
    // A first activity with no transfer picks up the next one that has it.
    const filled = observe(freshRecord(), obs({ tid: "t2", transfer: { q: "7" } }), NET, HASH, NOW);
    expect(filled.transfer).toStrictEqual({ q: "7" });
  });

  it("lets an outgoing observation win over an incoming one", () => {
    const record = observe(
      freshRecord({ direction: "out" }),
      obs({ tid: "t2", direction: "in" }),
      NET,
      HASH,
      NOW,
    );
    expect(record.direction).toBe("out");
  });

  it("keeps at most TIDS_MAX activity ids", () => {
    let record = freshRecord();
    for (let index = 1; index <= TIDS_MAX + 4; index += 1) {
      record = observe(record, obs({ tid: `t${String(index + 1)}` }), NET, HASH, NOW);
    }
    expect(record.tids).toHaveLength(TIDS_MAX);
  });

  it("reschedules an included record immediately on a removed activity", () => {
    const record = includedRecord();
    const next = observe(record, obs({ tid: "t2", removed: true }), NET, HASH, NOW);
    expect(next.nextCheck).toBe(NOW);
  });

  it("leaves a final record untouched", () => {
    const record = includedRecord({ status: "final", nextCheck: undefined });
    expect(observe(record, obs({ tid: "t2" }), NET, HASH, NOW + 1)).toBe(record);
  });
});

describe("applyCheck", () => {
  it("emits nothing for an unknown receipt and rechecks in a minute", () => {
    const { record, emit } = applyCheck(freshRecord(), { kind: "unknown" }, NOW, own);
    expect(emit).toBeUndefined();
    expect(record?.nextCheck).toBe(NOW + 60_000);
    expect(record?.status).toBe("pending");
  });

  it("emits received for an inbound successful inclusion", () => {
    const { record, emit } = applyCheck(freshRecord(), included(), NOW, own);
    expect(emit).toStrictEqual({ kind: "received", generation: 0 });
    expect(record?.status).toBe("included");
    expect(record?.block).toBe(100);
    expect(record?.notified).toBe("received");
  });

  it("emits nothing for an inbound failed receipt", () => {
    const { record, emit } = applyCheck(freshRecord(), included({ success: false }), NOW, own);
    expect(emit).toBeUndefined();
    expect(record?.status).toBe("included");
    expect(record?.notified).toBeUndefined();
  });

  it("emits sent for an outbound success and failed for an outbound failure", () => {
    const outgoing = freshRecord({ direction: "out" });
    expect(applyCheck(outgoing, included(), NOW, own).emit).toStrictEqual({
      kind: "sent",
      generation: 0,
    });
    expect(applyCheck(outgoing, included({ success: false }), NOW, own).emit).toStrictEqual({
      kind: "failed",
      generation: 0,
    });
  });

  it("deletes a watch record whose receipt names a foreign sender", () => {
    const record = newWatchRecord(NET, HASH, NOW);
    expect(applyCheck(record, included({ from: "0xforeign" }), NOW, own)).toStrictEqual({
      record: undefined,
      emit: undefined,
    });
  });

  it("fills a watch record's address from the receipt and emits sent", () => {
    const record = newWatchRecord(NET, HASH, NOW);
    const { record: next, emit } = applyCheck(record, included({ from: OWN }), NOW, own);
    expect(next?.address).toBe(OWN);
    expect(emit).toStrictEqual({ kind: "sent", generation: 0 });
  });

  it("emits nothing on a repeated inclusion, only tracking the block", () => {
    const { emit, record } = applyCheck(includedRecord(), included({ block: 200 }), NOW, own);
    expect(emit).toBeUndefined();
    expect(record?.block).toBe(200);
  });

  it("needs ABSENT_LIMIT consecutive absences to take an included record gone", () => {
    const once = applyCheck(includedRecord(), { kind: "absent" }, NOW, own);
    expect(once.emit).toBeUndefined();
    expect(once.record?.status).toBe("included");
    expect(once.record?.absent).toBe(1);
    if (once.record === undefined) {
      throw new TypeError("unreachable");
    }
    const twice = applyCheck(once.record, { kind: "absent" }, NOW, own);
    expect(twice.record?.status).toBe("gone");
    expect(twice.record?.absent).toBe(0);
    expect(twice.emit).toStrictEqual({ kind: "reverted", generation: 0 });
  });

  it("emits no reverted when nothing was ever notified", () => {
    const record = freshRecord(); // pending, never notified
    const once = applyCheck(record, { kind: "absent" }, NOW, own);
    expect(once.emit).toBeUndefined();
    if (once.record === undefined) {
      throw new TypeError("unreachable");
    }
    const twice = applyCheck(once.record, { kind: "absent" }, NOW, own);
    expect(twice.emit).toBeUndefined();
    expect(twice.record?.status).toBe("pending");
  });

  it("emits no reverted for an inbound failed receipt that never notified", () => {
    const checked = applyCheck(freshRecord(), included({ success: false }), NOW, own);
    if (checked.record === undefined) {
      throw new TypeError("unreachable");
    }
    for (let index = 0; index < ABSENT_LIMIT; index += 1) {
      const outcome = applyCheck(checked.record, { kind: "absent" }, NOW, own);
      expect(outcome.emit).toBeUndefined();
    }
  });

  it("bumps generation and re-notifies on a re-inclusion after gone", () => {
    const gone = applyCheck(
      applyCheck(includedRecord(), { kind: "absent" }, NOW, own).record ?? includedRecord(),
      { kind: "absent" },
      NOW,
      own,
    ).record;
    if (gone === undefined) {
      throw new TypeError("unreachable");
    }
    const { record, emit } = applyCheck(gone, included({ block: 300 }), NOW, own);
    expect(emit).toStrictEqual({ kind: "received", generation: 1 });
    expect(record?.generation).toBe(1);
    expect(record?.status).toBe("included");
  });

  it("stops checking when the receipt is final", () => {
    const { record, emit } = applyCheck(freshRecord(), included({ final: true }), NOW, own);
    expect(emit).toStrictEqual({ kind: "received", generation: 0 });
    expect(record?.status).toBe("final");
    expect(record?.nextCheck).toBeUndefined();
    const later = applyCheck(record ?? freshRecord(), included(), NOW + 1, own);
    expect(later.emit).toBeUndefined();
    expect(later.record?.status).toBe("final");
  });

  it("paces re-checks: 15 s after the first check, a minute to the fifth, five minutes after", () => {
    expect(checkDelay(1)).toBe(15_000);
    expect(checkDelay(2)).toBe(60_000);
    expect(checkDelay(5)).toBe(60_000);
    expect(checkDelay(6)).toBe(300_000);
  });
});

describe("expired", () => {
  it("sweeps records older than the retention window, whatever their status", () => {
    const record = freshRecord();
    expect(expired(record, NOW + RECORD_TTL_MS - 1)).toBe(false);
    expect(expired(record, NOW + RECORD_TTL_MS)).toBe(true);
    expect(expired({ ...record, status: "final" }, NOW + RECORD_TTL_MS)).toBe(true);
  });
});

describe("model", () => {
  const checkResult = oneof(
    constant<CheckResult>({ kind: "unknown" }),
    constant<CheckResult>({ kind: "absent" }),
    arbRecord({
      success: boolean(),
      block: integer({ min: 0, max: 1000 }),
      final: boolean(),
      from: constantFrom(OWN, "0xforeign"),
    }).map<CheckResult>((row) => ({ kind: "included", ...row })),
  );
  const step = arbRecord({
    key: integer({ min: 0, max: 1 }),
    kind: constantFrom("observe", "check"),
    direction: constantFrom("in", "out"),
    tid: integer({ min: 0, max: TIDS_MAX + 4 }),
    removed: boolean(),
    result: checkResult,
  });

  it("never repeats an event id, never reverts before a notification, never emits after final", () => {
    assert(
      property(array(step, { maxLength: 80 }), (steps) => {
        const records = new Map<string, PushRecord>();
        const emitted = new Map<string, Array<{ kind: string; generation: number }>>();
        const finalized = new Set<string>();
        let now = NOW;
        for (const event of steps) {
          const key = `k${String(event.key)}`;
          const seen = emitted.get(key) ?? [];
          const record = records.get(key);
          if (event.kind === "observe") {
            const next = observe(
              record,
              {
                direction: event.direction,
                address: OWN,
                tid: `t${String(event.tid)}`,
                transfer: undefined,
                removed: event.removed,
              },
              NET,
              `h${key}`,
              now,
            );
            if (next !== record) {
              records.set(key, next);
            }
          } else if (record !== undefined) {
            const outcome = applyCheck(record, event.result, now, own);
            if (finalized.has(key)) {
              // oxlint-disable-next-line vitest/no-conditional-expect -- silence after final is conditional
              expect(outcome.emit).toBeUndefined();
            }
            if (outcome.record === undefined) {
              records.delete(key);
            } else {
              records.set(key, outcome.record);
              if (outcome.record.status === "final") {
                finalized.add(key);
              }
            }
            if (outcome.emit !== undefined) {
              seen.push(outcome.emit);
              emitted.set(key, seen);
            }
          }
          now += 1;
        }
        for (const list of emitted.values()) {
          const ids = new Set(list.map((e) => `${e.kind}/${String(e.generation)}`));
          expect(ids.size).toBe(list.length);
          const firstReal = list.findIndex((e) => e.kind !== "reverted");
          const firstRevert = list.findIndex((e) => e.kind === "reverted");
          expect(firstRevert === -1 || (firstReal !== -1 && firstReal < firstRevert)).toBe(true);
        }
      }),
    );
  });
});
