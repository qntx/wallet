/**
 * Hermes smoke test for the wallet kernel: bundled to a single classic script and run on the bare
 * Hermes CLI that RN 0.88 ships (hermes-v260318099.0.4). Everything the kernel needs from its host
 * is injected — deterministic random, fake clock, pure-JS PBKDF2, a never-firing setTimer stub, an
 * in-memory store, and an in-memory port — so the only ambient requirements left are the globals
 * globals.ts reports and shims.
 *
 * Hard asserts only; entry.ts prints `HERMES_SMOKE_OK` after every check — including async ones —
 * settled. The OK line is the pass contract: Hermes exits 0 even for unhandled async errors, so
 * runners must assert the marker appears in stdout.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { nobleBackend, verifyEvent } from "@qntx/nostr";
import type { Event } from "@qntx/nostr";
import {
  VAULT_FORMAT,
  createMemoryAnchor,
  createMemoryStore,
  startKernel,
} from "@qntx/wallet-kernel";
import type { Argon2id, KernelPlatform, Pbkdf2, Port, Random } from "@qntx/wallet-kernel";
import type { ProtocolValue, WalletErrorCode } from "@qntx/wallet/protocol";

// vectors/wallet/nip06.json — NIP-06 derivation path m/44'/1237'/0'/0/0.
const MNEMONIC = "leader monkey parrot ring guide accident before fence cannon height naive bean";
const EXPECTED_PUBLIC_KEY = "17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917";
const EXPECTED_NSEC = "nsec10allq0gjx7fddtzef0ax00mdps9t2kmtrldkyjfs8l5xruwvh2dq0lhhkp";
const PASSWORD = "correct horse battery staple";
// vectors/bip39.json `passphrase` / vectors/wallet-id.json `passphrase` — `kana-and-compat`.
const PASSPHRASE_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSPHRASE = "\u30AC\uFF76\uFF9E \u2460";
const PASSPHRASE_WALLET_ID = "9f043a6d86bd43b4";
const PASSPHRASE_PUBLIC_KEY = "d487b7a4113a447308c57222d0307d0662ce682ada63ce1fc10d25a5531ef510";
// vectors/nip44/official.json — a fixed peer for the encrypt/decrypt round trip.
const PEER_PUBLIC_KEY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
// vectors/chains/evm.json — the anvil test mnemonic; its eip1559 expected bytes are reproduced
// verbatim below so the signature is vector-checked.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const EXPECTED_EVM_SIGNED =
  "02f87201028459682f0084773594008252089470997970c51812dc3a010c7d01b50e0d17dc79c888016345785d8a000080c001a0ad8d9fc0a96d964860f5513a3e25ae449aaf256299cce84d4639c1ef44f30199a0445b518a2309891c5d4f1efe410d8fc1cd8ede3e2139b59d9961890ef74cd649";
// A fixed legacy Solana system-transfer message (1000 lamports to a fixed recipient) whose fee
// payer is the anvil wallet's solana.bip44-change group-0 account (m/44'/501'/0'/0'); it decodes
// to a "transfer" intent with "full" verifiability. The expected signature is deterministic
// ed25519, checked byte for byte against an independent oracle — SLIP-10 derivation plus
// @noble/curves ed25519.sign, computed outside the kernel.
const SOLANA_MESSAGE = hexToBytes(
  "010001030bf32b9f0db09672038fea36139b18f98a5f0149ef4ce0332e44b9a77e83c22d" +
    "2222222222222222222222222222222222222222222222222222222222222222" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "3333333333333333333333333333333333333333333333333333333333333333" +
    "01020200010c02000000e803000000000000",
);
const EXPECTED_SOLANA_SIG =
  "535e4ab0fd51631c35be446ee5bee835c600dfdcb32f0cd7adaaf0b6fe899f49d35aca1203cd01ccc74efdf66568d10d1d0c71e363245585c08a4a8d993cc501";
// A fixed one-input PSBT: a p2wpkh prevout (nonWitnessUtxo + bip32Derivation) the anvil wallet
// controls at m/84'/0'/0'/0/0, paying 90000 sats to bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g.
// The expected signed PSBT is deterministic (RFC6979), checked byte for byte against an
// independent oracle — m/84'/0'/0'/0/0 derived with @scure/bip32, the PSBT signed with
// @scure/btc-signer, outside the kernel.
const BTC_PSBT = hexToBytes(
  "70736274ff01005202000000017648902d7b4387dea0bad1d616d431b448734368b04dc8e4ffb390e3798d385b" +
    "0000000000fdffffff01905f0100000000001600149c90f934ea51fa0f6504177043e0908da6929983" +
    "0000000000010052020000000107070707070707070707070707070707070707070707070707070707" +
    "070707070000000000ffffffff01a086010000000000160014a81d55416d14810a14ccf8fe619e8ad6" +
    "633e4dde0000000001011fa086010000000000160014a81d55416d14810a14ccf8fe619e8ad6633e4dde" +
    "220603fc2a760d930aa1459b35185f45784f4b42050311b232ed490f05db13f448e1541816a93ed054" +
    "000080000000800000008000000000000000000000",
);
const EXPECTED_BTC_SIGNED_PSBT =
  "70736274ff01005202000000017648902d7b4387dea0bad1d616d431b448734368b04dc8e4ffb390e3798d385b" +
  "0000000000fdffffff01905f0100000000001600149c90f934ea51fa0f6504177043e0908da6929983" +
  "0000000000010052020000000107070707070707070707070707070707070707070707070707070707" +
  "070707070000000000ffffffff01a086010000000000160014a81d55416d14810a14ccf8fe619e8ad6" +
  "633e4dde0000000001011fa086010000000000160014a81d55416d14810a14ccf8fe619e8ad6633e4dde" +
  "220203fc2a760d930aa1459b35185f45784f4b42050311b232ed490f05db13f448e154483045022100ae" +
  "d4f03f9ae5cc3978c92bd880bbe212585cbc68911286c133ab7c70624bc1dc02203f28883558326e4eb1" +
  "66349778bd30478f294d9e0a63554ff7f5dc44e9a938bc01220603fc2a760d930aa1459b35185f45784f" +
  "4b42050311b232ed490f05db13f448e1541816a93ed054000080000000800000008000000000000000000000";

// vectors/chains/tron.json "tronlink" key: the anvil mnemonic's tron.bip44 group-0 account is the
// TronLink dev pair 15f0bb… → TWer2Ygk… (verified via tronweb 6.5.2 address.fromPrivateKey). The
// raw_data is a 1 TRX TransferContract from that owner to TJRyWwFs…, built offline once with
// buildTronRawData (refBlock number 1, id "aa…", expiration 1700000000000). The expected signature
// is tronweb 6.5.2 utils.crypto.ECKeySign(sha256(rawData), key), computed offline in a scratch
// script — it matches signTronTransaction byte for byte.
const TRON_RAW = hexToBytes(
  "0a0200012208aaaaaaaaaaaaaaaa4080d095ffbc315a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541e2e1a54926527fbb4e4420de4c6bab82beaee24d1215415cd0fb0ab3ce40f3051414c604b27756e69e43db18c0843d70c0cbd8febc31",
);
const EXPECTED_TRON_SIG =
  "45e14e23a71071a1d5c62f0687af512676983066ed08fc9b892b6432ebabfa923eeba43698e490f70b77a46ed2f5bb95c22c5213ec967137dfe0bc3e71e8815d1c";

function assert(cond: boolean, name: string): asserts cond {
  if (!cond) {
    throw new Error(`smoke: ${name}`);
  }
}
function eq<T>(got: T, want: T, name: string): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`smoke: ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}

/** Mulberry32: small deterministic PRNG for the injected platform.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nextFloat = mulberry32(1);
const random: Random = (length) => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.floor(nextFloat() * 256);
  }
  return out;
};

/** Pure-JS PBKDF2 — Hermes has no WebCrypto; production RN injects a native KDF the same way. */
const noblePbkdf2: Pbkdf2 = async (hash, password, salt, iterations, length) =>
  pbkdf2Async(hash === "sha256" ? sha256 : sha512, password, salt, {
    c: iterations,
    dkLen: length,
  });

