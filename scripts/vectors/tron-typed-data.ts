/// <reference types="node" />
/**
 * Regenerates vectors/chains/tron-typed-data.json — TIP-712 fixed vectors, oracle tronweb 6.5.2
 * (`TypedDataEncoder.getPayload` for the canonical JSON, `hashTypedData` for the digest,
 * `signTypedData` for the signature). Accepted rows carry the argument triple the dApp sends, the
 * canonical document and the oracle digest/signature; rejected rows carry a document our parser
 * must refuse with `invalid-typed-data`; blind rows the blind reason `decodeTron` must report.
 *
 * Run from the repo root: bun scripts/vectors/tron-typed-data.ts
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

type Field = { readonly name: string; readonly type: string };
type Doc = {
  domain: Record<string, unknown>;
  types: Record<string, Field[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

const req = createRequire(import.meta.url);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tronweb's typed-data utils are untyped
const { TypedDataEncoder, hashTypedData, signTypedData, pkToAddress } = req("tronweb/utils") as {
  TypedDataEncoder: {
    getPayload: (
      d: Record<string, unknown>,
      t: Record<string, Field[]>,
      v: Record<string, unknown>,
    ) => Doc;
  };
  hashTypedData: (
    d: Record<string, unknown>,
    t: Record<string, Field[]>,
    v: Record<string, unknown>,
  ) => string;
  signTypedData: (
    d: Record<string, unknown>,
    t: Record<string, Field[]>,
    v: Record<string, unknown>,
    key: string,
  ) => string;
  pkToAddress: (key: string) => string;
};

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SIGNER = pkToAddress(KEY);

const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const PERMIT2 = "TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9";

const PERMIT_DOMAIN = {
  name: "Permit2",
  chainId: 728126428,
  verifyingContract: PERMIT2,
};

type Args = {
  domain: Record<string, unknown>;
  types: Record<string, Field[]>;
  message: Record<string, unknown>;
};
type Accepted = { name: string; args: Args; hasTrcToken: boolean };
type Rejected = { name: string; doc: Doc; error: string };
type Blind = { name: string; args: Args; blind: string };

const PERMIT_DETAILS = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint160" },
  { name: "expiration", type: "uint48" },
  { name: "nonce", type: "uint48" },
];

const accepted: Accepted[] = [
  {
    name: "permit2-single",
    args: {
      domain: PERMIT_DOMAIN,
      types: {
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
        PermitDetails: PERMIT_DETAILS,
      },
      message: {
        details: { token: USDT, amount: "1000000", expiration: "2000000000", nonce: "7" },
        spender: "0x0000000000000000000000000000000000000001",
        sigDeadline: "2000000100",
      },
    },
    hasTrcToken: false,
  },
  {
    name: "permit2-batch",
    args: {
      domain: PERMIT_DOMAIN,
      types: {
        PermitBatch: [
          { name: "details", type: "PermitDetails[]" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
        PermitDetails: PERMIT_DETAILS,
      },
      message: {
        details: [
          { token: USDT, amount: "1000000", expiration: "2000000000", nonce: "7" },
          {
            token: "0x0000000000000000000000000000000000000003",
            amount: "5",
            expiration: "1",
            nonce: "0",
          },
        ],
        spender: "0x0000000000000000000000000000000000000001",
        sigDeadline: "2000000100",
      },
    },
    hasTrcToken: false,
  },
  {
    name: "permit2-transfer",
    args: {
      domain: PERMIT_DOMAIN,
      types: {
        PermitTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      message: {
        permitted: { token: USDT, amount: "1000000" },
        spender: "0x0000000000000000000000000000000000000001",
        nonce: "9",
        deadline: "2000000100",
      },
    },
    hasTrcToken: false,
  },
  {
    name: "eip2612-usdt",
    args: {
      domain: {
        name: "Tether USD",
        version: "1",
        chainId: 728126428,
        verifyingContract: USDT,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      message: {
        owner: "41f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        spender: "0x0000000000000000000000000000000000000002",
        value: "1000000",
        nonce: "0",
        deadline: "2000000100",
      },
    },
    hasTrcToken: false,
  },
  {
    name: "trctoken",
    args: {
      domain: { name: "TRC10", chainId: 728126428 },
      types: {
        Send: [
          { name: "asset", type: "trcToken" },
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      message: { asset: "1002000", to: USDT, amount: "42" },
    },
    hasTrcToken: true,
  },
  {
    name: "address-base58",
    args: {
      domain: { name: "A", chainId: 728126428 },
      types: { Mail: [{ name: "to", type: "address" }] },
      message: { to: USDT },
    },
    hasTrcToken: false,
  },
  {
    name: "address-41hex",
    args: {
      domain: { name: "A", chainId: 728126428 },
      types: { Mail: [{ name: "to", type: "address" }] },
      message: { to: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c" },
    },
    hasTrcToken: false,
  },
  {
    name: "address-0x",
    args: {
      domain: { name: "A", chainId: 728126428 },
      types: { Mail: [{ name: "to", type: "address" }] },
      message: { to: "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c" },
    },
    hasTrcToken: false,
  },
  {
    name: "nested-arrays",
    args: {
      domain: { name: "N", chainId: 728126428 },
      types: {
        Order: [
          { name: "items", type: "Item[]" },
          { name: "meta", type: "Meta" },
          { name: "pair", type: "uint256[2]" },
          { name: "grid", type: "uint256[][]" },
        ],
        Item: [
          { name: "sku", type: "string" },
          { name: "qty", type: "uint8" },
        ],
        Meta: [
          { name: "buyer", type: "address" },
          { name: "gift", type: "bool" },
        ],
      },
      message: {
        items: [
          { sku: "a", qty: 1 },
          { sku: "b", qty: 2 },
        ],
        meta: { buyer: USDT, gift: false },
        pair: [7, 8],
        grid: [[1, 2], [3]],
      },
    },
    hasTrcToken: false,
  },
  {
    name: "bytes-leaves",
    args: {
      domain: { name: "B", chainId: 728126428 },
      types: {
        Blob: [
          { name: "data", type: "bytes" },
          { name: "short", type: "bytes4" },
          { name: "hash", type: "bytes32" },
        ],
      },
      message: {
        data: "0xdeadbeef",
        short: "0x01020304",
        hash: `0x${"ab".repeat(32)}`,
      },
    },
    hasTrcToken: false,
  },
  {
    name: "salt-domain",
    args: {
      domain: {
        name: "S",
        version: "2",
        chainId: 728126428,
        verifyingContract: USDT,
        salt: `0x${"cd".repeat(32)}`,
      },
      types: { Ping: [{ name: "nonce", type: "uint64" }] },
      message: { nonce: "3" },
    },
    hasTrcToken: false,
  },
  {
    name: "no-chainid",
    args: {
      domain: { name: "NoChain", verifyingContract: USDT },
      types: { Ping: [{ name: "nonce", type: "uint64" }] },
      message: { nonce: "3" },
    },
    hasTrcToken: false,
  },
  {
    name: "negative-int",
    args: {
      domain: { name: "I", chainId: 728126428 },
      types: { Delta: [{ name: "d", type: "int128" }] },
      message: { d: "-123" },
    },
    hasTrcToken: false,
  },
];

/* Rejected documents — each is a hand-mutated canonical JSON; error is the expected ChainError
   code. */
