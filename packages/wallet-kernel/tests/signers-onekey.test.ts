// oxlint-disable vitest/no-conditional-in-test -- plan/recorded fixtures narrow via guard throws
/**
 * OneKey end to end through the kernel: `hardware.begin`/`step` pair the device and sign an
 * EIP-1559 transaction and the mixed-template PSBT, with the recorded driver transcript
 * (vectors/onekey/driver-<model>.json) answering every exchange step exactly as the live emulator
 * did. The software wallet on the same seed is the oracle for the EVM artefact; the PSBT signatures
 * are verified independently (`verifyBitcoinPsbtSignatures`) since taproot carries BIP-340 aux
 * randomness.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { Transaction as ScureTransaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { normalizeBitcoin, verifyBitcoinPsbtSignatures } from "@qntx/wallet-chains/bitcoin";
import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { ONEKEY_DRIVER } from "../src/modules/signers/onekey/driver.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";
import {
  BTC_NETWORK,
  DRIVER_SEED,
  driverSignCases,
  leafPublic,
} from "./onekey-emulator/driver-cases.ts";
import { loadTranscript, replayExchange, transcriptSession } from "./onekey-emulator/index.ts";
import type { Transcript } from "./onekey-emulator/index.ts";
import { fakeDevice, masterFingerprint } from "./signers-fake.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF = new Uint8Array(32).fill(0x50);
const FACTOR = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF),
});
const PASSKEY = (): unknown => ({
  kind: "passkey",
  credentialId: new Uint8Array(CREDENTIAL_ID),
  prf: new Uint8Array(PRF),
});

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error(`expected object, got ${String(value)}`);
  }
  const v = (value as Record<string, ProtocolValue>)[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}
const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};
const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

/**
 * Drives a begin/step operation to `done`, replaying the recorded conversation back at every
 * `message` exchange — the exact bytes the live emulator saw and answered.
 */
