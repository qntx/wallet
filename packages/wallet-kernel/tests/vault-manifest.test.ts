/**
 * The vault's structure is authenticated under the DEK: a store writer without the DEK cannot
 * replay a row the vault dropped, delete or add one, or rewrite the format — the next reload under
 * a session (or the next unlock) latches the vault corrupted instead of trusting the store.
 */
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import type { KernelPlatform } from "../src/platform.ts";
import { Secret } from "../src/secret/secret.ts";
import { assertManifest, manifestDigest, withManifest } from "../src/vault/manifest.ts";
import type { RecordStore, StoredFactor, StoredRecord, VaultImage } from "../src/vault/store.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = hexToBytes("11".repeat(32));
const PRF_WALLET = hexToBytes("22".repeat(32));
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

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
  if (typeof v !== "string") {
    throw new TypeError(`field ${key} is not a string`);
  }
  return v;
}

const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF_VAULT),
});

const backupPassword = (text: string) => ({
  kind: "password" as const,
  password: utf8ToBytes(text),
});

async function passkeyVault(h: Harness): Promise<string> {
  await h.settle();
  const res = ok(
    await h.call("wallet.createWithPasskey", {
      ceremony: "host",
      credentialId: CREDENTIAL_ID,
      prfWallet: new Uint8Array(PRF_WALLET),
      synced: true,
      factor: verifyPasskey(),
    }),
  );
  return strField(res, "session");
}

function rowOf(image: VaultImage, kind: string): StoredRecord {
  const record = image.records.find((r) => r.kind === kind);
  if (record === undefined) {
    throw new Error(`missing ${kind} record`);
  }
  return record;
}

function factorOf(image: VaultImage, kind: string): StoredFactor {
  const factor = image.factors.find((f) => f.kind === kind);
  if (factor === undefined) {
    throw new Error(`missing ${kind} factor`);
  }
  return factor;
}

const withFormat =
  (format: number) =>
  (image: VaultImage): VaultImage =>
    image.meta === undefined ? image : { ...image, meta: { ...image.meta, format } };

/** A store writer rewrites the whole image in place — meta included — with no DEK. */
async function rewriteImage(store: RecordStore, edit: (image: VaultImage) => VaultImage) {
  const image = edit(await store.load());
  const { meta } = image;
  if (meta === undefined) {
    throw new Error("vault is not initialized");
  }
  await store.commit([{ op: "clear" }]);
  await store.commit([
    { op: "init", meta },
    ...image.factors.map((factor) => ({ op: "put-factor" as const, factor })),
    ...image.records.map((record) => ({ op: "put-record" as const, record })),
  ]);
}

async function vaultHealth(h: Harness): Promise<ProtocolValue> {
  return field(ok(await h.call("status")), "vault");
}

describe("replayed rows", () => {
  it("a blind-signing policy row the owner turned off corrupts the vault when put back", async () => {
    const h = createHarness({ seed: 30 });
    const session = await passkeyVault(h);
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: verifyPasskey() }, session));
    const captured = rowOf(await h.store.load(), "policy");
    ok(await h.call("vault.setBlindSigning", { enabled: false, verify: verifyPasskey() }, session));

    await h.store.commit([{ op: "put-record", record: captured }]);
    await h.settle();
    await expect(vaultHealth(h)).resolves.toBe("corrupted");
    expect(errCode(await h.call("session.touch", null, session))).toBe("integrity");
  });

  it("a retired backup-key row corrupts the vault instead of reinstating its key", async () => {
    const h = createHarness({ seed: 41 });
    const session = await passkeyVault(h);
    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPassword("old-backup-password-1")] },
        session,
      ),
    );
    const captured = rowOf(await h.store.load(), "backup-key");
    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPassword("new-backup-password-2")] },
        session,
      ),
    );

    await h.store.commit([{ op: "put-record", record: captured }]);
    await h.settle();
    await expect(vaultHealth(h)).resolves.toBe("corrupted");
    expect(errCode(await h.call("backup.update", null, session))).toBe("integrity");
  });

  it("a backup-key row put back after backup.disable corrupts the vault", async () => {
    const h = createHarness({ seed: 44 });
    const session = await passkeyVault(h);
    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPassword("old-backup-password-1")] },
        session,
      ),
    );
    const captured = rowOf(await h.store.load(), "backup-key");
    ok(await h.call("backup.disable", { verify: verifyPasskey() }, session));

    await h.store.commit([{ op: "put-record", record: captured }]);
    await h.settle();
    await expect(vaultHealth(h)).resolves.toBe("corrupted");
    expect(errCode(await h.call("backup.update", null, session))).toBe("integrity");
  });

  it("a row replayed while the vault is locked fails the next unlock", async () => {
    const h = createHarness({ seed: 45, idleMs: 60_000 });
    const session = await passkeyVault(h);
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: verifyPasskey() }, session));
    const captured = rowOf(await h.store.load(), "policy");
    ok(await h.call("vault.setBlindSigning", { enabled: false, verify: verifyPasskey() }, session));
    h.advance(61_000);
    await h.settle();

    await h.store.commit([{ op: "put-record", record: captured }]);
    const fresh = createHarness({ store: h.store, seed: 46 });
    await fresh.settle();
    expect(errCode(await fresh.call("vault.unlock", { factor: verifyPasskey() }))).toBe(
      "integrity",
    );
    await expect(vaultHealth(fresh)).resolves.toBe("corrupted");
  });
});

