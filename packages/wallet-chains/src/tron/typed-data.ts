/**
 * TIP-712 typed data — EIP-712 with TRON's two deviations (tips/tip-712.md; the oracle is TronWeb
 * 6.5.2's TypedDataEncoder): an `address` leaf is the 20 bytes after the 0x41 version byte, and
 * `trcToken` is an atomic type encoded like `uint256`. `parseTronTypedData` validates the canonical
 * JSON — what `TypedDataEncoder.getPayload` emits — and `tronTypedDataDigest` computes
 * `keccak256(0x1901 ‖ hashStruct(EIP712Domain, domain) ‖ hashStruct(primaryType, message))`,
 * byte-identical to TronWeb's `hashTypedData` on every accepted document. Where the canonical
 * grammar is stricter than TronWeb's loose inputs (JSON booleans only, even-length `0x` hex, no
 * bare-width `uint`), the difference can only change what it hashes to, never whether it signs — so
 * strictness is a validation concern, not a compatibility one.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { isRecord } from "../account-ref.ts";
import { MAX_TYPED_DATA_DEPTH, isTypedDataInput } from "../evm/typed-data.ts";
import type { ParsedTypedData, TypedDataInput } from "../evm/typed-data.ts";
import { ChainError } from "../index.ts";
import { strictJson } from "../strict-json.ts";
import { isTronAddress, tronAddressFromHex, tronAddressToBytes } from "./address.ts";

const fail = (what: string): never => {
  throw new ChainError("invalid-typed-data", what);
};

type Field = { readonly name: string; readonly type: string };
type Types = Record<string, ReadonlyArray<Field>>;

const INT_TYPE = /^(u?)int(\d*)$/;
const FIXED_BYTES = /^bytes(\d+)$/;
const ARRAY_TAIL = /^(.*)\[(\d*)\]$/;

/**
 * A leaf `address` value's 20-byte body: a base58check `T…` string, `41` + 40 hex, or `0x` + 40
 * hex. Bare 40-hex is refused — TronWeb's `toHex` would hash it as garbage rather than an address,
 * so accepting it could only mis-sign.
 */
const addressBody = (value: unknown): Uint8Array | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  if (isTronAddress(value)) {
    return tronAddressToBytes(value).subarray(1);
  }
  if (/^41[0-9a-fA-F]{40}$/.test(value)) {
    return hexToBytes(value).subarray(1);
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return hexToBytes(value.slice(2));
  }
  return undefined;
};

/** The display form of a leaf `address` value — base58check, whichever form the document used. */
export const tronTypedDataBase58 = (value: unknown): string | undefined => {
  const body = addressBody(value);
  return body === undefined ? undefined : tronAddressFromHex(`41${bytesToHex(body)}`);
};

const word = (value: bigint): Uint8Array => {
  const v = value < 0n ? 2n ** 256n + value : value;
  return hexToBytes(v.toString(16).padStart(64, "0"));
};

const intBounds = (signed: boolean, bits: number): readonly [bigint, bigint] =>
  signed ? [-(2n ** BigInt(bits - 1)), 2n ** BigInt(bits - 1) - 1n] : [0n, 2n ** BigInt(bits) - 1n];

/** Canonical-JSON int leaf: safe integer, decimal string (`-` only where signed), or `0x` hex. */
const strictInt = (value: unknown, signed: boolean): bigint | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (
    typeof value === "string" &&
    ((signed ? /^-?[0-9]+$/ : /^[0-9]+$/).test(value) || /^0x[0-9a-fA-F]+$/.test(value))
  ) {
    return BigInt(value);
  }
  return undefined;
};

/** A `tron_signTypedData` argument's int leaf — TronWeb's getBigInt forms. */
const looseInt = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") {
    return value;
  }
  /* TronWeb feeds numbers through ethers' getBigInt, which overflows on non-safe integers. */
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && (/^-?[0-9]+$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value))) {
    return BigInt(value);
  }
  return undefined;
};

/** A bytes leaf — canonical `0x` even-length hex, plus a `Uint8Array` in argument mode. */
const hexLeaf = (value: unknown, args: boolean): Uint8Array | undefined => {
  if (args && value instanceof Uint8Array) {
    return value;
  }
  return typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value)
    ? hexToBytes(value.slice(2))
    : undefined;
};

