/**
 * The signature record: one entry per request that reached a final stage, newest 1000 kept in the
 * engine store. Entries carry a summary only — never signature bytes or the full signable content.
 */
import type { NostrKeyRef } from "@qntx/wallet";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import type { EngineLogger } from "../events.ts";
import type { EngineStore } from "../store/port.ts";
import type { AccountRef } from "../transactions/route.ts";
import type { RequestCheckCode } from "./checks.ts";
import type { SolanaAccount } from "./controller.ts";
import type { RiskFinding } from "./risk.ts";
import type { RequestMethod, RequestOrigin } from "./types.ts";

export type SignLogOutcome = "submitted" | "rejected" | "failed" | "expired" | "invalidated";

export type SignLogEntry = {
  readonly id: string;
  readonly at: number;
  readonly origin: RequestOrigin;
  readonly method: RequestMethod;
  readonly account: AccountRef | SparkAccountRef | NostrKeyRef | SolanaAccount;
  readonly network: string;
  readonly summary: string;
  readonly verification: "verified" | "unverifiable";
  readonly checks: ReadonlyArray<RequestCheckCode>;
  readonly risk: ReadonlyArray<RiskFinding>;
  readonly outcome: SignLogOutcome;
  readonly error?: string;
};

export const SIGN_LOG_LIMIT = 1000;
const COLLECTION = "sign-log";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const METHODS: ReadonlySet<unknown> = new Set([
  "send",
  "speed-up",
  "cancel",
  "cpfp",
  "pay",
  "zap",
  "evm-sign",
  "nostr-sign",
  "webln-invoice",
  "spark-deposit",
  "spark-exit",
]);
const OUTCOMES: ReadonlySet<unknown> = new Set([
  "submitted",
  "rejected",
  "failed",
  "expired",
  "invalidated",
]);
const FAMILIES: ReadonlySet<unknown> = new Set(["evm", "solana", "bitcoin"]);

const isAccount = (value: unknown): value is AccountRef | SparkAccountRef | SolanaAccount => {
  if (!isObject(value)) {
    return false;
  }
  if (value["kind"] === "hd") {
    return (
      typeof value["walletId"] === "string" &&
      typeof value["groupIndex"] === "number" &&
      typeof value["template"] === "string"
    );
  }
  if (value["kind"] === "imported") {
    return typeof value["keyId"] === "string" && FAMILIES.has(value["family"]);
  }
  if (value["kind"] === "derived") {
    return typeof value["walletId"] === "string" && typeof value["index"] === "number";
  }
  if (
    value["kind"] === undefined &&
    typeof value["walletId"] === "string" &&
    typeof value["groupIndex"] === "number" &&
    typeof value["address"] === "string"
  ) {
    return true;
  }
  return (
    value["kind"] === undefined &&
    typeof value["walletId"] === "string" &&
    typeof value["groupIndex"] === "number" &&
    typeof value["network"] === "string"
  );
};

const isOrigin = (value: unknown): boolean =>
  isObject(value) &&
  (value["kind"] === "internal" ||
    (value["kind"] === "browser" && typeof value["origin"] === "string"));

const isEntry = (value: unknown): value is SignLogEntry =>
  isObject(value) &&
  typeof value["id"] === "string" &&
  typeof value["at"] === "number" &&
  isOrigin(value["origin"]) &&
  METHODS.has(value["method"]) &&
  OUTCOMES.has(value["outcome"]) &&
  isAccount(value["account"]);

/** Sortable key: time first, request id as the tiebreak. */
const keyOf = (entry: SignLogEntry): string => `${String(entry.at).padStart(16, "0")}-${entry.id}`;

export type SignLog = {
  readonly open: (store: EngineStore) => void;
  /** Stops writing; entries that arrive afterwards are dropped with a warning. */
  readonly close: () => void;
  readonly append: (entry: SignLogEntry) => Promise<void>;
  /** Newest first. */
  readonly list: () => Promise<ReadonlyArray<SignLogEntry>>;
  readonly clear: () => Promise<void>;
};

export function createSignLog(logger: EngineLogger): SignLog {
  let store: EngineStore | undefined;

  return {
    open: (next) => {
      store = next;
    },
    close: () => {
      store = undefined;
    },
    append: async (entry) => {
      const current = store;
      if (current === undefined) {
        logger.warn(
          `sign log entry for request ${entry.id} (${entry.outcome}) not written: vault locked`,
        );
        return;
      }
      const collection = current.collection(COLLECTION);
      await collection.put(keyOf(entry), new TextEncoder().encode(JSON.stringify(entry)));
      const keys = [...(await collection.list())].sort();
      await Promise.all(
        keys
          .slice(0, Math.max(0, keys.length - SIGN_LOG_LIMIT))
          .map(async (k) => collection.delete(k)),
      );
    },
    list: async () => {
      if (store === undefined) {
        return [];
      }
      const collection = store.collection(COLLECTION);
      const keys = [...(await collection.list())].sort();
      const rows = await Promise.all(keys.map(async (k) => collection.get(k)));
      const entries: SignLogEntry[] = [];
      for (const raw of rows) {
        if (raw === undefined) {
          continue;
        }
        const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
        if (isEntry(parsed)) {
          entries.push(parsed);
        }
      }
      return entries.reverse();
    },
    clear: async () => {
      if (store === undefined) {
        return;
      }
      const collection = store.collection(COLLECTION);
      const keys = [...(await collection.list())].sort();
      await Promise.all(keys.map(async (k) => collection.delete(k)));
    },
  };
}
