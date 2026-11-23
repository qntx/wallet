/**
 * Shared push fixtures: a fake EVM-like family config (lowercase `0x` 40-hex addresses, one
 * network), scripted verify/send helpers and a deterministic nonce clock for `PushCore` tests.
 */
import { DatabaseSync } from "node:sqlite";

import type { PushPlatform } from "@qntx/wallet-engine/gateway/contract";

import { PushCore } from "../../src/push/core.ts";
import type { PushCoreDeps, PushFamilyConfig, SubscribeRequest } from "../../src/push/core.ts";
import type { CheckResult } from "../../src/push/rules.ts";
import { importSealKey } from "../../src/push/seal.ts";
import type { PushDelivery, PushSender, SendOutcome } from "../../src/push/senders.ts";
import type { Sql } from "../../src/push/store.ts";
import { nodeSql } from "./sql.ts";

export const EVM = "eip155:1";
export const ADDRESS = "0x1111111111111111111111111111111111111111";
export const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";
export const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const SUBSCRIPTION_ID = "00112233445566778899aabbccddeeff";
export const DEVICE_TOKEN = "abababababababababababababababababababababababababababababababab";
/** Bytes 0..31 — the payload key the wallet retains, base64url-no-pad. */
export const PAYLOAD_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
/** Bytes 96..127 of standard base64 — the test `PUSH_SEAL_KEY`. */
export const SEAL_KEY_B64 = btoa(
  Array.from({ length: 32 }, (_, index) => String.fromCodePoint(0x60 + index)).join(""),
);

/** The fake family: `eip155:1`, `0x` 40-hex addresses normalized lowercase. */
export const evmFamily = (verify: PushFamilyConfig["verify"]): PushFamilyConfig => ({
  networks: new Set([EVM]),
  normalizeAddress: (address) =>
    /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : undefined,
  verify,
});

/** `verify` answering script rows per call, `unknown` once the script runs out. */
export function scriptVerify(script: ReadonlyArray<ReadonlyArray<CheckResult>> = []): {
  readonly verify: PushFamilyConfig["verify"];
  readonly calls: Array<ReadonlyArray<{ network: string; hash: string }>>;
} {
  const calls: Array<ReadonlyArray<{ network: string; hash: string }>> = [];
  let index = 0;
  return {
    calls,
    verify: async (targets) => {
      await Promise.resolve();
      calls.push(targets);
      const results =
        script[index] ?? targets.map((): CheckResult => ({ kind: "unknown" as const }));
      index += 1;
      return results;
    },
  };
}

/** A fresh PKCS8 PEM for APNs config tests — a throwaway P-256 key. */
export const p8Pem = async (): Promise<string> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  if (!("privateKey" in pair)) {
    throw new TypeError("expected a key pair");
  }
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(der instanceof ArrayBuffer)) {
    throw new TypeError("expected DER bytes");
  }
  let binary = "";
  for (const byte of new Uint8Array(der)) {
    binary += String.fromCodePoint(byte);
  }
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
};

/** Records deliveries; answers the scripted outcomes in order, `sent` past the end. */
export function fakeSender(
  script: ReadonlyArray<SendOutcome> = [],
): PushSender & { readonly deliveries: PushDelivery[] } {
  const deliveries: PushDelivery[] = [];
  let index = 0;
  return {
    deliveries,
    send: async (delivery) => {
      await Promise.resolve();
      deliveries.push(delivery);
      const outcome = script[index] ?? ({ kind: "sent" } as const);
      index += 1;
      return outcome;
    },
  };
}

export type CoreHarness = {
  readonly core: PushCore;
  readonly sql: Sql;
  readonly database: DatabaseSync;
  readonly sender: PushSender & { readonly deliveries: PushDelivery[] };
  readonly alarms: number[];
  readonly logs: string[];
  readonly verify: { readonly calls: Array<ReadonlyArray<{ network: string; hash: string }>> };
  readonly clock: { get: () => number; set: (ms: number) => void };
};

/** A `PushCore` on in-memory `node:sqlite` with a fake sender, scripted verify and a test clock. */
export async function coreHarness(
  options: {
    readonly sender?: PushSender & { readonly deliveries: PushDelivery[] };
    readonly script?: ReadonlyArray<ReadonlyArray<CheckResult>>;
    readonly start?: number;
  } = {},
): Promise<CoreHarness> {
  const database = new DatabaseSync(":memory:");
  const sql = nodeSql(database);
  const verify = scriptVerify(options.script);
  const sender = options.sender ?? fakeSender();
  const alarms: number[] = [];
  const logs: string[] = [];
  let clock = options.start ?? 1_700_000_000_000;
  let nonce = 0;
  const deps: PushCoreDeps = {
    sql,
    family: "evm",
    config: evmFamily(verify.verify),
    sealKey: await importSealKey(SEAL_KEY_B64),
    senders: { apns: sender },
    now: () => clock,
    random: (n) => {
      nonce += 1;
      const out = new Uint8Array(n).fill(0);
      // oxlint-disable-next-line eslint/no-bitwise -- nonce bytes for deterministic seals
      out[0] = nonce & 0xff;
      return out;
    },
    schedule: (at) => {
      alarms.push(at);
    },
    log: (line) => {
      logs.push(line);
    },
  };
  return {
    core: new PushCore(deps),
    sql,
    database,
    sender,
    alarms,
    logs,
    verify,
    clock: {
      get: () => clock,
      set: (ms) => {
        clock = ms;
      },
    },
  };
}

/** A standard subscribe request for the harness subscription id. */
export const subscribeRequest = (
  overrides: Partial<{
    readonly id: string;
    readonly platform: PushPlatform;
    readonly token: string;
    readonly key: string;
    readonly networks: string[];
    readonly addresses: string[];
  }> = {},
): SubscribeRequest => ({
  id: overrides.id ?? SUBSCRIPTION_ID,
  platform: overrides.platform ?? "apns",
  token: overrides.token ?? DEVICE_TOKEN,
  key: overrides.key ?? PAYLOAD_KEY,
  networks: overrides.networks ?? [EVM],
  addresses: overrides.addresses ?? [ADDRESS],
});