/**
 * The encoder for one atomic type, mirroring TronWeb's `getBaseEncoder` — including its rule that a
 * base-looking name with a malformed width (`uint7`, `bytes33`, bare `uint`) is a name error, not
 * "no such type", so `isBaseName` below can count it against struct names. `args` relaxes leaf
 * forms to what `_signTypedData(domain, types, value)` accepts.
 */
const baseEncoder = (type: string, args: boolean): ((value: unknown) => Uint8Array) | undefined => {
  const int = INT_TYPE.exec(type);
  if (int !== null) {
    const signed = int[1] === "";
    const w = int[2] === "" ? Number.NaN : Number(int[2]);
    if (w % 8 !== 0 || w < 8 || w > 256 || int[2] !== String(w)) {
      fail(`invalid numeric width in type ${type}`);
    }
    const [min, max] = intBounds(signed, w);
    return (value) => {
      const parsed = args ? looseInt(value) : strictInt(value, signed);
      if (parsed === undefined || parsed < min || parsed > max) {
        return fail(`value is out of bounds for ${type}`);
      }
      return word(parsed);
    };
  }
  const fixed = FIXED_BYTES.exec(type);
  if (fixed !== null) {
    const w = Number(fixed[1]);
    if (w < 1 || w > 32 || String(w) !== fixed[1]) {
      fail(`invalid bytes width in type ${type}`);
    }
    return (value) => {
      const bytes = hexLeaf(value, args);
      if (bytes === undefined || bytes.length !== w) {
        return fail(`invalid length for ${type}`);
      }
      const out = new Uint8Array(32);
      out.set(bytes);
      return out;
    };
  }
  switch (type) {
    case "trcToken":
      return baseEncoder("uint256", args);
    case "address":
      return (value) => {
        const body = addressBody(value);
        if (body === undefined) {
          return fail("address is not a base58, 41-hex or 0x-hex TRON address");
        }
        return concatBytes(new Uint8Array(12), body);
      };
    case "bool":
      return (value) => {
        if (args) {
          const truthy = Boolean(value);
          return word(truthy ? 1n : 0n);
        }
        if (typeof value !== "boolean") {
          return fail("bool is not a JSON boolean");
        }
        return word(value ? 1n : 0n);
      };
    case "bytes":
      return (value) => {
        const bytes = hexLeaf(value, args);
        if (bytes === undefined) {
          return fail("bytes is not 0x-prefixed even-length hex");
        }
        return keccak_256(bytes);
      };
    case "string":
      return (value) => {
        if (typeof value !== "string") {
          return fail("string value is not a string");
        }
        return keccak_256(utf8ToBytes(value));
      };
    default:
      return undefined;
  }
};

/** Mirrors TronWeb's `isBaseTypeName`: every base-looking name counts, even a malformed one. */
const isBaseName = (name: string): boolean =>
  INT_TYPE.test(name) ||
  FIXED_BYTES.test(name) ||
  name === "address" ||
  name === "bool" ||
  name === "string" ||
  name === "bytes" ||
  name === "trcToken";

/** A field type's base after stripping `[]`/`[n]` suffixes; a malformed suffix stays attached. */
const baseName = (type: string): string => {
  let t = type;
  for (;;) {
    const tail = ARRAY_TAIL.exec(t);
    if (tail === null) {
      return t;
    }
    t = tail[1] ?? "";
  }
};

const encodeTypeOf = (types: Types, name: string): string =>
  `${name}(${(types[name] ?? []).map((f) => `${f.type} ${f.name}`).join(",")})`;

/**
 * Validates a struct-type map like TronWeb's TypedDataEncoder constructor: no base-name collisions,
 * unique field names, field types resolving to a base or a declared struct, no cycles, and exactly
 * one root — the only type nothing references, hence the primary type. Unlike TronWeb, an
 * unreachable type (it could only be part of a disconnected cycle) is also refused: it would be
 * dead weight in the document.
 */
