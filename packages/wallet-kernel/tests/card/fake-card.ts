/**
 * A hostile/configurable software card for kernel tests: the card side of §8 (SELECT, OPEN, the
 * §8.4 record layer) and the single-card inner commands (STATUS, CREATE, VERIFY, CHANGE, ERASE,
 * WAIT, PUBLIC_KEY). The honest path mirrors spec/protocol.md (including the VERIFY wait gate and
 * the `63Cx` countdown); `knobs` flips deviations mid-test — a cert chaining to no anchor, a bad
 * session signature, a replayed cardEph, STATUS lying about life/tries, corrupted response MACs, or
 * a tear on the next persistent write. Personalised under the ca1 test CA by default; pass
 * `cert`/`caPrivate` for other anchors.
 */
import { cbc, cmac, ecb } from "@noble/ciphers/aes.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, bytesToNumberLE, numberToBytesBE } from "@noble/curves/utils.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import Slip10 from "micro-key-producer/slip10.js";

import { ascii, u16, validUncompressedPoint } from "../../src/modules/card/protocol/bytes.ts";
import { cardId } from "../../src/modules/card/protocol/identity.ts";
import { kdf, m2, unM2 } from "../../src/modules/card/protocol/kdf.ts";
import { loadVectors } from "../helpers.ts";

const INS_OPEN = 0x10;
const INS_SESSION = 0x12;
const SELECT_APDU = "00a4040007f0716e7478010100";
const LABEL_SESSION = ascii("qntx-card/v1/session");
const LABEL_KDF_SESSION = ascii("qntx-card/v1/kdf-session");
const LABEL_CERT = ascii("qntx-card/v1/cert");
const LABEL_OFFER = ascii("qntx-card/v1/offer");
const LABEL_EXPORT = ascii("qntx-card/v1/export");
const LABEL_KDF_TRANSFER = ascii("qntx-card/v1/kdf-transfer");
const LABEL_FP = ascii("qntx-card/v1/fingerprint");
const LIMITS = { failures: 10, free: 3, waits: 15 };

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the vector shape is pinned
const CERT_VECTORS = loadVectors("card/cert.json") as {
  cas: ReadonlyArray<{ name: string; private: string; public: string }>;
};
const ca1 = CERT_VECTORS.cas.find((ca) => ca.name === "ca1");
if (ca1 === undefined) {
  throw new Error("vectors/card/cert.json has no ca1");
}

/** The ca1 test-CA secret the bridge personalises under — used to issue fake certs. */
export const CA1_PRIVATE: Uint8Array = hexToBytes(ca1.private);

/** The ca1 anchor public key — the fake card trusts peer certs chaining to it. */
const CA1_ANCHOR_PUBLIC: Uint8Array = hexToBytes(ca1.public);

/** Issues `cert = A(33) ‖ r‖s(64)` for `identitySecret`'s public key under `caPrivate`. */
export function issueCert(
  identitySecret: Uint8Array,
  caPrivate: Uint8Array = CA1_PRIVATE,
  extraEntropy?: Uint8Array,
): Uint8Array {
  const identity = secp256k1.getPublicKey(identitySecret, true);
  const digest = sha256(concatBytes(LABEL_CERT, identity));
  const signature = secp256k1.sign(digest, caPrivate, {
    prehash: false,
    lowS: false,
    ...(extraEntropy === undefined ? {} : { extraEntropy }),
  });
  return concatBytes(identity, signature);
}

const sw = (code: number): Uint8Array => u16(code);

/** Wei25519 constants of §10.4; the fake card maps its edwards point onto W(P). */
const A3 = BigInt("0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2451");
const C = BigInt("0x70d9120b9f5ff9442d84f723fc03b0813a5e2c2eb482e57d3391fb5500ba81e7");

/** The inverse of `edwardsEncode` — `W(P) = X‖Y` for an edwards point's affine form. */
function weiEncode(point: { toAffine: () => { x: bigint; y: bigint } }): Uint8Array {
  const { Fp } = ed25519.Point;
  const { x, y } = point.toAffine();
  const u = Fp.div(Fp.add(Fp.ONE, y), Fp.sub(Fp.ONE, y));
  const weiX = Fp.add(u, A3);
  const weiY = Fp.div(Fp.mul(C, u), x);
  const out = new Uint8Array(64);
  out.set(be32(weiX), 0);
  out.set(be32(weiY), 32);
  return out;
}

/** Big-endian u256 — the `W(P)` wire format. */
const be32 = (value: bigint): Uint8Array => {
  const bytes = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i -= 1) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
};

/** Little-endian u256 — the `le32(S)` wire format of SIGN_ED25519 finish. */
const le32 = (value: bigint): Uint8Array => {
  const bytes = new Uint8Array(32);
  let rest = value;
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
};

