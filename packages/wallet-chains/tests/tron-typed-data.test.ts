import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `parseTronTypedData` / `tronTypedDataDigest` against the tronweb 6.5.2 fixed vectors in
 * vectors/chains/tron-typed-data.json (digests and signatures byte-equal, recovery returns the
 * signer), a second independent oracle (ox `TypedData.getSignPayload` on the EVM-mapped document)
 * for every case without `trcToken`, `tronTypedDataFromArgs` canonical output, the decode
 * blind/approval intents, and the parser's malformed-input rejections.
 */
// oxlint-disable vitest/expect-expect -- the refuse/vector helpers wrap the expect calls
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as TypedData from "ox/TypedData";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import type { SignRequest } from "../src/index.ts";
import { decodeTron } from "../src/tron/decode.ts";
import { normalizeTron } from "../src/tron/index.ts";
import { signTronTypedData } from "../src/tron/sign.ts";
import {
  parseTronTypedData,
  tronTypedDataBase58,
  tronTypedDataDigest,
  tronTypedDataFromArgs,
  tronTypedDataToEvm,
} from "../src/tron/typed-data.ts";
import { recoverTronTypedDataSigner, verifyTronTypedDataSignature } from "../src/tron/verify.ts";
import { ACCOUNT, OWNER } from "./tron.ts";

type VectorFile = {
  readonly key: string;
  readonly signer: string;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly args: {
      readonly domain: unknown;
      readonly types: unknown;
      readonly message: unknown;
    };
    readonly typedData: string;
    readonly digest: string;
    readonly signature: string;
    readonly hasTrcToken: boolean;
  }>;
  readonly rejected: ReadonlyArray<{
    readonly name: string;
    readonly typedData: string;
    readonly error: string;
  }>;
  readonly blind: ReadonlyArray<{
    readonly name: string;
    readonly typedData: string;
    readonly blind: string;
  }>;
};

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/tron-typed-data.json"), "utf8"),
) as VectorFile;

const hex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;

const tdRequest = (typedData: string, network = "tron:728126428"): SignRequest => ({
  kind: "tron.typed-data",
  network,
  account: ACCOUNT,
  typedData,
});

const refuse = (run: () => unknown, code: string, match?: RegExp | string): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).code).toBe(code);
    if (match !== undefined) {
      expect((error as ChainError).message).toMatch(match);
    }
    return;
  }
  throw new Error(`expected ChainError(${code})`);
};

