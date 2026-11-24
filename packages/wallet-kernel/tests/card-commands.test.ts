import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import { cmd } from "../src/modules/card/protocol/commands.ts";
import type { CommandName, CreateParams, Inner } from "../src/modules/card/protocol/commands.ts";
import { decode } from "../src/modules/card/protocol/decode.ts";
import { CardError } from "../src/modules/card/protocol/errors.ts";
import type { CardErrorCode } from "../src/modules/card/protocol/errors.ts";
import type { Anchor } from "../src/modules/card/protocol/identity.ts";
import { openRequest, openResponse } from "../src/modules/card/protocol/session.ts";
import type { InnerResponse } from "../src/modules/card/protocol/session.ts";
import { ACCESS_LIMITS, result, waitsBeforeVerify } from "../src/modules/card/protocol/status.ts";
import { loadVectors } from "./helpers.ts";

const hex = hexToBytes;

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

const cardError = (fn: () => unknown): CardErrorCode | undefined => capture(fn)?.code;

function requireCase<T>(value: T | null | undefined): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error("test vector missing");
  }
  return value;
}

/** `INS ‖ P1 ‖ P2 ‖ data` — the inner plaintext a session wraps. */
const plain = (i: Inner): Uint8Array => concatBytes(new Uint8Array([i.ins, i.p1, i.p2]), i.data);

const NAMES: ReadonlyArray<CommandName> = [
  "status",
  "create",
  "verify",
  "change",
  "erase",
  "wait",
  "public-key",
  "sign-ecdsa",
  "sign-bip340",
  "ed25519-begin",
  "ed25519-update",
  "ed25519-finish",
  "offer",
  "export-head",
  "export-payload",
  "import-head",
  "import-payload",
];

const innerOf = (name: CommandName): Inner => ({
  name,
  ins: 0x00,
  p1: 0x00,
  p2: 0x00,
  data: new Uint8Array(0),
});

const respond = (data: Uint8Array, sw: number): InnerResponse => ({ data, sw });
const NO_DATA = new Uint8Array(0);
const SOME_DATA = hex("aa");
const h32 = hex("11".repeat(32));