/** An honest r‖s ECDSA signature over `digest` under `priv`, but with the given nonce `k`. */
const ecdsaWithNonce = (digest: Uint8Array, priv: Uint8Array, nonce: Uint8Array): Uint8Array => {
  const { Fn } = secp256k1.Point;
  const k = Fn.create(bytesToNumberBE(nonce));
  const r = Fn.create(secp256k1.Point.BASE.multiply(k).toAffine().x);
  const s = Fn.mul(Fn.inv(k), Fn.add(bytesToNumberBE(digest), Fn.mul(r, Fn.fromBytes(priv))));
  return concatBytes(numberToBytesBE(r, 32), numberToBytesBE(s, 32));
};

export type FakeKnobs = {
  /** STATUS reports this instead of the real state (a lying card). */
  statusLife?: number;
  statusTries?: number;
  /** STATUS answers this status word instead of a real one (an impossible word → fault). */
  statusSw?: number;
  /** The OPEN session signature signs garbage instead of the transcript. */
  badSignature?: boolean;
  /** Always this cardEph — replays an ephemeral the host saw before. */
  fixedEph?: Uint8Array;
  /** Response-record MACs are corrupted after this many records. */
  badMacAfter?: number;
  /** Response records carry wrong padding (unM2 fails). */
  badPadding?: boolean;
  /** WalletInfo reports this master key instead of the wallet's. */
  walletInfoMaster?: Uint8Array;
  /** WalletInfo reports this member set instead of the wallet's. */
  walletInfoMembers?: Uint8Array[];
  /** PUBLIC_KEY answers 65 bytes that are not a curve point. */
  badPublicKey?: boolean;
  /** Every failed answer carries a stray data byte before the status word. */
  dataOnFailure?: boolean;
  /** From this response counter on, the card resends the previous record. */
  replayFrom?: number;
  /** The response at this counter is MACed with the next counter instead. */
  skipCtrAt?: number;
  /** SIGN_ECDSA signs with this nonce — every answer carries the same r. */
  ecdsaNonce?: Uint8Array;
  /** SIGN_ECDSA signs sha256(digest) instead of the digest. */
  ecdsaMutateDigest?: boolean;
  /** SIGN_ECDSA signs under a key derived from a different seed. */
  ecdsaWrongKey?: boolean;
  /** SIGN_BIP340 signs with `tweak + 1` instead of the requested tweak. */
  bip340WrongTweak?: boolean;
  /** SIGN_ED25519 begin returns `W` of a point that is not the stored nonce's. */
  ed25519WrongR?: boolean;
  /** SIGN_ED25519 finish returns a scalar at the group order (S ≥ ℓ). */
  ed25519BadS?: boolean;
  /** SIGN_ED25519 begin returns 64 bytes that are not a Wei25519 point. */
  ed25519BadWei?: boolean;
  /** OFFER signs garbage instead of the link key — the host must refuse to export to it. */
  offerBadSignature?: boolean;
  /**
   * §4.3 uninitialised: SELECT still answers 9000, `GET_IDENTITY` performs the next of seven
   * resumable init steps (`6283` until the last, then `A`), every other command answers `6283`.
   */
  uninitialised?: boolean;
  /** EXPORT head signs garbage instead of the transcript — the host must refuse the import. */
  exportBadSignature?: boolean;
  /** The next persistent write commits and the card loses power before it can respond. */
  dieAfterCommit?: boolean;
};

export type FakeCard = {
  readonly identity: Uint8Array;
  /** The identity secret — lets a twin card present the same identity under another cert. */
  readonly identitySecret: Uint8Array;
  readonly cert: Uint8Array;
  readonly cardId: Uint8Array;
  readonly knobs: FakeKnobs;
  /** Every inner instruction byte the session layer let through — VERIFY is `0x22`. */
  readonly received: number[];
  /** The host entropy the last generated-mode CREATE carried (bytes 32..64 of the payload). */
  readonly createEntropy: Uint8Array | undefined;
  /** What the last OPEN derived — leak tests assert none of it escapes the kernel. */
  readonly secrets: {
    eph?: Uint8Array;
    shared?: Uint8Array;
    keys?: Uint8Array;
  };
  /** Arm a tear: the `write`-th persistent write of a later command powers the card off. */
  readonly tearAt: (write: number) => void;
  /** Power cycle — clears the session, leaves persistent state. */
  readonly reset: () => void;
  readonly transmit: (apdu: Uint8Array) => Promise<Uint8Array | "torn">;
  /** Test view of the persistent state. */
  readonly state: { life: "blank" | "loaded"; fails: number };
  /** Plant a wallet without CREATE (a card loaded elsewhere). */
  readonly load: (seed: Uint8Array, accessHash: Uint8Array, others?: Uint8Array[]) => void;
  /** T-ERASE without going through the ERASE command — models the failure-limit wipe. */
  readonly wipe: () => void;
};

