/**
 * A `string` leaf of an EIP-712 or TIP-712 document carrying hidden or reordering characters blinds
 * the request as `message-bytes` — the same hazard a text message gets — in the domain, a top-level
 * field, a nested struct, or a `string[]` element. Drives every `hidden` sample of
 * vectors/chains/text-rule.json through both the EVM and TRON decoders; every `text`/`visible`
 * sample stays described. A key the type does not declare is not signed and is ignored, a
 * recognised permit is still recognised under its poisoned name, and an earlier blind reason (here
 * `typed-data-commitment`) keeps precedence.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { typedDataHasHiddenText } from "../src/evm/typed-data.ts";
import type { SignRequest } from "../src/index.ts";
import { decodeTron } from "../src/tron/decode.ts";
import { ACCOUNT as TRON_ACCOUNT, OWNER as TRON_OWNER } from "./tron.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/text-rule.json"), "utf8"),
) as {
  readonly text: ReadonlyArray<{ name: string; text: string }>;
  readonly hidden: ReadonlyArray<{ name: string; text: string }>;
  readonly visible: ReadonlyArray<{ name: string; text: string }>;
};

const SIGNER = "0x2222222222222222222222222222222222222222";
const EVM_ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;

const PLACES = ["domain", "top", "nested", "array"] as const;
type Place = (typeof PLACES)[number];

const doc = (place: Place, text: string, chainId: number): unknown => ({
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    Note: [{ name: "body", type: "string" }],
    Root: [
      { name: "subject", type: "string" },
      { name: "note", type: "Note" },
      { name: "tags", type: "string[]" },
    ],
  },
  primaryType: "Root",
  domain: { name: place === "domain" ? text : "App", version: "1", chainId },
  message: {
    subject: place === "top" ? text : "hi",
    note: { body: place === "nested" ? text : "ok" },
    tags: [place === "array" ? text : "a"],
  },
});

const evmDoc = (place: Place, text: string): SignRequest => ({
  kind: "evm.typed-data",
  network: "eip155:1",
  account: EVM_ACCOUNT,
  typedData: JSON.stringify(doc(place, text, 1)),
});

const tronDoc = (place: Place, text: string): SignRequest => ({
  kind: "tron.typed-data",
  network: "tron:728126428",
  account: TRON_ACCOUNT,
  typedData: JSON.stringify(doc(place, text, 728126428)),
});

const tronTyped = (doc: unknown): SignRequest => ({
  kind: "tron.typed-data",
  network: "tron:728126428",
  account: TRON_ACCOUNT,
  typedData: JSON.stringify(doc),
});

const evmTyped = (doc: unknown): SignRequest => ({
  kind: "evm.typed-data",
  network: "eip155:1",
  account: EVM_ACCOUNT,
  typedData: JSON.stringify(doc),
});

const blinds = (
  place: Place,
  text: string,
): { readonly evm: string | undefined; readonly tron: string | undefined } => ({
  evm: decodeEvm(evmDoc(place, text), SIGNER).blind,
  tron: decodeTron(tronDoc(place, text), TRON_OWNER).blind,
});

// A leaf that cannot be rendered on one line is already `typed-data-oversize` — an earlier
// blind reason that keeps precedence; the domain name is not leaf-expanded.
const expectedBlind = (place: Place, text: string): string =>
  place !== "domain" && text.includes("\n") ? "typed-data-oversize" : "message-bytes";

// A hidden leaf that keeps the displayable commitment reason, or loses it to oversize when the
// leaf itself cannot be rendered on one line.
const expectedCommitmentBlind = (text: string): string =>
  text.includes("\n") ? "typed-data-oversize" : "typed-data-commitment";

const fields = (spec: string) =>
  spec.split(",").map((part) => {
    const [type = "", name = ""] = part.trim().split(" ");
    return { type, name };
  });

/** Name → blind, so a failing diff names the sample that diverged. */
const blindsByName = (
  place: Place,
  samples: ReadonlyArray<{ name: string; text: string }>,
): Record<string, { readonly evm: string | undefined; readonly tron: string | undefined }> =>
  Object.fromEntries(samples.map(({ name, text }) => [name, blinds(place, text)]));