describe("result() status-word matrix", () => {
  const SW_SET = [
    0x9000,
    0x6283,
    ...Array.from({ length: 11 }, (_, i) => 0x63c0 + i),
    0x6700,
    0x6982,
    0x6983,
    0x6985,
    0x6986,
    0x6a80,
    0x6a86,
    0x6d00,
    0x6f00,
    0x9001,
    0x0000,
  ];

  // the design's allow-list with the approved B1 amendment (VERIFY's wait gate is 6986),
  // transcribed; 63C1–63C9 is a range, listed separately
  const ALLOWED: Readonly<Record<CommandName, ReadonlyArray<number>>> = {
    status: [],
    create: [0x6985, 0x6a80],
    verify: [0x6983, 0x6985, 0x6986],
    change: [0x6985, 0x6982],
    erase: [0x6985, 0x6982],
    wait: [0x6985],
    "public-key": [0x6985, 0x6982, 0x6a80],
    "sign-ecdsa": [0x6985, 0x6982, 0x6a80],
    "sign-bip340": [0x6985, 0x6982, 0x6a80],
    "ed25519-begin": [0x6985, 0x6982, 0x6a80],
    "ed25519-update": [0x6985, 0x6982],
    "ed25519-finish": [0x6985, 0x6982],
    offer: [],
    "export-head": [0x6985, 0x6982, 0x6a80],
    "export-payload": [0x6985, 0x6982],
    "import-head": [0x6985, 0x6a80],
    "import-payload": [0x6985, 0x6a80],
  };

  const expected = (
    name: CommandName,
    sw: number,
  ): { code: "data" | CardErrorCode; remaining: number | undefined } => {
    if (sw === 0x9000) {
      return { code: "data", remaining: undefined };
    }
    if (sw === 0x6f00) {
      return { code: "card-fault", remaining: undefined };
    }
    if (sw === 0x6283) {
      return { code: "card-not-genuine", remaining: undefined };
    }
    if (name === "verify" && sw >= 0x63c1 && sw <= 0x63c9) {
      return { code: "wrong-access-code", remaining: sw - 0x63c0 };
    }
    if (!ALLOWED[name].includes(sw)) {
      return { code: "card-fault", remaining: undefined };
    }
    if (sw === 0x6983) {
      return { code: "wallet-erased", remaining: undefined };
    }
    if (sw === 0x6986) {
      return { code: "wait-required", remaining: undefined };
    }
    if (sw === 0x6985) {
      return { code: "wrong-state", remaining: undefined };
    }
    if (sw === 0x6982) {
      return { code: "not-verified", remaining: undefined };
    }
    return { code: "invalid-data", remaining: undefined };
  };

  const matrix = NAMES.flatMap((name) =>
    SW_SET.map((sw) => ({ name, sw, outcome: expected(name, sw) })),
  );

  it.each(matrix.filter((entry) => entry.outcome.code === "data"))(
    "command=$name sw=$sw returns its data",
    ({ name, sw }) => {
      expect(result(innerOf(name), respond(SOME_DATA, sw))).toBe(SOME_DATA);
    },
  );

  it.each(matrix.filter((entry) => entry.outcome.code !== "data"))(
    "command=$name sw=$sw is $outcome.code",
    ({ name, sw, outcome }) => {
      const error = capture(() => result(innerOf(name), respond(NO_DATA, sw)));
      expect(error?.code).toBe(outcome.code);
      expect(error?.sw).toBe(sw);
      expect(error?.remaining).toBe(outcome.remaining);
    },
  );

  it.each(NAMES)("command=%s failing with data is card-fault", (name) => {
    expect(cardError(() => result(innerOf(name), respond(SOME_DATA, 0x6982)))).toBe("card-fault");
  });

  it.each(NAMES)("command=%s failing 6283 with data is card-fault", (name) => {
    expect(cardError(() => result(innerOf(name), respond(SOME_DATA, 0x6283)))).toBe("card-fault");
  });

  it("tells VERIFY's wait gate (6986) from a wrong card state (6985)", () => {
    expect(cardError(() => result(innerOf("verify"), respond(NO_DATA, 0x6986)))).toBe(
      "wait-required",
    );
    expect(cardError(() => result(innerOf("verify"), respond(NO_DATA, 0x6985)))).toBe(
      "wrong-state",
    );
    for (const name of NAMES.filter((other) => other !== "verify")) {
      expect(cardError(() => result(innerOf(name), respond(NO_DATA, 0x6986)))).toBe("card-fault");
    }
  });

  it("maps 6F00 to card-fault with its own message", () => {
    const error = capture(() => result(innerOf("status"), respond(NO_DATA, 0x6f00)));
    expect(error?.code).toBe("card-fault");
    expect(error?.message).toBe("card reported an internal fault");
  });
});

describe("waitsBeforeVerify", () => {
  it.each([
    ["blank", { life: "blank", tries: 0 } as const],
    ["loaded at zero tries", { life: "loaded", tries: 0 } as const],
  ])("%s is wrong-state", (_name, status) => {
    expect(cardError(() => waitsBeforeVerify(status))).toBe("wrong-state");
  });

  it.each([
    [10, 0],
    [8, 0],
    [7, 15],
    [1, 15],
  ])("tries=%d needs %d waits", (tries, waits) => {
    expect(waitsBeforeVerify({ life: "loaded", tries })).toBe(waits);
    expect(ACCESS_LIMITS).toStrictEqual({ failures: 10, free: 3, waits: 15 });
  });
});

