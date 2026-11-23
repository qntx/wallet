/**
 * The vault anchor holds the revision floor and the password failure counters outside the record
 * store: a store writer who puts an older vault image back is caught before any unlock, an image
 * whose revision was inflated up to the floor still fails the manifest that binds it, and rewriting
 * the store cannot disarm an armed backoff. Record vectors: vectors/vault-anchor.json.
 */
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import type { VaultAnchor } from "../src/platform.ts";
import {
  createMemoryAnchor,
  decodeAnchor,
  encodeAnchor,
  readAnchor,
  updateAnchor,
} from "../src/vault/anchor.ts";
import type { AnchorState } from "../src/vault/anchor.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import type { RecordStore, VaultImage, VaultMeta } from "../src/vault/store.ts";
import { createHarness, nonEchoing } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";

const nip06 = loadVectors("nip06.json") as {
  vectors: Array<{ mnemonic: string; privateKey: string; publicKey: string; nsec: string }>;
};

const PASSWORD = utf8ToBytes("correct horse battery");
const WRONG = utf8ToBytes("a wrong password");

function ok(response: KernelResponse): ProtocolValue {
  if ("ok" in response) {
    return response.ok;
  }
  throw new Error(`expected ok, got ${JSON.stringify(response)}`);
}

function errCode(response: KernelResponse): string {
  if ("err" in response) {
    return response.err.code;
  }
  throw new Error(`expected err, got ${JSON.stringify(response)}`);
}

function errPayload(response: KernelResponse): { code: string; retryAt?: number } {
  if ("err" in response) {
    return response.err;
  }
  throw new Error(`expected err, got ${JSON.stringify(response)}`);
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    const entry = (value as Record<string, ProtocolValue>)[key];
    if (entry !== undefined) {
      return entry;
    }
  }
  throw new Error(`missing field ${key}`);
}

function strField(value: ProtocolValue, key: string): string {
  const v = field(value, key);
  if (typeof v === "string") {
    return v;
  }
  throw new Error(`${key} is not a string`);
}

function metaOf(image: VaultImage): VaultMeta {
  if (image.meta === undefined) {
    throw new Error("vault is not initialized");
  }
  return image.meta;
}

async function vaultHealth(h: Harness): Promise<ProtocolValue> {
  return field(ok(await h.call("status")), "vault");
}

async function createPasswordVault(h: Harness): Promise<string> {
  return strField(
    ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    ),
    "session",
  );
}

const badPassword = async (h: Harness) =>
  h.call("vault.unlock", { factor: { kind: "password", password: new Uint8Array(WRONG) } });

const goodPassword = async (h: Harness) =>
  h.call("vault.unlock", { factor: { kind: "password", password: new Uint8Array(PASSWORD) } });

const verify = () => ({ kind: "password" as const, password: new Uint8Array(PASSWORD) });

/** The KernelError code a promise rejects with — or how it otherwise ended. */
async function rejectCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof KernelError ? error.code : "not a KernelError";
  }
  return "no rejection";
}

/** A store writer puts a whole captured image back — meta included — with no DEK. */
async function restoreImage(store: RecordStore, image: VaultImage): Promise<void> {
  await store.commit([{ op: "clear" }]);
  await store.commit([
    { op: "init", meta: metaOf(image) },
    ...image.factors.map((factor) => ({ op: "put-factor" as const, factor })),
    ...image.records.map((record) => ({ op: "put-record" as const, record })),
  ]);
}

/** An anchor whose next `count` writes reject — a host failure mid-establish or mid-unlock. */
function rejectingWrites(inner: VaultAnchor, remaining: { count: number }): VaultAnchor {
  return {
    read: async () => inner.read(),
    replace: async (next, expected) => {
      if (remaining.count > 0) {
        remaining.count -= 1;
        throw new Error("keystore gone");
      }
      return inner.replace(next, expected);
    },
  };
}

/** A store whose next `remaining` clear commits reject — a failing erase, nothing else. */
function rejectingClears(inner: RecordStore, remaining: { count: number }): RecordStore {
  return {
    load: async () => inner.load(),
    commit: async (ops) => {
      if (remaining.count > 0 && ops.some((op) => op.op === "clear")) {
        remaining.count -= 1;
        throw new Error("disk gone");
      }
      return inner.commit(ops);
    },
    watch: (listener) => inner.watch(listener),
  };
}

/** Runs `inject` on the first call only, then passes through — plants an interleave mid-read. */
function interleave<A extends ReadonlyArray<unknown>, R>(
  run: (...args: A) => Promise<R>,
  inject: () => Promise<void>,
): (...args: A) => Promise<R> {
  let once = true;
  return async (...args) => {
    if (once) {
      once = false;
      await inject();
    }
    return run(...args);
  };
}

