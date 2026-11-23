/**
 * The card module: owns the `card-wallet` record kind, the `card.*` method table and the single
 * active card operation. An operation is an async generator (`ops.ts`) whose yields are the public
 * steps — `input` (secure-input bytes) and `tap` (one reader session, run by `tap.ts`).
 * `card.begin` primes a generator, `card.step` services one step, `card.cancel`/`interrupt`/lock
 * and the 120 s timer all discard through `gen.return()` so the op's `finally` wipes its secrets.
 */
import { bytesToHex } from "@noble/hashes/utils.js";

import type { CARD_METHODS, CardOpResult, CardStep, MethodName } from "@qntx/wallet/protocol";

import type { Handler, VaultHooks } from "../../commands/context.ts";
import type { PublicMaterial } from "../../derive/material.ts";
import { KernelError } from "../../errors.ts";
import type { KernelPlatform } from "../../platform.ts";
import { cardPromptFor, promptLocale } from "../../prompts.ts";
import { wipe } from "../../secret/secret.ts";
import { verifyFactor } from "../../vault/vault.ts";
import type { OpenedRecord } from "../../vault/vault.ts";
import { PLAN_MS } from "./budget.ts";
import { cardMaterial } from "./material.ts";
import type { OpEnv, SignPrepared } from "./ops/index.ts";
import {
  checkOperation,
  makeOp,
  prepareSign,
  promptCards,
  promptKind,
  rememberGated,
  verifyGate,
} from "./ops/index.ts";
import type { CardWalletBody } from "./record.ts";
import { CARD_WALLET_KIND, parseCardWalletBody, parseCardWalletHeader } from "./record.ts";
import { runTap } from "./tap.ts";
import type { CardOp, PendingInput, PendingTap, StepOutcome } from "./tap.ts";

/** A step may wait this long for its host work — re-armed at every step boundary. */
const STEP_TIMEOUT_MS = 120_000;

type Active = {
  readonly opId: string;
  readonly gen: CardOp;
  pending: PendingInput | PendingTap;
  /** Set while a step's host work (secureInput or reader session) is in flight. */
  stepActive: boolean;
  /** An interrupt fired mid-step — the step must resolve, then answer `cancelled`. */
  aborted: boolean;
  cancelTimer: () => void;
};

export type CardModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof CARD_METHODS & MethodName]: Handler<M> };
  /** Live public material for an unlocked card wallet — `undefined` while locked or unknown. */
  readonly material: (walletId: string) => PublicMaterial | undefined;
  /**
   * Synchronously aborts the operation — called before `card.cancel` requests queue, by the 120 s
   * timer and by session lock. A blocked step resolves `cancelled`; an idle op discards.
   */
  readonly interrupt: (opId: string) => void;
};

/** The public shape of a pending step — never carries labels, prompts, expectations or APDUs. */
const publicOf = (pending: PendingInput | PendingTap): CardStep => {
  if (pending.kind === "input") {
    return {
      kind: "input",
      purpose: pending.purpose,
      ...(pending.card === undefined ? {} : { card: pending.card }),
      ...(pending.remaining === undefined ? {} : { remaining: pending.remaining }),
    };
  }
  return {
    kind: "tap",
    reason: pending.reason,
    ...(pending.card === undefined ? {} : { card: pending.card }),
    ...(pending.hold === undefined ? {} : { hold: true }),
  };
};