describe("a hidden character in a typed-data string leaf is blind", () => {
  it.each(PLACES)("every hidden sample at %s is blind on both chains", (place) => {
    expect(blindsByName(place, vectors.hidden)).toStrictEqual(
      Object.fromEntries(
        vectors.hidden.map(({ name, text }) => {
          const blind = expectedBlind(place, text);
          return [name, { evm: blind, tron: blind }];
        }),
      ),
    );
  });

  it.each(PLACES)(
    "every allowed sample at %s stays non-blind on both chains",
    { timeout: 120_000 },
    (place) => {
      const samples = [...vectors.text, ...vectors.visible];
      expect(blindsByName(place, samples)).toStrictEqual(
        Object.fromEntries(samples.map(({ name }) => [name, { evm: undefined, tron: undefined }])),
      );
    },
  );

  it.each(vectors.hidden)(
    "hidden text in a key the type does not declare is not signed and not blind: $name",
    ({ text }) => {
      const extra = (chainId: number) => ({
        types: {
          EIP712Domain: [{ name: "chainId", type: "uint256" }],
          Root: [{ name: "subject", type: "string" }],
        },
        primaryType: "Root",
        domain: { chainId },
        message: { subject: "hi", extra: text },
      });
      expect(decodeEvm(evmTyped(extra(1)), SIGNER).blind).toBeUndefined();
      expect(decodeTron(tronTyped(extra(728126428)), TRON_OWNER).blind).toBeUndefined();
    },
  );

  it.each(vectors.hidden)(
    "a recognised EIP-2612 permit under a poisoned name is blind and recognised: $name",
    ({ text }) => {
      const doc = {
        types: {
          EIP712Domain: fields(
            "string name,string version,uint256 chainId,address verifyingContract",
          ),
          Permit: fields(
            "address owner,address spender,uint256 value,uint256 nonce,uint256 deadline",
          ),
        },
        primaryType: "Permit",
        domain: {
          name: text,
          version: "1",
          chainId: 1,
          verifyingContract: "0x00000000000000000000000000000000DeaDBeef",
        },
        message: {
          owner: "0x0000000000000000000000000000000000000001",
          spender: "0x0000000000000000000000000000000000000002",
          value: "5",
          nonce: 0,
          deadline: 1_900_000_000,
        },
      };
      const intent = decodeEvm(evmTyped(doc), SIGNER);
      expect(intent.blind).toBe("message-bytes");
      expect(intent.approvals).toHaveLength(1);
    },
  );

  it.each(vectors.hidden)(
    "an earlier blind reason keeps precedence over hidden text: $name",
    ({ text }) => {
      const committed = (chainId: number) => ({
        types: {
          EIP712Domain: [{ name: "chainId", type: "uint256" }],
          Root: [
            { name: "digest", type: "bytes32" },
            { name: "subject", type: "string" },
          ],
        },
        primaryType: "Root",
        domain: { chainId },
        message: { digest: `0x${"ab".repeat(32)}`, subject: text },
      });
      const blind = expectedCommitmentBlind(text);
      expect(decodeEvm(evmTyped(committed(1)), SIGNER).blind).toBe(blind);
      expect(decodeTron(tronTyped(committed(728126428)), TRON_OWNER).blind).toBe(blind);
    },
  );
});

