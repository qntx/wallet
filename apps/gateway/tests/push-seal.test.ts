// oxlint-disable vitest/no-conditional-in-test -- narrowing fixture and vector payloads
// is inherent to asserting on them.
/**
 * The gateway sealing primitives against `vectors/push.json` — the independent Node-WebCrypto
 * oracle — plus a cross-implementation check that `sealEvent` output opens under the engine's
 * `openPush`, and `openTarget`'s never-throw contract on malformed input.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { PushEventKind, PushFamily } from "@qntx/wallet-engine/gateway/contract";
import { openPush } from "@qntx/wallet-engine/push";

import { base64urlBytes, base64urlOf, bytesOfHex } from "../src/push/encoding.ts";
import {
  eventIdOf,
  importSealKey,
  openTarget,
  sealEvent,
  sealTarget,
  subscriptionIdOf,
} from "../src/push/seal.ts";
import type { SealedTarget } from "../src/push/seal.ts";

type PushVectors = {
  readonly subscriptionIds: ReadonlyArray<{ readonly secret: string; readonly id: string }>;
  readonly eventIds: ReadonlyArray<{
    readonly key: string;
    readonly network: string;
    readonly hash: string;
    readonly kind: string;
    readonly generation: number;
    readonly eventId: string;
  }>;
  readonly messages: ReadonlyArray<{
    readonly key: string;
    readonly eventId: string;
    readonly nonce: string;
    readonly plaintext: string;
    readonly message: { readonly e: string; readonly c: string };
  }>;
  readonly seals: ReadonlyArray<{
    readonly sealKey: string;
    readonly family: string;
    readonly id: string;
    readonly nonce: string;
    readonly plaintext: string;
    readonly sealed: string;
  }>;
};

/* The vector file is canonical across packages — read it, never copy it into a fixture. */
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/push.json"), "utf8"),
) as PushVectors;

const hex = (value: string): Uint8Array => {
  const bytes = bytesOfHex(value);
  if (bytes === undefined) {
    throw new TypeError(`bad vector hex: ${value}`);
  }
  return bytes;
};

const targetOf = (plaintext: string): SealedTarget => {
  const value: unknown = JSON.parse(plaintext);
  if (typeof value !== "object" || value === null) {
    throw new TypeError("bad seal vector");
  }
  const { p, t, k } = value as Record<string, unknown>;
  if (typeof t !== "string" || typeof k !== "string" || (p !== "apns" && p !== "fcm")) {
    throw new TypeError("bad seal vector");
  }
  return { p, t, k };
};

const sealKeyOf = async (hexKey: string): Promise<CryptoKey> =>
  importSealKey(btoa(String.fromCodePoint(...hex(hexKey))));

describe("push seal vectors", () => {
  it("derives subscription ids", async () => {
    const ids = await Promise.all(
      vectors.subscriptionIds.map(async (vector) => subscriptionIdOf(hex(vector.secret))),
    );
    expect(ids).toStrictEqual(vectors.subscriptionIds.map((vector) => vector.id));
  });

  it("derives event ids", async () => {
    const ids = await Promise.all(
      vectors.eventIds.map(async (vector) =>
        eventIdOf(
          hex(vector.key),
          vector.network,
          vector.hash,
          vector.kind as PushEventKind,
          vector.generation,
        ),
      ),
    );
    expect(ids).toStrictEqual(vectors.eventIds.map((vector) => vector.eventId));
  });

  it("seals events to the oracle ciphertext", async () => {
    const sealed = await Promise.all(
      vectors.messages.map(async (vector) =>
        sealEvent(hex(vector.key), vector.eventId, vector.plaintext, hex(vector.nonce)),
      ),
    );
    expect(sealed).toStrictEqual(vectors.messages.map((vector) => vector.message.c));
  });

  it("seals and opens targets to the oracle ciphertext", async () => {
    const sealed = await Promise.all(
      vectors.seals.map(async (vector) => {
        const sealKey = await sealKeyOf(vector.sealKey);
        const family = vector.family as PushFamily;
        const blob = await sealTarget(
          sealKey,
          family,
          vector.id,
          targetOf(vector.plaintext),
          hex(vector.nonce),
        );
        const opened = await openTarget(sealKey, family, vector.id, blob);
        return { blob, opened };
      }),
    );
    expect(sealed.map(({ blob }) => blob)).toStrictEqual(
      vectors.seals.map((vector) => vector.sealed),
    );
    expect(sealed.map(({ opened }) => opened)).toStrictEqual(
      vectors.seals.map((vector) => targetOf(vector.plaintext)),
    );
  });
});

