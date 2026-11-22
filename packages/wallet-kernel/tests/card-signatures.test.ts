import { equalBytes } from "@noble/ciphers/utils.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { cmd } from "../src/modules/card/protocol/commands.ts";
import type { Inner } from "../src/modules/card/protocol/commands.ts";
import { decode } from "../src/modules/card/protocol/decode.ts";
import { CardError } from "../src/modules/card/protocol/errors.ts";
import type { CardErrorCode } from "../src/modules/card/protocol/errors.ts";
import { taprootTweak } from "../src/modules/card/protocol/signatures.ts";
import { exportMessage, offerMessage } from "../src/modules/card/protocol/transfer.ts";
import { edwardsEncode } from "../src/modules/card/protocol/wei25519.ts";
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

type Wei25519Vectors = {
  accepted: ReadonlyArray<{ name: string; wei: string; encoded: string }>;
  rejected: ReadonlyArray<{ name: string; wei: string }>;
};

type Ed25519Vectors = {
  accepted: ReadonlyArray<{
    name: string;
    publicKey: string;
    weiPublicKey: string;
    message: string;
    weiR: string;
    s: string;
    signature: string;
  }>;
  memberPair: { weiR: [string, string] };
  rejectedOf: string;
  rejected: ReadonlyArray<{ name: string; s: string }>;
};

type EcdsaVectors = {
  accepted: ReadonlyArray<{
    name: string;
    publicKey: string;
    digest: string;
    card: string;
    signature: string;
    recovery: number;
  }>;
  rejected: ReadonlyArray<{ name: string; card: string }>;
};

type Bip340Vectors = {
  accepted: ReadonlyArray<{
    name: string;
    internalKey: string;
    merkleRoot: string | null;
    tweak: string;
    outputKey: string;
    message: string;
    signature: string;
  }>;
  rejected: ReadonlyArray<{ name: string; signature: string }>;
};

type TransferVectors = {
  source: { identity: string; cert: string; cardId: string };
  target: { identity: string; cert: string; cardId: string };
  offer: string;
  offerHighS: string;
  export0: string;
  head: string;
  message: string;
  import0: string;
  export1: string;
  accessHashTarget: string;
  payload: string;
  import1: string;
  rejectedOffers: ReadonlyArray<{ name: string; offer: string }>;
  rejectedHeads: ReadonlyArray<{ name: string; head: string }>;
};

const oracle = loadVectors("card/oracle.json") as {
  wei25519: Wei25519Vectors;
  ed25519: Ed25519Vectors;
  ecdsa: EcdsaVectors;
  bip340: Bip340Vectors;
  transfer: TransferVectors;
};
const { wei25519, ed25519, ecdsa, bip340, transfer } = oracle;

describe("wei25519", () => {
  it.each(wei25519.accepted)("$name encodes", ({ wei, encoded }) => {
    const expected = hex(encoded);
    expect(bytesToHex(edwardsEncode(hex(wei)))).toBe(encoded);
    expect(bytesToHex(decode.weiPoint(hex(wei)))).toBe(encoded);
    expect(decode.weiPoint(hex(wei))).toStrictEqual(expected);
  });

  it.each(wei25519.rejected)("$name is card-fault", ({ wei }) => {
    expect(cardError(() => edwardsEncode(hex(wei)))).toBe("card-fault");
    expect(cardError(() => decode.weiPoint(hex(wei)))).toBe("card-fault");
  });

  it("rejects X = A3−1 (u + 1 = 0 has no edwards image)", () => {
    const wei = hex(
      "2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2450" +
        "20ae19a1b8a086b4e01edd2c7748d14c923d4d7e6d7c61b229e9c5a27eced3d9",
    );
    expect(cardError(() => edwardsEncode(wei))).toBe("card-fault");
  });
});

