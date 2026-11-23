/**
 * The applet's published `spec/vectors` files (copied into `vectors/card/` at the commit SOURCE
 * pins) replayed against the card protocol client: access-code hashing, the §10.1 seed wrap built
 * from the client's own primitives, transfer encoders/decoders, signature decoders, the
 * VERIFY/STATUS sequence rules and derivation-path encodings. Independent oracles — @scure/bip32
 * and micro-key-producer — confirm the derived public keys the client must match.
 */
import { cbc, cmac } from "@noble/ciphers/aes.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import { accessHash } from "../src/modules/card/protocol/access.ts";
import type { Argon2id } from "../src/modules/card/protocol/access.ts";
import { u16 } from "../src/modules/card/protocol/bytes.ts";
import { cmd, masterPublicKey } from "../src/modules/card/protocol/commands.ts";
import type { CardPath, Inner } from "../src/modules/card/protocol/commands.ts";
import { decode } from "../src/modules/card/protocol/decode.ts";
import { CardError } from "../src/modules/card/protocol/errors.ts";
import type { CardErrorCode } from "../src/modules/card/protocol/errors.ts";
import { taprootTweak } from "../src/modules/card/protocol/signatures.ts";
import { ACCESS_LIMITS, result, waitsBeforeVerify } from "../src/modules/card/protocol/status.ts";
import { exportMessage, offerMessage } from "../src/modules/card/protocol/transfer.ts";
import { edwardsEncode } from "../src/modules/card/protocol/wei25519.ts";
import { loadVectors, realArgon2id } from "./helpers.ts";

const hex = hexToBytes;

function requireCase<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("test vector missing");
  }
  return value;
}

const capture = (fn: () => unknown): CardError | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CardError) {
      return error;
    }
    throw error;
  }
  return undefined;
};

const cardError = (fn: () => unknown): CardErrorCode | undefined => capture(fn)?.code;

/** `m/44'/60'/0'/0/0` → the index list the path encoders take; `'` hardens. */
const parsePath = (path: string): CardPath =>
  path
    .split("/")
    .slice(1)
    .map((part) =>
      part.endsWith("'")
        ? Math.trunc(Number(part.slice(0, -1))) + 0x80_00_00_00
        : Math.trunc(Number(part)),
    );

const access = loadVectors("card/access.json") as {
  params: { saltLabel: string; m: number; t: number; p: number; T: number; version: number };
  valid: ReadonlyArray<{
    name: string;
    code: string;
    codeHex: string;
    cardId: string;
    salt: string;
    accessHash: string;
  }>;
  rejected: ReadonlyArray<{ name: string; codeHex: string; reason: string }>;
};

describe("access.json", () => {
  it.each(access.valid.slice(0, 2))(
    "derives $name at the real cost",
    { timeout: 30_000 },
    async (v) => {
      const derived = await accessHash(hex(v.codeHex), hex(v.cardId), realArgon2id);
      expect(bytesToHex(derived)).toBe(v.accessHash);
    },
  );

  it.each(access.valid)("asks Argon2id for the vector's salt and cost ($name)", async (v) => {
    const seen: { salt?: Uint8Array; password?: Uint8Array; cost?: unknown; length?: number } = {};
    const spy: Argon2id = async (password, salt, cost, length) => {
      seen.salt = salt;
      seen.password = new Uint8Array(password);
      seen.cost = cost;
      seen.length = length;
      return Promise.resolve(new Uint8Array(length));
    };
    await accessHash(hex(v.codeHex), hex(v.cardId), spy);
    expect(bytesToHex(requireCase(seen.salt))).toBe(v.salt);
    expect(seen.password).toStrictEqual(hex(v.codeHex));
    expect(seen.cost).toStrictEqual({
      memoryKiB: access.params.m,
      passes: access.params.t,
      lanes: access.params.p,
    });
    expect(seen).toHaveLength(access.params.T);
  });

  it.each(access.rejected)("rejects $name without calling Argon2id", async (v) => {
    let called = 0;
    const spy: Argon2id = async () => {
      called += 1;
      return Promise.resolve(new Uint8Array(32));
    };
    const first = requireCase(access.valid[0]);
    await expect(accessHash(hex(v.codeHex), hex(first.cardId), spy)).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect(called).toBe(0);
  });
});

