// oxlint-disable vitest/no-conditional-in-test -- narrowing fixture and vector payloads
// is inherent to asserting on them.
/**
 * The APNs/FCM senders over a scripted `fakeFetch`: exact request shapes (URL, headers, body
 * bytes), provider JWT header/claims decoded and signature-verified with WebCrypto against test
 * keys, token caching, and every documented outcome mapping.
 */
import { describe, expect, it } from "vite-plus/test";

import { PUSH_APNS_BODY_KEY, PUSH_APNS_TITLE_KEY } from "@qntx/wallet-engine/gateway/contract";

import { base64urlBytes, utf8 } from "../src/push/encoding.ts";
import {
  APNS_PRODUCTION_HOST,
  APNS_SANDBOX_HOST,
  apnsSender,
  fcmSender,
  fcmServiceAccount,
} from "../src/push/senders.ts";
import type { SendOutcome } from "../src/push/senders.ts";
import { fakeFetch } from "./helpers.ts";

const DELIVERY = {
  token: "devicetoken",
  eventId: "0123456789abcdef0123456789abcdef",
  c: "aGVsbG8",
  expiresAt: 1_700_000_000_000 + 3_600_000,
};

const pem = (der: ArrayBuffer | JsonWebKey): string => {
  if (!(der instanceof ArrayBuffer)) {
    throw new TypeError("expected DER bytes");
  }
  let binary = "";
  for (const byte of new Uint8Array(der)) {
    binary += String.fromCodePoint(byte);
  }
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
};

const jws = (
  jwt: string,
): { header: unknown; claims: unknown; input: Uint8Array; signature: Uint8Array } => {
  const [header = "", claims = "", signature = ""] = jwt.split(".");
  return {
    header: JSON.parse(new TextDecoder().decode(base64urlBytes(header))),
    claims: JSON.parse(new TextDecoder().decode(base64urlBytes(claims))),
    input: utf8(`${header}.${claims}`),
    signature: base64urlBytes(signature) ?? new Uint8Array(),
  };
};

const p256 = async (): Promise<{ pem: string; publicKey: CryptoKey }> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) {
    throw new TypeError("expected a key pair");
  }
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return {
    pem: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    ),
  };
};

const rsa = async (): Promise<{ pem: string; publicKey: CryptoKey }> => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) {
    throw new TypeError("expected a key pair");
  }
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return {
    pem: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    ),
  };
};

