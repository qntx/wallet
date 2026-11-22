/**
 * Bare-Hermes smoke for the card protocol client: bundled to a single classic script and run on the
 * `hermes` CLI. No global shims at all — `print`/`quit` are the only host functions — so this
 * proves the protocol module needs nothing beyond the enclave global allow-list. Vectors are
 * bundled JSON, not file reads (Hermes has no fs).
 */
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import cert from "../../../../vectors/card/cert.json" with { type: "json" };
import oracle from "../../../../vectors/card/oracle.json" with { type: "json" };
import sessionVectors from "../../../../vectors/card/session.json" with { type: "json" };
import {
  accessHash,
  CardError,
  cardId,
  cmd,
  decode,
  edwardsEncode,
  openRequest,
  openResponse,
  result,
  shortId,
  verifyCertificate,
} from "../../src/modules/card/protocol/index.ts";
import type { Anchor, Argon2id, Inner, Session } from "../../src/modules/card/protocol/index.ts";

declare function print(msg: string): void;
declare function quit(code: number): void;

const hex = hexToBytes;
let checks = 0;

const check = (ok: boolean, label: string): void => {
  checks += 1;
  if (!ok) {
    throw new Error(`check failed: ${label}`);
  }
};

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof CardError ? error.code : `foreign:${String(error)}`;
  }
  return "no-throw";
};

const req = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) {
    throw new Error(`missing: ${label}`);
  }
  return value;
};

/** `INS ‖ P1 ‖ P2 ‖ data` — the inner plaintext a session wraps. */
const plain = (inner: Inner): Uint8Array =>
  concatBytes(new Uint8Array([inner.ins, inner.p1, inner.p2]), inner.data);

function certificates(): void {
  for (const identity of cert.identities) {
    check(bytesToHex(cardId(hex(identity.compressed))) === identity.id, `cardId ${identity.name}`);
    check(shortId(hex(identity.compressed)) === identity.short, `shortId ${identity.name}`);
  }
  for (const v of cert.verify) {
    const anchor: Anchor = { batch: "test", key: hex(v.anchor) };
    if (v.valid) {
      const { identity } = verifyCertificate(hex(v.cert), [anchor]);
      check(bytesToHex(identity) === v.cert.slice(0, 66), `verifyCertificate identity ${v.name}`);
    } else {
      check(
        code(() => verifyCertificate(hex(v.cert), [anchor])) === "card-not-genuine",
        `verifyCertificate ${v.name}`,
      );
    }
  }
}

function open(secretHex: string, requestHex: string, responseHex: string, anchor: Anchor): Session {
  return openResponse(hex(secretHex), hex(requestHex), hex(responseHex), [anchor], []);
}

function opens(): void {
  const anchor: Anchor = { batch: "ca1", key: hex(sessionVectors.ca) };
  const { apdu } = openRequest(() => hex(sessionVectors.hostPrivate));
  check(bytesToHex(apdu) === sessionVectors.request, "session.json openRequest");
  open(sessionVectors.hostPrivate, sessionVectors.request, sessionVectors.response, anchor);
  for (const v of sessionVectors.rejected) {
    check(
      code(() => open(sessionVectors.hostPrivate, sessionVectors.request, v.response, anchor)) ===
        "card-not-genuine",
      `session.json rejected ${v.name}`,
    );
  }

  const oracleAnchor: Anchor = { batch: "ca1", key: hex(oracle.open.anchor) };
  const request = openRequest(() => hex(oracle.open.hostPrivate));
  check(bytesToHex(request.apdu) === oracle.open.request, "oracle openRequest");
  const session = open(
    oracle.open.hostPrivate,
    oracle.open.request,
    oracle.open.response,
    oracleAnchor,
  );
  check(bytesToHex(session.cardId) === oracle.open.cardId, "oracle cardId");
  check(bytesToHex(session.ephemeralTag) === oracle.open.ephemeralTag, "oracle ephemeralTag");
  open(oracle.open.hostPrivate, oracle.open.request, oracle.open.responseHighS, oracleAnchor);
  for (const v of oracle.open.rejected) {
    check(
      code(() => open(oracle.open.hostPrivate, oracle.open.request, v.response, oracleAnchor)) ===
        "card-not-genuine",
      `oracle open rejected ${v.name}`,
    );
  }
}