const wrap = loadVectors("card/wrap.json") as {
  wrapLabel: string;
  fingerprintLabel: string;
  cases: ReadonlyArray<{
    name: string;
    wrapKey: string;
    accessHash: string;
    seed: string;
    kEnc: string;
    kMac: string;
    ct: string;
    tag: string;
    fp: string;
  }>;
};

/**
 * The §10.1 seed wrap rebuilt from the client's primitives — `KDF108(K, label, ctx)` is `CMAC(K, i
 * ‖ label ‖ 0x00 ‖ ctx ‖ u16(256))` for `i ∈ {1, 2}` (SP 800-108r1 §4.1, r = 8); the client keeps
 * no wrap module because wrapping is card-side only.
 */
const kdf108 = (key: Uint8Array, label: Uint8Array, ctx: Uint8Array): Uint8Array =>
  concatBytes(
    cmac(concatBytes(new Uint8Array([1]), label, new Uint8Array([0]), ctx, u16(256)), key),
    cmac(concatBytes(new Uint8Array([2]), label, new Uint8Array([0]), ctx, u16(256)), key),
  );

describe("wrap.json", () => {
  it.each(wrap.cases)("$name wraps and fingerprints the seed", (v) => {
    const keys = kdf108(hex(v.wrapKey), hex(wrap.wrapLabel), hex(v.accessHash));
    expect(bytesToHex(keys.subarray(0, 16))).toBe(v.kEnc);
    expect(bytesToHex(keys.subarray(16, 32))).toBe(v.kMac);
    const ct = cbc(keys.subarray(0, 16), new Uint8Array(16), { disablePadding: true }).encrypt(
      hex(v.seed),
    );
    expect(bytesToHex(ct)).toBe(v.ct);
    expect(bytesToHex(cmac(ct, keys.subarray(16, 32)))).toBe(v.tag);
    expect(bytesToHex(sha256(concatBytes(hex(wrap.fingerprintLabel), hex(v.seed))))).toBe(v.fp);
  });
});

const transfer = loadVectors("card/transfer.json") as {
  labels: { offer: string; export: string; kdfTransfer: string };
  ca: string;
  cards: ReadonlyArray<{
    name: string;
    private: string;
    A: string;
    uncompressed: string;
    id: string;
    cert: string;
  }>;
  transfers: ReadonlyArray<{
    name: string;
    source: string;
    target: string;
    linkPrivate: string;
    LK: string;
    offerHash: string;
    offerSignature: string;
    e: string;
    E: string;
    M: string;
    TH: string;
    exportSignature: string;
    accessHashT: string;
    ct: string;
    tag: string;
  }>;
};

const transferCard = (name: string) => requireCase(transfer.cards.find((c) => c.name === name));

