// oxlint-disable vitest/no-conditional-in-test -- plan/recorded fixtures narrow via guard throws
/**
 * Driver-level replay of the live emulator recordings (vectors/onekey/driver-<model>.json): the
 * real ONEKEY_DRIVER — pair, accounts, verifyAddress, sign — against replayed exchanges, with every
 * signature verified independently (noble ecdsa/ed25519/schnorr, bitcoinjs sighashes). The requests
 * come from driver-cases.ts, the same builders the recorder used, so the replay asserts the driver
 * asks the device byte-for-byte what was recorded.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vite-plus/test";

import { KernelError } from "../src/errors.ts";
import type { ChainPlan } from "../src/modules/chains/run.ts";
import type { DeviceIdentity, DeviceLink, SignContext } from "../src/modules/signers/driver.ts";
import { ONEKEY_DRIVER } from "../src/modules/signers/onekey/driver.ts";
import {
  ecdsaOk,
  schnorrOk,
  sighash,
  sighashTweakedKey,
} from "./onekey-emulator/bitcoin-verify.ts";
import {
  assembleEvm,
  driverAccountsNeed,
  driverPin,
  driverSignCases,
  driverVerifyTargets,
  eip7702Case,
} from "./onekey-emulator/driver-cases.ts";
import { loadTranscript, replayExchange, transcriptSession } from "./onekey-emulator/index.ts";
import type { Transcript, TranscriptSession } from "./onekey-emulator/index.ts";

const EXPECTED: Record<"classic1s" | "pro", { model: string; firmware: string }> = {
  classic1s: { model: "classic1s", firmware: "3.21.0" },
  pro: { model: "pro", firmware: "4.21.0" },
};

const replayLink = (session: TranscriptSession): DeviceLink => {
  const device = replayExchange(session);
  return {
    exchange: async (request) => {
      if (request.kind !== "message") {
        throw new Error("the driver sent a non-message request");
      }
      return { kind: "message", data: await device(request.data) };
    },
  };
};

const context = (
  request: SignContext["request"],
  stage: ChainPlan,
  identity: DeviceIdentity,
): SignContext => {
  // The value the prompt stored at confirmation time — what `display` computed for the record.
  // When that is "unsupported" no confirmation could have happened; any stored value makes the
  // live check refuse the same way, so stand it in for the recorded refusal sessions.
  const shown = ONEKEY_DRIVER.display(request, stage, identity, undefined);
  return {
    request,
    stage,
    pin: driverPin(),
    display: shown === "unsupported" ? "clear" : shown,
    random: (n) => new Uint8Array(n),
  };
};

/** Verifies one stage task's signature with noble — no kernel signing code. */
const verifyTask = (
  plan: ChainPlan,
  index: number,
  sig: Uint8Array,
  psbt?: Uint8Array,
): boolean => {
  const task = plan.tasks[index];
  if (task === undefined) {
    throw new Error(`plan task ${index} missing`);
  }
  if (task.scheme === "ed25519") {
    return ed25519.verify(sig, task.message, task.publicKey);
  }
  if (task.scheme === "bip340") {
    const digest = psbt === undefined ? task.message : sighash(psbt, index, task.publicKey);
    const key = psbt === undefined ? task.publicKey : sighashTweakedKey(psbt, index);
    return schnorrOk(digest, sig, key);
  }
  const digest = psbt === undefined ? task.digest : sighash(psbt, index, task.publicKey);
  return ecdsaOk(digest, sig, task.publicKey);
};

