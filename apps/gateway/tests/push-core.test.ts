// oxlint-disable vitest/no-conditional-in-test -- narrowing fixture and vector payloads
// is inherent to asserting on them.
/**
 * `PushCore` end to end on `node:sqlite`: subscribe → ingest → alarm → verify → outbox → sender,
 * opened back with the engine's `openPush`. Also the privacy invariants — the database never stores
 * the device token or payload key in clear, and log lines carry only counts — plus caps, retries,
 * the gone cascade and TTL expiry.
 */
import { describe, expect, it } from "vite-plus/test";

import { PUSH_TTL_MS } from "@qntx/wallet-engine/gateway/contract";
import { openPush } from "@qntx/wallet-engine/push";

import { GatewayHttpError } from "../src/middleware/errors.ts";
import { OUTBOX_TTL_MS, PUSH_RECORDS_MAX, PUSH_WATCHED_MAX } from "../src/push/core.ts";
import type { IngestItem } from "../src/push/core.ts";
import { base64urlBytes } from "../src/push/encoding.ts";
import {
  ADDRESS,
  DEVICE_TOKEN,
  EVM,
  HASH,
  OTHER_ADDRESS,
  PAYLOAD_KEY,
  SUBSCRIPTION_ID,
  coreHarness,
  fakeSender,
  subscribeRequest,
} from "./push/helpers.ts";
import { dumpText } from "./push/sql.ts";

const payloadKeyBytes = (): Uint8Array => {
  const bytes = base64urlBytes(PAYLOAD_KEY);
  if (bytes === undefined) {
    throw new TypeError("bad fixture");
  }
  return bytes;
};

const observation = (overrides: Partial<IngestItem> = {}): IngestItem => ({
  network: EVM,
  address: ADDRESS,
  hash: HASH,
  direction: "in",
  tid: "t1",
  transfer: { q: "1500000", d: 6, s: "USDC", c: "0xcccccccccccccccccccccccccccccccccccccccc" },
  removed: false,
  ...overrides,
});

const included = (
  overrides: Partial<{ success: boolean; block: number; final: boolean; from: string }> = {},
) => ({
  kind: "included" as const,
  success: overrides.success ?? true,
  block: overrides.block ?? 100,
  final: overrides.final ?? false,
  from: overrides.from ?? "0x3333333333333333333333333333333333333333",
});

const expectGatewayError = async (
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    expect(
      error instanceof GatewayHttpError && error.status === status && error.code === code,
    ).toBe(true);
    return;
  }
  expect.unreachable();
};

describe("PushCore subscribe", () => {
  it("stores a sealed subscription and answers its served networks", async () => {
    const { core, alarms } = await coreHarness();
    const response = await core.subscribe(subscribeRequest());
    expect(response).toStrictEqual({
      id: SUBSCRIPTION_ID,
      networks: [EVM],
      expiresAt: 1_700_000_000_000 + PUSH_TTL_MS,
    });
    expect(alarms).toContain(1_700_000_000_000 + PUSH_TTL_MS);
  });

  // oxlint-disable-next-line vitest/expect-expect -- asserts through expectGatewayError
  it("rejects an unserved platform, unserved networks and a bad address", async () => {
    const { core } = await coreHarness();
    await expectGatewayError(
      core.subscribe(subscribeRequest({ platform: "fcm" })),
      404,
      "unsupported",
    );
    await expectGatewayError(
      core.subscribe(subscribeRequest({ networks: ["solana:abc"] })),
      404,
      "unsupported",
    );
    await expectGatewayError(
      core.subscribe(subscribeRequest({ addresses: ["not-an-address"] })),
      400,
      "invalid-request",
    );
  });

  it("is idempotent per id and filters to served networks", async () => {
    const { core } = await coreHarness();
    const first = await core.subscribe(
      subscribeRequest({ networks: [EVM, "solana:abc"], addresses: [ADDRESS, ADDRESS] }),
    );
    expect(first.networks).toStrictEqual([EVM]);
    const second = await core.subscribe(subscribeRequest());
    expect(second.id).toBe(first.id);
  });

  // oxlint-disable-next-line vitest/expect-expect -- asserts through expectGatewayError
  it("enforces the watched-pairs cap", async () => {
    const { core, sql } = await coreHarness();
    sql.exec(
      `with recursive seq(n) as (select 1 union all select n + 1 from seq where n < ${String(PUSH_WATCHED_MAX)})
       insert into addresses select 'eip155:1', printf('a%d', n), 'seed' from seq`,
    );
    await expectGatewayError(core.subscribe(subscribeRequest()), 503, "unavailable");
  });
});

