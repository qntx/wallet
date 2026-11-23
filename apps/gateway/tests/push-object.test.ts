/**
 * `PushObject` on a `node:sqlite`-backed fake `DurableObjectState`: the family is claimed on the
 * first RPC, `PushResult` unions come back instead of throws, and `alarm` drives the pass — with or
 * without seal materials. The test object overrides `pushRuntime` so the family map and materials
 * come from fixtures, not the env-derived production runtime.
 */
import { describe, expect, it } from "vite-plus/test";

import type { PushFamily } from "@qntx/wallet-engine/gateway/contract";

import type { WorkerEnv } from "../src/env.ts";
import type { PushFamilyConfig } from "../src/push/core.ts";
import { PushObject } from "../src/push/object.ts";
import { pushMaterials } from "../src/push/runtime.ts";
import type { PushRuntime } from "../src/push/runtime.ts";
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

class TestPushObject extends PushObject {
  readonly #families: Partial<Record<PushFamily, PushFamilyConfig>>;

  constructor(
    state: DurableObjectState,
    env: WorkerEnv,
    families: Partial<Record<PushFamily, PushFamilyConfig>>,
  ) {
    super(state, env);
    this.#families = families;
  }

  protected override async pushRuntime(): Promise<PushRuntime> {
    return {
      materials: await pushMaterials(
        this.env,
        async (input, init) => fetch(input, init),
        () => Date.now(),
      ),
      alchemy: undefined,
      families: this.#families,
    };
  }
}

describe("PushObject", () => {
  it("serves the family's RPCs and persists the claimed family", async () => {
    const verifyCalls: unknown[] = [];
    const families = {
      evm: evmFamily(async (targets) => {
        verifyCalls.push(targets);
        await Promise.resolve();
        return targets.map(() => ({ kind: "unknown" as const }));
      }),
    };
    const { state, alarmAt, pending } = pushObjectState();
    const object = new TestPushObject(state, await env(true), families);
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
  });

  it("answers 404 unsupported when the family has no served config", async () => {
    const { state } = pushObjectState();
    const object = new TestPushObject(state, await env(true), {});
    // "solana" is a valid family but no watcher config is served for it.
    const res = await object.subscribe("solana", subscribeRequest());
    expect(res).toStrictEqual({ ok: false, status: 404, code: "unsupported" });
    const evm = await object.subscribe("evm", subscribeRequest());
    expect(evm).toStrictEqual({ ok: false, status: 404, code: "unsupported" });
  });

  it("answers 404 unsupported without seal materials and still sweeps on alarm", async () => {
    const families = { evm: evmFamily(async () => Promise.resolve([])) };
    const { state, database } = pushObjectState();
    const object = new TestPushObject(state, await env(false), families);
    const res = await object.subscribe("evm", subscribeRequest());
    expect(res).toStrictEqual({ ok: false, status: 404, code: "unsupported" });
    // The family was claimed before materials were checked; alarm sweeps and reschedules.
    await object.alarm();
    expect(dumpText(database).length).toBeGreaterThan(0); // meta row persists
  });
});
