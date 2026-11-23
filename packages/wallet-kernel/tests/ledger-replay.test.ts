/**
 * Replays every recorded speculos case offline: each APDU the client sends must equal the recorded
 * transcript byte for byte, the device answers come from the vector, and the parsed result or
 * LedgerError must equal what the pinned app produced.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import type { Exchange } from "../src/modules/ledger/protocol/apdu.ts";
import type { LedgerApp } from "../src/modules/ledger/protocol/device.ts";
import { LedgerError } from "../src/modules/ledger/protocol/errors.ts";
import {
  BITCOIN_CASES,
  ETHEREUM_CASES,
  SOLANA_CASES,
  TRON_CASES,
} from "./speculos/ledger-cases.ts";
import type { CaseDef, RecordedCase, VectorFile } from "./speculos/record.ts";

const unhex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const isVectorFile = (value: unknown): value is VectorFile =>
  typeof value === "object" && value !== null && "cases" in value && Array.isArray(value.cases);

const vectors = (app: LedgerApp): VectorFile | undefined => {
  const path = fileURLToPath(new URL(`../../../vectors/ledger/${app}.json`, import.meta.url));
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isVectorFile(parsed)) {
    throw new Error(`${path}: unexpected shape`);
  }
  return parsed;
};

/** A no-op Screen double — the replayed device has no buttons to press. */
const noopScreen = {
  texts: [] as string[],
  approve: async () => Promise.resolve(),
  reject: async () => Promise.resolve(),
};

const replay = async (def: CaseDef, recorded: RecordedCase): Promise<void> => {
  let step = 0;
  const exchange: Exchange = async (apdu) => {
    const want = recorded.commands[step];
    if (want === undefined) {
      throw new Error(`case ${recorded.name}: client sent extra APDU ${hex(apdu)}`);
    }
    expect(hex(apdu)).toBe(want.apdu);
    step += 1;
    return Promise.resolve(unhex(want.response));
  };
  try {
    const result = await def.run(exchange, noopScreen as never, def);
    if (recorded.error !== undefined) {
      throw new Error(`case ${recorded.name}: expected error, got ${JSON.stringify(result)}`);
    }
    expect(result).toStrictEqual(recorded.result);
  } catch (error) {
    if (!(error instanceof LedgerError)) {
      throw error;
    }
    const want = recorded.error;
    if (want === undefined) {
      throw new Error(`case ${recorded.name}: unexpected ${error.code} (sw ${error.sw})`, {
        cause: error,
      });
    }
    expect(error.code).toBe(want.code);
    if (want.sw !== undefined) {
      expect(error.sw).toBe(want.sw);
    }
  }
  expect(step).toBe(recorded.commands.length);
};

const requireCaze = (file: VectorFile | undefined, name: string, app: string): RecordedCase => {
  const caze = file?.cases.find((c) => c.name === name);
  if (caze === undefined) {
    throw new Error(`missing recorded case ${app}/${name}`);
  }
  return caze;
};

describe("ledger replay vectors", () => {
  const suites: Array<{ app: LedgerApp; cases: CaseDef[]; file: VectorFile | undefined }> = [
    { app: "ethereum", cases: ETHEREUM_CASES, file: vectors("ethereum") },
    { app: "solana", cases: SOLANA_CASES, file: vectors("solana") },
    { app: "tron", cases: TRON_CASES, file: vectors("tron") },
    { app: "bitcoin", cases: BITCOIN_CASES, file: vectors("bitcoin") },
  ];
  const rows = suites.flatMap(({ app, cases, file }) =>
    cases.map((def) => ({ app, name: def.name, def, file })),
  );

  it.each(rows)("replays $app/$name", async ({ app, def, file }) => {
    expect.hasAssertions();
    await replay(def, requireCaze(file, def.name, app));
  });
});
