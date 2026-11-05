// BIP-39 passphrase ("25th word"): wallets derive from mnemonic + passphrase, the passphrase is
// sealed after the entropy in the wallet record, and it never enters a cloud backup payload.

import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";
import type { WalletErrorCode, WalletInfo } from "@qntx/wallet/types";

import type { KernelPlatform } from "../src/platform.ts";
import { Secret } from "../src/secret/secret.ts";
import { open as openEnvelope } from "../src/vault/envelope.ts";
import { passwordKek } from "../src/vault/factors.ts";
import { encodeHeader, parseEntropyHeader } from "../src/vault/headers.ts";
import type { StoredRecord } from "../src/vault/store.ts";
import { openWalletSecret, sealRecord } from "../src/vault/vault.ts";
import { createHarness, seededRandom } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { kernelError, loadVectors, subtlePbkdf2 } from "./helpers.ts";

type PassphraseVector = {
  name: string;
  mnemonic: string;
  passphrase: string;
  seed: string;
  evmAddress: string;
  nostrPublicKey: string;
};
type WalletIdVector = { name: string; walletId: string };
const bip39 = loadVectors("bip39.json") as { passphrase: PassphraseVector[] };
const walletIds = (loadVectors("wallet-id.json") as { passphrase: WalletIdVector[] }).passphrase;
const backupVector = loadVectors("backup.json") as {
  inputs: { password: string };
  id: string;
  passphrase: {
    passphrase: string;
    walletId: string;
    plainWalletId: string;
    header: string;
    envelope: string;
  };
};
const envelopeVectors = (
  loadVectors("envelope.json") as {
    vectors: Array<{ header: string; context: string; plaintext: string }>;
  }
).vectors;

const vectorOf = (name: string): PassphraseVector => {
  const found = bip39.passphrase.find((v) => v.name === name);
  if (found === undefined) {
    throw new Error(`no passphrase vector ${name}`);
  }
  return found;
};
const walletIdOfVector = (name: string): string => {
  const found = walletIds.find((v) => v.name === name);
  if (found === undefined) {
    throw new Error(`no walletId vector ${name}`);
  }
  return found.walletId;
};

const COMPOSED = vectorOf("composed-accents");
const MNEMONIC = COMPOSED.mnemonic;
const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = hexToBytes("11".repeat(32));
const passkeyFactor = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF_VAULT),
});
const text = (value: string): Uint8Array => utf8ToBytes(value);

function ok(response: KernelResponse): ProtocolValue {
  if ("ok" in response) {
    return response.ok;
  }
  throw new Error(`expected ok, got ${JSON.stringify(response)}`);
}

function errCode(response: KernelResponse): WalletErrorCode {
  if ("err" in response) {
    return response.err.code;
  }
  throw new Error("expected err");
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

const strField = (value: ProtocolValue, key: string): string => {
  const entry = field(value, key);
  if (typeof entry !== "string") {
    throw new TypeError(`field ${key} is not a string`);
  }
  return entry;
};

const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  const entry = field(value, key);
  if (!(entry instanceof Uint8Array)) {
    throw new TypeError(`field ${key} is not bytes`);
  }
  return entry;
};

const hasField = (value: ProtocolValue, key: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Uint8Array) &&
  key in (value as Record<string, ProtocolValue>);

const listField = (value: ProtocolValue, key: string): ReadonlyArray<ProtocolValue> => {
  const entry = field(value, key);
  if (!Array.isArray(entry)) {
    throw new TypeError(`field ${key} is not an array`);
  }
  return entry;
};

async function importFirst(h: Harness, passphrase?: Uint8Array, mnemonic = MNEMONIC) {
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: text(mnemonic),
      ...(passphrase === undefined ? {} : { passphrase }),
      factor: passkeyFactor(),
    }),
  );
  return { session: strField(res, "session"), wallet: field(res, "wallet") };
}

async function importMore(h: Harness, session: string, passphrase?: Uint8Array) {
  return h.call(
    "wallet.importMnemonic",
    { mnemonic: text(MNEMONIC), ...(passphrase === undefined ? {} : { passphrase }) },
    session,
  );
}