const checkTypes = (
  types: Types,
): { readonly primary: string; readonly fullTypes: ReadonlyMap<string, string> } => {
  const names = Object.keys(types);
  const links = new Map<string, Set<string>>();
  const parents = new Map<string, string[]>();
  const subtypes = new Map<string, Set<string>>();
  for (const name of names) {
    links.set(name, new Set());
    parents.set(name, []);
    subtypes.set(name, new Set());
  }
  for (const name of names) {
    if (isBaseName(name)) {
      fail(`struct type name ${JSON.stringify(name)} collides with a base type`);
    }
    const seen = new Set<string>();
    for (const field of types[name] ?? []) {
      if (seen.has(field.name)) {
        fail(`duplicate variable name ${JSON.stringify(field.name)} in ${JSON.stringify(name)}`);
      }
      seen.add(field.name);
      const base = baseName(field.type);
      if (base === name) {
        fail(`circular type reference to ${JSON.stringify(base)}`);
      }
      let baseIsAtomic: boolean;
      try {
        baseIsAtomic = baseEncoder(base, false) !== undefined;
      } catch (error) {
        if (error instanceof ChainError) {
          fail(`invalid field type ${JSON.stringify(field.type)}`);
        }
        throw error;
      }
      if (baseIsAtomic) {
        continue;
      }
      if (!parents.has(base)) {
        fail(`unknown type ${JSON.stringify(base)}`);
      }
      (parents.get(base) ?? []).push(name);
      (links.get(name) ?? new Set<string>()).add(base);
    }
  }
  const roots = names.filter((n) => (parents.get(n) ?? []).length === 0);
  if (roots.length === 0) {
    fail("missing primary type");
  }
  if (roots.length !== 1) {
    fail(
      `ambiguous primary types or unused types: ${roots.map((r) => JSON.stringify(r)).join(", ")}`,
    );
  }
  const primary = roots[0] ?? "";
  const visited = new Set<string>();
  const checkCircular = (type: string, found: Set<string>): void => {
    if (found.has(type)) {
      fail(`circular type reference to ${JSON.stringify(type)}`);
    }
    found.add(type);
    visited.add(type);
    for (const child of links.get(type) ?? new Set<string>()) {
      checkCircular(child, found);
      for (const subtype of found) {
        (subtypes.get(subtype) ?? new Set<string>()).add(child);
      }
    }
    found.delete(type);
  };
  checkCircular(primary, new Set());
  if (visited.size !== names.length) {
    fail("types contains types the primary type does not reach");
  }
  const fullTypes = new Map<string, string>();
  for (const [name, set] of subtypes) {
    const st = [...set].sort();
    fullTypes.set(name, encodeTypeOf(types, name) + st.map((t) => encodeTypeOf(types, t)).join(""));
  }
  return { primary, fullTypes };
};

/**
 * The encoder/walker pair over a validated type map. `hashStruct` produces TronWeb's `hashStruct`:
 * each leaf its 32-byte word, an array the keccak of its elements' encodings, a struct the keccak
 * of `typeHash ‖ fields` (a struct-typed field or element carries its own keccak). `visit` mirrors
 * `TypedDataEncoder.getPayload`'s message normalization: bytes as `0x` hex, integers decimal,
 * addresses `41`-hex, booleans `!!value`.
 */
