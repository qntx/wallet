/**
 * The two push providers, behind one `PushSender` interface. APNs authenticates with an ES256
 * provider token (Apple: header `{alg:"ES256",kid}`, claims `{iss,iat}`, refresh no more often than
 * every 20 minutes — cached 50); FCM exchanges an RS256 service-account assertion for an OAuth
 * access token (Google: `{iss,scope,aud,iat,exp≤iat+3600}` posted to the token endpoint, cached
 * `expires_in − 300` s). Both answer a `SendOutcome` and never throw: a transport error is a
 * `retry`, a dead device token is `gone` (the caller deletes the subscription), everything else is
 * retried or dropped per the provider's documented response classes.
 *
 * Sources:
 * developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns,
 * developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns,
 * developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns,
 * firebase.google.com/docs/cloud-messaging/send/v1-api,
 * firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode,
 * developers.google.com/identity/protocols/oauth2/service-account.
 */
import * as z from "zod/mini";

import { PUSH_APNS_BODY_KEY, PUSH_APNS_TITLE_KEY } from "@qntx/wallet-engine/gateway/contract";

import { base64Bytes, base64urlOf, utf8 } from "./encoding.ts";

export type PushDelivery = {
  readonly token: string;
  readonly eventId: string;
  readonly c: string;
  /** Unix ms; maps to `apns-expiration` (s) and the Android `ttl`. */
  readonly expiresAt: number;
};

export type SendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "gone" }
  | { readonly kind: "retry"; readonly afterSeconds?: number }
  | { readonly kind: "drop"; readonly reason: string };

export type PushSender = {
  readonly send: (delivery: PushDelivery) => Promise<SendOutcome>;
};

const SEND_TIMEOUT_MS = 10_000;
/** Apple: refresh the provider token no more than once per 20 min and no less than once per hour. */
const APNS_JWT_TTL_S = 50 * 60;
/** Google: refresh before `expires_in` so a mid-flight expiry cannot surface. */
const FCM_TOKEN_MARGIN_S = 300;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SEND_BASE = "https://fcm.googleapis.com/v1/projects/";

/** DER bytes of a PEM document — the base64 between the BEGIN/END armor lines. */
const pemDer = (pem: string): Uint8Array | undefined =>
  base64Bytes(
    pem
      .replace(/-----BEGIN [^-]+-----/, "")
      .replace(/-----END [^-]+-----/, "")
      .replaceAll(/\s+/g, ""),
  );

const recordOf = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = field;
  }
  return out;
};

/** `{"reason":"…"}` / `{"error":{"status":"…"}}` — the provider's error tag, when one was sent. */
const errorReason = async (res: Response): Promise<string | undefined> => {
  try {
    const value = recordOf(await res.json());
    const reason = value?.["reason"];
    if (typeof reason === "string") {
      return reason;
    }
    const status = recordOf(value?.["error"])?.["status"];
    return typeof status === "string" ? status : undefined;
  } catch {
    return undefined;
  }
};

const retryAfterSeconds = (res: Response): number | undefined => {
  const header = res.headers.get("retry-after");
  if (header === null) {
    return undefined;
  }
  const seconds = Math.trunc(Number(header));
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
};

export type ApnsConfig = {
  /** The `.p8` document Apple issues for the signing key. */
  readonly keyPem: string;
  readonly keyId: string;
  readonly teamId: string;
  /** The app bundle id. */
  readonly topic: string;
  /** `api.push.apple.com` or `api.sandbox.push.apple.com`. */
  readonly host: string;
};

export type FcmConfig = {
  readonly projectId: string;
  readonly clientEmail: string;
  /** The PEM `private_key` field of the service-account JSON document. */
  readonly privateKeyPem: string;
};

const fcmAccountSchema = z.object({
  project_id: z.string(),
  client_email: z.string(),
  private_key: z.string(),
});

/**
 * Parses `FCM_SERVICE_ACCOUNT` (the service-account JSON document); malformed input is a startup
 * misconfiguration and throws.
 */
export const fcmServiceAccount = (json: string): FcmConfig => {
  const parsed = z.safeParse(fcmAccountSchema, JSON.parse(json));
  if (!parsed.success) {
    throw new Error("FCM_SERVICE_ACCOUNT must be a service-account JSON document");
  }
  return {
    projectId: parsed.data.project_id,
    clientEmail: parsed.data.client_email,
    privateKeyPem: parsed.data.private_key,
  };
};

export const APNS_PRODUCTION_HOST = "api.push.apple.com";
export const APNS_SANDBOX_HOST = "api.sandbox.push.apple.com";

/**
 * APNs HTTP/2 sender. The WebCrypto ECDSA P-256 signature is already the raw `r ‖ s` JWS form.
 * Outcome mapping: 200 → sent; 410 or 400 BadDeviceToken/DeviceTokenNotForTopic → gone; 403
 * ExpiredProviderToken/InvalidProviderToken → drop the cached JWT and retry; 429, ≥500 and
 * transport errors/timeouts → retry; anything else → drop with the provider's reason.
 */