/** §5.2 — a peer cert must chain to the CA this card was personalised under (ca1). */
const peerIdentity = (peerCert: Uint8Array): Uint8Array | undefined => {
  if (peerCert.length !== 97) {
    return undefined;
  }
  const peer = peerCert.subarray(0, 33);
  try {
    if (
      secp256k1.verify(
        peerCert.subarray(33, 97),
        sha256(concatBytes(LABEL_CERT, peer)),
        CA1_ANCHOR_PUBLIC,
        {
          prehash: false,
          lowS: false,
        },
      )
    ) {
      return new Uint8Array(peer);
    }
  } catch {
    // not a point — falls through
  }
  return undefined;
};

export function createFakeCard(opts?: {
  cert?: Uint8Array;
  identitySecret?: Uint8Array;
  random?: (n: number) => Uint8Array;
  knobs?: FakeKnobs;
}): FakeCard {
  const random =
    opts?.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const knobs: FakeKnobs = { ...opts?.knobs };
  const identitySecret = opts?.identitySecret ?? random(32);
  const identity = secp256k1.getPublicKey(identitySecret, true);
  const ownId = cardId(identity);
  const cert = opts?.cert ?? issueCert(identitySecret);
  const state = { life: "blank" as "blank" | "loaded", fails: 0 };
  let wallet:
    | { seed: Uint8Array; accessHash: Uint8Array; members: Uint8Array[]; origin: number }
    | undefined;
  let session:
    | { keys: Uint8Array; ctr: number; verified: boolean; seed: Uint8Array | undefined }
    | undefined;
  let offerValid = false;
  let createEntropy: Uint8Array | undefined;
  let linkSecret: Uint8Array | undefined;
  let pendingExport: { kte: Uint8Array; ktm: Uint8Array } | undefined;
  let pendingImport: { kte: Uint8Array; ktm: Uint8Array; sender: Uint8Array } | undefined;
  let waited = 0;
  let torn = false;
  let initSteps = 7;
  let tearAt: number | undefined;
  let edStream: { r: bigint; a: bigint; stream: Uint8Array } | undefined;

  const write = (): boolean => {
    // A persistent write consumed an armed tear.
    if (tearAt !== undefined) {
      tearAt -= 1;
      if (tearAt === 0) {
        tearAt = undefined;
        torn = true;
        return false;
      }
    }
    return true;
  };

  const received: number[] = [];
  const secrets: { eph?: Uint8Array; shared?: Uint8Array; keys?: Uint8Array } = {};

  const walletInfo = (): Uint8Array => {
    if (wallet === undefined) {
      throw new Error("walletInfo without wallet");
    }
    const master = knobs.walletInfoMaster ?? HDKey.fromMasterSeed(wallet.seed).publicKey;
    if (master === null) {
      throw new Error("the planted seed has no valid master key");
    }
    const members = knobs.walletInfoMembers ?? wallet.members;
    return concatBytes(master, new Uint8Array([wallet.origin, members.length]), ...members);
  };

  const inner = (ins: number, p1: number, p2: number, data: Uint8Array): Uint8Array => {
    const live = session;
    const verified = live?.verified === true;
    received.push(ins);
    switch (ins) {
      case 0x20: {
        // STATUS: no verification needed.
        if (knobs.statusSw !== undefined) {
          return sw(knobs.statusSw);
        }
        const life = knobs.statusLife ?? (state.life === "blank" ? 0x01 : 0x02);
        const tries =
          knobs.statusTries ?? (state.life === "blank" ? 0x00 : LIMITS.failures - state.fails);
        return concatBytes(new Uint8Array([life & 0xff, tries & 0xff]), sw(0x9000));
      }
      case 0x21: {
        // CREATE — BLANK only.
        if (state.life !== "blank" || live === undefined) {
          return sw(0x6985);
        }
        if (p1 !== 0x00 && p1 !== 0x01) {
          return sw(0x6a86);
        }
        const min = p1 === 0x00 ? 64 : 96;
        if (data.length < min || (data.length - min) % 16 !== 0) {
          return sw(0x6700);
        }
        const accessHash = data.subarray(0, 32);
        const material = data.subarray(32, min);
        if (p1 === 0x00) {
          createEntropy = new Uint8Array(material);
        }
        const others: Uint8Array[] = [];
        for (let off = min; off < data.length; off += 16) {
          const id = data.subarray(off, off + 16);
          if (equalBytes(id, ownId) || others.some((o) => equalBytes(o, id))) {
            return sw(0x6a80);
          }
          others.push(new Uint8Array(id));
        }
        const seed =
          p1 === 0x01
            ? new Uint8Array(material)
            : sha512(concatBytes(ascii("qntx-card/v1/seed"), random(32), material));
        if (HDKey.fromMasterSeed(seed).publicKey === null) {
          return sw(0x6a80);
        }
        if (!write()) {
          return new Uint8Array(0); // torn mid-transaction — transmit turns it into TORN
        }
        wallet = {
          seed,
          accessHash: new Uint8Array(accessHash),
          members: [ownId, ...others],
          origin: p1 === 0x00 ? 0x01 : 0x02,
        };
        offerValid = false;
        linkSecret = undefined;
        pendingImport = undefined;
        state.life = "loaded";
        state.fails = 0;
        live.verified = true;
        live.seed = seed;
        if (knobs.dieAfterCommit === true) {
          knobs.dieAfterCommit = false;
          torn = true;
          return new Uint8Array(0);
        }
        return concatBytes(walletInfo(), sw(0x9000));
      }
      case 0x22:
        // VERIFY — §9.5.
        if (state.life !== "loaded" || live === undefined || wallet === undefined) {
          return sw(0x6985);
        }
        if (p1 !== 0 || p2 !== 0) {
          return sw(0x6a86);
        }
        if (data.length !== 32) {
          return sw(0x6700);
        }
        live.verified = false;
        live.seed = undefined;
        if (state.fails >= LIMITS.failures) {
          erase();
          return sw(0x6983);
        }
        if (state.fails >= LIMITS.free && waited < LIMITS.waits) {
          return sw(0x6985);
        }
        waited = 0;
        if (!write()) {
          return new Uint8Array(0);
        }
        state.fails += 1;
        if (equalBytes(data, wallet.accessHash)) {
          if (!write()) {
            return new Uint8Array(0);
          }
          state.fails = 0;
          live.verified = true;
          live.seed = wallet.seed;
          return concatBytes(walletInfo(), sw(0x9000));
        }
        if (state.fails >= LIMITS.failures) {
          erase();
          return sw(0x6983);
        }
        return sw(0x63c0 | (LIMITS.failures - state.fails));

      case 0x23:
        // CHANGE — verified only.
        if (state.life !== "loaded" || live === undefined) {
          return sw(0x6985);
        }
        if (p1 !== 0 || p2 !== 0) {
          return sw(0x6a86);
        }
        if (data.length !== 32) {
          return sw(0x6700);
        }
        if (!verified || wallet === undefined) {
          return sw(0x6982);
        }
        if (!write()) {
          return new Uint8Array(0);
        }
        wallet.accessHash = new Uint8Array(data);
        return sw(0x9000);

      case 0x24:
        // ERASE — verified only.
        if (state.life !== "loaded" || live === undefined) {
          return sw(0x6985);
        }
        if (p1 !== 0 || p2 !== 0) {
          return sw(0x6a86);
        }
        if (data.length > 0) {
          return sw(0x6700);
        }
        if (!verified) {
          return sw(0x6982);
        }
        if (!write()) {
          return new Uint8Array(0);
        }
        erase();
        return sw(0x9000);

      case 0x25:
        // WAIT — LOADED only.
        if (state.life !== "loaded") {
          return sw(0x6985);
        }
        if (p1 !== 0 || p2 !== 0) {
          return sw(0x6a86);
        }
        if (data.length > 0) {
          return sw(0x6700);
        }
        waited += 1;
        return sw(0x9000);

      case 0x30: {
        // PUBLIC_KEY — verified only.
        if (state.life !== "loaded" || live === undefined) {
          return sw(0x6985);
        }
        if (p1 !== 0x00 && p1 !== 0x01) {
          return sw(0x6a86);
        }
        const parsed = parsePath(data);
        if (parsed === "error") {
          return sw(0x6a80);
        }
        if (!verified) {
          return sw(0x6982);
        }
        if (knobs.badPublicKey === true) {
          return concatBytes(new Uint8Array(65), sw(0x9000));
        }
        const { seed } = live;
        if (seed === undefined) {
          return sw(0x6f00);
        }
        if (p1 === 0x00) {
          let node = HDKey.fromMasterSeed(seed);
          for (const index of parsed) {
            const child = node.deriveChild(index);
            if (child.publicKey === null) {
              return sw(0x6a80);
            }
            node = child;
          }
          if (node.publicKey === null || node.chainCode === null) {
            return sw(0x6a80);
          }
          return concatBytes(node.publicKey, node.chainCode, sw(0x9000));
        }
        if (parsed.some((index) => index < 0x80000000)) {
          return sw(0x6a80);
        }
        let node = Slip10.fromMasterSeed(seed);
        for (const index of parsed) {
          node = node.deriveChild(index);
        }
        const point = ed25519.Point.fromBytes(ed25519.getPublicKey(node.privateKey));
        return concatBytes(weiEncode(point), sw(0x9000));
      }
      case 0x31: {
        // SIGN_ECDSA — verified only, `digest(32) ‖ path` → `r‖s`.
        if (state.life !== "loaded" || live === undefined) {
          return sw(0x6985);
        }
        if (p1 !== 0 || p2 !== 0) {
          return sw(0x6a86);
        }
        if (data.length < 33 || (data.length - 33) % 4 !== 0) {
          return sw(0x6700);
        }
        const parsed = parsePath(data.subarray(32));
        if (parsed === "error") {
          return sw(0x6a80);
        }
        if (!verified) {
          return sw(0x6982);
        }
        const { seed } = live;
        if (seed === undefined) {
          return sw(0x6f00);
        }
        const privateKey = secpPrivate(parsed, knobs.ecdsaWrongKey === true ? sha256(seed) : seed);
        if (privateKey === undefined) {
          return sw(0x6a80);
        }
        const digest =
          knobs.ecdsaMutateDigest === true ? sha256(data.subarray(0, 32)) : data.subarray(0, 32);
        const signature =
          knobs.ecdsaNonce === undefined
            ? secp256k1.sign(digest, privateKey, { prehash: false, lowS: false })
            : ecdsaWithNonce(digest, privateKey, knobs.ecdsaNonce);
        return concatBytes(signature, sw(0x9000));
      }
      case 0x32: {
        // SIGN_BIP340 — verified only, `message(32) ‖ tweak(32) ‖ path` → `R_x‖s`.
        if (state.life !== "loaded" || live === undefined) {
          return sw(0x6985);
        }
        if (p1 !== 0 || p2 !== 0) {
          return sw(0x6a86);
        }
        if (data.length < 65 || (data.length - 65) % 4 !== 0) {
          return sw(0x6700);
        }
        const parsed = parsePath(data.subarray(64));
        if (parsed === "error") {
          return sw(0x6a80);
        }
        if (!verified) {
          return sw(0x6982);
        }
        const { seed } = live;
        if (seed === undefined) {
          return sw(0x6f00);
        }
        const privateKey = secpPrivate(parsed, seed);
        if (privateKey === undefined) {
          return sw(0x6a80);
        }
        const { Fn } = secp256k1.Point;
        const d0 = Fn.fromBytes(privateKey);
        const internal =
          secp256k1.Point.BASE.multiply(d0).toAffine().y % 2n === 0n ? d0 : Fn.neg(d0);
        let tweak = bytesToNumberBE(data.subarray(32, 64));
        if (knobs.bip340WrongTweak === true) {
          tweak += 1n;
        }
        if (tweak >= Fn.ORDER) {
          return sw(0x6a80);
        }
        const tweaked = Fn.create(internal + tweak);
        if (tweaked === 0n) {
          return sw(0x6a80);
        }
        const signature = schnorr.sign(
          data.subarray(0, 32),
          numberToBytesBE(tweaked, 32),
          random(32),
        );
        return concatBytes(signature, sw(0x9000));
      }
      case 0x33: {
        // SIGN_ED25519 — verified only; begin(path) → W(R), update/finish stream → le32(S).
        if (state.life !== "loaded" || live === undefined) {
          return sw(0x6985);
        }
        if (p2 !== 0 || p1 > 2) {
          return sw(0x6a86);
        }
        if (!verified) {
          return sw(0x6982);
        }
        if (p1 === 0x00) {
          const parsed = parsePath(data);
          if (parsed === "error" || parsed.some((index) => index < 0x80000000)) {
            return sw(0x6a80);
          }
          const { seed } = live;
          if (seed === undefined) {
            return sw(0x6f00);
          }
          let node = Slip10.fromMasterSeed(seed);
          for (const index of parsed) {
            node = node.deriveChild(index);
          }
          const { scalar } = ed25519.utils.getExtendedPublicKey(node.privateKey);
          const { Fn } = ed25519.Point;
          const r = Fn.create(bytesToNumberBE(random(32)));
          edStream = { r, a: scalar, stream: new Uint8Array(0) };
          const nonce = knobs.ed25519WrongR === true ? Fn.create(r + 1n) : r;
          const wei =
            knobs.ed25519BadWei === true
              ? random(64)
              : weiEncode(ed25519.Point.BASE.multiply(nonce));
          return concatBytes(wei, sw(0x9000));
        }
        if (edStream === undefined) {
          return sw(0x6985);
        }
        edStream.stream = concatBytes(edStream.stream, data);
        if (p1 === 0x01) {
          return sw(0x9000);
        }
        const { Fn } = ed25519.Point;
        const challenge = Fn.create(bytesToNumberLE(sha512(edStream.stream)));
        const s =
          knobs.ed25519BadS === true ? Fn.ORDER : Fn.create(edStream.r + challenge * edStream.a);
        edStream = undefined;
        return concatBytes(le32(s), sw(0x9000));
      }
      case 0x40: {
        // OFFER — §9.12: BLANK or LOADED; a valid offer re-answers the same link key.
        if (data.length > 0) {
          return sw(0x6700);
        }
        if (!offerValid) {
          if (!write()) {
            return new Uint8Array(0);
          }
          linkSecret = random(32);
          offerValid = true;
          if (knobs.dieAfterCommit === true) {
            knobs.dieAfterCommit = false;
            torn = true;
            return new Uint8Array(0);
          }
        }
        if (linkSecret === undefined) {
          return sw(0x6985);
        }
        const linkKey = secp256k1.getPublicKey(linkSecret, false);
        const digest =
          knobs.offerBadSignature === true
            ? sha256(ascii("garbage"))
            : sha256(concatBytes(LABEL_OFFER, linkKey));
        const signature = secp256k1.sign(digest, identitySecret, {
          prehash: false,
          lowS: false,
        });
        return concatBytes(linkKey, signature, sw(0x9000));
      }
      case 0x41:
        // EXPORT — §9.13: verified LOADED card only.
        if (state.life !== "loaded" || live === undefined || !verified || wallet === undefined) {
          return sw(0x6985);
        }
        if (p1 === 0x00) {
          if (data.length !== 226) {
            return sw(0x6700);
          }
          const certT = data.subarray(0, 97);
          const linkT = data.subarray(97, 162);
          const sigT = data.subarray(162, 226);
          const aT = peerIdentity(certT);
          if (aT === undefined || equalBytes(aT, identity)) {
            return sw(0x6a80);
          }
          if (!wallet.members.some((m) => equalBytes(m, cardId(aT)))) {
            return sw(0x6a80);
          }
          if (
            linkT[0] !== 0x04 ||
            !secp256k1.verify(sigT, sha256(concatBytes(LABEL_OFFER, linkT)), aT, {
              prehash: false,
              lowS: false,
            })
          ) {
            return sw(0x6a80);
          }
          const e = random(32);
          const E = secp256k1.getPublicKey(e, false);
          let Z: Uint8Array;
          try {
            Z = secp256k1.getSharedSecret(e, linkT, false).subarray(1, 33);
          } catch {
            return sw(0x6a80);
          }
          const TH = sha256(concatBytes(LABEL_EXPORT, identity, aT, linkT, E));
          const sigS = secp256k1.sign(
            knobs.exportBadSignature === true ? sha256(ascii("garbage")) : TH,
            identitySecret,
            { prehash: false, lowS: false },
          );
          const K = kdf(Z, LABEL_KDF_TRANSFER, TH, 32);
          pendingExport = { kte: K.subarray(0, 16), ktm: K.subarray(16, 32) };
          return concatBytes(E, sigS, sw(0x9000));
        }
        if (p1 === 0x01) {
          if (data.length !== 32) {
            return sw(0x6700);
          }
          const keys = pendingExport;
          if (keys === undefined) {
            return sw(0x6985);
          }
          const payload = concatBytes(
            new Uint8Array([wallet.origin & 0xff]),
            wallet.seed,
            data,
            new Uint8Array([wallet.members.length]),
            ...wallet.members,
          );
          const ct = cbc(keys.kte, new Uint8Array(16), { disablePadding: true }).encrypt(
            m2(payload),
          );
          const tag = cmac(ct, keys.ktm);
          pendingExport = undefined;
          return concatBytes(ct, tag, sw(0x9000));
        }
        return sw(0x6a86);

      case 0x42:
        // IMPORT — §9.14: BLANK installs, LOADED re-seals the same wallet.
        if (p1 === 0x00) {
          if (data.length !== 226) {
            return sw(0x6700);
          }
          if (!offerValid || linkSecret === undefined) {
            return sw(0x6985);
          }
          const certS = data.subarray(0, 97);
          const E = data.subarray(97, 162);
          const sigS = data.subarray(162, 226);
          const aS = peerIdentity(certS);
          if (aS === undefined || equalBytes(aS, identity)) {
            return sw(0x6a80);
          }
          if (
            state.life === "loaded" &&
            (wallet === undefined || !wallet.members.some((m) => equalBytes(m, cardId(aS))))
          ) {
            return sw(0x6a80);
          }
          const linkKey = secp256k1.getPublicKey(linkSecret, false);
          const TH = sha256(concatBytes(LABEL_EXPORT, aS, identity, linkKey, E));
          if (!secp256k1.verify(sigS, TH, aS, { prehash: false, lowS: false })) {
            return sw(0x6a80);
          }
          if (!validUncompressedPoint(E)) {
            return sw(0x6a80);
          }
          const Z = secp256k1.getSharedSecret(linkSecret, E, false).subarray(1, 33);
          const K = kdf(Z, LABEL_KDF_TRANSFER, TH, 32);
          pendingImport = {
            kte: K.subarray(0, 16),
            ktm: K.subarray(16, 32),
            sender: cardId(aS),
          };
          return sw(0x9000);
        }
        if (p1 === 0x01) {
          if (data.length !== 160 && data.length !== 176) {
            return sw(0x6700);
          }
          const keys = pendingImport;
          if (!offerValid || keys === undefined) {
            return sw(0x6985);
          }
          const ct = data.subarray(0, -16);
          const tag = data.subarray(-16);
          if (!equalBytes(cmac(ct, keys.ktm), tag)) {
            return sw(0x6a80);
          }
          const padded = cbc(keys.kte, new Uint8Array(16), {
            disablePadding: true,
          }).decrypt(ct);
          const payload = unM2(padded);
          if (
            payload === undefined ||
            payload.length < 98 + 32 ||
            (payload.length - 98) % 16 !== 0
          ) {
            return sw(0x6a80);
          }
          const origin = payload[0] ?? 0;
          const seed = payload.subarray(1, 65);
          const hashT = payload.subarray(65, 97);
          const c = payload[97] ?? 0;
          if (
            (origin !== 0x01 && origin !== 0x02) ||
            c < 2 ||
            c > 3 ||
            payload.length !== 98 + 16 * c
          ) {
            return sw(0x6a80);
          }
          const ids: Uint8Array[] = [];
          for (let i = 0; i < c; i += 1) {
            ids.push(payload.subarray(98 + 16 * i, 98 + 16 * (i + 1)));
          }
          if (
            ids.some((id, i) => ids.slice(i + 1).some((o) => equalBytes(o, id))) ||
            !ids.some((id) => equalBytes(id, ownId)) ||
            !ids.some((id) => equalBytes(id, keys.sender))
          ) {
            return sw(0x6a80);
          }
          if (HDKey.fromMasterSeed(seed).publicKey === null) {
            return sw(0x6a80);
          }
          if (state.life === "loaded") {
            if (wallet === undefined || origin !== wallet.origin) {
              return sw(0x6a80);
            }
            if (
              wallet.members.length !== c ||
              !wallet.members.every((m, i) => equalBytes(m, ids[i] ?? m))
            ) {
              return sw(0x6a80);
            }
            if (
              !equalBytes(
                sha256(concatBytes(LABEL_FP, seed)),
                sha256(concatBytes(LABEL_FP, wallet.seed)),
              )
            ) {
              return sw(0x6a80);
            }
          }
          if (!write()) {
            return new Uint8Array(0);
          }
          wallet = {
            seed: new Uint8Array(seed),
            accessHash: new Uint8Array(hashT),
            members: ids.map((id) => new Uint8Array(id)),
            origin,
          };
          state.life = "loaded";
          state.fails = 0;
          offerValid = false;
          linkSecret = undefined;
          pendingImport = undefined;
          if (live !== undefined) {
            live.verified = false;
            live.seed = undefined;
          }
          if (knobs.dieAfterCommit === true) {
            knobs.dieAfterCommit = false;
            torn = true;
            return new Uint8Array(0);
          }
          return concatBytes(walletInfo(), sw(0x9000));
        }
        return sw(0x6a86);

      default:
        return sw(0x6d00);
    }
  };

  const erase = (): void => {
    wallet = undefined;
    state.life = "blank";
    state.fails = 0;
    offerValid = false;
    linkSecret = undefined;
    pendingExport = undefined;
    pendingImport = undefined;
    if (session !== undefined) {
      session.verified = false;
      session.seed = undefined;
    }
    waited = 0;
  };

  const open = (apdu: Uint8Array): Uint8Array => {
    if (apdu.length < 5 || apdu[4] !== 0x41 || apdu.length < 5 + 65) {
      return u16(0x6700);
    }
    const hostEph = apdu.subarray(5, 70);
    if (!validUncompressedPoint(hostEph)) {
      return u16(0x6a80);
    }
    const ephSecret = knobs.fixedEph ?? random(32);
    const cardEph = secp256k1.getPublicKey(ephSecret, false);
    const transcriptHash = sha256(concatBytes(LABEL_SESSION, hostEph, cardEph, identity));
    const signed = knobs.badSignature === true ? sha256(ascii("garbage")) : transcriptHash;
    const signature = secp256k1.sign(signed, identitySecret, { prehash: false, lowS: false });
    const shared = secp256k1.getSharedSecret(ephSecret, hostEph, true);
    const keys = kdf(shared.subarray(1, 33), LABEL_KDF_SESSION, transcriptHash, 64);
    session = { keys, ctr: 0, verified: false, seed: undefined };
    secrets.eph = new Uint8Array(ephSecret);
    secrets.shared = shared;
    secrets.keys = keys;
    return concatBytes(cardEph, signature, cert, u16(0x9000));
  };

  const exchange = (apdu: Uint8Array): Uint8Array => {
    const live = session;
    if (live === undefined) {
      return u16(0x6985);
    }
    const record = apdu.subarray(5, -1);
    const { ctr } = live;
    const tag = record.subarray(-8);
    const ciphertext = record.subarray(0, -8);
    const expected = cmac(concatBytes(u16(ctr), ciphertext), live.keys.subarray(16, 32)).subarray(
      0,
      8,
    );
    if (!equalBytes(tag, expected)) {
      session = undefined;
      return u16(0x6982);
    }
    const kce = live.keys.subarray(0, 16);
    const padded = cbc(kce, recordIv(kce, 0x01, ctr), { disablePadding: true }).decrypt(ciphertext);
    const plain = unM2(padded);
    if (plain === undefined || plain.length < 3) {
      session = undefined;
      return u16(0x6982);
    }
    const answer = inner(plain[0] ?? 0, plain[1] ?? 0, plain[2] ?? 0, plain.subarray(3));
    if (answer.length === 0) {
      // The command's persistent write was torn.
      return new Uint8Array(0);
    }
    const failed = answer.length < 2 || !equalBytes(answer.subarray(-2), sw(0x9000));
    const body =
      knobs.dataOnFailure === true && failed ? concatBytes(new Uint8Array([0x00]), answer) : answer;
    const response = knobs.badPadding === true ? padded : m2(body);
    const outCtr = knobs.skipCtrAt === ctr ? ctr + 1 : ctr;
    const kre = live.keys.subarray(32, 48);
    const outCt = cbc(kre, recordIv(kre, 0x02, outCtr), { disablePadding: true }).encrypt(response);
    const macKey = live.keys.subarray(48, 64);
    let outTag = cmac(concatBytes(u16(outCtr), outCt), macKey).subarray(0, 8);
    if (knobs.badMacAfter !== undefined && ctr >= knobs.badMacAfter) {
      outTag = new Uint8Array(outTag);
      outTag[0] = (outTag[0] ?? 0) ^ 0xff;
    }
    live.ctr = ctr + 1;
    const out = concatBytes(outCt, outTag, u16(0x9000));
    if (knobs.replayFrom !== undefined && ctr >= knobs.replayFrom && lastResponse !== undefined) {
      return lastResponse;
    }
    lastResponse = out;
    return out;
  };

  let lastResponse: Uint8Array | undefined;

  return {
    identity,
    identitySecret,
    cert,
    cardId: ownId,
    knobs,
    received,
    get createEntropy() {
      return createEntropy;
    },
    secrets,
    tearAt: (write) => {
      tearAt = write;
    },
    reset: () => {
      torn = false;
      session = undefined;
      edStream = undefined;
      pendingExport = undefined;
      pendingImport = undefined;
      waited = 0;
    },
    state,
    load: (seed, accessHash, others = []) => {
      wallet = {
        seed: new Uint8Array(seed),
        accessHash: new Uint8Array(accessHash),
        members: [ownId, ...others],
        origin: 0x02,
      };
      state.life = "loaded";
      state.fails = 0;
    },
    wipe: () => {
      erase();
    },
    // oxlint-disable-next-line typescript/require-await -- the FieldCard contract is async
    transmit: async (apdu) => {
      if (torn) {
        return "torn" as const;
      }
      if (equalBytes(apdu, hexToBytes(SELECT_APDU))) {
        session = undefined;
        edStream = undefined;
        pendingExport = undefined;
        pendingImport = undefined;
        waited = 0;
        return u16(0x9000);
      }
      if (knobs.uninitialised === true) {
        // §4.3: GET_IDENTITY steps the resumable init; the completing call answers A(33).
        if (apdu.length >= 2 && apdu[0] === 0x80 && apdu[1] === 0xe0) {
          initSteps -= 1;
          if (initSteps <= 0) {
            knobs.uninitialised = false;
            return concatBytes(identity, u16(0x9000));
          }
        }
        return u16(0x6283);
      }
      if (apdu.length < 4 || apdu[0] !== 0x80) {
        return u16(0x6e00);
      }
      switch (apdu[1]) {
        case INS_OPEN: {
          const out = open(apdu);
          return out;
        }
        case INS_SESSION: {
          const out = exchange(apdu);
          if (out.length === 0) {
            return "torn" as const;
          }
          return out;
        }
        default:
          return u16(0x6d00);
      }
    },
  };
}

