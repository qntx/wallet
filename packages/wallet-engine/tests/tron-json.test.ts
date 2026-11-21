/**
 * `parseTronJson` is the lossless decoder `tronCaller` applies to every node body: integer literals
 * outside ±(2^53−1) come back as exact `bigint`s (java-tron prints int64 bare), and every safe
 * value is identical to `JSON.parse`. Malformed input throws one typed error; hostile depth is
 * capped before the recursion can overflow.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { account, chainParams, tronCaller } from "../src/chains/tron.ts";
import { TronJsonParseError, parseTronJson } from "../src/gateway/contract/index.ts";

const MAX_SAFE = "9007199254740991";
const TWO53 = "9007199254740992";
const INT64_MAX = "9223372036854775807";
const INT64_MIN = "-9223372036854775808";

describe("parseTronJson", () => {
  it("keeps safe integers as numbers and out-of-range integers as exact bigints", () => {
    expect(parseTronJson(MAX_SAFE)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseTronJson(`-${MAX_SAFE}`)).toBe(Number.MIN_SAFE_INTEGER);
    expect(parseTronJson(TWO53)).toBe(BigInt(TWO53));
    expect(parseTronJson("9007199254740993")).toBe(9007199254740993n);
    expect(parseTronJson(INT64_MAX)).toBe(BigInt(INT64_MAX));
    expect(parseTronJson(INT64_MIN)).toBe(BigInt(INT64_MIN));
    expect(parseTronJson("-0")).toBe(-0);
    expect(parseTronJson("0")).toBe(0);
  });

  it("keeps fractions and exponents as numbers with JSON.parse semantics", () => {
    for (const lit of ["1.5", "-0.25", "1e3", "1E-3", "9007199254740993.0", "1e300", "-1e-300"]) {
      expect(parseTronJson(lit)).toBe(JSON.parse(lit));
    }
    // A fractional literal that overflows stays a number, never a bigint.
    expect(parseTronJson("9223372036854775807.9")).toBe(JSON.parse("9223372036854775807.9"));
  });

  it("parses nested structures with bigints exactly where the literals are", () => {
    expect(
      parseTronJson(
        `{"a":[${INT64_MAX},{"b":${TWO53},"c":null,"d":[true,false,"x"]}],"a2":${INT64_MIN}}`,
      ),
    ).toStrictEqual({
      a: [BigInt(INT64_MAX), { b: BigInt(TWO53), c: null, d: [true, false, "x"] }],
      a2: BigInt(INT64_MIN),
    });
  });

  it("a duplicate key keeps the last value, like JSON.parse", () => {
    expect(parseTronJson('{"k":1,"k":2,"k":3}')).toStrictEqual(JSON.parse('{"k":1,"k":2,"k":3}'));
    expect(parseTronJson(`{"k":"a","k":${INT64_MAX}}`)).toStrictEqual({ k: BigInt(INT64_MAX) });
  });

  it("a __proto__ key is an own property, like JSON.parse", () => {
    const parsed = parseTronJson('{"__proto__":1,"a":2}');
    const ours = Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value;
    const native = Object.getOwnPropertyDescriptor(
      JSON.parse('{"__proto__":1,"a":2}'),
      "__proto__",
    )?.value;
    expect(ours).toBe(1);
    expect(ours).toBe(native);
  });

  it("huge digit strings parse to exact bigints", () => {
    const digits = `9`.repeat(100);
    expect(parseTronJson(digits)).toBe(BigInt(digits));
    expect(parseTronJson(`-${digits}`)).toBe(-BigInt(digits));
    expect(parseTronJson(`{"v":[${digits},${digits}0]}`)).toStrictEqual({
      v: [BigInt(digits), BigInt(`${digits}0`)],
    });
  });

  it("matches JSON.parse for string escapes and whitespace", () => {
    for (const lit of [
      String.raw`"\u0041\n\t\\\"/\ud83d\ude00"`,
      '  "a"  ',
      "\t[\r\n 1 , 2 ]\n",
      ' { "k" : null } ',
    ]) {
      expect(parseTronJson(lit)).toStrictEqual(JSON.parse(lit));
    }
  });

  it.each([
    "",
    " ",
    "{",
    "[1,",
    "[1,2",
    '{"a":1',
    "tru",
    "nulL",
    "+1",
    "01",
    "-",
    "1.",
    "1e",
    "1e+",
    ".5",
    "1 2",
    "{}x",
    "{a:1}",
    "{'a':1}",
    '{"a" 1}',
    "[1,]",
    "[,1]",
    String.raw`"\x"`,
    String.raw`"\u12"`,
    '"ab',
    '"a\nb"',
    "NaN",
    "Infinity",
  ])("rejects malformed input %# with the typed error", (bad) => {
    let caught: unknown;
    try {
      parseTronJson(bad);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TronJsonParseError);
    // Everything JSON.parse rejects is rejected here too.
    expect(() => JSON.parse(bad)).toThrow(SyntaxError);
  });

  it("caps nesting depth instead of overflowing the stack", () => {
    const deep = `${"[".repeat(511)}1${"]".repeat(511)}`;
    expect(parseTronJson(deep)).toBeDefined();
    const tooDeep = `${"[".repeat(600)}1${"]".repeat(600)}`;
    expect(() => parseTronJson(tooDeep)).toThrow(TronJsonParseError);
    const objTooDeep = `${'{"a":'.repeat(600)}1${"}".repeat(600)}`;
    expect(() => parseTronJson(objTooDeep)).toThrow(TronJsonParseError);
  });

  /* "Safe" means nothing the serializer emits is an unsafe integer literal — integer-valued
     doubles above 2^53 stringify as bare digits and are bigint by design, so they are excluded. */
  const safeNum = fc.oneof(
    fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    fc
      .double({ noNaN: true, noDefaultInfinity: true })
      .filter((d) => !Number.isInteger(d) || Number.isSafeInteger(d)),
  );
  const leaf = fc.oneof(fc.constant(null), fc.boolean(), fc.string(), safeNum);
  const { tree } = fc.letrec((recurse) => ({
    tree: fc.oneof(
      { depthSize: "small" },
      leaf,
      fc.array(recurse("tree"), { maxLength: 5 }),
      fc.dictionary(fc.string(), recurse("tree"), { maxKeys: 5 }),
    ),
  }));

  it("equals JSON.parse for arbitrary safe JSON values", { timeout: 20_000 }, () => {
    fc.assert(
      fc.property(tree, (v) => {
        const text = JSON.stringify(v);
        expect(parseTronJson(text)).toStrictEqual(JSON.parse(text));
      }),
      { numRuns: 2000 },
    );
  });
});