describe("PushCore flow", () => {
  it("delivers a received event the wallet's openPush decrypts", async () => {
    const { core, sender, verify } = await coreHarness({ script: [[included()]] });
    const at = 1_700_000_000_000;
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.alarm();
    expect(verify.calls).toStrictEqual([[{ network: EVM, hash: HASH }]]);
    expect(sender.deliveries).toHaveLength(1);
    const [delivery] = sender.deliveries;
    if (delivery === undefined) {
      throw new TypeError("unreachable");
    }
    expect(delivery.token).toBe(DEVICE_TOKEN);
    const opened = openPush({ v: "1", e: delivery.eventId, c: delivery.c }, [payloadKeyBytes()]);
    expect(opened?.event).toStrictEqual({
      v: 1,
      k: "received",
      n: EVM,
      h: HASH,
      a: ADDRESS,
      t: at,
      x: { q: "1500000", d: 6, s: "USDC", c: "0xcccccccccccccccccccccccccccccccccccccccc" },
    });
  });

  it("delivers once for a duplicated ingest", async () => {
    const { core, sender } = await coreHarness({ script: [[included()], [included()]] });
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.ingest([observation()]);
    await core.alarm();
    await core.alarm();
    expect(sender.deliveries).toHaveLength(1);
  });

  it("omits x when more than one activity id was folded in", async () => {
    const { core, sender } = await coreHarness({ script: [[included()]] });
    await core.subscribe(subscribeRequest());
    await core.ingest([observation(), observation({ tid: "t2" })]);
    await core.alarm();
    const [delivery] = sender.deliveries;
    if (delivery === undefined) {
      throw new TypeError("unreachable");
    }
    const opened = openPush({ v: "1", e: delivery.eventId, c: delivery.c }, [payloadKeyBytes()]);
    expect(opened?.event.x).toBeUndefined();
  });

  it("emits reverted with a fresh event id after two absences", async () => {
    const { core, sender, clock } = await coreHarness({
      script: [[included()], [{ kind: "absent" }], [{ kind: "absent" }]],
    });
    const at = clock.get();
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.alarm();
    clock.set(at + 15_000);
    await core.alarm();
    expect(sender.deliveries).toHaveLength(1); // one absence — nothing yet
    clock.set(at + 75_000);
    await core.alarm();
    expect(sender.deliveries).toHaveLength(2);
    const [received, reverted] = sender.deliveries;
    expect(reverted?.eventId).not.toBe(received?.eventId);
    if (reverted === undefined) {
      throw new TypeError("unreachable");
    }
    const opened = openPush({ v: "1", e: reverted.eventId, c: reverted.c }, [payloadKeyBytes()]);
    expect(opened?.event.k).toBe("reverted");
  });

  it("never notifies for a record whose receipt stays absent", async () => {
    const { core, sender, clock } = await coreHarness({
      script: [[{ kind: "absent" }], [{ kind: "absent" }]],
    });
    const at = clock.get();
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.alarm();
    clock.set(at + 60_000);
    await core.alarm();
    expect(sender.deliveries).toHaveLength(0);
  });

  it("delivers sent for an engine watch whose receipt names a watched address", async () => {
    const { core, sender } = await coreHarness({
      script: [[included({ from: ADDRESS })]],
    });
    await core.subscribe(subscribeRequest());
    await core.watch({ id: SUBSCRIPTION_ID, network: EVM, hash: HASH });
    await core.alarm();
    const [delivery] = sender.deliveries;
    if (delivery === undefined) {
      throw new TypeError("unreachable");
    }
    const opened = openPush({ v: "1", e: delivery.eventId, c: delivery.c }, [payloadKeyBytes()]);
    expect(opened?.event.k).toBe("sent");
    expect(opened?.event.a).toBe(ADDRESS);
  });

  it("drops a watch whose receipt names a foreign sender", async () => {
    const { core, sender, sql } = await coreHarness({
      script: [[included({ from: OTHER_ADDRESS })]],
    });
    await core.subscribe(subscribeRequest());
    await core.watch({ id: SUBSCRIPTION_ID, network: EVM, hash: HASH });
    await core.alarm();
    expect(sender.deliveries).toHaveLength(0);
    const rows = sql.exec(`select * from records`).toArray();
    expect(rows).toHaveLength(0);
  });

  // oxlint-disable-next-line vitest/expect-expect -- asserts through expectGatewayError
  it("answers not-found for an unknown subscription and unsupported for a foreign network", async () => {
    const { core } = await coreHarness();
    await expectGatewayError(
      core.watch({ id: SUBSCRIPTION_ID, network: EVM, hash: HASH }),
      404,
      "not-found",
    );
    await core.subscribe(subscribeRequest());
    await expectGatewayError(
      core.watch({ id: SUBSCRIPTION_ID, network: "solana:abc", hash: HASH }),
      404,
      "unsupported",
    );
  });

  // oxlint-disable-next-line vitest/expect-expect -- asserts through expectGatewayError
  it("enforces the per-subscription record cap", async () => {
    const { core, sql } = await coreHarness();
    await core.subscribe(subscribeRequest());
    for (let index = 0; index < PUSH_RECORDS_MAX; index += 1) {
      sql.exec(
        `insert into records values (?, ?, ?, ?, ?, ?)`,
        SUBSCRIPTION_ID,
        EVM,
        `h${String(index)}`,
        "{}",
        null,
        0,
      );
    }
    await expectGatewayError(
      core.watch({ id: SUBSCRIPTION_ID, network: EVM, hash: "hx" }),
      429,
      "rate-limited",
    );
  });
});