describe("dropped rows", () => {
  it("a deleted wallet record fails the next unlock", async () => {
    const h = createHarness({ seed: 47 });
    await passkeyVault(h);
    const wallet = rowOf(await h.store.load(), "entropy");
    await h.store.commit([{ op: "delete-record", kind: wallet.kind, id: wallet.id }]);

    const fresh = createHarness({ store: h.store, seed: 48 });
    await fresh.settle();
    expect(errCode(await fresh.call("vault.unlock", { factor: verifyPasskey() }))).toBe(
      "integrity",
    );
  });

  it("a deleted factor row corrupts the vault under a live session", async () => {
    const fk = fakeKeystore();
    const h = createHarness({ keystore: fk.keystore, noIdle: true });
    await h.settle();
    const session = strField(
      ok(
        await h.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(MNEMONIC),
          factor: { kind: "device" },
        }),
      ),
      "session",
    );
    const hardware = factorOf(await h.store.load(), "hardware");
    await h.store.commit([{ op: "delete-factor", id: hardware.id }]);
    await h.settle();
    await expect(vaultHealth(h)).resolves.toBe("corrupted");
    expect(errCode(await h.call("session.touch", null, session))).toBe("integrity");
  });

  it("a vault image without its manifest reads corrupted even while locked", async () => {
    const h = createHarness({ seed: 49 });
    await passkeyVault(h);
    const manifest = rowOf(await h.store.load(), "manifest");
    await h.store.commit([{ op: "delete-record", kind: manifest.kind, id: manifest.id }]);

    const fresh = createHarness({ store: h.store, seed: 50 });
    await fresh.settle();
    await expect(vaultHealth(fresh)).resolves.toBe("corrupted");
  });
});

describe("vault format", () => {
  it("a format a store writer rolled back is unsupported, never upgraded", async () => {
    const fk = fakeKeystore();
    const h = createHarness({ keystore: fk.keystore, noIdle: true });
    await h.settle();
    const session = strField(
      ok(
        await h.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(MNEMONIC),
          factor: { kind: "device" },
        }),
      ),
      "session",
    );
    ok(await h.call("vault.setAppLock", { enabled: true, verify: { kind: "hardware" } }, session));
    for (const format of [3, 4]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one rewrite per older format
      await rewriteImage(h.store, withFormat(format));
      const fresh = createHarness({ store: h.store, keystore: fk.keystore, noIdle: true });
      // oxlint-disable-next-line eslint/no-await-in-loop -- one rewrite per older format
      await fresh.settle();
      // oxlint-disable-next-line eslint/no-await-in-loop -- one rewrite per older format
      await expect(vaultHealth(fresh)).resolves.toBe("unsupported");
      // oxlint-disable-next-line eslint/no-await-in-loop -- one rewrite per older format
      const unlocked = await fresh.call("vault.unlock", { factor: { kind: "hardware" } });
      expect(errCode(unlocked)).toBe("unsupported");
      // oxlint-disable-next-line eslint/no-await-in-loop -- one rewrite per older format
      const { factors } = await h.store.load();
      expect(factors.map((f) => f.kind)).toStrictEqual(["hardware"]);
    }
  });
});

type VectorRow = { kind: string; id: string; header: string; sealed: string };
const vector = loadVectors("vault-manifest.json") as {
  image: {
    meta: {
      format: number;
      revision: number;
      keyId: string;
      failedAttempts: number;
      lastFailureAt: number;
    };
    records: VectorRow[];
    factors: VectorRow[];
  };
  digest: string;
  dek: string;
  nonce: string;
  manifest: VectorRow;
};

