import { equalBytes } from "@noble/ciphers/utils.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { withWalletSeed } from "../../../commands/vault.ts";
import { walletIdOf } from "../../../derive/wallet-id.ts";
import { KernelError } from "../../../errors.ts";
import { wipe } from "../../../secret/secret.ts";
import { priceOf } from "../budget.ts";
import { accessHash } from "../protocol/access.ts";
import type { CreateParams } from "../protocol/commands.ts";
import { cmd } from "../protocol/commands.ts";
import type { WalletInfo } from "../protocol/decode.ts";
import { decode } from "../protocol/decode.ts";
import type { CardOp, PendingInput, PendingTap, StepOutcome, TapSession } from "../tap.ts";
import { accessCodeLabel, tapPrompt } from "../text.ts";
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
  PLAN_MARGIN_MS,
  recordFrom,
  registrationPaths,
  tapRetry,
  walletOf,
} from "./shared.ts";
import type { Target } from "./transfer-shared.ts";
import { askShortId, exportTo, installRun, takeOffer, targetFrom } from "./transfer-shared.ts";

type CreateOp = Extract<CardOperation, { kind: "create" }>;

/**
 * `create` — move a wallet onto `op.cards` cards (§11.3). `cards: 1` keeps the single-card imported
 * flow; `cards: 2|3` OFFERs k−1 blank targets in the user's order, CREATEs the source with their
 * card IDs under one access code (each card's access hash derives from that code and its own card
 * ID), EXPORTs to each target and IMPORTs them — the source stays usable and the unfinished targets
 * stay `pending` if the op is abandoned mid-way (`transfer` finishes them).
 */
export async function* createOp(env: OpEnv, op: CreateOp): CardOp {
  if (op.cards === 1) {
    return yield* createOne(env, op);
  }
  return yield* createSet(env, op);
}

/**
 * `create` k=1 — move a vault HD wallet onto one card: short ID → new/confirm code → tap(blank,
 * shortId): CREATE import the 64-byte seed → the record lands in the same commit that deletes
 * `entropy` — then the registration set. A CREATE response lost mid-tap leaves the card LOADED or
 * BLANK; the retry takes life "any" and VERIFYs the same hash to tell them apart.
 */
