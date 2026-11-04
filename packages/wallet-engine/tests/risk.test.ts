import { describe, expect, it } from "vite-plus/test";

import { assessRecipients, comparable, mergeRisk, originRisk } from "../src/requests/risk.ts";

const KNOWN = "0x52908400098527886E0F7030069857D2E4169EE7";
const LOOKALIKE = "0x5290aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9EE7";
const OTHER = "0x1111111111111111111111111111111111112222";

describe("assessRecipients", () => {
  it("flags a recipient nobody has paid or saved", () => {
    expect(assessRecipients("evm", [OTHER], [KNOWN])).toStrictEqual([
      { code: "first-recipient", level: "warning" },
    ]);
  });

  it("is silent for a known address, in any case", () => {
    expect(assessRecipients("evm", [KNOWN], [KNOWN])).toStrictEqual([]);
    expect(assessRecipients("evm", [KNOWN.toLowerCase()], [KNOWN])).toStrictEqual([]);
    expect(assessRecipients("evm", [`0X${KNOWN.slice(2).toUpperCase()}`], [KNOWN])).toStrictEqual(
      [],
    );
  });

  it("flags a lookalike as poisoning, danger first, alongside first-recipient", () => {
    expect(assessRecipients("evm", [LOOKALIKE], [KNOWN])).toStrictEqual([
      { code: "address-poisoning", level: "danger" },
      { code: "first-recipient", level: "warning" },
    ]);
  });

  it("matches first and last four exactly", () => {
    const sameStartOnly = "0x5290aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000";
    const sameEndOnly = "0x0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9EE7";
    expect(assessRecipients("evm", [sameStartOnly], [KNOWN]).map((f) => f.code)).toStrictEqual([
      "first-recipient",
    ]);
    expect(assessRecipients("evm", [sameEndOnly], [KNOWN]).map((f) => f.code)).toStrictEqual([
      "first-recipient",
    ]);
  });

  it("compares EVM lookalikes without the 0x prefix and case", () => {
    expect(comparable("evm", "0xAbC")).toBe("abc");
    expect(comparable("solana", "AbC")).toBe("AbC");
    const upper = LOOKALIKE.toUpperCase().replace("0X", "0x");
    expect(assessRecipients("evm", [upper], [KNOWN]).map((f) => f.code)).toContain(
      "address-poisoning",
    );
  });

  it("deduplicates across several recipients", () => {
    const found = assessRecipients("evm", [OTHER, LOOKALIKE, OTHER], [KNOWN]);
    expect(found.map((f) => f.code)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });

  it("has nothing to say about no recipients", () => {
    expect(assessRecipients("evm", [], [KNOWN])).toStrictEqual([]);
  });
});

describe("originRisk and mergeRisk", () => {
  it("maps trusted to a danger, unchecked to a warning and the rest to nothing", () => {
    expect(originRisk("trusted")).toStrictEqual([{ code: "phishing-origin", level: "danger" }]);
    expect(originRisk("unchecked")).toStrictEqual([
      { code: "phishing-unchecked", level: "warning" },
    ]);
    expect(originRisk("clear")).toStrictEqual([]);
    expect(originRisk("blocked")).toStrictEqual([]);
  });

  it("merges findings deduplicated by code with danger first", () => {
    const merged = mergeRisk(
      [{ code: "first-recipient", level: "warning" }],
      [
        { code: "phishing-origin", level: "danger" },
        { code: "first-recipient", level: "warning" },
      ],
    );
    expect(merged).toStrictEqual([
      { code: "phishing-origin", level: "danger" },
      { code: "first-recipient", level: "warning" },
    ]);
  });
});