describe("tronCaller lossless reads", () => {
  const fetchOnce =
    (body: string): typeof globalThis.fetch =>
    async () =>
      Promise.resolve(new Response(body));

  it("returns bigint for out-of-range integer fields end to end", async () => {
    const api = tronCaller(["https://a.test"], fetchOnce(`{"v":${INT64_MAX}}`));
    const body = (await api.post("/wallet/getnowblock", {})) as { v: unknown };
    expect(body.v).toBe(BigInt(INT64_MAX));
  });

  it("moves to the next URL when the body is not parseable JSON", async () => {
    const bodies = [new Response("{"), Response.json({ ok: 1 }), new Response("")];
    const fetchFn = (async () => Promise.resolve(bodies.shift()!)) as typeof globalThis.fetch;
    const api = tronCaller(["https://a.test", "https://b.test"], fetchFn);
    await expect(api.post("/wallet/getnowblock", {})).resolves.toStrictEqual({ ok: 1 });
  });

  it.each([String(Number.MAX_SAFE_INTEGER - 1), TWO53, "9007199254740993", INT64_MAX])(
    "account balances stay exact: %s",
    { timeout: 10_000 },
    async (balance) => {
      const api = tronCaller(
        ["https://a.test"],
        fetchOnce(`{"address":"TAddr","balance":${balance}}`),
      );
      const row = await account(api, "TAddr");
      expect(String(row?.balance)).toBe(balance);
    },
  );

  it("signed chain parameters -1 and int64 min stay exact", async () => {
    const params = [
      "getTransactionFee",
      "getEnergyFee",
      "getCreateAccountFee",
      "getCreateNewAccountFeeInSystemContract",
      "getMaxFeeLimit",
      "getCreateNewAccountBandwidthRate",
      "getMaxCreateAccountTxSize",
    ];
    const values = ["-1", ...params.slice(1).map(() => INT64_MIN)];
    const rows = params.map((key, i) => `{"key":"${key}","value":${values[i]}}`).join(",");
    const api = tronCaller(["https://a.test"], fetchOnce(`{"chainParameter":[${rows}]}`));
    const p = await chainParams(api);
    expect(p.transactionFee).toBe(-1n);
    expect(p.energyFee).toBe(BigInt(INT64_MIN));
    expect(p.maxCreateAccountTxSize).toBe(BigInt(INT64_MIN));
  });
});