describe("transfer.json", () => {
  it.each(transfer.transfers)("$name offer decodes under the target identity", (v) => {
    const target = transferCard(v.target);
    const source = transferCard(v.source);
    expect(bytesToHex(offerMessage(hex(v.LK)))).toBe(transfer.labels.offer + v.LK);
    expect(bytesToHex(sha256(offerMessage(hex(v.LK))))).toBe(v.offerHash);
    const offer = decode.offer(concatBytes(hex(v.LK), hex(v.offerSignature)), hex(target.A));
    expect(offer.linkKey).toStrictEqual(hex(v.LK));
    expect(offer.signature).toStrictEqual(hex(v.offerSignature));
    // the offer is bound to the target's identity: it does not verify under the source's
    expect(
      cardError(() => decode.offer(concatBytes(hex(v.LK), hex(v.offerSignature)), hex(source.A))),
    ).toBe("card-fault");
  });

  it.each(transfer.transfers)("$name export head decodes under the source identity", (v) => {
    const source = transferCard(v.source);
    const target = transferCard(v.target);
    const message = exportMessage(hex(source.A), hex(target.A), hex(v.LK), hex(v.E));
    expect(bytesToHex(message)).toBe(v.M);
    expect(bytesToHex(sha256(message))).toBe(v.TH);
    const head = decode.exportHead(concatBytes(hex(v.E), hex(v.exportSignature)), {
      source: hex(source.A),
      target: hex(target.A),
      linkKey: hex(v.LK),
    });
    expect(head.ephemeral).toStrictEqual(hex(v.E));
    expect(head.signature).toStrictEqual(hex(v.exportSignature));
    expect(
      cardError(() =>
        decode.exportHead(concatBytes(hex(v.E), hex(v.exportSignature)), {
          source: hex(target.A),
          target: hex(source.A),
          linkKey: hex(v.LK),
        }),
      ),
    ).toBe("card-fault");
  });

  it.each(transfer.transfers)("$name encoders produce the wire forms", (v) => {
    const source = transferCard(v.source);
    const target = transferCard(v.target);
    const offer = { linkKey: hex(v.LK), signature: hex(v.offerSignature) };
    const export0 = cmd.export0(hex(target.cert), offer);
    expect(export0.ins).toBe(0x41);
    expect(export0.p1).toBe(0);
    expect(export0.data).toStrictEqual(hex(target.cert + v.LK + v.offerSignature));
    const export1 = cmd.export1(hex(v.accessHashT));
    expect(export1.ins).toBe(0x41);
    expect(export1.p1).toBe(1);
    expect(export1.data).toStrictEqual(hex(v.accessHashT));
    const head = { ephemeral: hex(v.E), signature: hex(v.exportSignature) };
    const import0 = cmd.import0(hex(source.cert), head);
    expect(import0.ins).toBe(0x42);
    expect(import0.p1).toBe(0);
    expect(import0.data).toStrictEqual(hex(source.cert + v.E + v.exportSignature));
    const payload = hex(v.ct + v.tag);
    const import1 = cmd.import1(payload);
    expect(import1.ins).toBe(0x42);
    expect(import1.p1).toBe(1);
    expect(import1.data).toStrictEqual(payload);
    expect(decode.exportPayload(payload)).toStrictEqual(payload);
  });
});

const ecdsa = loadVectors("card/ecdsa.json") as {
  cases: ReadonlyArray<{
    name: string;
    path: string;
    wire: string;
    publicKey: string;
    digest: string;
    signature: string;
    recoveryId: number;
    lowS: string;
    lowSRecoveryId: number;
    highS: string;
    highSRecoveryId: number;
  }>;
  invalid: ReadonlyArray<{ name: string; publicKey: string; digest: string; signature: string }>;
};

describe("ecdsa.json", () => {
  it.each(ecdsa.cases)("$name encodes the command and decodes both s forms", (v) => {
    const inner = cmd.signEcdsa(hex(v.digest), parsePath(v.path));
    expect(inner.data).toStrictEqual(hex(v.digest + v.wire));
    for (const data of [hex(v.signature), hex(v.highS)]) {
      const decoded = decode.ecdsa(data, hex(v.digest), hex(v.publicKey), []);
      expect(decoded.signature).toStrictEqual(hex(v.lowS));
      expect(decoded.recovery).toBe(v.lowSRecoveryId);
    }
    // a repeated r is a card fault (§12.1 nonce reuse)
    expect(
      cardError(() =>
        decode.ecdsa(hex(v.signature), hex(v.digest), hex(v.publicKey), [
          hex(v.signature).subarray(0, 32),
        ]),
      ),
    ).toBe("card-fault");
  });

  it.each(ecdsa.invalid)("rejects $name as card-fault", (v) => {
    expect(
      cardError(() => decode.ecdsa(hex(v.signature), hex(v.digest), hex(v.publicKey), [])),
    ).toBe("card-fault");
  });
});

const bip340 = loadVectors("card/bip340.json") as {
  official: ReadonlyArray<{
    index: number;
    publicKey: string;
    message: string;
    signature: string;
    valid: boolean;
    comment: string;
  }>;
  bip86: {
    seed: string;
    keys: ReadonlyArray<{
      path: string;
      wire: string;
      internalKey: string;
      tweak: string;
      outputKey: string;
    }>;
  };
  cases: ReadonlyArray<{
    name: string;
    path: string;
    wire: string;
    publicKey: string;
    internalKey: string;
    tweak: string;
    outputKey: string;
    merkleRoot?: string;
    message: string;
    signature: string;
  }>;
  invalidTweak: ReadonlyArray<{ name: string; path: string; tweak: string; reason: string }>;
};

