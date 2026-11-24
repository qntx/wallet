import { readFileSync } from "node:fs";

import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { card } from "@qntx/wallet/card";
import type { DeviceIo } from "@qntx/wallet/hardware";
import { hardware } from "@qntx/wallet/hardware";
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
import { SignersController } from "../src/signers/controller.ts";
import type { SignerFamily, SignersState } from "../src/signers/controller.ts";
import { MNEMONIC, nodeWallet, until, VERIFY } from "./apps-helpers.ts";
import { keystoneIo } from "./keystone-io.ts";

const SYNC = hexToBytes(
  (
    JSON.parse(
      readFileSync(new URL("../../../vectors/keystone/sync.json", import.meta.url), "utf8"),
    ) as { sync: { cbor: string } }
  ).sync.cbor,
);

const stepKind = (state: SignersState): string => state.active?.step.kind ?? "none";

const controller = (
  wallet: Wallet,
  options: {
    readonly deviceIo?: DeviceIo;
    readonly recheck?: (
      walletId: string,
      groupIndex: number,
      family: SignerFamily,
    ) => Promise<void>;
  } = {},
): SignersController => {
  const io = options.deviceIo;
  return new SignersController({
    wallet,
    ...(io === undefined ? {} : { deviceIo: () => io }),
    recheck: options.recheck ?? (async () => Promise.resolve()),
    networks: { enabled: (family) => (family === "evm" ? ["eip155:42161"] : []) },
    random: (n) => new Uint8Array(n).fill(7),
    logger: { warn: () => undefined },
  });
};

const pairKeystone = async (wallet: Wallet): Promise<string> => {
  const existing = wallet.getSnapshot().wallets.find((w) => w.custody === "hardware");
  if (existing !== undefined) {
    return existing.walletId;
  }
  const result = await hardware(wallet).start(
    { kind: "pair", device: "keystone" },
    {
      io: {
        exchange: async () =>
          Promise.resolve({
            kind: "qr",
            ur: { type: "crypto-multi-accounts", cbor: SYNC },
          }),
      },
    },
  ).result;
  if (result.kind !== "pair") {
    throw new Error("pair did not return a wallet");
  }
  return result.wallet.walletId;
};

const typedData = (hwId: string) => ({
  kind: "evm.typed-data" as const,
  network: "eip155:42161",
  account: { kind: "hd" as const, walletId: hwId, groupIndex: 0, template: "evm.bip44" as const },
  typedData: JSON.stringify({
    types: { EIP712Domain: [], Mail: [{ name: "contents", type: "string" }] },
    primaryType: "Mail",
    domain: {},
    message: { contents: "hello" },
  }),
});

const CODE_TEXT = "card rig access";
const CARD_VERIFY = { kind: "password" as const, password: "card rig password" };

type CardRig = {
  wallet: Wallet;
  cardWalletId: string;
  input: TestSecureInput;
  reader: TestCardReader;
  member: FakeCard;
};

/**
 * A real Wallet over the in-process kernel with the fake card platform bound — the created card
 * wallet is a k=1 import of the abandon mnemonic, so its access code is CODE_TEXT.
 */
