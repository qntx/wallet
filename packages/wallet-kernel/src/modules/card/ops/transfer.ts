import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { KernelError } from "../../../errors.ts";
import { wipe } from "../../../secret/secret.ts";
import type { CardOp } from "../tap.ts";
import { accessCodeLabel, tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import { ask, askNewCode, hashAll, holdDue, tapRetry, walletOf } from "./shared.ts";
import type { Target } from "./transfer-shared.ts";
import { askShortId, exportTo, installRun, takeOffer, targetFrom } from "./transfer-shared.ts";

/**
 * `transfer` — provision the wallet's unfinished members (§11.3): every `pending` member, or when
 * none are pending the members not yet proven `ready` (an erased card shows BLANK). Each target is
 * OFFERed by typed short ID, the user names a ready member as the source, enters the source's
 * existing code and the target's new code; the source VERIFYs and EXPORTs under the target's hash,
 * the target IMPORTs and its WalletInfo must echo the record. I4 is structural: the export's target
 * is exactly the card this operation OFFERed and the record lists.
 */
export async function* transferOp(
  env: OpEnv,
  op: Extract<CardOperation, { kind: "transfer" }>,
): CardOp {
  const { header } = walletOf(env, op.walletId);
  const pending = header.cards.filter((c) => c.state === "pending").map((c) => c.cardId);
  const targetIds =
    pending.length > 0
      ? pending
      : header.cards.filter((c) => c.state !== "ready").map((c) => c.cardId);
  if (targetIds.length === 0) {
    throw new KernelError("invalid-input", "every member of this wallet is already provisioned");
  }
  const readyIds = header.cards.filter((c) => c.state === "ready").map((c) => c.cardId);
  if (readyIds.length === 0) {
    throw new KernelError("invalid-input", "no ready member can export this wallet");
  }
  const ready = readyIds.map(hexToBytes);
  const hashes = new Map<string, Uint8Array>();
  let sourceCode: Uint8Array | undefined;
  let targetCode: Uint8Array | undefined;
  let sourceCert: Uint8Array | undefined;
  try {
    for (const targetIdHex of targetIds) {
      const targetId = hexToBytes(targetIdHex);
      const typedT = yield* askShortId(env.locale);
      // The target's OFFER — any life: BLANK installs fresh, LOADED re-seals the same wallet.
      let target: Target | undefined;
      yield* tapRetry((retry) => {
        void walletOf(env, op.walletId);
        return {
          reason: retry ? "retry" : "target",
          prompt: tapPrompt(env.locale, "transfer", retry ? "retry" : "target", typedT),
          expect: {
            life: "any",
            cards: [targetId],
            shortId: typedT,
            walletId: op.walletId,
          },
          run: async (tap): Promise<RunOutcome> => {
            target = targetFrom(tap, await takeOffer(tap));
            return { status: "done" };
          },
        };
      });
      if (target === undefined) {
        throw new KernelError("integrity", "the target's offer was not taken");
      }
      const peer: Target = target;
      const typedS = yield* askShortId(env.locale);
      sourceCode ??= yield* ask({
        purpose: "access-code",
        secure: "access-code",
        card: typedS,
        label: accessCodeLabel(env.locale, typedS, undefined),
      });
      targetCode = yield* askNewCode(env);

      // Source and target taps alternate until the target installs: a lost offer on the
      // target (`reexport`) sends the op back to the source for a fresh export.
      for (;;) {
        while (peer.transfer === undefined) {
          // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
          const outcome = yield* tapRetry((retry) => {
            const entry = walletOf(env, op.walletId);
            const short = typedS;
            return {
              reason: retry ? "retry" : "source",
              card: short,
              hold: holdDue(entry.header, readyIds),
              prompt: tapPrompt(env.locale, "transfer", retry ? "retry" : "source", short),
              expect: { life: "loaded", cards: ready, shortId: typedS, walletId: op.walletId },
              run: async (tap): Promise<RunOutcome> => {
                const id = bytesToHex(tap.cardId);
                if (!hashes.has(id)) {
                  if (sourceCode === undefined) {
                    return { status: "need-code", card: tap.shortId };
                  }
                  const code = sourceCode;
                  sourceCode = undefined;
                  await hashAll(env, hashes, code, [tap.cardId]);
                  wipe(code);
                }
                if (!hashes.has(bytesToHex(peer.cardId))) {
                  if (targetCode === undefined) {
                    return { status: "need-code", card: peer.shortId };
                  }
                  const code = targetCode;
                  await hashAll(env, hashes, code, [peer.cardId]);
                }
                const hashS = hashes.get(id);
                if (hashS === undefined) {
                  return { status: "need-code", card: tap.shortId };
                }
                const verified = await tap.verify(hashS);
                if (!verified.ok) {
                  return { status: "wrong-code", remaining: verified.remaining };
                }
                const hashT = hashes.get(bytesToHex(peer.cardId));
                if (hashT === undefined) {
                  return { status: "need-code", card: peer.shortId };
                }
                peer.transfer = await exportTo(tap, peer, hashT);
                ({ cert: sourceCert } = tap);
                return { status: "done" };
              },
            };
          });
          if (outcome.status === "done") {
            break;
          }
          if (outcome.status === "reexport") {
            throw new KernelError("integrity", "a source tap cannot re-export");
          }
          const asked = yield* ask({
            purpose: "access-code",
            secure: "access-code",
            ...(outcome.status === "need-code" ? { card: outcome.card } : {}),
            ...(outcome.status === "wrong-code" ? { remaining: outcome.remaining } : {}),
            label:
              outcome.status === "need-code"
                ? accessCodeLabel(env.locale, outcome.card, undefined)
                : accessCodeLabel(env.locale, undefined, outcome.remaining),
          });
          if (outcome.status === "wrong-code") {
            for (const id of readyIds) {
              const old = hashes.get(id);
              if (old !== undefined) {
                wipe(old);
                hashes.delete(id);
              }
            }
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential KDF
          await hashAll(env, hashes, asked, ready);
          wipe(asked);
        }

        // Target tap: IMPORT both halves; the WalletInfo must echo the record.
        // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
        const outcome = yield* tapRetry((retry) => ({
          reason: retry ? "retry" : "target",
          card: peer.shortId,
          prompt: tapPrompt(env.locale, "transfer", retry ? "retry" : "target", peer.shortId),
          expect: {
            life: "any",
            cards: [peer.cardId],
            shortId: peer.shortId,
            walletId: op.walletId,
          },
          run: async (tap): Promise<RunOutcome> => {
            if (sourceCert === undefined) {
              throw new KernelError("integrity", "the exporting member was never tapped");
            }
            const result = await installRun({
              tap,
              target: peer,
              sourceCert,
              hashT: () => hashes.get(targetIdHex),
              entry: walletOf(env, op.walletId),
            });
            if (result.status === "done" && targetCode !== undefined) {
              wipe(targetCode);
              targetCode = undefined;
            }
            return result;
          },
        }));
        if (outcome.status === "done" || outcome.status === "reexport") {
          break;
        }
        const asked = yield* ask({
          purpose: "access-code",
          secure: "access-code",
          ...(outcome.status === "need-code" ? { card: outcome.card } : {}),
          ...(outcome.status === "wrong-code" ? { remaining: outcome.remaining } : {}),
          label:
            outcome.status === "need-code"
              ? accessCodeLabel(env.locale, outcome.card, undefined)
              : accessCodeLabel(env.locale, undefined, outcome.remaining),
        });
        const old = hashes.get(targetIdHex);
        if (outcome.status === "wrong-code" && old !== undefined) {
          wipe(old);
          hashes.delete(targetIdHex);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential KDF
        await hashAll(env, hashes, asked, [targetId]);
        wipe(asked);
      }
    }
    return { kind: "transfer", walletId: op.walletId } satisfies CardOpResult;
  } finally {
    if (sourceCode !== undefined) {
      wipe(sourceCode);
    }
    if (targetCode !== undefined) {
      wipe(targetCode);
    }
    for (const hash of hashes.values()) {
      wipe(hash);
    }
  }
}