function transcript(): void {
  const anchor: Anchor = { batch: "ca1", key: hex(oracle.open.anchor) };
  const session = open(oracle.open.hostPrivate, oracle.open.request, oracle.open.response, anchor);
  const t = oracle.transcript;
  const stream0 = hex(req(find("ed25519-update-0"), "update-0").plain).subarray(3);
  const stream = cmd.ed25519Stream(
    stream0.subarray(0, 32),
    stream0.subarray(32, 64),
    hex(t.ed25519.message),
  );
  const inners = new Map<string, Inner>([
    ["status", cmd.status()],
    ["fault", cmd.status()],
    ["verify-wrong", cmd.verify(hex(t.inputs.wrongAccessHash))],
    ["wait", cmd.wait()],
    ["verify", cmd.verify(hex(t.inputs.accessHash))],
    ["public-key-secp256k1", cmd.publicKey("secp256k1", t.inputs.ecdsaPath)],
    ["sign-ecdsa", cmd.signEcdsa(hex(t.ecdsa.digest), t.inputs.ecdsaPath)],
    ["public-key-taproot", cmd.publicKey("secp256k1", t.inputs.taprootPath)],
    [
      "sign-bip340",
      cmd.signBip340(hex(t.bip340.message), hex(t.bip340.tweak), t.inputs.taprootPath),
    ],
    ["public-key-ed25519", cmd.publicKey("ed25519", t.inputs.ed25519Path)],
    ["ed25519-begin", cmd.ed25519Begin(t.inputs.ed25519Path)],
    ["ed25519-update-0", req(stream[0], "stream[0]")],
    ["ed25519-update-1", req(stream[1], "stream[1]")],
    ["ed25519-finish", req(stream[2], "stream[2]")],
    ["change", cmd.change(hex(t.inputs.newAccessHash))],
  ]);

  let ecdsaKey: Uint8Array = new Uint8Array(0);
  let taprootKey: Uint8Array = new Uint8Array(0);
  let encodedA: Uint8Array = new Uint8Array(0);
  let encodedR: Uint8Array = new Uint8Array(0);

  for (const entry of t.exchanges) {
    const inner = req(inners.get(entry.name), `inner ${entry.name}`);
    check(bytesToHex(plain(inner)) === entry.plain, `plain ${entry.name}`);
    check(bytesToHex(session.wrap(inner)) === entry.apdu, `wrap ${entry.name}`);
    const response = session.unwrap(hex(entry.rapdu));
    check(response.sw === Number.parseInt(entry.sw, 16), `sw ${entry.name}`);
    check(bytesToHex(response.data) === entry.data, `data ${entry.name}`);

    if (entry.name === "status") {
      const status = decode.status(result(inner, response));
      check(status.life === "loaded" && status.tries === 10, "decode.status");
    } else if (entry.name === "verify-wrong") {
      check(code(() => result(inner, response)) === "wrong-access-code", "result verify-wrong");
    } else if (entry.name === "wait" || entry.name === "change") {
      decode.empty(result(inner, response));
    } else if (entry.name === "verify") {
      const info = decode.walletInfo(result(inner, response), session.cardId);
      check(
        bytesToHex(info.masterPublicKey) === t.walletInfo.masterPublicKey &&
          info.origin === t.walletInfo.origin &&
          info.members.map(bytesToHex).join(",") === t.walletInfo.members.join(","),
        "decode.walletInfo",
      );
    } else if (entry.name === "public-key-secp256k1") {
      ecdsaKey = decode.publicKey(result(inner, response)).publicKey;
      check(bytesToHex(ecdsaKey) === t.ecdsa.publicKey, "decode.publicKey secp256k1");
    } else if (entry.name === "sign-ecdsa") {
      const signed = decode.ecdsa(result(inner, response), hex(t.ecdsa.digest), ecdsaKey, []);
      check(bytesToHex(signed.signature) === t.ecdsa.signature, "decode.ecdsa");
    } else if (entry.name === "public-key-taproot") {
      taprootKey = decode.publicKey(result(inner, response)).publicKey;
    } else if (entry.name === "sign-bip340") {
      const signature = decode.bip340(
        result(inner, response),
        hex(t.bip340.message),
        taprootKey,
        hex(t.bip340.tweak),
      );
      check(bytesToHex(signature) === t.bip340.signature, "decode.bip340");
    } else if (entry.name === "public-key-ed25519") {
      encodedA = decode.weiPoint(result(inner, response));
    } else if (entry.name === "ed25519-begin") {
      encodedR = decode.weiPoint(result(inner, response));
    } else if (entry.name === "ed25519-update-0" || entry.name === "ed25519-update-1") {
      decode.empty(result(inner, response));
    } else if (entry.name === "ed25519-finish") {
      const signature = decode.ed25519(
        result(inner, response),
        encodedR,
        encodedA,
        hex(t.ed25519.message),
      );
      check(bytesToHex(signature) === t.ed25519.signature, "decode.ed25519");
    } else {
      // "fault": the inner 6F00 response tears the session down before unwrap returns normally.
      check(code(() => result(inner, response)) === "card-fault", "result fault");
    }
  }
  check(session.closed, "session torn down after 6F00");
}

