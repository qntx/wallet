import { bytesToHex } from "@noble/hashes/utils.js";

import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { withWalletSeed } from "../../../commands/vault.ts";
import { walletIdOf } from "../../../derive/wallet-id.ts";
import { KernelError } from "../../../errors.ts";
import { wipe } from "../../../secret/secret.ts";
import { accessHash } from "../protocol/access.ts";
import type { CreateParams } from "../protocol/commands.ts";
import { cmd } from "../protocol/commands.ts";
import type { WalletInfo } from "../protocol/decode.ts";
import { decode } from "../protocol/decode.ts";
import type { CardOp } from "../tap.ts";
import { accessCodeLabel, shortIdLabel, tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import {
  ask,
  askNewCode,
  DEFAULT_GROUPS,
  fetchNodes,
  hashAll,
  holdDue,
  missingIn,
  pinnedShortId,
  recordFrom,
  registrationPaths,
  tapRetry,
  walletOf,
} from "./shared.ts";

/**
 * `create` k=1 — move a vault HD wallet onto one card: short ID → new/confirm code → tap(blank,
 * shortId): CREATE import the 64-byte seed → the record lands in the same commit that deletes
 * `entropy` — then the registration set. A CREATE response lost mid-tap leaves the card LOADED or
 * BLANK; the retry takes life "any" and VERIFYs the same hash to tell them apart.
 */
export async function* createOp(
  env: OpEnv,
  op: Extract<CardOperation, { kind: "create" }>,
): CardOp {
  if (op.source.kind !== "wallet") {
    throw new KernelError("unsupported", "card-generated wallets arrive in a later build");
  }
  const sourceId = op.source.walletId;
  const paths = registrationPaths(op.groups ?? DEFAULT_GROUPS);
  const hashes = new Map<string, Uint8Array>();
  let newCode: Uint8Array | undefined;
  let info: WalletInfo | undefined;
  let presented: Uint8Array | undefined;
  try {
    // The printed short ID, re-asked until it parses.
    let typed: string | undefined;
    while (typed === undefined) {
      const raw = yield* ask({
        purpose: "short-id",
        secure: "short-id",
        label: shortIdLabel(env.locale),
      });
      const text = new TextDecoder().decode(raw);
      wipe(raw);
      if (/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(text)) {
        typed = text;
      }
    }
    newCode = yield* askNewCode(env);
    let walletId: string | undefined;
    for (;;) {
      // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
      const outcome = yield* tapRetry((retry) => ({
        reason: retry ? "retry" : "source",
        prompt: tapPrompt(env.locale, "create", retry ? "retry" : "source", typed),
        expect: {
          // The retry may find the card LOADED — CREATE committed but its response was lost.
          life: retry ? "any" : "blank",
          shortId: typed,
          walletId,
        },
        run: async (tap): Promise<RunOutcome> => {
          const id = bytesToHex(tap.cardId);
          let hash = hashes.get(id);
          if (hash === undefined) {
            if (newCode === undefined) {
              return { status: "need-code", card: tap.shortId };
            }
            hash = await accessHash(newCode, tap.cardId, env.ctx.platform.argon2id);
            hashes.set(id, hash);
            wipe(newCode);
            newCode = undefined;
          }
          /** The card-wallet record plus the entropy deletion — staged in this tap's commit. */
          const stage = (verified: WalletInfo): void => {
            const wallet = walletIdOf(verified.masterPublicKey);
            if (wallet !== sourceId) {
              // A LOADED card that verifies but holds a different wallet is not the card this
              // import was started on — refuse rather than record it or drop the source.
              throw new KernelError(
                "wrong-card",
                "the card's wallet does not match the source wallet",
              );
            }
            walletId = wallet;
            tap.update((d) => {
              const record = recordFrom(
                env,
                tap.cardId,
                verified,
                op.remember === true ? { [id]: bytesToHex(hash) } : undefined,
              );
              d.header = record.header;
              d.body = record.body;
              d.extra.push({ op: "delete-record", kind: "entropy", id: sourceId });
              for (const module of env.ctx.modules) {
                d.extra.push(...module.walletDeleteOps(env.ctx.image, sourceId));
              }
            });
          };
          if (tap.status.life === "loaded") {
            // A previous CREATE committed but its response was lost — VERIFY with the same
            // hash confirms the wallet, then the record is staged as if CREATE just ran.
            const confirmed = await tap.verify(hash);
            if (!confirmed.ok) {
              wipe(hash);
              hashes.delete(id);
              return { status: "wrong-code", remaining: confirmed.remaining };
            }
            stage(confirmed.info);
            ({ info } = confirmed);
            ({ cardId: presented } = tap);
            return { status: "done" };
          }
          const { dek } = env.ctx.session.current();
          const source = env.ctx.image.records.find(
            (r) => r.kind === "entropy" && r.id === sourceId,
          );
          if (source === undefined) {
            throw new KernelError("not-found", "the source wallet is gone");
          }
          const created = await withWalletSeed(
            env.ctx.platform.pbkdf2,
            dek,
            source,
            async (seed) => {
              const params: CreateParams = {
                mode: "import",
                accessHash: hash,
                seed,
                others: [],
              };
              const data = await tap.send(cmd.create(params));
              return decode.created(data, params, tap.cardId);
            },
          );
          stage(created);
          info = created;
          ({ cardId: presented } = tap);
          return { status: "done" };
        },
      }));
      if (outcome.status === "done") {
        break;
      }
      if (outcome.status === "need-code") {
        newCode = yield* askNewCode(env);
        continue;
      }
      // LOADED but the remembered hash fails — a torn CREATE sealed under a different code
      // than the user meant, or a card someone else loaded. Re-asking for the code the card
      // actually has is the only honest path.
      const { remaining } = outcome;
      newCode = yield* ask({
        purpose: "access-code",
        secure: "access-code",
        remaining,
        label: accessCodeLabel(env.locale, undefined, remaining),
      });
    }
    if (presented === undefined || info === undefined) {
      throw new KernelError("integrity", "the created card was not recorded");
    }
    const walletIdFinal = walletIdOf(info.masterPublicKey);
    const only = new Uint8Array(presented);
    // Registration set — same card, VERIFY from the remembered hash on every tap.
    for (;;) {
      if (missingIn(env.bodies.get(walletIdFinal), paths).length === 0) {
        break;
      }
      const outcome = yield* tapRetry((retry) => {
        const entry = walletOf(env, walletIdFinal);
        const short = pinnedShortId(entry.header, bytesToHex(only));
        return {
          reason: retry ? "retry" : "member",
          card: short,
          hold: holdDue(entry.header, entry.header.members),
          prompt: tapPrompt(env.locale, "create", retry ? "retry" : "member", short),
          expect: { life: "loaded", cards: [only], walletId: walletIdFinal },
          run: async (tap): Promise<RunOutcome> => {
            const id = bytesToHex(tap.cardId);
            const hash = hashes.get(id);
            if (hash === undefined) {
              return { status: "need-code", card: tap.shortId };
            }
            const verified = await tap.verify(hash);
            if (!verified.ok) {
              return { status: "wrong-code", remaining: verified.remaining };
            }
            await fetchNodes(tap, missingIn(env.bodies.get(walletIdFinal), paths));
            return { status: "done" };
          },
        };
      });
      if (outcome.status === "done") {
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
      if (outcome.status === "wrong-code") {
        const old = hashes.get(bytesToHex(only));
        if (old !== undefined) {
          wipe(old);
          hashes.delete(bytesToHex(only));
        }
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential taps are the design
      await hashAll(env, hashes, asked, [only]);
      wipe(asked);
    }
    return { kind: "create", walletId: walletIdFinal } satisfies CardOpResult;
  } finally {
    if (newCode !== undefined) {
      wipe(newCode);
    }
    for (const hash of hashes.values()) {
      wipe(hash);
    }
  }
}
