/**
 * The Alchemy Notify watcher for EVM push records:
 *
 * - `POST /hooks/alchemy` receives Address Activity payloads. Authentication is hex
 *   `HMAC-SHA256(signingKey, raw body)` in `X-Alchemy-Signature` — the signing key comes from
 *   `ALCHEMY_WEBHOOKS`, keyed by the payload's `webhookId`. A non-2xx answer makes Alchemy retry,
 *   which is why an ingest failure answers 503 rather than 4xx.
 *   https://www.alchemy.com/docs/data/webhooks/webhook-types/address-activity-webhook
 * - `alchemyObservations` folds each activity into `IngestItem`s: `toAddress` is an incoming
 *   observation, `fromAddress` an outgoing one (a self-transfer is both — `out` wins in the rules),
 *   `log.logIndex`/`typeTraceAddress`/`external` forms the activity id a replayed webhook
 *   deduplicates on, and `log.removed` carries the re-org flag.
 * - `alchemySync` keeps each webhook's tracked set equal to the store's desired set through `PATCH
 *   /api/update-webhook-addresses` (`X-Alchemy-Token`, ≤ 500 addresses per list, idempotent). It
 *   fetches directly — the management API is not a metered JSON-RPC upstream, so it has no cost
 *   model and does not belong behind the forwarder.
 *   https://www.alchemy.com/docs/data/webhooks/webhooks-api-endpoints/update-webhook-addresses
 *
 * `ALCHEMY_NOTIFY_TOKEN` and `ALCHEMY_WEBHOOKS` are all-or-nothing: both absent disables the EVM
 * watcher; exactly one present, malformed JSON or a webhook pointed at a network the deploy does
 * not serve all throw at startup like any other malformed secret.
 */
import * as z from "zod/mini";

import type { IngestItem } from "./core.ts";

/** The dashboard API that reconciles a webhook's tracked address set. */
const UPDATE_ADDRESSES_URL = "https://dashboard.alchemy.com/api/update-webhook-addresses";
const MANAGEMENT_TIMEOUT_MS = 10_000;

/** Receipt of more than this many observations in one delivery is a flood — the rest are dropped. */
export const OBSERVATIONS_MAX = 5000;

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
/** The plaintext contract rules — a transfer display violating either is dropped, not pushed. */
const AMOUNT = /^(0|[1-9][0-9]{0,77})$/;
const SYMBOL = /^[!-~](?:[ -~]{0,14}[!-~])?$/;

const webhookEntrySchema = z.strictObject({
  id: z.string().check(z.minLength(1)),
  signingKey: z.string().check(z.minLength(1)),
});
const webhooksSchema = z.record(z.string(), webhookEntrySchema);

export type AlchemyHook = {
  /** The CAIP-2 network the webhook watches. */
  readonly network: string;
  /** The webhook destination id — identifies the `signingKey` an `X-Alchemy-Signature` needs. */
  readonly id: string;
  readonly signingKey: string;
};

export type AlchemyConfig = {
  /** The `X-Alchemy-Token` management credential. */
  readonly token: string;
  /** Every CAIP-2 network with a webhook — the EVM family's `networks`. */
  readonly networks: ReadonlySet<string>;
  /** `webhookId` → hook, for the hook route's lookup. */
  readonly hooks: ReadonlyMap<string, AlchemyHook>;
  /** CAIP-2 → webhook id, for the address reconciliation. */
  readonly webhooks: ReadonlyMap<string, { readonly id: string }>;
};

/**
 * The watcher env → config: `{"<caip2>": {"id", "signingKey"}}` per network, each caip2 a served
 * EVM network. Both vars absent → `undefined` (watcher off); anything else malformed → throw.
 */
