import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { wipe } from "../../../secret/secret.ts";
import { accountFor } from "../../chains/index.ts";
import { changeMark } from "../../chains/marks.ts";
import { BTC_PURPOSE } from "../../chains/shared.ts";
import type { CardOp } from "../tap.ts";
import { accessCodeLabel, tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import {
  ask,
  fetchNodes,
  hashAll,
  holdDue,
  lowestTries,
  missingIn,
  neededPaths,
  savedAccess,
  tapRetry,
  walletOf,
} from "./shared.ts";

/** `accounts` — VERIFY on a member, fetch the missing nodes, answer from the fresh cache. */
export async function* accountsOp(
  env: OpEnv,
  op: Extract<CardOperation, { kind: "accounts" }>,
): CardOp {
  const { walletId } = op;
  const paths = neededPaths(op.templates, op.groupIndex, op.network);
  const hashes = new Map<string, Uint8Array>();
  let code: Uint8Array | undefined;
  try {
    const wallet = walletOf(env, walletId);
    const saved = savedAccess(env, walletId);
    if (!wallet.header.members.every((m) => saved[m] !== undefined)) {
      const remaining = lowestTries(wallet.header, wallet.header.members);
      code = yield* ask({
        purpose: "access-code",
        secure: "access-code",
        remaining,
        label: accessCodeLabel(env.locale, undefined, remaining),
      });
    }
    for (;;) {
      if (missingIn(env.bodies.get(walletId), paths).length === 0) {
        break;
      }
      // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state shared across retries
      const outcome = yield* tapRetry((retry) => {
        const fresh = walletOf(env, walletId);
        return {
          reason: retry ? "retry" : "member",
          hold: holdDue(fresh.header, fresh.header.members),
          prompt: tapPrompt(env.locale, "accounts", retry ? "retry" : "member", undefined),
          expect: {
            life: "loaded",
            cards: fresh.header.members.map(hexToBytes),
            walletId,
          },
          run: async (tap): Promise<RunOutcome> => {
            const id = bytesToHex(tap.cardId);
            let hash = hashes.get(id);
            if (hash === undefined) {
              const remembered = savedAccess(env, walletId)[id];
              if (remembered !== undefined) {
                hash = hexToBytes(remembered);
                hashes.set(id, hash);
              } else if (code === undefined) {
                return { status: "need-code", card: tap.shortId };
              } else {
                await hashAll(env, hashes, code, fresh.header.members.map(hexToBytes));
                wipe(code);
                code = undefined;
                hash = hashes.get(id);
              }
            }
            if (hash === undefined) {
              return { status: "need-code", card: tap.shortId };
            }
            const verified = await tap.verify(hash);
            if (!verified.ok) {
              wipe(hash);
              hashes.delete(id);
              // A saved hash that just failed is stale — the record drops it in this commit.
              tap.update((d) => {
                if (d.body?.access !== undefined && d.body.access[id] !== undefined) {
                  const access = Object.fromEntries(
                    Object.entries(d.body.access).filter(([key]) => key !== id),
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
      if (outcome.status === "need-code") {
        code = yield* ask({
          purpose: "access-code",
          secure: "access-code",
          card: outcome.card,
          label: accessCodeLabel(env.locale, outcome.card, undefined),
        });
        continue;
      }
      code = yield* ask({
        purpose: "access-code",
        secure: "access-code",
        remaining: outcome.remaining,
        label: accessCodeLabel(env.locale, undefined, outcome.remaining),
      });
    }
    const material = env.ctx.externalMaterial(walletOf(env, walletId).record);
    const accounts = [];
    for (const template of op.templates) {
      const purpose = BTC_PURPOSE[template];
      const mark =
        purpose === undefined
          ? 0
          : changeMark(env.ctx.image, walletId, op.groupIndex, purpose, op.network);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential material lookups
      accounts.push(await accountFor(material, template, op.network, op.groupIndex, mark));
    }
    return { kind: "accounts", accounts } satisfies CardOpResult;
  } finally {
    if (code !== undefined) {
      wipe(code);
    }
    for (const hash of hashes.values()) {
      wipe(hash);
    }
  }
}
