import { bytesToHex } from "@noble/hashes/utils.js";

import type { CardOpResult } from "@qntx/wallet/protocol";

import { walletIdOf } from "../../../derive/wallet-id.ts";
import { KernelError } from "../../../errors.ts";
import { wipe } from "../../../secret/secret.ts";
import { accessHash } from "../protocol/access.ts";
import type { WalletInfo } from "../protocol/decode.ts";
import type { CardOp } from "../tap.ts";
import { accessCodeLabel, tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import {
  ask,
  DEFAULT_GROUPS,
  fetchNodes,
  hashAll,
  missingIn,
  pinnedShortId,
  recordFrom,
  registrationPaths,
  tapRetry,
  walletOf,
} from "./shared.ts";

/**
 * `add` — adopt a card group: code → tap(any loaded non-member): VERIFY → walletId → already-exists
 * gate → the record lands in that tap's commit → registration PUBLIC_KEYs across as many taps of
 * the same card as the budget needs.
 */
export async function* addOp(env: OpEnv, op: { groups?: number }): CardOp {
  const paths = registrationPaths(op.groups ?? DEFAULT_GROUPS);
  const hashes = new Map<string, Uint8Array>();
  let code: Uint8Array | undefined;
  let info: WalletInfo | undefined;
  let presented: Uint8Array | undefined;
  let remaining: number | undefined;
  try {
    // Phase 1: prove the code on any loaded card that belongs to no known wallet. A retry may
    // show a different card — hashes are keyed by cardId, so the op asks the code for it again.
    for (;;) {
      code ??= yield* ask({
        purpose: "access-code",
        secure: "access-code",
        remaining,
        label: accessCodeLabel(env.locale, undefined, remaining),
      });
      // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
      const outcome = yield* tapRetry((retry) => ({
        reason: retry ? "retry" : "any",
        prompt: tapPrompt(env.locale, "add", retry ? "retry" : "any", undefined),
        expect: { life: "loaded" },
        run: async (tap): Promise<RunOutcome> => {
          if (tap.memberOf !== undefined) {
            // Already a member of a record — adding it again is an identity no-op, and the
            // answer comes before any VERIFY so the card never sees a hash.
            throw new KernelError("already-exists", "this card already belongs to a wallet");
          }
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
          const walletId = walletIdOf(verified.info.masterPublicKey);
          if (env.ctx.image.records.some((r) => r.id === walletId)) {
            throw new KernelError("already-exists", "this card's wallet is already in the vault");
          }
          tap.update((d) => {
            const record = recordFrom(env, tap.cardId, verified.info);
            d.header = record.header;
            d.body = record.body;
          });
          ({ info } = verified);
          ({ cardId: presented } = tap);
          return { status: "done" };
        },
      }));
      if (outcome.status === "done") {
        break; // run() resolves `done` only after `info`/`presented` were captured
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
      ({ remaining } = outcome);
    }
    if (presented === undefined || info === undefined) {
      throw new KernelError("integrity", "the verified card was not recorded");
    }
    const walletId = walletIdOf(info.masterPublicKey);
    const only = new Uint8Array(presented);

    // Phase 2: same card only — VERIFY from the remembered hash, then PUBLIC_KEY batches.
    for (;;) {
      const missing = missingIn(env.bodies.get(walletId), paths);
      if (missing.length === 0) {
        break;
      }
      const outcome = yield* tapRetry((retry) => {
        const entry = walletOf(env, walletId);
        const short = pinnedShortId(entry.header, bytesToHex(only));
        return {
          reason: retry ? "retry" : "member",
          card: short,
          prompt: tapPrompt(env.locale, "add", retry ? "retry" : "member", short),
          expect: { life: "loaded", cards: [only], walletId },
          run: async (tap): Promise<RunOutcome> => {
            const id = bytesToHex(tap.cardId);
            const hash = hashes.get(id);
            if (hash === undefined) {
              return { status: "need-code", card: tap.shortId };
            }
            const verified = await tap.verify(hash);
            if (!verified.ok) {
              wipe(hash);
              hashes.delete(id);
              return { status: "wrong-code", remaining: verified.remaining };
            }
            await fetchNodes(tap, missingIn(env.bodies.get(walletId), paths));
            return { status: "done" };
          },
        };
      });
      if (outcome.status === "done") {
        continue;
      }
      if (outcome.status === "need-code" || outcome.status === "wrong-code") {
        const label =
          outcome.status === "need-code"
            ? accessCodeLabel(env.locale, outcome.card, undefined)
            : accessCodeLabel(env.locale, undefined, outcome.remaining);
        code = yield* ask({
          purpose: "access-code",
          secure: "access-code",
          ...(outcome.status === "need-code" ? { card: outcome.card } : {}),
          ...(outcome.status === "wrong-code" ? { remaining: outcome.remaining } : {}),
          label,
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential taps are the design
        await hashAll(env, hashes, code, [only]);
        wipe(code);
        code = undefined;
      }
    }
    return { kind: "add", walletId } satisfies CardOpResult;
  } finally {
    if (code !== undefined) {
      wipe(code);
    }
    for (const hash of hashes.values()) {
      wipe(hash);
    }
  }
}