const cardRig = async (): Promise<CardRig> => {
  const field = testCardReader();
  const input = testSecureInput();
  // A real `open` polls the field until a card enters or the platform window ends — the scripted
  // reader answers `timeout` on the spot, which on an empty queue would spin `tapRetry` at
  // microtask pace and starve the event loop. Park the poll until `present` queues a card or
  // `close` ends the session.
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
          : utf8ToBytes(CODE_TEXT),
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

/** The inner card step the activity currently shows, if any. */
const activeCardStep = (signers: SignersController): string | undefined => {
  const step = signers.getState().active?.step;
  return step?.kind === "card" ? step.step.kind : undefined;
};

describe("the signers controller", () => {
  it("routes a hardware wallet's signature through deviceIo and publishes exchange steps", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const signers = controller(wallet, { deviceIo: keystoneIo() });
    const steps: string[] = [];
    const off = signers.store.subscribe((state) => {
      steps.push(stepKind(state));
    });
    const result = await signers.apis.sign({
      request: typedData(hwId),
      verify: VERIFY,
    });
    off();
    expect(result.kind).toBe("evm.typed-data");
    expect(steps).toContain("starting");
    expect(steps).toContain("device");
    expect(signers.getState().active).toBeNull();
  });

  it("signs vault requests through chains() without an activity", async () => {
    const { wallet, walletId } = await nodeWallet();
    const signers = controller(wallet);
    const result = await signers.apis.sign({
      request: {
        kind: "evm.typed-data",
        network: "eip155:42161",
        account: {
          kind: "hd",
          walletId,
          groupIndex: 0,
          template: "evm.bip44",
        },
        typedData: JSON.stringify({
          types: { EIP712Domain: [], Mail: [{ name: "contents", type: "string" }] },
          primaryType: "Mail",
          domain: {},
          message: { contents: "hello" },
        }),
      },
      verify: VERIFY,
    });
    expect(result.kind).toBe("evm.typed-data");
    expect(signers.getState().active).toBeNull();
  });

  it("answers unsupported for a hardware wallet without a transport", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const noTransport = controller(wallet);
    await expect(
      noTransport.apis.sign({ request: typedData(hwId), verify: VERIFY }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("a second sign refuses conflict while the exchange runs, and the first op completes", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signers = controller(wallet, { deviceIo: keystoneIo(async () => gate) });
    const first = signers.apis.sign({ request: typedData(hwId), verify: VERIFY });
    // The user's confirmation is on the device — the exchange is in flight.
    await until(() => signers.getState().active?.step.kind === "device");
    await expect(
      signers.apis.sign({ request: typedData(hwId), verify: VERIFY }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Releasing the device finishes the running op untouched — it was never cancelled.
    release();
    await expect(first).resolves.toMatchObject({ kind: "evm.typed-data" });
    expect(signers.getState().active).toBeNull();
  });

  it("a second sign refuses conflict while the card waits for a tap, and the first op completes", async () => {
    const { wallet, cardWalletId, input, reader, member } = await cardRig();
    const signers = controller(wallet);
    // Pre-queue the access code — the op consumes it on the spot and parks at the tap wait.
    input.push(utf8ToBytes(CODE_TEXT));
    const first = signers.apis.sign({ request: typedData(cardWalletId), verify: CARD_VERIFY });
    // The member-card prompt is on screen — the card op is in flight.
    await until(() => activeCardStep(signers) === "tap");
    await expect(
      signers.apis.sign({ request: typedData(cardWalletId), verify: CARD_VERIFY }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Present the member card — the running op completes untouched.
    reader.present(member);
    await expect(first).resolves.toMatchObject({ kind: "evm.typed-data" });
    expect(signers.getState().active).toBeNull();
  });

  it("cancel() rejects the running result with cancelled and clears the activity", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const gate = new Promise<never>(() => {});
    const signers = controller(wallet, { deviceIo: keystoneIo(async () => gate) });
    const first = signers.apis.sign({ request: typedData(hwId), verify: VERIFY });
    await Promise.resolve();
    expect(signers.getState().active).not.toBeNull();
    await signers.cancel();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(signers.getState().active).toBeNull();
    await expect(signers.cancel()).resolves.toBeUndefined();
  });

  it("verifyAddress runs the device compare; card and vault refuse unsupported", async () => {
    const { wallet, walletId } = await nodeWallet();
    const signers = controller(wallet, { deviceIo: keystoneIo() });
    await expect(
      signers.verifyAddress({
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: "eip155:42161",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    const hwId = await pairKeystone(wallet);
    const verified = await signers.verifyAddress({
      walletId: hwId,
      groupIndex: 0,
      template: "evm.bip44",
      network: "eip155:42161",
    });
    expect(verified.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(signers.getState().active).toBeNull();
    await expect(
      signers.verifyAddress({
        walletId: "no-such-wallet",
        groupIndex: 0,
        template: "evm.bip44",
        network: "eip155:42161",
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("fetchAccounts drives one accounts op and re-checks the family", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const rechecked: string[] = [];
    const signers = controller(wallet, {
      deviceIo: {
        exchange: async () =>
          Promise.resolve({
            kind: "qr",
            ur: { type: "crypto-multi-accounts", cbor: SYNC },
          }),
      },
      recheck: async (walletId, groupIndex, family) => {
        rechecked.push(`${walletId}:${groupIndex}:${family}`);
        await Promise.resolve();
      },
    });
    const accounts = await signers.fetchAccounts({ walletId: hwId, groupIndex: 0, family: "evm" });
    expect(accounts.length).toBeGreaterThan(0);
    expect(rechecked).toStrictEqual([`${hwId}:0:evm`]);
    expect(signers.getState().active).toBeNull();
  });
});