/** A CAS that loses its first `losses` races — the update loop must retry past them. */
function racingCas(
  inner: VaultAnchor,
  losses: number,
): {
  readonly anchor: VaultAnchor;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    anchor: {
      read: async () => inner.read(),
      replace: async (next, expected) => {
        calls += 1;
        return calls <= losses ? Promise.resolve(false) : inner.replace(next, expected);
      },
    },
    calls: () => calls,
  };
}

describe("vault anchor — revision floor", () => {
  it("a pre-commit image put back while locked reads corrupted before any unlock", async () => {
    const h = createHarness({ seed: 60, idleMs: 60_000 });
    const session = await createPasswordVault(h);
    const snapshot = await h.store.load();
    // A structural commit bumps the revision and the kernel seals it — the floor follows.
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: verify() }, session));
    h.advance(61_000); // idle lock: the restore must be caught locked, not via the session
    await h.settle();

    await restoreImage(h.store, snapshot);
    await h.settle();
    await expect(vaultHealth(h)).resolves.toBe("corrupted");
    expect(errCode(await goodPassword(h))).toBe("integrity");
  });

  it("a pre-commit image put back under a live session invalidates it", async () => {
    const h = createHarness({ seed: 61 });
    const session = await createPasswordVault(h);
    const snapshot = await h.store.load();
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: verify() }, session));

    await restoreImage(h.store, snapshot);
    await h.settle();
    await expect(vaultHealth(h)).resolves.toBe("corrupted");
    expect(errCode(await h.call("session.touch", null, session))).toBe("integrity");
  });

  it("an old image whose revision was rewritten up to the floor fails the manifest", async () => {
    const h = createHarness({ seed: 62 });
    const session = await createPasswordVault(h);
    const snapshot = await h.store.load();
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: verify() }, session));
    const floorState = await readAnchor(h.anchor);
    // The writer lifts the replayed revision to the floor: the floor check passes but the
    // manifest — which binds the revision under the DEK — does not.
    const meta = { ...metaOf(snapshot), revision: floorState.revision };
    await restoreImage(h.store, { ...snapshot, meta });

    const fresh = createHarness({ store: h.store, anchor: h.anchor, seed: 63 });
    await fresh.settle();
    await expect(vaultHealth(fresh)).resolves.toBe("locked");
    expect(errCode(await goodPassword(fresh))).toBe("integrity");
    await expect(vaultHealth(fresh)).resolves.toBe("corrupted");
  });

  it("an inflated revision while locked never raises the anchor", async () => {
    const h = createHarness({ seed: 64, idleMs: 60_000 });
    await createPasswordVault(h);
    const image = await h.store.load();
    h.advance(61_000); // lock: the inflated image is unauthenticated and must not move the floor
    await h.settle();

    await restoreImage(h.store, { ...image, meta: { ...metaOf(image), revision: 9999 } });
    await h.settle();
    await expect(vaultHealth(h)).resolves.toBe("locked");
    await expect(readAnchor(h.anchor)).resolves.toStrictEqual({
      revision: 1,
      failedAttempts: 0,
      lastFailureAt: 0,
    });
  });

  it("establish starts at the anchor floor + 1", async () => {
    const anchor = createMemoryAnchor();
    await anchor.replace(
      encodeAnchor({ revision: 40, failedAttempts: 7, lastFailureAt: 123 }),
      undefined,
    );
    const h = createHarness({ anchor, seed: 65 });
    await h.settle();
    await createPasswordVault(h);

    const image = await h.store.load();
    expect(image.meta?.revision).toBe(41);
    await expect(readAnchor(anchor)).resolves.toStrictEqual({
      revision: 41,
      failedAttempts: 0,
      lastFailureAt: 0,
    });
  });

  it("an anchor failure after the init commit keeps the sealed vault and its keys", async () => {
    const inner = createMemoryAnchor();
    const anchor = rejectingWrites(inner, { count: 1 });
    const fk = fakeKeystore();
    const h = createHarness({ keystore: fk.keystore, anchor, noIdle: true });
    await h.settle();
    const before = fk.calls.length;

    expect(
      errCode(
        await h.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
          factor: { kind: "device" },
        }),
      ),
    ).toBe("unavailable");
    // The init landed and the floor write failed: the sealed vault and its hardware keys stay.
    const image = await h.store.load();
    expect(image.meta).toBeDefined();
    expect(fk.calls.slice(before).filter((call) => call.op === "clear")).toHaveLength(1);

    // The vault is openable, and a successful unlock raises the floor to its revision.
    ok(await h.call("vault.unlock", { factor: { kind: "hardware" } }));
    await expect(readAnchor(inner)).resolves.toMatchObject({ revision: 1 });
  });
});