describe("bip340.json", () => {
  it.each(bip340.cases)("$name encodes the command and verifies the signature", (v) => {
    // publicKey is the compressed form of the x-only internalKey the card signs under
    expect(v.publicKey.slice(2)).toBe(v.internalKey);
    const inner = cmd.signBip340(hex(v.message), hex(v.tweak), parsePath(v.path));
    expect(inner.data).toStrictEqual(hex(v.message + v.tweak + v.wire));
    expect(
      decode.bip340(hex(v.signature), hex(v.message), hex(v.publicKey), hex(v.tweak)),
    ).toStrictEqual(hex(v.signature));
  });

  // 'untweaked' sends t = 0 (Q = P'), so the taproot tweak is asserted only where one is meant.
  const tweakedCases = bip340.cases
    .filter((v) => v.tweak !== "0".repeat(64))
    .map((v) => ({ ...v, merkle: hex(v.merkleRoot ?? "") }));

  it.each(tweakedCases)("$name's tweak is the BIP-341 TaggedHash", (v) => {
    expect(bytesToHex(taprootTweak(hex(v.publicKey), v.merkle))).toBe(v.tweak);
  });

  const { official } = bip340;

  // the card signs 32-byte messages only; official vectors with other sizes are not applicable
  const official32 = official.filter((v) => v.valid && v.message.length === 64);

  it.each(official32)("official vector $index verifies untweaked", (v) => {
    const internalKey = concatBytes(new Uint8Array([0x02]), hex(v.publicKey));
    expect(
      decode.bip340(hex(v.signature), hex(v.message), internalKey, new Uint8Array(32)),
    ).toStrictEqual(hex(v.signature));
  });

  it.each(official.filter((v) => !v.valid))("official vector $index is rejected", (v) => {
    const internalKey = concatBytes(new Uint8Array([0x02]), hex(v.publicKey));
    expect(
      capture(() =>
        decode.bip340(hex(v.signature), hex(v.message), internalKey, new Uint8Array(32)),
      ),
    ).toBeDefined();
  });

  it.each(bip340.bip86.keys)("$path derives the BIP-86 key and tweak", (v) => {
    const node = HDKey.fromMasterSeed(hex(bip340.bip86.seed)).derive(v.path);
    expect(node.privateKey).not.toBeNull();
    expect(bytesToHex(requireCase(node.publicKey).subarray(1))).toBe(v.internalKey);
    const internalKey = concatBytes(new Uint8Array([0x02]), hex(v.internalKey));
    expect(bytesToHex(taprootTweak(internalKey, new Uint8Array(0)))).toBe(v.tweak);
    const inner = cmd.signBip340(new Uint8Array(32), hex(v.tweak), parsePath(v.path));
    expect(inner.data).toStrictEqual(concatBytes(new Uint8Array(32), hex(v.tweak), hex(v.wire)));
    node.wipePrivateData();
  });

  it.each(bip340.invalidTweak.filter((v) => v.reason === "tweak >= n"))(
    "rejects $name as invalid-input",
    (v) => {
      const message = new Uint8Array(32);
      expect(cardError(() => cmd.signBip340(message, hex(v.tweak), parsePath(v.path)))).toBe(
        "invalid-input",
      );
      const internal = requireCase(bip340.bip86.keys.find((k) => k.path === v.path));
      const internalKey = concatBytes(new Uint8Array([0x02]), hex(internal.internalKey));
      expect(
        cardError(() => decode.bip340(new Uint8Array(64), message, internalKey, hex(v.tweak))),
      ).toBe("invalid-input");
    },
  );

  it.each(bip340.invalidTweak.filter((v) => v.reason === "the tweaked key is zero"))(
    "rejects $name as card-fault",
    (v) => {
      // tweak ≥ n passes the host's own check; the output key only fails to be a point on decode
      const internal = requireCase(bip340.bip86.keys.find((k) => k.path === v.path));
      const internalKey = concatBytes(new Uint8Array([0x02]), hex(internal.internalKey));
      expect(
        cardError(() =>
          decode.bip340(new Uint8Array(64), new Uint8Array(32), internalKey, hex(v.tweak)),
        ),
      ).toBe("card-fault");
    },
  );
});

