import { cbc, cmac, ecb } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { u16 } from "../src/modules/card/protocol/bytes.ts";
import type { Inner } from "../src/modules/card/protocol/commands.ts";
import { CardError } from "../src/modules/card/protocol/errors.ts";
import type { CardErrorCode } from "../src/modules/card/protocol/errors.ts";
import type { Anchor } from "../src/modules/card/protocol/identity.ts";
import { m2 } from "../src/modules/card/protocol/kdf.ts";
import {
  openRequest,
  openResponse,
  SELECT_APDU,
  sessionFromKeys,
} from "../src/modules/card/protocol/session.ts";
import type { Session } from "../src/modules/card/protocol/session.ts";
import { loadVectors } from "./helpers.ts";

const hex = hexToBytes;

function cardError(fn: () => unknown): CardErrorCode | undefined {
  return capture(fn)?.code;
}

function capture(fn: () => unknown): CardError | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof CardError) {
      return error;
    }
    throw error;
  }
  return undefined;
}

function requireCase<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("test vector missing");
  }
  return value;
}

const allZero = (b: Uint8Array): boolean => [...b].every((x) => x === 0);

const statusInner = (): Inner => ({
  name: "status",
  ins: 0x20,
  p1: 0x00,
  p2: 0x00,
  data: new Uint8Array(0),
});

// Test-side §8.4 record helpers over the oracle keys — independent of session.ts so a
// wrong record formula cannot cancel out between implementation and expectations.
const recordIv = (key: Uint8Array, direction: number, counter: number): Uint8Array => {
  const block = new Uint8Array(16);
  block[0] = direction;
  block.set(u16(counter), 14);
  return ecb(key, { disablePadding: true }).encrypt(block);
};

const commandRecord = (keys: Uint8Array, counter: number, plain: Uint8Array): Uint8Array => {
  const kce = keys.subarray(0, 16);
  const ct = cbc(kce, recordIv(kce, 1, counter), { disablePadding: true }).encrypt(m2(plain));
  const tag = cmac(concatBytes(u16(counter), ct), keys.subarray(16, 32)).subarray(0, 8);
  return concatBytes(
    new Uint8Array([0x80, 0x12, 0, 0, ct.length + 8]),
    ct,
    tag,
    new Uint8Array([0]),
  );
};

const responseRecord = (
  keys: Uint8Array,
  counter: number,
  data: Uint8Array,
  sw: number,
): Uint8Array => {
  const kre = keys.subarray(32, 48);
  const ct = cbc(kre, recordIv(kre, 2, counter), { disablePadding: true }).encrypt(
    m2(concatBytes(data, u16(sw))),
  );
  const tag = cmac(concatBytes(u16(counter), ct), keys.subarray(48, 64)).subarray(0, 8);
  return concatBytes(ct, tag, new Uint8Array([0x90, 0x00]));
};

type SessionVectors = {
  ca: string;
  identity: { private: string; compressed: string };
  cert: string;
  hostPrivate: string;
  hostEph: string;
  cardPrivate: string;
  cardEph: string;
  th: string;
  z: string;
  sig: string;
  kce: string;
  kcm: string;
  kre: string;
  krm: string;
  request: string;
  response: string;
  rejected: ReadonlyArray<{ name: string; response: string }>;
};

type OpenVectors = {
  anchor: string;
  hostPrivate: string;
  request: string;
  response: string;
  responseHighS: string;
  identity: string;
  cardId: string;
  shortId: string;
  ephemeralTag: string;
  keys: { kce: string; kcm: string; kre: string; krm: string };
  rejected: ReadonlyArray<{ name: string; response: string }>;
};

type RecordVectors = {
  keys: { kce: string; kcm: string; kre: string; krm: string };
  commands: ReadonlyArray<{
    name: string;
    ctr: number;
    ins: string;
    p1: string;
    p2: string;
    data: string;
    iv: string;
    apdu: string;
  }>;
  responses: ReadonlyArray<{
    name: string;
    ctr: number;
    data: string;
    sw: string;
    iv: string;
    rapdu: string;
  }>;
  rejectedCommands: ReadonlyArray<{ name: string; ctr: number; apdu: string }>;
  rejectedResponses: ReadonlyArray<{ name: string; ctr: number; rapdu: string }>;
};

const vec = loadVectors("card/session.json") as SessionVectors;
const { open } = loadVectors("card/oracle.json") as { open: OpenVectors };
const record = loadVectors("card/record.json") as RecordVectors;