const runOp = async (
  h: Harness,
  session: string,
  begin: KernelResponse,
  device: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<ProtocolValue> => {
  const opId = strField(ok(begin), "opId");
  let step = field(ok(begin), "step");
  for (let guard = 0; strField(step, "kind") === "exchange" && guard < 64; guard++) {
    const request = field(step, "request");
    if (strField(request, "kind") !== "message") {
      throw new Error(`expected a message request, got ${JSON.stringify(request)}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- the coroutine answers one turn per step
    const response = { kind: "message", data: await device(bytesField(request, "data")) };
    // oxlint-disable-next-line no-await-in-loop -- the coroutine advances one turn per step
    const next = await h.call("hardware.step", { opId, response }, session);
    if ("err" in next) {
      throw new Error(`hardware.step failed: ${JSON.stringify(next.err)}`);
    }
    step = next.ok;
  }
  if (strField(step, "kind") !== "done") {
    throw new Error("the operation did not finish");
  }
  return field(step, "result");
};

const boot = async (
  transcript: Transcript,
): Promise<{ h: Harness; session: string; walletId: string; hwId: string }> => {
  const h = createHarness({
    drivers: {
      keystone: fakeDevice(DRIVER_SEED).driver,
      ledger: fakeDevice(DRIVER_SEED).driver,
      onekey: ONEKEY_DRIVER,
    },
  });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: FACTOR() }),
  );
  const session = (res as Record<string, ProtocolValue>)["session"] as string;
  const walletId = (
    (res as Record<string, ProtocolValue>)["wallet"] as Record<string, ProtocolValue>
  )["walletId"] as string;
  ok(await h.call("vault.setBlindSigning", { enabled: true, verify: PASSKEY() }, session));
  const result = await runOp(
    h,
    session,
    await h.call("hardware.begin", { op: { kind: "pair", device: "onekey" } }, session),
    replayExchange(transcriptSession(transcript, "driver-pair")),
  );
  const hwId = strField(field(result, "wallet"), "walletId");
  return { h, session, walletId, hwId };
};

const H = 0x80_00_00_00;
const TEMPLATES: ReadonlyArray<readonly [number, BitcoinAccountTemplate]> = [
  [44 + H, "btc.bip44"],
  [49 + H, "btc.bip49"],
  [84 + H, "btc.bip84"],
  [86 + H, "btc.bip86"],
];

const integration = (model: "classic1s" | "pro"): void => {
  describe(`onekey ${model} through hardware.begin/step`, () => {
    const transcript = loadTranscript(model, "driver");
    const find = (name: string) => {
      const item = driverSignCases().find((c) => c.name === name);
      if (item === undefined) {
        throw new Error(`driver case ${name} missing`);
      }
      return item;
    };

    it("pairs, then an EIP-1559 transaction is byte-identical to local signing", async () => {
      const { h, session, walletId, hwId } = await boot(transcript);
      const { request } = find("driver-sign-evm-eip1559");
      const account = (walletId: string) => ({
        kind: "hd",
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
      });
      const done = await runOp(
        h,
        session,
        await h.call(
          "hardware.begin",
          {
            op: {
              kind: "sign",
              request: { ...request, account: account(hwId) },
            },
            verify: PASSKEY(),
          },
          session,
        ),
        replayExchange(transcriptSession(transcript, "driver-sign-evm-eip1559")),
      );
      const sw = ok(
        await h.call(
          "chain.sign",
          {
            request: { ...request, account: account(walletId) },
            verify: PASSKEY(),
          },
          session,
        ),
      );
      expect(field(done, "result")).toStrictEqual(sw);
    });

    it("the mixed-template PSBT verifies against the pinned account nodes", async () => {
      const { h, session, hwId } = await boot(transcript);
      const { request } = find("driver-sign-bitcoin-psbt");
      if (request.kind !== "bitcoin.psbt") {
        throw new Error("unexpected request kind");
      }
      // The kernel proves each sign entry's ownership from the PSBT itself: derivation entries
      // (bip32/taproot) and witnessUtxo for the non-legacy inputs. The protocol-level fixture
      // carries neither — the OneKey wire plan only needs the sign list's paths — so add them.
      const stage = find("driver-sign-bitcoin-psbt").stage();
      const spend = ScureTransaction.fromPSBT(request.psbt, { allowUnknownInputs: true });
      // BIP-174 fingerprints are uint32 — the first four hash160 bytes read big-endian.
      const fingerprint = new DataView(masterFingerprint(DRIVER_SEED).buffer).getUint32(0, false);
      for (const [i, entry] of request.sign.entries()) {
        const task = stage.tasks[i];
        if (task === undefined || task.scheme === "ed25519") {
          throw new Error(`sign entry ${entry.index} has no secp256k1 task`);
        }
        const pub = leafPublic([...task.path]);
        const patch: Record<string, unknown> =
          entry.template === "btc.bip86"
            ? {
                tapInternalKey: pub.slice(1),
                tapBip32Derivation: [
                  [pub.slice(1), { hashes: [], der: { fingerprint, path: task.path } }],
                ],
              }
            : { bip32Derivation: [[pub, { fingerprint, path: task.path }]] };
        const input = spend.getInput(entry.index);
        const prevTx = input.nonWitnessUtxo;
        const vout = input.index;
        if (prevTx === undefined || vout === undefined) {
          throw new Error(`input ${entry.index} carries no previous transaction`);
        }
        const prevout = (
          prevTx.outputs as ReadonlyArray<{ script?: Uint8Array; amount?: bigint } | undefined>
        )[vout];
        if (prevout?.script === undefined || prevout.amount === undefined) {
          throw new Error(`input ${entry.index} prevout ${vout} missing`);
        }
        // witnessUtxo on every input: the kernel requires it for non-legacy spends, and the
        // BIP-341 taproot sighash commits to every input's prevout script and amount.
        patch["witnessUtxo"] = { script: prevout.script, amount: prevout.amount };
        spend.updateInput(entry.index, patch);
      }
      // The kernel only signs the normalized form — canonical psbt bytes, sorted sign entries.
      const normalized = normalizeBitcoin({
        ...request,
        account: { kind: "hd", walletId: hwId, groupIndex: 0 },
        psbt: spend.toPSBT(0),
      });
      const done = await runOp(
        h,
        session,
        await h.call(
          "hardware.begin",
          {
            op: { kind: "sign", request: normalized },
            verify: PASSKEY(),
          },
          session,
        ),
        replayExchange(transcriptSession(transcript, "driver-sign-bitcoin-psbt")),
      );
      const signedPsbt = bytesField(field(done, "result"), "signedPsbt");
      // Group the sign entries by template; each group verifies against its account xpub.
      const byTemplate = new Map<string, number[]>();
      for (const entry of request.sign) {
        const list = byTemplate.get(entry.template) ?? [];
        list.push(entry.index);
        byTemplate.set(entry.template, list);
      }
      expect(byTemplate.size).toBe(4);
      for (const [purpose, template] of TEMPLATES) {
        const indices = byTemplate.get(template);
        if (indices === undefined) {
          throw new Error(`the PSBT signs no ${template} input`);
        }
        const xpub = HDKey.fromMasterSeed(DRIVER_SEED).derive(
          `m/${(purpose - H).toString()}'/0'/0'`,
        ).publicExtendedKey;
        expect(verifyBitcoinPsbtSignatures(signedPsbt, indices, xpub, template, BTC_NETWORK)).toBe(
          true,
        );
      }
    });
  });
};

integration("classic1s");
integration("pro");