describe("cmd encodings", () => {
  it.each([
    ["status", cmd.status(), "200000"],
    ["erase", cmd.erase(), "240000"],
    ["wait", cmd.wait(), "250000"],
    ["offer", cmd.offer(), "400000"],
    ["verify", cmd.verify(h32), `220000${"11".repeat(32)}`],
    ["change", cmd.change(h32), `230000${"11".repeat(32)}`],
  ])("%s inner plaintext", (_label, inner, expected) => {
    expect(bytesToHex(plain(inner))).toBe(expected);
  });

  it("encodes create(generate) as accessHash ‖ entropy ‖ others", () => {
    const inner = cmd.create({
      mode: "generate",
      accessHash: h32,
      entropy: hex("22".repeat(32)),
      others: [hex("aa".repeat(16)), hex("bb".repeat(16))],
    });
    expect(bytesToHex(plain(inner))).toBe(
      `210000${"11".repeat(32)}${"22".repeat(32)}${"aa".repeat(16)}${"bb".repeat(16)}`,
    );
  });

  it("encodes create(import) as accessHash ‖ seed ‖ others", () => {
    const inner = cmd.create({
      mode: "import",
      accessHash: h32,
      seed: hex("33".repeat(64)),
      others: [hex("aa".repeat(16))],
    });
    expect(bytesToHex(plain(inner))).toBe(
      `210100${"11".repeat(32)}${"33".repeat(64)}${"aa".repeat(16)}`,
    );
  });

  it("encodes publicKey paths and the curve selector", () => {
    const path = [0x8000002c, 0x8000003c, 0x80000000, 0, 0];
    expect(bytesToHex(plain(cmd.publicKey("secp256k1", path)))).toBe(
      "300000058000002c8000003c800000000000000000000000",
    );
    expect(bytesToHex(plain(cmd.publicKey("ed25519", [0x8000002c])))).toBe("300100018000002c");
  });

  it("encodes sign commands with digest/tweak before the path", () => {
    const path = [0x8000002c];
    expect(bytesToHex(plain(cmd.signEcdsa(h32, path)))).toBe(`310000${"11".repeat(32)}018000002c`);
    expect(bytesToHex(plain(cmd.signBip340(h32, h32, path)))).toBe(
      `320000${"11".repeat(64)}018000002c`,
    );
    expect(bytesToHex(plain(cmd.ed25519Begin([0x8000002c])))).toBe("330000018000002c");
  });

  it("encodes transfer heads and payloads", () => {
    const cert = hex("cc".repeat(97));
    const p65 = hex("dd".repeat(65));
    const sig = hex("ee".repeat(64));
    expect(bytesToHex(plain(cmd.export0(cert, { linkKey: p65, signature: sig })))).toBe(
      `410000${"cc".repeat(97)}${"dd".repeat(65)}${"ee".repeat(64)}`,
    );
    expect(bytesToHex(plain(cmd.export1(h32)))).toBe(`410100${"11".repeat(32)}`);
    expect(bytesToHex(plain(cmd.import0(cert, { ephemeral: p65, signature: sig })))).toBe(
      `420000${"cc".repeat(97)}${"dd".repeat(65)}${"ee".repeat(64)}`,
    );
    const payload = new Uint8Array(160);
    expect(bytesToHex(plain(cmd.import1(payload)))).toBe(`420100${"00".repeat(160)}`);
  });
});

describe("cmd invalid-input guards", () => {
  const h32 = hex("11".repeat(32));
  const path = [0x8000002c];

  it.each([
    ["empty path", () => cmd.publicKey("secp256k1", [])],
    [
      "depth 11",
      () =>
        cmd.publicKey(
          "secp256k1",
          Array.from({ length: 11 }, () => 0),
        ),
    ],
    ["negative index", () => cmd.publicKey("secp256k1", [-1])],
    ["index at 2^32", () => cmd.publicKey("secp256k1", [0x100000000])],
    ["fractional index", () => cmd.publicKey("secp256k1", [0.5])],
    ["ed25519 non-hardened", () => cmd.publicKey("ed25519", [0x8000002c, 0])],
    ["ed25519Begin non-hardened", () => cmd.ed25519Begin([...path, 0])],
    ["short accessHash", () => cmd.verify(new Uint8Array(31))],
    ["short change hash", () => cmd.change(new Uint8Array(31))],
    [
      "short entropy",
      () =>
        cmd.create({ mode: "generate", accessHash: h32, entropy: new Uint8Array(31), others: [] }),
    ],
    [
      "short seed",
      () => cmd.create({ mode: "import", accessHash: h32, seed: new Uint8Array(63), others: [] }),
    ],
    [
      "three others",
      () =>
        cmd.create({
          mode: "generate",
          accessHash: h32,
          entropy: h32,
          others: [hex("aa".repeat(16)), hex("bb".repeat(16)), hex("cc".repeat(16))],
        }),
    ],
    [
      "short member id",
      () =>
        cmd.create({
          mode: "generate",
          accessHash: h32,
          entropy: h32,
          others: [new Uint8Array(15)],
        }),
    ],
    [
      "duplicate members",
      () =>
        cmd.create({
          mode: "generate",
          accessHash: h32,
          entropy: h32,
          others: [hex("aa".repeat(16)), hex("aa".repeat(16))],
        }),
    ],
    ["short digest", () => cmd.signEcdsa(new Uint8Array(31), path)],
    ["short message", () => cmd.signBip340(new Uint8Array(31), h32, path)],
    ["short tweak", () => cmd.signBip340(h32, new Uint8Array(31), path)],
    [
      "tweak at n",
      () =>
        cmd.signBip340(
          h32,
          hex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
          path,
        ),
    ],
    ["tweak over n", () => cmd.signBip340(h32, hex("ff".repeat(32)), path)],
    ["short encodedR", () => cmd.ed25519Stream(new Uint8Array(31), h32, new Uint8Array(0))],
    ["short stream key", () => cmd.ed25519Stream(h32, new Uint8Array(31), new Uint8Array(0))],
    [
      "short certT",
      () =>
        cmd.export0(new Uint8Array(96), {
          linkKey: new Uint8Array(65),
          signature: new Uint8Array(64),
        }),
    ],
    [
      "short offer key",
      () =>
        cmd.export0(hex("cc".repeat(97)), {
          linkKey: new Uint8Array(64),
          signature: new Uint8Array(64),
        }),
    ],
    [
      "short offer sig",
      () =>
        cmd.export0(hex("cc".repeat(97)), {
          linkKey: new Uint8Array(65),
          signature: new Uint8Array(63),
        }),
    ],
    ["short accessHashT", () => cmd.export1(new Uint8Array(31))],
    [
      "short certS",
      () =>
        cmd.import0(new Uint8Array(96), {
          ephemeral: new Uint8Array(65),
          signature: new Uint8Array(64),
        }),
    ],
    [
      "short head E",
      () =>
        cmd.import0(hex("cc".repeat(97)), {
          ephemeral: new Uint8Array(64),
          signature: new Uint8Array(64),
        }),
    ],
    [
      "short head sig",
      () =>
        cmd.import0(hex("cc".repeat(97)), {
          ephemeral: new Uint8Array(65),
          signature: new Uint8Array(63),
        }),
    ],
    ["payload 159", () => cmd.import1(new Uint8Array(159))],
    ["payload 177", () => cmd.import1(new Uint8Array(177))],
  ])("rejects %s", (_label, build) => {
    expect(cardError(build)).toBe("invalid-input");
  });

  it.each([160, 176])("accepts a %d-byte import payload", (len) => {
    expect(cmd.import1(new Uint8Array(len)).data).toHaveLength(len);
  });
});