const makeEncoder = (
  types: Types,
  args: boolean,
): {
  readonly primary: string;
  readonly hashStruct: (type: string, value: unknown) => Uint8Array;
  readonly visit: (type: string, value: unknown) => unknown;
} => {
  const { primary, fullTypes } = checkTypes(types);

  const encode = (type: string, value: unknown, depth: number): Uint8Array => {
    if (depth > MAX_TYPED_DATA_DEPTH) {
      fail("typedData nests too deeply");
    }
    const atomic = baseEncoder(type, args);
    if (atomic !== undefined) {
      return atomic(value);
    }
    const tail = ARRAY_TAIL.exec(type);
    if (tail !== null) {
      if (!Array.isArray(value)) {
        return fail(`${type} value is not an array`);
      }
      const len = tail[2] === "" ? undefined : Number(tail[2]);
      if (len !== undefined && len !== value.length) {
        return fail(`array length mismatch; expected length ${len}`);
      }
      const elementType = tail[1] ?? "";
      const structElements = fullTypes.has(elementType);
      const encoded = value.map((v: unknown) => encode(elementType, v, depth + 1));
      return keccak_256(concatBytes(...encoded.map((e) => (structElements ? keccak_256(e) : e))));
    }
    const fields = types[type];
    if (fields !== undefined) {
      if (!isRecord(value)) {
        return fail(`${type} value is not an object`);
      }
      const typeHash = keccak_256(utf8ToBytes(fullTypes.get(type) ?? ""));
      const encoded = fields.map((f) => {
        const e = encode(f.type, value[f.name], depth + 1);
        return fullTypes.has(f.type) ? keccak_256(e) : e;
      });
      return concatBytes(typeHash, ...encoded);
    }
    return fail(`unknown type ${type}`);
  };

  const visitLeaf = (type: string, value: unknown): unknown => {
    if (/^bytes(\d*)/.test(type)) {
      const bytes = hexLeaf(value, args);
      if (bytes === undefined) {
        return fail(`invalid bytes value for ${type}`);
      }
      return `0x${bytesToHex(bytes)}`;
    }
    if (/^u?int/.test(type) || type === "trcToken") {
      const v = looseInt(value);
      if (v === undefined) {
        return fail(`invalid numeric value for ${type}`);
      }
      return v.toString(10);
    }
    switch (type) {
      case "address": {
        const body = addressBody(value);
        if (body === undefined) {
          return fail("address is not a base58, 41-hex or 0x-hex TRON address");
        }
        return `41${bytesToHex(body)}`;
      }
      case "bool":
        return Boolean(value);
      case "string":
        if (typeof value !== "string") {
          return fail("string value is not a string");
        }
        return value;
      default:
        return fail(`unsupported type ${type}`);
    }
  };

  const visit = (type: string, value: unknown, depth: number): unknown => {
    if (depth > MAX_TYPED_DATA_DEPTH) {
      fail("typedData nests too deeply");
    }
    if (baseEncoder(type, true) !== undefined) {
      return visitLeaf(type, value);
    }
    const tail = ARRAY_TAIL.exec(type);
    if (tail !== null) {
      if (!Array.isArray(value)) {
        return fail(`${type} value is not an array`);
      }
      const len = tail[2] === "" ? undefined : Number(tail[2]);
      if (len !== undefined && len !== value.length) {
        return fail(`array length mismatch; expected length ${len}`);
      }
      return value.map((v: unknown) => visit(tail[1] ?? "", v, depth + 1));
    }
    const fields = types[type];
    if (fields !== undefined) {
      if (!isRecord(value)) {
        return fail(`${type} value is not an object`);
      }
      return Object.fromEntries(
        fields.map((f) => [f.name, visit(f.type, value[f.name], depth + 1)]),
      );
    }
    return fail(`unknown type ${type}`);
  };

  return {
    primary,
    hashStruct: (type, value) => keccak_256(encode(type, value, 0)),
    visit: (type, value) => visit(type, value, 0),
  };
};

/** The five domain fields a TIP-712 document may carry, in canonical order. */
const DOMAIN_FIELD_TYPES: ReadonlyArray<Field> = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];
const DOMAIN_NAMES = new Set(DOMAIN_FIELD_TYPES.map((f) => f.name));

/** `types.EIP712Domain` exactly mirrors the domain's non-null keys, in canonical order. */
const domainFieldsOf = (domain: Record<string, unknown>): Field[] => {
  const fields: Field[] = [];
  for (const f of DOMAIN_FIELD_TYPES) {
    const value = domain[f.name];
    if (value !== undefined && value !== null) {
      fields.push(f);
    }
  }
  for (const key of Object.keys(domain)) {
    if (domain[key] !== undefined && domain[key] !== null && !DOMAIN_NAMES.has(key)) {
      fail(`invalid typed-data domain key ${JSON.stringify(key)}`);
    }
  }
  return fields;
};

const sameFieldList = (declared: ReadonlyArray<Field>, expected: ReadonlyArray<Field>): boolean =>
  declared.length === expected.length &&
  declared.every((f, i) => f.name === expected[i]?.name && f.type === expected[i]?.type);