describe("apnsSender", () => {
  const sendWith = async (handler: (call: { body: string }) => Response) => {
    const { pem: keyPem, publicKey } = await p256();
    const upstream = fakeFetch({ "https://api.push.apple.com": handler });
    const clock = { now: 1_700_000_000_000 };
    const sender = await apnsSender(
      { keyPem, keyId: "KID123", teamId: "TEAM456", topic: "app.qntx", host: APNS_PRODUCTION_HOST },
      upstream.fetch,
      () => clock.now,
    );
    return { sender, upstream, publicKey, clock };
  };

  it("posts the exact Apple request with a verifiable ES256 provider token", async () => {
    const { sender, upstream, publicKey } = await sendWith(
      () => new Response(null, { status: 200 }),
    );
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual({ kind: "sent" });
    const [call] = upstream.calls;
    expect(call?.url).toBe(`https://api.push.apple.com/3/device/${DELIVERY.token}`);
    expect(call?.method).toBe("POST");
    const headers = call?.headers as Record<string, string>;
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-topic"]).toBe("app.qntx");
    expect(headers["apns-priority"]).toBe("10");
    expect(headers["apns-expiration"]).toBe(String(Math.floor(DELIVERY.expiresAt / 1000)));
    expect(headers["apns-collapse-id"]).toBe(DELIVERY.eventId);
    expect(headers["content-type"]).toBe("application/json");
    expect(call?.body).toBe(
      JSON.stringify({
        aps: {
          alert: { "title-loc-key": PUSH_APNS_TITLE_KEY, "loc-key": PUSH_APNS_BODY_KEY },
          "mutable-content": 1,
          sound: "default",
        },
        qntx: { v: "1", e: DELIVERY.eventId, c: DELIVERY.c },
      }),
    );
    const bearer = headers["authorization"]?.replace("bearer ", "") ?? "";
    const { header, claims, input, signature } = jws(bearer);
    expect(header).toStrictEqual({ alg: "ES256", kid: "KID123" });
    expect(claims).toStrictEqual({ iss: "TEAM456", iat: 1_700_000_000 });
    await expect(
      crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, input),
    ).resolves.toBe(true);
  });

  it("caches the provider JWT for 50 minutes then re-signs", async () => {
    const { sender, upstream, clock } = await sendWith(() => new Response(null, { status: 200 }));
    await sender.send(DELIVERY);
    await sender.send(DELIVERY);
    clock.now += 51 * 60_000;
    await sender.send(DELIVERY);
    const tokens = upstream.calls.map(
      (call) => (call.headers as Record<string, string>)["authorization"],
    );
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[0]).not.toBe(tokens[2]);
    expect(jws(tokens[2]?.replace("bearer ", "") ?? "").claims).toStrictEqual({
      iss: "TEAM456",
      iat: 1_700_003_060,
    });
  });

  it.each<[number, unknown, SendOutcome]>([
    [410, {}, { kind: "gone" }],
    [400, { reason: "BadDeviceToken" }, { kind: "gone" }],
    [400, { reason: "DeviceTokenNotForTopic" }, { kind: "gone" }],
    [400, { reason: "BadCollapseId" }, { kind: "drop", reason: "apns 400 BadCollapseId" }],
    [403, { reason: "ExpiredProviderToken" }, { kind: "retry" }],
    [403, { reason: "InvalidProviderToken" }, { kind: "retry" }],
    [403, { reason: "BadProviderToken" }, { kind: "drop", reason: "apns 403 BadProviderToken" }],
    [429, {}, { kind: "retry" }],
    [500, {}, { kind: "retry" }],
    [503, {}, { kind: "retry" }],
    [413, {}, { kind: "drop", reason: "apns 413 unknown" }],
  ])("maps status %d %o to %o", async (status, body, expected) => {
    const { sender } = await sendWith(() => Response.json(body, { status }));
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual(expected);
  });

  it("drops the cached JWT when the provider token expired and retries", async () => {
    let answer: Response = new Response(null, { status: 200 });
    const { sender, upstream, clock } = await sendWith(() => answer);
    await sender.send(DELIVERY);
    const [firstCall] = upstream.calls;
    if (firstCall === undefined) {
      throw new TypeError("missing first call");
    }
    const first = (firstCall.headers as Record<string, string>)["authorization"];
    answer = Response.json({ reason: "ExpiredProviderToken" }, { status: 403 });
    clock.now += 60_000; // still inside the 50-minute cache window
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual({ kind: "retry" });
    answer = new Response(null, { status: 200 });
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual({ kind: "sent" });
    const thirdCall = upstream.calls.at(2);
    if (thirdCall === undefined) {
      throw new TypeError("missing third call");
    }
    const second = (thirdCall.headers as Record<string, string>)["authorization"];
    expect(second).not.toBe(first); // the dropped JWT was re-signed
  });

  it("retries when the transport throws", async () => {
    const upstream = fakeFetch({
      "https://api.push.apple.com": () => {
        throw new TypeError("network down");
      },
    });
    const { pem: keyPem } = await p256();
    const sender = await apnsSender(
      { keyPem, keyId: "K", teamId: "T", topic: "t", host: APNS_SANDBOX_HOST },
      upstream.fetch,
      () => 1,
    );
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual({ kind: "retry" });
    expect(upstream.calls[0]?.url).toContain(APNS_SANDBOX_HOST);
  });

  it("rejects a malformed APNS_KEY at startup", async () => {
    await expect(
      apnsSender(
        { keyPem: "not a pem", keyId: "K", teamId: "T", topic: "t", host: APNS_PRODUCTION_HOST },
        async () => Promise.resolve(new Response(null)),
        () => 1,
      ),
    ).rejects.toThrow("APNS_KEY");
  });
});

