/**
 * Records the protocol client's exchanges against the pinned vendor apps running in Speculos — the
 * app is the oracle. `LEDGER_RECORD=1` writes vectors/ledger/<app>.json; normal runs replay the
 * same cases and assert byte-for-byte transcript, result and error equality (drift check).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { getAddress, hashMessage, hashTypedData, recoverAddress } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { tronMessageDigest } from "@qntx/wallet-chains/tron";

import type { LedgerApp } from "../../src/modules/signers/ledger/protocol/device.ts";
import {
  BITCOIN_CASES,
  COMPLEX,
  ETHEREUM_CASES,
  MAIL,
  SOLANA_CASES,
  TRON_CASES,
} from "./ledger-cases.ts";
import {
  alive,
  appsJson,
  checkCase,
  committed,
  hex,
  RECORD,
  unhex,
  writeVectors,
} from "./record.ts";
import type { CaseDef, RecordedCase, VectorFile } from "./record.ts";

const UP = existsSync(
  fileURLToPath(new URL("../../../../.cache/ledger/endpoints.json", import.meta.url)),
);

const SEED = appsJson().seed;

const restartSpeculos = (): void => {
  execFileSync("bun", ["scripts/ledger/speculos.ts"], {
    cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
    stdio: "ignore",
  });
};

const ensureAlive = async (app: LedgerApp): Promise<void> => {
  if (!(await alive(app))) {
    restartSpeculos();
  }
};

const settingOf = (def: CaseDef): Pick<RecordedCase, "setting"> => {
  if (def.setting === undefined) {
    return {};
  }
  return { setting: `${def.setting.label}=${def.setting.enabled ? "on" : "off"}` };
};

const outcomeOf = (outcome: {
  result?: unknown;
  error?: RecordedCase["error"];
}): Pick<RecordedCase, "result" | "error"> => {
  if (outcome.error === undefined) {
    return { result: outcome.result };
  }
  return { error: outcome.error };
};

const runSuite = (app: LedgerApp, cases: CaseDef[]): void => {
  const collected: RecordedCase[] = [];
  const recorded = new Map((committed(app)?.cases ?? []).map((c) => [c.name, c] as const));

  describe.skipIf(!UP)(`ledger speculos ${app}`, () => {
    afterAll(() => {
      if (RECORD) {
        writeVectors(app, collected);
      }
    });

    // one `it` per case: a device or navigation failure must not lose the remaining recordings
    it.each(cases)(
      "$name",
      async (def) => {
        const outcome = await checkCase(app, def, recorded.get(def.name));
        collected.push({
          name: def.name,
          ...settingOf(def),
          call: def.call,
          commands: outcome.steps,
          screens: outcome.screens,
          ...outcomeOf(outcome),
        });
        expect(outcome.steps.length).toBeGreaterThan(0);
        await ensureAlive(app);
      },
      300_000,
    );
  });
};

runSuite("ethereum", ETHEREUM_CASES);
runSuite("solana", SOLANA_CASES);
runSuite("tron", TRON_CASES);
runSuite("bitcoin", BITCOIN_CASES);

const deviceAddress = (): `0x${string}` => mnemonicToAccount(SEED).address;

const evmTail = (uncompressed: Uint8Array): `0x${string}` =>
  `0x${hex(keccak_256(uncompressed.slice(1)).slice(12))}`;

const str = (value: unknown, name: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`case ${name}: result is not a string`);
  }
  return value;
};

const requireFile = (app: string): VectorFile => {
  const file = committed(app);
  if (file === undefined) {
    throw new Error(`missing recorded vectors for ${app}`);
  }
  return file;
};

const isAddrResult = (value: unknown): value is { address: string; publicKey: string } =>
  typeof value === "object" &&
  value !== null &&
  "address" in value &&
  typeof value.address === "string" &&
  "publicKey" in value &&
  typeof value.publicKey === "string";

const resultOf = (file: VectorFile, name: string): unknown => {
  const c = file?.cases.find((x) => x.name === name);
  if (c === undefined || c.result === undefined) {
    throw new Error(`case ${name}: no recorded result`);
  }
  return c.result;
};

const callOf = (file: VectorFile, name: string): Record<string, unknown> => {
  const c = file?.cases.find((x) => x.name === name);
  if (c === undefined) {
    throw new Error(`case ${name}: not recorded`);
  }
  return c.call;
};

const callString = (file: VectorFile, name: string, key: string): string =>
  str(callOf(file, name)[key], `${name}.${key}`);

const addrResultOf = (file: VectorFile, name: string): { address: string; publicKey: string } => {
  const value = resultOf(file, name);
  if (!isAddrResult(value)) {
    throw new Error(`case ${name}: result is not an address record`);
  }
  return value;
};

// recover the signer for a 64-byte r‖s signature by trying both parities (the client
// deliberately discards v; assemble recomputes parity later)
const recovers = async (
  name: string,
  sigHex: string,
  digest: Uint8Array,
  expected: `0x${string}`,
): Promise<void> => {
  const sig = unhex(sigHex);
  const r: `0x${string}` = `0x${hex(sig.slice(0, 32))}`;
  const s: `0x${string}` = `0x${hex(sig.slice(32, 64))}`;
  const seen = new Set<string>();
  for (const yParity of [0, 1] as const) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- two recovery attempts, sequential
    seen.add(await recoverAddress({ hash: `0x${hex(digest)}`, signature: { r, s, yParity } }));
  }
  // viem returns EIP-55 checksummed addresses — normalize so a lowercase expected tail still hits
  if (!seen.has(getAddress(expected))) {
    throw new Error(`${name}: signature does not recover to ${expected}`);
  }
};

describe("ledger speculos oracles", () => {
  it.skipIf(RECORD)(
    "recorded signatures verify against the device keys",
    async () => {
      const eth = requireFile("ethereum");
      const sol = requireFile("solana");
      const trx = requireFile("tron");
      expect(addrResultOf(eth, "address").address).toBe(deviceAddress());

      // oxlint-disable eslint/no-await-in-loop -- one oracle check at a time
      for (const name of [
        "tx-legacy",
        "tx-legacy-chunked",
        "tx-eip2930",
        "tx-eip1559",
        "tx-eip1559-calldata-blind-on",
      ]) {
        const unsigned = unhex(callString(eth, name, "unsigned"));
        await recovers(name, str(resultOf(eth, name), name), keccak_256(unsigned), deviceAddress());
      }

      await recovers(
        "personal-short",
        str(resultOf(eth, "personal-short"), "personal-short"),
        unhex(hashMessage({ raw: unhex("68656c6c6f20776f726c64") }).slice(2)),
        deviceAddress(),
      );

      await recovers(
        "eip712-mail",
        str(resultOf(eth, "eip712-mail"), "eip712-mail"),
        unhex(hashTypedData(MAIL).slice(2)),
        deviceAddress(),
      );
      await recovers(
        "eip712-complex",
        str(resultOf(eth, "eip712-complex"), "eip712-complex"),
        unhex(hashTypedData(COMPLEX).slice(2)),
        deviceAddress(),
      );

      // solana: ed25519 signatures verify over the exact message bytes
      const solPub = unhex(str(resultOf(sol, "address"), "address"));
      for (const name of ["tx-legacy", "tx-v0", "tx-unknown-blind-on", "tx-big"]) {
        const msg = unhex(callString(sol, name, "message"));
        const sig = unhex(str(resultOf(sol, name), name));
        expect(ed25519.verify(sig, msg, solPub)).toBe(true);
      }

      // tron: tx signature over sha256(raw_data); TIP-712 over keccak(0x1901‖domain‖message)
      const uncompressed = secp256k1.Point.fromHex(addrResultOf(trx, "address").publicKey).toBytes(
        false,
      );
      const expected = evmTail(uncompressed);
      for (const name of ["tx-transfer", "tx-trc20", "tx-big"]) {
        const raw = unhex(callString(trx, name, "rawData"));
        await recovers(name, str(resultOf(trx, name), name), sha256(raw), expected);
      }
      await recovers(
        "personal-short",
        str(resultOf(trx, "personal-short"), "personal-short"),
        tronMessageDigest(unhex(callString(trx, "personal-short", "message"))),
        expected,
      );
      const tip712 = new Uint8Array(2 + 64);
      tip712.set([0x19, 0x01]);
      tip712.set(unhex(callString(trx, "tip712-hash-on", "domainHash")), 2);
      tip712.set(unhex(callString(trx, "tip712-hash-on", "messageHash")), 34);
      await recovers(
        "tip712-hash-on",
        str(resultOf(trx, "tip712-hash-on"), "tip712-hash-on"),
        keccak_256(tip712),
        expected,
      );
      // oxlint-enable eslint/no-await-in-loop
    },
    300_000,
  );
});
