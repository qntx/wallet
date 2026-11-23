/**
 * The transfer machinery the multi-card ops share (§11): OFFER/EXPORT/IMPORT step bodies, the typed
 * short-ID ask, and the target-side record comparison. The I4 target gate lives in the op structure
 * itself — a `Target` only ever exists because this operation OFFERed that card (create) or because
 * the wallet record names it as the member being provisioned (transfer/reseal); the card-ID gates
 * on every tap (`expect.cards`/`exclude`/`shortId`) are what keep a different physical card from
 * ever receiving a hash or payload.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { KernelError } from "../../../errors.ts";
import { wipe } from "../../../secret/secret.ts";
import { cmd } from "../protocol/commands.ts";
import type { WalletInfo } from "../protocol/decode.ts";
import { decode } from "../protocol/decode.ts";
import { CardError } from "../protocol/errors.ts";
import type { ExportHead, Offer } from "../protocol/transfer.ts";
import type { CardWalletBody, CardWalletHeader } from "../record.ts";
import type { PendingInput, PendingTap, StepOutcome, TapSession } from "../tap.ts";
import { shortIdLabel } from "../text.ts";
import type { RunOutcome } from "./shared.ts";
import { ask } from "./shared.ts";

/** A target card: its OPEN facts plus the offer it issued, and the export once it exists. */
export type Target = {
  readonly cardId: Uint8Array;
  readonly identity: Uint8Array;
  readonly cert: Uint8Array;
  readonly shortId: string;
  offer: Offer;
  transfer?: { readonly head: ExportHead; readonly payload: Uint8Array } | undefined;
  /** Set once the op re-took the offer after a `wrong-state` — a second refusal is a fault. */
  refreshed?: boolean;
};

/** OFFER on the session's card; the signature must verify under the card's own identity (§9.12). */
export const takeOffer = async (tap: TapSession): Promise<Offer> =>
  decode.offer(await tap.send(cmd.offer()), tap.identity);

/**
 * EXPORT head + payload to `target` (§9.13): the head is bound to this session's identity, the
 * target identity and the link key by the decoder's signature check; the payload is sealed under
 * `accessHashT`, the access hash for exactly `target.cardId` (I4: never another card's hash).
 */
export const exportTo = async (
  tap: TapSession,
  target: Target,
  accessHashT: Uint8Array,
): Promise<{ head: ExportHead; payload: Uint8Array }> => {
  const head = decode.exportHead(await tap.send(cmd.export0(target.cert, target.offer)), {
    source: tap.identity,
    target: target.identity,
    linkKey: target.offer.linkKey,
  });
  const payload = decode.exportPayload(await tap.send(cmd.export1(accessHashT)));
  return { head, payload };
};

/**
 * IMPORT pair on the session's card (§9.14). `wrong-state` on IMPORT P1=0 means `offer = NONE`: the
 * offer was consumed by a completed T-INSTALL (LOADED target — the caller VERIFYs to confirm) or
 * lost on a BLANK one (the caller re-offers and re-exports). `invalid-data` passes through: on a
 * LOADED card it means the sender is not in its members or the export data is corrupt — a wrong
 * card, not a committed install (a committed install has `offer = NONE`).
 */
export const importOutcome = async (
  tap: TapSession,
  sourceCert: Uint8Array,
  transfer: { readonly head: ExportHead; readonly payload: Uint8Array },
): Promise<WalletInfo | "offer-gone"> => {
  try {
    decode.empty(await tap.send(cmd.import0(sourceCert, transfer.head)));
  } catch (error) {
    if (error instanceof CardError && error.code === "wrong-state") {
      return "offer-gone";
    }
    if (
      error instanceof CardError &&
      error.code === "invalid-data" &&
      tap.status.life === "loaded"
    ) {
      throw new KernelError("wrong-card", "the loaded card does not accept this wallet's export");
    }
    throw error;
  }
  try {
    return decode.walletInfo(await tap.send(cmd.import1(transfer.payload)), tap.cardId);
  } catch (error) {
    // On a LOADED target a rejected payload means the stored fp/origin/members differ — the
    // card holds a different wallet. On a BLANK one it's a corrupt payload → card-fault.
    if (
      error instanceof CardError &&
      error.code === "invalid-data" &&
      tap.status.life === "loaded"
    ) {
      throw new KernelError("wrong-card", "the loaded card holds a different wallet");
    }
    throw error;
  }
};

/**
 * The WalletInfo an install (or its VERIFY confirmation) returns must echo the record exactly: same
 * master key and the same member list in the same order — anything else is a wrong card.
 */
