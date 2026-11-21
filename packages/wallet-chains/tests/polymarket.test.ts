import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import * as fc from "fast-check";
import * as TypedData from "ox/TypedData";
import { concat, getAddress, keccak256 } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { signEvmTypedData } from "../src/evm/sign.ts";
import { parseTypedData } from "../src/evm/typed-data.ts";
import { ChainError, isBlindIntent } from "../src/index.ts";
import type {
  DisplayIntent,
  MessageContent,
  PolymarketContent,
  SignRequest,
} from "../src/index.ts";
import { attempt } from "./fuzz.ts";

const OTHER = "0x00000000000000000000000000000000c0ffee00";
const V3 = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";
const account = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

/** Run count for the property tests; the weekly job raises it via FUZZ_RUNS. */
const numRuns = Number(process.env["FUZZ_RUNS"] ?? "200");

type Field = { name: string; type: string };
type Doc = {
  types: Record<string, Field[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
};
type VectorCase = {
  name: string;
  network: string;
  typedData: Doc;
  digest: string;
  signature: string;
  expected: unknown;
  blind?: string;
  onchain?: { block: string; hash: string } | "unavailable";
};

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/polymarket.json"), "utf8"),
) as { privateKey: string; cases: VectorCase[] };

const clone = (doc: Doc): Doc => structuredClone(doc);

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
};

const request = (doc: Doc, network: string): SignRequest => ({
  kind: "evm.typed-data",
  network,
  account,
  typedData: JSON.stringify(doc),
});

/* The signer the document itself binds to (the order's `signer`, the auth `address`); batch and
   deposit-wallet envelopes carry no account binding and decode for any signer. */
const decodeSigner = (v: VectorCase): string => {
  const bound = v.typedData.message["signer"] ?? v.typedData.message["address"];
  return typeof bound === "string" ? getAddress(bound) : OTHER;
};

const doc = (name: string): VectorCase =>
  must(
    vectors.cases.find((v) => v.name === name),
    `vector ${name}`,
  );

const polymarket = (message: MessageContent | undefined): PolymarketContent | undefined =>
  message?.kind === "typed-data" ? message.polymarket : undefined;

