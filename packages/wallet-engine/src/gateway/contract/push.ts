import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";
import { caip2 } from "./primitives.ts";

export const PUSH_FAMILIES = ["evm", "solana", "bitcoin", "tron"] as const;
export type PushFamily = (typeof PUSH_FAMILIES)[number];

export const PUSH_PLATFORMS = ["apns", "fcm"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const PUSH_ADDRESSES_MAX = 64;
export const PUSH_NETWORKS_MAX = 64;
/** A subscription not refreshed within this window is deleted. */
export const PUSH_TTL_MS = 30 * 86_400_000;
/** `Authorization: Bearer base64url(secret)` — the subscription's only credential. */
export const PUSH_AUTH_SCHEME = "Bearer";

/**
 * `title-loc-key` / `loc-key` values the gateway puts in the APNs alert: hosts ship these keys in
 * `Localizable.strings` as the fallback copy for a notification the extension cannot open.
 */
export const PUSH_APNS_TITLE_KEY = "QNTX_PUSH_TITLE";
export const PUSH_APNS_BODY_KEY = "QNTX_PUSH_BODY";

/**
 * 32 bytes as unpadded base64url: 42 body characters, then a final character whose low two bits are
 * zero — 43 arbitrary characters would decode to more than 32 bytes.
 */
const key32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** The bearer secret and payload key encoding. */
export const pushSecret = z.string().check(z.regex(key32));
export const pushSubscriptionId = /^[0-9a-f]{32}$/;

const alnum = z.string().check(z.regex(/^[0-9A-Za-z]{1,128}$/));

export const pushCapabilities = endpoint(
  "GET",
  "/v1/push",
  z.undefined(),
  z.strictObject({
    platforms: z.array(z.enum(PUSH_PLATFORMS)).check(z.maxLength(PUSH_PLATFORMS.length)),
    families: z.array(z.enum(PUSH_FAMILIES)).check(z.maxLength(PUSH_FAMILIES.length)),
  }),
);

export const pushSubscriptionRequest = z.strictObject({
  platform: z.enum(PUSH_PLATFORMS),
  /** The provider device token — printable ASCII, opaque to the gateway. */
  token: z.string().check(z.regex(/^[!-~]{1,4096}$/)),
  /** The payload key the gateway seals subscription-side. */
  key: pushSecret,
  networks: z.array(caip2).check(z.minLength(1), z.maxLength(PUSH_NETWORKS_MAX)),
  addresses: z.array(alnum).check(z.minLength(1), z.maxLength(PUSH_ADDRESSES_MAX)),
});

export const pushSubscriptionResponse = z.strictObject({
  id: z.string().check(z.regex(pushSubscriptionId)),
  /** The intersection of requested networks and what the gateway watches. */
  networks: z.array(caip2).check(z.maxLength(PUSH_NETWORKS_MAX)),
  expiresAt: z.int().check(z.minimum(0)),
});

export const pushSubscribe = endpoint(
  "PUT",
  "/v1/push/:family/subscription",
  pushSubscriptionRequest,
  pushSubscriptionResponse,
);

export const pushUnsubscribe = endpoint(
  "DELETE",
  "/v1/push/:family/subscription",
  z.undefined(),
  z.undefined(),
);

/** Registers a submitted outgoing hash so the gateway watches it to a settlement or failure. */
export const pushTransactionRequest = z.strictObject({ network: caip2, hash: alnum });

export const pushWatch = endpoint(
  "POST",
  "/v1/push/:family/transactions",
  pushTransactionRequest,
  z.strictObject({}),
);

/** A push route path for one family. */
export const pushPath = (template: string, family: PushFamily): string =>
  template.replace(":family", family);

export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequest>;
export type PushSubscriptionResponse = z.infer<typeof pushSubscriptionResponse>;
export type PushTransactionRequest = z.infer<typeof pushTransactionRequest>;
