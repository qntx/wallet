// oxlint-disable eslint/no-await-in-loop, vitest/no-conditional-in-test -- the step driver is sequential and conditional by design
/**
 * Layer-4 card signing against the real qntx applet in jcardsim (`QNTX_CARD_SIM`, skipped without
 * it). Every `vectors/chains/signing-plans.json` case signs through `card.begin({kind:"sign"})` on
 * a SimCard holding the vector mnemonic; the planned tasks are compared field-for-field against the
 * vector stages and each artefact is verified by the family's independent oracle (viem-style
 * recovery via `recoverEvmSigner`, tron address recovery, `verifySolanaSignature`, the scure-based
 * `verifyBitcoinPsbtSignatures`, and the message verifiers). The 50-input PSBT, the EIP-7702 budget
 * split, tag-loss resume and the BIP-340 backend variants run against the real applet too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { address, getAddressEncoder } from "@solana/kit";
import { parseTransaction } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Assembled, SignTask } from "@qntx/wallet-chains";
import {
  planBitcoinMessage,
  planBitcoinPsbt,
  verifyBitcoinMessage,
  verifyBitcoinPsbtSignatures,
  verifyLegacyBitcoinMessage,
} from "@qntx/wallet-chains/bitcoin";
import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import {
  evmAddressFromPublicKey,
  normalizeEvm,
  planEvm,
  recoverEvmSigner,
} from "@qntx/wallet-chains/evm";
import { planSolana, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { planTron, tronAddressFromPublicKey, tronMessageDigest } from "@qntx/wallet-chains/tron";
import type { WalletInfo } from "@qntx/wallet/types";

import { signBip340Task } from "../src/modules/card/backend.ts";
import { accessHash } from "../src/modules/card/protocol/access.ts";
import { cmd } from "../src/modules/card/protocol/commands.ts";
import type { Inner } from "../src/modules/card/protocol/commands.ts";
import { decode } from "../src/modules/card/protocol/decode.ts";
import type { CardStatus } from "../src/modules/card/protocol/decode.ts";
import { shortId } from "../src/modules/card/protocol/identity.ts";
import { openRequest, openResponse, SELECT_APDU } from "../src/modules/card/protocol/session.ts";
import { bip340OutputX, taprootTweak } from "../src/modules/card/protocol/signatures.ts";
import { result } from "../src/modules/card/protocol/status.ts";
import type { TapSession, VerifyOutcome } from "../src/modules/card/tap.ts";
import { seedKeys } from "../src/modules/chains/keys.ts";
import type { ChainPlan } from "../src/modules/chains/run.ts";
import { assembleChain, taskSignerFor } from "../src/modules/chains/run.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { testSecureInput } from "./card/input.ts";
import { testCardReader } from "./card/reader.ts";
import { CA1_ANCHOR, SIM_LAUNCHER, startSimulator } from "./card/sim.ts";
import type { SimCard, Simulator } from "./card/sim.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";
import { quickArgon2id, subtlePbkdf2 } from "./helpers.ts";

const HARDENED = 0x80000000;
const CREDENTIAL_ID = utf8ToBytes("credential-1");
const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";
const code = (): Uint8Array => utf8ToBytes("sim-sign-1");
const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(32).fill(1),
});

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/signing-plans.json"), "utf8"),
) as {
  readonly mnemonic: string;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly key?: { readonly path: number[]; readonly publicKey: string };
    readonly request: Record<string, unknown> & { readonly kind: string };
    readonly stages: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
    readonly artefact: unknown;
  }>;
};

const fiat24 = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/fiat24.json"), "utf8"),
) as {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly request: {
      readonly kind: string;
      readonly network?: string;
      readonly tokenId?: string;
      readonly deadline?: number;
    };
    readonly session?: { readonly signature: string };
  }>;
};

const polymarket = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/polymarket.json"), "utf8"),
) as {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly network: string;
    readonly typedData: unknown;
  }>;
};

const SEED = await seedFromEntropy(entropyFromMnemonic(vectors.mnemonic), "", subtlePbkdf2);
const zeroRandom = (): Uint8Array => new Uint8Array(32);

const ok = (res: KernelResponse): Record<string, unknown> => {
  if (!("ok" in res)) {
    throw new Error(`call failed: ${JSON.stringify(res.err)}`);
  }
  return res.ok as Record<string, unknown>;
};

const field = (res: Record<string, unknown>, key: string): unknown => {
  const value = res[key];
  if (value === undefined) {
    throw new Error(`missing ${key}`);
  }
  return value;
};
const strField = (res: Record<string, unknown>, key: string): string => String(field(res, key));

type Step = { kind: string; [k: string]: unknown };

type Rig = {
  h: Harness;
  session: string;
  /** Set by `vectorWallet` — the import call opens the session. */
  reader: ReturnType<typeof testCardReader>;
  input: ReturnType<typeof testSecureInput>;
};

