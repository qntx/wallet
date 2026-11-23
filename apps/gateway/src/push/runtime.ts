/**
 * Worker-side materialization of the push env: secrets → seal key and senders. Push is enabled only
 * when `PUSH_SEAL_KEY` is set AND at least one sender is configured AND at least one family config
 * exists — `pushFamilies` stays empty until Layer 3 lands a watcher, so production answers empty
 * capabilities now. Malformed secrets throw at startup rather than inside an alarm.
 */
import type { PushFamily, PushPlatform } from "@qntx/wallet-engine/gateway/contract";

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

/** Family watchers this deploy serves — none yet: the EVM watcher lands with Layer 3. */
export const pushFamilies: Partial<Record<PushFamily, PushFamilyConfig>> = {};

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