type Oracle = {
  open: {
    anchor: string;
    hostPrivate: string;
    request: string;
    response: string;
    ephemeralTag: string;
    cardId: string;
  };
  transcript: {
    inputs: {
      wrongAccessHash: string;
      accessHash: string;
      newAccessHash: string;
      ecdsaPath: number[];
      taprootPath: number[];
      ed25519Path: number[];
    };
    exchanges: ReadonlyArray<{
      name: string;
      ctr: number;
      plain: string;
      apdu: string;
      data: string;
      sw: string;
      rapdu: string;
    }>;
    ecdsa: { publicKey: string; digest: string; signature: string };
    bip340: { internalKey: string; tweak: string; message: string; signature: string };
    ed25519: { publicKey: string; message: string; signature: string };
    walletInfo: { masterPublicKey: string; origin: string; members: string[] };
  };
};

const { open, transcript } = loadVectors("card/oracle.json") as Oracle;
const apdu = loadVectors("card/apdu.json") as {
  commands: ReadonlyArray<{
    name: string;
    cases: ReadonlyArray<{ name: string; inner: boolean; apdu: string; sw: string }>;
  }>;
};
const sessionVec = loadVectors("card/session.json") as { hostEph: string; hostPrivate: string };

describe("apdu.json plaintexts", () => {
  const group = (name: string) =>
    requireCase(apdu.commands.find((command) => command.name === name));

  it("emits the STATUS success plaintext", () => {
    const v = requireCase(group("STATUS").cases.find((c) => c.name === "success-loaded"));
    expect(bytesToHex(plain(cmd.status()))).toBe(v.apdu);
  });

  it("emits the OPEN request the file describes", () => {
    const v = requireCase(group("OPEN").cases.find((c) => c.name === "success"));
    const resolved = v.apdu.replace("{hostEph}", sessionVec.hostEph);
    expect(resolved).toBe(bytesToHex(openRequest(() => hex(sessionVec.hostPrivate)).apdu));
  });
});

