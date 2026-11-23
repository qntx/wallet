import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
/**
 * Bare-Hermes smoke for the OneKey protocol client: bundled to a single classic script and run on
 * the `hermes` CLI. No global shims at all — `print`/`quit` are the only host functions — so this
 * proves the protocol module needs nothing beyond the enclave global allow-list. Transcripts and
 * plans are bundled JSON, not file reads (Hermes has no fs).
 *
 * The PSBT, Solana-self and TRON-self inputs and the Bitcoin sighashes below are derived offline
 * from the committed fixtures (tests/onekey-emulator/bitcoin-fixtures.ts and the vectors' plan
 * keys); each was checked here to verify the recorded device signatures before embedding.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

import type { EvmTransaction } from "@qntx/wallet-chains";

import plansJson from "../../../../vectors/chains/signing-plans.json" with { type: "json" };
import classicJson from "../../../../vectors/onekey/emulator-classic1s.json" with { type: "json" };
import proJson from "../../../../vectors/onekey/emulator-pro.json" with { type: "json" };
import {
  bitcoinPrepare,
  initialize,
  publicNode,
  signBitcoinTransaction,
  signEvmTransaction,
  signSolanaTransaction,
  signTronTransaction,
  signTypedData,
  solanaPublicKey,
} from "../../src/modules/onekey/protocol/index.ts";
import type { Exchange } from "../../src/modules/onekey/protocol/index.ts";

declare function print(msg: string): void;
declare function quit(code: number): void;

const H = 0x80_00_00_00;
const hex = hexToBytes;
let checks = 0;

const check = (ok: boolean, label: string): void => {
  checks += 1;
  if (!ok) {
    throw new Error(`check failed: ${label}`);
  }
};

const req = <T>(value: T, label: string): NonNullable<T> => {
  if (value === undefined || value === null) {
    throw new Error(`missing: ${label}`);
  }
  return value;
};

// Plans arrive as bundled JSON — keep the inferred literal types and narrow per field.
type PlanCase = (typeof plansJson.cases)[number];
type PlanTask = NonNullable<NonNullable<PlanCase["stages"]>[number]>[number];
const planCase = (name: string): PlanCase =>
  req(
    plansJson.cases.find((c) => c.name === name),
    name,
  );
const isEvmTransaction = (value: unknown): value is EvmTransaction =>
  typeof value === "object" && value !== null && "type" in value && "chainId" in value;
const taskDigest = (task: PlanTask, label: string): string =>
  "digest" in task && typeof task.digest === "string" ? task.digest : req(undefined, label);

type TranscriptSession = {
  name: string;
  exchanges: ReadonlyArray<{ request: string; response: string }>;
};
type Transcript = { sessions: ReadonlyArray<TranscriptSession> };

const sessionOf = (transcript: Transcript, name: string): TranscriptSession =>
  req(
    transcript.sessions.find((s) => s.name === name),
    `session ${name}`,
  );

/** Replay a recorded session: every request must equal the recorded one; returns a drain check. */
const replay = (session: TranscriptSession): { exchange: Exchange; drain: () => void } => {
  let at = 0;
  return {
    exchange: async (data) => {
      // Yield so callers observe exchanges asynchronously like a real transport.
      await Promise.resolve();
      const step = session.exchanges[at];
      at += 1;
      if (step === undefined) {
        throw new Error(`replay ${session.name} ran past the recorded session`);
      }
      if (bytesToHex(data) !== step.request) {
        throw new Error(`replay ${session.name} request ${at} diverged`);
      }
      return hex(step.response);
    },
    drain: () => {
      if (at !== session.exchanges.length) {
        throw new Error(`replay ${session.name} left ${session.exchanges.length - at} exchanges`);
      }
    },
  };
};

