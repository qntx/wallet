import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Generate vectors/native-vault-image.json — vault-image CBOR frames for the file RecordStore. */
import { encode } from "cborg";

const out = resolve(import.meta.dirname, "../../vectors/native-vault-image.json");

const image = (
  meta: unknown,
  records: unknown[] = [],
  factors: unknown[] = [],
): { meta: unknown; records: unknown[]; factors: unknown[] } => ({ meta, records, factors });

const meta = (revision: number) => ({
  format: 2,
  revision,
  keyId: "0123456789abcdef0123456789abcdef",
  failedAttempts: 0,
  lastFailureAt: 0,
});

const empty = image(null);
const initialized = image(meta(1));
const withRecord = image(meta(2), [
  {
    kind: "entropy",
    id: "wallet-1",
    header: '{"origin":"mnemonic","words":24}',
    sealed: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  },
]);
const full = image(meta(3), withRecord.records, [
  {
    kind: "password",
    id: "fedcba9876543210fedcba9876543210",
    header: '{"kind":"password"}',
    sealed: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
  },
]);

const cases = [
  { name: "empty", expect: "ok", frame: Buffer.from(encode(empty as never)).toString("hex") },
  {
    name: "initialized",
    expect: "ok",
    frame: Buffer.from(encode(initialized as never)).toString("hex"),
  },
  { name: "record", expect: "ok", frame: Buffer.from(encode(withRecord as never)).toString("hex") },
  {
    name: "record-factor",
    expect: "ok",
    frame: Buffer.from(encode(full as never)).toString("hex"),
  },
  {
    name: "truncated",
    expect: "reject",
    frame: Buffer.from(encode(full as never))
      .subarray(0, 7)
      .toString("hex"),
  },
  { name: "garbage", expect: "reject", frame: "ff6100" },
  { name: "indefinite", expect: "reject", frame: "9f01ff" },
  // Well-formed CBOR, wrong image shape — decode succeeds, validation must reject.
  {
    name: "missing-records",
    expect: "reject",
    frame: Buffer.from(encode({ meta: null, factors: [] })).toString("hex"),
  },
  {
    name: "meta-not-map",
    expect: "reject",
    frame: Buffer.from(encode({ meta: 7, records: [], factors: [] })).toString("hex"),
  },
  {
    name: "extra-key",
    expect: "reject",
    frame: Buffer.from(encode({ meta: null, records: [], factors: [], extra: 1 })).toString("hex"),
  },
];

writeFileSync(
  out,
  `${JSON.stringify(
    { description: "File RecordStore vault images (strict CBOR)", cases },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${out} (${cases.length} cases)`);