/** Pure-JS Argon2id — what a runtime without a native KDF would have to run. */
const nobleArgon2id: Argon2id = async (password, salt, cost, length) =>
  argon2idAsync(password, salt, {
    m: cost.memoryKiB,
    t: cost.passes,
    p: cost.lanes,
    dkLen: length,
  });

type Reply = {
  readonly ok?: ProtocolValue;
  readonly err?: { readonly code: WalletErrorCode; readonly retryAt?: number };
};

type Kernel = {
  readonly call: (
    method: string,
    params: unknown,
    session?: string,
  ) => Promise<{ readonly ok?: ProtocolValue; readonly err?: { readonly code: WalletErrorCode } }>;
  readonly posted: ReadonlyArray<ProtocolValue>;
};

function boot(store: ReturnType<typeof createMemoryStore>): Kernel {
  const posted: ProtocolValue[] = [];
  const pending = new Map<number, (reply: Reply) => void>();
  let handler: ((message: unknown) => void) | undefined;
  const port: Port = {
    post: (message) => {
      posted.push(message);
      if (
        typeof message !== "object" ||
        message === null ||
        Array.isArray(message) ||
        message instanceof Uint8Array ||
        !("id" in message)
      ) {
        return;
      }
      const { id } = message;
      if (typeof id !== "number") {
        return;
      }
      const resolve = pending.get(id);
      if (resolve !== undefined) {
        pending.delete(id);
        resolve(message);
      }
    },
    listen: (h) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
  };
  const platform: KernelPlatform = {
    random,
    keystore: undefined,
    passkey: undefined,
    secureInput: undefined,
    now: () => 1_700_000_000_000,
    elapsed: () => 0,
    // The session's idle/max timers simply never fire in this smoke — no ambient clock advances.
    setTimer: () => () => undefined,
    pbkdf2: noblePbkdf2,
    argon2id: nobleArgon2id,
    store,
    anchor: createMemoryAnchor(),
    policy: {
      maxSessionMs: 12 * 3_600_000,
      maxScryptLogN: 20,
      idle: { ms: 15 * 60_000, activity: "request" },
    },
    // No spark.wasm in the bare-Hermes smoke — the backend must never load here anyway.
    backends: {
      spark: async () => {
        await Promise.resolve();
        throw new Error("no spark backend in hermes smoke");
      },
      nostr: nobleBackend,
    },
  };
  startKernel(platform, port);

  let nextId = 1;
  return {
    posted,
    call: async (method, params, session) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        handler?.({ v: 3, id, method, session, params: params ?? null });
      }),
  };
}