describe("oracle transcript", () => {
  const anchor: Anchor = { batch: "ca1", key: hex(open.anchor) };
  const exchange = (name: string) => requireCase(transcript.exchanges.find((e) => e.name === name));

  /** Stream inputs are the first two fields of the first update chunk. */
  const streamInners = (): ReadonlyArray<Inner> => {
    const stream0 = hex(exchange("ed25519-update-0").plain).subarray(3);
    return cmd.ed25519Stream(
      stream0.subarray(0, 32),
      stream0.subarray(32, 64),
      hex(transcript.ed25519.message),
    );
  };

  const innerByName = (stream: ReadonlyArray<Inner>): ReadonlyMap<string, Inner> =>
    new Map<string, Inner>([
      ["status", cmd.status()],
      ["fault", cmd.status()],
      ["verify-wrong", cmd.verify(hex(transcript.inputs.wrongAccessHash))],
      ["wait", cmd.wait()],
      ["verify", cmd.verify(hex(transcript.inputs.accessHash))],
      ["public-key-secp256k1", cmd.publicKey("secp256k1", transcript.inputs.ecdsaPath)],
      ["sign-ecdsa", cmd.signEcdsa(hex(transcript.ecdsa.digest), transcript.inputs.ecdsaPath)],
      ["public-key-taproot", cmd.publicKey("secp256k1", transcript.inputs.taprootPath)],
      [
        "sign-bip340",
        cmd.signBip340(
          hex(transcript.bip340.message),
          hex(transcript.bip340.tweak),
          transcript.inputs.taprootPath,
        ),
      ],
      ["public-key-ed25519", cmd.publicKey("ed25519", transcript.inputs.ed25519Path)],
      ["ed25519-begin", cmd.ed25519Begin(transcript.inputs.ed25519Path)],
      ["ed25519-update-0", requireCase(stream[0])],
      ["ed25519-update-1", requireCase(stream[1])],
      ["ed25519-finish", requireCase(stream[2])],
      ["change", cmd.change(hex(transcript.inputs.newAccessHash))],
    ]);

  it("replays every exchange byte-for-byte", () => {
    const { apdu: request } = openRequest(() => hex(open.hostPrivate));
    expect(bytesToHex(request)).toBe(open.request);
    const session = openResponse(hex(open.hostPrivate), request, hex(open.response), [anchor], []);
    const stream = streamInners();
    expect(stream.map((s) => s.name)).toStrictEqual([
      "ed25519-update",
      "ed25519-update",
      "ed25519-finish",
    ]);
    const inners = innerByName(stream);
    for (const entry of transcript.exchanges) {
      const inner = requireCase(inners.get(entry.name));
      expect(bytesToHex(plain(inner))).toBe(entry.plain);
      expect(bytesToHex(session.wrap(inner))).toBe(entry.apdu);
      const response = session.unwrap(hex(entry.rapdu));
      expect(response.sw).toBe(Number.parseInt(entry.sw, 16));
      expect(bytesToHex(response.data)).toBe(entry.data);
    }
    expect(session.closed).toBe(true); // the final 6F00 tore it down
  });

  it("decodes the successful responses and ends on the fault", () => {
    const session = openResponse(
      hex(open.hostPrivate),
      hex(open.request),
      hex(open.response),
      [anchor],
      [],
    );
    const inners = innerByName(streamInners());
    const run = (name: string) => {
      const inner = requireCase(inners.get(name));
      session.wrap(inner);
      return { inner, response: session.unwrap(hex(exchange(name).rapdu)) };
    };

    const status = run("status");
    expect(decode.status(result(status.inner, status.response))).toStrictEqual({
      life: "loaded",
      tries: 10,
    });

    const wrong = run("verify-wrong");
    const error = capture(() => result(wrong.inner, wrong.response));
    expect(error?.code).toBe("wrong-access-code");
    expect(error?.remaining).toBe(9);

    const waited = run("wait");
    decode.empty(result(waited.inner, waited.response));

    const verified = run("verify");
    const info = decode.walletInfo(result(verified.inner, verified.response), session.cardId);
    expect(bytesToHex(info.masterPublicKey)).toBe(transcript.walletInfo.masterPublicKey);
    expect(info.origin).toBe(transcript.walletInfo.origin);
    expect(info.members.map(bytesToHex)).toStrictEqual(transcript.walletInfo.members);

    const secp = run("public-key-secp256k1");
    const ecdsaKey = decode.publicKey(result(secp.inner, secp.response)).publicKey;
    expect(bytesToHex(ecdsaKey)).toBe(transcript.ecdsa.publicKey);

    const signed = run("sign-ecdsa");
    const ecdsaResult = decode.ecdsa(
      result(signed.inner, signed.response),
      hex(transcript.ecdsa.digest),
      ecdsaKey,
      [],
    );
    expect(bytesToHex(ecdsaResult.signature)).toBe(transcript.ecdsa.signature);

    const taproot = run("public-key-taproot");
    const taprootKey = decode.publicKey(result(taproot.inner, taproot.response)).publicKey;
    expect(bytesToHex(taprootKey)).toBe(transcript.bip340.internalKey);

    const schnorred = run("sign-bip340");
    expect(
      bytesToHex(
        decode.bip340(
          result(schnorred.inner, schnorred.response),
          hex(transcript.bip340.message),
          taprootKey,
          hex(transcript.bip340.tweak),
        ),
      ),
    ).toBe(transcript.bip340.signature);

    const edPublic = run("public-key-ed25519");
    const encodedA = decode.weiPoint(result(edPublic.inner, edPublic.response));
    const began = run("ed25519-begin");
    const encodedR = decode.weiPoint(result(began.inner, began.response));

    for (const name of ["ed25519-update-0", "ed25519-update-1"]) {
      const update = run(name);
      decode.empty(result(update.inner, update.response));
    }
    const finish = run("ed25519-finish");
    const edSignature = decode.ed25519(
      result(finish.inner, finish.response),
      encodedR,
      encodedA,
      hex(transcript.ed25519.message),
    );
    expect(bytesToHex(edSignature)).toBe(transcript.ed25519.signature);

    const changed = run("change");
    decode.empty(result(changed.inner, changed.response));

    const faulted = run("fault");
    expect(capture(() => result(faulted.inner, faulted.response))?.code).toBe("card-fault");
    expect(session.closed).toBe(true);
  });
});