describe("fcmSender", () => {
  const account = (privateKeyPem: string): string =>
    JSON.stringify({
      project_id: "qntx",
      client_email: "push@qntx.iam",
      private_key: privateKeyPem,
    });

  const sendWith = async (
    sendHandler: (call: { body: string; headers: unknown }) => Response,
    tokenHandler?: () => Response,
  ) => {
    const { pem: privateKeyPem, publicKey } = await rsa();
    const upstream = fakeFetch({
      "https://oauth2.googleapis.com/token":
        tokenHandler ?? (() => Response.json({ access_token: "ya29.fake", expires_in: 3600 })),
      "https://fcm.googleapis.com": sendHandler,
    });
    const clock = { now: 1_700_000_000_000 };
    const sender = await fcmSender(
      fcmServiceAccount(account(privateKeyPem)),
      upstream.fetch,
      () => clock.now,
    );
    return { sender, upstream, publicKey, clock };
  };

  it("exchanges a verifiable RS256 assertion and posts the data-only message", async () => {
    const { sender, upstream, publicKey } = await sendWith(() => Response.json({ name: "x" }));
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual({ kind: "sent" });
    const [token] = upstream.callsTo("https://oauth2.googleapis.com/token");
    expect(token?.method).toBe("POST");
    const body = token?.body ?? "";
    expect(body).toContain(
      `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}`,
    );
    const assertion = decodeURIComponent(body.split("assertion=")[1] ?? "");
    const { header, claims, input, signature } = jws(assertion);
    expect(header).toStrictEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toStrictEqual({
      iss: "push@qntx.iam",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    await expect(
      crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, publicKey, signature, input),
    ).resolves.toBe(true);
    const [call] = upstream.callsTo("https://fcm.googleapis.com");
    expect(call?.url).toBe("https://fcm.googleapis.com/v1/projects/qntx/messages:send");
    expect(call?.method).toBe("POST");
    const callHeaders = call?.headers as Record<string, string> | undefined;
    expect(callHeaders?.["authorization"]).toBe("Bearer ya29.fake");
    expect(call?.body).toBe(
      JSON.stringify({
        message: {
          token: DELIVERY.token,
          data: { v: "1", e: DELIVERY.eventId, c: DELIVERY.c },
          android: { priority: "high", ttl: "3600s" },
        },
      }),
    );
  });

  it("caches the access token and refreshes it 5 minutes early", async () => {
    const { sender, upstream, clock } = await sendWith(() => Response.json({}));
    await sender.send(DELIVERY);
    await sender.send(DELIVERY);
    clock.now += 3_301_000; // expires_in 3600 − 300 margin + slack
    await sender.send(DELIVERY);
    expect(upstream.callsTo("https://oauth2.googleapis.com/token")).toHaveLength(2);
    expect(upstream.callsTo("https://fcm.googleapis.com")).toHaveLength(3);
  });

  it.each<[number, unknown, Record<string, string>, SendOutcome]>([
    [404, {}, {}, { kind: "gone" }],
    [403, { error: { status: "SENDER_ID_MISMATCH" } }, {}, { kind: "gone" }],
    [
      403,
      { error: { status: "PERMISSION_DENIED" } },
      {},
      { kind: "drop", reason: "fcm 403 PERMISSION_DENIED" },
    ],
    [401, {}, {}, { kind: "retry" }],
    [429, {}, { "retry-after": "30" }, { kind: "retry", afterSeconds: 30 }],
    [503, {}, {}, { kind: "retry" }],
    [500, {}, {}, { kind: "retry" }],
    [400, {}, {}, { kind: "drop", reason: "fcm 400 unknown" }],
  ])("maps status %d to %o", async (status, body, headers, expected) => {
    const { sender } = await sendWith(() => Response.json(body, { status, headers }));
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual(expected);
  });

  it("refetches the access token after a 401", async () => {
    const { sender, upstream } = await sendWith(
      (() => {
        const statuses = [401, 200];
        let index = 0;
        return (): Response => Response.json({}, { status: statuses[index++] ?? 200 });
      })(),
    );
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual({ kind: "retry" });
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual({ kind: "sent" });
    expect(upstream.callsTo("https://oauth2.googleapis.com/token")).toHaveLength(2);
  });

  it("retries when the transport throws", async () => {
    const { sender } = await sendWith(
      () => {
        throw new TypeError("network down");
      },
      () => Response.json({ access_token: "ya29.fake", expires_in: 3600 }),
    );
    await expect(sender.send(DELIVERY)).resolves.toStrictEqual({ kind: "retry" });
  });

  it("rejects a malformed service account at startup", () => {
    expect(() => fcmServiceAccount("{}")).toThrow("FCM_SERVICE_ACCOUNT");
    expect(() => fcmServiceAccount("{")).toThrow(SyntaxError);
  });
});