const rig = async (planMs?: number, start?: number): Promise<Rig> => {
  const reader = testCardReader();
  const input = testSecureInput();
  const h = createHarness({
    ...(start === undefined ? {} : { start }),
    card: {
      reader: reader.reader,
      secureInput: input.secureInput,
      anchors: [CA1_ANCHOR],
      ...(planMs === undefined ? {} : { planMs }),
    },
  });
  await h.settle();
  return { h, session: "", reader, input };
};

type Driven = { readonly result: Record<string, unknown>; readonly taps: number };

/** Drives `card.begin` to `done`, counting tap steps; codes and cards queue in order. */
const drive = async (
  r: Rig,
  op: unknown,
  actions: { codes?: Uint8Array[]; cards: SimCard[] },
  verify?: unknown,
): Promise<Driven> => {
  const first = ok(
    await r.h.call("card.begin", { op, ...(verify === undefined ? {} : { verify }) }, r.session),
  ) as { opId: string; step: Step };
  let { step } = first;
  let taps = 0;
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    if (guard > 80) {
      throw new Error(`operation did not finish: ${JSON.stringify(step)}`);
    }
    if (step.kind === "input") {
      if (step["purpose"] === "short-id") {
        const [upcoming] = actions.cards;
        if (upcoming === undefined) {
          throw new Error("short-id asked with no card queued");
        }
        r.input.push(utf8ToBytes(shortId(upcoming.identity)));
      } else {
        const code = actions.codes?.shift();
        if (code === undefined) {
          throw new Error(`unexpected input step ${JSON.stringify(step)}`);
        }
        r.input.push(code);
      }
    } else if (step.kind === "tap") {
      taps += 1;
      const [next] = actions.cards.splice(0, 1);
      if (next === undefined) {
        throw new Error(`unexpected tap step ${JSON.stringify(step)}`);
      }
      r.reader.present(next);
    }
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
  }
  return { result: step["result"] as Record<string, unknown>, taps };
};

const driveErr = async (
  r: Rig,
  op: unknown,
  actions: { codes?: Uint8Array[]; cards: SimCard[] },
  verify?: unknown,
): Promise<string> => {
  const first = await r.h.call(
    "card.begin",
    { op, ...(verify === undefined ? {} : { verify }) },
    r.session,
  );
  if ("err" in first) {
    return first.err.code;
  }
  const { opId, step: firstStep } = first.ok as { opId: string; step: Step };
  let step = firstStep;
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    if (guard > 80) {
      return "driver-guard";
    }
    if (step.kind === "input") {
      const code = actions.codes?.shift();
      if (code === undefined) {
        return "unexpected-input";
      }
      r.input.push(code);
    } else if (step.kind === "tap") {
      const [next] = actions.cards.splice(0, 1);
      if (next === undefined) {
        return "unexpected-tap";
      }
      r.reader.present(next);
    }
    const next = await r.h.call("card.step", { opId }, r.session);
    if ("err" in next) {
      return next.err.code;
    }
    step = next.ok as Step;
  }
  return "no-error";
};

const taps = (card: SimCard, n = 8): SimCard[] => Array.from({ length: n }, () => card);

/** Imports the vector mnemonic into the rig's vault and `create`s a k=1 card wallet on `card`. */
const vectorWallet = async (
  r: Rig,
  simulator: Simulator,
  groups = 1,
): Promise<{ walletId: string; card: SimCard }> => {
  const imported = ok(
    await r.h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(vectors.mnemonic),
      factor: verifyPasskey(),
    }),
  );
  r.session = strField(imported, "session");
  const sourceId = strField(field(imported, "wallet") as Record<string, unknown>, "walletId");
  const card = await simulator.newCard();
  const { result: created } = await drive(
    r,
    { kind: "create", cards: 1, source: { kind: "wallet", walletId: sourceId }, groups },
    { codes: [code(), code()], cards: taps(card) },
    verifyPasskey(),
  );
  const walletId = strField(created, "walletId");
  expect(walletId).toBe(sourceId);
  return { walletId, card };
};

const BTC_TEMPLATES: Record<number, BitcoinAccountTemplate> = {
  44: "btc.bip44",
  49: "btc.bip49",
  84: "btc.bip84",
  86: "btc.bip86",
};

const BYTE_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "evm.personal-message": ["message"],
  "tron.transaction": ["rawData"],
  "tron.message": ["message"],
  "solana.transaction": ["message"],
  "solana.message": ["message"],
  "bitcoin.psbt": ["psbt"],
};

const ANVIL_TRON = hexToBytes("41f39fd6e51aad88f6f4ce6ab8827279cfffb92266");

/**
 * The wire vector requests embed the anvil account as their embedded signer (the vectors exercise
 * the plan/task layer where the account is declared separately). The kernel's request decoders
 * correctly refuse a transaction whose embedded signer is not the account's key, so these rewrites
 * re-point the embedded signer at the card wallet's key — the task digests change accordingly and
 * `stagesMatch` still covers the vector stages field-for-field.
 */
const tronWithSigner = (rawData: Uint8Array, owner20: Uint8Array): Uint8Array => {
  const out = new Uint8Array(rawData);
  const replacement = new Uint8Array([0x41, ...owner20]);
  for (let i = 0; i + 21 <= out.length; i += 1) {
    if (out.subarray(i, i + 21).every((b, j) => b === ANVIL_TRON[j])) {
      out.set(replacement, i);
    }
  }
  return out;
};

