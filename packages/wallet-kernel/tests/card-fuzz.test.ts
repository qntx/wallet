/**
 * Property/fuzz coverage for the card protocol (fast-check; `bun run fuzz` raises the run count via
 * FUZZ_RUNS). Every property's contract is the same: the API returns normally or throws a CardError
 * — never another error type, never a hang — and a mutated-but-once-valid input is never accepted.
 * All branching lives in module helpers: no-conditional-in-test keeps `it` bodies straight-line.
 */
import { cbc, cmac, ecb } from "@noble/ciphers/aes.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { u16 } from "../src/modules/card/protocol/bytes.ts";
import { cmd } from "../src/modules/card/protocol/commands.ts";
import type { CreateParams, Inner } from "../src/modules/card/protocol/commands.ts";
import { decode } from "../src/modules/card/protocol/decode.ts";
import { CardError } from "../src/modules/card/protocol/errors.ts";
import type { CardErrorCode } from "../src/modules/card/protocol/errors.ts";
import type { Anchor } from "../src/modules/card/protocol/identity.ts";
import { m2 } from "../src/modules/card/protocol/kdf.ts";
import { openResponse, sessionFromKeys } from "../src/modules/card/protocol/session.ts";
import type { Session } from "../src/modules/card/protocol/session.ts";
import { result } from "../src/modules/card/protocol/status.ts";
import { edwardsEncode } from "../src/modules/card/protocol/wei25519.ts";
import { loadVectors } from "./helpers.ts";

/** Run count; the weekly job raises it via FUZZ_RUNS. */
const RUNS = Number(process.env["FUZZ_RUNS"] ?? "3000");
const TIMEOUT = 60_000 * Math.max(1, Math.ceil(RUNS / 3000));

const hex = hexToBytes;

type SessionVec = {
  ca: string;
  identity: { compressed: string };
  cert: string;
};
type RecordVec = {
  keys: { kce: string; kcm: string; kre: string; krm: string };
};
type OracleVec = {
  open: {
    anchor: string;
    hostPrivate: string;
    request: string;
    response: string;
    cardId: string;
  };
  transcript: {
    inputs: { accessHash: string; newAccessHash: string };
    ecdsa: { publicKey: string; digest: string };
    bip340: { internalKey: string; tweak: string; message: string };
    ed25519: { publicKey: string; message: string };
  };
  transfer: {
    source: { identity: string };
    target: { identity: string };
    offer: string;
  };
};

const sessionVec = loadVectors("card/session.json") as SessionVec;
const record = loadVectors("card/record.json") as RecordVec;
const oracle = loadVectors("card/oracle.json") as OracleVec;

const recordKeys = (): Uint8Array =>
  concatBytes(
    hex(record.keys.kce),
    hex(record.keys.kcm),
    hex(record.keys.kre),
    hex(record.keys.krm),
  );

const freshSession = (): Session =>
  sessionFromKeys(
    recordKeys(),
    hex(sessionVec.identity.compressed),
    hex(sessionVec.cert),
    "test",
    new Uint8Array(8),
  );

const statusInner = (): Inner => ({
  name: "status",
  ins: 0x20,
  p1: 0,
  p2: 0,
  data: new Uint8Array(0),
});

const recordIv = (key: Uint8Array, direction: number, counter: number): Uint8Array => {
  const block = new Uint8Array(16);
  block[0] = direction;
  block.set(u16(counter), 14);
  return ecb(key, { disablePadding: true }).encrypt(block);
};

/** A correctly MACed §8.4 response record for `counter` under the record.json keys. */
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

/** Runs `fn`: "ok" on a normal return, the CardError code on a CardError, rethrows foreign errors. */
const outcome = (fn: () => unknown): "ok" | CardErrorCode => {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof CardError)) {
      throw error;
    }
    return error.code;
  }
  return "ok";
};