const fromHex = (row: VectorRow) => ({ ...row, sealed: hexToBytes(row.sealed) });
const vectorImage: VaultImage = {
  meta: vector.image.meta,
  records: vector.image.records.map(fromHex),
  factors: vector.image.factors.map(fromHex),
};
const vectorDek = () => Secret.take(hexToBytes(vector.dek));
const sealedImage: VaultImage = {
  ...vectorImage,
  records: [...vectorImage.records, fromHex(vector.manifest)],
};

function rowAt(rows: ReadonlyArray<StoredRecord>, index: number): StoredRecord {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`missing row ${index}`);
  }
  return row;
}

/** The row with its last sealed byte flipped. */
function flipped(row: StoredRecord): StoredRecord {
  const sealed = Uint8Array.from(row.sealed);
  sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 1;
  return { ...row, sealed };
}

function structureFailure(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof KernelError ? { code: error.code, corrupted: error.corrupted } : error;
  }
  return "no failure";
}

describe("manifest vector", () => {
  it("digests the image's structure exactly as the vector spells it", () => {
    expect(manifestDigest(vectorImage)).toStrictEqual(hexToBytes(vector.digest));
    // Row order in the store does not matter; the manifest record itself is left out.
    const reordered: VaultImage = {
      ...sealedImage,
      records: sealedImage.records.toReversed(),
      factors: vectorImage.factors.toReversed(),
    };
    expect(manifestDigest(reordered)).toStrictEqual(hexToBytes(vector.digest));
  });

  it("seals the manifest record byte for byte", () => {
    const platform = { random: () => hexToBytes(vector.nonce) } as unknown as KernelPlatform;
    const image: VaultImage = { ...vectorImage, records: vectorImage.records.slice(1) };
    const ops = withManifest(
      platform,
      image,
      [{ op: "put-record", record: rowAt(vectorImage.records, 0) }],
      vectorDek(),
    );
    expect(ops.at(-1)).toStrictEqual({ op: "put-record", record: fromHex(vector.manifest) });
  });

  it("accepts the sealed image and rejects any change to what it covers", () => {
    expect(() => {
      assertManifest(vectorDek(), sealedImage);
    }).not.toThrow();
    const corrupted = { code: "integrity", corrupted: true };
    const first = rowAt(sealedImage.records, 0);
    const rest = sealedImage.records.slice(1);
    const variants: ReadonlyArray<VaultImage> = [
      { ...sealedImage, meta: { ...vector.image.meta, format: 4 } },
      { ...sealedImage, meta: { ...vector.image.meta, keyId: "ff".repeat(16) } },
      { ...sealedImage, records: rest },
      { ...sealedImage, records: [flipped(first), ...rest] },
      {
        ...sealedImage,
        records: [...sealedImage.records, { ...first, id: "extra" }],
      },
      { ...sealedImage, factors: sealedImage.factors.slice(1) },
      { ...sealedImage, records: vectorImage.records },
      { ...sealedImage, records: [...sealedImage.records, fromHex(vector.manifest)] },
    ];
    for (const image of variants) {
      expect(structureFailure(() => assertManifest(vectorDek(), image))).toStrictEqual(corrupted);
    }
    // Counters change without a session and stay outside the manifest.
    expect(() => {
      assertManifest(vectorDek(), {
        ...sealedImage,
        meta: { ...vector.image.meta, failedAttempts: 9 },
      });
    }).not.toThrow();
    // Another DEK cannot vouch for it.
    expect(
      structureFailure(() => assertManifest(Secret.take(new Uint8Array(32)), sealedImage)),
    ).toStrictEqual(corrupted);
  });
});

describe("structural commits", () => {
  it("a hardware unlock that drops the dead device row keeps the vault healthy", async () => {
    const fk = fakeKeystore();
    const h = createHarness({ keystore: fk.keystore, noIdle: true });
    await h.settle();
    ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const device = factorOf(await h.store.load(), "device");
    // The device key is gone for good: the next hardware unlock's probe drops its row in a
    // commit whose only op is the delete.
    fk.invalidate(device.id);

    const unlocked = createHarness({ keystore: fk.keystore, store: h.store, noIdle: true });
    await unlocked.settle();
    ok(await unlocked.call("vault.unlock", { factor: { kind: "hardware" } }));
    const after = await h.store.load();
    expect(after.factors.some((f) => f.kind === "device")).toBe(false);

    const fresh = createHarness({ keystore: fk.keystore, store: h.store });
    await fresh.settle();
    await expect(vaultHealth(fresh)).resolves.toBe("locked");
    ok(await fresh.call("vault.unlock", { factor: { kind: "hardware" } }));
  });
});