const edVectors = loadVectors("card/ed25519.json") as {
  nonceLabel: string;
  rfc8032: ReadonlyArray<{
    name: string;
    secretKey: string;
    publicKey: string;
    message: string;
    signature: string;
    wei: string;
  }>;
  cases: ReadonlyArray<{
    name: string;
    path: string;
    wire: string;
    publicKey: string;
    wei: string;
    weiR: string;
    encodedR: string;
    message: string;
    s: string;
    signature: string;
  }>;
  wrongStream: ReadonlyArray<{
    name: string;
    case: string;
    s: string;
    signature: string;
    message: string;
    valid: boolean;
  }>;
};

describe("ed25519.json", () => {
  it.each(edVectors.cases)("$name maps Wei25519 points and verifies the signature", (v) => {
    expect(bytesToHex(edwardsEncode(hex(v.wei)))).toBe(v.publicKey);
    expect(bytesToHex(edwardsEncode(hex(v.weiR)))).toBe(v.encodedR);
    expect(v.signature).toBe(v.encodedR + v.s);
    const signature = decode.ed25519(hex(v.s), hex(v.encodedR), hex(v.publicKey), hex(v.message));
    expect(signature).toStrictEqual(hex(v.signature));
  });

  it.each(edVectors.cases)("$name encodes the stream chunks", (v) => {
    expect(cmd.ed25519Begin(parsePath(v.path)).data).toStrictEqual(hex(v.wire));
    const stream = hex(v.encodedR + v.publicKey + v.message);
    const inners = cmd.ed25519Stream(hex(v.encodedR), hex(v.publicKey), hex(v.message));
    expect(concatBytes(...inners.map((inner) => inner.data))).toStrictEqual(stream);
    const last = requireCase(inners.at(-1));
    expect(last.name).toBe("ed25519-finish");
    expect(last.p1).toBe(0x02);
    for (const inner of inners.slice(0, -1)) {
      expect(inner.name).toBe("ed25519-update");
      expect(inner.p1).toBe(0x01);
    }
  });

  it.each(edVectors.rfc8032)("$name maps the Wei25519 public key and verifies", (v) => {
    expect(bytesToHex(edwardsEncode(hex(v.wei)))).toBe(v.publicKey);
    const signature = decode.ed25519(
      hex(v.signature).subarray(32),
      hex(v.signature).subarray(0, 32),
      hex(v.publicKey),
      hex(v.message),
    );
    expect(signature).toStrictEqual(hex(v.signature));
  });

  it.each(edVectors.wrongStream)("rejects $name", (v) => {
    const source = requireCase(edVectors.cases.find((c) => c.name === v.case));
    expect(
      cardError(() =>
        decode.ed25519(hex(v.s), hex(source.encodedR), hex(source.publicKey), hex(v.message)),
      ),
    ).toBe("card-fault");
  });
});

const derivation = loadVectors("card/derivation.json") as {
  bip32: ReadonlyArray<{
    name: string;
    seed: string;
    nodes: ReadonlyArray<{
      path: string;
      wire?: string;
      privateKey: string;
      chainCode: string;
      publicKey: string;
    }>;
  }>;
  slip10: ReadonlyArray<{
    name: string;
    seed: string;
    nodes: ReadonlyArray<{
      path: string;
      wire?: string;
      privateKey: string;
      chainCode: string;
      publicKey: string;
      wei: string;
    }>;
  }>;
  templates: {
    seed: string;
    masterPublicKey: string;
    secp256k1: ReadonlyArray<{
      name: string;
      path: string;
      wire: string;
      privateKey: string;
      chainCode: string;
      publicKey: string;
    }>;
    ed25519: ReadonlyArray<{
      name: string;
      path: string;
      wire: string;
      privateKey: string;
      chainCode: string;
      publicKey: string;
      wei: string;
    }>;
  };
};

