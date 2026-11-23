/**
 * `openPush` against vectors/push.json — produced by the independent Node-WebCrypto oracle in
 * scripts/vectors/push.ts, so this file is a second implementation meeting the wire format.
 */
import { readFileSync } from "node:fs";

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  PUSH_EVENT_DOMAIN,
  PUSH_ID_DOMAIN,
  PUSH_KEYS_MAX,
  pushEventInput,
} from "../src/gateway/contract/push-message.ts";
import type { PushEventKind, PushPlaintext } from "../src/gateway/contract/push-message.ts";
import { openPush } from "../src/push/index.ts";

const VECTORS = JSON.parse(
  readFileSync(new URL("../../../vectors/push.json", import.meta.url), "utf8"),
) as {
  domains: { id: string; event: string; aad: string };
  subscriptionIds: ReadonlyArray<{ secret: string; id: string }>;
  eventIds: ReadonlyArray<{
    name: string;
    key: string;
    network: string;
    hash: string;
    kind: PushEventKind;
    generation: number;
    input: string;
    eventId: string;
  }>;
  messages: ReadonlyArray<{
    name: string;
    key: string;
    eventId: string;
    nonce: string;
    plaintext: string;
    message: { v: string; e: string; c: string };
  }>;
  rejects: ReadonlyArray<{
    reason: string;
    message: { v: string; e: string; c: string };
    keys: ReadonlyArray<string>;
  }>;
};

const numRuns = Number(process.env["FUZZ_RUNS"] ?? "200");

describe("domains", () => {
  it("the contract constants are the strings the oracle hashed", () => {
    expect(PUSH_ID_DOMAIN).toBe(VECTORS.domains.id);
    expect(PUSH_EVENT_DOMAIN).toBe(VECTORS.domains.event);
  });
});

describe("subscription ids", () => {
  it.each(VECTORS.subscriptionIds)("derives $id", ({ secret, id }) => {
    const digest = sha256(concatBytes(utf8ToBytes(PUSH_ID_DOMAIN), hexToBytes(secret)));
    expect(bytesToHex(digest.subarray(0, 16))).toBe(id);
  });
});

describe("event ids", () => {
  it.each(VECTORS.eventIds)("$name is HMAC-SHA256 over pushEventInput", (c) => {
    const input = pushEventInput(c.network, c.hash, c.kind, c.generation);
    expect(input).toBe(c.input);
    const digest = hmac(sha256, hexToBytes(c.key), utf8ToBytes(input));
    expect(bytesToHex(digest.subarray(0, 16))).toBe(c.eventId);
  });
});

describe("openPush", () => {
  it.each(VECTORS.messages)("opens $name keyed second of three", (c) => {
    const keys = [hexToBytes("ff".repeat(32)), hexToBytes(c.key), hexToBytes("00".repeat(32))];
    const opened = openPush(c.message, keys);
    expect(opened?.keyIndex).toBe(1);
    expect(opened?.event).toStrictEqual(JSON.parse(c.plaintext) as PushPlaintext);
  });

  it.each(VECTORS.rejects)("does not open — $reason", ({ message, keys }) => {
    expect(
      openPush(
        message,
        keys.map((k) => hexToBytes(k)),
      ),
    ).toBeUndefined();
  });

  it.each(VECTORS.messages)("skips keys of the wrong length for $name", (c) => {
    const opened = openPush(c.message, [hexToBytes("aa".repeat(16)), hexToBytes(c.key)]);
    expect(opened?.keyIndex).toBe(1);
  });

  it.each(VECTORS.messages)("refuses PUSH_KEYS_MAX + 1 keys for $name", (c) => {
    const keys = [
      hexToBytes(c.key),
      ...Array.from({ length: PUSH_KEYS_MAX }, () => hexToBytes("11".repeat(32))),
    ];
    expect(keys).toHaveLength(PUSH_KEYS_MAX + 1);
    expect(openPush(c.message, keys)).toBeUndefined();
  });

  it("never throws on arbitrary messages and key lists", () => {
    fc.assert(
      fc.property(fc.anything(), fc.array(fc.uint8Array()), (message, keys) => {
        expect(() => openPush(message, keys)).not.toThrow();
      }),
      { numRuns },
    );
  });

  it.each(VECTORS.messages)("random keys never open $name", (c) => {
    const foreign = fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .filter((key) => bytesToHex(key) !== c.key);
    fc.assert(
      fc.property(foreign, (key) => {
        expect(openPush(c.message, [key])).toBeUndefined();
      }),
      { numRuns },
    );
  });
});
