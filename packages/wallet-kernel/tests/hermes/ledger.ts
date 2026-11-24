/**
 * Bare-Hermes smoke for the Ledger protocol client: replays one recorded Speculos case per app
 * (Ethereum transaction, Solana transaction, Tron transaction) through the pure protocol code — no
 * globals beyond ES builtins, so this proves the module needs nothing outside the enclave
 * allow-list. Vectors are bundled JSON (Hermes has no fs).
 */

import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";

import btc from "../../../../vectors/ledger/bitcoin.json" with { type: "json" };
import eth from "../../../../vectors/ledger/ethereum.json" with { type: "json" };
import sol from "../../../../vectors/ledger/solana.json" with { type: "json" };
import trx from "../../../../vectors/ledger/tron.json" with { type: "json" };
import type { Exchange } from "../../src/modules/signers/ledger/protocol/apdu.ts";
import {
  btcMasterFingerprint,
  btcSignPsbt,
} from "../../src/modules/signers/ledger/protocol/bitcoin/index.ts";
import type { BitcoinPolicy } from "../../src/modules/signers/ledger/protocol/bitcoin/policy.ts";
import {
  ethAddress,
  ethSignTransaction,
} from "../../src/modules/signers/ledger/protocol/ethereum.ts";
import {
  solanaAddress,
  solanaSignTransaction,
} from "../../src/modules/signers/ledger/protocol/solana.ts";
import {
  tronAddress,
  tronSignTransaction,
} from "../../src/modules/signers/ledger/protocol/tron.ts";

const isPolicy = (value: unknown): value is BitcoinPolicy =>
  typeof value === "object" && value !== null && "template" in value && "key" in value;

const isYield = (
  value: unknown,
): value is { input: number; publicKey: string; signature: string } =>
  typeof value === "object" &&
  value !== null &&
  "input" in value &&
  "publicKey" in value &&
  "signature" in value;

declare function print(msg: string): void;
declare function quit(code: number): void;

type Step = { apdu: string; response: string };
type Case = {
  name: string;
  call: Record<string, unknown>;
  commands: Step[];
  result?: unknown;
  error?: { code: string };
};

const replay = (caze: Case): Exchange => {
  let i = 0;
  // oxlint-disable-next-line typescript/require-await -- the replayed device answers synchronously
  return async (apdu) => {
    const want = caze.commands[i];
    if (want === undefined || want.apdu !== bytesToHex(apdu)) {
      throw new Error(`transcript mismatch at step ${i}`);
    }
    i += 1;
    return hexToBytes(want.response);
  };
};

/** The message streamed inside the case's sign APDUs: 01 ‖ nPath ‖ path ‖ chunks. */
const solMessage = (caze: Case): Uint8Array => {
  const parts: number[] = [];
  for (const c of caze.commands) {
    const apdu = hexToBytes(c.apdu);
    if ((apdu[0] ?? -1) !== 0xe0 || apdu[1] !== 0x06) {
      continue;
    }
    const data = apdu.slice(5);
    if (((apdu[3] ?? 0) & 0x01) === 0) {
      const pathLen = data[1] ?? 0;
      parts.push(...data.slice(2 + pathLen * 4));
    } else {
      parts.push(...data);
    }
  }
  return Uint8Array.from(parts);
};

const named = (cases: Case[], name: string): Case => {
  const hit = cases.find((c) => c.name === name);
  if (hit === undefined) {
    throw new Error(`case ${name} missing`);
  }
  return hit;
};

const sig = (value: unknown): string => {
  if (typeof value !== "string" || value.length !== 128) {
    throw new Error("unexpected signature");
  }
  return value;
};

const callHex = (caze: Case, key: string): Uint8Array => {
  const value = caze.call[key];
  if (typeof value !== "string") {
    throw new TypeError(`case ${caze.name}: missing call.${key}`);
  }
  return hexToBytes(value);
};

const main = async (): Promise<void> => {
  const ETH_PATH = [0x80_00_00_2c, 0x80_00_00_3c, 0x80_00_00_00, 0, 0];
  const SOL_PATH = [0x80_00_00_2c, 0x80_00_01_f5, 0x80_00_00_00, 0x80_00_00_00];
  const TRX_PATH = [0x80_00_00_2c, 0x80_00_00_c3, 0x80_00_00_00, 0, 0];

  // ethereum: address + a legacy transaction, replayed byte-for-byte
  {
    const cases = eth.cases as Case[];
    const ex = replay(named(cases, "address"));
    await ethAddress(ex, ETH_PATH, false);
    const tx = named(cases, "tx-legacy");
    const unsigned = callHex(tx, "unsigned");
    const out = await ethSignTransaction(replay(tx), ETH_PATH, unsigned);
    if (bytesToHex(out) !== sig(tx.result)) {
      throw new Error("ethereum signature mismatch");
    }
  }
  // solana: the recorded run asked for the pubkey first, then signed — replay does the same
  {
    const cases = sol.cases as Case[];
    const tx = named(cases, "tx-legacy");
    const ex = replay(tx);
    await solanaAddress(ex, SOL_PATH, false);
    const out = await solanaSignTransaction(ex, SOL_PATH, solMessage(tx));
    if (bytesToHex(out) !== sig(tx.result)) {
      throw new Error("solana signature mismatch");
    }
  }
  // tron: address + transfer
  {
    const cases = trx.cases as Case[];
    await tronAddress(replay(named(cases, "address")), TRX_PATH, false);
    const tx = named(cases, "tx-transfer");
    const out = await tronSignTransaction(replay(tx), TRX_PATH, callHex(tx, "rawData"));
    if (bytesToHex(out) !== sig(tx.result)) {
      throw new Error("tron signature mismatch");
    }
  }
  // bitcoin: fingerprint + a P2WPKH sign-psbt — exercises the whole interactive interpreter
  // (preimages, merkle proofs, yields) inside Hermes
  {
    const tx = named(btc.cases, "sign-psbt-wpkh");
    const ex = replay(tx);
    await btcMasterFingerprint(ex);
    if (!isPolicy(tx.call["policy"])) {
      throw new Error("bitcoin policy missing");
    }
    const out = await btcSignPsbt(ex, callHex(tx, "psbt"), tx.call["policy"]);
    const want = tx.result;
    if (
      !Array.isArray(want) ||
      !want.every(isYield) ||
      out.length !== want.length ||
      out.some(
        (y, i) =>
          y.input !== want[i]?.input ||
          bytesToHex(y.publicKey) !== want[i]?.publicKey ||
          bytesToHex(y.signature) !== want[i]?.signature,
      )
    ) {
      throw new Error("bitcoin yields mismatch");
    }
  }

  print("HERMES_LEDGER_OK");
};

// oxlint-disable-next-line unicorn/prefer-top-level-await -- top-level await cannot appear in the iife classic-script bundle Hermes runs
void (async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    print(`HERMES_LEDGER_FAIL ${String(error)}`);
    quit(1);
  }
})();