const base = (over: (doc: Doc) => void): Doc => {
  const doc = TypedDataEncoder.getPayload(
    { name: "X", chainId: 728126428 },
    { Ping: [{ name: "nonce", type: "uint64" }] },
    { nonce: "3" },
  );
  over(doc);
  return doc;
};

const rejected: Rejected[] = [
  {
    name: "eip712domain-extra",
    doc: base((d) => {
      d.types["EIP712Domain"]?.push({ name: "extra", type: "string" });
    }),
    error: "invalid-typed-data",
  },
  {
    name: "eip712domain-missing",
    doc: base((d) => {
      d.types["EIP712Domain"] = [{ name: "chainId", type: "uint256" }];
    }),
    error: "invalid-typed-data",
  },
  {
    name: "eip712domain-reordered",
    doc: base((d) => {
      d.types["EIP712Domain"] = [
        { name: "chainId", type: "uint256" },
        { name: "name", type: "string" },
      ];
    }),
    error: "invalid-typed-data",
  },
  {
    name: "bool-as-string",
    doc: base((d) => {
      d.types["Ping"] = [{ name: "ok", type: "bool" }];
      d.message = { ok: "true" };
    }),
    error: "invalid-typed-data",
  },
  {
    name: "short-hex-address",
    doc: base((d) => {
      d.types["Ping"] = [{ name: "to", type: "address" }];
      d.message = { to: "0x1234" };
    }),
    error: "invalid-typed-data",
  },
  {
    name: "unknown-type",
    doc: base((d) => {
      d.types["Ping"] = [{ name: "x", type: "Missing" }];
    }),
    error: "invalid-typed-data",
  },
  {
    name: "two-roots",
    doc: base((d) => {
      d.types["Other"] = [{ name: "y", type: "uint256" }];
    }),
    error: "invalid-typed-data",
  },
  {
    name: "base-name-struct",
    doc: base((d) => {
      d.types["uint256"] = [{ name: "y", type: "uint8" }];
    }),
    error: "invalid-typed-data",
  },
  {
    name: "duplicate-field",
    doc: base((d) => {
      d.types["Ping"] = [
        { name: "nonce", type: "uint64" },
        { name: "nonce", type: "uint64" },
      ];
    }),
    error: "invalid-typed-data",
  },
  {
    name: "unknown-domain-key",
    doc: base((d) => {
      d.domain["bogus"] = "x";
      d.types["EIP712Domain"]?.push({ name: "bogus", type: "string" });
    }),
    error: "invalid-typed-data",
  },
];

