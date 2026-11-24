import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { KernelError } from "../../../errors.ts";
import { wipe } from "../../../secret/secret.ts";
// oxlint-disable typescript/require-await -- op bodies are async generators whose own code
// only `yield*`s; the awaits live in the `run` callbacks and the hash helpers.
import type { CardOp } from "../tap.ts";
import { accessCodeLabel, tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import { ask, hashAll, holdDue, pinnedShortId, tapRetry, walletOf } from "./shared.ts";

/** `health` — one input, then a VERIFY tap for every member, any order. */
export async function* healthOp(
  env: OpEnv,
  op: Extract<CardOperation, { kind: "health" }>,
): CardOp {
  const { walletId } = op;
  const hashes = new Map<string, Uint8Array>();
  let code: Uint8Array | undefined;
  const done = new Set<string>();
  try {
    code = yield* ask({
      purpose: "access-code",
      secure: "access-code",
      label: accessCodeLabel(env.locale, undefined, undefined),
    });
    for (;;) {
      const wallet = walletOf(env, walletId);
      if (wallet.header.members.every((m) => done.has(m))) {
        break;
      }
      let lastCard: string | undefined;
      // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
      const outcome = yield* tapRetry((retry) => {
        const fresh = walletOf(env, walletId);
        const undone = fresh.header.members.filter((m) => !done.has(m));
        const short =
          undone.length === 1 ? pinnedShortId(fresh.header, undone[0] ?? "") : undefined;
        return {
          reason: retry ? "retry" : "member",
          card: short,
          hold: holdDue(fresh.header, undone),
          prompt: tapPrompt(env.locale, "health", retry ? "retry" : "member", short),
          expect: {
            life: "loaded",
            cards: undone.map(hexToBytes),
            exclude: [...done].map(hexToBytes),
            walletId,
          },
          run: async (tap): Promise<RunOutcome> => {
            const id = bytesToHex(tap.cardId);
            lastCard = id;
            let hash = hashes.get(id);
            if (hash === undefined) {
              if (code === undefined) {
                return { status: "need-code", card: tap.shortId };
              }
              // Every member's hash at once — the code bytes die inside this first tap.
              await hashAll(env, hashes, code, fresh.header.members.map(hexToBytes));
              wipe(code);
              code = undefined;
              hash = hashes.get(id);
            }
            if (hash === undefined) {
              return { status: "need-code", card: tap.shortId };
            }
            const verified = await tap.verify(hash);
            if (!verified.ok) {
              wipe(hash);
              hashes.delete(id);
              return { status: "wrong-code", remaining: verified.remaining };
            }
            return { status: "done" };
          },
        };
      });
      if (outcome.status === "done") {
        if (lastCard === undefined) {
          throw new KernelError("integrity", "a verified tap did not record its card");
        }
        done.add(lastCard);
        continue;
      }
      if (outcome.status === "need-code") {
        code = yield* ask({
          purpose: "access-code",
          secure: "access-code",
          card: outcome.card,
          label: accessCodeLabel(env.locale, outcome.card, undefined),
        });
        continue;
      }
      const { remaining } = outcome;
      code = yield* ask({
        purpose: "access-code",
        secure: "access-code",
        remaining,
        label: accessCodeLabel(env.locale, undefined, remaining),
      });
    }
    return { kind: "health", walletId } satisfies CardOpResult;
  } finally {
    if (code !== undefined) {
      wipe(code);
    }
    for (const hash of hashes.values()) {
      wipe(hash);
    }
  }
}