describe("sealEvent ↔ openPush", () => {
  it("opens every sealed message with the engine's opener", async () => {
    const opened = await Promise.all(
      vectors.messages.map(async (vector) => {
        const c = await sealEvent(
          hex(vector.key),
          vector.eventId,
          vector.plaintext,
          hex(vector.nonce),
        );
        return openPush({ v: "1", e: vector.eventId, c }, [hex(vector.key)]);
      }),
    );
    for (const [index, result] of opened.entries()) {
      expect(result).toBeDefined();
      expect(result?.keyIndex).toBe(0);
      expect(result?.event).toStrictEqual(JSON.parse(vectors.messages[index]?.plaintext ?? ""));
    }
  });
});

describe("openTarget", () => {
  const family = "evm";
  const id = "8ee86d90f223f4765aff16c21e04ecaf";

  const keyAndBlob = async (): Promise<{ key: CryptoKey; sealed: string }> => {
    const [vector] = vectors.seals;
    if (vector === undefined) {
      throw new TypeError("missing seal vector");
    }
    const key = await sealKeyOf(vector.sealKey);
    return { key, sealed: vector.sealed };
  };

  it("returns undefined rather than throwing on malformed input", async () => {
    const { key, sealed } = await keyAndBlob();
    await expect(openTarget(key, family, id, "!!!")).resolves.toBeUndefined();
    await expect(
      openTarget(key, family, id, base64urlOf(new Uint8Array(8))),
    ).resolves.toBeUndefined();
    // Truncated tag and tampered ciphertext fail authentication.
    await expect(openTarget(key, family, id, sealed.slice(0, -2))).resolves.toBeUndefined();
    const blob = base64urlBytes(sealed) ?? new Uint8Array();
    // oxlint-disable-next-line eslint/no-bitwise -- flipping one ciphertext byte is the tamper
    blob[20] = (blob[20] ?? 0) ^ 0xff;
    await expect(openTarget(key, family, id, base64urlOf(blob))).resolves.toBeUndefined();
    // A different family or id is a different AAD.
    await expect(openTarget(key, "bitcoin", id, sealed)).resolves.toBeUndefined();
    await expect(
      openTarget(key, family, "ffffffffffffffffffffffffffffffff", sealed),
    ).resolves.toBeUndefined();
    // A different seal key fails authentication.
    const other = await sealKeyOf(vectors.seals[1]?.sealKey ?? "");
    const rekeyed = await sealTarget(
      other,
      family,
      id,
      { p: "fcm", t: "tok", k: vectors.subscriptionIds[0]?.secret ?? "" },
      hex(vectors.seals[0]?.nonce ?? ""),
    );
    await expect(openTarget(key, family, id, rekeyed)).resolves.toBeUndefined();
    // A blob that decrypts but fails the shape check (here a 64-hex `k`, not a 43-char key).
    const wrongShape = await sealTarget(
      key,
      family,
      id,
      { p: "fcm", t: "tok", k: vectors.subscriptionIds[0]?.secret ?? "" },
      hex(vectors.seals[0]?.nonce ?? ""),
    );
    await expect(openTarget(key, family, id, wrongShape)).resolves.toBeUndefined();
  });
});

describe("importSealKey", () => {
  it("accepts exactly 32 bytes of standard base64", async () => {
    const key = await importSealKey(btoa(String.fromCodePoint(...new Uint8Array(32))));
    expect(key).toBeDefined();
    await expect(importSealKey("")).rejects.toThrow("32 bytes");
    await expect(importSealKey("AAA")).rejects.toThrow("32 bytes");
    await expect(importSealKey(btoa(String.fromCodePoint(...new Uint8Array(31))))).rejects.toThrow(
      "32 bytes",
    );
    await expect(importSealKey("not base64!!")).rejects.toThrow("32 bytes");
  });
});