const anchor: Anchor = { batch: "ca1", key: hex(vec.ca) };
const vecKeys = (): Uint8Array =>
  concatBytes(hex(vec.kce), hex(vec.kcm), hex(vec.kre), hex(vec.krm));
const recordKeys = (): Uint8Array =>
  concatBytes(
    hex(record.keys.kce),
    hex(record.keys.kcm),
    hex(record.keys.kre),
    hex(record.keys.krm),
  );

const freshSession = (keys: Uint8Array): Session =>
  sessionFromKeys(keys, hex(vec.identity.compressed), hex(vec.cert), "test", new Uint8Array(8));

describe("SELECT and OPEN request", () => {
  it("encodes the SELECT APDU", () => {
    expect(bytesToHex(SELECT_APDU)).toBe("00a4040007f0716e7478010100");
  });

  it("builds the OPEN APDU around the drawn secret", () => {
    const { apdu, secret } = openRequest(() => hex(vec.hostPrivate));
    expect(bytesToHex(apdu)).toBe(vec.request);
    expect(bytesToHex(secret)).toBe(vec.hostPrivate);
  });

  it("wipes invalid draws and keeps drawing", () => {
    const drawn = [new Uint8Array(32), hex(vec.hostPrivate)];
    let index = 0;
    const { apdu, secret } = openRequest(() => requireCase(drawn[index++]));
    expect(index).toBe(2);
    expect(allZero(requireCase(drawn[0]))).toBe(true);
    expect(bytesToHex(apdu)).toBe(vec.request);
    expect(bytesToHex(secret)).toBe(vec.hostPrivate);
  });

  it("gives up after 8 invalid draws", () => {
    const n = hex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const drawn = [new Uint8Array(32), n, new Uint8Array(16), hex("ff".repeat(32))];
    let calls = 0;
    const random = () => {
      calls += 1;
      return requireCase(drawn[(calls - 1) % drawn.length]);
    };
    expect(cardError(() => openRequest(random))).toBe("invalid-input");
    expect(calls).toBe(8);
    expect(drawn.every(allZero)).toBe(true);
  });
});

describe("openResponse (session.json)", () => {
  it("verifies the response and derives the vector keys", () => {
    const secret = hex(vec.hostPrivate);
    const session = openResponse(secret, hex(vec.request), hex(vec.response), [anchor], []);
    expect(allZero(secret)).toBe(true); // the host ephemeral is wiped on success
    expect(bytesToHex(session.identity)).toBe(vec.identity.compressed);
    expect(bytesToHex(session.cert)).toBe(vec.cert);
    expect(session.batch).toBe("ca1");
    expect(bytesToHex(session.ephemeralTag)).toBe(
      bytesToHex(sha256(hex(vec.cardEph)).subarray(0, 8)),
    );
    expect(session.closed).toBe(false);
    // the derived keys are the vector keys: the wrapped STATUS equals the record
    // built from kce/kcm directly
    expect(bytesToHex(session.wrap(statusInner()))).toBe(
      bytesToHex(commandRecord(vecKeys(), 0, hex("200000"))),
    );
    session.close();
  });

  it.each(vec.rejected)("rejects $name as card-not-genuine", (v) => {
    const secret = hex(vec.hostPrivate);
    const error = capture(() =>
      openResponse(secret, hex(vec.request), hex(v.response), [anchor], []),
    );
    expect(error?.code).toBe("card-not-genuine");
    expect(allZero(secret)).toBe(true);
  });
});