describe("decode.walletInfo / decode.created", () => {
  const info = requireCase(transcript.exchanges.find((e) => e.name === "verify"));
  const cardIdBytes = hex(open.cardId);
  const otherId = hex(requireCase(transcript.walletInfo.members[1]));

  it("decodes the transcript WalletInfo", () => {
    const info2 = decode.walletInfo(hex(info.data), cardIdBytes);
    expect(bytesToHex(info2.masterPublicKey)).toBe(transcript.walletInfo.masterPublicKey);
    expect(info2.members.map(bytesToHex)).toStrictEqual(transcript.walletInfo.members);
  });

  it.each([
    ["far too short for a header", hex("00".repeat(3))],
    ["short", hex("00".repeat(50))],
    ["not member-aligned", hex("00".repeat(52))],
    [
      "count too high",
      concatBytes(hex(transcript.walletInfo.masterPublicKey), hex("0104"), new Uint8Array(64)),
    ],
    [
      "count mismatch",
      concatBytes(hex(transcript.walletInfo.masterPublicKey), hex("0102"), cardIdBytes),
    ],
    [
      "bad origin",
      concatBytes(hex(transcript.walletInfo.masterPublicKey), hex("0302"), cardIdBytes, otherId),
    ],
    [
      "bad master point",
      concatBytes(hex("03".concat("ff".repeat(32))), hex("0102"), cardIdBytes, otherId),
    ],
    [
      "duplicate members",
      concatBytes(
        hex(transcript.walletInfo.masterPublicKey),
        hex("0102"),
        cardIdBytes,
        cardIdBytes,
      ),
    ],
  ])("rejects %s", (_name, data) => {
    expect(cardError(() => decode.walletInfo(data, cardIdBytes))).toBe("card-fault");
  });

  it("rejects a WalletInfo that does not list this card", () => {
    const data = concatBytes(
      hex(transcript.walletInfo.masterPublicKey),
      hex("0102"),
      otherId,
      hex("ee".repeat(16)),
    );
    expect(cardError(() => decode.walletInfo(data, cardIdBytes))).toBe("card-fault");
  });

  it("rejects a WalletInfo with four distinct members", () => {
    const data = concatBytes(
      hex(transcript.walletInfo.masterPublicKey),
      hex("0104"),
      cardIdBytes,
      otherId,
      hex("cc".repeat(16)),
      hex("dd".repeat(16)),
    );
    expect(cardError(() => decode.walletInfo(data, cardIdBytes))).toBe("card-fault");
  });

  it("rejects a wrong-length cardId as invalid-input", () => {
    expect(cardError(() => decode.walletInfo(hex(info.data), new Uint8Array(15)))).toBe(
      "invalid-input",
    );
  });

  const master = hex(transcript.walletInfo.masterPublicKey);

  it("decodes CREATE echo for generate", () => {
    const data = concatBytes(master, hex("0102"), cardIdBytes, otherId);
    const params = { mode: "generate", accessHash: h32, entropy: h32, others: [otherId] } as const;
    const decoded = decode.created(data, params, cardIdBytes);
    expect(decoded.origin).toBe("generated");
    expect(decoded.members.map(bytesToHex)).toStrictEqual([
      open.cardId,
      transcript.walletInfo.members[1],
    ]);
  });

  it("decodes CREATE echo for import", () => {
    const seed = hex("33".repeat(64));
    const expectedMaster = HDKey.fromMasterSeed(seed).publicKey;
    const data = concatBytes(requireCase(expectedMaster), hex("0201"), cardIdBytes);
    const params = { mode: "import", accessHash: h32, seed, others: [] } as const;
    const decoded = decode.created(data, params, cardIdBytes);
    expect(decoded.origin).toBe("imported");
    expect(decoded.members).toHaveLength(1);
  });

  it.each([
    ["wrong origin", concatBytes(master, hex("0202"), cardIdBytes, otherId)],
    ["member order swapped", concatBytes(master, hex("0102"), otherId, cardIdBytes)],
    ["extra member", concatBytes(master, hex("0103"), cardIdBytes, otherId, hex("ee".repeat(16)))],
    ["other member value", concatBytes(master, hex("0102"), cardIdBytes, hex("ee".repeat(16)))],
  ])("rejects %s", (_name, data) => {
    const params = { mode: "generate", accessHash: h32, entropy: h32, others: [otherId] } as const;
    expect(cardError(() => decode.created(data, params, cardIdBytes))).toBe("card-fault");
  });

  it("rejects a mismatched import master public key", () => {
    const data = concatBytes(master, hex("0201"), cardIdBytes);
    const params = {
      mode: "import",
      accessHash: h32,
      seed: hex("33".repeat(64)),
      others: [],
    } as const;
    expect(cardError(() => decode.created(data, params, cardIdBytes))).toBe("card-fault");
  });

  it.each<[string, CreateParams]>([
    [
      "short accessHash",
      { mode: "generate", accessHash: new Uint8Array(31), entropy: h32, others: [] },
    ],
    [
      "short entropy",
      { mode: "generate", accessHash: h32, entropy: new Uint8Array(31), others: [] },
    ],
    ["short seed", { mode: "import", accessHash: h32, seed: new Uint8Array(63), others: [] }],
    [
      "bad member id",
      { mode: "generate", accessHash: h32, entropy: h32, others: [new Uint8Array(15)] },
    ],
  ])("rejects invalid params (%s) as invalid-input", (_name, params) => {
    const data = concatBytes(master, hex("0101"), cardIdBytes);
    expect(cardError(() => decode.created(data, params, cardIdBytes))).toBe("invalid-input");
  });
});