describe("vault anchor — reset", () => {
  it("an erased image put back after reset reads corrupted", async () => {
    const h = createHarness({ seed: 66 });
    const session = await createPasswordVault(h);
    const snapshot = await h.store.load();
    ok(await h.call("vault.reset", null, session));
    // Reset raised the floor past the erased image.
    await expect(readAnchor(h.anchor)).resolves.toStrictEqual({
      revision: 2,
      failedAttempts: 0,
      lastFailureAt: 0,
    });

    await restoreImage(h.store, snapshot);
    await h.settle();
    await expect(vaultHealth(h)).resolves.toBe("corrupted");
    expect(errCode(await goodPassword(h))).toBe("integrity");
  });

  it("reset recovers a garbage anchor and writes revision 1", async () => {
    const h = createHarness({ seed: 67 });
    const session = await createPasswordVault(h);
    const stored = await h.anchor.read();
    await h.anchor.replace(new Uint8Array([0xff, 0x01]), stored);

    ok(await h.call("vault.reset", null, session));
    await expect(readAnchor(h.anchor)).resolves.toStrictEqual({
      revision: 1,
      failedAttempts: 0,
      lastFailureAt: 0,
    });
  });

  it("a clear failing after the floor rose leaves the vault corrupted — a second reset finishes it", async () => {
    const clears = { count: 1 };
    const h = createHarness({
      seed: 69,
      wrapStore: (inner) => rejectingClears(inner, clears),
    });
    const session = await createPasswordVault(h);
    // Reset raised the floor first, then the erase failed: the image still in the store is now
    // below the floor, so the vault reads corrupted — the recovery path is another reset.
    expect(errCode(await h.call("vault.reset", null, session))).toBe("unavailable");
    await h.store.commit([{ op: "expect-revision", revision: 1 }]);
    await h.settle();
    await expect(vaultHealth(h)).resolves.toBe("corrupted");

    ok(await h.call("vault.reset", null));
    await expect(readAnchor(h.anchor)).resolves.toStrictEqual({
      revision: 3,
      failedAttempts: 0,
      lastFailureAt: 0,
    });
    await expect(vaultHealth(h)).resolves.toBe("uninitialized");
  });
});

describe("vault anchor — failure counters", () => {
  it("restoring the store cannot disarm the armed backoff", async () => {
    const h = createHarness({ wrapStore: nonEchoing, seed: 68 });
    await h.settle();
    await createPasswordVault(h);
    const fresh = createHarness({ store: h.store, anchor: h.anchor, wrapStore: nonEchoing });
    await fresh.settle();
    const snapshot = await h.store.load();

    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- unlock attempts are sequential by design
      expect(errCode(await badPassword(fresh))).toBe("wrong-password");
    }
    const armed = await badPassword(fresh);
    expect(errCode(armed)).toBe("rate-limited");
    expect(errPayload(armed).retryAt).toBeTypeOf("number");

    // The store writer restores the pre-failure image; the counters are not there — they live
    // in the anchor — so the backoff stays armed.
    await restoreImage(h.store, snapshot);
    await fresh.settle();
    const still = await badPassword(fresh);
    expect(errCode(still)).toBe("rate-limited");
    await expect(readAnchor(h.anchor)).resolves.toMatchObject({ failedAttempts: 5 });

    // A successful unlock clears the anchor counters.
    fresh.advanceWall(31_000);
    ok(await goodPassword(fresh));
    await expect(readAnchor(h.anchor)).resolves.toStrictEqual({
      revision: 1,
      failedAttempts: 0,
      lastFailureAt: 0,
    });
  });
});