const find = (name: string) => oracle.transcript.exchanges.find((entry) => entry.name === name);

function wei25519(): void {
  for (const v of oracle.wei25519.accepted) {
    check(bytesToHex(edwardsEncode(hex(v.wei))) === v.encoded, `wei25519 accepted ${v.name}`);
  }
  for (const v of oracle.wei25519.rejected) {
    check(code(() => edwardsEncode(hex(v.wei))) === "card-fault", `wei25519 rejected ${v.name}`);
  }
}

function transfer(): void {
  const targetId = hex(oracle.transfer.target.identity);
  const sourceId = hex(oracle.transfer.source.identity);
  const offer = decode.offer(hex(oracle.transfer.offer), targetId);
  decode.offer(hex(oracle.transfer.offerHighS), targetId);
  for (const v of oracle.transfer.rejectedOffers) {
    check(
      code(() => decode.offer(hex(v.offer), targetId)) === "card-fault",
      `rejectedOffer ${v.name}`,
    );
  }
  const head = decode.exportHead(hex(oracle.transfer.head), {
    source: sourceId,
    target: targetId,
    linkKey: offer.linkKey,
  });
  check(head.ephemeral.length === 65, "exportHead ephemeral");
  for (const v of oracle.transfer.rejectedHeads) {
    check(
      code(() =>
        decode.exportHead(hex(v.head), {
          source: sourceId,
          target: targetId,
          linkKey: offer.linkKey,
        }),
      ) === "card-fault",
      `rejectedHead ${v.name}`,
    );
  }
  decode.exportPayload(hex(oracle.transfer.payload));
}

async function access(): Promise<void> {
  const card = hex(oracle.open.cardId);
  const expectedSalt = concatBytes(utf8ToBytes("qntx-card/v1/access"), card);
  const mark = new Uint8Array(32).fill(0x42);
  let captured: Uint8Array | undefined;
  const fake: Argon2id = (password, salt, cost, length) => {
    check(bytesToHex(salt) === bytesToHex(expectedSalt), "argon2id salt");
    check(cost.memoryKiB === 65_536 && cost.passes === 3 && cost.lanes === 4, "argon2id cost");
    check(length === 32, "argon2id length");
    captured = password;
    return Promise.resolve(mark);
  };
  const hash = await accessHash("hunter2!", card, fake);
  check(hash === mark, "accessHash returns the derived bytes");
  check(
    captured !== undefined && captured.every((byte) => byte === 0),
    "password buffer wiped after argon2id resolves",
  );
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- top-level await cannot appear in the iife classic-script bundle Hermes runs
void (async (): Promise<void> => {
  try {
    certificates();
    opens();
    transcript();
    wei25519();
    transfer();
    await access();
    print(`HERMES_CARD_OK (${checks} checks)`);
  } catch (error) {
    print(
      `HERMES_CARD_FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    quit(1);
  }
})();