const driverReplay = (model: "classic1s" | "pro"): void => {
  const transcript: Transcript = loadTranscript(model, "driver");
  const session = (name: string): TranscriptSession => transcriptSession(transcript, name);

  describe(`${model} driver replay`, () => {
    it("pairs: publishes the seed's account nodes and the device identity", async () => {
      const pairing = await ONEKEY_DRIVER.pair(replayLink(session("driver-pair")));
      const pin = driverPin();
      expect(pairing.model).toBe(EXPECTED[model].model);
      expect(pairing.firmware).toBe(EXPECTED[model].firmware);
      expect(pairing.fingerprint).toStrictEqual(pin.fingerprint);
      expect(pairing.nodes).toStrictEqual(pin.nodes);
      expect(pairing.ed25519).toStrictEqual(pin.ed25519);
    });

    it("accounts: fills the requested nodes for the second group", async () => {
      const result = await ONEKEY_DRIVER.accounts(
        replayLink(session("driver-accounts")),
        driverAccountsNeed,
        driverPin(),
      );
      expect(result.fingerprint).toStrictEqual(driverPin().fingerprint);
      expect(result.nodes.map((n) => n.path)).toStrictEqual(driverAccountsNeed.secp256k1);
      expect(result.ed25519.map((e) => e.path)).toStrictEqual(driverAccountsNeed.ed25519);
      for (const node of result.nodes) {
        expect(node.publicKey).toHaveLength(33);
      }
    });

    // Only the Pro emulator can run a host-initiated display headlessly; Classic 1S records none.
    it.each(model === "pro" ? driverVerifyTargets() : [])(
      "$name: the device shows the address",
      async (entry) => {
        const verdict = await ONEKEY_DRIVER.verifyAddress(
          replayLink(session(entry.name)),
          entry.target,
          driverPin(),
        );
        expect(verdict).toStrictEqual({ method: "device", matched: true });
      },
    );

    // The record identity `display` computes against — the pair test asserts the device reports it.
    const identity: DeviceIdentity = {
      fingerprint: driverPin().fingerprint,
      model: EXPECTED[model].model,
      firmware: EXPECTED[model].firmware,
    };

    const cases = driverSignCases();
    // BIP-322 needs Pro ≥ 4.9.3 — on Classic 1S the driver refuses at the live-display check.
    const refused = (item: { name: string }): boolean =>
      model === "classic1s" && item.name.includes("bip322");

    it.each(cases.filter((item) => !refused(item)))(
      "$name: signs and every signature verifies",
      async (item) => {
        const stage = item.stage();
        const ctx = context(item.request, stage, identity);
        const signatures = await ONEKEY_DRIVER.sign(replayLink(session(item.name)), ctx);
        expect(signatures).toHaveLength(stage.tasks.length);
        const psbt = item.request.kind === "bitcoin.psbt" ? item.request.psbt : undefined;
        for (const [i, sig] of signatures.entries()) {
          expect(verifyTask(stage, i, sig, psbt), `signature ${i}`).toBe(true);
        }
      },
    );

    it.each(cases.filter(refused))("$name: refuses as unsupported", async (item) => {
      const stage = item.stage();
      const ctx = context(item.request, stage, identity);
      const error = await ONEKEY_DRIVER.sign(replayLink(session(item.name)), ctx).then(
        () => {
          throw new Error("expected a refusal");
        },
        (error_: unknown) => error_,
      );
      expect(error).toBeInstanceOf(KernelError);
      expect((error as KernelError).code).toBe("unsupported");
      // The refusal lands after Initialize + the pinned-node probe — before any sign call.
      expect(session(item.name).exchanges).toHaveLength(2);
    });

    it("driver-sign-evm-eip7702: both stages verify against their digests", async () => {
      const { request, stage } = eip7702Case();
      const plan1 = stage();
      const sig1 = await ONEKEY_DRIVER.sign(
        replayLink(session("driver-sign-evm-eip7702-stage1")),
        context(request, plan1, identity),
      );
      const next = assembleEvm(plan1, sig1);
      if (next.kind !== "next") {
        throw new Error("eip7702 stage 1 did not produce a stage-2 plan");
      }
      const sig2 = await ONEKEY_DRIVER.sign(
        replayLink(session("driver-sign-evm-eip7702-stage2")),
        context(request, next.plan, identity),
      );
      expect(verifyTask(plan1, 0, sig1[0] ?? new Uint8Array())).toBe(true);
      expect(verifyTask(next.plan, 0, sig2[0] ?? new Uint8Array())).toBe(true);
    });
  });
};

driverReplay("classic1s");
driverReplay("pro");