export function createCardModule(platform: KernelPlatform): CardModule {
  // The live card-wallet bodies claimed at unlock — the ops' record view and material source.
  const live = new Map<string, CardWalletBody>();
  let current: Active | undefined;

  /** The value a discarded generator completes with — only its `finally` matters. */
  const DISCARDED: CardOpResult = { kind: "status", life: "blank", tries: 0 };

  const discard = async (active: Active): Promise<void> => {
    if (current === active) {
      current = undefined;
    }
    active.cancelTimer();
    await active.gen.return(DISCARDED);
  };

  /** Aborts an operation: a step in flight is interrupted, an idle generator just winds down. */
  const abort = (active: Active): void => {
    if (current === active) {
      current = undefined;
    }
    active.cancelTimer();
    if (active.stepActive) {
      active.aborted = true;
      platform.card?.secureInput.cancel();
      platform.card?.reader.close("failure", "");
    } else {
      void active.gen.return(DISCARDED);
    }
  };

  const interrupt = (opId: string): void => {
    if (current?.opId === opId) {
      abort(current);
    }
  };

  /** The no-progress timeout — armed at every step boundary; fires interrupt + discard. */
  const arm = (active: Active): void => {
    active.cancelTimer();
    active.cancelTimer = platform.setTimer(STEP_TIMEOUT_MS, () => interrupt(active.opId));
  };

  const vault: VaultHooks = {
    ownsRecord: (kind) => kind === CARD_WALLET_KIND,
    claimUnlocked: (records) => {
      const unclaimed: OpenedRecord[] = [];
      for (const record of records) {
        if (record.kind !== CARD_WALLET_KIND) {
          unclaimed.push(record);
          continue;
        }
        try {
          const text = new TextDecoder().decode(record.plaintext);
          live.set(record.id, parseCardWalletBody(text, record.id));
        } finally {
          wipe(record.plaintext);
        }
      }
      return unclaimed;
    },
    forget: (kind, id) => {
      if (kind === CARD_WALLET_KIND) {
        live.delete(id);
      }
    },
    lock: () => {
      // A lock interrupts an in-flight step and discards every operation secret.
      if (current !== undefined) {
        abort(current);
      }
      live.clear();
    },
    walletDeleteOps: () => [],
    parseHeader: (record) => {
      parseCardWalletHeader(record.header);
    },
  };

  const handlers: { [M in keyof typeof CARD_METHODS & MethodName]: Handler<M> } = {
    "card.begin": async (ctx, params, session) => {
      const { dek } = ctx.session.require(session);
      const { card } = platform;
      if (card === undefined) {
        throw new KernelError("unsupported", "this host has no card reader");
      }
      const gate = verifyGate(params.op);
      if (gate === "unsupported") {
        throw new KernelError("unsupported", "card operations arrive in a later build");
      }
      checkOperation(ctx, params.op);
      if (gate === "forbidden" && params.verify !== undefined) {
        throw new KernelError("invalid-input", "this card operation takes no verify");
      }
      const env: OpEnv = {
        ctx,
        bodies: live,
        locale: promptLocale(platform.keystore?.locale ?? "en"),
        planMs: card.planMs ?? PLAN_MS,
      };
      let prepared: SignPrepared | undefined;
      if (gate === "required") {
        if (params.verify === undefined) {
          throw new KernelError("invalid-input", "this card operation needs a verify");
        }
        rememberGated(ctx, params.op, params.verify.kind);
        // The sign op's verify prompt is the rendered signing intent, prepared before the
        // factor runs so it is exactly what the host shows (design §8).
        const prompt =
          params.op.kind === "sign"
            ? (prepared = await prepareSign(env, params.op, dek)).verifyPrompt
            : cardPromptFor(platform.keystore, promptKind(params.op), () =>
                promptCards(ctx, params.op),
              );
        await verifyFactor(platform, ctx.image, params.verify, dek, ctx.commit, prompt);
      }
      // One active operation at a time — the prior one's finally wipes its secrets.
      if (current !== undefined) {
        await discard(current);
      }
      const gen = makeOp(env, params.op, prepared);
      const opId = bytesToHex(platform.random(16));
      const first = await gen.next(undefined);
      if (first.done === true) {
        return { opId, step: { kind: "done", result: first.value } };
      }
      const active: Active = {
        opId,
        gen,
        pending: first.value,
        stepActive: false,
        aborted: false,
        cancelTimer: () => undefined,
      };
      arm(active);
      current = active;
      return { opId, step: publicOf(first.value) };
    },

    "card.step": async (ctx, params, session) => {
      ctx.session.require(session);
      const { card } = platform;
      if (card === undefined) {
        throw new KernelError("unsupported", "this host has no card reader");
      }
      const active = current;
      if (active === undefined || active.opId !== params.opId) {
        throw new KernelError("not-found", "no such card operation");
      }
      active.stepActive = true;
      try {
        let outcome: StepOutcome;
        if (active.pending.kind === "input") {
          const response = await card.secureInput.request(
            active.pending.secure,
            active.pending.label,
          );
          if (!response.ok) {
            throw response.failure === "cancelled"
              ? new KernelError("cancelled", "the secure input was dismissed")
              : new KernelError("unavailable", "the secure input is unavailable");
          }
          outcome = response.value;
        } else {
          outcome = await runTap(ctx, active.pending, live);
        }
        if (active.aborted) {
          throw new KernelError("cancelled", "the card operation was cancelled");
        }
        const next = await active.gen.next(outcome);
        if (active.aborted) {
          throw new KernelError("cancelled", "the card operation was cancelled");
        }
        if (next.done === true) {
          const result = next.value;
          await discard(active);
          return { kind: "done", result } satisfies CardStep;
        }
        active.pending = next.value;
        arm(active);
        return publicOf(next.value);
      } catch (error) {
        await discard(active).catch(() => undefined);
        throw error;
      } finally {
        // Between steps the op is idle again — an abort must discard it, not interrupt.
        active.stepActive = false;
      }
    },

    "card.cancel": async (ctx, params, session) => {
      ctx.session.require(session);
      if (platform.card === undefined) {
        throw new KernelError("unsupported", "this host has no card reader");
      }
      const active = current;
      if (active !== undefined && active.opId === params.opId) {
        await discard(active);
      }
      return null;
    },
  };

  return {
    vault,
    handlers,
    material: (walletId) => {
      const body = live.get(walletId);
      return body === undefined ? undefined : cardMaterial(body);
    },
    interrupt,
  };
}
