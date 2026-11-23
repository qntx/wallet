import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { wipe } from "../../../secret/secret.ts";
import { CARD_WALLET_KIND } from "../../../vault/store.ts";
import { accessHash } from "../protocol/access.ts";
import { cmd } from "../protocol/commands.ts";
import { decode } from "../protocol/decode.ts";
// oxlint-disable typescript/require-await -- op bodies are async generators whose own code
// only `yield*`s; the awaits live in the `run` callbacks and the hash helpers.
import type { CardOp } from "../tap.ts";
import { accessCodeLabel, tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import { ask, holdDue, lowestTries, pinnedShortId, tapRetry, walletOf } from "./shared.ts";

/** `erase` — VERIFY then ERASE; drops the card entry, and deletes a now card-less record. */
export async function* eraseOp(env: OpEnv, op: Extract<CardOperation, { kind: "erase" }>): CardOp {
  const { walletId } = op;
  const target = op.card;
  const hashes = new Map<string, Uint8Array>();
  let code: Uint8Array | undefined;
  try {
    const wallet = walletOf(env, walletId);
    const short = pinnedShortId(wallet.header, target);
    const remaining = lowestTries(wallet.header, [target]);
    code = yield* ask({
      purpose: "access-code",
      secure: "access-code",
      card: short,
      remaining,
      label: accessCodeLabel(env.locale, short, remaining),
    });
    for (;;) {
      // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
      const outcome = yield* tapRetry((retry) => {
        const fresh = walletOf(env, walletId);
        const card = pinnedShortId(fresh.header, target);
        return {
          reason: retry ? "retry" : "member",
          card,
          hold: holdDue(fresh.header, [target]),
          prompt: tapPrompt(env.locale, "erase", retry ? "retry" : "member", card),
          expect: { life: "loaded", cards: [hexToBytes(target)], walletId },
          run: async (tap): Promise<RunOutcome> => {
            const id = bytesToHex(tap.cardId);
            let hash = hashes.get(id);
            if (hash === undefined) {
              if (code === undefined) {
                return { status: "need-code", card: tap.shortId };
              }
              hash = await accessHash(code, tap.cardId, env.ctx.platform.argon2id);
              hashes.set(id, hash);
              wipe(code);
              code = undefined;
            }
            const verified = await tap.verify(hash);
            if (!verified.ok) {
              wipe(hash);
              hashes.delete(id);
              return { status: "wrong-code", remaining: verified.remaining };
            }
            decode.empty(await tap.send(cmd.erase()));
            tap.update((d) => {
              if (d.header === undefined || d.body === undefined) {
                return;
              }
              const cards = d.header.cards.filter((c) => c.cardId !== target);
              if (cards.length === 0) {
                // The last card is gone — the whole record goes with it.
                d.header = undefined;
                d.body = undefined;
                d.extra.push({ op: "delete-record", kind: CARD_WALLET_KIND, id: walletId });
                return;
              }
              d.header = { ...d.header, cards };
            });
            return { status: "done" };
          },
        };
      });
      if (outcome.status === "done") {
        break;
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
    return { kind: "erase", walletId } satisfies CardOpResult;
  } finally {
    if (code !== undefined) {
      wipe(code);
    }
    for (const hash of hashes.values()) {
      wipe(hash);
    }
  }
}