describe("openResponse (oracle)", () => {
  const openKeys = (): Uint8Array =>
    concatBytes(hex(open.keys.kce), hex(open.keys.kcm), hex(open.keys.kre), hex(open.keys.krm));
  const oracleAnchor: Anchor = { batch: "ca1", key: hex(open.anchor) };

  it.each(["response", "responseHighS"] as const)("accepts %s", (field) => {
    const session = openResponse(
      hex(open.hostPrivate),
      hex(open.request),
      hex(open[field]),
      [oracleAnchor],
      [],
    );
    expect(bytesToHex(session.identity)).toBe(open.identity);
    expect(bytesToHex(session.cardId)).toBe(open.cardId);
    expect(bytesToHex(session.ephemeralTag)).toBe(open.ephemeralTag);
    expect(bytesToHex(session.wrap(statusInner()))).toBe(
      bytesToHex(commandRecord(openKeys(), 0, hex("200000"))),
    );
    session.close();
  });

  it.each(open.rejected)("rejects $name as card-not-genuine", (v) => {
    const error = capture(() =>
      openResponse(hex(open.hostPrivate), hex(open.request), hex(v.response), [oracleAnchor], []),
    );
    expect(error?.code).toBe("card-not-genuine");
  });

  it("rejects a sub-2-byte OPEN response without a status word", () => {
    const error = capture(() =>
      openResponse(hex(open.hostPrivate), hex(open.request), hex("90"), [oracleAnchor], []),
    );
    expect(error?.code).toBe("card-not-genuine");
    expect(error?.sw).toBeUndefined();
  });

  it("passes the outer status word through on a non-9000 OPEN response", () => {
    const v = requireCase(open.rejected.find((r) => r.name === "status-6985"));
    const error = capture(() =>
      openResponse(hex(open.hostPrivate), hex(open.request), hex(v.response), [oracleAnchor], []),
    );
    expect(error?.code).toBe("card-not-genuine");
    expect(error?.sw).toBe(0x6985);
  });

  it("rejects a repeated ephemeralTag as card-fault", () => {
    const error = capture(() =>
      openResponse(
        hex(open.hostPrivate),
        hex(open.request),
        hex(open.response),
        [oracleAnchor],
        [hex(open.ephemeralTag)],
      ),
    );
    expect(error?.code).toBe("card-fault");
  });

  it.each([
    ["invalid secret", hex("ff".repeat(32)), hex(open.request)],
    ["empty secret", new Uint8Array(0), hex(open.request)],
    ["request of another ephemeral", hex(open.hostPrivate), hex(vec.request)],
  ])("rejects %s as invalid-input", (_name, secret, request) => {
    expect(
      cardError(() => openResponse(secret, request, hex(open.response), [oracleAnchor], [])),
    ).toBe("invalid-input");
  });
});

describe("record layer (record.json)", () => {
  /** Wraps `count` dummy commands so the next wrap happens at counter `count`. */
  const wrapTo = (session: Session, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      session.wrap(statusInner());
    }
  };

  /** Delivers `count` valid dummy responses so the next unwrap happens at counter `count`. */
  const unwrapTo = (session: Session, keys: Uint8Array, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      session.unwrap(responseRecord(keys, i, new Uint8Array(0), 0x9000));
    }
  };

  // an empty p2 means the plaintext is shorter than INS‖P1‖P2 — a malformed inner the
  // card rejects; the host never produces it, so the vector only pins the record formula
  const wellFormed = record.commands.filter((c) => c.p2 !== "");
  const malformed = record.commands.filter((c) => c.p2 === "");

  it.each(wellFormed)("$name wraps to the vector APDU", (v) => {
    const session = freshSession(recordKeys());
    wrapTo(session, v.ctr);
    const apdu = session.wrap({
      name: "status",
      ins: Number.parseInt(v.ins, 16),
      p1: Number.parseInt(v.p1, 16),
      p2: Number.parseInt(v.p2, 16),
      data: hex(v.data),
    });
    expect(bytesToHex(apdu)).toBe(v.apdu);
    session.close();
  });

  it.each(malformed)("$name follows the record formula", (v) => {
    const plain = hex(`${v.ins}${v.p1}${v.p2}${v.data}`);
    expect(bytesToHex(commandRecord(recordKeys(), v.ctr, plain))).toBe(v.apdu);
  });

  it.each(record.responses)("$name unwraps to the vector data/sw", (v) => {
    const keys = recordKeys();
    const session = freshSession(keys);
    wrapTo(session, v.ctr + 1);
    unwrapTo(session, keys, v.ctr);
    const { data, sw } = session.unwrap(hex(v.rapdu));
    expect(bytesToHex(data)).toBe(v.data);
    expect(sw).toBe(Number.parseInt(v.sw, 16));
    session.close();
  });

  it.each(record.rejectedCommands)("never produces the card-side reject $name", (v) => {
    const session = freshSession(recordKeys());
    const apdu = session.wrap(statusInner());
    expect(bytesToHex(apdu)).not.toBe(v.apdu);
    session.close();
  });

  it.each(record.rejectedResponses)("$name breaks the session and wipes the keys", (v) => {
    const keys = recordKeys();
    const session = freshSession(keys);
    wrapTo(session, v.ctr + 1);
    unwrapTo(session, keys, v.ctr);
    const error = capture(() => session.unwrap(hex(v.rapdu)));
    expect(error?.code).toBe("session-broken");
    expect(session.closed).toBe(true);
    expect(allZero(keys)).toBe(true);
  });

  it("passes the outer status word through session-broken", () => {
    const keys = recordKeys();
    const session = freshSession(keys);
    session.wrap(statusInner());
    const rapdu = hex(requireCase(record.responses[0]).rapdu);
    rapdu[rapdu.length - 2] = 0x69;
    rapdu[rapdu.length - 1] = 0x85;
    const error = capture(() => session.unwrap(rapdu));
    expect(error?.code).toBe("session-broken");
    expect(error?.sw).toBe(0x6985);
    expect(allZero(keys)).toBe(true);
  });
});