async function walletsOf(h: Harness, session: string): Promise<WalletInfo[]> {
  const status = ok(await h.call("status", undefined, session));
  return listField(status, "wallets") as unknown as WalletInfo[];
}

async function evmAddress(h: Harness, session: string, walletId: string): Promise<string> {
  const res = ok(
    await h.call(
      "wallet.accounts",
      { walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
      session,
    ),
  );
  return strField(res, "address");
}

const wordAt = (words: ReadonlyArray<string>, position: ProtocolValue): Uint8Array =>
  text(words[Number(position)] ?? "");

const syncPublicKeyOf = (seedHex: string): string => {
  const secret = HDKey.fromMasterSeed(hexToBytes(seedHex)).derive(
    "m/44'/1237'/2147483647'/0/0",
  ).privateKey;
  if (secret === null) {
    throw new Error("no sync key");
  }
  return Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
};

const passphraseEnvelopeVector = () => {
  const vector = envelopeVectors.find((v) => v.header.includes('"passphrase":true'));
  if (vector === undefined) {
    throw new Error("no passphrase envelope vector");
  }
  return vector;
};

const onlyFactor = <T>(factors: ReadonlyArray<T>): T => {
  const [factor] = factors;
  if (factor === undefined) {
    throw new Error("no factor");
  }
  return factor;
};

describe("import with a passphrase", () => {
  it("derives a separate wallet from the same mnemonic; both coexist", async () => {
    const h = createHarness();
    await h.settle();
    const { session, wallet: plain } = await importFirst(h);
    expect(field(plain, "passphrase")).toBe(false);

    const res = ok(await importMore(h, session, text("p\u00E4ssw\u00F6rd")));
    const wallet = field(res, "wallet");
    expect(field(wallet, "passphrase")).toBe(true);
    expect(strField(wallet, "walletId")).toBe(walletIdOfVector("composed-accents"));
    expect(strField(wallet, "walletId")).not.toBe(strField(plain, "walletId"));
    expect(strField(wallet, "backup")).toBe("mnemonic");

    const listed = await walletsOf(h, session);
    expect(listed.map((w) => Number(w.passphrase)).toSorted((a, b) => a - b)).toStrictEqual([0, 1]);
  });

  it("the same passphrase twice is already-exists, composed or decomposed", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await importFirst(h, text("p\u00E4ssw\u00F6rd"));
    expect(errCode(await importMore(h, session, text("p\u00E4ssw\u00F6rd")))).toBe(
      "already-exists",
    );
    // NFKD equivalence: the decomposed spelling is the same passphrase.
    expect(errCode(await importMore(h, session, text("pa\u0308sswo\u0308rd")))).toBe(
      "already-exists",
    );
  });

  it("normalizes NFKD (kana, compatibility characters) and keeps spaces significant", async () => {
    const h = createHarness();
    await h.settle();
    const { session, wallet } = await importFirst(h, text("\u30AC\uFF76\uFF9E \u2460"));
    expect(strField(wallet, "walletId")).toBe(walletIdOfVector("kana-and-compat"));
    const spaced = ok(await importMore(h, session, text(" a")));
    expect(strField(field(spaced, "wallet"), "walletId")).toBe(walletIdOfVector("leading-space"));
    const bare = ok(await importMore(h, session, text("a")));
    expect(strField(field(bare, "wallet"), "walletId")).toBe(walletIdOfVector("no-space"));
  });

  it("rejects a passphrase over 1024 bytes after NFKD and invalid UTF-8", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await importFirst(h);
    // Raw 120 bytes; NFKD expands each U+FDFA into 18 Arabic letters (well past 1024 bytes).
    expect(errCode(await importMore(h, session, text("\uFDFA".repeat(40))))).toBe("invalid-input");
    expect(errCode(await importMore(h, session, new Uint8Array([0xff, 0xfe])))).toBe(
      "invalid-input",
    );
    await expect(walletsOf(h, session)).resolves.toHaveLength(1);
  });

  it("wipes the passphrase buffer it was given", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await importFirst(h);
    const passphrase = text("secret");
    ok(await importMore(h, session, passphrase));
    expect(passphrase.every((b) => b === 0)).toBe(true);
  });
});

