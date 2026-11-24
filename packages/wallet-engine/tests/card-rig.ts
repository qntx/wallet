/**
 * The in-process fake card platform every engine card test shares: `cardRig` builds a real Wallet
 * over the in-process kernel with the test card reader and secure input bound, then creates a k=1
 * card wallet importing the abandon mnemonic. The scripted reader's `open` is wrapped so it keeps
 * "polling" — a real `CardReader.open` polls the NFC field for a platform window while the scripted
 * one answers `timeout` synchronously on an empty queue, which would spin the kernel's `tapRetry`
 * at microtask pace and starve the event loop. The wrapper parks the poll until `present` queues a
 * card or `close` ends the session (answering `interrupted` so abort unwinds).
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { card } from "@qntx/wallet/card";
import { connectKernel } from "@qntx/wallet/host";

import { shortId } from "../../wallet-kernel/src/modules/card/protocol/identity.ts";
import { createFakeCard } from "../../wallet-kernel/tests/card/fake-card.ts";
import type { FakeCard } from "../../wallet-kernel/tests/card/fake-card.ts";
import { testSecureInput } from "../../wallet-kernel/tests/card/input.ts";
import type { TestSecureInput } from "../../wallet-kernel/tests/card/input.ts";
import { testCardReader } from "../../wallet-kernel/tests/card/reader.ts";
import type { TestCardReader } from "../../wallet-kernel/tests/card/reader.ts";
import { CA1_ANCHOR } from "../../wallet-kernel/tests/card/sim.ts";
import { createHarness } from "../../wallet-kernel/tests/harness.ts";
import { MNEMONIC } from "./apps-helpers.ts";

export const CARD_CODE = "card rig access";
export const CARD_VERIFY = { kind: "password" as const, password: "card rig password" };

export type CardRig = {
  wallet: Wallet;
  cardWalletId: string;
  input: TestSecureInput;
  reader: TestCardReader;
  member: FakeCard;
};

export const cardRig = async (options?: { readonly now?: number }): Promise<CardRig> => {
  const field = testCardReader();
  const input = testSecureInput();
  let ended = false;
  let wake: (() => void) | undefined;
  const nextPoll = async (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  const reader: TestCardReader = {
    ...field,
    reader: {
      open: async (prompt) => {
        ended = false;
        for (;;) {
          if (ended) {
            return { ok: false, failure: "interrupted", detail: undefined };
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- one field poll at a time
          const opened = await field.reader.open(prompt);
          if (opened.ok || opened.failure !== "timeout") {
            return opened;
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- the field poll waits for a card
          await nextPoll();
        }
      },
      transmit: async (apdu) => field.reader.transmit(apdu),
      close: (outcome, text) => {
        ended = true;
        wake?.();
        wake = undefined;
        field.reader.close(outcome, text);
      },
    },
    present: (card) => {
      field.present(card);
      wake?.();
    },
  };
  const h = createHarness({
    card: { reader: reader.reader, secureInput: input.secureInput, anchors: [CA1_ANCHOR] },
    ...(options?.now === undefined ? {} : { start: options.now }),
  });
  const wallet = await connectKernel({
    verifyEvent,
    spawn: () => h.hostPort,
    factors: "software",
    passkey: {
      rpId: "qntx.test",
      rpName: "qntx",
      walletSalt: "qntx/wallet",
      backupSalt: "qntx/backup",
      vaultSalt: "qntx/vault",
    },
    ceremony: undefined,
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  });
  const { walletId: sourceId } = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: CARD_VERIFY,
  });
  const member = createFakeCard();
  const created = card(wallet).start(
    { kind: "create", cards: 1, source: { kind: "wallet", walletId: sourceId } },
    { verify: CARD_VERIFY },
  );
  created.observe((step) => {
    if (step.kind === "input") {
      input.push(
        step.purpose === "short-id"
          ? utf8ToBytes(shortId(member.identity))
          : utf8ToBytes(CARD_CODE),
      );
    } else if (step.kind === "tap") {
      reader.present(member);
    }
  });
  const made = await created.result;
  if (made.kind !== "create") {
    throw new Error("the card wallet was not created");
  }
  return { wallet, cardWalletId: made.walletId, input, reader, member };
};