describe("tron-typed-data vectors (tronweb 6.5.2)", () => {
  it.each(vectors.cases)("$name: parse, digest, signature, recovery", (c) => {
    const { json } = parseTronTypedData(c.typedData);
    expect(hex(tronTypedDataDigest(json))).toBe(c.digest);

    const signature = signTronTypedData(c.typedData, hexToBytes(vectors.key.slice(2)));
    expect(hex(signature)).toBe(c.signature);
    expect(signature).toHaveLength(65);
    expect([27, 28]).toContain(signature.at(-1));

    expect(recoverTronTypedDataSigner(c.typedData, signature)).toBe(vectors.signer);
    expect(verifyTronTypedDataSignature(c.typedData, signature, vectors.signer)).toBe(true);
    expect(
      verifyTronTypedDataSignature(c.typedData, signature, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
    ).toBe(false);
  });

  it.each(vectors.cases.filter((c) => !c.hasTrcToken))(
    "$name: ox oracle agrees on the EVM-mapped document",
    (c) => {
      const { json } = parseTronTypedData(c.typedData);
      const evm = tronTypedDataToEvm(json);
      expect(evm).toBeDefined();
      expect(TypedData.getSignPayload(defined(evm))).toBe(c.digest);
    },
  );

  it.each(vectors.cases.filter((c) => c.hasTrcToken))(
    "$name: a trcToken document has no EVM mapping",
    (c) => {
      const { json } = parseTronTypedData(c.typedData);
      expect(tronTypedDataToEvm(json)).toBeUndefined();
    },
  );

  it.each(vectors.cases)("$name: tronTypedDataFromArgs reproduces the canonical document", (c) => {
    const canonical = tronTypedDataFromArgs(c.args.domain, c.args.types, c.args.message);
    expect(JSON.parse(canonical)).toStrictEqual(JSON.parse(c.typedData));
  });

  it.each(vectors.rejected)("$name: refused as $error", (r) => {
    refuse(() => parseTronTypedData(r.typedData), r.error);
    refuse(() => normalizeTron(tdRequest(r.typedData)), r.error);
  });

  it.each(vectors.blind)("$name: decodes blind as $blind", (b) => {
    const intent = decodeTron(tdRequest(b.typedData), OWNER);
    expect(intent.blind).toBe(b.blind);
    expect(intent.verifiability).toBe("opaque");
  });
});

describe("tronTypedDataIntent", () => {
  it("a SUN Permit2 PermitSingle is recognized with base58 approvals", () => {
    const intent = decodeTron(tdRequest(named("permit2-single").typedData), OWNER);
    expect(intent.summary).toBe("approve");
    expect(intent.blind).toBeUndefined();
    expect(intent.approvals[0]).toMatchObject({
      kind: "allowance",
      spender: expect.stringMatching(/^T[1-9A-HJ-NP-Za-km-z]{33}$/),
      via: "permit2",
      amount: { asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
    });
    expect(intent.message).toMatchObject({
      kind: "typed-data",
      domain: { verifyingContract: "TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9" },
    });
  });

  it("an EIP-2612 Permit on USDT is recognized with a base58 spender", () => {
    const intent = decodeTron(tdRequest(named("eip2612-usdt").typedData), OWNER);
    expect(intent.summary).toBe("approve");
    expect(intent.approvals[0]).toMatchObject({
      kind: "allowance",
      spender: expect.stringMatching(/^T[1-9A-HJ-NP-Za-km-z]{33}$/),
      verified: true,
    });
  });

  it("a trcToken document is field-shown with a base58 address leaf", () => {
    const intent = decodeTron(tdRequest(named("trctoken").typedData), OWNER);
    expect(intent.summary).toBe("message");
    expect(intent.blind).toBeUndefined();
    expect(intent.message).toMatchObject({
      kind: "typed-data",
      fields: expect.arrayContaining([
        { path: "to", value: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
        { path: "asset", value: "1002000" },
      ]),
    });
  });

  it("an unclaimed document shows bounded base58 address leaves", () => {
    const intent = decodeTron(tdRequest(named("address-base58").typedData), OWNER);
    expect(intent.message).toMatchObject({
      kind: "typed-data",
      fields: expect.arrayContaining([{ path: "to", value: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }]),
    });
  });
});

const fail = (): never => {
  throw new Error("expected defined");
};

const defined = <T>(value: T | undefined): T => value ?? fail();

const named = (name: string): (typeof vectors.cases)[number] => {
  const c = vectors.cases.find((x) => x.name === name);
  return c ?? fail();
};

describe("normalizeTron tron.typed-data", () => {
  const doc = vectors.cases[0]?.typedData ?? fail();

  it("accepts a valid document on mainnet", () => {
    const req = normalizeTron(tdRequest(doc));
    expect(req.kind).toBe("tron.typed-data");
  });

  it("rejects a document without a domain chainId on a non-matching network", () => {
    const noChain = named("no-chainid").typedData;
    const req = normalizeTron(tdRequest(noChain, "tron:2494104990"));
    expect(req.kind).toBe("tron.typed-data");
  });

  it("chain-id-mismatch when the domain chainId differs", () => {
    refuse(() => normalizeTron(tdRequest(doc, "tron:2494104990")), "chain-id-mismatch", /chainId/);
  });

  it("rejects a non-string payload and a non-TRON network", () => {
    refuse(
      () =>
        normalizeTron({
          kind: "tron.typed-data",
          network: "tron:728126428",
          account: ACCOUNT,
          typedData: new Uint8Array(1),
        }),
      "invalid-request",
    );
    refuse(
      () => normalizeTron(tdRequest(doc, "eip155:1")),
      "invalid-request",
      /not a TRON network/,
    );
  });
});

describe("parseTronTypedData malformed inputs", () => {
  const valid = vectors.cases[0]?.typedData ?? fail();

  it("rejects duplicate object keys", () => {
    refuse(
      () => parseTronTypedData(valid.replace('"primaryType"', '"types":{},"primaryType"')),
      "invalid-typed-data",
    );
    refuse(
      () =>
        parseTronTypedData(
          '{"types":{"A":[]},"types":{"B":[]},"primaryType":"A","domain":{},"message":{}}',
        ),
      "invalid-typed-data",
    );
    /* A duplicate leaf whose last value would silently win must still refuse — never let
       JSON.parse last-write semantics pick what gets hashed. */
    const doc =
      '{"types":{"EIP712Domain":[],"P":[{"name":"n","type":"uint8"}]},"primaryType":"P",' +
      '"domain":{},"message":{"n":1,"n":2}}';
    refuse(() => parseTronTypedData(doc), "invalid-typed-data");
  });

  it("rejects an ambiguous two-root graph as ambiguous, not unreachable", () => {
    const doc = JSON.stringify({
      types: {
        EIP712Domain: [],
        P: [{ name: "a", type: "uint8" }],
        Q: [{ name: "b", type: "uint8" }],
      },
      primaryType: "P",
      domain: {},
      message: { a: 1 },
    });
    refuse(() => parseTronTypedData(doc), "invalid-typed-data", /ambiguous primary types/);
  });

  it("rejects trailing text after the value", () => {
    refuse(() => parseTronTypedData(`${valid} null`), "invalid-typed-data");
    refuse(() => parseTronTypedData(`${valid}{`), "invalid-typed-data");
    refuse(() => parseTronTypedData(valid.slice(0, -1)), "invalid-typed-data");
  });

  it("rejects non-object roots, a missing primaryType and a bad domain", () => {
    for (const bad of ["null", "[]", '"x"', "7", "{}"]) {
      refuse(() => parseTronTypedData(bad), "invalid-typed-data");
    }
  });

  it("rejects a document whose shape is not typed-data input", () => {
    const big = `{"types":{"P":[{"name":"f","type":"string"}]},"x":${JSON.stringify(
      "y".repeat(300000),
    )}}`;
    refuse(() => parseTronTypedData(big), "invalid-typed-data");
  });

  it("rejects deep nesting beyond the depth budget", () => {
    const deep = `${"[".repeat(300)}${"]".repeat(300)}`;
    refuse(() => parseTronTypedData(deep), "invalid-typed-data", /nests too deeply/);
  });

  it("rejects a supplied EIP712Domain that does not match the domain keys", () => {
    refuse(
      () =>
        tronTypedDataFromArgs(
          { name: "X", chainId: 1 },
          { EIP712Domain: [{ name: "name", type: "string" }], Ping: [] },
          {},
        ),
      "invalid-typed-data",
    );
  });

  it("rejects an unknown domain key", () => {
    refuse(
      () => tronTypedDataFromArgs({ name: "X", bogus: 1 }, { Ping: [] }, {}),
      "invalid-typed-data",
      /domain key/,
    );
  });
});

describe("tronTypedDataFromArgs", () => {
  it("rejects a non-safe-integer number leaf like TronWeb's getBigInt", () => {
    refuse(
      () =>
        tronTypedDataFromArgs(
          { name: "X", chainId: 728126428 },
          { Ping: [{ name: "n", type: "uint64" }] },
          { n: 2 ** 60 },
        ),
      "invalid-typed-data",
    );
  });

  it("rejects non-record arguments", () => {
    refuse(() => tronTypedDataFromArgs(null, {}, {}), "invalid-typed-data");
    refuse(() => tronTypedDataFromArgs({}, null, {}), "invalid-typed-data");
    refuse(() => tronTypedDataFromArgs({}, {}, []), "invalid-typed-data");
    refuse(() => tronTypedDataFromArgs({}, { P: "x" }, {}), "invalid-typed-data");
  });
});

describe("tronTypedDataBase58", () => {
  it("renders the three address input forms as base58", () => {
    const b58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    expect(tronTypedDataBase58(b58)).toBe(b58);
    expect(tronTypedDataBase58("41a614f803b6fd780986a42c78ec9c7f77e6ded13c")).toBe(b58);
    expect(tronTypedDataBase58("0xa614f803b6fd780986a42c78ec9c7f77e6ded13c")).toBe(b58);
    expect(tronTypedDataBase58("0x1234")).toBeUndefined();
    expect(tronTypedDataBase58(42)).toBeUndefined();
  });
});
