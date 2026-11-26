/**
 * The `sign` operation (design §8): `chain.sign`'s prepare on the card wallet's public material —
 * the same intent, the same plan, the same assemble — with the signing done by
 * `modules/card/backend.ts` on the card. Tasks are grouped by their master fingerprint's card ID,
 * greedily packed into taps under the per-tap budget, and a lost tap retries without re-sending
 * anything the card already signed (the signatures and the `r` history live in op locals).
 *
 * Re-prompting rule (design §8): one approval covers the frozen plan — a resumed tap signs only the
 * plan's still-unsigned tasks, never asks for the verify factor again, and asks for the access code
 * again only after a wrong-code answer (each card's access hash lives in op locals until then).
 * After the first successful VERIFY later taps accept only that card.
 */
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { ChainError } from "@qntx/wallet-chains";
import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { KernelError } from "../../../errors.ts";
import type { KeystorePrompt } from "../../../platform.ts";
import { promptLocale } from "../../../prompts.ts";
import type { Secret } from "../../../secret/secret.ts";
import { wipe } from "../../../secret/secret.ts";
import { assertFiat24Deadline } from "../../chains/evm.ts";
import { prepareApproval } from "../../chains/index.ts";
import { chainPrompt } from "../../chains/prompt.ts";
import type { PromptIntent } from "../../chains/prompt.ts";
import { assembleChain } from "../../chains/run.ts";
import type { ChainPlan } from "../../chains/run.ts";
import { signTask, taskPrice } from "../backend.ts";
import { PRICE_OPEN, priceOf } from "../budget.ts";
import { accessHash } from "../protocol/access.ts";
import { ACCESS_LIMITS } from "../protocol/status.ts";
import type { CardOp, PendingInput, PendingTap, StepOutcome } from "../tap.ts";
import { PROMPT_LIMIT } from "../tap.ts";
import { accessCodeLabel, signCardLine, tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import {
  ask,
  holdDue,
  lowestTries,
  PLAN_MARGIN_MS,
  pinnedShortId,
  savedAccess,
  tapRetry,
  walletOf,
} from "./shared.ts";

/**
 * What `card.begin` computed for a sign op — the approved plan plus the texts and prompts the steps
 * need, so the generator only ever resumes, never re-prepares.
 */
export type SignPrepared = {
  readonly walletId: string;
  readonly prompt: PromptIntent;
  readonly plan: ChainPlan;
  readonly verifyPrompt: () => KeystorePrompt;
  readonly tapText: string;
  /** Raises to the sealed change marks — committed after verification, before the first tap. */
  readonly changeMarks?: {
    readonly groupIndex: number;
    readonly network: string;
    readonly raises: ReadonlyArray<{ readonly purpose: number; readonly index: number }>;
  };
};

/** A 7702 stage-1 plan signs the authorization, then the envelope under the same account. */
const isTwoStage = (plan: ChainPlan): boolean =>
  plan.kind === "evm.transaction" &&
  "authorization" in plan &&
  plan.authorization === undefined &&
  plan.tx.type === "eip7702";

/** Greedy pack: how many taps `prices` need at `budget`, the first tap also paying `waits`. */
const estimateTaps = (prices: ReadonlyArray<number>, waits: number, budget: number): number => {
  let taps = 0;
  let spent = 0;
  for (const price of prices) {
    if (spent === 0) {
      taps += 1;
      spent = PRICE_OPEN + priceOf("verify") + (taps === 1 ? waits : 0);
    }
    if (spent + price + PLAN_MARGIN_MS > budget) {
      taps += 1;
      spent = PRICE_OPEN + priceOf("verify");
    }
    spent += price;
  }
  return taps;
};

/**
 * The sign op's begin-time work (design §8): wallet lookup, `prepareApproval` on the card's public
 * material — every miss is `device-required`, and the same normalize/ownership/agent checks
 * `chain.sign` runs — then the prompt the reader shows (`chainPrompt`'s title + description plus a
 * card line, ≤ 1024 UTF-8 bytes) and the budget bounds: every task must fit an empty tap and the
 * whole plan — a 7702's two stages included — at most two taps.
 */
export const prepareSign = async (
  env: OpEnv,
  op: Extract<CardOperation, { kind: "sign" }>,
  dek: Secret,
): Promise<SignPrepared> => {
  const { request } = op;
  if (request.account.kind !== "hd") {
    throw new KernelError("invalid-input", "only an hd account signs on a card");
  }
  const { walletId } = request.account;
  const { header, record } = walletOf(env, walletId);
  const material = env.ctx.externalMaterial(record);
  if (request.kind === "solana.message" && request.message.length > 16_384) {
    throw new KernelError("card-unsupported", "the message is too large for the card");
  }
  // A card pin confirms every entry by construction ("all") — there is nothing to acknowledge.
  const prepared = await prepareApproval(env.ctx, request, material, dek, false);
  const keystore = chainPrompt(env.locale, prepared.prompt);
  const cards = header.cards
    .map((c) => pinnedShortId(header, c.cardId))
    .filter((s): s is string => s !== undefined);
  const tapText = `${keystore.title}\n${keystore.description}\n${signCardLine(env.locale, cards)}`;
  if (utf8ToBytes(tapText).length > PROMPT_LIMIT) {
    throw new KernelError("card-unsupported", "the signing text is too long for the reader");
  }
  const budget = env.planMs;
  const waits = holdDue(header, header.members) ? ACCESS_LIMITS.waits * priceOf("wait") : 0;
  const base = PRICE_OPEN + priceOf("verify") + waits;
  for (const task of prepared.plan.tasks) {
    if (base + taskPrice(task) + PLAN_MARGIN_MS > budget) {
      throw new KernelError("card-unsupported", "a signing task does not fit one tap");
    }
  }
  const prices = prepared.plan.tasks.map(taskPrice);
  if (isTwoStage(prepared.plan)) {
    prices.push(priceOf("sign-ecdsa"));
  }
  if (estimateTaps(prices, waits, budget) > 2) {
    throw new KernelError("card-unsupported", "the signing plan needs more than two taps");
  }
  return {
    walletId,
    prompt: prepared.prompt,
    plan: prepared.plan,
    verifyPrompt: () =>
      prepared.shown?.prompt ??
      chainPrompt(promptLocale(env.ctx.platform.keystore?.locale ?? "en"), prepared.prompt),
    tapText,
    ...(request.kind === "bitcoin.psbt" && prepared.changeMarks !== undefined
      ? {
          changeMarks: {
            groupIndex: request.account.groupIndex,
            network: request.network,
            raises: prepared.changeMarks,
          },
        }
      : {}),
  };
};

type PendingItem = { readonly index: number; readonly task: ChainPlan["tasks"][number] };

// oxlint-disable typescript/require-await -- the op body only `yield*`s; the awaits live in `run`.
export const signOp = (
  env: OpEnv,
  op: Extract<CardOperation, { kind: "sign" }>,
  prepared: SignPrepared,
): CardOp =>
  (async function* (): AsyncGenerator<
    PendingInput | PendingTap,
    CardOpResult,
    StepOutcome | undefined
  > {
    const { walletId, tapText } = prepared;
    const hashes = new Map<string, Uint8Array>();
    /**
     * `r` values the card already produced this op — member cards share the seed, so a repeated r
     * on any of them is nonce reuse. Spans taps, retries and continuation stages.
     */
    const previousR: Uint8Array[] = [];
    /** The card the first successful VERIFY bound this approval to — later taps accept only it. */
    let boundCard: Uint8Array | undefined;
    let boundShort: string | undefined;
    let code: Uint8Array | undefined;
    try {
      const material = env.ctx.externalMaterial(walletOf(env, walletId).record);
      const saved = (): Readonly<Record<string, string>> => savedAccess(env, walletId);
      {
        const { header } = walletOf(env, walletId);
        if (!header.members.every((id) => saved()[id] !== undefined)) {
          code = yield* ask({
            purpose: "access-code",
            secure: "access-code",
            remaining: lowestTries(header, header.members),
            label: accessCodeLabel(env.locale, undefined, lowestTries(header, header.members)),
          });
        }
      }
      let current = prepared.plan;
      for (;;) {
        // Any member signs any task — every card of this wallet holds the same seed.
        const pending: PendingItem[] = current.tasks.map((task, index) => ({ index, task }));
        const signatures: Uint8Array[] = [];
        while (pending.length > 0) {
          // oxlint-disable-next-line eslint/no-loop-func -- op locals are the resumable state
          const outcome = yield* tapRetry((retry) => {
            const fresh = walletOf(env, walletId);
            // The fiat24 window is re-checked before every tap, as the vault path re-checks it
            // after the verify prompt (design §8).
            if (op.request.kind === "evm.fiat24-session") {
              assertFiat24Deadline(op.request, env.ctx.platform.now());
            }
            const bound =
              boundCard === undefined ? fresh.header.members.map(hexToBytes) : [boundCard];
            return {
              reason: retry ? "retry" : "member",
              hold: holdDue(fresh.header, fresh.header.members),
              ...(boundShort === undefined ? {} : { card: boundShort }),
              prompt: retry
                ? tapPrompt(
                    env.locale,
                    "sign",
                    "retry",
                    boundShort ??
                      fresh.header.cards
                        .map((c) => pinnedShortId(fresh.header, c.cardId))
                        .find((s) => s !== undefined),
                  )
                : tapText,
              expect: {
                life: "loaded",
                cards: bound,
                walletId,
              },
              run: async (tap): Promise<RunOutcome> => {
                const cardIdHex = bytesToHex(tap.cardId);
                let hash = hashes.get(cardIdHex);
                if (hash === undefined) {
                  const remembered = saved()[cardIdHex];
                  if (remembered !== undefined) {
                    hash = hexToBytes(remembered);
                    hashes.set(cardIdHex, hash);
                  } else if (code === undefined) {
                    return { status: "need-code", card: tap.shortId };
                  } else {
                    hash = await accessHash(code, tap.cardId, env.ctx.platform.argon2id);
                    wipe(code);
                    code = undefined;
                    hashes.set(cardIdHex, hash);
                  }
                }
                const verified = await tap.verify(hash);
                if (verified.ok) {
                  // First successful VERIFY binds the approval to this card (design §8 (b)).
                  boundCard = tap.cardId;
                  boundShort = tap.shortId;
                } else {
                  wipe(hash);
                  hashes.delete(cardIdHex);
                  // A saved hash that just failed is stale — the record drops it in this commit.
                  tap.update((d) => {
                    if (d.body?.access !== undefined && d.body.access[cardIdHex] !== undefined) {
                      const access = Object.fromEntries(
                        Object.entries(d.body.access).filter(([key]) => key !== cardIdHex),
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
                if (op.remember === true) {
                  const savedHash = bytesToHex(hash);
                  tap.update((d) => {
                    if (d.body !== undefined) {
                      d.body = {
                        ...d.body,
                        access: { ...d.body.access, [cardIdHex]: savedHash },
                      };
                    }
                  });
                }
                for (;;) {
                  const [item] = pending;
                  if (
                    item === undefined ||
                    tap.cost() + taskPrice(item.task) + PLAN_MARGIN_MS > env.planMs
                  ) {
                    break;
                  }
                  // oxlint-disable-next-line eslint/no-await-in-loop -- card commands are sequential
                  signatures[item.index] = await signTask(tap, item.task, material, previousR);
                  pending.shift();
                }
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
        let result;
        try {
          result = assembleChain(current, signatures);
        } catch (error) {
          if (error instanceof ChainError) {
            throw new KernelError("integrity", "assembled card signatures were refused");
          }
          throw error;
        }
        if (result.kind === "signed") {
          return { kind: "sign", result: result.artefact } satisfies CardOpResult;
        }
        current = result.plan;
      }
    } finally {
      if (code !== undefined) {
        wipe(code);
      }
      for (const hash of hashes.values()) {
        wipe(hash);
      }
    }
  })();