/**
 * The domain's non-null entries — a `null` domain value is dropped like TronWeb's `== null` skip,
 * so `types.EIP712Domain` can still match the remaining keys.
 */
const domainValues = (domain: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(domain).filter(([, v]) => v !== null && v !== undefined));

/**
 * Parses the canonical TIP-712 JSON. Beyond `isTypedDataInput`'s shape, the document must be strict
 * JSON (no duplicate keys, nothing after the value), `types.EIP712Domain` must be exactly the
 * domain's present keys in canonical order, the struct types must form a single root DAG naming
 * `primaryType`, and every leaf must carry its canonical value — verified by running the encoder,
 * so anything that would hash is something that validated.
 */
export const parseTronTypedData = (typedData: string): ParsedTypedData => {
  const json = strictJson(typedData, (reason) => fail(`typedData ${reason}`));
  if (!isTypedDataInput(json)) {
    return fail("typedData must be a JSON object with types, primaryType, domain and message");
  }
  const domainFields = domainFieldsOf(json.domain);
  const declared = json.types["EIP712Domain"] ?? fail("typedData must declare types.EIP712Domain");
  if (!sameFieldList(declared, domainFields)) {
    fail("types.EIP712Domain is not the canonical field list of the domain keys present");
  }
  tronTypedDataDigest(json);
  return { json: { ...json, domain: domainValues(json.domain) } };
};

/**
 * The signing digest of a parsed document: `keccak256(0x1901 ‖ hashStruct(EIP712Domain, domain) ‖
 * hashStruct(primaryType, message))`. The domain is hashed under the fields its non-null keys
 * derive; the message under `json.primaryType`, which must be the unique root of `types` minus
 * `EIP712Domain`.
 */
export const tronTypedDataDigest = (json: TypedDataInput): Uint8Array => {
  const domainFields = domainFieldsOf(json.domain);
  const messageTypes: Types = {};
  for (const [name, fields] of Object.entries(json.types)) {
    if (name !== "EIP712Domain") {
      messageTypes[name] = fields;
    }
  }
  const encoder = makeEncoder(messageTypes, false);
  if (encoder.primary !== json.primaryType) {
    fail(`primaryType ${JSON.stringify(json.primaryType)} is not the unique root type`);
  }
  const domain = makeEncoder({ EIP712Domain: domainFields }, false).hashStruct(
    "EIP712Domain",
    json.domain,
  );
  const message = encoder.hashStruct(json.primaryType, json.message);
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domain, message));
};

const domainArg = (name: string, value: unknown): unknown => {
  switch (name) {
    case "name":
    case "version":
      if (typeof value !== "string") {
        return fail(`domain.${name} is not a string`);
      }
      return value;
    case "chainId": {
      const v = looseInt(value);
      if (v === undefined || v < 0n) {
        return fail("domain.chainId is not a non-negative integer");
      }
      /* domainChecks.chainId looks like it emits a JSON number when safe
         (Number.isSafeInteger), but its input is getBigInt's bigint, so the branch is
         dead and getPayload always emits a 0x quantity. */
      return `0x${v.toString(16)}`;
    }
    case "verifyingContract": {
      const body = addressBody(value);
      if (body === undefined) {
        return fail("domain.verifyingContract is not a valid TRON address");
      }
      return `41${bytesToHex(body)}`;
    }
    case "salt": {
      const bytes = hexLeaf(value, true);
      if (bytes === undefined || bytes.length !== 32) {
        return fail("domain.salt is not 32 bytes");
      }
      return `0x${bytesToHex(bytes)}`;
    }
    default:
      return fail(`invalid typed-data domain key ${JSON.stringify(name)}`);
  }
};

/**
 * The `tron_signTypedData(domain, types, message)` argument form → the canonical JSON a
 * `tron.typed-data` request carries, mirroring `TypedDataEncoder.getPayload`: `EIP712Domain` is
 * derived from the domain's present keys (a supplied one must equal the derivation), `primaryType`
 * is the unique root of `types`, and message leaves normalize to `0x` hex, decimals, `41`-hex
 * addresses and booleans. The result is re-parsed before it is returned — canonical output is a
 * checked invariant, not an assumption.
 */
