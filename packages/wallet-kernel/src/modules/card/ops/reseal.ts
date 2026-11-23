import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { KernelError } from "../../../errors.ts";
import { wipe } from "../../../secret/secret.ts";
import type { CardOp } from "../tap.ts";
import { accessCodeLabel, tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import { ask, askNewCode, hashAll, holdDue, pinnedShortId, tapRetry, walletOf } from "./shared.ts";
import type { Target } from "./transfer-shared.ts";
import { askShortId, exportTo, installRun, takeOffer, targetFrom } from "./transfer-shared.ts";

/**
 * `reseal` — give member `op.card` a fresh access code without knowing the old one (§11.3): the
 * target is never erased and never VERIFYed — OFFER is allowed on a LOADED card and a valid offer
 * just re-answers the same link key. Another ready member (`op.member`, or the first ready member
 * that is not the target) VERIFYs under its own code and EXPORTs under the target's new hash; the
 * target IMPORTs and its WalletInfo must echo the record. Covers both a LOADED card whose code was
 * forgotten (T-INSTALL rewrites equal wallet data, new code) and a BLANK card the failure limit
 * erased (fresh install).
 */
export async function* resealOp(
  env: OpEnv,
  op: Extract<CardOperation, { kind: "reseal" }>,
): CardOp {
  const { header } = walletOf(env, op.walletId);
  const targetId = hexToBytes(op.card);
  const member =
    op.member ?? header.cards.find((c) => c.state === "ready" && c.cardId !== op.card)?.cardId;
  if (member === undefined) {
    throw new KernelError("invalid-input", "no other ready member can reseal this card");
  }
  const memberId = hexToBytes(member);
  const hashes = new Map<string, Uint8Array>();
  let memberCode: Uint8Array | undefined;
  let newCode: Uint8Array | undefined;
  let sourceCert: Uint8Array | undefined;
  let target: Target | undefined;
  try {
    // Target first: typed short ID, then the tap takes its offer — LOADED or BLANK alike.
    const typedT = yield* askShortId(env.locale);
    yield* tapRetry((retry) => {
      void walletOf(env, op.walletId);
      return {
        reason: retry ? "retry" : "target",
        prompt: tapPrompt(env.locale, "reseal", retry ? "retry" : "target", typedT),
        expect: { life: "any", cards: [targetId], shortId: typedT, walletId: op.walletId },
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

    // The exporting member: typed short ID, its existing code, then the target's new code.
    const typedM = yield* askShortId(env.locale);
    memberCode = yield* ask({
      purpose: "access-code",
      secure: "access-code",
      card: typedM,
      label: accessCodeLabel(env.locale, typedM, undefined),
    });
    newCode = yield* askNewCode(env);

    for (;;) {
      while (peer.transfer === undefined) {
        // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
        const outcome = yield* tapRetry((retry) => {
          const entry = walletOf(env, op.walletId);
          const short = pinnedShortId(entry.header, member);
          return {
            reason: retry ? "retry" : "source",
            card: short ?? typedM,
            hold: holdDue(entry.header, [member]),
            prompt: tapPrompt(env.locale, "reseal", retry ? "retry" : "source", short ?? typedM),
            expect: {
              life: "loaded",
              cards: [memberId],
              shortId: typedM,
              walletId: op.walletId,
            },
            run: async (tap): Promise<RunOutcome> => {
              const id = bytesToHex(tap.cardId);
              if (!hashes.has(id)) {
                if (memberCode === undefined) {
                  return { status: "need-code", card: tap.shortId };
                }
                const code = memberCode;
                memberCode = undefined;
                await hashAll(env, hashes, code, [tap.cardId]);
                wipe(code);
              }
              if (!hashes.has(bytesToHex(peer.cardId))) {
                if (newCode === undefined) {
                  return { status: "need-code", card: peer.shortId };
                }
                await hashAll(env, hashes, newCode, [peer.cardId]);
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
        const old = hashes.get(member);
        if (outcome.status === "wrong-code" && old !== undefined) {
          wipe(old);
          hashes.delete(member);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential KDF
        await hashAll(env, hashes, asked, [memberId]);
        wipe(asked);
      }

      // The target's install tap — never VERIFYed: installRun's LOADED retry confirms a
      // committed install by VERIFYing the NEW hash, which is the only allowed exception.
      // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
      const outcome = yield* tapRetry((retry) => ({
        reason: retry ? "retry" : "target",
        card: peer.shortId,
        prompt: tapPrompt(env.locale, "reseal", retry ? "retry" : "target", peer.shortId),
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
            hashT: () => hashes.get(op.card),
            entry: walletOf(env, op.walletId),
          });
          if (result.status === "done") {
            // The old code is gone — a saved hash under it would only cause a 63Cx later.
            tap.update((d) => {
              if (d.body !== undefined && d.body.access?.[op.card] !== undefined) {
                const { [op.card]: _removed, ...access } = d.body.access;
                d.body = { ...d.body, access };
              }
            });
          }
          return result;
        },
      }));
      if (outcome.status === "done") {
        break;
      }
      if (outcome.status === "reexport") {
        continue;
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
      const old = hashes.get(op.card);
      if (outcome.status === "wrong-code" && old !== undefined) {
        wipe(old);
        hashes.delete(op.card);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential KDF
      await hashAll(env, hashes, asked, [targetId]);
      wipe(asked);
    }
    return { kind: "reseal", walletId: op.walletId } satisfies CardOpResult;
  } finally {
    if (memberCode !== undefined) {
      wipe(memberCode);
    }
    if (newCode !== undefined) {
      wipe(newCode);
    }
    for (const hash of hashes.values()) {
      wipe(hash);
    }
  }
}
