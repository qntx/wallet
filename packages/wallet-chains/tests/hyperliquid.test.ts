import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import * as fc from "fast-check";
import * as TypedData from "ox/TypedData";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { signEvmTypedData } from "../src/evm/sign.ts";
import { parseTypedData } from "../src/evm/typed-data.ts";
import { ChainError, isBlindIntent } from "../src/index.ts";
import type {
  DisplayIntent,
  HyperliquidAction,
  MessageContent,
  SignRequest,
} from "../src/index.ts";
import { attempt } from "./fuzz.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
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
type UserSignedVector = {
  name: string;
  source?: string;
  typedData: Doc;
  digest: string;
  privateKey: string;
  signature: string;
  expected: HyperliquidAction | null;
};
type L1Vector = {
  name: string;
  source?: string;
  action: Record<string, unknown>;
  nonce: number;
  vaultAddress?: string;
  expiresAfter?: number;
  network: string;
  connectionId: string;
  typedData: Doc;
  digest: string;
  privateKey: string;
  signature: string;
};

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/hyperliquid.json"), "utf8"),
) as { userSigned: UserSignedVector[]; l1: L1Vector[] };

const clone = (doc: Doc): Doc => structuredClone(doc);

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
};

const request = (doc: Doc): SignRequest => ({
  kind: "evm.typed-data",
  network: `eip155:${Number(doc.domain["chainId"])}`,
  account,
  typedData: JSON.stringify(doc),
});

const doc = (name: string): Doc =>
  clone(must(vectors.userSigned.find((v) => v.name === name)?.typedData, name));

const hyperliquid = (message: MessageContent | undefined): HyperliquidAction | undefined =>
  message?.kind === "typed-data" ? message.hyperliquid : undefined;

const INTENT: Readonly<Record<string, { summary: string; verifiability: string }>> = {
  "usd-send": { summary: "transfer", verifiability: "full" },
  withdraw: { summary: "transfer", verifiability: "partial" },
  "spot-send": { summary: "transfer", verifiability: "partial" },
  "usd-class-transfer": { summary: "transfer", verifiability: "full" },
  "send-asset": { summary: "transfer", verifiability: "partial" },
  "staking-deposit": { summary: "stake", verifiability: "full" },
  "staking-withdraw": { summary: "stake", verifiability: "full" },
  "token-delegate": { summary: "stake", verifiability: "partial" },
  "approve-agent": { summary: "approve", verifiability: "partial" },
  "approve-builder-fee": { summary: "approve", verifiability: "partial" },
};

const fields = (doc: Doc): Field[] => doc.types[doc.primaryType] ?? [];