export const tronTypedDataFromArgs = (
  domain: unknown,
  types: unknown,
  message: unknown,
): string => {
  if (!isRecord(domain)) {
    return fail("domain must be an object");
  }
  const domainFields: Field[] = [];
  const values: Record<string, unknown> = {};
  for (const f of DOMAIN_FIELD_TYPES) {
    const value = domain[f.name];
    if (value === undefined || value === null) {
      continue;
    }
    domainFields.push(f);
    values[f.name] = domainArg(f.name, value);
  }
  for (const key of Object.keys(domain)) {
    if (domain[key] !== undefined && domain[key] !== null && !DOMAIN_NAMES.has(key)) {
      fail(`invalid typed-data domain key ${JSON.stringify(key)}`);
    }
  }
  if (!isRecord(types)) {
    return fail("types must be an object");
  }
  const tmap: Types = {};
  for (const [name, fields] of Object.entries(types)) {
    if (!Array.isArray(fields)) {
      return fail(`types.${name} is not a list of {name, type} fields`);
    }
    const list: Field[] = [];
    for (const f of fields) {
      if (!isRecord(f) || typeof f["name"] !== "string" || typeof f["type"] !== "string") {
        return fail(`types.${name} is not a list of {name, type} fields`);
      }
      list.push({ name: f["name"], type: f["type"] });
    }
    tmap[name] = list;
  }
  const declared = tmap["EIP712Domain"];
  if (declared !== undefined && !sameFieldList(declared, domainFields)) {
    fail("types.EIP712Domain does not match the domain fields");
  }
  delete tmap["EIP712Domain"];
  if (!isRecord(message)) {
    return fail("message must be an object");
  }
  const encoder = makeEncoder(tmap, true);
  const canonical = encoder.visit(encoder.primary, message);
  const json = JSON.stringify({
    types: { ...tmap, EIP712Domain: domainFields },
    primaryType: encoder.primary,
    domain: values,
    message: canonical,
  });
  parseTronTypedData(json);
  return json;
};

/**
 * The document as an EVM-equivalent input for `recognizePermit`: every `address` leaf becomes
 * `0x`-form so the EVM recognizers' `0x`-only rules match. A document declaring `trcToken` anywhere
 * has no EVM equivalent and is not mapped.
 */
export const tronTypedDataToEvm = (json: TypedDataInput): TypedDataInput | undefined => {
  if (
    Object.values(json.types).some((fields) => fields.some((f) => baseName(f.type) === "trcToken"))
  ) {
    return undefined;
  }
  const map = (type: string, value: unknown): unknown => {
    const tail = ARRAY_TAIL.exec(type);
    if (tail !== null) {
      return Array.isArray(value) ? value.map((v: unknown) => map(tail[1] ?? "", v)) : value;
    }
    const struct = json.types[type];
    if (struct !== undefined) {
      return isRecord(value)
        ? Object.fromEntries(struct.map((f) => [f.name, map(f.type, value[f.name])]))
        : value;
    }
    if (type === "address") {
      const body = addressBody(value);
      return body === undefined ? value : `0x${bytesToHex(body)}`;
    }
    return value;
  };
  const domain = { ...json.domain };
  const verifying = addressBody(domain["verifyingContract"]);
  if (verifying !== undefined) {
    domain["verifyingContract"] = `0x${bytesToHex(verifying)}`;
  }
  return {
    types: json.types,
    primaryType: json.primaryType,
    domain,
    message: Object.fromEntries(
      (json.types[json.primaryType] ?? []).map((f) => [f.name, map(f.type, json.message[f.name])]),
    ),
  };
};

/**
 * The leaf-value override for `typedDataFields` on a TRON document: `address` leaves render base58
 * and `trcToken` decimal; anything else defers to the default leaf rule.
 */
export const tronTypedDataLeaf = (type: string, value: unknown): string | undefined => {
  if (type === "address") {
    return tronTypedDataBase58(value);
  }
  if (type === "trcToken") {
    const v = strictInt(value, false);
    const [, max] = intBounds(false, 256);
    return v === undefined || v > max ? undefined : v.toString(10);
  }
  return undefined;
};
