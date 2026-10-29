import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Generate vectors/native-frames.json with cborg directly (independent of src/cbor.ts). */
import { encode } from "cborg";

const out = resolve(import.meta.dirname, "../../vectors/native-frames.json");

type Case = {
  name: string;
  value?: unknown;
  frame?: string;
  expect: "ok" | "reject";
  reason?: string;
};
const cases: Case[] = [];

const ok = (name: string, value: Parameters<typeof encode>[0]): void => {
  cases.push({
    name,
    value: value as unknown,
    frame: Buffer.from(encode(value)).toString("hex"),
    expect: "ok",
  });
};
const reject = (name: string, frame: Uint8Array | string, reason: string): void => {
  cases.push({
    name,
    frame: typeof frame === "string" ? frame : Buffer.from(frame).toString("hex"),
    expect: "reject",
    reason,
  });
};

ok("null", null);
ok("true", true);
ok("false", false);
ok("zero", 0);
ok("positive-int", 42);
ok("negative-int", -17);
ok("safe-int-max", Number.MAX_SAFE_INTEGER);
ok("empty-string", "");
ok("string", "kernel:post");
ok("unicode-string", "héllo 钱包");
ok("bytes-empty", new Uint8Array(0));
ok("bytes", new Uint8Array([0, 1, 2, 255]));
ok("empty-array", []);
ok("array", [1, "two", true, null]);
ok("empty-object", {});
ok("object", { method: "session.touch", id: 7, params: { a: [1, 2] } });
ok("nested", { session: { wallets: [{ id: "w1", groups: [0, 1, 2], meta: { locked: false } }] } });

reject("float", encode(1.5), "float");
reject("float64-pi", encode(Math.PI), "float");
reject("unsafe-int", encode(Number.MAX_SAFE_INTEGER + 1), "unsafe-int");
reject("undefined", Uint8Array.from([0xf7]), "undefined");
reject("bigint-as-uint64", encode(BigInt("9007199254740993")), "unsafe-int");
reject("tag-bignum", Uint8Array.from([0xc2, 0x41, 0x00]), "tag");
reject(
  "tag-datetime",
  Uint8Array.from([0xc0, 0x74, ...new TextEncoder().encode("2013-03-21T20:04:00Z")]),
  "tag",
);
reject("non-string-key", Uint8Array.from([0xa1, 0x01, 0x02]), "non-string-key");
reject(
  "duplicate-key",
  Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]),
  "duplicate-key",
);
reject("indefinite-array", Uint8Array.from([0x9f, 0x01, 0x02, 0xff]), "indefinite");
reject("indefinite-map", Uint8Array.from([0xbf, 0x61, 0x61, 0x01, 0xff]), "indefinite");
reject("empty", new Uint8Array(0), "truncated");
reject("truncated", Uint8Array.from([0xa1, 0x61]), "malformed");
const big = new Uint8Array(1024 * 1024 + 1);
{
  const frame = encode(big);
  cases.push({
    name: "oversize",
    frame: Buffer.from(frame).toString("hex"),
    expect: "reject",
    reason: "oversize",
  });
}

writeFileSync(
  out,
  `${JSON.stringify(
    { description: "Kernel-channel CBOR frames (strict ProtocolValue domain)", cases },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${out} (${cases.length} cases)`);
