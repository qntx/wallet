/**
 * `PushObject` on a `node:sqlite`-backed fake `DurableObjectState`: the family is claimed on the
 * first RPC, `PushResult` unions come back instead of throws, and `alarm` drives the pass — with or
 * without seal materials.
 */
import { describe, expect, it } from "vite-plus/test";

import { PushObject } from "../src/push/object.ts";
import { pushFamilies } from "../src/push/runtime.ts";
import type { WorkerEnv } from "../src/worker.ts";
import {
  ADDRESS,
  EVM,
  HASH,
  SEAL_KEY_B64,
  SUBSCRIPTION_ID,
  evmFamily,
  p8Pem,
  subscribeRequest,
} from "./push/helpers.ts";
import { dumpText, pushObjectState } from "./push/sql.ts";

const env = async (sealed: boolean): Promise<WorkerEnv> =>
  ({
    ...(sealed
      ? {
          PUSH_SEAL_KEY: SEAL_KEY_B64,
          APNS_KEY: await p8Pem(),
          APNS_KEY_ID: "KID",
          APNS_TEAM_ID: "TEAM",
          APNS_TOPIC: "app.qntx",
        }
      : {}),
    NETWORKS: "staging",
  }) as WorkerEnv;

describe("PushObject", () => {
  it("serves the family's RPCs and persists the claimed family", async () => {
    const verifyCalls: unknown[] = [];
    pushFamilies["evm"] = evmFamily(async (targets) => {
      verifyCalls.push(targets);
      await Promise.resolve();
      return targets.map(() => ({ kind: "unknown" as const }));
    });
    try {
      const { state, alarmAt, pending } = pushObjectState();
      const object = new PushObject(state, await env(true));
      const subscribed = await object.subscribe("evm", subscribeRequest());
      expect(subscribed.ok).toBe(true);
      const watched = await object.watch("evm", {
        id: SUBSCRIPTION_ID,
        network: EVM,
        hash: HASH,
      });
      expect(watched.ok).toBe(true);
      const ingested = await object.ingest("evm", [
        {
          network: EVM,
          address: ADDRESS,
          hash: "0xbb",
          direction: "in",
          tid: "t1",
          transfer: undefined,
          removed: false,
        },
      ]);
      expect(ingested.ok).toBe(true);
      await object.alarm();
      await pending();
      expect(verifyCalls.length).toBeGreaterThan(0);
      expect(alarmAt()).not.toBeNull();
      const unsubscribed = await object.unsubscribe("evm", SUBSCRIPTION_ID);
      expect(unsubscribed.ok).toBe(true);
      // A second call on the same family still works; the family stayed claimed.
      const again = await object.subscribe("evm", subscribeRequest());
      expect(again.ok).toBe(true);
    } finally {
      delete pushFamilies["evm"];
    }
  });

  it("answers 404 unsupported when the family has no served config", async () => {
    const { state } = pushObjectState();
    const object = new PushObject(state, await env(true));
    // "solana" is a valid family but pushFamilies stays empty until Layer 3.
    const res = await object.subscribe("solana", subscribeRequest());
    expect(res).toStrictEqual({ ok: false, status: 404, code: "unsupported" });
    const evm = await object.subscribe("evm", subscribeRequest());
    expect(evm).toStrictEqual({ ok: false, status: 404, code: "unsupported" });
  });

  it("answers 404 unsupported without seal materials and still sweeps on alarm", async () => {
    pushFamilies["evm"] = evmFamily(async () => Promise.resolve([]));
    try {
      const { state, database } = pushObjectState();
      const object = new PushObject(state, await env(false));
      const res = await object.subscribe("evm", subscribeRequest());
      expect(res).toStrictEqual({ ok: false, status: 404, code: "unsupported" });
      // The family was claimed before materials were checked; alarm sweeps and reschedules.
      await object.alarm();
      expect(dumpText(database).length).toBeGreaterThan(0); // meta row persists
    } finally {
      delete pushFamilies["evm"];
    }
  });
});