/** A session with `count` pre-wrapped commands (receive counter still 0). */
const wrappedSession = (count: number): Session => {
  const session = freshSession();
  for (let i = 0; i < count; i += 1) {
    session.wrap(statusInner());
  }
  return session;
};

const rejectUnwrap = (rapdu: Uint8Array, sent: number): void => {
  const session = wrappedSession(sent);
  expect(outcome(() => session.unwrap(rapdu))).not.toBe("ok");
  session.close();
};

const randomRecordRejected = (rapdu: Uint8Array): void => {
  rejectUnwrap(rapdu, 1);
};

const mutatedRecordRejected = (ctr: number, n: number, mode: string): void => {
  const keys = recordKeys();
  const valid = responseRecord(keys, ctr, hex("0100"), 0x9000);
  const rapdu =
    mode === "truncate"
      ? valid.subarray(0, Math.max(0, valid.length - n))
      : concatBytes(valid, new Uint8Array(n).fill(0xaa));
  rejectUnwrap(rapdu, ctr + 1);
};

const flippedRecordRejected = (ctr: number, bit: number): void => {
  const keys = recordKeys();
  const rapdu = responseRecord(keys, ctr, hex("aabb"), 0x6a80);
  const byte = bit % rapdu.length;
  rapdu[byte] = (rapdu[byte] ?? 0) ^ (1 << (Math.floor(bit / rapdu.length) % 8));
  rejectUnwrap(rapdu, ctr + 1);
};

const replayAndOrderRejected = (data: Uint8Array): void => {
  const keys = recordKeys();
  const rapdu0 = responseRecord(keys, 0, data, 0x9000);
  const rapdu1 = responseRecord(keys, 1, data, 0x6a80);

  // Replay: a ctr-0 record while the session expects ctr 1.
  const replayed = wrappedSession(2);
  expect(outcome(() => replayed.unwrap(rapdu0))).toBe("ok");
  expect(outcome(() => replayed.unwrap(rapdu0))).not.toBe("ok");
  replayed.close();

  // Out of order: a ctr-1 response while the session expects ctr 0.
  const outOfOrder = wrappedSession(2);
  expect(outcome(() => outOfOrder.unwrap(rapdu1))).not.toBe("ok");
  outOfOrder.close();

  // The same two records in order still unwrap.
  const ordered = wrappedSession(2);
  expect(outcome(() => ordered.unwrap(rapdu0))).toBe("ok");
  expect(outcome(() => ordered.unwrap(rapdu1))).toBe("ok");
  ordered.close();
};

const cardIdBytes = hex(oracle.open.cardId);
const targetId = hex(oracle.transfer.target.identity);
const sourceId = hex(oracle.transfer.source.identity);
const offer = decode.offer(hex(oracle.transfer.offer), targetId);
const createGenerate: CreateParams = {
  mode: "generate",
  accessHash: new Uint8Array(32),
  entropy: new Uint8Array(32),
  others: [],
};
const createImport: CreateParams = {
  mode: "import",
  accessHash: new Uint8Array(32),
  seed: new Uint8Array(64).fill(1),
  others: [],
};
const decoders: ReadonlyArray<readonly [string, (data: Uint8Array) => unknown]> = [
  ["status", (d) => decode.status(d)],
  ["walletInfo", (d) => decode.walletInfo(d, cardIdBytes)],
  ["created-generate", (d) => decode.created(d, createGenerate, cardIdBytes)],
  ["created-import", (d) => decode.created(d, createImport, cardIdBytes)],
  ["publicKey", (d) => decode.publicKey(d)],
  ["weiPoint", (d) => decode.weiPoint(d)],
  ["empty", (d) => decode.empty(d)],
  [
    "ecdsa",
    (d) =>
      decode.ecdsa(
        d,
        hex(oracle.transcript.ecdsa.digest),
        hex(oracle.transcript.ecdsa.publicKey),
        [],
      ),
  ],
  [
    "bip340",
    (d) =>
      decode.bip340(
        d,
        hex(oracle.transcript.bip340.message),
        hex(oracle.transcript.bip340.internalKey),
        hex(oracle.transcript.bip340.tweak),
      ),
  ],
  [
    "ed25519",
    (d) =>
      decode.ed25519(
        d,
        new Uint8Array(32),
        hex(oracle.transfer.source.identity).subarray(0, 32),
        hex(oracle.transcript.ed25519.message),
      ),
  ],
  ["offer", (d) => decode.offer(d, targetId)],
  [
    "exportHead",
    (d) => decode.exportHead(d, { source: sourceId, target: targetId, linkKey: offer.linkKey }),
  ],
  ["exportPayload", (d) => decode.exportPayload(d)],
];

