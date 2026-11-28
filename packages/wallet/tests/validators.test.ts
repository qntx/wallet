import { describe, expect, it } from "vite-plus/test";

import { chainAccount } from "../src/protocol/chains.ts";
import {
  arr,
  bool,
  bytes,
  int,
  isProtocolValue,
  literal,
  MAX_REQUEST_BYTES,
  METHODS,
  nullValue,
  obj,
  opt,
  record,
  requestBytes,
  str,
  union,
  ValidationError,
  validate,
} from "../src/protocol/index.ts";
import type { ProtocolValue } from "../src/protocol/index.ts";

function fails(validator: (v: unknown) => unknown, value: unknown): boolean {
  try {
    validator(value);
    return false;
  } catch (error) {
    return error instanceof ValidationError;
  }
}

/**
 * A depth-`depth` binary DAG: every level shares one live array as both children, so a full tree
 * walk would visit 2^depth nodes while the live object count stays linear.
 */
function dag(depth: number): ProtocolValue[] {
  let node: ProtocolValue[] = [];
  for (let i = 0; i < depth; i++) {
    node = [node, node];
  }
  return node;
}

describe("primitive validators", () => {
  it("literal accepts only the exact value", () => {
    const v = literal("x");
    expect(v("x")).toBe("x");
    expect(fails(v, "y")).toBe(true);
    expect(fails(v, undefined)).toBe(true);
    expect(fails(v, null)).toBe(true);
  });

  it("int enforces safe integers and range", () => {
    const v = int(0, 10);
    expect(v(5)).toBe(5);
    expect(fails(v, -1)).toBe(true);
    expect(fails(v, 11)).toBe(true);
    expect(fails(v, 1.5)).toBe(true);
    expect(fails(v, Number.MAX_SAFE_INTEGER + 1)).toBe(true);
    expect(fails(v, "5")).toBe(true);
  });

  it("str enforces length and pattern", () => {
    const v = str(4, /^[a-z]+$/);
    expect(v("abcd")).toBe("abcd");
    expect(fails(v, "abcde")).toBe(true);
    expect(fails(v, "AB")).toBe(true);
    expect(fails(v, 7)).toBe(true);
  });

  it("bytes enforces exact or ranged length", () => {
    expect(bytes(32)(new Uint8Array(32))).toBeInstanceOf(Uint8Array);
    expect(fails(bytes(32), new Uint8Array(31))).toBe(true);
    expect(fails(bytes(1, 4), new Uint8Array(0))).toBe(true);
    expect(fails(bytes(1, 4), new Uint8Array(5))).toBe(true);
    expect(fails(bytes(4), "aaaa")).toBe(true);
  });

  it("bool and nullValue", () => {
    expect(bool(true)).toBe(true);
    expect(fails(bool, 0)).toBe(true);
    expect(nullValue(null)).toBeNull();
    expect(fails(nullValue, 0)).toBe(true);
  });
});

describe("structural validators", () => {
  it("obj enforces the exact key set including optional keys", () => {
    const v = obj({ a: str(8), b: opt(int(0, 9)) });
    expect(v({ a: "x" })).toStrictEqual({ a: "x" });
    expect(v({ a: "x", b: 3 })).toStrictEqual({ a: "x", b: 3 });
    expect(fails(v, { a: "x", c: 1 })).toBe(true); // unknown key
    expect(fails(v, { b: 3 })).toBe(true); // missing required
    // present-but-undefined optional keys are rejected upstream by isProtocolValue
    expect(fails(v, [])).toBe(true);
    expect(fails(v, new Uint8Array(2))).toBe(true);
    expect(fails(v, "x")).toBe(true);
  });

  it("obj rejects own keys named after Object.prototype members", () => {
    const v = obj({ a: str(8) });
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      // An own enumerable key must never match the shape's prototype chain lookup.
      const input = JSON.parse(`{"a":"x","${name}":1}`) as unknown;
      expect(fails(v, input)).toBe(true);
    }
    // JSON.parse defines __proto__ as an own enumerable key — it is still unknown.
    const withProto = JSON.parse('{"a":"x","__proto__":1}') as unknown;
    expect(fails(v, withProto)).toBe(true);
  });

  it("obj reports a missing required key named after a prototype member", () => {
    // "toString" exists on Object.prototype — a shape key by that name must not be
    // satisfied by the inherited method.
    const v = obj({ a: str(8), toString: str(8) });
    expect(fails(v, { a: "x" })).toBe(true);
    expect(v({ a: "x", toString: "y" })).toStrictEqual({ a: "x", toString: "y" });
  });

  it("arr enforces item shape and bounds", () => {
    const v = arr(int(0, 9), 3, 1);
    expect(v([1, 2])).toStrictEqual([1, 2]);
    expect(fails(v, [])).toBe(true);
    expect(fails(v, [1, 2, 3, 4])).toBe(true);
    expect(fails(v, [1, "x"])).toBe(true);
  });

  it("union picks the first matching branch", () => {
    const v = union(literal("a"), obj({ k: literal("b") }));
    expect(v("a")).toBe("a");
    expect(v({ k: "b" })).toStrictEqual({ k: "b" });
    expect(fails(v, { k: "c" })).toBe(true);
    expect(fails(v, "b")).toBe(true);
  });

  it("validate returns undefined instead of throwing", () => {
    expect(validate(int(0, 9), 4)).toBe(4);
    expect(validate(int(0, 9), 99)).toBeUndefined();
  });
});