function ok(value: { ok?: ProtocolValue; err?: { code: WalletErrorCode } }): ProtocolValue {
  if (value.err !== undefined) {
    throw new Error(`smoke: kernel error ${value.err.code}`);
  }
  if (value.ok === undefined) {
    throw new Error("smoke: response carried neither ok nor err");
  }
  return value.ok;
}

function field(value: ProtocolValue, name: string): ProtocolValue {
  assert(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array),
    `field ${name}: not an object`,
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a record above
  const result = (value as Record<string, ProtocolValue>)[name];
  assert(result !== undefined, `field ${name}: absent`);
  return result;
}

export async function main(): Promise<void> {
  const store = createMemoryStore();
  const kernel = boot(store);

  // 1. Import the NIP-06 mnemonic with a password factor → wallet + session, then derive the
  // group-0 key through the nostr module.
  const imported = ok(
    await kernel.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: { kind: "password", password: utf8ToBytes(PASSWORD) },
    }),
  );
  const walletId = field(field(imported, "wallet"), "walletId");
  const sessionValue = field(imported, "session");
  assert(typeof sessionValue === "string" && sessionValue.length === 32, "importMnemonic session");
  const derived = ok(await kernel.call("nostr.deriveKey", { walletId, index: 0 }, sessionValue));
  eq(field(derived, "publicKey"), EXPECTED_PUBLIC_KEY, "deriveKey public key");

  // 2./3. A lock is host-side (the worker dies and respawns): booting a fresh kernel over the
  // same store is the locked enclave — unlock with the password → a fresh session.
  const kernel2 = boot(store);
  const unlocked = ok(
    await kernel2.call("vault.unlock", {
      factor: { kind: "password", password: utf8ToBytes(PASSWORD) },
    }),
  );
  const unlockSession = field(unlocked, "session");
  assert(typeof unlockSession === "string" && unlockSession.length === 32, "unlock session");
  const session = unlockSession;

  // One chain.sign per family — ox, @solana/* and btc-signer only run under Hermes if the smoke
  // calls them. The wallet is the chains/evm.json vector mnemonic (its eip1559 expected bytes are
  // the vector's own); the Solana and Bitcoin expectations were checked against independent
  // oracles (@noble/curves ed25519, @scure/bip32 + @scure/btc-signer — see the constants above).
  const anvil = ok(
    await kernel2.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(ANVIL_MNEMONIC) }, session),
  );
  const anvilWalletId = field(field(anvil, "wallet"), "walletId");
  // Each verify factor is consumed (wiped) by the kernel — every call needs fresh bytes.
  const verifyPassword = () => ({ kind: "password", password: utf8ToBytes(PASSWORD) });

  const evmSigned = ok(
    await kernel2.call(
      "chain.sign",
      {
        request: {
          kind: "evm.transaction",
          network: "eip155:1",
          account: {
            kind: "hd",
            walletId: anvilWalletId,
            groupIndex: 0,
            template: "evm.bip44",
          },
          tx: {
            type: "eip1559",
            chainId: 1,
            nonce: 2,
            gas: "0x5208",
            value: "0x16345785d8a0000",
            data: "0x",
            to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            accessList: [],
            maxFeePerGas: "0x77359400",
            maxPriorityFeePerGas: "0x59682f00",
          },
        },
        verify: verifyPassword(),
      },
      session,
    ),
  );
  const signedTx = field(evmSigned, "signedTransaction");
  assert(signedTx instanceof Uint8Array, "chain.sign evm signedTransaction bytes");
  eq(bytesToHex(signedTx), EXPECTED_EVM_SIGNED, "chain.sign evm eip1559");

  const solSigned = ok(
    await kernel2.call(
      "chain.sign",
      {
        request: {
          kind: "solana.transaction",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          account: {
            kind: "hd",
            walletId: anvilWalletId,
            groupIndex: 0,
            template: "solana.bip44-change",
          },
          message: new Uint8Array(SOLANA_MESSAGE),
        },
        verify: verifyPassword(),
      },
      session,
    ),
  );
  const solSig = field(solSigned, "signature");
  assert(solSig instanceof Uint8Array, "chain.sign solana signature bytes");
  eq(bytesToHex(solSig), EXPECTED_SOLANA_SIG, "chain.sign solana transaction");

  const btcSigned = ok(
    await kernel2.call(
      "chain.sign",
      {
        request: {
          kind: "bitcoin.psbt",
          network: "bip122:000000000019d6689c085ae165831e93",
          account: { kind: "hd", walletId: anvilWalletId, groupIndex: 0 },
          psbt: new Uint8Array(BTC_PSBT),
          sign: [{ index: 0, template: "btc.bip84" }],
        },
        verify: verifyPassword(),
      },
      session,
    ),
  );
  const signedPsbt = field(btcSigned, "signedPsbt");
  assert(signedPsbt instanceof Uint8Array, "chain.sign bitcoin signedPsbt bytes");
  eq(bytesToHex(signedPsbt), EXPECTED_BTC_SIGNED_PSBT, "chain.sign bitcoin psbt");

  const tronAccounts = ok(
    await kernel2.call(
      "wallet.accounts",
      {
        walletId: anvilWalletId,
        groupIndex: 0,
        template: "tron.bip44",
        network: "tron:728126428",
      },
      session,
    ),
  );
  eq(field(tronAccounts, "address"), "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6", "wallet.accounts tron");

  const tronSigned = ok(
    await kernel2.call(
      "chain.sign",
      {
        request: {
          kind: "tron.transaction",
          network: "tron:728126428",
          account: {
            kind: "hd",
            walletId: anvilWalletId,
            groupIndex: 0,
            template: "tron.bip44",
          },
          rawData: new Uint8Array(TRON_RAW),
        },
        verify: verifyPassword(),
      },
      session,
    ),
  );
  const tronSig = field(tronSigned, "signature");
  assert(tronSig instanceof Uint8Array, "chain.sign tron signature bytes");
  eq(bytesToHex(tronSig), EXPECTED_TRON_SIG, "chain.sign tron transaction");

  // 4. Sign an event with the derived key — the schnorr signature must verify.
  const signed = ok(
    await kernel2.call(
      "nostr.signEvent",
      {
        publicKey: EXPECTED_PUBLIC_KEY,
        event: {
          kind: 1,
          created_at: 1_700_000_000,
          tags: [["t", "hermes"]],
          content: "hello from bare hermes",
        },
      },
      session,
    ),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- result validator guarantees the Event shape
  const event = signed as Event;
  eq(event.pubkey, EXPECTED_PUBLIC_KEY, "signEvent pubkey");
  assert(verifyEvent(event), "signEvent verifies");

  // 5./6. NIP-44 round trip against a fixed peer.
  const ciphertext = ok(
    await kernel2.call(
      "nostr.nip44Encrypt",
      { publicKey: EXPECTED_PUBLIC_KEY, peer: PEER_PUBLIC_KEY, text: "hermes nip44" },
      session,
    ),
  );
  assert(typeof ciphertext === "string" && ciphertext.length > 0, "nip44Encrypt payload");
  const plaintext = ok(
    await kernel2.call(
      "nostr.nip44Decrypt",
      { publicKey: EXPECTED_PUBLIC_KEY, peer: PEER_PUBLIC_KEY, text: ciphertext },
      session,
    ),
  );
  eq(plaintext, "hermes nip44", "nip44 round trip");

  // 7. Export the key in nsec format — re-verifies with the password factor.
  const nsecBytes = ok(
    await kernel2.call(
      "nostr.exportKey",
      {
        verify: { kind: "password", password: utf8ToBytes(PASSWORD) },
        publicKey: EXPECTED_PUBLIC_KEY,
        format: { kind: "nsec" },
      },
      session,
    ),
  );
  assert(nsecBytes instanceof Uint8Array, "nostr.exportKey bytes");
  const nsec = new TextDecoder().decode(nsecBytes);
  eq(nsec, EXPECTED_NSEC, "nostr.exportKey nsec");

  const statusEvents = kernel2.posted.filter(
    (m) => typeof m === "object" && m !== null && !Array.isArray(m) && "event" in m,
  );
  assert(statusEvents.length > 0, "kernel posted status events");

  // 8. BIP-39 passphrases are NFKD-normalized, so Hermes' String.prototype.normalize must really
  // decompose (a stub that returns its input would silently derive different wallets): accents,
  // half-width kana and a compatibility character, then a passphrase wallet whose walletId and
  // NIP-06 key come from the vectors (vectors/bip39.json, vectors/wallet-id.json `kana-and-compat`).
  eq("\u00E9".normalize("NFKD"), "e\u0301", "NFKD decomposes an accent");
  eq("\u30AC".normalize("NFKD"), "\u30AB\u3099", "NFKD decomposes a kana");
  eq("\uFF76\uFF9E".normalize("NFKD"), "\u30AB\u3099", "NFKD maps half-width kana");
  eq("\u2460".normalize("NFKD"), "1", "NFKD maps a compatibility digit");
  const withPassphrase = ok(
    await kernel2.call(
      "wallet.importMnemonic",
      {
        mnemonic: utf8ToBytes(PASSPHRASE_MNEMONIC),
        passphrase: utf8ToBytes(PASSPHRASE),
      },
      session,
    ),
  );
  const passphraseWallet = field(withPassphrase, "wallet");
  eq(field(passphraseWallet, "walletId"), PASSPHRASE_WALLET_ID, "passphrase walletId");
  eq(field(passphraseWallet, "passphrase"), true, "passphrase flag");
  const passphraseKey = ok(
    await kernel2.call("nostr.deriveKey", { walletId: PASSPHRASE_WALLET_ID, index: 0 }, session),
  );
  eq(field(passphraseKey, "publicKey"), PASSPHRASE_PUBLIC_KEY, "passphrase NIP-06 key");

  // 9. The native kernel entry runs on the same bare runtime: __qntx is what the native host
  // injects (deterministic random, fake clock, sync pbkdf2 callback, in-memory file, a capture
  // port). Importing the entry starts the kernel — its first store.load() and status frame
  // exercise the file-backed RecordStore, so any global outside the Hermes set (e.g.
  // structuredClone) fails this smoke instead of an RN build.
  const postedFrames: ArrayBuffer[] = [];
  const fileBytes = { value: undefined as Uint8Array | undefined };
  const __qntxFile = {
    read: (): Uint8Array | undefined => fileBytes.value,
    replace: (next: Uint8Array, expected: Uint8Array | undefined): boolean => {
      const current = fileBytes.value;
      const matches =
        expected === undefined
          ? current === undefined
          : current !== undefined &&
            current.length === expected.length &&
            current.every((b, i) => b === expected[i]);
      if (!matches) {
        return false;
      }
      fileBytes.value = next;
      return true;
    },
  };
  (globalThis as Record<string, unknown>)["__qntx"] = {
    random,
    now: () => 1_700_000_000_000,
    elapsed: () => 0,
    setTimer: (_ms: number, _fn: () => void) => () => undefined,
    pbkdf2: (
      hash: string,
      password: Uint8Array,
      salt: Uint8Array,
      iterations: number,
      length: number,
      callback: (result: Uint8Array | undefined, error: string | undefined) => void,
    ) => {
      // The injected __qntx.pbkdf2 is callback-shaped by design — an async bridge back to a
      // promise is exactly what the native side delivers, so the promise rules are waived here.
      const fn = hash === "sha512" ? sha512 : sha256;
      void (async () => {
        try {
          callback(
            await pbkdf2Async(fn, password, salt, { c: iterations, dkLen: length }),
            undefined,
          );
        } catch (error) {
          callback(undefined, String(error));
        }
      })();
    },
    // The smoke never enables a backup, so the entry only needs the function to exist.
    argon2id: () => undefined,
    file: __qntxFile,
    // The native kernel entry binds the keystore eagerly; the smoke never
    // reaches a factor ceremony, so only the shape is needed.
    keystore: {
      locale: "en",
      seal: () => undefined,
      open: () => undefined,
      authenticate: () => undefined,
      clear: () => undefined,
    },
    passkey: { create: () => undefined, get: () => undefined },
    // The native kernel entry binds backends.nostr and backends.spark eagerly
    // at platform construction — the smoke never calls either, so only the ABI
    // pins and call shapes are real.
    backends: {
      nostr: { abiVersion: 2 },
      spark: {
        abiVersion: 1,
        frostCommit: () => new Uint8Array(),
        frostSign: () => new Uint8Array(),
        frostAggregate: () => new Uint8Array(),
        eciesEncrypt: () => new Uint8Array(),
        eciesDecrypt: () => new Uint8Array(),
        splitSecretWithProofs: () => new Uint8Array(),
      },
    },
    frames: {
      post: (frame: ArrayBuffer) => {
        postedFrames.push(frame);
      },
      onMessage: () => undefined,
    },
  };
  await import("../../../wallet-native/kernel/kernel-entry.ts");
  await new Promise<void>((resolve) => {
    setTimeout(resolve);
  });
  assert(postedFrames.length > 0, "native kernel entry posted its first frame");

  // The kernel loads its store lazily, so exercise the file store directly — this is the
  // guard for globals outside the Hermes set (e.g. structuredClone): load commits the clone
  // path and a real commit exercises encode + compare-and-swap replace + watch.
  const { createFileStore } = await import("../../../wallet-native/kernel/store.ts");
  const fs = createFileStore(__qntxFile);
  const loaded = await fs.load();
  assert(loaded.meta === undefined && loaded.records.length === 0, "file store initial load");
  await fs.commit([
    {
      op: "init",
      meta: {
        format: VAULT_FORMAT,
        revision: 1,
        keyId: "0123456789abcdef0123456789abcdef",
      },
    },
  ]);
  const reloaded = await createFileStore(__qntxFile).load();
  assert(reloaded.meta?.revision === 1, "file store reload across rebuild");
}
