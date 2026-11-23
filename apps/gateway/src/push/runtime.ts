/**
 * Worker-side materialization of the push env. `pushMaterials` turns the secrets into the seal key
 * and the senders; `pushRuntimeFor` adds the watcher config (`ALCHEMY_NOTIFY_TOKEN` +
 * `ALCHEMY_WEBHOOKS`) and the family map — `evm` when the Alchemy env is complete, nothing
 * otherwise, so Solana/Bitcoin/TRON keep answering `unsupported`. Malformed secrets and webhook
 * config throw at startup rather than inside an alarm.
 */
import type { PushFamily, PushPlatform } from "@qntx/wallet-engine/gateway/contract";

import type { WorkerEnv } from "../env.ts";
import { indexNetworks } from "../middleware/network.ts";
import { createForwarder } from "../providers/forward.ts";
import { upstreamFor } from "../upstream.ts";
import type { PushFamilyConfig } from "./core.ts";
import { importSealKey } from "./seal.ts";
import {
  APNS_PRODUCTION_HOST,
  APNS_SANDBOX_HOST,
  apnsSender,
  fcmSender,
  fcmServiceAccount,
} from "./senders.ts";
import type { PushSender } from "./senders.ts";
import { evmVerifier } from "./verify-evm.ts";
import { alchemyConfig, alchemySync } from "./watch-alchemy.ts";
import type { AlchemyConfig } from "./watch-alchemy.ts";

export type PushSecrets = {
  readonly PUSH_SEAL_KEY?: string;
  readonly APNS_KEY?: string;
  readonly APNS_KEY_ID?: string;
  readonly APNS_TEAM_ID?: string;
  readonly APNS_TOPIC?: string;
  readonly FCM_SERVICE_ACCOUNT?: string;
  /** `"production" | "staging"` — APNs hosts differ. */
  readonly NETWORKS: string;
};

export type PushMaterials = {
  readonly sealKey: CryptoKey;
  readonly senders: Partial<Record<PushPlatform, PushSender>>;
};

export type PushRuntime = {
  /** `undefined` without `PUSH_SEAL_KEY` or without any configured sender. */
  readonly materials: PushMaterials | undefined;
  /** `undefined` without the complete Alchemy watcher env — then `families` is empty too. */
  readonly alchemy: AlchemyConfig | undefined;
  readonly families: Partial<Record<PushFamily, PushFamilyConfig>>;
};

export const pushMaterials = async (
  env: PushSecrets,
  fetchImpl: typeof globalThis.fetch,
  now: () => number,
): Promise<PushMaterials | undefined> => {
  if (env.PUSH_SEAL_KEY === undefined) {
    return undefined;
  }
  const sealKey = await importSealKey(env.PUSH_SEAL_KEY);
  const senders: Partial<Record<PushPlatform, PushSender>> = {};
  if (
    env.APNS_KEY !== undefined &&
    env.APNS_KEY_ID !== undefined &&
    env.APNS_TEAM_ID !== undefined &&
    env.APNS_TOPIC !== undefined
  ) {
    senders.apns = await apnsSender(
      {
        keyPem: env.APNS_KEY,
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        topic: env.APNS_TOPIC,
        host: env.NETWORKS === "production" ? APNS_PRODUCTION_HOST : APNS_SANDBOX_HOST,
      },
      fetchImpl,
      now,
    );
  }
  if (env.FCM_SERVICE_ACCOUNT !== undefined) {
    const account = fcmServiceAccount(env.FCM_SERVICE_ACCOUNT);
    senders.fcm = await fcmSender(account, fetchImpl, now);
  }
  if (senders.apns === undefined && senders.fcm === undefined) {
    return undefined;
  }
  return { sealKey, senders };
};

const evmAddress = (address: string): string | undefined =>
  /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : undefined;

/**
 * One runtime for the HTTP worker and for every `PushObject`: the env-derived networks/accounts,
 * the Alchemy watcher config and the family map (`evm` verifies through the shared forwarder over
 * `upstreamFetch` and syncs addresses on the dashboard API). Each isolate and object builds its own
 * — the forwarder and budget are per-isolate state by design.
 */
export const pushRuntimeFor = async (
  env: WorkerEnv,
  upstreamFetch: typeof globalThis.fetch,
  log: (line: string) => void,
): Promise<PushRuntime> => {
  const upstream = upstreamFor(env, upstreamFetch, log);
  const served = indexNetworks(upstream.networks, upstream.auth, upstream.accounts);
  const evmNetworks = new Set(
    [...served.values()].filter((network) => network.family === "evm").map(({ id }) => id),
  );
  const alchemy = alchemyConfig(env, evmNetworks);
  const materials = await pushMaterials(env, upstreamFetch, () => Date.now());
  if (alchemy === undefined) {
    return { materials, alchemy: undefined, families: {} };
  }
  const forwarder = createForwarder(upstreamFetch, log, { budget: upstream.budget });
  const families: Partial<Record<PushFamily, PushFamilyConfig>> = {
    evm: {
      networks: alchemy.networks,
      normalizeAddress: evmAddress,
      verify: evmVerifier({ forwarder, served }),
      syncAddresses: alchemySync(alchemy, upstreamFetch),
    },
  };
  return { materials, alchemy, families };
};