async function* createOne(env: OpEnv, op: CreateOp): CardOp {
  if (op.source.kind !== "wallet") {
    throw new KernelError("unsupported", "a generated wallet needs at least two cards");
  }
  const sourceId = op.source.walletId;
  const paths = registrationPaths(op.groups ?? DEFAULT_GROUPS);
  const hashes = new Map<string, Uint8Array>();
  let newCode: Uint8Array | undefined;
  let info: WalletInfo | undefined;
  let presented: Uint8Array | undefined;
  try {
    // The printed short ID, re-asked until it parses.
    const typed = yield* askShortId(env.locale);
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
                "wrong-device",
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
              const echoed = decode.created(data, params, tap.cardId);
              // T-CREATE reset the counter — the record owes the card its fresh tries.
              tap.installed(echoed);
              return echoed;
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
      if (outcome.status === "reexport") {
        throw new KernelError("integrity", "a single-card create cannot re-export");
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

/**
 * `create` k=2|3 — §11.3's set flow. Targets are OFFERed first (each a fresh BLANK card named by
 * its typed short ID and excluded from the other slots), then the source is CREATEd with the target
 * IDs in order — generated mode spends 32 bytes of host entropy, imported mode the vault wallet's
 * 64-byte seed. The record lands in the CREATE tap's commit: the source ready, every target
 * `pending` with its OPEN certificate pinned. Later source taps VERIFY under the same code and
 * EXPORT to each target as the plan budget allows; the target taps IMPORT and compare the returned
 * WalletInfo to the record — `done` only once every member is ready.
 */
async function* createSet(env: OpEnv, op: CreateOp): CardOp {
  const generate = op.source.kind === "generate";
  const sourceId = generate ? undefined : op.source.walletId;
  const paths = registrationPaths(op.groups ?? DEFAULT_GROUPS);
  const hashes = new Map<string, Uint8Array>();
  const targets: Target[] = [];
  let newCode: Uint8Array | undefined;
  let sourceCert: Uint8Array | undefined;
  let sourceCard: Uint8Array | undefined;
  let walletId: string | undefined;
  try {
    // OFFER each target in order — a torn OFFER just re-answers the same link key.
    for (let i = 0; i < op.cards - 1; i += 1) {
      const typed = yield* askShortId(env.locale);
      const exclude = targets.map((t) => t.cardId);
      yield* tapRetry((retry) => ({
        reason: retry ? "retry" : "target",
        prompt: tapPrompt(env.locale, "create", retry ? "retry" : "target", typed),
        expect: { life: "blank", shortId: typed, exclude },
        run: async (tap): Promise<RunOutcome> => {
          targets.push(targetFrom(tap, await takeOffer(tap)));
          return { status: "done" };
        },
      }));
    }
    const typedSource = yield* askShortId(env.locale);
    newCode = yield* askNewCode(env);

    /** Stages the card-wallet record — targets pending with their pinned certs. */
    const stage = (tap: TapSession, verified: WalletInfo): void => {
      const wallet = walletIdOf(verified.masterPublicKey);
      if (sourceId !== undefined && wallet !== sourceId) {
        throw new KernelError("wrong-device", "the card's wallet does not match the source wallet");
      }
      // The member list must be exactly this operation's set, in order — a LOADED card that
      // verifies under the same hash but names other members is a wrong card, not this set.
      const expected = [tap.cardId, ...targets.map((t) => t.cardId)];
      if (
        verified.members.length !== expected.length ||
        !verified.members.every((m, i) => equalBytes(m, expected[i] ?? m))
      ) {
        throw new KernelError("wrong-device", "the card's member list does not match this set");
      }
      if (generate && verified.origin !== "generated") {
        throw new KernelError("wrong-device", "the card's wallet was not generated");
      }
      if (!generate && verified.origin !== "imported") {
        throw new KernelError("wrong-device", "the card's wallet was not imported");
      }
      walletId = wallet;
      const id = bytesToHex(tap.cardId);
      const hash = hashes.get(id);
      tap.update((d) => {
        const record = recordFrom(
          env,
          tap.cardId,
          verified,
          op.remember === true && hash !== undefined ? { [id]: bytesToHex(hash) } : undefined,
        );
        const header = {
          ...record.header,
          cards: record.header.cards.map((card) => {
            const target = targets.find((t) => bytesToHex(t.cardId) === card.cardId);
            return target === undefined
              ? card
              : { cardId: card.cardId, cert: bytesToHex(target.cert), state: "pending" as const };
          }),
        };
        d.header = header;
        d.body = record.body;
        if (sourceId !== undefined) {
          d.extra.push({ op: "delete-record", kind: "entropy", id: sourceId });
          for (const module of env.ctx.modules) {
            d.extra.push(...module.walletDeleteOps(env.ctx.image, sourceId));
          }
        }
      });
    };

    /** Pending source-side work — exports the plan still affords, after the nodes it affords. */
    const work = async (tap: TapSession): Promise<void> => {
      if (walletId !== undefined) {
        await fetchNodes(tap, missingIn(env.bodies.get(walletId), paths), env.planMs);
      }
      for (const target of targets) {
        if (target.transfer !== undefined) {
          continue;
        }
        const cost = tap.cost() + priceOf("export-head") + priceOf("export-payload");
        if (cost > env.planMs - PLAN_MARGIN_MS) {
          break;
        }
        const hashT = hashes.get(bytesToHex(target.cardId));
        if (hashT === undefined) {
          continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- exports are strictly sequential
        target.transfer = await exportTo(tap, target, hashT);
      }
    };

    // Source taps: the first CREATEs (or confirms a lost CREATE), the rest VERIFY and work.
    for (;;) {
      const ready =
        sourceCard !== undefined &&
        walletId !== undefined &&
        targets.every((t) => t.transfer !== undefined) &&
        missingIn(env.bodies.get(walletId), paths).length === 0;
      if (ready) {
        break;
      }
      // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
      const outcome = yield* tapRetry((retry) => ({
        reason: retry ? "retry" : "source",
        prompt: tapPrompt(
          env.locale,
          "create",
          retry ? "retry" : "source",
          sourceCard === undefined ? typedSource : undefined,
        ),
        expect:
          sourceCard === undefined
            ? {
                // The retry may find the card LOADED — CREATE committed but its response was lost.
                life: retry ? "any" : "blank",
                shortId: typedSource,
                exclude: targets.map((t) => t.cardId),
              }
            : { life: "loaded", cards: [sourceCard], walletId },
        run: async (tap): Promise<RunOutcome> => {
          const id = bytesToHex(tap.cardId);
          if (!hashes.has(id)) {
            if (newCode === undefined) {
              return { status: "need-code", card: tap.shortId };
            }
            const code = newCode;
            newCode = undefined;
            await hashAll(env, hashes, code, [tap.cardId, ...targets.map((t) => t.cardId)]);
            wipe(code);
          }
          const hash = hashes.get(id);
          if (hash === undefined) {
            return { status: "need-code", card: tap.shortId };
          }
          if (sourceCard !== undefined) {
            // Continuation tap: VERIFY, then whatever work the plan still affords.
            const verified = await tap.verify(hash);
            if (!verified.ok) {
              return { status: "wrong-code", remaining: verified.remaining };
            }
            await work(tap);
            return { status: "done" };
          }
          if (tap.status.life === "loaded") {
            // A lost CREATE response — VERIFY under the same hash and accept only this set.
            const confirmed = await tap.verify(hash);
            if (!confirmed.ok) {
              wipe(hash);
              hashes.delete(id);
              return { status: "wrong-code", remaining: confirmed.remaining };
            }
            stage(tap, confirmed.info);
            tap.installed(confirmed.info);
          } else if (generate) {
            const params: CreateParams = {
              mode: "generate",
              accessHash: hash,
              entropy: env.ctx.platform.random(32),
              others: targets.map((t) => t.cardId),
            };
            try {
              const echoed = decode.created(await tap.send(cmd.create(params)), params, tap.cardId);
              tap.installed(echoed);
              stage(tap, echoed);
            } finally {
              wipe(params.entropy);
            }
          } else {
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
                const build: CreateParams = {
                  mode: "import",
                  accessHash: hash,
                  seed,
                  others: targets.map((t) => t.cardId),
                };
                const echoed = decode.created(await tap.send(cmd.create(build)), build, tap.cardId);
                tap.installed(echoed);
                return echoed;
              },
            );
            stage(tap, created);
            ({ cardId: sourceCard, cert: sourceCert } = tap);
            await work(tap);
            return { status: "done" };
          }
          ({ cardId: sourceCard, cert: sourceCert } = tap);
          await work(tap);
          return { status: "done" };
        },
      }));
      if (outcome.status === "done") {
        continue;
      }
      if (outcome.status === "reexport") {
        throw new KernelError("integrity", "a source tap cannot re-export");
      }
      if (outcome.status === "need-code") {
        newCode = yield* askNewCode(env);
        continue;
      }
      // A torn CREATE sealed under a different code — re-ask the code the card actually has.
      const { remaining } = outcome;
      const asked = yield* ask({
        purpose: "access-code",
        secure: "access-code",
        remaining,
        label: accessCodeLabel(env.locale, undefined, remaining),
      });
      const old = sourceCard === undefined ? undefined : hashes.get(bytesToHex(sourceCard));
      if (old !== undefined) {
        wipe(old);
        hashes.delete(bytesToHex(sourceCard ?? new Uint8Array()));
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- KDF work is serialized on purpose
      await hashAll(env, hashes, asked, [
        ...(sourceCard === undefined ? [] : [sourceCard]),
        ...targets.map((t) => t.cardId),
      ]);
      wipe(asked);
    }

    if (sourceCard === undefined || sourceCert === undefined || walletId === undefined) {
      throw new KernelError("integrity", "the created card was not recorded");
    }
    const own = sourceCard;
    const cert = sourceCert;
    const wid = walletId;

    /** One source tap that (re-)exports `target` — VERIFY under the source hash first. */
    async function* reExport(
      target: Target,
    ): AsyncGenerator<PendingInput | PendingTap, void, StepOutcome | undefined> {
      for (;;) {
        const outcome = yield* tapRetry((retry) => {
          const entry = walletOf(env, wid);
          const short = pinnedShortId(entry.header, bytesToHex(own));
          return {
            reason: retry ? "retry" : "source",
            card: short,
            hold: holdDue(entry.header, entry.header.members),
            prompt: tapPrompt(env.locale, "create", retry ? "retry" : "source", short),
            expect: { life: "loaded", cards: [own], walletId: wid },
            run: async (tap): Promise<RunOutcome> => {
              const hashS = hashes.get(bytesToHex(tap.cardId));
              if (hashS === undefined) {
                return { status: "need-code", card: tap.shortId };
              }
              const verified = await tap.verify(hashS);
              if (!verified.ok) {
                return { status: "wrong-code", remaining: verified.remaining };
              }
              const hashT = hashes.get(bytesToHex(target.cardId));
              if (hashT === undefined) {
                return { status: "need-code", card: target.shortId };
              }
              target.transfer = await exportTo(tap, target, hashT);
              return { status: "done" };
            },
          };
        });
        if (outcome.status === "done") {
          return;
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
        const old = hashes.get(bytesToHex(own));
        if (outcome.status === "wrong-code" && old !== undefined) {
          wipe(old);
          hashes.delete(bytesToHex(own));
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential KDF
        await hashAll(env, hashes, asked, [own, target.cardId]);
        wipe(asked);
      }
    }

    // Target taps: IMPORT each pending member; done only once every member is ready.
    for (const target of targets) {
      for (;;) {
        const outcome = yield* tapRetry((retry) => {
          void walletOf(env, wid);
          return {
            reason: retry ? "retry" : "target",
            card: target.shortId,
            prompt: tapPrompt(env.locale, "create", retry ? "retry" : "target", target.shortId),
            expect: {
              // A committed install or a foreign wallet leaves the target LOADED — any life.
              life: "any",
              cards: [target.cardId],
              shortId: target.shortId,
              walletId: wid,
            },
            run: async (tap) =>
              installRun({
                tap,
                target,
                sourceCert: cert,
                hashT: () => hashes.get(bytesToHex(target.cardId)),
                entry: walletOf(env, wid),
              }),
          };
        });
        if (outcome.status === "done") {
          break;
        }
        if (outcome.status === "reexport") {
          // The target lost its offer — re-offer was taken on the spot; re-export it.
          yield* reExport(target);
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
        const old = hashes.get(bytesToHex(target.cardId));
        if (outcome.status === "wrong-code" && old !== undefined) {
          wipe(old);
          hashes.delete(bytesToHex(target.cardId));
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential KDF
        await hashAll(env, hashes, asked, [target.cardId]);
        wipe(asked);
      }
    }
    return { kind: "create", walletId: wid } satisfies CardOpResult;
  } finally {
    if (newCode !== undefined) {
      wipe(newCode);
    }
    for (const hash of hashes.values()) {
      wipe(hash);
    }
    for (const target of targets) {
      if (target.transfer !== undefined) {
        wipe(target.transfer.payload);
      }
    }
  }
}