const decoderSafe = (fn: (data: Uint8Array) => unknown, data: Uint8Array): void => {
  expect(() => outcome(() => fn(data))).not.toThrow();
};

const offerTargetSafe = (target: Uint8Array): void => {
  expect(() => outcome(() => decode.offer(hex(oracle.transfer.offer), target))).not.toThrow();
};

const anchor: Anchor = { batch: "ca1", key: hex(oracle.open.anchor) };
const open = (response: Uint8Array): Session =>
  openResponse(hex(oracle.open.hostPrivate), hex(oracle.open.request), response, [anchor], []);

const randomOpenRejected = (response: Uint8Array): void => {
  expect(outcome(() => open(response))).not.toBe("ok");
};

const mutateOpen = (bit: number, mode: string): Uint8Array => {
  const valid = hex(oracle.open.response);
  if (mode === "flip") {
    const copy = new Uint8Array(valid);
    const byte = bit % copy.length;
    copy[byte] = (copy[byte] ?? 0) ^ (1 << (Math.floor(bit / copy.length) % 8));
    return copy;
  }
  if (mode === "truncate") {
    const cut = 1 + (bit % (valid.length - 1));
    return valid.subarray(0, valid.length - cut);
  }
  return concatBytes(valid, new Uint8Array(1 + (bit % 64)));
};

const mutatedOpenRejected = (bit: number, mode: string): void => {
  expect(outcome(() => open(mutateOpen(bit, mode)))).not.toBe("ok");
};

const edwardsLen = (wei: Uint8Array): number => {
  try {
    return edwardsEncode(wei).length;
  } catch (error) {
    if (!(error instanceof CardError)) {
      throw error;
    }
    return -1;
  }
};

const edwardsSafe = (wei: Uint8Array): void => {
  expect([-1, 32]).toContain(edwardsLen(wei));
};

const accessHashBytes = hex(oracle.transcript.inputs.accessHash);
const streamInners = cmd.ed25519Stream(
  new Uint8Array(32),
  new Uint8Array(32),
  hex(oracle.transcript.ed25519.message),
);
const inners: ReadonlyArray<Inner> = [
  cmd.status(),
  cmd.wait(),
  cmd.verify(accessHashBytes),
  cmd.change(hex(oracle.transcript.inputs.newAccessHash)),
  cmd.publicKey("secp256k1", [0x80_00_00_00]),
  cmd.publicKey("ed25519", [0x80_00_00_00]),
  cmd.signEcdsa(new Uint8Array(32), [0x80_00_00_00]),
  cmd.signBip340(new Uint8Array(32), new Uint8Array(32), [0x80_00_00_00]),
  cmd.ed25519Begin([0x80_00_00_00]),
  ...streamInners,
  cmd.create({
    mode: "generate",
    accessHash: accessHashBytes,
    entropy: new Uint8Array(32),
    others: [],
  }),
  cmd.export0(new Uint8Array(97), { linkKey: new Uint8Array(65), signature: new Uint8Array(64) }),
  cmd.export1(new Uint8Array(32)),
  cmd.import0(new Uint8Array(97), {
    ephemeral: new Uint8Array(65),
    signature: new Uint8Array(64),
  }),
  cmd.import1(new Uint8Array(160)),
];