describe("a hidden character in a typed-data name or type is blind", () => {
  /* The EIP-712 type encoding signs `primaryType`, every key of `types` and every field's
     `name`/`type` — a deceptive code point there is blind for the same reason as hidden
     message bytes. Each slot is poisoned in a structurally valid document, including a type
     nothing references (all declared types are scanned, not only reachable ones). */
  const namedDoc = (place: string, text: string): unknown => {
    switch (place) {
      case "primary-type":
        return {
          types: {
            EIP712Domain: [{ name: "name", type: "string" }],
            [text]: [{ name: "a", type: "string" }],
          },
          primaryType: text,
          domain: { name: "App" },
          message: { a: "x" },
        };
      case "unused-type":
        return {
          types: {
            EIP712Domain: [{ name: "name", type: "string" }],
            Mail: [{ name: "note", type: "string" }],
            [text]: [{ name: "a", type: "string" }],
          },
          primaryType: "Mail",
          domain: { name: "App" },
          message: { note: "x" },
        };
      case "field-name":
        return {
          types: {
            EIP712Domain: [{ name: "name", type: "string" }],
            Mail: [{ name: text, type: "string" }],
          },
          primaryType: "Mail",
          domain: { name: "App" },
          message: { [text]: "hello" },
        };
      case "field-type":
        return {
          types: {
            EIP712Domain: [{ name: "name", type: "string" }],
            Mail: [{ name: "note", type: text }],
            [text]: [{ name: "a", type: "string" }],
          },
          primaryType: "Mail",
          domain: { name: "App" },
          message: { note: { a: "x" } },
        };
      default:
        return {
          types: {
            EIP712Domain: [{ name: text, type: "string" }],
            Mail: [{ name: "note", type: "string" }],
          },
          primaryType: "Mail",
          domain: { [text]: "App" },
          message: { note: "x" },
        };
    }
  };

  /* TIP-712's structural validator already refuses an unused declared type and a
     non-canonical domain key before the hidden-text check runs, so for those slots the safe
     outcome is the refusal itself. */
  const tronNameBlind = (place: string, text: string): string => {
    try {
      return (
        decodeTron(
          {
            kind: "tron.typed-data",
            network: "tron:728126428",
            account: TRON_ACCOUNT,
            typedData: JSON.stringify(namedDoc(place, text)),
          },
          TRON_OWNER,
        ).blind ?? "described"
      );
    } catch {
      return "refused";
    }
  };

  const nameBlinds = (place: string, text: string) => ({
    evm: decodeEvm(
      {
        kind: "evm.typed-data",
        network: "eip155:1",
        account: EVM_ACCOUNT,
        typedData: JSON.stringify(namedDoc(place, text)),
      },
      SIGNER,
    ).blind,
    tron: tronNameBlind(place, text),
  });

  /** Name → blind, so a failing diff names the sample that diverged. */
  const nameBlindsByName = (place: string) =>
    Object.fromEntries(vectors.hidden.map(({ name, text }) => [name, nameBlinds(place, text)]));

  /* A poisoned `primaryType`, unreachable type key, field `type`, or domain field is blind
     `message-bytes` — on TRON, a structurally refused slot (`unused-type`, `domain-field`)
     reports "refused" for the refusal itself. A field *name* carrying a newline cannot render
     on one row either, so that sample blinds earlier as `typed-data-oversize`. */
  const nameExpected = (place: string, tron: string) =>
    Object.fromEntries(
      vectors.hidden.map(({ name, text }) => {
        const oversize = place === "field-name" && text.includes("\n");
        return [
          name,
          {
            evm: oversize ? "typed-data-oversize" : "message-bytes",
            tron: oversize ? "typed-data-oversize" : tron,
          },
        ];
      }),
    );

  it.each([
    ["primary-type", "message-bytes"],
    ["unused-type", "refused"],
    ["field-name", "message-bytes"],
    ["field-type", "message-bytes"],
    ["domain-field", "refused"],
  ] as const)("every hidden sample in %s is blind or refused on both chains", (place, tron) => {
    expect(nameBlindsByName(place)).toStrictEqual(nameExpected(place, tron));
  });

  /* A `primaryType` or field `type` whose name matches nothing declared never reaches decode —
     the validator refuses it — but the scan is conservative and flags it anyway. */
  it("a poisoned primaryType or field type is hidden even where the validator would refuse", () => {
    const base = {
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "note", type: "string" }],
      },
      primaryType: "Mail",
      domain: { name: "App" },
      message: { note: "x" },
    };
    expect(typedDataHasHiddenText({ ...base, primaryType: "Ma\u202Eil" })).toBe(true);
    expect(
      typedDataHasHiddenText({
        ...base,
        types: { ...base.types, Mail: [{ name: "note", type: "Weird\u202EName" }] },
      }),
    ).toBe(true);
  });
});