describe("session lifecycle", () => {
  it("rejects wrap and unwrap after close", () => {
    const keys = recordKeys();
    const session = freshSession(keys);
    session.close();
    expect(session.closed).toBe(true);
    expect(allZero(keys)).toBe(true);
    expect(cardError(() => session.wrap(statusInner()))).toBe("session-broken");
    expect(cardError(() => session.unwrap(hex("9000")))).toBe("session-broken");
  });

  it("rejects unwrap without a pending command", () => {
    const session = freshSession(recordKeys());
    expect(cardError(() => session.unwrap(hex("9000")))).toBe("session-broken");
  });

  it.each([
    ["one-byte response", "90"],
    ["status-only response", "9000"],
    ["ciphertext not a multiple of 16", "ff".repeat(27)],
  ])("rejects a malformed %s", (_name, raw) => {
    const keys = recordKeys();
    const session = freshSession(keys);
    session.wrap(statusInner());
    expect(cardError(() => session.unwrap(hex(raw)))).toBe("session-broken");
    expect(session.closed).toBe(true);
    expect(allZero(keys)).toBe(true);
  });

  it("tears down after an inner 6F00 response", () => {
    const keys = recordKeys();
    const session = freshSession(keys);
    session.wrap(statusInner());
    const { data, sw } = session.unwrap(responseRecord(keys, 0, new Uint8Array(0), 0x6f00));
    expect(sw).toBe(0x6f00);
    expect(data).toHaveLength(0);
    expect(session.closed).toBe(true);
    expect(allZero(keys)).toBe(true);
    expect(cardError(() => session.wrap(statusInner()))).toBe("session-broken");
  });

  const badInners: ReadonlyArray<[string, Inner]> = [
    ["negative ins", { name: "status", ins: -1, p1: 0, p2: 0, data: new Uint8Array(0) }],
    ["ins over 0xff", { name: "status", ins: 0x100, p1: 0, p2: 0, data: new Uint8Array(0) }],
    ["fractional p1", { name: "status", ins: 0x20, p1: 0.5, p2: 0, data: new Uint8Array(0) }],
    ["data over 236", { name: "status", ins: 0x20, p1: 0, p2: 0, data: new Uint8Array(237) }],
  ];

  it.each(badInners)("rejects wrap of %s as invalid-input", (_name, inner) => {
    const session = freshSession(recordKeys());
    expect(cardError(() => session.wrap(inner))).toBe("invalid-input");
    expect(session.closed).toBe(false);
    session.close();
  });

  it.each([
    [
      "short keys",
      new Uint8Array(63),
      hex(vec.identity.compressed),
      hex(vec.cert),
      new Uint8Array(8),
    ],
    ["short identity", recordKeys(), new Uint8Array(32), hex(vec.cert), new Uint8Array(8)],
    [
      "short cert",
      recordKeys(),
      hex(vec.identity.compressed),
      new Uint8Array(96),
      new Uint8Array(8),
    ],
    ["short tag", recordKeys(), hex(vec.identity.compressed), hex(vec.cert), new Uint8Array(7)],
  ])("rejects sessionFromKeys with %s", (_name, keys, identity, cert, tag) => {
    expect(cardError(() => sessionFromKeys(keys, identity, cert, "t", tag))).toBe("invalid-input");
  });

  it("tears down after the response that consumes ctr 0xFFFF", { timeout: 120_000 }, () => {
    const keys = recordKeys();
    const session = freshSession(keys);
    for (let i = 0; i <= 0xffff; i += 1) {
      session.wrap(statusInner());
      session.unwrap(responseRecord(keys, i, new Uint8Array(0), 0x9000));
    }
    expect(session.closed).toBe(true);
    expect(allZero(keys)).toBe(true);
    expect(cardError(() => session.wrap(statusInner()))).toBe("session-broken");
  });

  it("rejects the wrap after ctr 0xFFFF", { timeout: 60_000 }, () => {
    const keys = recordKeys();
    const session = freshSession(keys);
    for (let i = 0; i <= 0xffff; i += 1) {
      session.wrap(statusInner());
    }
    const error = capture(() => session.wrap(statusInner()));
    expect(error?.code).toBe("session-broken");
    expect(session.closed).toBe(true);
    expect(allZero(keys)).toBe(true);
  });
});
