#!/usr/bin/env python3
"""Independent host-side vectors for the qntx card protocol client (vectors/card/oracle.json).

Written from the applet repository's spec/protocol.md alone, in a different language and with
different libraries than the TypeScript client: libsecp256k1 (coincurve) for ECDSA, ECDH and
BIP-340, the reference Argon2 C implementation (argon2-cffi) for accessHash, pyca/cryptography
(OpenSSL) for AES-CBC, AES-CMAC and Ed25519 key derivation and verification, hashlib for the
hashes, and plain integer arithmetic for the Wei25519 <-> edwards25519 maps. The card-side
computations (session signature, Ed25519 begin/finish, offers, export heads) are simulated here
from the spec so that the client is tested against bytes it did not produce.

Every random value is a labelled SHA-256 of a fixed string, so the output is deterministic.

Requirements (any version providing these APIs; recorded at generation time):
  python3 -m venv venv && venv/bin/pip install cryptography==50.0.2 coincurve==21.0.0 \
      argon2-cffi==25.1.0
Usage: venv/bin/python scripts/vectors/card-oracle.py > vectors/card/oracle.json
"""
import hashlib
import json
import sys
from importlib.metadata import version

import argon2.low_level as argon2
import coincurve
from cryptography.hazmat.primitives import cmac as pyca_cmac
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

# secp256k1 (SEC 2 v2 §2.4.1)
P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141

# edwards25519 / Wei25519 (RFC 8032 §5.1, protocol.md §10.4)
Q = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, Q - 2, Q)) % Q
MONT_A = 486662
A3 = MONT_A * pow(3, Q - 2, Q) % Q
A_W = (3 - MONT_A * MONT_A) * pow(3, Q - 2, Q) % Q
B_W = (2 * MONT_A**3 - 9 * MONT_A) * pow(27, Q - 2, Q) % Q
C = 0x70D9120B9F5FF9442D84F723FC03B0813A5E2C2EB482E57D3391FB5500BA81E7

# protocol.md labels
LABEL_CERT = b"qntx-card/v1/cert"
LABEL_SESSION = b"qntx-card/v1/session"
LABEL_KDF_SESSION = b"qntx-card/v1/kdf-session"
LABEL_ACCESS = b"qntx-card/v1/access"
LABEL_OFFER = b"qntx-card/v1/offer"
LABEL_EXPORT = b"qntx-card/v1/export"
LABEL_KDF_TRANSFER = b"qntx-card/v1/kdf-transfer"
LABEL_ED_NONCE = b"qntx-card/v1/ed25519-nonce"

H = 0x80000000

# cert.json (applet spec/vectors, commit recorded in vectors/card/SOURCE)
CA1_PRIVATE = bytes.fromhex("a76d852de566723ec4e6414f49b80dd3899ef7661b9afc4e6dac489adcba69a7")
CARD1_PRIVATE = bytes.fromhex("7bd2a9b600c1d8f862ab32e276c36f81fbb340409bee50d9af060878c3abb7a1")
CARD2_PRIVATE = bytes.fromhex("4a02157daba557345b4027774e211885651bc46a9f90b9f9ad6648b1566218a8")


def det(label, n=32):
    out = b""
    counter = 0
    while len(out) < n:
        out += hashlib.sha256(b"qntx-card-oracle/" + label.encode() + bytes([counter])).digest()
        counter += 1
    return out[:n]


def scalar(label):
    counter = 0
    while True:
        k = int.from_bytes(det(f"{label}/{counter}"), "big")
        if 1 <= k < N:
            return k.to_bytes(32, "big")
        counter += 1


def u16(v):
    return v.to_bytes(2, "big")


def u32(v):
    return v.to_bytes(4, "big")


def sha256(*parts):
    return hashlib.sha256(b"".join(parts)).digest()


def sha512(*parts):
    return hashlib.sha512(b"".join(parts)).digest()


def card_id(compressed):
    return sha256(compressed)[:16]


def short_id(compressed):
    h = card_id(compressed)[:4].hex().upper()
    return f"{h[:4]}-{h[4:]}"


def pub(private, compressed=True):
    return coincurve.PrivateKey(private).public_key.format(compressed=compressed)