export const alchemyConfig = (
  env: {
    readonly ALCHEMY_NOTIFY_TOKEN?: string | undefined;
    readonly ALCHEMY_WEBHOOKS?: string | undefined;
  },
  evmNetworks: ReadonlySet<string>,
): AlchemyConfig | undefined => {
  const token = env.ALCHEMY_NOTIFY_TOKEN;
  const webhooksJson = env.ALCHEMY_WEBHOOKS;
  if (token === undefined && webhooksJson === undefined) {
    return undefined;
  }
  if (token === undefined || webhooksJson === undefined) {
    throw new Error("ALCHEMY_NOTIFY_TOKEN and ALCHEMY_WEBHOOKS are all-or-nothing");
  }
  let value: unknown;
  try {
    value = JSON.parse(webhooksJson);
  } catch {
    throw new Error("ALCHEMY_WEBHOOKS is not JSON");
  }
  const parsed = z.safeParse(webhooksSchema, value);
  if (!parsed.success) {
    throw new Error("ALCHEMY_WEBHOOKS is malformed — expected {<caip2>: {id, signingKey}}");
  }
  const hooks = new Map<string, AlchemyHook>();
  const webhooks = new Map<string, { id: string }>();
  const networks = new Set<string>();
  for (const [network, hook] of Object.entries(parsed.data)) {
    if (!evmNetworks.has(network)) {
      throw new Error(`ALCHEMY_WEBHOOKS network ${network} is not a served EVM network`);
    }
    networks.add(network);
    webhooks.set(network, { id: hook.id });
    hooks.set(hook.id, { network, id: hook.id, signingKey: hook.signingKey });
  }
  return { token, networks, hooks, webhooks };
};

const fromHex = (text: string): Uint8Array | undefined => {
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) {
    return undefined;
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

/**
 * `X-Alchemy-Signature` is hex `HMAC-SHA256(signingKey, raw body)`
 * (https://www.alchemy.com/docs/data/webhooks/webhooks-quickstart — "Validate webhook signatures").
 * `crypto.subtle.verify` compares in constant time.
 */
export const verifyAlchemySignature = async (
  rawBody: string,
  header: string | undefined,
  signingKey: string,
): Promise<boolean> => {
  if (header === undefined) {
    return false;
  }
  const signature = fromHex(header);
  if (signature === undefined || signature.length !== 32) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(signature).buffer,
    new TextEncoder().encode(rawBody),
  );
};

const activitySchema = z.looseObject({
  hash: z.optional(z.string()),
  fromAddress: z.optional(z.string()),
  toAddress: z.optional(z.string()),
  asset: z.optional(z.union([z.string(), z.null()])),
  category: z.optional(z.union([z.string(), z.null()])),
  rawContract: z.optional(
    z.union([
      z.looseObject({
        rawValue: z.optional(z.union([z.string(), z.null()])),
        address: z.optional(z.union([z.string(), z.null()])),
        decimals: z.optional(z.union([z.number(), z.string(), z.null()])),
      }),
      z.null(),
    ]),
  ),
  log: z.optional(
    z.union([
      z.looseObject({
        logIndex: z.optional(z.union([z.string(), z.number(), z.null()])),
        removed: z.optional(z.union([z.boolean(), z.null()])),
      }),
      z.null(),
    ]),
  ),
  typeTraceAddress: z.optional(z.union([z.string(), z.null()])),
});

/** The hook route's full-parse schema — required fields only, extras tolerated. */
export const alchemyPayloadSchema = z.looseObject({
  webhookId: z.string(),
  id: z.string(),
  createdAt: z.string(),
  type: z.string(),
  event: z.looseObject({
    network: z.string(),
    activity: z.array(activitySchema),
  }),
});
export type AlchemyPayload = z.infer<typeof alchemyPayloadSchema>;

const symbol = (asset: string | undefined): string | undefined =>
  asset !== undefined && SYMBOL.test(asset) ? asset : undefined;

const quantity = (rawValue: string | undefined): string | undefined => {
  if (rawValue === undefined || !HEX.test(rawValue)) {
    return undefined;
  }
  const q = BigInt(rawValue).toString();
  return AMOUNT.test(q) ? q : undefined;
};

/** `rawContract.decimals` is a number in the docs' example and a hex string in the field table. */
const decimalsOf = (value: number | string | undefined): number | undefined => {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;
  }
  if (typeof value === "string" && HEX.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= 255 ? parsed : undefined;
  }
  return undefined;
};

