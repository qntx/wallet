import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { KernelError } from "../../../errors.ts";
import { wipe } from "../../../secret/secret.ts";
import { accessHash } from "../protocol/access.ts";
import { cmd } from "../protocol/commands.ts";
import { decode } from "../protocol/decode.ts";
import type { CardOp } from "../tap.ts";
import { accessCodeLabel, tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import {
  ask,
  askNewCode,
  holdDue,
  lowestTries,
  pinnedShortId,
  tapRetry,
  walletOf,
} from "./shared.ts";

/**
 * `change-access` — old + new + confirm inputs, then per member VERIFY(old) → CHANGE(new). A CHANGE
 * response lost mid-tap retries VERIFY(new) first — the code may already be changed, and that probe
 * costs the card one attempt, which the retry label warns about.
 */
export async function* changeAccessOp(
  env: OpEnv,
  op: Extract<CardOperation, { kind: "change-access" }>,
): CardOp {
  const { walletId } = op;
  const oldHashes = new Map<string, Uint8Array>();
  const newHashes = new Map<string, Uint8Array>();
  const changeSent = new Set<string>();
  let oldCode: Uint8Array | undefined;
  let newCode: Uint8Array | undefined;
  try {
    const first = walletOf(env, walletId);
    const remaining = lowestTries(first.header, first.header.members);
    oldCode = yield* ask({
      purpose: "access-code",
      secure: "access-code",
      remaining,
      label: accessCodeLabel(env.locale, undefined, remaining),
    });
    newCode = yield* askNewCode(env);
    const done = new Set<string>();
    for (;;) {
      let lastCard: string | undefined;
      const wallet = walletOf(env, walletId);
      if (wallet.header.members.every((m) => done.has(m))) {
        break;
      }
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
          prompt: tapPrompt(env.locale, "change-access", retry ? "retry" : "member", short),
          expect: {
            life: "loaded",
            cards: undone.map(hexToBytes),
            exclude: [...done].map(hexToBytes),
            walletId,
          },
          run: async (tap): Promise<RunOutcome> => {
            const id = bytesToHex(tap.cardId);
            lastCard = id;
            if (oldCode === undefined && !oldHashes.has(id)) {
              return { status: "need-code", card: tap.shortId };
            }
            if (oldCode !== undefined) {
              // Every member's old and new hashes, then both codes die — a re-asked old code
              // only ever recomputes old hashes; the new hashes already exist by then.
              const { argon2id } = env.ctx.platform;
              for (const member of walletOf(env, walletId).header.members) {
                const idBytes = hexToBytes(member);
                if (!oldHashes.has(member)) {
                  // oxlint-disable-next-line eslint/no-await-in-loop -- one KDF at a time keeps memory bounded
                  oldHashes.set(member, await accessHash(oldCode, idBytes, argon2id));
                }
              }
              for (const member of walletOf(env, walletId).header.members) {
                const idBytes = hexToBytes(member);
                if (!newHashes.has(member) && newCode !== undefined) {
                  // oxlint-disable-next-line eslint/no-await-in-loop -- one KDF at a time keeps memory bounded
                  newHashes.set(member, await accessHash(newCode, idBytes, argon2id));
                }
              }
              wipe(oldCode);
              oldCode = undefined;
              if (newCode !== undefined) {
                wipe(newCode);
                newCode = undefined;
              }
            }
            const oldHash = oldHashes.get(id);
            const newHash = newHashes.get(id);
            if (oldHash === undefined || newHash === undefined) {
              throw new KernelError("integrity", "member hash was not derived");
            }
            // A lost CHANGE may have committed anyway — the card could already take the new
            // hash. Probe it first; the failed probe costs one attempt, which the label warns.
            if (changeSent.has(id)) {
              const probe = await tap.verify(newHash);
              if (probe.ok) {
                return { status: "done" };
              }
            }
            const verified = await tap.verify(oldHash);
            if (!verified.ok) {
              return { status: "wrong-code", remaining: verified.remaining };
            }
            changeSent.add(id);
            decode.empty(await tap.send(cmd.change(newHash)));
            tap.update((d) => {
              if (d.body !== undefined) {
                const access =
                  op.remember === true
                    ? { ...d.body.access, [id]: bytesToHex(newHash) }
                    : Object.fromEntries(
                        Object.entries(d.body.access ?? {}).filter(([key]) => key !== id),
                      );
                d.body = {
                  master: d.body.master,
                  nodes: d.body.nodes,
                  ed25519: d.body.ed25519,
                  ephemerals: d.body.ephemerals,
                  ...(Object.keys(access).length === 0 ? {} : { access }),
                };
              }
            });
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
        oldCode = yield* ask({
          purpose: "access-code",
          secure: "access-code",
          card: outcome.card,
          label: accessCodeLabel(env.locale, outcome.card, undefined),
        });
        continue;
      }
      // Wrong old code: every old hash is equally wrong — wipe them all and re-ask.
      for (const hash of oldHashes.values()) {
        wipe(hash);
      }
      oldHashes.clear();
      const again = outcome.remaining;
      oldCode = yield* ask({
        purpose: "access-code",
        secure: "access-code",
        remaining: again,
        label: accessCodeLabel(env.locale, undefined, again),
      });
    }
    return { kind: "change-access", walletId } satisfies CardOpResult;
  } finally {
    if (oldCode !== undefined) {
      wipe(oldCode);
    }
    if (newCode !== undefined) {
      wipe(newCode);
    }
    for (const hash of oldHashes.values()) {
      wipe(hash);
    }
    for (const hash of newHashes.values()) {
      wipe(hash);
    }
  }
}