describe("decode guards", () => {
  it("decodes a blank status", () => {
    expect(decode.status(hex("0100"))).toStrictEqual({ life: "blank", tries: 0 });
  });

  it.each([
    ["empty", new Uint8Array(0)],
    ["one byte", new Uint8Array(1)],
    ["three bytes", new Uint8Array(3)],
    ["life 03", hex("0300")],
    ["blank with tries", hex("0105")],
    ["loaded tries over L", hex("020b")],
    ["life ff", hex("ff00")],
  ])("status %s is card-fault", (_name, data) => {
    expect(cardError(() => decode.status(data))).toBe("card-fault");
  });

  it.each([
    ["empty", new Uint8Array(0)],
    ["too long", new Uint8Array(66)],
    ["not a point", hex("03".concat("ff".repeat(32), "00".repeat(32)))],
  ])("publicKey %s is card-fault", (_name, data) => {
    expect(cardError(() => decode.publicKey(data))).toBe("card-fault");
  });

  it("empty rejects a non-empty response", () => {
    expect(cardError(() => decode.empty(hex("00")))).toBe("card-fault");
    expect(decode.empty(new Uint8Array(0))).toBeUndefined();
  });

  it.each([159, 161, 175, 177, 0, 240])("exportPayload of %d bytes is card-fault", (len) => {
    expect(cardError(() => decode.exportPayload(new Uint8Array(len)))).toBe("card-fault");
  });
});
