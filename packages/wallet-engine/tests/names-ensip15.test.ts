import { readFileSync } from "node:fs";

import { ens_normalize } from "@adraffy/ens-normalize";
import { describe, expect, it } from "vite-plus/test";

import { assessName } from "../src/requests/risk.ts";

type Ensip15Case = {
  readonly name: string;
  readonly norm?: string;
  readonly error?: boolean;
  readonly comment?: string;
};
type Ensip15Vector = {
  readonly source: string;
  readonly commit: string;
  readonly selection: string;
  readonly cases: ReadonlyArray<Ensip15Case>;
};

const vector = JSON.parse(
  readFileSync(new URL("../../../vectors/names/ensip15.json", import.meta.url), "utf8"),
) as Ensip15Vector;
const validCases = vector.cases
  .filter((row) => row.error !== true)
  .map((row) => ({ ...row, expected: row.norm ?? row.name }));
const errorCases = vector.cases.filter((row) => row.error === true);

describe("ENSIP-15 recorded reference subset", () => {
  it("records its upstream provenance and selection rule", () => {
    expect(vector.source).toBe(
      "https://raw.githubusercontent.com/adraffy/ens-normalize.js/main/validate/tests.json",
    );
    expect(vector.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(vector.selection).toContain("verbatim");
    expect(vector.cases).toHaveLength(143);
  });

  it.each(validCases)("normalizes valid case %# ($comment)", ({ name, expected }) => {
    expect(ens_normalize(name)).toBe(expected);
  });

  it.each(errorCases)("rejects error case %# ($comment)", ({ name }) => {
    expect(() => ens_normalize(name)).toThrow(Error);
  });

  it("assigns unicode findings to non-ASCII reference names", () => {
    expect(assessName("vitalik.eth")).toStrictEqual([]);
    expect(assessName("öbb.at")).toStrictEqual([{ code: "name-unicode", level: "warning" }]);
    expect(assessName("🌈rainbow")).toStrictEqual([{ code: "name-unicode", level: "warning" }]);
  });
});