describe("derivation.json", () => {
  it("computes the template master public key", () => {
    expect(masterPublicKey(hex(derivation.templates.seed))).toStrictEqual(
      hex(derivation.templates.masterPublicKey),
    );
  });

  it.each(derivation.templates.secp256k1)(
    "$name encodes the path and derives the key with @scure/bip32",
    (v) => {
      expect(cmd.publicKey("secp256k1", parsePath(v.path)).data).toStrictEqual(hex(v.wire));
      const node = HDKey.fromMasterSeed(hex(derivation.templates.seed)).derive(v.path);
      expect(bytesToHex(requireCase(node.privateKey))).toBe(v.privateKey);
      expect(bytesToHex(requireCase(node.chainCode))).toBe(v.chainCode);
      expect(bytesToHex(requireCase(node.publicKey))).toBe(v.publicKey);
      node.wipePrivateData();
      expect(decode.publicKey(hex(v.publicKey + v.chainCode))).toStrictEqual({
        publicKey: hex(v.publicKey),
        chainCode: hex(v.chainCode),
      });
    },
  );

  it.each(derivation.templates.ed25519)(
    "$name encodes the path and derives the key with micro-key-producer",
    (v) => {
      expect(cmd.publicKey("ed25519", parsePath(v.path)).data).toStrictEqual(hex(v.wire));
      const node = Slip10.fromMasterSeed(hex(derivation.templates.seed)).derive(v.path);
      expect(bytesToHex(node.privateKey)).toBe(v.privateKey);
      expect(bytesToHex(node.chainCode)).toBe(v.chainCode);
      expect(bytesToHex(ed25519.getPublicKey(node.privateKey))).toBe(v.publicKey);
      expect(bytesToHex(edwardsEncode(hex(v.wei)))).toBe(v.publicKey);
    },
  );

  const bip32Nodes = derivation.bip32.flatMap((vector) =>
    vector.nodes
      .filter((node) => node.wire !== undefined)
      .map((node) => ({ seed: vector.seed, ...node }) as const),
  );

  it.each(bip32Nodes)("bip32 $path encodes the path and derives with @scure/bip32", (v) => {
    expect(cmd.publicKey("secp256k1", parsePath(v.path)).data).toStrictEqual(
      hex(requireCase(v.wire)),
    );
    const node = HDKey.fromMasterSeed(hex(v.seed)).derive(v.path);
    expect(bytesToHex(requireCase(node.publicKey))).toBe(v.publicKey);
    expect(bytesToHex(requireCase(node.chainCode))).toBe(v.chainCode);
    node.wipePrivateData();
  });

  const slip10Nodes = derivation.slip10.flatMap((vector) =>
    vector.nodes
      .filter((node) => node.wire !== undefined)
      .map((node) => ({ seed: vector.seed, ...node }) as const),
  );

  it.each(slip10Nodes)("slip10 $path encodes the path and derives with micro-key-producer", (v) => {
    expect(cmd.publicKey("ed25519", parsePath(v.path)).data).toStrictEqual(
      hex(requireCase(v.wire)),
    );
    const node = Slip10.fromMasterSeed(hex(v.seed)).derive(v.path);
    expect(bytesToHex(node.privateKey)).toBe(v.privateKey);
    expect(bytesToHex(node.chainCode)).toBe(v.chainCode);
    expect(bytesToHex(ed25519.getPublicKey(node.privateKey))).toBe(v.publicKey);
    expect(bytesToHex(edwardsEncode(hex(v.wei)))).toBe(v.publicKey);
  });
});

const verifySequence = loadVectors("card/verify-sequence.json") as {
  constants: { L: number; F: number; W: number; I: number };
  sequences: ReadonlyArray<{
    name: string;
    description: string;
    setup: string;
    steps: ReadonlyArray<{
      command: string;
      sw?: string;
      status?: string;
      repeat?: number;
      tear?: string;
      code?: string;
      export?: number;
      lk?: string;
    }>;
  }>;
};

const dummyInner: Readonly<Record<string, () => ReadonlyArray<Inner>>> = {
  VERIFY: () => [cmd.verify(new Uint8Array(32))],
  WAIT: () => [cmd.wait()],
  ERASE: () => [cmd.erase()],
  OFFER: () => [cmd.offer()],
  EXPORT: () => [
    cmd.export0(new Uint8Array(97), {
      linkKey: new Uint8Array(65),
      signature: new Uint8Array(64),
    }),
    cmd.export1(new Uint8Array(32)),
  ],
  IMPORT0: () => [
    cmd.import0(new Uint8Array(97), {
      ephemeral: new Uint8Array(65),
      signature: new Uint8Array(64),
    }),
  ],
  IMPORT1: () => [cmd.import1(new Uint8Array(160))],
};

