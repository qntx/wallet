/**
 * The op dispatch: precondition checks that end `card.begin` before any step, the verify gates,
 * prompt selection, and `makeOp` — the generator factory. One file per op plus `shared.ts` for the
 * machinery they share.
 */
import type { CardOperation } from "@qntx/wallet/protocol";

import type { KernelContext } from "../../../commands/context.ts";
import { KernelError } from "../../../errors.ts";
import { CARD_WALLET_KIND } from "../../../vault/store.ts";
import { findWalletRecord } from "../../../vault/vault.ts";
import { parseCardWalletHeader } from "../record.ts";
import type { CardOp } from "../tap.ts";
import { accountsOp } from "./accounts.ts";
import { addOp } from "./add.ts";
import { changeAccessOp } from "./change-access.ts";
import { createOp } from "./create.ts";
import { eraseOp } from "./erase.ts";
import { forgetAccessOp } from "./forget-access.ts";
import { healthOp } from "./health.ts";
import { resealOp } from "./reseal.ts";
import type { OpEnv } from "./shared.ts";
import { pinnedShortId } from "./shared.ts";
import { signOp } from "./sign.ts";
import type { SignPrepared } from "./sign.ts";
import { statusOp } from "./status.ts";
import { transferOp } from "./transfer.ts";

export type { OpEnv } from "./shared.ts";
export { registrationPaths } from "./shared.ts";
export { prepareSign } from "./sign.ts";
export type { SignPrepared } from "./sign.ts";

/** Preconditions that end `card.begin` before any step: wallets exist, gates, unsupported ops. */
export const checkOperation = (ctx: KernelContext, op: CardOperation): void => {
  const cardRecord = (walletId: string) =>
    ctx.image.records.find((r) => r.kind === CARD_WALLET_KIND && r.id === walletId);
  switch (op.kind) {
    case "accounts":
    case "health":
    case "change-access":
    case "forget-access":
      if (cardRecord(op.walletId) === undefined) {
        throw new KernelError("not-found", "no such card wallet");
      }
      return;
    case "sign": {
      const { account } = op.request;
      if (account.kind !== "hd") {
        throw new KernelError("invalid-input", "only an hd account signs on a card");
      }
      if (cardRecord(account.walletId) === undefined) {
        // A walletId may name a vault record and a card wallet at once — only a missing card
        // record with no other wallet of that id is `not-found`; a non-card wallet is input.
        throw findWalletRecord(ctx.image, account.walletId) === undefined
          ? new KernelError("not-found", "no such card wallet")
          : new KernelError("invalid-input", "the account's wallet is not a card wallet");
      }
      return;
    }
    case "erase": {
      const record = cardRecord(op.walletId);
      if (record === undefined) {
        throw new KernelError("not-found", "no such card wallet");
      }
      const header = parseCardWalletHeader(record.header);
      if (!header.cards.some((c) => c.cardId === op.card)) {
        throw new KernelError("not-found", "no such card in this wallet");
      }
      if (header.cards.length === 1 && header.origin === "generated" && op.last !== true) {
        throw new KernelError(
          "invalid-input",
          "erasing the only card of a generated wallet needs last: true",
        );
      }
      return;
    }
    case "create": {
      if (op.source.kind === "generate") {
        if (op.cards === 1) {
          throw new KernelError(
            "invalid-input",
            "a card-generated wallet needs at least two cards",
          );
        }
        break;
      }
      const sourceId = op.source.walletId;
      const source = findWalletRecord(ctx.image, sourceId);
      if (source === undefined) {
        throw new KernelError("not-found", "no such source wallet");
      }
      if (source.kind !== "entropy") {
        throw new KernelError("invalid-input", "the source is not a vault HD wallet");
      }
      break;
    }
    case "transfer": {
      const record = cardRecord(op.walletId);
      if (record === undefined) {
        throw new KernelError("not-found", "no such card wallet");
      }
      const header = parseCardWalletHeader(record.header);
      if (header.cards.every((c) => c.state === "ready")) {
        throw new KernelError(
          "invalid-input",
          "every member of this wallet is already provisioned",
        );
      }
      if (!header.cards.some((c) => c.state === "ready")) {
        throw new KernelError("invalid-input", "no ready member can export this wallet");
      }
      break;
    }
    case "reseal": {
      const record = cardRecord(op.walletId);
      if (record === undefined) {
        throw new KernelError("not-found", "no such card wallet");
      }
      const header = parseCardWalletHeader(record.header);
      const target = header.cards.find((c) => c.cardId === op.card);
      if (target === undefined) {
        throw new KernelError("not-found", "no such card in this wallet");
      }
      if (op.member !== undefined) {
        const member = header.cards.find((c) => c.cardId === op.member);
        if (member === undefined) {
          throw new KernelError("not-found", "no such card in this wallet");
        }
        if (op.member === op.card) {
          throw new KernelError("invalid-input", "the resealing member must be another card");
        }
        if (member.state !== "ready") {
          throw new KernelError("invalid-input", "the resealing member is not ready");
        }
      } else if (!header.cards.some((c) => c.state === "ready" && c.cardId !== op.card)) {
        throw new KernelError("invalid-input", "no other ready member can reseal this card");
      }
      break;
    }
    default:
      break;
  }
};

