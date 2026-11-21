/**
 * Solana mainnet fixtures: real transactions (two per program family) re-fetched from the public
 * RPC by scripts/vectors/solana-mainnet.ts. Every fixture must decode to its pinned class — a
 * `blind` reason, or `undefined` with the count of programAuthority entries — so a decoder change
 * that silently re-classes a real transaction fails here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { decodeSolana } from "../src/solana/index.ts";
import type { BlindReason } from "../src/index.ts";

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;

type Fixture = {
  readonly label: string;
  readonly program: string;
  readonly signature: string;
  readonly signer: string;
  readonly message: string;
  readonly lookupTables?: ReadonlyArray<{
    readonly address: string;
    readonly addresses: ReadonlyArray<string>;
  }>;
};

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana-mainnet.json"), "utf8"),
) as Fixture[];

/* signature prefix → [expected blind (undefined = described), programAuthority entry count] */
const expected: Record<string, readonly [BlindReason | undefined, number]> = {
  zYfMbwWqc26i: ["program-authority", 1],
  "4ZgGzFAQUZW2": ["program-authority", 1],
  "3c196gtidd98": [undefined, 2],
  "5SXmd3gsbs8m": [undefined, 1],
  "5pm4LpEeFQYz": [undefined, 1],
  "4jm6EBbGnmZN": [undefined, 1],
  "2cu4yxFLmq8r": ["program-authority", 2],
  "28zvUEaiK5mh": [undefined, 2],
  "5TxQMHyNe9zG": [undefined, 1],
  "4Gw1daGSyTk1": [undefined, 1],
  "3RKLg59qHt39": [undefined, 1],
  "4TbJ8ktGJ21H": [undefined, 1],
  yArWhwYWvJAd: [undefined, 1],
  "48CgRHsnfc38": [undefined, 1],
  "2i2KaJa2hbNG": [undefined, 0],
  "2g8W344o3APT": [undefined, 0],
  "55WEmE2mabLY": ["program-authority", 2],
  "2vd7c6nHgafK": ["program-authority", 2],
  "64dQeTRdnDBX": [undefined, 1],
  d8ASHGbcZy4w: [undefined, 1],
  "5BNpKjy1yVdp": [undefined, 0],
  wSFiqNWATBKu: [undefined, 0],
  "3eUMQBKD7GJo": [undefined, 1],
  "2Agn3XxRf4Ud": [undefined, 1],
  "2JMd6BHt5jjF": [undefined, 1],
  "48QW6n6kwr32": [undefined, 1],
  "2WQtSrGHJ8ZA": [undefined, 2],
  "29uWmL2Jwbt9": [undefined, 2],
  nPsLJ87bae9f: ["program-authority", 2],
  "2bJGJCSQg5za": ["program-authority", 1],
  RJGLC4Jsy7HM: [undefined, 1],
  "3haVxXtM5FZo": [undefined, 1],
  "2gY6PiMjNs6C": [undefined, 1],
  "4qGxbcXkMQjd": [undefined, 1],
  "3gDLixGSjoHz": [undefined, 1],
  "5CM9JJCdwqzt": [undefined, 1],
};

describe("solana mainnet fixtures decode to their pinned class", () => {
  it("the expectation table covers every fixture", () => {
    expect(Object.keys(expected)).toHaveLength(fixtures.length);
  });
  it.each(fixtures)("$label $signature", (fixture) => {
    const want = expected[fixture.signature.slice(0, 12)];
    if (want === undefined) {
      throw new Error(`no expectation pinned for ${fixture.signature}`);
    }
    const intent = decodeSolana(
      {
        kind: "solana.transaction",
        network: MAINNET,
        account: ACCOUNT,
        message: Uint8Array.from(Buffer.from(fixture.message, "base64")),
        ...(fixture.lookupTables === undefined || fixture.lookupTables.length === 0
          ? {}
          : { lookupTables: fixture.lookupTables }),
      },
      fixture.signer,
    );
    expect(intent.blind).toBe(want[0]);
    expect(intent.programAuthority ?? []).toHaveLength(want[1]);
  });
});