export const checkInfo = (
  header: CardWalletHeader,
  body: CardWalletBody,
  info: WalletInfo,
): void => {
  if (
    bytesToHex(info.masterPublicKey) !== body.master ||
    header.members.length !== info.members.length ||
    !header.members.every((m, i) => {
      const member = info.members[i];
      return member !== undefined && equalBytes(hexToBytes(m), member);
    })
  ) {
    throw new KernelError("wrong-card", "the card's wallet does not match the record");
  }
};

/**
 * The target-side run of an install tap — the lost-response contract of §11:
 *
 * - Fresh BLANK tap: IMPORT P1=0 then P1=1; the WalletInfo must echo the record.
 * - Retry finding the target LOADED: a `wrong-state` IMPORT P1=0 means the earlier install committed
 *   and consumed the offer — VERIFY the target's hash to prove it, which also records the card
 *   ready through the engine's bookkeeping. (`invalid-data` there means the card holds a foreign
 *   wallet — `wrong-card`, never a probing VERIFY.)
 * - Retry finding it still BLANK with the offer gone (`wrong-state`): OFFER again on the spot and ask
 *   the op for a re-export (`reexport`). Any other answer stays a real fault.
 */
export const installRun = async (opts: {
  tap: TapSession;
  target: Target;
  sourceCert: Uint8Array;
  hashT: () => Uint8Array | undefined;
  entry: { header: CardWalletHeader; body: CardWalletBody };
}): Promise<RunOutcome> => {
  const { tap, target } = opts;
  if (target.transfer === undefined) {
    throw new KernelError("integrity", "no export is staged for this target");
  }
  const installed = await importOutcome(tap, opts.sourceCert, target.transfer);
  if (installed === "offer-gone") {
    if (tap.status.life === "loaded") {
      const hash = opts.hashT();
      if (hash === undefined) {
        return { status: "need-code", card: tap.shortId };
      }
      const confirmed = await tap.verify(hash);
      if (!confirmed.ok) {
        // A card whose install committed verifies under the new hash — one that does not
        // holds a foreign wallet that merely burned its offer.
        throw new KernelError("wrong-card", "the loaded card did not accept this wallet's code");
      }
      checkInfo(opts.entry.header, opts.entry.body, confirmed.info);
      return { status: "done" };
    }
    if (target.refreshed === true) {
      throw new CardError("card-fault", "the target keeps refusing the staged export");
    }
    target.refreshed = true;
    target.offer = await takeOffer(tap);
    target.transfer = undefined;
    return { status: "reexport", remaining: 0 };
  }
  checkInfo(opts.entry.header, opts.entry.body, installed);
  tap.installed(installed);
  return { status: "done" };
};

/**
 * The source-side run of an export tap: VERIFY under the source's hash, then EXPORT head + payload
 * to `target` under the target's own hash — both hashes looked up lazily so a missing one reports
 * `need-code` for the right card.
 */
export const exportRun = async (opts: {
  tap: TapSession;
  target: Target;
  hashS: () => Uint8Array | undefined;
  hashT: () => Uint8Array | undefined;
}): Promise<RunOutcome> => {
  const { tap, target } = opts;
  const hashS = opts.hashS();
  if (hashS === undefined) {
    return { status: "need-code", card: tap.shortId };
  }
  const verified = await tap.verify(hashS);
  if (!verified.ok) {
    return { status: "wrong-code", remaining: verified.remaining };
  }
  const hashT = opts.hashT();
  if (hashT === undefined) {
    return { status: "need-code", card: target.shortId };
  }
  target.transfer = await exportTo(tap, target, hashT);
  return { status: "done" };
};

/** The printed short ID, re-asked until it parses. */
export function* askShortId(
  labelLocale: Parameters<typeof shortIdLabel>[0],
): Generator<PendingInput | PendingTap, string, StepOutcome | undefined> {
  for (;;) {
    const raw = yield* ask({
      purpose: "short-id",
      secure: "short-id",
      label: shortIdLabel(labelLocale),
    });
    const text = new TextDecoder().decode(raw);
    wipe(raw);
    if (/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(text)) {
      return text;
    }
  }
}

/** `t`'s facts from a just-OFFERed session card. */
export const targetFrom = (tap: TapSession, offer: Offer): Target => ({
  cardId: new Uint8Array(tap.cardId),
  identity: new Uint8Array(tap.identity),
  cert: new Uint8Array(tap.cert),
  shortId: tap.shortId,
  offer,
});