describe("create with a passphrase", () => {
  const confirmWith = async (seed: number, passphrase?: Uint8Array) => {
    const h = createHarness({ seed });
    await h.settle();
    const draft = ok(await h.call("wallet.createMnemonic", { words: 12, factor: passkeyFactor() }));
    const words = new TextDecoder().decode(bytesField(draft, "words")).split(" ");
    const answers = listField(draft, "quiz").map((position) => wordAt(words, position));
    const res = ok(
      await h.call("wallet.confirmMnemonic", {
        draft: strField(draft, "draft"),
        answers,
        ...(passphrase === undefined ? {} : { passphrase }),
      }),
    );
    return { h, res, words: words.join(" "), session: strField(res, "session") };
  };

  it("confirm with a passphrase flags the wallet and changes its addresses", async () => {
    const withPassphrase = await confirmWith(7, text("p\u00E4ssw\u00F6rd"));
    const without = await confirmWith(7);
    expect(withPassphrase.words).toBe(without.words);
    const a = field(withPassphrase.res, "wallet");
    const b = field(without.res, "wallet");
    expect(field(a, "passphrase")).toBe(true);
    expect(field(b, "passphrase")).toBe(false);
    expect(strField(a, "backup")).toBe("mnemonic");
    expect(strField(a, "walletId")).not.toBe(strField(b, "walletId"));
    const addressA = await evmAddress(
      withPassphrase.h,
      withPassphrase.session,
      strField(a, "walletId"),
    );
    const addressB = await evmAddress(without.h, without.session, strField(b, "walletId"));
    expect(addressA).not.toBe(addressB);
  });

  it("an invalid passphrase at confirm keeps the draft so the user can retry", async () => {
    const h = createHarness({ seed: 9 });
    await h.settle();
    const draft = ok(await h.call("wallet.createMnemonic", { words: 12, factor: passkeyFactor() }));
    const words = new TextDecoder().decode(bytesField(draft, "words")).split(" ");
    const answers = () => listField(draft, "quiz").map((position) => wordAt(words, position));
    const id = strField(draft, "draft");
    expect(
      errCode(
        await h.call("wallet.confirmMnemonic", {
          draft: id,
          answers: answers(),
          passphrase: new Uint8Array([0xff]),
        }),
      ),
    ).toBe("invalid-input");
    const retry = ok(
      await h.call("wallet.confirmMnemonic", {
        draft: id,
        answers: answers(),
        passphrase: text("fine"),
      }),
    );
    expect(field(field(retry, "wallet"), "passphrase")).toBe(true);
  });
});

