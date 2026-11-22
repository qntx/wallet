/**
 * The group's CLOB L2 credentials in the apps store — `{owner, apiKey, secret, passphrase}` under
 * the `eip155:137` record name (Polymarket trades on Polygon only), encrypted with the session data
 * key like every engine record (design.md §返工). A locked vault throws
 * `PolymarketError("unlock-required")`; a record that is not strict JSON with exactly those four
 * keys and valid field formats reads as absent, with one content-free warning — the enable flow
 * then re-derives rather than trusting it. The record's `owner` is the `evm.bip44` signer that
 * imported it; `l2.ts` re-checks it against the group's live signer on every request, so another
 * account's record can never sign. `onDelete` notifies after a `delete` lands — a live account view
 * stops on it rather than re-sending the deleted credentials on its next reconnect.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

import { EngineStoreError } from "../../errors.ts";
import type { EngineLogger } from "../../events.ts";
import { readJson } from "../../store/json.ts";
import type { AppGroup, AppStorage } from "../types.ts";
import { PolymarketError } from "./errors.ts";

/** The record name — the signature chain's CAIP-2. */
const NAME = "eip155:137";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const API_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The alphabet import accepts — standard or url-safe base64, padding optional. */
const SECRET_CHARS = /^[A-Za-z0-9+/=_-]+$/;
/** Printable ASCII 0x21–0x7e, like the CLOB issues it. */
const PASSPHRASE = /^[\u0021-\u007E]{1,128}$/;
const SECRET_MAX_CHARS = 128;
const SECRET_MIN_BYTES = 16;
const SECRET_MAX_BYTES = 64;

export type PolymarketCredentials = {
  /** The group's `evm.bip44` signer when the credentials were imported. */
  readonly owner: `0x${string}`;
  /** The lowercase UUID the CLOB issued with this credential set. */
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
};

export type PolymarketCredentialStore = {
  /** The group's credentials — `undefined` when absent or malformed. */
  readonly get: (group: AppGroup) => Promise<PolymarketCredentials | undefined>;
  /** Validates and stores; a field out of bounds is `malformed`, never written. */
  readonly put: (group: AppGroup, value: PolymarketCredentials) => Promise<void>;
  readonly delete: (group: AppGroup) => Promise<void>;
  /**
   * Fires after a `delete` lands, once per registered listener; a throwing listener is logged and
   * never fails the delete. Returns the unsubscribe.
   */
  readonly onDelete: (listener: (group: AppGroup) => void) => () => void;
  /** The groups with a credentials record. */
  readonly groups: () => Promise<ReadonlyArray<AppGroup>>;
};

/**
 * The secret decoded to HMAC key bytes, or undefined when the string is not within bounds or does
 * not decode. Mirrors clob-client-v2 `src/signing/hmac.ts` `decodeBase64Secret`: the url-safe
 * alphabet is normalized to the standard one and `=` padding is optional; a length-`%4 == 1`
 * remainder or a stray `=` fails the decode, never produces wrong bytes.
 */
export function decodeSecret(secret: string): Uint8Array | undefined {
  if (secret.length === 0 || secret.length > SECRET_MAX_CHARS || !SECRET_CHARS.test(secret)) {
    return undefined;
  }
  const normalized = secret.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const bytes = base64.decode(padded);
    return bytes.length >= SECRET_MIN_BYTES && bytes.length <= SECRET_MAX_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

const isAddress = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && ADDRESS.test(value);

/** Field formats, minus `owner` — shared by `put` validation and the strict record parse. */
const fieldsValid = (value: {
  readonly apiKey?: unknown;
  readonly secret?: unknown;
  readonly passphrase?: unknown;
}): value is { readonly apiKey: string; readonly secret: string; readonly passphrase: string } =>
  typeof value.apiKey === "string" &&
  API_KEY.test(value.apiKey) &&
  typeof value.secret === "string" &&
  decodeSecret(value.secret) !== undefined &&
  typeof value.passphrase === "string" &&
  PASSPHRASE.test(value.passphrase);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The strict record shape: exactly the four keys, each with a valid format. */
const parse = (raw: Uint8Array): PolymarketCredentials | undefined => {
  const value: unknown = readJson(raw);
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    Object.keys(value).some(
      (key) => key !== "owner" && key !== "apiKey" && key !== "secret" && key !== "passphrase",
    )
  ) {
    return undefined;
  }
  const { owner } = value;
  if (!isAddress(owner) || !fieldsValid(value)) {
    return undefined;
  }
  return {
    owner,
    apiKey: value.apiKey,
    secret: value.secret,
    passphrase: value.passphrase,
  };
};

/* A closed session store means a locked vault — map it once for every method. */
const read = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EngineStoreError && error.code === "closed") {
      throw new PolymarketError("unlock-required", "the vault is locked", { cause: error });
    }
    throw error;
  }
};

export function createPolymarketCredentials(options: {
  readonly storage: AppStorage;
  readonly logger: EngineLogger;
}): PolymarketCredentialStore {
  const deleteListeners = new Set<(group: AppGroup) => void>();
  return {
    get: async (group) => {
      const raw = await read(async () => options.storage.get(group, NAME));
      if (raw === undefined) {
        return undefined;
      }
      const parsed = parse(raw);
      if (parsed === undefined) {
        options.logger.warn(
          `polymarket credentials ${group.walletId}/${group.groupIndex} skipped: malformed`,
        );
      }
      return parsed;
    },
    put: async (group, value) => {
      /* apiKey arrives case-insensitive and is stored lowercase — the same normalization the
         kernel record enforced. */
      const normalized = {
        owner: value.owner,
        apiKey: value.apiKey.toLowerCase(),
        secret: value.secret,
        passphrase: value.passphrase,
      };
      if (!isAddress(normalized.owner) || !fieldsValid(normalized)) {
        throw new PolymarketError("malformed", "the credential fields failed validation");
      }
      await read(async () =>
        options.storage.put(group, NAME, utf8ToBytes(JSON.stringify(normalized))),
      );
    },
    delete: async (group) => {
      await read(async () => options.storage.delete(group, NAME));
      for (const listener of deleteListeners) {
        try {
          listener(group);
        } catch (error) {
          options.logger.warn("polymarket credentials delete listener threw", error);
        }
      }
    },
    onDelete: (listener) => {
      deleteListeners.add(listener);
      return () => {
        deleteListeners.delete(listener);
      };
    },
    groups: async () => read(options.storage.groups),
  };
}