describe("ed25519", () => {
  it.each(ed25519.accepted)("$name assembles and verifies", (vector) => {
    const encodedR = decode.weiPoint(hex(vector.weiR));
    expect(bytesToHex(decode.weiPoint(hex(vector.weiPublicKey)))).toBe(vector.publicKey);
    const signature = decode.ed25519(
      hex(vector.s),
      encodedR,
      hex(vector.publicKey),
      hex(vector.message),
    );
    expect(bytesToHex(signature)).toBe(vector.signature);
  });

  it("derives different R for member cards sharing a seed", () => {
    const [first, second] = ed25519.memberPair.weiR;
    expect(equalBytes(edwardsEncode(hex(first)), edwardsEncode(hex(second)))).toBe(false);
  });

  it.each(ed25519.rejected)("$name is card-fault", ({ s }) => {
    const context = requireCase(
      ed25519.accepted.find((vector) => vector.name === ed25519.rejectedOf),
    );
    const error = capture(() =>
      decode.ed25519(
        hex(s),
        decode.weiPoint(hex(context.weiR)),
        hex(context.publicKey),
        hex(context.message),
      ),
    );
    expect(error?.code).toBe("card-fault");
  });

  it.each([
    [
      "encodedR length",
      () =>
        decode.ed25519(
          new Uint8Array(32),
          new Uint8Array(31),
          new Uint8Array(32),
          new Uint8Array(0),
        ),
    ],
    [
      "publicKey length",
      () =>
        decode.ed25519(
          new Uint8Array(32),
          new Uint8Array(32),
          new Uint8Array(31),
          new Uint8Array(0),
        ),
    ],
  ])("%s is invalid-input", (_name, run) => {
    expect(cardError(run)).toBe("invalid-input");
  });

  it.each([31, 33])("a %d-byte finish response is card-fault", (len) => {
    expect(
      cardError(() =>
        decode.ed25519(
          new Uint8Array(len),
          new Uint8Array(32),
          new Uint8Array(32),
          new Uint8Array(0),
        ),
      ),
    ).toBe("card-fault");
  });
});

describe("ecdsa", () => {
  it.each(ecdsa.accepted)("$name verifies and normalises", (vector) => {
    const result = decode.ecdsa(hex(vector.card), hex(vector.digest), hex(vector.publicKey), []);
    expect(bytesToHex(result.signature)).toBe(vector.signature);
    expect(result.recovery).toBe(vector.recovery);
  });

  it.each(ecdsa.rejected)("$name is card-fault", ({ card }) => {
    const context = requireCase(ecdsa.accepted[0]);
    expect(
      cardError(() => decode.ecdsa(hex(card), hex(context.digest), hex(context.publicKey), [])),
    ).toBe("card-fault");
  });

  it("rejects a repeated r", () => {
    const vector = requireCase(ecdsa.accepted[0]);
    const r = hex(vector.card).subarray(0, 32);
    expect(
      cardError(() =>
        decode.ecdsa(hex(vector.card), hex(vector.digest), hex(vector.publicKey), [
          new Uint8Array(r),
        ]),
      ),
    ).toBe("card-fault");
    const decoded = decode.ecdsa(hex(vector.card), hex(vector.digest), hex(vector.publicKey), [
      new Uint8Array(32),
    ]);
    expect(bytesToHex(decoded.signature)).toBe(vector.signature);
  });

  it.each([
    [
      "short digest",
      (publicKey: Uint8Array) =>
        decode.ecdsa(new Uint8Array(64), new Uint8Array(31), publicKey, []),
    ],
    [
      "short publicKey",
      () => decode.ecdsa(new Uint8Array(64), new Uint8Array(32), new Uint8Array(32), []),
    ],
    [
      "invalid publicKey",
      () =>
        decode.ecdsa(new Uint8Array(64), new Uint8Array(32), hex("03".concat("ff".repeat(32))), []),
    ],
    [
      "short previousR",
      (publicKey: Uint8Array) =>
        decode.ecdsa(new Uint8Array(64), new Uint8Array(32), publicKey, [new Uint8Array(31)]),
    ],
  ])("%s is invalid-input", (_name, run) => {
    // a VALID public key: a degenerate one would mask the argument guard under test
    const publicKey = hex(requireCase(ecdsa.accepted[0]).publicKey);
    expect(cardError(() => run(publicKey))).toBe("invalid-input");
  });

  it.each([63, 65])("a %d-byte response is card-fault", (len) => {
    const vector = requireCase(ecdsa.accepted[0]);
    expect(
      cardError(() =>
        decode.ecdsa(new Uint8Array(len), hex(vector.digest), hex(vector.publicKey), []),
      ),
    ).toBe("card-fault");
  });
});