describe("isProtocolValue", () => {
  it("accepts the protocol value domain", () => {
    expect(isProtocolValue(null)).toBe(true);
    expect(isProtocolValue(true)).toBe(true);
    expect(isProtocolValue(42)).toBe(true);
    expect(isProtocolValue("s")).toBe(true);
    expect(isProtocolValue(new Uint8Array(3))).toBe(true);
    expect(isProtocolValue([1, "a", [null]])).toBe(true);
    expect(isProtocolValue({ a: 1, b: { c: new Uint8Array(1) } })).toBe(true);
  });

  it("rejects non-protocol values", () => {
    expect(isProtocolValue(1.5)).toBe(false);
    expect(isProtocolValue(undefined)).toBe(false);
    expect(isProtocolValue(Symbol("x"))).toBe(false);
    expect(isProtocolValue(new Map())).toBe(false);
    expect(isProtocolValue(new Date())).toBe(false);
    expect(isProtocolValue({ a: undefined })).toBe(false);
    expect(isProtocolValue(Object.create(null))).toBe(false);
    expect(isProtocolValue({ __proto__: { polluted: true } })).toBe(false);
  });

  it("checks a shared-reference DAG once per object, at any depth", () => {
    expect(isProtocolValue(dag(64))).toBe(true);
    const shared = { kind: "hardware" };
    expect(isProtocolValue({ verify: shared, factor: shared, list: [shared] })).toBe(true);
    const leaf = new Uint8Array(4);
    expect(isProtocolValue({ a: leaf, list: [leaf, leaf] })).toBe(true);
  });

  it("still finds an invalid leaf behind a shared reference", () => {
    const shared = { bad: 1.5 };
    expect(isProtocolValue([shared, shared])).toBe(false);
    const deep: ProtocolValue[] = dag(32);
    expect(isProtocolValue([deep, [deep, { n: Number.MAX_SAFE_INTEGER + 1 }]])).toBe(false);
  });

  it("rejects objects and arrays that contain themselves", () => {
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject["self"] = cyclicObject;
    expect(isProtocolValue(cyclicObject)).toBe(false);
    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);
    expect(isProtocolValue(cyclicArray)).toBe(false);
    const outer: Record<string, unknown> = {};
    outer["list"] = [{ back: outer }];
    expect(isProtocolValue(outer)).toBe(false);
  });
});