def ecdsa(private, message):
    """Sign(k, M) of protocol.md §1: ECDSA over SHA-256(M), r ‖ s (libsecp256k1: low s)."""
    sig = coincurve.PrivateKey(private).sign_recoverable(sha256(message), hasher=None)
    return sig[:64]


def high_s(sig):
    s = int.from_bytes(sig[32:], "big")
    return sig[:32] + (N - s).to_bytes(32, "big")


def ecdh_x(private, point):
    return coincurve.PublicKey(point).multiply(private).format(compressed=False)[1:33]


def kdf(z, label, ctx, length):
    """protocol.md §1 KDF: NIST SP 800-56C Rev. 2 one-step with SHA-256."""
    out = sha256(u32(1), z, label, ctx) + sha256(u32(2), z, label, ctx)
    return out[:length]


def aes_block(key, block):
    enc = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return enc.update(block) + enc.finalize()


def cbc(key, iv, data):
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return enc.update(data) + enc.finalize()


def aes_cmac(key, data):
    c = pyca_cmac.CMAC(algorithms.AES(key))
    c.update(data)
    return c.finalize()


def m2(data):
    padded = data + b"\x80"
    return padded + b"\x00" * (-len(padded) % 16)


def cert_for(private):
    a = pub(private)
    return a + ecdsa(CA1_PRIVATE, LABEL_CERT + a)


# edwards25519 arithmetic (affine, integers) for points the oracle must construct


def inv(x):
    return pow(x, Q - 2, Q)


def ed_add(p1, p2):
    x1, y1 = p1
    x2, y2 = p2
    t = D * x1 * x2 * y1 * y2 % Q
    return ((x1 * y2 + x2 * y1) * inv(1 + t) % Q, (y1 * y2 + x1 * x2) * inv(1 - t) % Q)


def ed_mul(k, p):
    acc = (0, 1)
    while k:
        if k & 1:
            acc = ed_add(acc, p)
        p = ed_add(p, p)
        k >>= 1
    return acc