/** Whether the op takes a `verify`, forbids one, or is not in this layer. */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export const verifyGate = (op: CardOperation): "required" | "forbidden" | "unsupported" => {
  switch (op.kind) {
    case "status":
    case "add":
    case "accounts":
    case "health":
      return "forbidden";
    case "change-access":
    case "erase":
    case "create":
    case "transfer":
    case "reseal":
    case "forget-access":
    case "sign":
      return "required";
  }
};

/** Which prompt kind a verify-bearing op uses. */
export const promptKind = (
  op: CardOperation,
):
  | "card-change-access"
  | "card-erase"
  | "card-create"
  | "card-transfer"
  | "card-reseal"
  | "card-forget-access" => {
  switch (op.kind) {
    case "change-access":
      return "card-change-access";
    case "erase":
      return "card-erase";
    case "transfer":
      return "card-transfer";
    case "reseal":
      return "card-reseal";
    case "forget-access":
      return "card-forget-access";
    default:
      return "card-create";
  }
};

/** `remember` needs app lock on and a hardware verify — else `unsupported` at begin. */
export const rememberGated = (ctx: KernelContext, op: CardOperation, verifyKind: string): void => {
  const wants =
    (op.kind === "change-access" || op.kind === "create" || op.kind === "sign") &&
    op.remember === true;
  if (!wants) {
    return;
  }
  if (verifyKind !== "hardware" || ctx.image.factors.some((f) => f.kind === "device")) {
    throw new KernelError(
      "unsupported",
      "saving the card code needs app lock and a hardware verify",
    );
  }
};

/** The short IDs an op's verify prompt names — the pinned cards of the wallet, or the target. */
export const promptCards = (ctx: KernelContext, op: CardOperation): ReadonlyArray<string> => {
  const walletId = "walletId" in op && typeof op.walletId === "string" ? op.walletId : undefined;
  if (walletId === undefined) {
    return [];
  }
  const record = ctx.image.records.find((r) => r.kind === CARD_WALLET_KIND && r.id === walletId);
  if (record === undefined) {
    return [];
  }
  const header = parseCardWalletHeader(record.header);
  if (op.kind === "erase") {
    const short = pinnedShortId(header, op.card);
    return short === undefined ? [] : [short];
  }
  return header.cards
    .map((c) => pinnedShortId(header, c.cardId))
    .filter((s): s is string => s !== undefined);
};

/** Builds the op's generator — thrown precondition failures happen before any yield. */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export const makeOp = (env: OpEnv, op: CardOperation, prepared?: SignPrepared): CardOp => {
  switch (op.kind) {
    case "status":
      return statusOp(env);
    case "add":
      return addOp(env, op);
    case "accounts":
      return accountsOp(env, op);
    case "health":
      return healthOp(env, op);
    case "change-access":
      return changeAccessOp(env, op);
    case "erase":
      return eraseOp(env, op);
    case "create":
      return createOp(env, op);
    case "transfer":
      return transferOp(env, op);
    case "reseal":
      return resealOp(env, op);
    case "forget-access":
      return forgetAccessOp(env, op);
    case "sign":
      if (prepared === undefined) {
        throw new KernelError("integrity", "the sign operation was not prepared");
      }
      return signOp(env, op, prepared);
  }
};