describe("requestBytes", () => {
  it("measures the documented worst-case byte weight", () => {
    expect(requestBytes(null)).toBe(8);
    expect(requestBytes(true)).toBe(8);
    expect(requestBytes(42)).toBe(8);
    expect(requestBytes("abcd")).toBe(12); // length * 3
    expect(requestBytes(new Uint8Array(9))).toBe(9);
    // Array: 8 per element plus each element's own size.
    expect(requestBytes([1, "ab"])).toBe(8 + 8 + 8 + 6);
    // Object: each key costs key.length * 3 + 8 plus its value.
    expect(requestBytes({ a: 1 })).toBe(3 + 8 + 8);
    expect(requestBytes({ list: [null] })).toBe(4 * 3 + 8 + 8 + 8);
  });

  it("measures deep values iteratively without overflowing the stack", () => {
    let value: ProtocolValue = null;
    for (let i = 0; i < 50_000; i++) {
      value = [value];
    }
    expect(requestBytes(value)).toBe(50_001 * 8);
  });

  it("flags an over-cap and accepts a just-under-cap request", () => {
    const event = (content: string): ProtocolValue => ({
      v: 1,
      id: 1,
      method: "nostr.signEvent",
      session: "ab".repeat(16),
      params: {
        publicKey: "cd".repeat(32),
        event: { kind: 1, created_at: 1, tags: [], content, pubkey: "cd".repeat(32) },
      },
    });
    expect(requestBytes(event("x".repeat(400_000)))).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(requestBytes(event("x".repeat(262_144)))).toBeLessThan(MAX_REQUEST_BYTES);
  });

  it("stops once the running total passes the cap on a shared-reference DAG", () => {
    // A full walk of dag(64) would push 2^64 nodes; the early exit returns after a bounded count.
    expect(requestBytes(dag(64))).toBeGreaterThan(MAX_REQUEST_BYTES);
  });
});

describe("method table", () => {
  it("rejects malformed params and accepts valid ones for every method", () => {
    for (const spec of Object.values(METHODS)) {
      expect(spec.params).toBeTypeOf("function");
      expect(spec.result).toBeTypeOf("function");
      // params validators reject wrong-typed values
      expect(fails(spec.params, "garbage")).toBe(true);
      expect(fails(spec.params, { extra: 1 })).toBe(true);
    }
  });

  it("accepts a valid unlock request shape", () => {
    const params = METHODS["vault.unlock"].params({
      factor: { kind: "password", password: new Uint8Array(10) },
    });
    expect(params.factor.kind).toBe("password");
  });

  it("enforces batch limits", () => {
    const events = Array.from({ length: 257 }, (_, i) => ({
      id: "ab".repeat(32),
      pubkey: "cd".repeat(32),
      sig: "ef".repeat(64),
      kind: 1059,
      created_at: i,
      tags: [],
      content: "x",
    }));
    expect(
      fails(METHODS["nostr.unwrapGiftWraps"].params, { publicKey: "ab".repeat(32), events }),
    ).toBe(true);
  });
});

describe("record validator", () => {
  const value = bytes(1, 8);
  const key = str(4, /^[0-9a-f]{4}$/);
  const v = record(key, value, 2);

  it("accepts a plain record within the cap", () => {
    expect(v({ aaaa: new Uint8Array(4), bbbb: new Uint8Array(8) })).toStrictEqual({
      aaaa: new Uint8Array(4),
      bbbb: new Uint8Array(8),
    });
  });

  it("rejects non-plain values", () => {
    expect(fails(v, [new Uint8Array(4)])).toBe(true);
    expect(fails(v, new Uint8Array(4))).toBe(true);
    expect(fails(v, "x")).toBe(true);
    expect(fails(v, Object.create(null))).toBe(true);
  });

  it("rejects prototype-polluting keys", () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      const input = JSON.parse(`{"aaaa":null,"${bad}":{"$skip":true}}`) as Record<string, unknown>;
      input["aaaa"] = new Uint8Array(4);
      expect(fails(v, input)).toBe(true);
    }
  });

  it("rejects bad keys, bad values and over-cap entry counts", () => {
    expect(fails(v, { zzzz: new Uint8Array(4) })).toBe(true);
    expect(fails(v, { aaaa: new Uint8Array(64) })).toBe(true);
    expect(
      fails(v, {
        aaaa: new Uint8Array(4),
        bbbb: new Uint8Array(4),
        cccc: new Uint8Array(4),
      }),
    ).toBe(true);
  });
});