describe("bip340", () => {
  it.each(bip340.accepted)("$name verifies under the tweaked key", (vector) => {
    expect(
      bytesToHex(
        decode.bip340(
          hex(vector.signature),
          hex(vector.message),
          hex(vector.internalKey),
          hex(vector.tweak),
        ),
      ),
    ).toBe(vector.signature);
  });

  it.each(bip340.accepted.filter((vector) => vector.merkleRoot !== null))(
    "$name's tweak is the tagged hash",
    (vector) => {
      expect(
        bytesToHex(taprootTweak(hex(vector.internalKey), hex(requireCase(vector.merkleRoot)))),
      ).toBe(vector.tweak);
    },
  );

  it.each(bip340.rejected)("$name is card-fault", ({ signature }) => {
    const context = requireCase(bip340.accepted.find((vector) => vector.name === "bip86-even"));
    expect(
      cardError(() =>
        decode.bip340(
          hex(signature),
          hex(context.message),
          hex(context.internalKey),
          hex(context.tweak),
        ),
      ),
    ).toBe("card-fault");
  });

  const validKey = hex(requireCase(bip340.accepted[0]).internalKey);

  it.each([
    [
      "short message",
      () => decode.bip340(new Uint8Array(64), new Uint8Array(31), validKey, new Uint8Array(32)),
    ],
    [
      "short internalKey",
      () =>
        decode.bip340(
          new Uint8Array(64),
          new Uint8Array(32),
          new Uint8Array(32),
          new Uint8Array(32),
        ),
    ],
    [
      "invalid internalKey",
      () =>
        decode.bip340(
          new Uint8Array(64),
          new Uint8Array(32),
          hex("03".concat("ff".repeat(32))),
          new Uint8Array(32),
        ),
    ],
    [
      "short tweak",
      () => decode.bip340(new Uint8Array(64), new Uint8Array(32), validKey, new Uint8Array(31)),
    ],
    [
      "tweak at n",
      () =>
        decode.bip340(
          new Uint8Array(64),
          new Uint8Array(32),
          validKey,
          hex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
        ),
    ],
    ["merkleRoot length", () => taprootTweak(validKey, new Uint8Array(16))],
    ["taproot internalKey", () => taprootTweak(new Uint8Array(32), new Uint8Array(0))],
  ])("%s is invalid-input", (_name, run) => {
    expect(cardError(run)).toBe("invalid-input");
  });

  it.each([63, 65])("a %d-byte response is card-fault", (len) => {
    const context = requireCase(bip340.accepted[0]);
    expect(
      cardError(() =>
        decode.bip340(
          new Uint8Array(len),
          hex(context.message),
          hex(context.internalKey),
          hex(context.tweak),
        ),
      ),
    ).toBe("card-fault");
  });

  it("rejects when the tweaked output key is the identity", () => {
    // P′ = G (even-y generator) and t = n−1 ⇒ Q = t·G + P′ = O
    const generator = hex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    const nMinusOne = hex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140");
    expect(
      cardError(() => decode.bip340(new Uint8Array(64), new Uint8Array(32), generator, nMinusOne)),
    ).toBe("card-fault");
  });
});

describe("transfer", () => {
  const sourceId = hex(transfer.source.identity);
  const targetId = hex(transfer.target.identity);
  const certS = hex(transfer.source.cert);
  const certT = hex(transfer.target.cert);

  it.each([
    ["offer", transfer.offer],
    ["offerHighS", transfer.offerHighS],
  ])("accepts %s", (_label, raw) => {
    const data = hex(raw);
    const decoded = decode.offer(data, targetId);
    expect(decoded.linkKey).toStrictEqual(new Uint8Array(data.subarray(0, 65)));
    expect(decoded.signature).toStrictEqual(new Uint8Array(data.subarray(65)));
  });

  it.each(transfer.rejectedOffers)("$name is card-fault", ({ offer }) => {
    expect(cardError(() => decode.offer(hex(offer), targetId))).toBe("card-fault");
  });

  it("rejects a malformed target identity as invalid-input", () => {
    expect(cardError(() => decode.offer(hex(transfer.offer), new Uint8Array(32)))).toBe(
      "invalid-input",
    );
  });

  it("binds source, target, link key and ephemeral into the export message", () => {
    const offer = decode.offer(hex(transfer.offer), targetId);
    const head = hex(transfer.head);
    const ephemeral = head.subarray(0, 65);
    expect(bytesToHex(offerMessage(offer.linkKey))).toBe(
      bytesToHex(concatBytes(new TextEncoder().encode("qntx-card/v1/offer"), offer.linkKey)),
    );
    expect(bytesToHex(exportMessage(sourceId, targetId, offer.linkKey, ephemeral))).toBe(
      transfer.message,
    );
  });

  it("accepts the export head", () => {
    const offer = decode.offer(hex(transfer.offer), targetId);
    const data = hex(transfer.head);
    const head = decode.exportHead(data, {
      source: sourceId,
      target: targetId,
      linkKey: offer.linkKey,
    });
    expect(head.ephemeral).toStrictEqual(new Uint8Array(data.subarray(0, 65)));
    expect(head.signature).toStrictEqual(new Uint8Array(data.subarray(65)));
  });

  it.each(transfer.rejectedHeads)("$name is card-fault", ({ head }) => {
    const offer = decode.offer(hex(transfer.offer), targetId);
    expect(
      cardError(() =>
        decode.exportHead(hex(head), {
          source: sourceId,
          target: targetId,
          linkKey: offer.linkKey,
        }),
      ),
    ).toBe("card-fault");
  });

  it("rejects malformed export params as invalid-input", () => {
    const head = hex(transfer.head);
    const linkKey = hex(transfer.offer).subarray(0, 65);
    const cases: ReadonlyArray<() => unknown> = [
      () =>
        decode.exportHead(head, {
          source: new Uint8Array(32),
          target: targetId,
          linkKey, // a VALID link key, so only the identity guard can reject this
        }),
      () =>
        decode.exportHead(head, {
          source: sourceId,
          target: new Uint8Array(32),
          linkKey,
        }),
      () =>
        decode.exportHead(head, {
          source: sourceId,
          target: targetId,
          linkKey: new Uint8Array(64),
        }),
      () =>
        decode.exportHead(head, {
          source: sourceId,
          target: targetId,
          linkKey: hex("03".concat("ff".repeat(32), "00".repeat(32))),
        }),
    ];
    expect(cases.map((run) => cardError(run))).toStrictEqual([
      "invalid-input",
      "invalid-input",
      "invalid-input",
      "invalid-input",
    ]);
  });

  it("encodes the transfer inner plaintexts", () => {
    const offer = decode.offer(hex(transfer.offer), targetId);
    const head = decode.exportHead(hex(transfer.head), {
      source: sourceId,
      target: targetId,
      linkKey: offer.linkKey,
    });
    expect(bytesToHex(plain(cmd.export0(certT, offer)))).toBe(transfer.export0);
    expect(bytesToHex(plain(cmd.export1(hex(transfer.accessHashTarget))))).toBe(transfer.export1);
    expect(bytesToHex(plain(cmd.import0(certS, head)))).toBe(transfer.import0);
    expect(bytesToHex(plain(cmd.import1(hex(transfer.payload))))).toBe(transfer.import1);
  });

  it("accepts the transfer payload and rejects other lengths", () => {
    expect(decode.exportPayload(hex(transfer.payload))).toStrictEqual(hex(transfer.payload));
    expect(decode.exportPayload(new Uint8Array(160))).toStrictEqual(new Uint8Array(160));
  });
});