def ed_decode(encoded):
    y = int.from_bytes(encoded, "little") & ((1 << 255) - 1)
    sign = encoded[31] >> 7
    x2 = (y * y - 1) * inv(D * y * y + 1) % Q
    x = pow(x2, (Q + 3) // 8, Q)
    if (x * x - x2) % Q:
        x = x * pow(2, (Q - 1) // 4, Q) % Q
    assert (x * x - x2) % Q == 0, "not a point"
    if x % 2 != sign:
        x = Q - x
    return (x, y)


def ed_encode(point):
    x, y = point
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


ED_BASE = ed_decode(bytes.fromhex("5866666666666666666666666666666666666666666666666666666666666666"))


def wei_from_edwards(point):
    """Inverse of the protocol.md §10.4 host map: u = (1 + y)/(1 − y), X = u + A₃, Y = c·u/x."""
    x, y = point
    u = (1 + y) * inv(1 - y) % Q
    big_x = (u + A3) % Q
    big_y = C * u * inv(x) % Q
    assert (big_y * big_y - (big_x**3 + A_W * big_x + B_W)) % Q == 0
    return big_x.to_bytes(32, "big") + big_y.to_bytes(32, "big")


def wei_on_curve(w):
    x = int.from_bytes(w[:32], "big")
    y = int.from_bytes(w[32:], "big")
    return x < Q and y < Q and (y * y - (x**3 + A_W * x + B_W)) % Q == 0


def ed_public(sk):
    """RFC 8032 §5.1.5 through pyca/cryptography; returns (a, prefix, encoded A)."""
    h = sha512(sk)
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    encoded = (
        Ed25519PrivateKey.from_private_bytes(sk).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    )
    assert ed_encode(ed_mul(a, ED_BASE)) == encoded
    return a, h[32:], encoded


def ed_verify(public, signature, message):
    try:
        Ed25519PublicKey.from_public_bytes(public).verify(signature, message)
        return True
    except Exception:
        return False


def tagged(tag, *parts):
    t = hashlib.sha256(tag.encode()).digest()
    return sha256(t, t, *parts)


def xonly_tweak(x, tweak):
    """x(lift_x(x) + t·G) through libsecp256k1 (secp256k1_xonly_pubkey_tweak_add)."""
    key = coincurve.PublicKeyXOnly(x)
    key.tweak_add(tweak)
    return key.format()


def path_bytes(path):
    return bytes([len(path)]) + b"".join(u32(i) for i in path)


def access_vectors():
    ids = [card_id(pub(CARD1_PRIVATE)), card_id(pub(CARD2_PRIVATE))]
    accepted = []
    for code, cid in [
        ("correct horse", ids[0]),
        ("correct horse", ids[1]),
        ("123456", ids[0]),
        (" ~!@#$%^&*()_+-={}[]|\\:;\"'<>,.?/`" + "x" * 30, ids[0]),
        ("A" * 64, ids[1]),
    ]:
        password = code.encode("ascii")
        salt = LABEL_ACCESS + cid
        digest = argon2.hash_secret_raw(
            secret=password,
            salt=salt,
            time_cost=3,
            memory_cost=65536,
            parallelism=4,
            hash_len=32,
            type=argon2.Type.ID,
            version=19,
        )
        accepted.append(
            {"code": code, "cardId": cid.hex(), "salt": salt.hex(), "accessHash": digest.hex()}
        )
    rejected = [
        {"name": "five-characters", "code": "12345"},
        {"name": "sixty-five-characters", "code": "A" * 65},
        {"name": "empty", "code": ""},
        {"name": "non-ascii", "code": "pässword"},
        {"name": "tab", "code": "pass\tword"},
        {"name": "newline", "code": "password\n"},
        {"name": "delete", "code": "password\x7f"},
        {"name": "nul", "code": "pass\x00word"},
        {"name": "astral", "code": "pass\U0001F600word"},
    ]
    return {"accepted": accepted, "rejected": rejected}


def wei_vectors():
    cases = [{"name": "base-point", "wei": wei_from_edwards(ED_BASE).hex(), "encoded": ed_encode(ED_BASE).hex()}]
    for name, sk in RFC8032:
        a, _, encoded = ed_public(sk)
        cases.append({"name": name, "wei": wei_from_edwards(ed_decode(encoded)).hex(), "encoded": encoded.hex()})
    for i in range(8):
        sk = det(f"wei/random/{i}")
        _, _, encoded = ed_public(sk)
        cases.append({"name": f"random-{i}", "wei": wei_from_edwards(ed_decode(encoded)).hex(), "encoded": encoded.hex()})
    test1 = cases[1]["wei"]
    # protocol.md §10.4 worked example: W(A) of TEST 1 is 5961a13b…96b48329 ‖ 53373f33…2aca8de5
    assert test1[:8] == "5961a13b" and test1[56:64] == "96b48329", test1
    assert test1[64:72] == "53373f33" and test1[120:] == "2aca8de5", test1

    base = wei_from_edwards(ED_BASE)
    bx = int.from_bytes(base[:32], "big")
    by = int.from_bytes(base[32:], "big")
    rejected = [
        {"name": "off-curve", "wei": (base[:32] + ((by + 1) % Q).to_bytes(32, "big")).hex()},
        {"name": "x-not-reduced", "wei": ((bx + Q).to_bytes(32, "big") + base[32:]).hex()},
        {"name": "y-not-reduced", "wei": (base[:32] + (by + Q).to_bytes(32, "big")).hex()},
        {"name": "order-two-y-zero", "wei": (A3.to_bytes(32, "big") + bytes(32)).hex()},
        {"name": "short", "wei": base[:63].hex()},
        {"name": "long", "wei": (base + b"\x00").hex()},
    ]
    assert wei_on_curve(bytes.fromhex(rejected[3]["wei"]))
    # u = −1 is the other exceptional input of the map; it is on the curve iff A − 2 is a square
    u_minus_one_x = (A3 - 1) % Q
    rhs = (u_minus_one_x**3 + A_W * u_minus_one_x + B_W) % Q
    if pow(rhs, (Q - 1) // 2, Q) == 1:
        y = pow(rhs, (Q + 3) // 8, Q)
        if (y * y - rhs) % Q:
            y = y * pow(2, (Q - 1) // 4, Q) % Q
        rejected.append({"name": "u-minus-one", "wei": (u_minus_one_x.to_bytes(32, "big") + y.to_bytes(32, "big")).hex()})
    # small-order and mixed-order points: on the curve, but outside the prime-order subgroup
    order8 = ed_decode(bytes.fromhex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"))
    assert ed_mul(8, order8) == (0, 1) and ed_mul(4, order8) != (0, 1)
    order4 = ed_mul(2, order8)
    rejected.append({"name": "order-eight", "wei": wei_from_edwards(order8).hex()})
    rejected.append({"name": "order-four", "wei": wei_from_edwards(order4).hex()})
    _, _, test1_encoded = ed_public(RFC8032[0][1])
    mixed = ed_add(ed_decode(test1_encoded), order8)
    rejected.append({"name": "mixed-order", "wei": wei_from_edwards(mixed).hex()})
    for r in rejected[6:]:
        assert wei_on_curve(bytes.fromhex(r["wei"])), r["name"]
    return {"accepted": cases, "rejected": rejected}


RFC8032 = [
    ("rfc8032-test1", bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")),
    ("rfc8032-test2", bytes.fromhex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")),
    ("rfc8032-test3", bytes.fromhex("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7")),
]


def card_ed25519(sk, counter, zr, cid, stream):
    """protocol.md §12.3 begin/finish as the card computes it; returns (W(R), le32(S))."""
    a, prefix, _ = ed_public(sk)
    r = int.from_bytes(sha512(LABEL_ED_NONCE, zr, prefix, cid, u32(counter)), "little") % L
    big_r = ed_mul(r, ED_BASE)
    k = int.from_bytes(sha512(stream), "little") % L
    s = (r + k * a) % L
    return wei_from_edwards(big_r), s.to_bytes(32, "little"), ed_encode(big_r)


def ed25519_vectors():
    cid1 = card_id(pub(CARD1_PRIVATE))
    cid2 = card_id(pub(CARD2_PRIVATE))
    cases = []
    messages = [
        ("empty", b""),
        ("one-byte", b"\x72"),
        ("one-chunk", det("ed/one-chunk", 172)),
        ("two-chunks", det("ed/two-chunks", 173)),
        ("solana-v1-max", det("ed/solana", 4032)),
    ]
    for (mname, message), (kname, sk) in zip(messages, RFC8032 + RFC8032[:2]):
        _, _, public = ed_public(sk)
        zr = det(f"ed/zr/{mname}")
        counter = 7 + len(cases)
        wei_r, s, encoded_r = card_ed25519(sk, counter, zr, cid1, b"")
        stream = encoded_r + public + message
        wei_r, s, encoded_r2 = card_ed25519(sk, counter, zr, cid1, stream)
        assert encoded_r2 == encoded_r
        signature = encoded_r + s
        assert ed_verify(public, signature, message)
        cases.append(
            {
                "name": f"{kname}-{mname}",
                "secretKey": sk.hex(),
                "publicKey": public.hex(),
                "weiPublicKey": wei_from_edwards(ed_decode(public)).hex(),
                "counter": counter,
                "zr": zr.hex(),
                "cardId": cid1.hex(),
                "message": message.hex(),
                "weiR": wei_r.hex(),
                "s": s.hex(),
                "signature": signature.hex(),
            }
        )
    # the same N and Zr on another member card give another r (protocol.md §12.3)
    sk = RFC8032[0][1]
    _, _, public = ed_public(sk)
    zr = det("ed/zr/members")
    w1, _, _ = card_ed25519(sk, 1, zr, cid1, b"")
    w2, _, _ = card_ed25519(sk, 1, zr, cid2, b"")
    assert w1 != w2
    member_pair = {"secretKey": sk.hex(), "counter": 1, "zr": zr.hex(), "cardIds": [cid1.hex(), cid2.hex()], "weiR": [w1.hex(), w2.hex()]}

    rejected = []
    base = cases[1]
    message = bytes.fromhex(base["message"])
    public = bytes.fromhex(base["publicKey"])
    encoded_r = bytes.fromhex(base["signature"])[:32]
    zr = bytes.fromhex(base["zr"])
    for name, stream in [
        ("stream-without-public-key", encoded_r + message),
        ("stream-other-message", encoded_r + public + message + b"\x00"),
        ("stream-other-r", ed_encode(ED_BASE) + public + message),
    ]:
        _, s, _ = card_ed25519(RFC8032[1][1], base["counter"], zr, cid1, stream)
        assert not ed_verify(public, encoded_r + s, message)
        rejected.append({"name": name, "s": s.hex()})
    s_int = int.from_bytes(bytes.fromhex(base["s"]), "little")
    rejected.append({"name": "s-plus-order", "s": (s_int + L).to_bytes(32, "little").hex()})
    return {"accepted": cases, "memberPair": member_pair, "rejected": rejected, "rejectedOf": base["name"]}


def ecdsa_vectors():
    cases = []
    rejected = []
    for i in range(4):
        priv = scalar(f"ecdsa/key/{i}")
        digest = det(f"ecdsa/digest/{i}")
        rec = coincurve.PrivateKey(priv).sign_recoverable(digest, hasher=None)
        low = rec[:64]
        recovery = rec[64]
        card = low if i % 2 == 0 else high_s(low)
        cases.append(
            {
                "name": f"key{i}-{'low' if i % 2 == 0 else 'high'}-s",
                "publicKey": pub(priv).hex(),
                "digest": digest.hex(),
                "card": card.hex(),
                "signature": low.hex(),
                "recovery": recovery,
            }
        )
    base = cases[0]
    sig = bytes.fromhex(base["card"])
    n_bytes = N.to_bytes(32, "big")
    for name, bad in [
        ("r-zero", bytes(32) + sig[32:]),
        ("s-zero", sig[:32] + bytes(32)),
        ("r-order", n_bytes + sig[32:]),
        ("s-order", sig[:32] + n_bytes),
        ("flipped", sig[:63] + bytes([sig[63] ^ 1])),
        ("other-key", bytes.fromhex(cases[1]["signature"])),
    ]:
        rejected.append({"name": name, "card": bad.hex()})
    return {"accepted": cases, "rejected": rejected, "rejectedOf": base["name"]}


def bip340_vectors():
    cases = []
    for i, merkle in enumerate([None, b"", det("bip340/merkle")]):
        for parity in (0, 1):
            counter = 0
            while True:
                priv = scalar(f"bip340/key/{i}/{parity}/{counter}")
                if pub(priv)[0] == 2 + parity:
                    break
                counter += 1
            internal = pub(priv)
            d0 = int.from_bytes(priv, "big")
            if internal[0] == 3:
                d0 = N - d0
            if merkle is None:
                tweak = bytes(32)
            else:
                tweak = tagged("TapTweak", internal[1:], merkle)
            d = (d0 + int.from_bytes(tweak, "big")) % N
            output = coincurve.PublicKeyXOnly.from_secret(d.to_bytes(32, "big")).format()
            assert xonly_tweak(internal[1:], tweak) == output
            message = det(f"bip340/message/{i}/{parity}")
            aux = det(f"bip340/aux/{i}/{parity}")
            sig = coincurve.PrivateKey(d.to_bytes(32, "big")).sign_schnorr(message, aux)
            assert coincurve.PublicKeyXOnly(output).verify(sig, message)
            cases.append(
                {
                    "name": f"{['zero-tweak', 'bip86', 'script-tree'][i]}-{'odd' if parity else 'even'}",
                    "internalKey": internal.hex(),
                    "merkleRoot": None if merkle is None else merkle.hex(),
                    "tweak": tweak.hex(),
                    "outputKey": output.hex(),
                    "message": message.hex(),
                    "signature": sig.hex(),
                }
            )
    # BIP-86 test vector m/86'/0'/0'/0/0 (bitcoin/bips bip-0086.mediawiki "Test vectors")
    internal_x = bytes.fromhex("cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115")
    t = tagged("TapTweak", internal_x)
    output = xonly_tweak(internal_x, t)
    assert output.hex() == "a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c"
    bip86 = {"internalKey": internal_x.hex(), "tweak": t.hex(), "outputKey": output.hex()}
    base = cases[2]
    sig = bytes.fromhex(base["signature"])
    rejected = [
        {"name": "flipped", "signature": (sig[:63] + bytes([sig[63] ^ 1])).hex()},
        {"name": "under-internal-key", "signature": cases[0]["signature"]},
    ]
    return {"accepted": cases, "bip86": bip86, "rejected": rejected, "rejectedOf": base["name"]}


def open_vectors():
    card = pub(CARD1_PRIVATE)
    cert = cert_for(CARD1_PRIVATE)
    host_private = scalar("open/host")
    card_private = scalar("open/card")
    host_eph = pub(host_private, compressed=False)
    card_eph = pub(card_private, compressed=False)
    transcript = LABEL_SESSION + host_eph + card_eph + card
    th = sha256(transcript)
    sig = ecdsa(CARD1_PRIVATE, transcript)
    z = ecdh_x(card_private, host_eph)
    assert z == ecdh_x(host_private, card_eph)
    keys = kdf(z, LABEL_KDF_SESSION, th, 64)
    request = bytes.fromhex("8010000041") + host_eph + b"\x00"
    response = card_eph + sig + cert + b"\x90\x00"

    # a certificate under the test CA for 33 bytes that are not a point
    not_a_point = b"\x02" + (5).to_bytes(32, "big")
    try:
        coincurve.PublicKey(not_a_point)
        raise AssertionError("x = 5 must not be on secp256k1")
    except ValueError:
        pass
    bad_cert = not_a_point + ecdsa(CA1_PRIVATE, LABEL_CERT + not_a_point)

    compressed_eph = pub(card_private)
    rejected = [
        {"name": "card-eph-compressed", "response": (compressed_eph + b"\x00" * 32 + sig + cert + b"\x90\x00").hex()},
        {"name": "card-eph-off-curve", "response": (card_eph[:64] + bytes([card_eph[64] ^ 1]) + sig + cert + b"\x90\x00").hex()},
        {"name": "certificate-key-not-a-point", "response": (card_eph + sig + bad_cert + b"\x90\x00").hex()},
        {"name": "signature-over-other-host-eph", "response": (card_eph + ecdsa(CARD1_PRIVATE, LABEL_SESSION + pub(scalar("open/other"), False) + card_eph + card) + cert + b"\x90\x00").hex()},
        {"name": "status-6985", "response": "6985"},
        {"name": "short", "response": response[:-3].hex() + "9000"},
        {"name": "long", "response": (response[:-2] + b"\x00\x90\x00").hex()},
    ]
    return {
        "anchor": pub(CA1_PRIVATE, compressed=False).hex(),
        "hostPrivate": host_private.hex(),
        "request": request.hex(),
        "response": response.hex(),
        "responseHighS": (card_eph + high_s(sig) + cert + b"\x90\x00").hex(),
        "identity": card.hex(),
        "cardId": card_id(card).hex(),
        "shortId": short_id(card),
        "ephemeralTag": sha256(card_eph)[:8].hex(),
        "keys": {"kce": keys[:16].hex(), "kcm": keys[16:32].hex(), "kre": keys[32:48].hex(), "krm": keys[48:].hex()},
        "rejected": rejected,
    }, keys


def record(keys, ctr, plain, command):
    enc_key = keys[:16] if command else keys[32:48]
    mac_key = keys[16:32] if command else keys[48:]
    iv = aes_block(enc_key, bytes([1 if command else 2]) + bytes(13) + u16(ctr))
    ct = cbc(enc_key, iv, m2(plain))
    tag = aes_cmac(mac_key, u16(ctr) + ct)[:8]
    if command:
        return bytes([0x80, 0x12, 0, 0, len(ct) + 8]) + ct + tag + b"\x00"
    return ct + tag + b"\x90\x00"


def transcript_vectors(keys):
    """One session from the open vector: every exchange as plaintext, command APDU and R-APDU."""
    exchanges = []
    ctr = [0]

    def exchange(name, ins, p1, p2, data, response, sw):
        plain = bytes([ins, p1, p2]) + data
        exchanges.append(
            {
                "name": name,
                "ctr": ctr[0],
                "plain": plain.hex(),
                "apdu": record(keys, ctr[0], plain, True).hex(),
                "data": response.hex(),
                "sw": sw,
                "rapdu": record(keys, ctr[0], response + bytes.fromhex(sw), False).hex(),
            }
        )
        ctr[0] += 1

    access_hash = det("transcript/access")
    master = pub(scalar("transcript/master"))
    cid = card_id(pub(CARD1_PRIVATE))
    cid2 = card_id(pub(CARD2_PRIVATE))
    exchange("status", 0x20, 0, 0, b"", b"\x02\x0a", "9000")
    exchange("verify-wrong", 0x22, 0, 0, det("transcript/wrong"), b"", "63c9")
    exchange("wait", 0x25, 0, 0, b"", b"", "9000")
    exchange("verify", 0x22, 0, 0, access_hash, master + b"\x01\x02" + cid + cid2, "9000")

    ecdsa_private = scalar("transcript/ecdsa")
    ecdsa_path = [44 | H, 60 | H, 0 | H, 0, 0]
    chain_code = det("transcript/chain")
    exchange("public-key-secp256k1", 0x30, 0, 0, path_bytes(ecdsa_path), pub(ecdsa_private) + chain_code, "9000")
    digest = det("transcript/digest")
    ecdsa_sig = high_s(coincurve.PrivateKey(ecdsa_private).sign_recoverable(digest, hasher=None)[:64])
    exchange("sign-ecdsa", 0x31, 0, 0, digest + path_bytes(ecdsa_path), ecdsa_sig, "9000")

    taproot_private = scalar("transcript/taproot")
    taproot_path = [86 | H, 0 | H, 0 | H, 0, 0]
    internal = pub(taproot_private)
    tweak = tagged("TapTweak", internal[1:])
    d0 = int.from_bytes(taproot_private, "big")
    if internal[0] == 3:
        d0 = N - d0
    d = ((d0 + int.from_bytes(tweak, "big")) % N).to_bytes(32, "big")
    message = det("transcript/sighash")
    schnorr_sig = coincurve.PrivateKey(d).sign_schnorr(message, det("transcript/aux"))
    exchange("public-key-taproot", 0x30, 0, 0, path_bytes(taproot_path), internal + det("transcript/chain2"), "9000")
    exchange("sign-bip340", 0x32, 0, 0, message + tweak + path_bytes(taproot_path), schnorr_sig, "9000")

    ed_sk = det("transcript/ed25519")
    ed_path = [44 | H, 501 | H, 0 | H, 0 | H]
    _, _, ed_public_key = ed_public(ed_sk)
    exchange("public-key-ed25519", 0x30, 1, 0, path_bytes(ed_path), wei_from_edwards(ed_decode(ed_public_key)), "9000")
    zr = det("transcript/zr")
    ed_message = det("transcript/solana", 600)
    wei_r, _, encoded_r = card_ed25519(ed_sk, 42, zr, cid, b"")
    exchange("ed25519-begin", 0x33, 0, 0, path_bytes(ed_path), wei_r, "9000")
    stream = encoded_r + ed_public_key + ed_message
    _, s, _ = card_ed25519(ed_sk, 42, zr, cid, stream)
    chunks = [stream[i : i + 236] for i in range(0, len(stream), 236)]
    for i, chunk in enumerate(chunks[:-1]):
        exchange(f"ed25519-update-{i}", 0x33, 1, 0, chunk, b"", "9000")
    exchange("ed25519-finish", 0x33, 2, 0, chunks[-1], s, "9000")
    assert ed_verify(ed_public_key, encoded_r + s, ed_message)
    exchange("change", 0x23, 0, 0, det("transcript/new-access"), b"", "9000")
    exchange("fault", 0x20, 0, 0, b"", b"", "6f00")
    return {
        "inputs": {
            "wrongAccessHash": det("transcript/wrong").hex(),
            "accessHash": access_hash.hex(),
            "newAccessHash": det("transcript/new-access").hex(),
            "ecdsaPath": ecdsa_path,
            "taprootPath": taproot_path,
            "ed25519Path": ed_path,
        },
        "exchanges": exchanges,
        "ecdsa": {"publicKey": pub(ecdsa_private).hex(), "digest": digest.hex(), "signature": high_s(ecdsa_sig).hex()},
        "bip340": {"internalKey": internal.hex(), "tweak": tweak.hex(), "message": message.hex(), "signature": schnorr_sig.hex()},
        "ed25519": {"publicKey": ed_public_key.hex(), "message": ed_message.hex(), "signature": (encoded_r + s).hex()},
        "walletInfo": {"masterPublicKey": master.hex(), "origin": "generated", "members": [cid.hex(), cid2.hex()]},
    }


def transfer_vectors():
    source = pub(CARD1_PRIVATE)
    target = pub(CARD2_PRIVATE)
    cert_s = cert_for(CARD1_PRIVATE)
    cert_t = cert_for(CARD2_PRIVATE)
    link_private = scalar("transfer/link")
    link = pub(link_private, compressed=False)
    offer = link + ecdsa(CARD2_PRIVATE, LABEL_OFFER + link)
    e = scalar("transfer/e")
    big_e = pub(e, compressed=False)
    m = LABEL_EXPORT + source + target + link + big_e
    head = big_e + ecdsa(CARD1_PRIVATE, m)
    z = ecdh_x(e, link)
    assert z == ecdh_x(link_private, big_e)
    keys = kdf(z, LABEL_KDF_TRANSFER, sha256(m), 32)
    payload_ct = det("transfer/payload", 160)
    payload = payload_ct + aes_cmac(keys[16:], payload_ct)

    other_link = pub(scalar("transfer/other-link"), compressed=False)
    rejected_offers = [
        {"name": "signed-by-source", "offer": (link + ecdsa(CARD1_PRIVATE, LABEL_OFFER + link)).hex()},
        {"name": "flipped-signature", "offer": (offer[:128] + bytes([offer[128] ^ 1])).hex()},
        {"name": "link-key-compressed", "offer": (b"\x02" + link[1:33] + link[33:] + offer[65:]).hex()},
        {"name": "link-key-off-curve", "offer": (link[:64] + bytes([link[64] ^ 1]) + offer[65:]).hex()},
        {"name": "other-link-key", "offer": (other_link + offer[65:]).hex()},
        {"name": "short", "offer": offer[:128].hex()},
    ]
    rejected_heads = [
        {"name": "swapped-identities", "head": (big_e + ecdsa(CARD1_PRIVATE, LABEL_EXPORT + target + source + link + big_e)).hex()},
        {"name": "other-link-key", "head": (big_e + ecdsa(CARD1_PRIVATE, LABEL_EXPORT + source + target + other_link + big_e)).hex()},
        {"name": "signed-by-target", "head": (big_e + ecdsa(CARD2_PRIVATE, m)).hex()},
        {"name": "ephemeral-off-curve", "head": (big_e[:64] + bytes([big_e[64] ^ 1]) + head[65:]).hex()},
        {"name": "long", "head": (head + b"\x00").hex()},
    ]
    return {
        "source": {"identity": source.hex(), "cert": cert_s.hex(), "cardId": card_id(source).hex()},
        "target": {"identity": target.hex(), "cert": cert_t.hex(), "cardId": card_id(target).hex()},
        "offer": offer.hex(),
        "offerHighS": (link + high_s(offer[65:])).hex(),
        "export0": ("410000" + (cert_t + offer).hex()),
        "head": head.hex(),
        "message": m.hex(),
        "import0": ("420000" + (cert_s + head).hex()),
        "export1": ("410100" + det("transfer/access-target").hex()),
        "accessHashTarget": det("transfer/access-target").hex(),
        "payload": payload.hex(),
        "import1": ("420100" + payload.hex()),
        "rejectedOffers": rejected_offers,
        "rejectedHeads": rejected_heads,
    }


def main():
    open_vector, keys = open_vectors()
    doc = {
        "generator": "scripts/vectors/card-oracle.py",
        "libraries": {name: version(name) for name in ("cryptography", "coincurve", "argon2-cffi")},
        "access": access_vectors(),
        "wei25519": wei_vectors(),
        "ed25519": ed25519_vectors(),
        "ecdsa": ecdsa_vectors(),
        "bip340": bip340_vectors(),
        "open": open_vector,
        "transcript": transcript_vectors(keys),
        "transfer": transfer_vectors(),
    }
    sys.stdout.write(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