describe("spark method validators", () => {
  const account = { walletId: "0011223344556677", groupIndex: 0, network: "regtest" };
  const identifier = "ab".repeat(32);
  const compressed = new Uint8Array(33);
  const bytes32 = new Uint8Array(32);
  const bytes64 = new Uint8Array(64);
  const commitment = { hiding: compressed, binding: compressed };
  const leafId = "3f7b2e1c-1a2b-4c3d-8e4f-000000000001";
  const target = {
    transaction: new Uint8Array(32),
    inputIndex: 0,
    prevouts: [{ script: new Uint8Array(34), amount: 1000 }],
  };
  const signJob = {
    key: { type: "leaf", leafId },
    target,
    verifyingKey: compressed,
    commitment,
    operatorCommitments: [{ identifier, commitment }],
  };
  const aggregateJob = {
    key: { type: "static-deposit", index: 0 },
    target,
    verifyingKey: compressed,
    commitment,
    signatureShare: bytes32,
    operators: [{ identifier, commitment, signatureShare: bytes32, publicKey: compressed }],
  };

  it("accepts valid params for all 13 spark methods", () => {
    const cases: ReadonlyArray<readonly [keyof typeof METHODS, unknown]> = [
      ["spark.identityPublicKey", { account }],
      ["spark.publicKeys", { account, keys: [{ type: "leaf", leafId }] }],
      ["spark.receivedPublicKeys", { account, ciphertexts: [new Uint8Array(96)] }],
      ["spark.newCommitments", { account, count: 2 }],
      ["spark.signFrost", { account, jobs: [signJob] }],
      [
        "spark.signFrost",
        {
          account,
          jobs: [
            { ...signJob, exit: { connectorTx: new Uint8Array(60), exitTx: new Uint8Array(60) } },
          ],
        },
      ],
      ["spark.aggregateFrost", { account, jobs: [aggregateJob] }],
      [
        "spark.signIdentity",
        { account, statement: { kind: "so-challenge", challenge: new Uint8Array(48) } },
      ],
      [
        "spark.signKeySpend",
        { account, key: { type: "received", ciphertext: new Uint8Array(96) }, target },
      ],
      [
        "spark.signHtlcTimeout",
        {
          account,
          request: {
            transaction: new Uint8Array(32),
            inputIndex: 0,
            prevoutAmountSats: 1000,
            paymentHash: bytes32,
            hashLockPublicKey: compressed,
          },
        },
      ],
      [
        "spark.prepareTransfer",
        {
          account,
          request: {
            transferId: leafId,
            leaves: [
              {
                leafId,
                key: { type: "leaf", leafId },
                receiverIdentityPublicKey: compressed,
              },
            ],
          },
        },
      ],
      [
        "spark.prepareClaim",
        {
          account,
          request: { transferId: leafId, leaves: [{ leafId, secretCipher: new Uint8Array(96) }] },
        },
      ],
      ["spark.prepareLightningReceive", { account }],
      [
        "spark.claimStaticDeposit",
        {
          account,
          request: {
            index: 0,
            statement: {
              kind: "static-deposit-claim",
              network: "regtest",
              txid: bytes32,
              vout: 0,
              creditAmountSats: 100_000,
              sspSignature: bytes64,
            },
          },
        },
      ],
    ];
    for (const [method, params] of cases) {
      expect(() => METHODS[method].params(params as never)).not.toThrow();
    }
  });

  it("every spark method is session-gated; only approve is presence-bearing", () => {
    for (const name of Object.keys(METHODS).filter((n) => n.startsWith("spark."))) {
      const spec = METHODS[name as keyof typeof METHODS];
      expect(spec.session).toBe(true);
      expect(spec.presence).toBe(name === "spark.approve");
    }
  });

  it("rejects malformed account refs", () => {
    const { params } = METHODS["spark.identityPublicKey"];
    expect(fails(params, { account: { ...account, network: "signet" } })).toBe(true);
    expect(fails(params, { account: { ...account, walletId: "xyz" } })).toBe(true);
    expect(fails(params, { account: { ...account, groupIndex: -1 } })).toBe(true);
    expect(fails(params, {})).toBe(true);
  });

  it("rejects wrong byte lengths and extra fields", () => {
    expect(fails(METHODS["spark.identityPublicKey"].params, { account, extra: 1 })).toBe(true);
    expect(
      fails(METHODS["spark.publicKeys"].params, {
        account,
        keys: [{ type: "leaf", leafId, extra: true }],
      }),
    ).toBe(true);
    expect(
      fails(METHODS["spark.signFrost"].params, {
        account,
        jobs: [{ ...signJob, verifyingKey: new Uint8Array(32) }],
      }),
    ).toBe(true);
    expect(
      fails(METHODS["spark.signFrost"].params, {
        account,
        jobs: [
          { ...signJob, exit: { connectorTx: new Uint8Array(0), exitTx: new Uint8Array(60) } },
        ],
      }),
    ).toBe(true);
    expect(
      fails(METHODS["spark.signFrost"].params, {
        account,
        jobs: [{ ...signJob, commitment: { hiding: new Uint8Array(33) } }],
      }),
    ).toBe(true);
    expect(
      fails(METHODS["spark.signKeySpend"].params, {
        account,
        key: { type: "unknown" },
        target,
      }),
    ).toBe(true);
  });

  it("caps list params at MAX_BATCH and counts at 1..64", () => {
    const keys = Array.from({ length: 65 }, () => ({ type: "leaf", leafId }));

    const approveParams = METHODS["spark.approve"].params;
    const verify = { kind: "password", password: new Uint8Array(10) };
    const tokenIntent = (amount: string) => ({
      account,
      intent: {
        kind: "token",
        tokenIdentifier: bytes32,
        receivers: [{ ownerPublicKey: compressed, amount }],
      },
      verify,
    });
    for (const amount of ["0", "1", "340282366920938463463374607431768211455"]) {
      expect(fails(approveParams, tokenIntent(amount))).toBe(false);
    }
    for (const amount of ["01", "0abc", "x12", "", "340282366920938463463374607431768211456"]) {
      expect(fails(approveParams, tokenIntent(amount))).toBe(true);
    }
    expect(fails(METHODS["spark.publicKeys"].params, { account, keys })).toBe(true);
    expect(
      fails(METHODS["spark.receivedPublicKeys"].params, {
        account,
        ciphertexts: Array.from({ length: 65 }, () => new Uint8Array(96)),
      }),
    ).toBe(true);
    expect(fails(METHODS["spark.newCommitments"].params, { account, count: 0 })).toBe(true);
    expect(fails(METHODS["spark.newCommitments"].params, { account, count: 65 })).toBe(true);
    expect(fails(METHODS["spark.newCommitments"].params, { account, count: 1.5 })).toBe(true);
    expect(
      fails(METHODS["spark.signFrost"].params, {
        account,
        jobs: Array.from({ length: 65 }, () => signJob),
      }),
    ).toBe(true);
  });

  it("caps transfer/claim leaves at 256 and rejects empty leaf lists", () => {
    const leaf = { leafId, key: { type: "leaf", leafId }, receiverIdentityPublicKey: compressed };
    const request = { transferId: leafId, leaves: Array.from({ length: 256 }, () => leaf) };
    expect(() => METHODS["spark.prepareTransfer"].params({ account, request })).not.toThrow();
    expect(
      fails(METHODS["spark.prepareTransfer"].params, {
        account,
        request: { transferId: leafId, leaves: [...request.leaves, leaf] },
      }),
    ).toBe(true);
    expect(
      fails(METHODS["spark.prepareClaim"].params, {
        account,
        request: { transferId: leafId, leaves: [] },
      }),
    ).toBe(true);
  });

  it("validates every identity statement variant", () => {
    const spec = METHODS["spark.signIdentity"].params;
    const base = { txid: bytes32, vout: 0, target };
    const good: unknown[] = [
      { kind: "so-challenge", challenge: new Uint8Array(48) },
      { kind: "ssp-challenge", protectedChallenge: "cHJvdGVjdGVk" },
      { kind: "transfer-package", transferId: leafId, package: new Uint8Array(24) },
      { kind: "claim-package", transferId: leafId, package: new Uint8Array(24) },
      {
        kind: "static-deposit-claim",
        network: "mainnet",
        txid: bytes32,
        vout: 1,
        creditAmountSats: 50_000,
        sspSignature: bytes64,
      },
      { kind: "static-deposit-refund", network: "regtest", ...base, amount: 5000 },
      { kind: "watchtower-recovery", network: "regtest", leafId, target },
      { kind: "spark-invoice", invoice: new Uint8Array(24) },
      { kind: "token-transaction", partialTransaction: new Uint8Array(24) },
      {
        kind: "lightning-address",
        action: "register",
        domain: "wallet.example",
        username: "satoshi",
        description: "me",
        timestamp: 1_700_000_000,
      },
      {
        kind: "lightning-address",
        action: "unregister",
        domain: "wallet.example",
        username: "satoshi",
        timestamp: 1_700_000_000,
      },
    ];
    for (const statement of good) {
      expect(() => spec({ account, statement })).not.toThrow();
    }
    expect(fails(spec, { account, statement: { kind: "unknown" } })).toBe(true);
    expect(
      fails(spec, {
        account,
        statement: {
          kind: "lightning-address",
          action: "unregister",
          domain: "a.b",
          username: "UPPER",
          timestamp: 1,
        },
      }),
    ).toBe(true);
    expect(
      fails(spec, {
        account,
        statement: {
          kind: "static-deposit-claim",
          network: "signet",
          txid: bytes32,
          vout: 0,
          creditAmountSats: 1,
          sspSignature: bytes64,
        },
      }),
    ).toBe(true);
  });

  it("validates result shapes including operatorPackages records", () => {
    const receive = METHODS["spark.prepareLightningReceive"].result;
    const ok = {
      paymentHash: bytes32,
      operatorPackages: { [identifier]: new Uint8Array(96) },
    };
    expect(receive(ok)).toStrictEqual(ok);
    expect(fails(receive, { ...ok, paymentHash: new Uint8Array(31) })).toBe(true);
    expect(
      fails(receive, { paymentHash: bytes32, operatorPackages: { BAD: new Uint8Array(1) } }),
    ).toBe(true);
    const proto = JSON.parse(`{"paymentHash":null,"operatorPackages":{"__proto__":{}}}`) as Record<
      string,
      unknown
    >;
    proto["paymentHash"] = bytes32;
    expect(fails(receive, proto)).toBe(true);
    const tooMany = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [
        identifier.slice(0, 60) + String(i).padStart(4, "0"),
        new Uint8Array(1),
      ]),
    );
    expect(fails(receive, { paymentHash: bytes32, operatorPackages: tooMany })).toBe(true);
  });
});