describe("ed25519Stream chunks", () => {
  const r = hex("aa".repeat(32));
  const a = hex("bb".repeat(32));
  const chunkNames = (messageLength: number) =>
    cmd
      .ed25519Stream(r, a, new Uint8Array(messageLength))
      .map((inner) => `${inner.p1}:${inner.data.length}`);

  it.each([
    ["single finish below a record", 0, ["2:64"]],
    ["single finish at the record boundary", 172, ["2:236"]],
    ["finish spill by one", 173, ["1:236", "2:1"]],
    ["two full chunks", 408, ["1:236", "2:236"]],
    ["two chunks plus spill", 409, ["1:236", "1:236", "2:1"]],
  ])("%s", (_label, messageLength, expected) => {
    expect(chunkNames(messageLength)).toStrictEqual(expected);
  });

  it("never sends an empty finish (B2: finish carries 1–236 bytes)", () => {
    for (let messageLength = 0; messageLength <= 3 * 236; messageLength += 1) {
      const chunks = cmd.ed25519Stream(r, a, new Uint8Array(messageLength));
      const finish = requireCase(chunks.at(-1));
      expect(finish.name).toBe("ed25519-finish");
      expect(finish.data.length).toBeGreaterThanOrEqual(1);
      expect(finish.data.length).toBeLessThanOrEqual(236);
      expect(chunks.slice(0, -1).every((chunk) => chunk.name === "ed25519-update")).toBe(true);
      expect(chunks.every((chunk) => chunk.data.length > 0)).toBe(true);
    }
  });

  it("chunks the 4032-byte oracle message into 17 updates and a finish", () => {
    const message = requireCase(
      ed25519.accepted.find((vector) => vector.message.length === 4032 * 2),
    );
    const chunks = cmd.ed25519Stream(r, hex(message.publicKey), hex(message.message));
    expect(chunks.map((chunk) => chunk.p1)).toStrictEqual([
      ...Array.from({ length: 17 }, () => 1),
      2,
    ]);
    expect(chunks.slice(0, -1).every((chunk) => chunk.data.length === 236)).toBe(true);
    expect(requireCase(chunks.at(-1)).data).toHaveLength((64 + message.message.length / 2) % 236);
    const reassembled = concatBytes(...chunks.map((chunk) => chunk.data));
    expect(reassembled.subarray(0, 32)).toStrictEqual(r);
    expect(reassembled.subarray(64)).toStrictEqual(hex(message.message));
  });
});