const omit = <T>(obj: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

const described = vectors.userSigned.filter((v) => v.expected !== null);
const blindDocs = vectors.userSigned.filter((v) => v.expected === null);

describe("hyperliquid vectors", () => {
  it.each(described)("$name", (v) => {
    const { json } = parseTypedData(JSON.stringify(v.typedData));
    expect(TypedData.getSignPayload(json)).toBe(v.digest);
    const signature = signEvmTypedData(
      JSON.stringify(v.typedData),
      hexToBytes(v.privateKey.slice(2)),
    );
    expect(`0x${Buffer.from(signature).toString("hex")}`).toBe(v.signature);
    const intent = decodeEvm(request(v.typedData), SIGNER);
    expect(isBlindIntent(intent)).toBe(false);
    expect(hyperliquid(intent.message)).toStrictEqual(v.expected);
    const intentOf = INTENT[must(v.expected, "expected").kind];
    expect(intent.summary).toBe(intentOf?.summary);
    expect(intent.verifiability).toBe(intentOf?.verifiability);
  });

  it.each(blindDocs)("$name stays blind", (v) => {
    const intent = decodeEvm(request(v.typedData), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
    expect(isBlindIntent(intent)).toBe(true);
  });

  it.each(vectors.l1)("$name", (v) => {
    const { json } = parseTypedData(JSON.stringify(v.typedData));
    expect(TypedData.getSignPayload(json)).toBe(v.digest);
    const signature = signEvmTypedData(
      JSON.stringify(v.typedData),
      hexToBytes(v.privateKey.slice(2)),
    );
    expect(`0x${Buffer.from(signature).toString("hex")}`).toBe(v.signature);
    const intent = decodeEvm(request(v.typedData), SIGNER);
    expect(intent.blind).toBe("typed-data-commitment");
  });
});

describe("hyperliquid near misses", () => {
  const nearMisses: ReadonlyArray<{ name: string; mutate: (doc: Doc) => Doc }> = [
    {
      name: "domain version 2",
      mutate: (d) => {
        d.domain["version"] = "2";
        return d;
      },
    },
    {
      name: "non-zero verifying contract",
      mutate: (d) => {
        d.domain["verifyingContract"] = "0x0000000000000000000000000000000000000001";
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
      name: "missing verifyingContract",
      mutate: (d) => {
        d.domain = omit(d.domain, "verifyingContract");
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
      name: "field renamed",
      mutate: (d) => {
        const list = fields(d);
        list[1] = { name: "dest", type: "string" };
        d.message["dest"] = d.message["destination"];
        d.message = omit(d.message, "destination");
        return d;
      },
    },
    {
      name: "field retyped",
      mutate: (d) => {
        const list = fields(d);
        list[1] = { name: "destination", type: "address" };
        return d;
      },
    },
    {
      name: "fields reordered",
      mutate: (d) => {
        const list = fields(d);
        const last = list.pop();
        if (last !== undefined) {
          list.unshift(last);
        }
        return d;
      },
    },
    {
      name: "field added",
      mutate: (d) => {
        fields(d).push({ name: "memo", type: "string" });
        d.message["memo"] = "hello";
        return d;
      },
    },
    {
      name: "field removed",
      mutate: (d) => {
        fields(d).pop();
        return d;
      },
    },
    {
      name: "unknown primary type",
      mutate: (d) => {
        d.types["HyperliquidTransaction:NotAnAction"] = d.types[d.primaryType] ?? [];
        d.types = omit(d.types, d.primaryType);
        d.primaryType = "HyperliquidTransaction:NotAnAction";
        return d;
      },
    },
    {
      name: "multi-sig injected fields",
      mutate: (d) => {
        fields(d).push(
          { name: "payloadMultiSigUser", type: "address" },
          { name: "outerSigner", type: "address" },
        );
        d.message["payloadMultiSigUser"] = "0x1234567890123456789012345678901234567890";
        d.message["outerSigner"] = "0x2234567890123456789012345678901234567890";
        return d;
      },
    },
    {
      name: "lowercase hyperliquidChain",
      mutate: (d) => {
        d.message["hyperliquidChain"] = "mainnet";
        return d;
      },
    },
    ...[
      "-1",
      "1e3",
      "1.",
      ".5",
      "+1",
      " 1",
      "1234567890123456",
      "0.123456789",
      "1 subaccount:0x1234567890123456789012345678901234567890",
    ].map((value) => ({
      name: `amount ${JSON.stringify(value)}`,
      mutate: (d: Doc) => {
        d.message["amount"] = value;
        return d;
      },
    })),
    {
      name: "checksummed destination string",
      mutate: (d) => {
        d.message["destination"] = "0x5E9EE1089755C3435139848e47e6635505D5a13A";
        return d;
      },
    },
    {
      name: "uppercase destination string",
      mutate: (d) => {
        d.message["destination"] = "0x5E9EE1089755C3435139848E47E6635505D5A13A";
        return d;
      },
    },
    {
      name: "time over uint64",
      mutate: (d) => {
        d.message["time"] = "18446744073709551616";
        return d;
      },
    },
  ];

  it.each(nearMisses)("$name", ({ mutate }) => {
    const intent = decodeEvm(request(mutate(doc("usdSend Arbitrum One signing chain"))), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a different domain name is not described", () => {
    const mutated = doc("usdSend Arbitrum One signing chain");
    mutated.domain["name"] = "SomethingElse";
    const intent = decodeEvm(request(mutated), SIGNER);
    expect(hyperliquid(intent.message)).toBeUndefined();
    expect(intent.blind).toBeUndefined();
    expect(intent.verifiability).toBe("opaque");
  });

  const actionNearMisses: ReadonlyArray<{ name: string; doc: Doc }> = [
    {
      name: "malformed token",
      doc: (() => {
        const d = doc("spotSend testnet");
        d.message["token"] = "not a token";
        return d;
      })(),
    },
    ...[
      "a".repeat(17),
      "bad\nname",
      "x valid_until please",
      "agent valid_until abc",
      "agent valid_until 99999999999999999",
    ].map((agentName) => ({
      name: `agentName ${JSON.stringify(agentName)}`,
      doc: (() => {
        const d = doc("approveAgent named");
        d.message["agentName"] = agentName;
        return d;
      })(),
    })),
    {
      name: "maxFeeRate without %",
      doc: (() => {
        const d = doc("approveBuilderFee");
        d.message["maxFeeRate"] = "0.1";
        return d;
      })(),
    },
  ];

  it.each(actionNearMisses)("$name", ({ doc: mutated }) => {
    const intent = decodeEvm(request(mutated), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });
});

describe("hyperliquid L1 phantom agent", () => {
  const agent = must(vectors.l1.find((v) => v.name === "order")?.typedData, "l1 order vector");

  it("is blind as a typed-data commitment", () => {
    const intent = decodeEvm(request(agent), SIGNER);
    expect(intent.blind).toBe("typed-data-commitment");
  });

  it("stays a commitment with chainId 1", () => {
    const mutated = clone(agent);
    mutated.domain["chainId"] = 1;
    const intent = decodeEvm(
      {
        kind: "evm.typed-data",
        network: "eip155:1",
        account,
        typedData: JSON.stringify(mutated),
      },
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-commitment");
  });

  it("is not claimed under another domain name", () => {
    const mutated: Doc = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Agent: [
          { name: "source", type: "string" },
          { name: "note", type: "string" },
        ],
      },
      primaryType: "Agent",
      domain: { name: "NotExchange", version: "1" },
      message: { source: "a", note: "hello" },
    };
    const intent = decodeEvm(
      {
        kind: "evm.typed-data",
        network: "eip155:1",
        account,
        typedData: JSON.stringify(mutated),
      },
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
    expect(intent.verifiability).toBe("opaque");
  });
});

const STRUCTURAL_KINDS = [
  "version",
  "verifyingContract",
  "domainSalt",
  "missingVc",
  "extraType",
  "renameField",
  "retypeField",
  "reorderFields",
  "addField",
  "removeField",
  "primaryType",
  "injectedFields",
] as const;
type Structural = (typeof STRUCTURAL_KINDS)[number];

const applyStructural = (d: Doc, kind: Structural): void => {
  const list = fields(d);
  switch (kind) {
    case "version":
      d.domain["version"] = "2";
      break;
    case "verifyingContract":
      d.domain["verifyingContract"] = "0x0000000000000000000000000000000000000001";
      break;
    case "domainSalt":
      d.types["EIP712Domain"] = [
        ...(d.types["EIP712Domain"] ?? []),
        { name: "salt", type: "bytes32" },
      ];
      d.domain["salt"] = `0x${"ab".repeat(32)}`;
      break;
    case "missingVc":
      d.domain = omit(d.domain, "verifyingContract");
      break;
    case "extraType":
      d.types["Extra"] = [{ name: "a", type: "uint256" }];
      break;
    case "renameField":
      if (list.length > 1) {
        list[1] = { name: "renamed", type: "string" };
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
    case "addField":
      list.push({ name: "memo", type: "string" });
      d.message["memo"] = "hello";
      break;
    case "removeField":
      list.pop();
      break;
    case "primaryType":
      d.primaryType = "HyperliquidTransaction:Renamed";
      break;
    case "injectedFields":
      list.push(
        { name: "payloadMultiSigUser", type: "address" },
        { name: "outerSigner", type: "address" },
      );
      d.message["payloadMultiSigUser"] = "0x1234567890123456789012345678901234567890";
      d.message["outerSigner"] = "0x2234567890123456789012345678901234567890";
      break;
  }
};

type Outcome =
  | { readonly ok: true; readonly intent: DisplayIntent }
  | { readonly ok: false; readonly error: unknown };

const outcomeOf = (doc: Doc): Outcome => {
  const r = attempt(() => decodeEvm(request(doc), SIGNER));
  return r.ok ? { ok: true, intent: r.value } : { ok: false, error: r.error };
};

const payloadOf = (doc: Doc): string | undefined => {
  const p = attempt(() => TypedData.getSignPayload(parseTypedData(JSON.stringify(doc)).json));
  return p.ok ? p.value : undefined;
};

/* The property callbacks cannot hold conditionals, so the helpers return the violation they
   found ("" when none). */
const structuralViolation = (base: UserSignedVector, kind: Structural): string => {
  const mutated = clone(base.typedData);
  applyStructural(mutated, kind);
  const r = outcomeOf(mutated);
  if (!r.ok) {
    return r.error instanceof ChainError ? "" : `unexpected error ${String(r.error)}`;
  }
  return payloadOf(mutated) !== base.digest && r.intent.blind !== "typed-data-variant"
    ? `structural ${kind} changed the digest but blind is ${r.intent.blind ?? "none"}`
    : "";
};

const valueViolation = (base: UserSignedVector, index: number, junk: unknown): string => {
  const keys = Object.keys(base.typedData.message);
  const key = keys[index % keys.length];
  if (key === undefined) {
    return "";
  }
  const mutated = clone(base.typedData);
  mutated.message[key] = junk;
  const r = outcomeOf(mutated);
  if (!r.ok) {
    return r.error instanceof ChainError ? "" : `unexpected error ${String(r.error)}`;
  }
  /* A described document whose digest changed through a displayed field must show the new value;
     time/nonce are not displayed and unhashed keys never change the digest. */
  return key !== "time" &&
    key !== "nonce" &&
    payloadOf(mutated) !== base.digest &&
    hyperliquid(r.intent.message) !== undefined &&
    JSON.stringify(hyperliquid(r.intent.message)) === JSON.stringify(base.expected)
    ? `value mutation of ${key} changed the digest but the described content did not change`
    : "";
};

describe("hyperliquid mutations", () => {
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