/** The BIP-32 private key of `seed` at `path`, or `undefined` when a child is invalid. */
const secpPrivate = (path: ReadonlyArray<number>, seed: Uint8Array): Uint8Array | undefined => {
  let node = HDKey.fromMasterSeed(seed);
  for (const index of path) {
    node = node.deriveChild(index);
    if (node.privateKey === undefined || node.privateKey === null) {
      return undefined;
    }
  }
  return node.privateKey ?? undefined;
};

/** `path = depth(1) ‖ u32(index)…` — §9.2. */
const parsePath = (data: Uint8Array): number[] | "error" => {
  if (data.length === 0) {
    return "error";
  }
  const depth = data[0] ?? 0;
  if (depth < 1 || depth > 10 || data.length !== 1 + 4 * depth) {
    return "error";
  }
  const path: number[] = [];
  for (let i = 0; i < depth; i += 1) {
    path.push(new DataView(data.buffer, data.byteOffset + 1 + 4 * i, 4).getUint32(0));
  }
  return path;
};

/** `IV = AES-ECB(key, direction ‖ 13×0x00 ‖ u16(counter))` (§8.4). */
const recordIv = (key: Uint8Array, direction: number, counter: number): Uint8Array => {
  const block = new Uint8Array(16);
  block[0] = direction;
  block.set(u16(counter), 14);
  return ecb(key, { disablePadding: true }).encrypt(block);
};