describe("PushCore delivery", () => {
  it("retries on the backoff ladder and succeeds", async () => {
    const sender = fakeSender([{ kind: "retry" }, { kind: "sent" }]);
    const { core, clock } = await coreHarness({ sender, script: [[included()]] });
    const at = clock.get();
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.alarm();
    expect(sender.deliveries).toHaveLength(1);
    clock.set(at + 30_000);
    await core.alarm();
    expect(sender.deliveries).toHaveLength(2);
  });

  it("drops a delivery whose retry would land past expiry", async () => {
    const sender = fakeSender([{ kind: "retry", afterSeconds: OUTBOX_TTL_MS / 1000 + 60 }]);
    const { core, sql } = await coreHarness({ sender, script: [[included()]] });
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.alarm();
    expect(sender.deliveries).toHaveLength(1);
    expect(sql.exec(`select count(*) as n from outbox`).toArray()[0]?.["n"]).toBe(0);
  });

  it("honours a sender Retry-After hint", async () => {
    const sender = fakeSender([{ kind: "retry", afterSeconds: 5 }]);
    const { core, alarms } = await coreHarness({ sender, script: [[included()]] });
    const at = 1_700_000_000_000;
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.alarm();
    expect(alarms).toContain(at + 5000);
  });

  it("cascades the subscription when the provider reports the token gone", async () => {
    const sender = fakeSender([{ kind: "gone" }]);
    const { core, sql } = await coreHarness({ sender, script: [[included()]] });
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.alarm();
    for (const table of ["subscriptions", "addresses", "records", "outbox"]) {
      expect(sql.exec(`select count(*) as n from ${table}`).toArray()[0]?.["n"]).toBe(0);
    }
  });
});

describe("PushCore expiry", () => {
  it("sweeps an expired subscription with all its rows", async () => {
    const { core, sql, clock } = await coreHarness({ script: [[included()]] });
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    clock.set(clock.get() + PUSH_TTL_MS + 1);
    await core.alarm();
    for (const table of ["subscriptions", "addresses", "records", "outbox"]) {
      expect(sql.exec(`select count(*) as n from ${table}`).toArray()[0]?.["n"]).toBe(0);
    }
  });

  it("unsubscribes idempotently", async () => {
    const { core, sql } = await coreHarness();
    await core.subscribe(subscribeRequest());
    await core.unsubscribe(SUBSCRIPTION_ID);
    await core.unsubscribe(SUBSCRIPTION_ID);
    expect(sql.exec(`select count(*) as n from subscriptions`).toArray()[0]?.["n"]).toBe(0);
  });
});

describe("PushCore privacy", () => {
  it("never stores the device token or payload key in clear", async () => {
    const { core, database } = await coreHarness({ script: [[included()]] });
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.alarm();
    const dump = dumpText(database).join("\n");
    expect(dump).not.toContain(DEVICE_TOKEN);
    expect(dump).not.toContain(PAYLOAD_KEY);
  });

  it("keeps tokens, keys, addresses, hashes and ids out of the logs", async () => {
    const { core, logs } = await coreHarness({ script: [[included()]] });
    await core.subscribe(subscribeRequest());
    await core.ingest([observation()]);
    await core.alarm();
    const joined = logs.join("\n");
    for (const secret of [
      DEVICE_TOKEN,
      PAYLOAD_KEY,
      ADDRESS,
      HASH,
      SUBSCRIPTION_ID,
      "1500000",
      "USDC",
    ]) {
      expect(joined).not.toContain(secret);
      expect(joined).not.toContain(ADDRESS.toUpperCase());
    }
  });
});