/** Re-points a solana message's first (only) required signer at `key`. */
const solanaWithSigner = (message: Uint8Array, key: Uint8Array): Uint8Array => {
  const out = new Uint8Array(message);
  // v1 (0x81): version ‖ header(3) ‖ configMask(4) ‖ lifetime(32) ‖ counts(2) ‖ accounts.
  // v0 (0x80) and legacy: (version) ‖ header(3) ‖ count ‖ accounts.
  const accountsAt = message[0] === 0x81 ? 41 : ((message[0] ?? 0) >= 0x80 ? 1 : 0) + 3;
  out.set(key, accountsAt + 1);
  return out;
};

/** Adds `witnessUtxo` where the vector PSBT carries only `nonWitnessUtxo` (the kernel requires it). */
const psbtWithWitness = (psbt: Uint8Array): Uint8Array => {
  const tx = Transaction.fromPSBT(psbt);
  for (let i = 0; i < tx.inputsLength; i += 1) {
    const input = tx.getInput(i);
    if (input.witnessUtxo === undefined && input.nonWitnessUtxo !== undefined) {
      const prev = (
        input.nonWitnessUtxo as { outputs: ReadonlyArray<{ script?: Uint8Array; amount?: bigint }> }
      ).outputs[input.index ?? 0];
      if (prev?.script !== undefined && prev.amount !== undefined) {
        tx.updateInput(i, { witnessUtxo: { script: prev.script, amount: prev.amount } });
      }
    }
  }
  return tx.toPSBT(0);
};

/** The wire request for a vector case aimed at the card wallet. */
const requestFor = (
  c: (typeof vectors.cases)[number],
  walletId: string,
): Record<string, unknown> => {
  const request: Record<string, unknown> = { ...c.request };
  for (const key of BYTE_FIELDS[request["kind"] as string] ?? []) {
    const value = request[key];
    if (typeof value === "string") {
      request[key] = hexToBytes(value);
    }
  }
  if (request["kind"] === "bitcoin.psbt") {
    const inputs = request["inputs"] as ReadonlyArray<{
      readonly index: number;
      readonly path: ReadonlyArray<number>;
      readonly publicKey: string;
    }>;
    request["account"] = { kind: "hd", walletId, groupIndex: 0 };
    request["sign"] = inputs.map(({ index, path }) => ({
      index,
      template: BTC_TEMPLATES[(path[0] ?? 0) & ~HARDENED],
    }));
    delete request["inputs"];
    request["psbt"] = psbtWithWitness(request["psbt"] as Uint8Array);
    return request;
  }
  const purpose = (c.key?.path[0] ?? 0) & ~HARDENED;
  const template = (request["kind"] as string).startsWith("evm.")
    ? "evm.bip44"
    : (request["kind"] as string).startsWith("tron.")
      ? "tron.bip44"
      : (request["kind"] as string).startsWith("solana.")
        ? "solana.bip44-change"
        : BTC_TEMPLATES[purpose];
  request["account"] = { kind: "hd", walletId, groupIndex: 0, template };
  if (request["kind"] === "bitcoin.message") {
    request["change"] = 0;
    request["index"] = 0;
  }
  const key = c.key?.publicKey;
  if (request["kind"] === "tron.transaction" && key !== undefined) {
    request["rawData"] = tronWithSigner(
      request["rawData"] as Uint8Array,
      hexToBytes(evmAddressFromPublicKey(hexToBytes(key)).slice(2)),
    );
  }
  if (request["kind"] === "solana.transaction" && key !== undefined) {
    request["message"] = solanaWithSigner(request["message"] as Uint8Array, hexToBytes(key));
  }
  return request;
};

/** The chain plan for a vector case — the same data the sign op's prepare produces. */
const planFor = (c: (typeof vectors.cases)[number]): ChainPlan => {
  const request = { ...c.request };
  for (const key of BYTE_FIELDS[c.request.kind] ?? []) {
    const value = request[key];
    if (typeof value === "string") {
      request[key] = hexToBytes(value);
    }
  }
  if (c.request.kind === "bitcoin.psbt") {
    const inputs = (
      c.request["inputs"] as ReadonlyArray<{
        readonly index: number;
        readonly path: ReadonlyArray<number>;
        readonly publicKey: string;
      }>
    ).map(({ index, path, publicKey }) => ({
      index,
      key: { path, publicKey: hexToBytes(publicKey) },
    }));
    return planBitcoinPsbt(request["psbt"] as Uint8Array, inputs);
  }
  const keyVector = c.key;
  if (keyVector === undefined) {
    throw new Error(`${c.name}: no key`);
  }
  const key = { path: keyVector.path, publicKey: hexToBytes(keyVector.publicKey) };
  if (c.request.kind === "bitcoin.message") {
    return planBitcoinMessage(request as never, key);
  }
  if (c.request.kind.startsWith("evm.")) {
    return planEvm(request as never, key);
  }
  if (c.request.kind.startsWith("tron.")) {
    return planTron(request as never, key);
  }
  return planSolana(request as never, key);
};