export const apnsSender = async (
  config: ApnsConfig,
  fetchImpl: typeof globalThis.fetch,
  now: () => number,
): Promise<PushSender> => {
  const der = pemDer(config.keyPem);
  if (der === undefined) {
    throw new Error("APNS_KEY is not a PEM document");
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  let cached: { readonly jwt: string; readonly iat: number } | undefined;
  const providerToken = async (): Promise<string> => {
    const at = Math.floor(now() / 1000);
    if (cached !== undefined && at - cached.iat < APNS_JWT_TTL_S) {
      return cached.jwt;
    }
    const header = base64urlOf(utf8(JSON.stringify({ alg: "ES256", kid: config.keyId })));
    const claims = base64urlOf(utf8(JSON.stringify({ iss: config.teamId, iat: at })));
    const input = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      utf8(input),
    );
    const jwt = `${input}.${base64urlOf(new Uint8Array(signature))}`;
    cached = { jwt, iat: at };
    return jwt;
  };
  return {
    send: async (delivery) => {
      try {
        const jwt = await providerToken();
        const res = await fetchImpl(`https://${config.host}/3/device/${delivery.token}`, {
          method: "POST",
          headers: {
            authorization: `bearer ${jwt}`,
            "apns-push-type": "alert",
            "apns-topic": config.topic,
            "apns-priority": "10",
            "apns-expiration": String(Math.floor(delivery.expiresAt / 1000)),
            "apns-collapse-id": delivery.eventId,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            aps: {
              alert: {
                "title-loc-key": PUSH_APNS_TITLE_KEY,
                "loc-key": PUSH_APNS_BODY_KEY,
              },
              "mutable-content": 1,
              sound: "default",
            },
            qntx: { v: "1", e: delivery.eventId, c: delivery.c },
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (res.status === 200) {
          return { kind: "sent" };
        }
        if (res.status === 410) {
          return { kind: "gone" };
        }
        const reason = await errorReason(res);
        if (res.status === 400) {
          return reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"
            ? { kind: "gone" }
            : { kind: "drop", reason: `apns 400 ${reason ?? "unknown"}` };
        }
        if (
          res.status === 403 &&
          (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")
        ) {
          cached = undefined;
          return { kind: "retry" };
        }
        if (res.status === 429 || res.status >= 500) {
          return { kind: "retry" };
        }
        return { kind: "drop", reason: `apns ${String(res.status)} ${reason ?? "unknown"}` };
      } catch {
        return { kind: "retry" };
      }
    },
  };
};

/**
 * FCM HTTP v1 sender. Outcome mapping: 200 → sent; 404 → gone; 403 SENDER_ID_MISMATCH → gone; 401 →
 * drop the cached access token and retry; 429/503/500 → retry honouring a delta-seconds
 * `Retry-After`; 400 → drop; transport errors/timeouts → retry.
 */
export const fcmSender = async (
  config: FcmConfig,
  fetchImpl: typeof globalThis.fetch,
  now: () => number,
): Promise<PushSender> => {
  const der = pemDer(config.privateKeyPem);
  if (der === undefined) {
    throw new Error("FCM private_key is not a PEM document");
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  let cached: { readonly token: string; readonly expiresAt: number } | undefined;
  const accessToken = async (): Promise<string> => {
    if (cached !== undefined && cached.expiresAt > now()) {
      return cached.token;
    }
    const iat = Math.floor(now() / 1000);
    const header = base64urlOf(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claims = base64urlOf(
      utf8(
        JSON.stringify({
          iss: config.clientEmail,
          scope: FCM_SCOPE,
          aud: FCM_TOKEN_URL,
          iat,
          exp: iat + 3600,
        }),
      ),
    );
    const input = `${header}.${claims}`;
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, utf8(input));
    const assertion = `${input}.${base64urlOf(new Uint8Array(signature))}`;
    const res = await fetchImpl(FCM_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`fcm token endpoint ${String(res.status)}`);
    }
    const body = z.safeParse(
      z.object({ access_token: z.string(), expires_in: z.number() }),
      await res.json(),
    );
    if (!body.success) {
      throw new Error("fcm token endpoint answered a malformed body");
    }
    cached = {
      token: body.data.access_token,
      expiresAt: now() + (body.data.expires_in - FCM_TOKEN_MARGIN_S) * 1000,
    };
    return cached.token;
  };
  return {
    send: async (delivery) => {
      try {
        const token = await accessToken();
        const ttl = Math.max(0, Math.floor((delivery.expiresAt - now()) / 1000));
        const res = await fetchImpl(`${FCM_SEND_BASE}${config.projectId}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              token: delivery.token,
              data: { v: "1", e: delivery.eventId, c: delivery.c },
              android: { priority: "high", ttl: `${String(ttl)}s` },
            },
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (res.status === 200) {
          return { kind: "sent" };
        }
        if (res.status === 404) {
          return { kind: "gone" };
        }
        const reason = await errorReason(res);
        if (res.status === 403) {
          return reason === "SENDER_ID_MISMATCH"
            ? { kind: "gone" }
            : { kind: "drop", reason: `fcm 403 ${reason ?? "unknown"}` };
        }
        if (res.status === 401) {
          cached = undefined;
          return { kind: "retry" };
        }
        if (res.status === 429 || res.status === 503 || res.status === 500) {
          const after = retryAfterSeconds(res);
          return after === undefined ? { kind: "retry" } : { kind: "retry", afterSeconds: after };
        }
        return { kind: "drop", reason: `fcm ${String(res.status)} ${reason ?? "unknown"}` };
      } catch {
        return { kind: "retry" };
      }
    },
  };
};