describe("vault anchor — concurrent kernels", () => {
  it("a commit landing between the anchor read and the store load is no false corruption", async () => {
    const store = createMemoryStore();
    const anchor = createMemoryAnchor();
    const a = createHarness({ store, anchor, seed: 70 });
    const sessionA = await createPasswordVault(a);
    const commit = async () => {
      ok(await a.call("vault.setBlindSigning", { enabled: true, verify: verify() }, sessionA));
      await a.settle();
    };

    // Kernel B boots on the same host: its reload reads the anchor first, then the store. A's
    // commit (plus A's own floor raise) lands inside that window — the floor B read can only be
    // at or below the image B then loads, so a legal concurrent commit cannot read corrupted.
    const b = createHarness({
      store,
      anchor,
      seed: 71,
      wrapStore: (inner) => ({
        load: interleave(async () => inner.load(), commit),
        commit: async (ops) => inner.commit(ops),
        watch: (listener) => inner.watch(listener),
      }),
    });
    await b.settle();
    await expect(vaultHealth(b)).resolves.toBe("locked");
    ok(await goodPassword(b));
  });

  it("the anchor read precedes the store load, so a mid-flight commit cannot false-corrupt", async () => {
    const store = createMemoryStore();
    const anchor = createMemoryAnchor();
    const a = createHarness({ store, anchor, seed: 74 });
    const sessionA = await createPasswordVault(a);
    const commit = async () => {
      ok(await a.call("vault.setBlindSigning", { enabled: true, verify: verify() }, sessionA));
      await a.settle();
    };

    // The discriminating window: B's anchor read makes A commit first and only then reads the
    // floor. Read in the declared order, B sees floor 2 against the post-commit image — a match.
    // Read the store first (a regression), B would hold the pre-commit image against floor 2.
    const b = createHarness({
      store,
      anchor,
      seed: 75,
      wrapAnchor: (inner) => ({
        read: interleave(async () => inner.read(), commit),
        replace: async (next, expected) => inner.replace(next, expected),
      }),
    });
    await b.settle();
    await expect(vaultHealth(b)).resolves.toBe("locked");
    ok(await goodPassword(b));
  });

  it("concurrent failure records from two kernels are both counted", async () => {
    const store = createMemoryStore();
    const anchor = createMemoryAnchor();
    const a = createHarness({ store, anchor, seed: 72 });
    await a.settle();
    await createPasswordVault(a);
    const b = createHarness({ store, anchor, seed: 73 });
    await b.settle();

    const results = await Promise.all([
      badPassword(a),
      badPassword(b),
      badPassword(a),
      badPassword(b),
      badPassword(a),
    ]);
    // Five concurrent misses under the armed threshold: every CAS retry preserves its increment.
    for (const response of results) {
      expect(errCode(response)).toBe("wrong-password");
    }
    await expect(readAnchor(anchor)).resolves.toMatchObject({ failedAttempts: 5 });
  });
});

describe("vault anchor — updateAnchor", () => {
  const bump = (state: AnchorState): AnchorState => ({
    ...state,
    failedAttempts: state.failedAttempts + 1,
  });

  it("retries a lost CAS race and lands the update", async () => {
    const inner = createMemoryAnchor();
    const { anchor, calls } = racingCas(inner, 3);
    await updateAnchor(anchor, bump);
    await expect(readAnchor(inner)).resolves.toMatchObject({ failedAttempts: 1 });
    expect(calls()).toBe(4);
  });

  it("reports conflict after eight lost races", async () => {
    const anchor: VaultAnchor = {
      read: async () => Promise.resolve(encodeAnchor(ZERO_STATE)),
      replace: async () => Promise.resolve(false),
    };
    await expect(rejectCode(updateAnchor(anchor, bump))).resolves.toBe("conflict");
  });

  it("maps host rejections to unavailable", async () => {
    const rejected: VaultAnchor = {
      read: async () => Promise.reject(new Error("disk gone")),
      replace: async () => Promise.reject(new Error("disk gone")),
    };
    await expect(rejectCode(readAnchor(rejected))).resolves.toBe("unavailable");
    await expect(rejectCode(updateAnchor(rejected, bump))).resolves.toBe("unavailable");
    const written = createMemoryAnchor();
    const replaceFails: VaultAnchor = {
      read: async () => written.read(),
      replace: async () => Promise.reject(new Error("disk gone")),
    };
    await expect(rejectCode(updateAnchor(replaceFails, bump))).resolves.toBe("unavailable");
  });
});

const ZERO_STATE: AnchorState = { revision: 0, failedAttempts: 0, lastFailureAt: 0 };

describe("vault anchor — record vectors", () => {
  const vectors = loadVectors("vault-anchor.json") as {
    accept: ReadonlyArray<{
      name: string;
      state: AnchorState;
      hex: string;
    }>;
    reject: ReadonlyArray<{ name: string; hex: string }>;
  };

  it.each(vectors.accept.map((v) => [v.name, v] as const))(
    "accept %s: decode matches the fields and encodes back to the hex",
    (_name, vector) => {
      expect(decodeAnchor(hexToBytes(vector.hex))).toStrictEqual(vector.state);
      expect(encodeAnchor(vector.state)).toStrictEqual(hexToBytes(vector.hex));
    },
  );

  it.each(vectors.reject.map((v) => [v.name, v] as const))(
    "reject %s: decode throws integrity",
    (_name, vector) => {
      expect(() => decodeAnchor(hexToBytes(vector.hex))).toThrow(KernelError);
    },
  );

  it("a stored record that does not decode reads as an integrity failure", async () => {
    const anchor = createMemoryAnchor();
    await anchor.replace(hexToBytes(vectors.reject[0]!.hex), undefined);
    await expect(rejectCode(readAnchor(anchor))).resolves.toBe("integrity");
  });
});