const taskShape = (task: SignTask): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    scheme: task.scheme,
    path: task.path,
    publicKey: bytesToHex(task.publicKey),
  };
  if ("digest" in task) {
    out["digest"] = bytesToHex(task.digest);
  }
  if ("message" in task) {
    out["message"] = bytesToHex(task.message);
  }
  if ("tweak" in task) {
    out["tweak"] = bytesToHex(task.tweak);
  }
  return out;
};

/**
 * Signs the vector case's plan through the seed backend stage by stage, asserting the plan's tasks
 * equal each vector stage's tasks — the same commands the card receives.
 */
const stagesMatch = async (c: (typeof vectors.cases)[number]): Promise<void> => {
  const keys = seedKeys(SEED, zeroRandom);
  try {
    let plan = planFor(c);
    for (const [index, stage] of c.stages.entries()) {
      expect(plan.tasks.map(taskShape), `${c.name} stage ${index} tasks`).toStrictEqual(
        stage.map((t) => ({ ...t, path: [...(t["path"] as number[])] })),
      );
      const signatures: Uint8Array[] = [];
      const signer = keys.backend(taskSignerFor(plan));
      for (const task of plan.tasks) {
        signatures.push(await signer.sign(task));
      }
      const assembled: Assembled<unknown, ChainPlan> = assembleChain(plan, signatures);
      if (assembled.kind === "signed") {
        expect(index).toBe(c.stages.length - 1);
        return;
      }
      ({ plan } = assembled);
    }
    throw new Error(`${c.name}: plan ended before all stages ran`);
  } finally {
    keys.wipe();
  }
};

const evmSignerOf = (c: (typeof vectors.cases)[number]): string => {
  const { key } = c;
  if (key === undefined) {
    throw new Error(`${c.name}: no key`);
  }
  return evmAddressFromPublicKey(hexToBytes(key.publicKey)).toLowerCase();
};

/** EIP-2: a card-signed artefact never carries a high s. */
const expectLowS = (s: bigint | Uint8Array): void => {
  expect(typeof s === "bigint" ? s : bytesToNumberBE(s)).toBeLessThanOrEqual(
    secp256k1.Point.Fn.ORDER / 2n,
  );
};

/** Independent verification of the artefact `card.begin` returned for the vector case. */
const verifyArtefact = async (
  r: Rig,
  c: (typeof vectors.cases)[number],
  request: Record<string, unknown>,
  result: Record<string, unknown>,
  walletId: string,
): Promise<void> => {
  const { kind } = c.request;
  if (kind.startsWith("evm.")) {
    const normalized = normalizeEvm(request);
    const recovered = recoverEvmSigner(normalized, result);
    expect(recovered).toBe(evmSignerOf(c));
    const signature = result["signature"] as Uint8Array | undefined;
    if (signature === undefined) {
      const parsed = parseTransaction(
        `0x${bytesToHex(field(result, "signedTransaction") as Uint8Array)}`,
      );
      expectLowS(BigInt(parsed.s ?? "0x0"));
      for (const auth of parsed.authorizationList ?? []) {
        expectLowS(BigInt(auth.s));
      }
    } else {
      expectLowS(signature.subarray(32, 64));
    }
    return;
  }
  if (kind.startsWith("tron.")) {
    // Recover the signer over the signed digest and compare to the key's tron address.
    const signature = field(result, "signature") as Uint8Array;
    const task = planFor(c).tasks[0] as { digest?: Uint8Array };
    const digest =
      kind === "tron.transaction"
        ? sha256(request["rawData"] as Uint8Array)
        : (task.digest ?? tronMessageDigest(hexToBytes(c.request["message"] as string)));
    const v = signature[64] ?? 0;
    const recovered = new secp256k1.Signature(
      bytesToNumberBE(signature.subarray(0, 32)),
      bytesToNumberBE(signature.subarray(32, 64)),
      v >= 27 ? v - 27 : v,
    ).recoverPublicKey(digest);
    expect(tronAddressFromPublicKey(recovered.toBytes(false))).toBe(
      tronAddressFromPublicKey(hexToBytes(c.key?.publicKey ?? "")),
    );
    expectLowS(signature.subarray(32, 64));
    return;
  }
  if (kind.startsWith("solana.")) {
    const signature = field(result, "signature") as Uint8Array;
    const accounts = ok(
      await r.h.call(
        "wallet.accounts",
        {
          walletId,
          groupIndex: 0,
          template: "solana.bip44-change",
          network: c.request["network"],
        },
        r.session,
      ),
    );
    const address = strField(accounts, "address");
    expect(verifySolanaSignature(request["message"] as Uint8Array, signature, address)).toBe(true);
    return;
  }
  if (kind === "bitcoin.psbt") {
    const signedPsbt = field(result, "signedPsbt") as Uint8Array;
    const inputs = c.request["inputs"] as ReadonlyArray<{
      readonly index: number;
      readonly path: ReadonlyArray<number>;
      readonly publicKey: string;
    }>;
    for (const { index, path } of inputs) {
      const purpose = (path[0] ?? 0) & ~HARDENED;
      const template = BTC_TEMPLATES[purpose] ?? "btc.bip84";
      const xpub = HDKey.fromMasterSeed(SEED).derive(`m/${purpose}'/0'/0'`).publicExtendedKey;
      expect(
        verifyBitcoinPsbtSignatures(signedPsbt, [index], xpub, template as never, BTC_MAINNET),
      ).toBe(true);
    }
    const signed = Transaction.fromPSBT(signedPsbt);
    for (const { index } of inputs) {
      for (const [, der] of signed.getInput(index).partialSig ?? []) {
        // Each partial signature is DER plus a sighash-type byte.
        expectLowS(secp256k1.Signature.fromBytes(der.subarray(0, -1), "der").s);
      }
    }
    return;
  }
  if (kind === "bitcoin.message") {
    const signature = field(result, "signature");
    const base64 =
      signature instanceof Uint8Array
        ? Buffer.from(signature).toString("base64")
        : String(signature);
    const address = c.request["address"] as string;
    const message = c.request["message"] as string;
    const format = c.request["format"] as string | undefined;
    if (format === "bip322-simple") {
      expect(verifyBitcoinMessage(address, message, base64, BTC_MAINNET)).toBe(true);
    } else {
      expect(verifyLegacyBitcoinMessage(address, message, base64, BTC_MAINNET)).toBe(true);
    }
    return;
  }
  throw new Error(`no verifier for ${kind}`);
};