const resultSafe = (index: number, sw: number, data: Uint8Array): void => {
  const inner = inners[index % inners.length];
  expect(() => outcome(() => result(inner ?? statusInner(), { data, sw }))).not.toThrow();
};

const resultDataFault = (index: number, sw: number, data: Uint8Array): void => {
  const inner = inners[index % inners.length];
  expect(outcome(() => result(inner ?? statusInner(), { data, sw }))).toBe("card-fault");
};

describe("unwrap fuzz", () => {
  it("random response records are always rejected with a CardError", { timeout: TIMEOUT }, () => {
    expect.hasAssertions();
    fc.assert(fc.property(fc.uint8Array({ maxLength: 600 }), randomRecordRejected), {
      numRuns: RUNS,
    });
  });

  it("truncated and extended valid records are never accepted", { timeout: TIMEOUT }, () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1 }),
        fc.integer({ min: 1, max: 50 }),
        fc.constantFrom("truncate", "extend"),
        mutatedRecordRejected,
      ),
      { numRuns: RUNS },
    );
  });

  it("single-bit mutations of a valid record are never accepted", { timeout: TIMEOUT }, () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 16_000 }),
        flippedRecordRejected,
      ),
      { numRuns: RUNS },
    );
  });

  it(
    "replayed earlier records and out-of-order responses are never accepted",
    { timeout: TIMEOUT },
    () => {
      expect.hasAssertions();
      fc.assert(fc.property(fc.uint8Array({ maxLength: 200 }), replayAndOrderRejected), {
        numRuns: Math.ceil(RUNS / 4),
      });
    },
  );
});

describe("decoder fuzz", () => {
  it.each(decoders)(
    "decode.%s only throws CardError on random data",
    { timeout: TIMEOUT },
    (_name, fn) => {
      expect.hasAssertions();
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 600 }), (data) => decoderSafe(fn, data)),
        { numRuns: Math.ceil(RUNS / 4) },
      );
    },
  );

  it("decode.offer only throws CardError on random target identities", { timeout: TIMEOUT }, () => {
    expect.hasAssertions();
    fc.assert(fc.property(fc.uint8Array({ maxLength: 70 }), offerTargetSafe), {
      numRuns: Math.ceil(RUNS / 4),
    });
  });
});

describe("openResponse fuzz", () => {
  it("random responses are never accepted", { timeout: TIMEOUT }, () => {
    expect.hasAssertions();
    fc.assert(fc.property(fc.uint8Array({ maxLength: 600 }), randomOpenRejected), {
      numRuns: Math.ceil(RUNS / 4),
    });
  });

  it("mutations of the valid response are never accepted", { timeout: TIMEOUT }, () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 7000 }),
        fc.constantFrom("flip", "truncate", "extend"),
        mutatedOpenRejected,
      ),
      { numRuns: Math.ceil(RUNS / 2) },
    );
  });
});

describe("edwardsEncode fuzz", () => {
  it("random 64-byte Wei25519 inputs only throw CardError", { timeout: TIMEOUT }, () => {
    expect.hasAssertions();
    fc.assert(fc.property(fc.uint8Array({ minLength: 64, maxLength: 64 }), edwardsSafe), {
      numRuns: RUNS,
    });
  });
});

describe("result fuzz", () => {
  it("random sw/data per command only throws CardError", { timeout: TIMEOUT }, () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 0xffff }),
        fc.uint8Array({ maxLength: 300 }),
        resultSafe,
      ),
      { numRuns: RUNS },
    );
  });

  it("a failing sw carrying data is always a card fault", { timeout: TIMEOUT }, () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 0xfffe }).filter((sw) => sw !== 0x9000),
        fc.uint8Array({ minLength: 1, maxLength: 300 }),
        resultDataFault,
      ),
      { numRuns: Math.ceil(RUNS / 2) },
    );
  });
});