const ecdsaOk = (digest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean => {
  if (signature.length !== 64) {
    return false;
  }
  try {
    return secp256k1.verify(signature, digest, publicKey, { prehash: false });
  } catch {
    return false;
  }
};

const SOL_PATH = [H + 44, H + 501, H, H];
const TRON_PATH = [H + 44, H + 195, H, 0, 0];

/** The test mnemonic's m/84'/0'/0' account — publicNode's expected output. */
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * The mixed-template fixture PSBT (buildMixedPsbt of bitcoin-psbt-every-template) — three
 * legacy/P2SH/P2WPKH inputs with full prev txs plus a synthesized taproot input. DIGESTS are the
 * four independent sighashes over this exact PSBT (bitcoinjs oracle); the taproot one differs from
 * the plan's because the synthesized prev txid feeds every input's hashPrevouts.
 */
const MIXED_PSBT =
  "70736274ff0100ec0200000004bbc190071272f3fd9bb60c3c4e4bc6d2b7b487fdf8a7835dbae0071ae681dfb30000000000fdffffffbacffca5a1b88bb5ec173d179e0d4ce5176286c62eac04af4f75e22340d593830000000000fdffffffd526b9d93a9d2eb43121460bbf062227a6c4645a4520c54c4019e4ca85efcabd0000000000fdffffff9f678f4278af421dece556cfea57bc42ee2fba3b47ca16614bb8de4014d2c2a30000000000fdffffff0250c3000000000000160014a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a050c3000000000000160014a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a10000000000010055020000000101010101010101010101010101010101010101010101010101010101010101010000000000fdffffff01a0860100000000001976a914d986ed01b7a22225a70edbf2ba7cfb63a15cb3aa88ac0000000000010053020000000102020202020202020202020202020202020202020202020202020202020202020000000000fdffffff01888a01000000000017a9143fb6e95812e57bb4691f9a4a628862a61a4f769b870000000000010052020000000103030303030303030303030303030303030303030303030303030303030303030000000000fdffffff01708e010000000000160014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2000000000001005e02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00fdffffff015892010000000000225120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c00000000011720cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115000000";
const BTC_DIGESTS = [
  "7c13d532fa6bb69cee48faa8bc96be81498a1791d7a0e1ec6205a57cd5d50637",
  "3bb861ccaeaf7ca96eda2bcd9a5901be58bb14ccf7dbd6d1963c8fb19211e95d",
  "7c413cd06ff746752520e3cd5eb54d2b552ddd15981a1e6580bb28a55712e659",
  "b33a713ce0c7cc5db0905fac1899dcaf3b9ff95b30cd856fd54c85c6d4628f42",
];

/** Solana-transaction-legacy-single-signer with the fee payer replaced by the device key. */
const SOL_SELF =
  "01000103f036276246a75b9de3349ed42b15e232f6518fc20f5fcd4f1d64e81f9bd258f702020202020202020202020202020202020202020202020202020202020202020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001020200010c02000000e803000000000000";
const SOL_KEY = "f036276246a75b9de3349ed42b15e232f6518fc20f5fcd4f1d64e81f9bd258f7";

/** Tron-transaction-trx-transfer with the owner rewritten to the device's TRON address. */
const TRON_SELF =
  "0a026e5022081a2b3c4d5e6f789040e0a4eeb6b7335a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541c8599111f29c1e1e061265b4af93ea1f274ad78a1215415cd0fb0ab3ce40f3051414c604b27756e69e43db18c0843d7080d0eab6b733";
const TRON_KEY = "03ff21f8e64d3a3c0198edfbb7afdc79be959432e92e2f8a1984bb436a414b8edc";

const BTC_SCRIPT_TYPES: Record<number, number> = { 44: 0, 49: 4, 84: 3, 86: 5 };
const scriptTypeFor = (path: ReadonlyArray<number>): number =>
  req(BTC_SCRIPT_TYPES[(path[0] ?? 0) - H], "script type");

const run = async (label: string, transcript: Transcript): Promise<void> => {
  const session = (name: string) => replay(sessionOf(transcript, name));

  // initialize
  const init = session("initialized");
  const deviceInfo = await initialize(init.exchange);
  init.drain();
  check(deviceInfo.model === label && deviceInfo.firmware.length === 3, `${label} initialize`);

  // publicNode m/84'/0'/0' against an independent BIP-32 derivation
  {
    const s = session("node-bip84");
    const node = await publicNode(s.exchange, [H + 84, H, H], { scriptType: 3 });
    s.drain();
    const oracle = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC)).derive("m/84'/0'/0'");
    check(
      bytesToHex(node.publicKey) === bytesToHex(req(oracle.publicKey, "oracle pubkey")) &&
        bytesToHex(node.chainCode) === bytesToHex(req(oracle.chainCode, "oracle chainCode")),
      `${label} node-bip84`,
    );
  }

  // solanaPublicKey returns the SLIP-10 ed25519 key recorded in the plan
  {
    const s = session("sol-account0");
    const key = await solanaPublicKey(s.exchange, SOL_PATH, false);
    s.drain();
    check(bytesToHex(key) === SOL_KEY, `${label} sol-account0`);
  }

  // one EVM legacy transaction
  {
    const plan = planCase("evm-legacy");
    const tx = "tx" in plan.request ? plan.request.tx : undefined;
    if (!isEvmTransaction(tx)) {
      throw new Error("plan carries no evm-legacy transaction");
    }
    const s = session("evm-legacy");
    const result = await signEvmTransaction(
      s.exchange,
      deviceInfo,
      req(plan.key, "evm-legacy key").path,
      tx,
    );
    s.drain();
    check(
      ecdsaOk(
        hex(taskDigest(req(plan.stages[0]?.[0], "evm-legacy task"), "evm-legacy digest")),
        result.signature,
        hex(req(plan.key, "evm-legacy key").publicKey),
      ),
      `${label} evm-legacy`,
    );
  }

  // one EVM typed-data stream exchange
  {
    const plan = planCase("evm-typed-data-mail");
    const s = session("evm-typed-data-mail");
    const sig = await signTypedData(
      s.exchange,
      deviceInfo,
      req(plan.key, "typed-data key").path,
      req("typedData" in plan.request ? plan.request.typedData : undefined, "typedData"),
    );
    s.drain();
    check(
      ecdsaOk(
        hex(taskDigest(req(plan.stages[0]?.[0], "typed-data task"), "typed-data digest")),
        sig,
        hex(req(plan.key, "typed-data key").publicKey),
      ),
      `${label} evm-typed-data-mail`,
    );
  }

  // one Solana transaction (self-owner rebuild of the legacy plan message)
  {
    const s = session("solana-transaction-legacy-self");
    const message = hex(SOL_SELF);
    const sig = await signSolanaTransaction(s.exchange, SOL_PATH, message, hex(SOL_KEY));
    s.drain();
    check(ed25519.verify(sig, message, hex(SOL_KEY)), `${label} solana legacy tx`);
  }

  // one TRON transaction (self-owner rebuild; digest = sha256(rawData))
  {
    const s = session("tron-transfer-self");
    const rawData = hex(TRON_SELF);
    const sig = await signTronTransaction(s.exchange, TRON_PATH, rawData, hex(TRON_KEY));
    s.drain();
    check(ecdsaOk(sha256(rawData), sig, hex(TRON_KEY)), `${label} tron transfer`);
  }

  // the BIP-84 + taproot mixed PSBT: four signatures over independently computed sighashes
  {
    const plan = planCase("bitcoin-psbt-every-template");
    const tasks = req(plan.stages[0], "bitcoin tasks");
    const sign = tasks.map((task, index) => ({
      index,
      path: req(task.path, "task path"),
      scriptType: scriptTypeFor(req(task.path, "task path")),
    }));
    const prepared = bitcoinPrepare(hex(MIXED_PSBT), sign, "mainnet", []);
    const s = session("bitcoin-psbt-mixed-prevtxs");
    const sigs = await signBitcoinTransaction(s.exchange, deviceInfo, prepared);
    s.drain();
    check(sigs.length === 4, `${label} bitcoin sig count`);
    for (let i = 0; i < 4; i += 1) {
      const sig = req(sigs[i], `bitcoin sig ${i}`);
      const task = req(tasks[i], `bitcoin task ${i}`);
      const ok =
        sign[i]?.scriptType === 5
          ? schnorr.verify(
              sig,
              hex(req(BTC_DIGESTS[i], "digest")),
              hex(req(task.publicKey, "task key")),
            )
          : ecdsaOk(hex(req(BTC_DIGESTS[i], "digest")), sig, hex(req(task.publicKey, "task key")));
      check(ok, `${label} bitcoin sig ${i}`);
    }
  }
};

const main = async (): Promise<void> => {
  await run("classic1s", classicJson);
  await run("pro", proJson);
  print(`HERMES_ONEKEY_OK ${checks}`);
};

// oxlint-disable-next-line unicorn/prefer-top-level-await -- the bundle is an es2017 IIFE
void (async (): Promise<void> => {
  try {
    await main();
    quit(0);
  } catch (error) {
    print(`HERMES_ONEKEY_FAIL ${String(error)}`);
    quit(1);
  }
})();