describe("hardware op and chain account guards", () => {
  const signOp = {
    kind: "sign",
    request: {
      kind: "evm.personal-message",
      network: "eip155:1",
      account: {
        kind: "hd",
        walletId: "ab".repeat(8),
        groupIndex: 0,
        template: "evm.bip44",
      },
      message: new Uint8Array(4),
    },
  };

  it("acknowledgeUnconfirmed accepts only the literal true", () => {
    /* The flag is the user's answer to a danger prompt — coercible values like "yes" or false
       must not silently stand in for it. */
    const { params } = METHODS["hardware.begin"];
    expect(fails(params, { op: signOp })).toBe(false);
    expect(fails(params, { op: { ...signOp, acknowledgeUnconfirmed: true } })).toBe(false);
    expect(fails(params, { op: { ...signOp, acknowledgeUnconfirmed: false } })).toBe(true);
    expect(fails(params, { op: { ...signOp, acknowledgeUnconfirmed: "yes" } })).toBe(true);
    expect(fails(params, { op: { ...signOp, acknowledgeUnconfirmed: 1 } })).toBe(true);
  });

  it("Ledger token descriptors are bounded wire bytes and a bounded list", () => {
    /* 38..151 bytes is exactly the legacy format's span: shortest ticker/signature through the
       app's 50-byte ticker and longest strict-DER signature. */
    const { params } = METHODS["hardware.begin"];
    const token = new Uint8Array(38);
    expect(fails(params, { op: { ...signOp, descriptors: { tokens: [token] } } })).toBe(false);
    expect(
      fails(params, { op: { ...signOp, descriptors: { tokens: [new Uint8Array(151)] } } }),
    ).toBe(false);
    expect(
      fails(params, { op: { ...signOp, descriptors: { tokens: [new Uint8Array(37)] } } }),
    ).toBe(true);
    expect(
      fails(params, { op: { ...signOp, descriptors: { tokens: [new Uint8Array(152)] } } }),
    ).toBe(true);
    expect(
      fails(params, {
        op: { ...signOp, descriptors: { tokens: Array.from({ length: 17 }, () => token) } },
      }),
    ).toBe(true);
    expect(
      fails(params, { op: { ...signOp, descriptors: { tokens: [new Uint8Array(38), "00"] } } }),
    ).toBe(true);
    expect(fails(params, { op: { ...signOp, descriptors: [] } })).toBe(true);
  });

  it("Ledger typed-data filters are bounded and strictly shaped", () => {
    const { params } = METHODS["hardware.begin"];
    const td = {
      chainId: 1,
      verifyingContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      schemaHash: "a".repeat(56),
      info: new Uint8Array(5),
      filters: [{ path: "spender", kind: 0xff, data: new Uint8Array(3) }],
    };
    const op = (typedData: unknown) => ({ op: { ...signOp, descriptors: { typedData } } });
    expect(fails(params, op(td))).toBe(false);
    for (const kind of [0xfc, 0xfd, 0xfe]) {
      expect(
        fails(params, op({ ...td, filters: [{ path: "a.b", kind, data: new Uint8Array(3) }] })),
      ).toBe(false);
    }
    expect(fails(params, op({ ...td, chainId: -1 }))).toBe(true);
    expect(fails(params, op({ ...td, chainId: 0x100000000 }))).toBe(true);
    expect(fails(params, op({ ...td, verifyingContract: "0xabc" }))).toBe(true);
    expect(
      fails(params, op({ ...td, verifyingContract: "A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" })),
    ).toBe(true);
    expect(fails(params, op({ ...td, schemaHash: "A".repeat(56) }))).toBe(true);
    expect(fails(params, op({ ...td, schemaHash: "a".repeat(55) }))).toBe(true);
    expect(fails(params, op({ ...td, info: new Uint8Array(4) }))).toBe(true);
    expect(fails(params, op({ ...td, info: new Uint8Array(332) }))).toBe(true);
    expect(fails(params, op({ ...td, filters: [] }))).toBe(true);
    expect(
      fails(params, op({ ...td, filters: Array.from({ length: 33 }, () => td.filters[0]) })),
    ).toBe(true);
    expect(
      fails(
        params,
        op({ ...td, filters: [{ path: "1bad", kind: 0xff, data: new Uint8Array(3) }] }),
      ),
    ).toBe(true);
    expect(
      fails(
        params,
        op({ ...td, filters: [{ path: "a..b", kind: 0xff, data: new Uint8Array(3) }] }),
      ),
    ).toBe(true);
    expect(
      fails(
        params,
        op({ ...td, filters: [{ path: "a".repeat(256), kind: 0xff, data: new Uint8Array(3) }] }),
      ),
    ).toBe(true);
    expect(
      fails(params, op({ ...td, filters: [{ path: "ok", kind: 0xfb, data: new Uint8Array(3) }] })),
    ).toBe(true);
    expect(
      fails(params, op({ ...td, filters: [{ path: "ok", kind: 0xff, data: new Uint8Array(2) }] })),
    ).toBe(true);
    expect(
      fails(
        params,
        op({ ...td, filters: [{ path: "ok", kind: 0xff, data: new Uint8Array(332) }] }),
      ),
    ).toBe(true);
  });

  it("every chain account shape requires a boolean confirmed", () => {
    /* The kernel seals confirmed only after an on-device verify; a missing or non-boolean flag
       must not decode as an account at all. */
    const accounts: Array<Record<string, unknown>> = [
      {
        template: "evm.bip44",
        network: "eip155:1",
        address: `0x${"ab".repeat(20)}`,
        confirmed: true,
      },
      {
        template: "solana.bip44-change",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        address: "A".repeat(44),
        confirmed: false,
      },
      {
        template: "tron.bip44",
        network: "tron:mainnet",
        address: `T${"A".repeat(33)}`,
        confirmed: true,
      },
      {
        template: "btc.bip84",
        network: "bip122:000000000019d6689c085ae165831e93",
        xpub: "x".repeat(111),
        fingerprint: "73c5da0a",
        path: "m/84'/0'/0'",
        confirmed: true,
        changeMark: 0,
      },
    ];
    for (const account of accounts) {
      expect(fails(chainAccount, account)).toBe(false);
      const { confirmed: _confirmed, ...missing } = account;
      expect(fails(chainAccount, missing)).toBe(true);
      expect(fails(chainAccount, { ...account, confirmed: "yes" })).toBe(true);
      expect(fails(chainAccount, { ...account, confirmed: 1 })).toBe(true);
    }
  });
});