type SequenceStep = {
  readonly sequence: string;
  readonly index: number;
  readonly command: string;
  readonly sw: string | undefined;
  readonly status: string | undefined;
};

const allSteps: ReadonlyArray<SequenceStep> = verifySequence.sequences.flatMap((sequence) =>
  sequence.steps.map((step, index) => ({
    sequence: sequence.name,
    index,
    command: step.command,
    sw: step.sw,
    status: step.status,
  })),
);

/** Every inner a step drives (OPEN is the outer session establishment, not an inner command). */
const stepRows = allSteps
  .filter((step) => step.sw !== undefined && step.sw !== "torn" && step.command !== "OPEN")
  .flatMap((step) => {
    const { command } = step;
    const sw = requireCase(step.sw);
    const make = requireCase(dummyInner[command]);
    const remaining = sw.startsWith("63c") ? Number.parseInt(sw.slice(3), 16) : undefined;
    const code =
      sw === "9000"
        ? undefined
        : sw.startsWith("63c")
          ? "wrong-access-code"
          : (
              { "6983": "wallet-erased", "6985": "wrong-state", "6a80": "invalid-data" } as Record<
                string,
                CardErrorCode
              >
            )[sw];
    if (sw !== "9000" && code === undefined) {
      throw new Error(`no expected mapping for ${command} ${sw}`);
    }
    return make().map((inner) => ({
      name: `${step.sequence}[${step.index}] ${command} ${inner.name} → ${sw}`,
      inner,
      sw: Number.parseInt(sw, 16),
      code,
      remaining,
    }));
  });

describe("verify-sequence.json", () => {
  it("exposes the §7.3 constants the file fixes", () => {
    expect(ACCESS_LIMITS.failures).toBe(verifySequence.constants.L);
    expect(ACCESS_LIMITS.free).toBe(verifySequence.constants.F);
    expect(ACCESS_LIMITS.waits).toBe(verifySequence.constants.W);
  });

  it.each(stepRows.filter((row) => row.code === undefined))("$name returns its data", (row) => {
    const data = new Uint8Array(0);
    expect(result(row.inner, { data, sw: row.sw })).toStrictEqual(data);
  });

  // Amendment B1 (owner-approved, spec update pending) makes the VERIFY wait gate answer 6986 →
  // wait-required; the applet at the pinned commit still answers 6985, which the client maps to
  // wrong-state for every command — this test asserts the pinned mapping, not B1's.
  it.each(stepRows.filter((row) => row.code !== undefined))(
    "$name maps to its CardError",
    (row) => {
      const error = capture(() => result(row.inner, { data: new Uint8Array(0), sw: row.sw }));
      expect(error?.code).toBe(row.code);
      expect(error?.sw).toBe(row.sw);
      expect(error?.remaining).toBe(row.remaining);
    },
  );

  const statusRows = allSteps
    .filter((step) => step.status !== undefined)
    .map((step) => {
      const status = hex(requireCase(step.status));
      const decoded = decode.status(status);
      const expected =
        decoded.life === "blank" || decoded.tries === 0
          ? ("wrong-state" as const)
          : decoded.tries <= verifySequence.constants.L - verifySequence.constants.F
            ? verifySequence.constants.W
            : 0;
      return {
        name: `${step.sequence}[${step.index}] status ${step.status}`,
        decoded,
        expected,
      };
    });

  const wrongStateRows = statusRows.filter((row) => row.expected === "wrong-state");

  it.each(wrongStateRows)("$name gates the next verify as wrong-state", (row) => {
    expect(cardError(() => waitsBeforeVerify(row.decoded))).toBe("wrong-state");
  });

  const waitRows = statusRows.filter((row) => typeof row.expected === "number");

  it.each(waitRows)("$name needs $expected waits", (row) => {
    expect(waitsBeforeVerify(row.decoded)).toBe(row.expected);
  });
});