describe.skipIf(SIM_LAUNCHER === undefined)("card sign (simulator)", () => {
  let simulator: Simulator;

  const stats: Array<{ name: string; taps: number; transmits: number }> = [];

  it("starts the pinned simulator", async () => {
    simulator = await startSimulator(SIM_LAUNCHER ?? "");
    expect(simulator).toBeDefined();
  });

  it.each(vectors.cases)("$name: the card signs the vector artefact", async (c) => {
    const r = await rig();
    const { walletId, card } = await vectorWallet(r, simulator);
    const request = requestFor(c, walletId);
    await stagesMatch(c);
    r.reader.sessionLengths.length = 0;
    const { result, taps: n } = await drive(
      r,
      { kind: "sign", request },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(strField(result, "kind")).toBe("sign");
    const sign = field(result, "result") as Record<string, unknown>;
    await verifyArtefact(r, c, request, sign, walletId);
    const transmits = r.reader.sessionLengths.reduce((a, b) => a + b, 0);
    stats.push({ name: c.name, taps: n, transmits });
  });

  it("fiat24-session signs inside its deadline", async () => {
    const c = fiat24.cases.find(
      (x) => x.request.kind === "evm.fiat24-session" && x.session !== undefined,
    );
    if (c === undefined) {
      throw new Error("fiat24 vector missing");
    }
    const r = await rig(undefined, ((c.request.deadline ?? 0) - 600) * 1000);
    const { walletId, card } = await vectorWallet(r, simulator);
    const request = {
      kind: "evm.fiat24-session",
      network: c.request.network,
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      tokenId: c.request.tokenId,
      deadline: c.request.deadline,
    };
    const { result } = await drive(
      r,
      { kind: "sign", request },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    const sign = field(result, "result") as Record<string, unknown>;
    const signature = field(sign, "signature") as Uint8Array;
    const normalized = normalizeEvm(request);
    const leaf = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'/0/0");
    expect(recoverEvmSigner(normalized as never, { signature })).toBe(
      evmAddressFromPublicKey(leaf.publicKey ?? new Uint8Array(33)).toLowerCase(),
    );
    // The vector artefact is the anvil key's signature — the card signs with its own key.
    expect(signature).toHaveLength(65);
  });

  it("a polymarket app-origin typed-data order signs and recovers to the card account", async () => {
    const [c] = polymarket.cases;
    if (c === undefined) {
      throw new Error("polymarket vector missing");
    }
    const r = await rig();
    const { walletId, card } = await vectorWallet(r, simulator);
    // The CTF order type is unknown to the decoder — the request needs the vault's blind-signing
    // policy on, exactly as it would for an app-attributed chain.sign.
    ok(
      await r.h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: verifyPasskey() },
        r.session,
      ),
    );
    const request = {
      kind: "evm.typed-data",
      network: c.network,
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      typedData: JSON.stringify(c.typedData),
    };
    const { result } = await drive(
      r,
      { kind: "sign", request },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    const sign = field(result, "result") as Record<string, unknown>;
    const normalized = normalizeEvm(request);
    const recovered = recoverEvmSigner(normalized, sign);
    const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
    expect(status.wallets.some((w) => w.custody === "card" && w.walletId === walletId)).toBe(true);
    const leaf = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'/0/0");
    expect(recovered).toBe(
      evmAddressFromPublicKey(leaf.publicKey ?? new Uint8Array(33)).toLowerCase(),
    );
  });

  it("a solana transaction with a second signer signs only its own slot", async () => {
    const r = await rig();
    const { walletId, card } = await vectorWallet(r, simulator);
    ok(
      await r.h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: verifyPasskey() },
        r.session,
      ),
    );
    const accounts = ok(
      await r.h.call(
        "wallet.accounts",
        {
          walletId,
          groupIndex: 0,
          template: "solana.bip44-change",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        },
        r.session,
      ),
    );
    const ours = strField(accounts, "address");
    const other = "So11111111111111111111111111111111111111112";
    const enc = getAddressEncoder();
    const ourKey = new Uint8Array(enc.encode(address(ours)));
    const otherKey = new Uint8Array(enc.encode(address(other)));
    const systemProgram = new Uint8Array(32);
    // v0 message: 2 signers (ours, other), one unsigned readonly account (system program).
    const message = new Uint8Array([
      0x80,
      2,
      0,
      1,
      3,
      ...ourKey,
      ...otherKey,
      ...systemProgram,
      ...new Uint8Array(32), // blockhash
      1, // one instruction
      2,
      2,
      0,
      1,
      9,
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // transfer 2 lamports 0->1
      0, // no address table lookups
    ]);
    const request = {
      kind: "solana.transaction",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
      message,
    };
    const { result } = await drive(
      r,
      { kind: "sign", request },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    const sign = field(result, "result") as Record<string, unknown>;
    expect(verifySolanaSignature(message, field(sign, "signature") as Uint8Array, ours)).toBe(true);
  });

  it("an eip7702 upgrade splits over two taps under a small budget", async () => {
    const c = vectors.cases.find((x) => x.name === "evm-eip7702-upgrade");
    if (c === undefined) {
      throw new Error("vector missing");
    }
    // OPEN(200)+STATUS+VERIFY+margin leaves < 1 sign per tap; each of the 2 stages gets its own tap.
    const r = await rig(2000);
    const { walletId, card } = await vectorWallet(r, simulator);
    const request = requestFor(c, walletId);
    const { result, taps: n } = await drive(
      r,
      { kind: "sign", request },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(n).toBe(2);
    const sign = field(result, "result") as Record<string, unknown>;
    const normalized = normalizeEvm(request);
    expect(recoverEvmSigner(normalized as never, sign as never)).toBe(evmSignerOf(c));
  });

  const bip84Leaf = (index: number): HDKey =>
    HDKey.fromMasterSeed(SEED).derive(`m/84'/0'/0'/0/${index}`);

  /** A SegWit PSBT spending `inputs` of the vector wallet's bip84 receive leaves. */
  const bip84Psbt = (inputs: number): Uint8Array => {
    const masterFp = HDKey.fromMasterSeed(SEED).fingerprint;
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    for (let index = 0; index < inputs; index += 1) {
      const child = bip84Leaf(index);
      const pub = child.publicKey;
      if (pub === null) {
        throw new Error("no public key");
      }
      const spend = p2wpkh(pub);
      const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
      prev.addInput({
        txid: hexToBytes(`${index === 0 ? "aa" : "bb"}${"11".repeat(31)}`),
        index: 0,
        sequence: 0xffffffff,
      });
      prev.addOutput({ script: spend.script, amount: 100000n });
      tx.addInput({
        txid: hexToBytes(prev.id),
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script: spend.script, amount: 100000n },
        nonWitnessUtxo: prev.toBytes(true, false),
        bip32Derivation: [
          [pub, { fingerprint: masterFp, path: [84 + HARDENED, HARDENED, HARDENED, 0, index] }],
        ],
      });
    }
    tx.addOutput({ script: p2wpkh(bip84Leaf(9).publicKey!).script, amount: 5000n });
    return tx.toPSBT(0);
  };

  const psbtRequest = (walletId: string, psbt: Uint8Array, templates: string[]) => ({
    kind: "bitcoin.psbt",
    network: BTC_MAINNET,
    account: { kind: "hd", walletId, groupIndex: 0 },
    psbt,
    sign: templates.map((template, index) => ({ index, template })),
  });

  it("a psbt with two inputs of every template signs all eight on the card", async () => {
    const r = await rig();
    const { walletId, card } = await vectorWallet(r, simulator);
    const masterFp = HDKey.fromMasterSeed(SEED).fingerprint;
    const leaf = (purpose: number, index: number) => {
      const child = HDKey.fromMasterSeed(SEED).derive(`m/${purpose}'/0'/0'/0/${index}`);
      if (child.publicKey === null) {
        throw new Error("no public key");
      }
      return child.publicKey;
    };
    const spendScript = (purpose: number, pub: Uint8Array): Uint8Array =>
      purpose === 44
        ? p2pkh(pub).script
        : purpose === 49
          ? p2sh(p2wpkh(pub)).script
          : purpose === 84
            ? p2wpkh(pub).script
            : p2tr(pub.slice(1)).script;
    const purposes = [44, 44, 49, 49, 84, 84, 86, 86];
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    for (const [i, purpose] of purposes.entries()) {
      const pub = leaf(purpose, i % 2);
      const script = spendScript(purpose, pub);
      const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
      prev.addInput({
        txid: hexToBytes(`${(i + 0x10).toString(16)}${"cc".repeat(31)}`),
        index: 0,
        sequence: 0xffffffff,
      });
      prev.addOutput({ script, amount: 100000n });
      const path = [purpose + HARDENED, HARDENED, HARDENED, 0, i % 2];
      if (purpose === 86) {
        const xonly = pub.slice(1);
        tx.addInput({
          txid: hexToBytes(prev.id),
          index: 0,
          sequence: 0xfffffffd,
          witnessUtxo: { script, amount: 100000n },
          nonWitnessUtxo: prev.toBytes(true, false),
          tapInternalKey: xonly,
          tapBip32Derivation: [[xonly, { hashes: [], der: { fingerprint: masterFp, path } }]],
        });
      } else {
        tx.addInput({
          txid: hexToBytes(prev.id),
          index: 0,
          sequence: 0xfffffffd,
          witnessUtxo: { script, amount: 100000n },
          nonWitnessUtxo: prev.toBytes(true, false),
          ...(purpose === 49 ? { redeemScript: p2wpkh(pub).script } : {}),
          bip32Derivation: [[pub, { fingerprint: masterFp, path }]],
        });
      }
    }
    tx.addOutput({ script: p2wpkh(bip84Leaf(9).publicKey!).script, amount: 5000n });
    const templates = [
      "btc.bip44",
      "btc.bip44",
      "btc.bip49",
      "btc.bip49",
      "btc.bip84",
      "btc.bip84",
      "btc.bip86",
      "btc.bip86",
    ];
    const { result } = await drive(
      r,
      { kind: "sign", request: psbtRequest(walletId, tx.toPSBT(0), templates) },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    const signedPsbt = field(
      field(result, "result") as Record<string, unknown>,
      "signedPsbt",
    ) as Uint8Array;
    const groups: ReadonlyArray<readonly [number, ReadonlyArray<number>]> = [
      [44, [0, 1]],
      [49, [2, 3]],
      [84, [4, 5]],
      [86, [6, 7]],
    ];
    for (const [purpose, indices] of groups) {
      const xpub = HDKey.fromMasterSeed(SEED).derive(`m/${purpose}'/0'/0'`).publicExtendedKey;
      expect(
        verifyBitcoinPsbtSignatures(
          signedPsbt,
          [...indices],
          xpub,
          BTC_TEMPLATES[purpose]!,
          BTC_MAINNET,
        ),
      ).toBe(true);
    }
  });

  it("a 50-input segwit psbt needs exactly two taps and one verify", async () => {
    const r = await rig();
    const { walletId, card } = await vectorWallet(r, simulator);
    const psbt = bip84Psbt(50);
    r.reader.sessionLengths.length = 0;
    const { result, taps: n } = await drive(
      r,
      {
        kind: "sign",
        request: psbtRequest(
          walletId,
          psbt,
          Array.from({ length: 50 }, () => "btc.bip84"),
        ),
      },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(n).toBe(2);
    // Each tap's session is SELECT+OPEN+STATUS+VERIFY+k×SIGN; the two sessions sign all 50 once.
    const sessions = r.reader.sessionLengths;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]! + sessions[1]! - 8).toBe(50);
    const xpub = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'").publicExtendedKey;
    expect(
      verifyBitcoinPsbtSignatures(
        field(field(result, "result") as Record<string, unknown>, "signedPsbt") as Uint8Array,
        Array.from({ length: 50 }, (_, i) => i),
        xpub,
        "btc.bip84",
        BTC_MAINNET,
      ),
    ).toBe(true);
  });

  it("a tag lost in the second tap resends only the pending inputs", async () => {
    const r = await rig();
    const { walletId, card } = await vectorWallet(r, simulator);
    const psbt = bip84Psbt(50);
    r.reader.sessionLengths.length = 0;
    // First do a clean run to learn the transmit count of tap 1's last SIGN…
    const clean = await drive(
      r,
      {
        kind: "sign",
        request: psbtRequest(
          walletId,
          psbt,
          Array.from({ length: 50 }, () => "btc.bip84"),
        ),
      },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(clean.taps).toBe(2);
    const firstSession = r.reader.sessionLengths[0] ?? 0;
    // …then lose the SECOND tap's very first SIGN (global transmit = firstSession + 5).
    r.reader.sessionLengths.length = 0;
    r.reader.loseGlobal(firstSession + 5);
    const { result, taps: n } = await drive(
      r,
      {
        kind: "sign",
        request: psbtRequest(
          walletId,
          psbt,
          Array.from({ length: 50 }, () => "btc.bip84"),
        ),
      },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    // The lost tap is retried: three taps total, the first tap's inputs are never re-signed —
    // session 1 (clean) signed `firstSession - 4` of them, sessions 2+3 sign the remaining ones.
    expect(n).toBe(3);
    const sessions = r.reader.sessionLengths;
    expect(sessions[0]).toBe(firstSession);
    // Tap 2's session died at its first SIGN (4 framing + 1); the retry re-verifies and signs only
    // the inputs tap 1 never saw — the first tap's 36 are not re-signed.
    expect(sessions[1]).toBe(5);
    expect(sessions[2]).toBe(4 + (50 - (firstSession - 4)));
    expect(field(result, "result")).toBeDefined();
  });

  it("a plan over the per-approval limit is refused before any verify", async () => {
    const r = await rig(2000);
    const { walletId, card } = await vectorWallet(r, simulator);
    const psbt = bip84Psbt(4);
    r.reader.sessionLengths.length = 0;
    const codeErr = await driveErr(
      r,
      {
        kind: "sign",
        request: psbtRequest(walletId, psbt, ["btc.bip84", "btc.bip84", "btc.bip84", "btc.bip84"]),
      },
      { codes: [code()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(codeErr).toBe("card-unsupported");
    expect(r.reader.sessionLengths).toHaveLength(0);
  });

  it("the bip340 backend signs zero-tweak, bip86 and script-tree tweaks on the card", async () => {
    const r = await rig();
    const { card } = await vectorWallet(r, simulator);
    // Open a session on the loaded card: SELECT → OPEN → STATUS → VERIFY.
    await card.transmit(SELECT_APDU);
    const req = openRequest((n) => {
      const b = new Uint8Array(n);
      b[31] = 7;
      return b;
    });
    const openResp = await card.transmit(req.apdu);
    if (openResp === "torn") {
      throw new Error("torn OPEN");
    }
    const session = openResponse(req.secret, req.apdu, openResp, [CA1_ANCHOR], []);
    const send = async (inner: Inner): Promise<Uint8Array> => {
      const resp = await card.transmit(session.wrap(inner));
      if (resp === "torn") {
        throw new Error("torn transmit");
      }
      return result(inner, session.unwrap(resp));
    };
    const status: CardStatus = decode.status(await send(cmd.status()));
    expect(status.life).toBe("loaded");
    const hash = await accessHash(code(), session.cardId, quickArgon2id);
    decode.walletInfo(await send(cmd.verify(hash)), session.cardId);
    const tap: TapSession = {
      identity: session.identity,
      cert: session.cert,
      cardId: session.cardId,
      shortId: shortId(session.identity),
      status,
      memberOf: undefined,
      send,
      verify: async (): Promise<VerifyOutcome> =>
        Promise.reject(new Error("verify is not used by the task functions")),
      installed: () => {
        throw new Error("installed is not used by the task functions");
      },
      cost: () => 0,
      update: () => undefined,
    };

    const path = [86 + HARDENED, HARDENED, HARDENED, 0, 0];
    const leaf = HDKey.fromMasterSeed(SEED).derive(`m/86'/0'/0'/0/0`);
    const internal = leaf.publicKey;
    if (internal === null) {
      throw new Error("no internal key");
    }
    const message = new Uint8Array(32).fill(9);

    // Zero tweak: the output key is the internal key's own x-coordinate.
    const zeroTweak = new Uint8Array(32);
    const zeroOut = bip340OutputX(internal, zeroTweak);
    const sig0 = await signBip340Task(
      tap,
      { scheme: "bip340", path, publicKey: zeroOut, message, tweak: zeroTweak },
      internal,
    );
    expect(sig0).toHaveLength(64);

    // BIP-86 key-path tweak: output key = the vector's bip86 leaf x-only key.
    const bip86Tweak = taprootTweak(internal, new Uint8Array(0));
    const bip86Out = bip340OutputX(internal, bip86Tweak);
    const sig86 = await signBip340Task(
      tap,
      { scheme: "bip340", path, publicKey: bip86Out, message, tweak: bip86Tweak },
      internal,
    );
    expect(sig86).toHaveLength(64);

    // Key-path + script-tree tweak: TapTweak(P‖merkleRoot), verified under the tweaked key.
    const merkleRoot = new Uint8Array(32).fill(4);
    const treeTweak = taprootTweak(internal, merkleRoot);
    const treeOut = bip340OutputX(internal, treeTweak);
    const sigTree = await signBip340Task(
      tap,
      { scheme: "bip340", path, publicKey: treeOut, message, tweak: treeTweak },
      internal,
    );
    expect(sigTree).toHaveLength(64);

    // Independently verify all three under their output keys with noble schnorr.
    expect(schnorr.verify(sig0, message, zeroOut)).toBe(true);
    expect(schnorr.verify(sig86, message, bip86Out)).toBe(true);
    expect(schnorr.verify(sigTree, message, treeOut)).toBe(true);
    // And the bip86 output key is the one the vector's p2tr case signs under.
    const p2trCase = vectors.cases.find((x) => x.name === "bitcoin-message-bip322-p2tr");
    expect(bytesToHex(bip86Out)).toBe(String((p2trCase?.stages[0]?.[0] ?? {})["publicKey"]));
    session.close();
  });

  it("prints the per-case tap/transmit table", () => {
    for (const row of stats) {
      process.stdout.write(`SIGNSTAT ${row.name} taps=${row.taps} transmits=${row.transmits}\n`);
    }
    expect(stats).toHaveLength(20);
  });
});