const omit = <T>(obj: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

const orderDoc = (): Doc => clone(doc("CTF Exchange buy (EOA)").typedData);
const orderFields = (d: Doc): Field[] => d.types["Order"] ?? [];

/* The POLY_1271 case records the full ERC-7739 blob; the signature over the document is its
   inner-signature prefix. */
const expectedSignature = (v: VectorCase): string =>
  v.typedData.primaryType === "TypedDataSign" ? v.signature.slice(0, 132) : v.signature;

/* The blob carries appDomainSep ‖ contentsHash; hashOrder returns their 0x1901 digest. */
const appDigest = (blob: string): string =>
  keccak256(concat(["0x1901", `0x${blob.slice(132, 196)}`, `0x${blob.slice(196, 260)}`]));

const expectedOnchain = (v: VectorCase): string | undefined => {
  if (v.onchain === undefined || v.onchain === "unavailable") {
    return undefined;
  }
  return v.typedData.primaryType === "TypedDataSign" ? appDigest(v.signature) : v.digest;
};

const actualOnchain = (v: VectorCase): string | undefined =>
  v.onchain === undefined || v.onchain === "unavailable" ? undefined : v.onchain.hash;

const batchView = (content: PolymarketContent | undefined): unknown =>
  content?.kind === "batch"
    ? {
        ...content,
        calls: content.calls.map((c) =>
          c.blind === undefined ? { summary: c.summary } : { summary: c.summary, blind: c.blind },
        ),
      }
    : content;

const batchCalls = (message: MessageContent | undefined): unknown =>
  message?.kind === "typed-data" && message.polymarket?.kind === "batch"
    ? message.polymarket.calls
    : undefined;

const batchCases = vectors.cases.filter((v) => (v.expected as { kind?: string }).kind === "batch");
const nonBatchCases = vectors.cases.filter(
  (v) => (v.expected as { kind?: string }).kind !== "batch",
);

describe("polymarket vectors", () => {
  it.each(vectors.cases)("digest and signature: $name", (v) => {
    const { json } = parseTypedData(JSON.stringify(v.typedData));
    expect(TypedData.getSignPayload(json)).toBe(v.digest);
    const signature = `0x${Buffer.from(
      signEvmTypedData(JSON.stringify(v.typedData), hexToBytes(vectors.privateKey.slice(2))),
    ).toString("hex")}`;
    expect(signature).toBe(expectedSignature(v));
    expect(actualOnchain(v)).toBe(expectedOnchain(v));
  });

  it.each(vectors.cases)("decodes $name", (v) => {
    const intent = decodeEvm(request(v.typedData, v.network), decodeSigner(v));
    expect(intent.blind).toBe(v.blind);
    expect(polymarket(intent.message)).toBeDefined();
  });

  it.each(nonBatchCases)("describes $name", (v) => {
    const intent = decodeEvm(request(v.typedData, v.network), decodeSigner(v));
    expect(polymarket(intent.message)).toStrictEqual(v.expected);
  });

  it.each(batchCases)("batch markers: $name", (v) => {
    const intent = decodeEvm(request(v.typedData, v.network), decodeSigner(v));
    expect(batchView(polymarket(intent.message))).toStrictEqual(v.expected);
  });
});

describe("polymarket order near misses", () => {
  const nearMisses: ReadonlyArray<{ name: string; mutate: (d: Doc) => Doc }> = [
    {
      name: "version 3 for the CTF exchange",
      mutate: (d) => {
        d.domain["version"] = "3";
        return d;
      },
    },
    {
      name: "unknown verifying contract",
      mutate: (d) => {
        d.domain["verifyingContract"] = OTHER;
        return d;
      },
    },
    {
      name: "chainId 80002 for the v3 address",
      mutate: (d) => {
        d.domain["verifyingContract"] = V3;
        d.domain["version"] = "3";
        d.domain["chainId"] = 80002;
        return d;
      },
    },
    {
      name: "chainId 1",
      mutate: (d) => {
        d.domain["chainId"] = 1;
        return d;
      },
    },
    {
      name: "EIP712Domain with salt",
      mutate: (d) => {
        d.types["EIP712Domain"] = [
          ...(d.types["EIP712Domain"] ?? []),
          { name: "salt", type: "bytes32" },
        ];
        d.domain["salt"] = `0x${"0".repeat(64)}`;
        return d;
      },
    },
    {
      name: "extra type",
      mutate: (d) => {
        d.types["Extra"] = [{ name: "a", type: "uint256" }];
        return d;
      },
    },
    {
      name: "Order field renamed",
      mutate: (d) => {
        orderFields(d)[0] = { name: "nonce", type: "uint256" };
        return d;
      },
    },
    {
      name: "Order field retyped",
      mutate: (d) => {
        orderFields(d)[3] = { name: "tokenId", type: "uint128" };
        return d;
      },
    },
    {
      name: "Order fields reordered",
      mutate: (d) => {
        orderFields(d).reverse();
        return d;
      },
    },
    {
      name: "Order field added",
      mutate: (d) => {
        orderFields(d).push({ name: "memo", type: "string" });
        d.message["memo"] = "hi";
        return d;
      },
    },
    {
      name: "Order field removed",
      mutate: (d) => {
        orderFields(d).pop();
        d.message = omit(d.message, "builder");
        return d;
      },
    },
    {
      name: "side 2",
      mutate: (d) => {
        d.message["side"] = 2;
        return d;
      },
    },
    {
      name: "signatureType 3 in a plain Order",
      mutate: (d) => {
        d.message["signatureType"] = 3;
        return d;
      },
    },
    {
      name: "signatureType 0 with maker != signer",
      mutate: (d) => {
        d.message["maker"] = OTHER;
        return d;
      },
    },
    {
      name: "makerAmount 0",
      mutate: (d) => {
        d.message["makerAmount"] = "0";
        return d;
      },
    },
    {
      name: "takerAmount 0",
      mutate: (d) => {
        d.message["takerAmount"] = "0";
        return d;
      },
    },
  ];

  it.each(nearMisses)("$name", ({ mutate }) => {
    const mutated = mutate(orderDoc());
    const signer = String(mutated.message["signer"]);
    const intent = decodeEvm(request(mutated, "eip155:137"), getAddress(signer));
    expect(intent.blind).toBe("typed-data-variant");
    expect(isBlindIntent(intent)).toBe(true);
  });

  it("an order whose signer is not the account stays blind", () => {
    const d = orderDoc();
    const intent = decodeEvm(request(d, "eip155:137"), OTHER);
    expect(intent.blind).toBe("typed-data-variant");
  });
});

describe("polymarket deposit-wallet order near misses", () => {
  const base = (): Doc => clone(doc("deposit-wallet buy (POLY_1271)").typedData);
  const contents = (d: Doc): Record<string, unknown> =>
    must(d.message["contents"], "contents") as Record<string, unknown>;

  const nearMisses: ReadonlyArray<{ name: string; mutate: (d: Doc) => Doc }> = [
    {
      name: "name not DepositWallet",
      mutate: (d) => {
        d.message["name"] = "OtherWallet";
        return d;
      },
    },
    {
      name: "inner version 2",
      mutate: (d) => {
        d.message["version"] = "2";
        return d;
      },
    },
    {
      name: "non-zero inner salt",
      mutate: (d) => {
        d.message["salt"] = `0x${"1".repeat(64)}`;
        return d;
      },
    },
    {
      name: "inner chainId mismatch",
      mutate: (d) => {
        d.message["chainId"] = 80002;
        return d;
      },
    },
    {
      name: "contents.signer != verifyingContract",
      mutate: (d) => {
        contents(d)["signer"] = OTHER;
        return d;
      },
    },
    {
      name: "contents.signatureType 0",
      mutate: (d) => {
        contents(d)["signatureType"] = 0;
        return d;
      },
    },
  ];

  it.each(nearMisses)("$name", ({ mutate }) => {
    const intent = decodeEvm(request(mutate(base()), "eip155:137"), OTHER);
    expect(intent.blind).toBe("typed-data-variant");
  });
});

describe("polymarket ClobAuth near misses", () => {
  const base = (): Doc => clone(doc("ClobAuth (Amoy)").typedData);
  const signer = (d: Doc): string => getAddress(String(d.message["address"]));

  const nearMisses: ReadonlyArray<{ name: string; mutate: (d: Doc) => Doc }> = [
    {
      name: "verifyingContract in the domain",
      mutate: (d) => {
        d.types["EIP712Domain"] = [
          ...(d.types["EIP712Domain"] ?? []),
          { name: "verifyingContract", type: "address" },
        ];
        d.domain["verifyingContract"] = OTHER;
        return d;
      },
    },
    {
      name: "timestamp exponent",
      mutate: (d) => {
        d.message["timestamp"] = "1e9";
        return d;
      },
    },
    {
      name: "changed message",
      mutate: (d) => {
        d.message["message"] = "Sign in to Polymarket";
        return d;
      },
    },
    {
      name: "chainId 1",
      mutate: (d) => {
        d.domain["chainId"] = 1;
        return d;
      },
    },
  ];

  it.each(nearMisses)("$name", ({ mutate }) => {
    const mutated = base();
    const intent = decodeEvm(request(mutate(mutated), "eip155:80002"), signer(mutated));
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("an auth for another address stays blind", () => {
    const d = base();
    const intent = decodeEvm(request(d, "eip155:80002"), OTHER);
    expect(intent.blind).toBe("typed-data-variant");
  });
});

describe("polymarket batch near misses", () => {
  const base = (): Doc => clone(doc("batch: pUSD approve + CTF setApprovalForAll").typedData);
  const calls = (d: Doc): unknown[] => must(d.message["calls"], "calls") as unknown[];

  it("wallet != verifyingContract", () => {
    const d = base();
    d.message["wallet"] = OTHER;
    const intent = decodeEvm(request(d, "eip155:137"), OTHER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("zero calls", () => {
    const d = base();
    d.message["calls"] = [];
    const intent = decodeEvm(request(d, "eip155:137"), OTHER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("nine calls stay blind as oversize", () => {
    const d = base();
    const list = calls(d);
    d.message["calls"] = Array.from({ length: 9 }, (_, i) => list[i % 2]);
    const intent = decodeEvm(request(d, "eip155:137"), OTHER);
    expect(intent.blind).toBe("typed-data-oversize");
    expect(intent.verifiability).toBe("opaque");
    expect(batchCalls(intent.message)).toStrictEqual([]);
  });

  it("deadline over uint48", () => {
    const d = base();
    d.message["deadline"] = String(2n ** 48n);
    const intent = decodeEvm(request(d, "eip155:137"), OTHER);
    expect(intent.blind).toBe("typed-data-variant");
  });
});

const STRUCTURAL_KINDS = [
  "version",
  "verifyingContract",
  "chainId",
  "domainSalt",
  "extraType",
  "renameField",
  "retypeField",
  "reorderFields",
  "removeField",
  "side",
  "signatureType",
  "makerSigner",
  "amount",
] as const;
type Structural = (typeof STRUCTURAL_KINDS)[number];

const applyStructural = (d: Doc, kind: Structural): void => {
  const list = d.types[d.primaryType] ?? [];
  switch (kind) {
    case "version":
      d.domain["version"] = d.domain["version"] === "1" ? "9" : "2";
      break;
    case "verifyingContract":
      d.domain["verifyingContract"] = OTHER;
      break;
    case "chainId":
      d.domain["chainId"] = 1;
      break;
    case "domainSalt":
      d.types["EIP712Domain"] = [
        ...(d.types["EIP712Domain"] ?? []),
        { name: "salt", type: "bytes32" },
      ];
      d.domain["salt"] = `0x${"ab".repeat(32)}`;
      break;
    case "extraType":
      d.types["Extra"] = [{ name: "a", type: "uint256" }];
      break;
    case "renameField":
      if (list.length > 1) {
        list[1] = { name: "renamed", type: list[1]?.type ?? "uint256" };
      }
      break;
    case "retypeField":
      if (list.length > 1) {
        list[1] = { name: list[1]?.name ?? "x", type: "bytes32" };
      }
      break;
    case "reorderFields":
      list.reverse();
      break;
    case "removeField":
      list.pop();
      break;
    case "side":
      d.message["side"] = 9;
      break;
    case "signatureType":
      d.message["signatureType"] = 9;
      break;
    case "makerSigner":
      /* An EOA order's maker must be its signer; a proxy/Safe order may fund from another
         address, so the mutation also drops signatureType to 0. */
      d.message["signatureType"] = 0;
      d.message["maker"] = OTHER;
      break;
    case "amount":
      d.message["makerAmount"] = "0";
      break;
  }
};

type Outcome =
  | { readonly ok: true; readonly intent: DisplayIntent }
  | { readonly ok: false; readonly error: unknown };

const outcomeOf = (v: VectorCase, doc: Doc): Outcome => {
  const r = attempt(() => decodeEvm(request(doc, v.network), decodeSigner(v)));
  return r.ok ? { ok: true, intent: r.value } : { ok: false, error: r.error };
};

const payloadOf = (doc: Doc): string | undefined => {
  const p = attempt(() => TypedData.getSignPayload(parseTypedData(JSON.stringify(doc)).json));
  return p.ok ? p.value : undefined;
};

/* The property callbacks cannot hold conditionals, so the helpers return the violation they
   found ("" when none). */
const structuralViolation = (base: VectorCase, kind: Structural): string => {
  const mutated = clone(base.typedData);
  applyStructural(mutated, kind);
  const r = outcomeOf(base, mutated);
  if (!r.ok) {
    return r.error instanceof ChainError ? "" : `unexpected error ${String(r.error)}`;
  }
  return payloadOf(mutated) !== base.digest && r.intent.blind !== "typed-data-variant"
    ? `structural ${kind} changed the digest but blind is ${r.intent.blind ?? "none"}`
    : "";
};

const valueViolation = (base: VectorCase, index: number, junk: unknown): string => {
  const keys = Object.keys(base.typedData.message);
  const key = keys[index % keys.length];
  if (key === undefined || key === "contents" || key === "calls") {
    return "";
  }
  const mutated = clone(base.typedData);
  mutated.message[key] = junk;
  const r = outcomeOf(base, mutated);
  if (!r.ok) {
    return r.error instanceof ChainError ? "" : `unexpected error ${String(r.error)}`;
  }
  /* A described document whose digest changed through a displayed field must show the new value;
     salt/timestamp/nonce/deadline and the TypedDataSign envelope fields are not displayed and
     unhashed keys never change the digest. */
  const shown =
    key !== "salt" &&
    key !== "timestamp" &&
    key !== "nonce" &&
    key !== "deadline" &&
    key !== "name" &&
    key !== "version" &&
    key !== "chainId" &&
    key !== "verifyingContract";
  return shown &&
    payloadOf(mutated) !== base.digest &&
    polymarket(r.intent.message) !== undefined &&
    JSON.stringify(polymarket(r.intent.message)) === JSON.stringify(base.expected)
    ? `value mutation of ${key} changed the digest but the described content did not change`
    : "";
};

const described = vectors.cases;

describe("polymarket mutations", () => {
  it("structural digest changes go blind as typed-data-variant", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...described),
        fc.constantFrom(...STRUCTURAL_KINDS),
        (base, kind) => {
          expect(structuralViolation(base, kind)).toBe("");
        },
      ),
      { numRuns },
    );
  });

  it("value mutations keep a valid intent and reach the described content", () => {
    fc.assert(
      fc.property(fc.constantFrom(...described), fc.nat(), fc.jsonValue(), (base, index, junk) => {
        expect(valueViolation(base, index, junk)).toBe("");
      }),
      { numRuns },
    );
  });
});