describe("derivations use the passphrase seed", () => {
  it("accounts, nostr identity and the sync key come from the passphrase seed", async () => {
    const h = createHarness();
    await h.settle();
    const { session, wallet } = await importFirst(h, text("p\u00E4ssw\u00F6rd"));
    const walletId = strField(wallet, "walletId");

    await expect(evmAddress(h, session, walletId)).resolves.toBe(COMPOSED.evmAddress);
    const derived = ok(await h.call("nostr.deriveKey", { walletId, index: 0 }, session));
    expect(strField(derived, "publicKey")).toBe(COMPOSED.nostrPublicKey);

    const sync = ok(await h.call("nostr.syncKey", { walletId }, session));
    expect(strField(sync, "publicKey")).toBe(syncPublicKeyOf(COMPOSED.seed));
  });

  it("the no-passphrase wallet of the same mnemonic keeps the plain addresses", async () => {
    const h = createHarness();
    await h.settle();
    const { session, wallet } = await importFirst(h);
    await expect(evmAddress(h, session, strField(wallet, "walletId"))).resolves.toBe(
      "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    );
  });
});

describe("export", () => {
  it("returns the mnemonic and the NFKD passphrase bytes; none without a passphrase", async () => {
    const h = createHarness();
    await h.settle();
    const { session, wallet } = await importFirst(h, text("pa\u0308sswo\u0308rd"));
    const exported = ok(
      await h.call(
        "wallet.exportMnemonic",
        { verify: passkeyFactor(), walletId: strField(wallet, "walletId") },
        session,
      ),
    );
    expect(new TextDecoder().decode(bytesField(exported, "mnemonic"))).toBe(MNEMONIC);
    expect(bytesField(exported, "passphrase")).toStrictEqual(
      text("p\u00E4ssw\u00F6rd".normalize("NFKD")),
    );

    const plain = ok(await importMore(h, session));
    const plainExport = ok(
      await h.call(
        "wallet.exportMnemonic",
        { verify: passkeyFactor(), walletId: strField(field(plain, "wallet"), "walletId") },
        session,
      ),
    );
    expect(hasField(plainExport, "passphrase")).toBe(false);
    expect(new TextDecoder().decode(bytesField(plainExport, "mnemonic"))).toBe(MNEMONIC);
  });
});

/** A `random` whose first 32-byte draw (the vault DEK of the first create/import) is `dek`. */
function dekRandom(dek: Uint8Array, seed: number): KernelPlatform["random"] {
  const rest = seededRandom(seed).random;
  let first = true;
  return (length) => {
    if (first) {
      first = false;
      return new Uint8Array(dek);
    }
    return rest(length);
  };
}

describe("record integrity", () => {
  const DEK = new Uint8Array(32).fill(0x5a);
  const platform = { random: seededRandom(5).random } as unknown as KernelPlatform;

  async function tampered(
    mutate: (header: Record<string, unknown>, plaintext: Uint8Array) => [string, Uint8Array],
  ) {
    const h = createHarness({ random: dekRandom(DEK, 3) });
    await h.settle();
    await importFirst(h, text("secret"));
    const image = await h.store.load();
    const record = image.records.find((r) => r.kind === "entropy");
    if (record === undefined) {
      throw new Error("no entropy record");
    }
    const header = JSON.parse(record.header) as Record<string, unknown>;
    const plaintext = openWalletPlaintext(record);
    const [nextHeader, nextPlaintext] = mutate(header, plaintext);
    const sealed = sealRecord(
      platform,
      Secret.take(new Uint8Array(DEK)),
      "entropy",
      record.id,
      nextHeader,
      nextPlaintext,
    );
    await h.store.commit([{ op: "put-record", record: sealed }]);
    const h2 = createHarness({ store: h.store });
    await h2.settle();
    return h2;
  }

  /** The record's sealed plaintext (entropy ‖ passphrase) under the known test DEK. */
  function openWalletPlaintext(record: StoredRecord): Uint8Array {
    const { entropy, passphrase } = openWalletSecret(Secret.take(new Uint8Array(DEK)), record);
    return new Uint8Array([...entropy, ...(passphrase ?? [])]);
  }

  const unlock = async (h: Harness) =>
    errCode(await h.call("vault.unlock", { factor: passkeyFactor() }));

  it("a consistent re-sealed record still unlocks (harness control)", async () => {
    const h = await tampered((header, plaintext) => [JSON.stringify(header), plaintext]);
    expect("ok" in (await h.call("vault.unlock", { factor: passkeyFactor() }))).toBe(true);
  });

  it("a passphrase flag without passphrase bytes is integrity", async () => {
    const h = await tampered((header, plaintext) => [
      JSON.stringify(header),
      plaintext.slice(0, 16),
    ]);
    await expect(unlock(h)).resolves.toBe("integrity");
  });

  it("passphrase bytes without the flag are integrity", async () => {
    const h = await tampered((header, plaintext) => {
      const { passphrase: _flag, ...rest } = header;
      return [JSON.stringify(rest), plaintext];
    });
    await expect(unlock(h)).resolves.toBe("integrity");
  });

  it("a passphrase over 1024 bytes is integrity", async () => {
    const h = await tampered((header, plaintext) => [
      JSON.stringify(header),
      new Uint8Array([...plaintext.slice(0, 16), ...new Uint8Array(1025).fill(0x61)]),
    ]);
    await expect(unlock(h)).resolves.toBe("integrity");
  });

  it("a header with passphrase: false is integrity", async () => {
    const h = await tampered((header, plaintext) => [
      JSON.stringify({ ...header, passphrase: false }),
      plaintext,
    ]);
    await expect(unlock(h)).resolves.toBe("integrity");
  });
});

describe("entropy header", () => {
  const base = {
    walletId: "a8a96711dff685cb",
    origin: "mnemonic" as const,
    words: 12 as const,
    backup: "mnemonic" as const,
    createdAt: 1,
  };

  it("keeps the exact bytes of a wallet without a passphrase", () => {
    expect(encodeHeader(base)).toBe(
      '{"walletId":"a8a96711dff685cb","origin":"mnemonic","words":12,"backup":"mnemonic","createdAt":1}',
    );
  });

  it("puts passphrase right after words and round-trips", () => {
    const text = encodeHeader({ ...base, passphrase: true });
    expect(text).toBe(
      '{"walletId":"a8a96711dff685cb","origin":"mnemonic","words":12,"passphrase":true,"backup":"mnemonic","createdAt":1}',
    );
    expect(parseEntropyHeader(text)).toStrictEqual({ ...base, passphrase: true });
  });

  it.each([
    ["passphrase: false", { ...base, passphrase: false }],
    ["passphrase: 1", { ...base, passphrase: 1 }],
    ["a passkey wallet with a passphrase", { ...base, origin: "passkey", passphrase: true }],
    ["an extra key", { ...base, passphrase: true, extra: 1 }],
  ])("rejects %s", (_name, header) => {
    expect(kernelError(() => parseEntropyHeader(JSON.stringify(header)))).toBe("integrity");
  });

  it("the envelope vector record reads as entropy plus NFKD passphrase", () => {
    const vector = passphraseEnvelopeVector();
    const header = parseEntropyHeader(vector.header);
    expect(header.passphrase).toBe(true);
    const plaintext = hexToBytes(vector.plaintext);
    expect(plaintext.length - (header.words / 3) * 4).toBe(
      text("p\u00E4ssw\u00F6rd".normalize("NFKD")).length,
    );
    expect(vector.context).toBe(`qntx-wallet/vault/v1/record/entropy/${header.walletId}`);
  });
});

const backupPassword = () => ({
  kind: "password" as const,
  password: utf8ToBytes(backupVector.inputs.password),
});

describe("cloud backup", () => {
  it("never puts the passphrase in the payload; the header only flags it", async () => {
    const h = createHarness({ seed: 21 });
    await h.settle();
    const { session } = await importFirst(h, text("p\u00E4ssw\u00F6rd"));
    ok(
      await h.call(
        "backup.enable",
        { verify: passkeyFactor(), factors: [backupPassword()] },
        session,
      ),
    );
    const envelope = JSON.parse(
      strField(ok(await h.call("backup.update", null, session)), "envelope"),
    ) as {
      header: string;
      factors: Array<{ kind: string; salt: string; sealedBek: string }>;
      payload: string;
    };
    expect(JSON.parse(envelope.header)).toStrictEqual({
      wallets: [
        {
          walletId: walletIdOfVector("composed-accents"),
          origin: "mnemonic",
          words: 12,
          passphrase: true,
        },
      ],
    });
    const factor = onlyFactor(envelope.factors);
    const kek = await passwordKek(
      backupPassword().password,
      base64urlnopad.decode(factor.salt),
      subtlePbkdf2,
    );
    const bek = openEnvelope(
      kek,
      base64urlnopad.decode(factor.sealedBek),
      "qntx-wallet/backup/v1/factor/password",
      "",
    );
    const headerDigest = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", utf8ToBytes(envelope.header)),
    );
    const payload = openEnvelope(
      bek,
      base64urlnopad.decode(envelope.payload),
      `qntx-wallet/backup/v1/payload/${Buffer.from(headerDigest).toString("hex")}`,
      "",
    );
    // version(1) ‖ one entry: tag(1) ‖ origin(1) ‖ length(1) ‖ 16 entropy bytes — nothing more.
    expect(payload).toHaveLength(1 + 3 + 16);
    expect(Buffer.from(payload)).not.toContain(Buffer.from(text("sswo")));
  });

  const { passphrase: pv } = backupVector;
  const restoreInto = async (h: Harness, session: string | undefined, extra: object = {}) =>
    h.call(
      "backup.restore",
      {
        envelope: pv.envelope,
        backupFactor: backupPassword(),
        ...(session === undefined ? { factor: passkeyFactor() } : {}),
        ...extra,
      },
      session,
    );

  it("restores what it can, lists passphrase wallets, and a second restore completes them", async () => {
    const h = createHarness({ seed: 31 });
    await h.settle();
    const first = ok(await restoreInto(h, undefined));
    expect(listField(first, "wallets").map((w) => strField(w, "walletId"))).toStrictEqual([
      pv.plainWalletId,
    ]);
    expect(listField(first, "passphraseRequired")).toStrictEqual([pv.walletId]);
    // The envelope's backup key is adopted while the vault is established.
    const session = strField(first, "session");
    const status = ok(await h.call("status", undefined, session));
    expect(strField(field(status, "backup"), "id")).toBe(backupVector.id);

    const second = ok(
      await restoreInto(h, session, {
        passphrases: [{ walletId: pv.walletId, passphrase: text(pv.passphrase) }],
      }),
    );
    expect(listField(second, "wallets").map((w) => strField(w, "walletId"))).toStrictEqual([
      pv.walletId,
    ]);
    expect(field(listField(second, "wallets")[0] as ProtocolValue, "passphrase")).toBe(true);
    expect(listField(second, "passphraseRequired")).toStrictEqual([]);
    await expect(evmAddress(h, session, pv.walletId)).resolves.toBe(COMPOSED.evmAddress);

    // Restoring again is a no-op merge: everything exists, nothing is required.
    const third = ok(await restoreInto(h, session));
    expect(listField(third, "wallets")).toStrictEqual([]);
    expect(listField(third, "passphraseRequired")).toStrictEqual([]);
  });

  it("restores a passphrase wallet straight into a fresh vault", async () => {
    const h = createHarness({ seed: 32 });
    await h.settle();
    const res = ok(
      await restoreInto(h, undefined, {
        passphrases: [{ walletId: pv.walletId, passphrase: text(pv.passphrase) }],
      }),
    );
    expect(listField(res, "wallets")).toHaveLength(2);
    expect(listField(res, "passphraseRequired")).toStrictEqual([]);
    const session = strField(res, "session");
    const exported = ok(
      await h.call(
        "wallet.exportMnemonic",
        { verify: passkeyFactor(), walletId: pv.walletId },
        session,
      ),
    );
    // The re-sealed record (backup "none" → "mnemonic") keeps its passphrase.
    expect(bytesField(exported, "passphrase")).toStrictEqual(text(pv.passphrase.normalize("NFKD")));
    const respawned = createHarness({ store: h.store });
    await respawned.settle();
    const unlocked = ok(await respawned.call("vault.unlock", { factor: passkeyFactor() }));
    await expect(evmAddress(respawned, strField(unlocked, "session"), pv.walletId)).resolves.toBe(
      COMPOSED.evmAddress,
    );
  });

  it("a wrong passphrase is invalid-input and commits nothing", async () => {
    const h = createHarness({ seed: 33 });
    await h.settle();
    const first = ok(await restoreInto(h, undefined));
    const session = strField(first, "session");
    const imageBefore = await h.store.load();
    const before = imageBefore.records.length;
    expect(
      errCode(
        await restoreInto(h, session, {
          passphrases: [{ walletId: pv.walletId, passphrase: text("wrong") }],
        }),
      ),
    ).toBe("invalid-input");
    const imageAfter = await h.store.load();
    expect(imageAfter.records).toHaveLength(before);
    await expect(walletsOf(h, session)).resolves.toHaveLength(1);
  });

  it("a passphrase for an unflagged or unknown wallet, or a duplicate, is invalid-input", async () => {
    const h = createHarness({ seed: 34 });
    await h.settle();
    const session = strField(ok(await restoreInto(h, undefined)), "session");
    const attempts = [
      [{ walletId: pv.plainWalletId, passphrase: text("x") }],
      [{ walletId: "0".repeat(16), passphrase: text("x") }],
      [
        { walletId: pv.walletId, passphrase: text(pv.passphrase) },
        { walletId: pv.walletId, passphrase: text(pv.passphrase) },
      ],
    ];
    for (const passphrases of attempts) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential attempts
      expect(errCode(await restoreInto(h, session, { passphrases }))).toBe("invalid-input");
    }
    await expect(walletsOf(h, session)).resolves.toHaveLength(1);
  });
});