type Activity = z.infer<typeof activitySchema>;

const transferOf = (activity: Activity): IngestItem["transfer"] => {
  const contract = activity.rawContract ?? undefined;
  const q = quantity(contract?.rawValue ?? undefined);
  if (q === undefined) {
    return undefined;
  }
  const s = symbol(activity.asset ?? undefined);
  if (activity.category === "external" || activity.category === "internal") {
    return { q, d: 18, ...(s === undefined ? {} : { s }) };
  }
  const contractAddress = contract?.address;
  const d = decimalsOf(contract?.decimals ?? undefined);
  if (
    (activity.category === "erc20" || activity.category === "token") &&
    d !== undefined &&
    contractAddress !== undefined &&
    contractAddress !== null &&
    EVM_ADDRESS.test(contractAddress)
  ) {
    return { q, d, ...(s === undefined ? {} : { s }), c: contractAddress.toLowerCase() };
  }
  return undefined;
};

const activityId = (activity: Activity): string => {
  const logIndex = activity.log?.logIndex;
  if (logIndex !== undefined && logIndex !== null) {
    return `log:${String(logIndex)}`;
  }
  const trace = activity.typeTraceAddress;
  if (trace !== undefined && trace !== null && trace !== "") {
    return `trace:${trace}`;
  }
  return "external";
};

/**
 * Address Activity → observations for `network` (the caip2 the webhook id was configured under —
 * `event.network` is Alchemy's own name and only cross-checks). Malformed hashes or missing
 * addresses are skipped; an oversized delivery is truncated to `OBSERVATIONS_MAX` items and the
 * remainder is reported in `dropped` — a residual gap the caller logs, since dropped activity never
 * reaches a record.
 */
export const alchemyObservations = (
  payload: AlchemyPayload,
  network: string,
): { readonly items: IngestItem[]; readonly dropped: number } => {
  const items: IngestItem[] = [];
  let dropped = 0;
  for (const activity of payload.event.activity) {
    const { hash } = activity;
    if (hash === undefined || !EVM_HASH.test(hash)) {
      continue;
    }
    const to = activity.toAddress;
    const from = activity.fromAddress;
    const valid = [
      ...(to !== undefined && EVM_ADDRESS.test(to) ? (["in"] as const) : []),
      ...(from !== undefined && EVM_ADDRESS.test(from) ? (["out"] as const) : []),
    ];
    if (items.length + valid.length > OBSERVATIONS_MAX) {
      dropped += valid.length;
      continue;
    }
    const base = {
      network,
      hash: hash.toLowerCase(),
      tid: activityId(activity),
      transfer: transferOf(activity),
      removed: activity.log?.removed === true,
    };
    for (const direction of valid) {
      const address = direction === "in" ? to : from;
      if (address === undefined) {
        continue;
      }
      items.push({ ...base, address: address.toLowerCase(), direction });
    }
  }
  return { items, dropped };
};

/**
 * One reconciliation call: `PATCH {webhook_id, addresses_to_add, addresses_to_remove}` on the
 * dashboard API — idempotent by the docs, so a retried batch is harmless. A non-2xx throws so the
 * core's sync step defers the remainder. Not the forwarder: the management API is not a metered
 * JSON-RPC upstream and has no cost model.
 * https://www.alchemy.com/docs/data/webhooks/webhooks-api-endpoints/update-webhook-addresses
 */
export const alchemySync =
  (
    config: AlchemyConfig,
    fetchImpl: typeof globalThis.fetch,
  ): ((
    network: string,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>,
  ) => Promise<void>) =>
  async (network, add, remove) => {
    const hook = config.webhooks.get(network);
    if (hook === undefined) {
      throw new Error(`no alchemy webhook for ${network}`);
    }
    const response = await fetchImpl(UPDATE_ADDRESSES_URL, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "X-Alchemy-Token": config.token,
      },
      body: JSON.stringify({
        webhook_id: hook.id,
        addresses_to_add: [...add],
        addresses_to_remove: [...remove],
      }),
      signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`alchemy update-webhook-addresses: status-${response.status}`);
    }
    await response.text();
  };