/* Blind rows — the document parses but stays unclaimed, with the expected DisplayIntent.blind. */
const blind: Blind[] = [
  {
    name: "permit2-shape-mismatch",
    args: {
      domain: PERMIT_DOMAIN,
      types: {
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
          { name: "extra", type: "uint256" },
        ],
        PermitDetails: PERMIT_DETAILS,
      },
      message: {
        details: { token: USDT, amount: "1", expiration: "2", nonce: "3" },
        spender: "0x0000000000000000000000000000000000000001",
        sigDeadline: "9",
        extra: "1",
      },
    },
    blind: "typed-data-variant",
  },
  {
    name: "oversize",
    args: {
      domain: { name: "Big", chainId: 728126428 },
      types: {
        Wide: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, type: "string" })),
      },
      message: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, `v${i}`])),
    },
    blind: "typed-data-oversize",
  },
  {
    name: "commitment",
    args: {
      domain: { name: "C", chainId: 728126428 },
      types: { Commit: [{ name: "h", type: "bytes32" }] },
      message: { h: `0x${"ef".repeat(32)}` },
    },
    blind: "typed-data-commitment",
  },
];

const cases = accepted.map(({ name, args, hasTrcToken }) => {
  const payload = TypedDataEncoder.getPayload(args.domain, args.types, args.message);
  const typedData = JSON.stringify(payload);
  const digest = hashTypedData(args.domain, args.types, args.message);
  const signature = signTypedData(args.domain, args.types, args.message, KEY);
  return { name, args, typedData, digest, signature, hasTrcToken };
});

const out = {
  source: "tronweb 6.5.2 utils/typedData (TypedDataEncoder.getPayload/hashTypedData/signTypedData)",
  generated: new Date().toISOString().slice(0, 10),
  key: KEY,
  signer: SIGNER,
  cases,
  rejected: rejected.map(({ name, doc, error }) => ({
    name,
    typedData: JSON.stringify(doc),
    error,
  })),
  blind: blind.map(({ name, args, blind: reason }) => ({
    name,
    typedData: JSON.stringify(TypedDataEncoder.getPayload(args.domain, args.types, args.message)),
    blind: reason,
  })),
};

const path = new URL("../../vectors/chains/tron-typed-data.json", import.meta.url).pathname;
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `wrote ${path}: ${cases.length} accepted, ${rejected.length} rejected, ${blind.length} blind`,
);
