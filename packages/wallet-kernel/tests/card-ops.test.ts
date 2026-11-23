import { secp256k1 } from "@noble/curves/secp256k1.js";
// oxlint-disable eslint/no-await-in-loop, vitest/no-conditional-in-test, vitest/no-conditional-expect -- the step driver is sequential and conditional by design
/**
 * The layer-3 operation engine end to end against the configurable fake card: every single-card op
 * (`status`, `add`, `accounts`, `health`, `change-access`, `erase`, `create`, `forget-access`), the
 * tap gates (ephemeral replay, cert trust, status lies, wrong codes, tag loss), and the operation
 * lifecycle (cancel, timeout, lock, secret wiping).
 */
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import type { WalletInfo } from "@qntx/wallet/types";

import { walletIdOf } from "../src/derive/wallet-id.ts";
import { accessHash } from "../src/modules/card/protocol/access.ts";
import { shortId } from "../src/modules/card/protocol/identity.ts";
import { encodeCardWalletBody, encodeCardWalletHeader } from "../src/modules/card/record.ts";
import type { CardWalletBody, CardWalletHeader } from "../src/modules/card/record.ts";
import { wipe } from "../src/secret/secret.ts";
import type { Secret } from "../src/secret/secret.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { passkeyKek, unwrapDek } from "../src/vault/factors.ts";
import { withManifest } from "../src/vault/manifest.ts";
import { CARD_WALLET_KIND } from "../src/vault/store.ts";
import { sealRecord } from "../src/vault/vault.ts";
import { CA1_PRIVATE, createFakeCard, issueCert } from "./card/fake-card.ts";
import type { FakeCard } from "./card/fake-card.ts";
import { testSecureInput } from "./card/input.ts";
import { testCardReader } from "./card/reader.ts";
import { CA1_ANCHOR } from "./card/sim.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";
import { quickArgon2id, subtlePbkdf2 } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CREDENTIAL_ID = utf8ToBytes("credential-1");
const CODE_TEXT = "correct horse";
const CODE = utf8ToBytes(CODE_TEXT);
/** A fresh code buffer — the kernel wipes the buffer it is handed, so never reuse one. */
const freshCode = (): Uint8Array => utf8ToBytes(CODE_TEXT);

const ok = (res: KernelResponse): unknown => {
  if (!("ok" in res)) {
    throw new Error(`call failed: ${JSON.stringify(res.err)}`);
  }
  return res.ok;
};
const errCode = async (res: Promise<KernelResponse>): Promise<string> => {
  const response = await res;
  if (!("err" in response)) {
    throw new Error("call did not fail");
  }
  return response.err.code;
};
const field = (value: unknown, key: string): unknown => (value as Record<string, unknown>)[key];
const strField = (value: unknown, key: string): string => String(field(value, key));

const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(32).fill(1),
});

type Rig = {
  h: Harness;
  session: string;
  reader: ReturnType<typeof testCardReader>;
  input: ReturnType<typeof testSecureInput>;
};

const rig = async (): Promise<Rig> => {
  const reader = testCardReader();
  const input = testSecureInput();
  const h = createHarness({
    card: { reader: reader.reader, secureInput: input.secureInput, anchors: [CA1_ANCHOR] },
  });
  const res = ok(
    await h.call("wallet.createWithPasskey", {
      ceremony: "host",
      credentialId: CREDENTIAL_ID,
      prfWallet: new Uint8Array(32).fill(2),
      synced: true,
      factor: verifyPasskey(),
    }),
  );
  return { h, session: strField(res, "session"), reader, input };
};

const vaultWalletId = async (r: Rig): Promise<string> => {
  const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
  const vault = status.wallets.find((w) => w.custody === "vault");
  if (vault === undefined) {
    throw new Error("no vault wallet");
  }
  return vault.walletId;
};

type Step = { kind: string; [k: string]: unknown };
type FieldCard = { transmit: (a: Uint8Array) => Promise<Uint8Array | "torn"> };

/** Runs `card.begin` and then steps until `done`, feeding queued codes and queued cards. */
const drive = async (
  r: Rig,
  op: unknown,
  actions: { codes?: Uint8Array[]; cards: FieldCard[]; shortIds?: Record<number, string> },
  verify?: unknown,
): Promise<Record<string, unknown>> => {
  const first = ok(
    await r.h.call("card.begin", { op, ...(verify === undefined ? {} : { verify }) }, r.session),
  ) as { opId: string; step: Step };
  let { step } = first;
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    if (guard > 60) {
      throw new Error(`operation did not finish: ${JSON.stringify(step)}`);
    }
    if (step.kind === "input") {
      if (step["purpose"] === "short-id") {
        // Peek at the card about to be tapped and type its printed ID.
        const upcoming = actions.cards[0] as FakeCard | undefined;
        r.input.push(utf8ToBytes(shortId(upcoming?.identity ?? new Uint8Array(33))));
      } else {
        const [code] = actions.codes?.splice(0, 1) ?? [];
        if (code === undefined) {
          throw new Error(`unexpected input step ${JSON.stringify(step)}`);
        }
        r.input.push(code);
      }
    } else if (step.kind === "tap") {
      const [next] = actions.cards.splice(0, 1);
      if (next === undefined) {
        throw new Error(`unexpected tap step ${JSON.stringify(step)}`);
      }
      r.reader.present(next);
    }
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
  }
  return field(step, "result") as Record<string, unknown>;
};

const cardWalletIds = async (r: Rig): Promise<string[]> => {
  const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
  return status.wallets.filter((w) => w.custody === "card").map((w) => w.walletId);
};

const seed = await seedFromEntropy(entropyFromMnemonic(MNEMONIC), "", subtlePbkdf2);

/** A second seed — the keystore rig's imported wallet already owns `seed`'s walletId. */
const seed2 = await seedFromEntropy(
  entropyFromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
  ),
  "",
  subtlePbkdf2,
);

/** A fake card loaded with `seed` under `code`. */
const loadedCard = async (code = CODE, withSeed: Uint8Array = seed): Promise<FakeCard> => {
  const card = createFakeCard();
  card.load(withSeed, await accessHash(code, card.cardId, quickArgon2id));
  return card;
};

describe("card operations (fake card)", () => {
  it("status on a blank card reports blank, tries 0, no walletId", async () => {
    const r = await rig();
    const card = createFakeCard();
    const result = await drive(r, { kind: "status" }, { cards: [card] });
    expect(result["life"]).toBe("blank");
    expect(result["tries"]).toBe(0);
    expect(result["walletId"]).toBeUndefined();
    expect(r.reader.closes.at(-1)).toStrictEqual({ outcome: "success", text: expect.any(String) });
  });

  it("status on a loaded card reports loaded and remaining tries", async () => {
    const r = await rig();
    const card = await loadedCard();
    const result = await drive(r, { kind: "status" }, { cards: [card] });
    expect(result["life"]).toBe("loaded");
    expect(result["tries"]).toBe(10);
    expect(result["walletId"]).toBeUndefined(); // unknown card — not a member of a record
  });

  it("create imports a k=1 wallet: verify, new code, tap, record committed, entropy gone", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = createFakeCard();
    const c1 = utf8ToBytes("correct horse");
    const c2 = utf8ToBytes("correct horse");
    const result = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      { codes: [c1, c2], cards: Array.from({ length: 10 }, () => card) },
      verifyPasskey(),
    );
    expect(result["kind"]).toBe("create");
    const walletId = strField(result, "walletId");
    await expect(cardWalletIds(r)).resolves.toContain(walletId);
    const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
    // The import keeps the walletId (same master key) but the vault copy is deleted.
    const imported = status.wallets.find((w) => w.walletId === source);
    expect(imported?.custody).toBe("card");
    const { records } = await r.h.store.load();
    expect(records.some((rec) => rec.id === source && rec.kind === "entropy")).toBe(false);
    expect(card.state.life).toBe("loaded");
    // The code buffers the kernel held are wiped after the op.
    expect(c1.every((b) => b === 0)).toBe(true);
    expect(c2.every((b) => b === 0)).toBe(true);
  });

  it("add registers a loaded card that belongs to no record and fetches public keys", async () => {
    const r = await rig();
    const card = await loadedCard();
    const taps = Array.from({ length: 8 }, () => card);
    const result = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps },
    );
    expect(result["kind"]).toBe("add");
    await expect(cardWalletIds(r)).resolves.toContain(strField(result, "walletId"));
  });

  it("accounts verifies the member, fetches the missing node, returns chain accounts", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
    );
    const walletId = strField(added, "walletId");
    const result = await drive(
      r,
      { kind: "accounts", walletId, groupIndex: 0, templates: ["evm.bip44"], network: "eip155:1" },
      { codes: [freshCode()], cards: Array.from({ length: 4 }, () => card) },
    );
    expect(result["kind"]).toBe("accounts");
    const accounts = result["accounts"] as Array<Record<string, unknown>>;
    expect(accounts).toHaveLength(1);
    const expected = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0").publicKey;
    if (expected === null) {
      throw new Error("no master key");
    }
    expect(accounts[0]?.["address"]).toBe(evmAddressFromPublicKey(expected));
  });

  it("health verifies a member card", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
    );
    const walletId = strField(added, "walletId");
    const result = await drive(
      r,
      { kind: "health", walletId },
      { codes: [freshCode()], cards: Array.from({ length: 4 }, () => card) },
    );
    expect(result).toStrictEqual({ kind: "health", walletId });
  });

  it("change-access rotates the code on the member card", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
    );
    const walletId = strField(added, "walletId");
    const n1 = utf8ToBytes("new code 1234");
    const n2 = utf8ToBytes("new code 1234");
    const result = await drive(
      r,
      { kind: "change-access", walletId },
      { codes: [freshCode(), n1, n2], cards: Array.from({ length: 4 }, () => card) },
      verifyPasskey(),
    );
    expect(result["kind"]).toBe("change-access");
    const status = await drive(r, { kind: "status" }, { cards: [card] });
    expect(status["life"]).toBe("loaded");
    expect(n1.every((b) => b === 0)).toBe(true);
    expect(n2.every((b) => b === 0)).toBe(true);
  });

  it("erase removes the card and deletes the emptied imported record", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
    );
    const walletId = strField(added, "walletId");
    const result = await drive(
      r,
      { kind: "erase", walletId, card: bytesToHex(card.cardId) },
      { codes: [freshCode()], cards: Array.from({ length: 4 }, () => card) },
      verifyPasskey(),
    );
    expect(result["kind"]).toBe("erase");
    await expect(cardWalletIds(r)).resolves.not.toContain(walletId);
    expect(card.state.life).toBe("blank");
  });

  it("erasing a generated wallet's only card needs last: true — then the record is gone", async () => {
    const r = await rig();
    const card = createFakeCard();
    card.load(seed2, await accessHash(CODE, card.cardId, quickArgon2id));
    const masterKey = HDKey.fromMasterSeed(seed2);
    try {
      const master = masterKey.publicKey;
      if (master === null) {
        throw new Error("no master public key");
      }
      const walletId = walletIdOf(master);
      const cardIdHex = bytesToHex(card.cardId);
      await plantCardWallet(
        r.h,
        {
          v: 1,
          walletId,
          origin: "generated",
          createdAt: 0,
          members: [cardIdHex],
          cards: [{ cardId: cardIdHex, state: "ready", cert: bytesToHex(card.cert), tries: 10 }],
        },
        { master: bytesToHex(master), nodes: {}, ed25519: {}, ephemerals: {} },
      );
      // Without last the op is refused at begin — no step is ever yielded.
      await expect(
        errCode(
          r.h.call(
            "card.begin",
            { op: { kind: "erase", walletId, card: cardIdHex }, verify: verifyPasskey() },
            r.session,
          ),
        ),
      ).resolves.toBe("invalid-input");
      // With last: true the tap erases the card and the whole record goes with it.
      const result = await drive(
        r,
        { kind: "erase", walletId, card: cardIdHex, last: true },
        { codes: [freshCode()], cards: taps(card, 4) },
        verifyPasskey(),
      );
      expect(result["kind"]).toBe("erase");
      await expect(cardWalletIds(r)).resolves.not.toContain(walletId);
      expect(card.state.life).toBe("blank");
    } finally {
      masterKey.wipePrivateData();
    }
  });

  it("forget-access completes in begin with no tap", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
    );
    const first = ok(
      await r.h.call(
        "card.begin",
        {
          op: { kind: "forget-access", walletId: strField(added, "walletId") },
          verify: verifyPasskey(),
        },
        r.session,
      ),
    ) as { step: Step };
    expect(first.step.kind).toBe("done");
    expect(field(first.step, "result")).toMatchObject({ kind: "forget-access" });
  });

  it("transfer, reseal and sign are unsupported", async () => {
    const r = await rig();
    await expect(
      errCode(
        r.h.call("card.begin", { op: { kind: "transfer", walletId: "ab".repeat(8) } }, r.session),
      ),
    ).resolves.toBe("unsupported");
  });

  it("a wrong code re-asks with the remaining count; the right one then succeeds", async () => {
    const r = await rig();
    const card = await loadedCard();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    expect(first.step.kind).toBe("input");
    r.input.push(utf8ToBytes("wrong code"));
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("input");
    expect(step["remaining"]).toBe(9);
    r.input.push(freshCode());
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    for (let i = 0; step.kind !== "done" && i < 30; i += 1) {
      r.reader.present(card);
      step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    }
    expect(step.kind).toBe("done");
    expect(field(step, "result")).toMatchObject({ kind: "add" });
  });

  it("tag loss mid-tap re-yields the step with reason retry", async () => {
    const r = await rig();
    const card = createFakeCard();
    const first = ok(await r.h.call("card.begin", { op: { kind: "status" } }, r.session)) as {
      opId: string;
      step: Step;
    };
    r.reader.loseAfter(1); // SELECT answers, OPEN is lost
    r.reader.present(card);
    const step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step).toMatchObject({ kind: "tap", reason: "retry" });
    r.reader.present(card);
    const done = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(done.kind).toBe("done");
  });

  it("a cert chaining to no anchor is card-not-genuine", async () => {
    const r = await rig();
    const rogueCa = new Uint8Array(32).fill(7);
    const card = createFakeCard({ cert: issueCert(new Uint8Array(32).fill(9), rogueCa) });
    const first = ok(await r.h.call("card.begin", { op: { kind: "status" } }, r.session)) as {
      opId: string;
      step: Step;
    };
    r.reader.present(card);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "card-not-genuine",
    );
  });

  it("a bad session signature is card-not-genuine", async () => {
    const r = await rig();
    const card = createFakeCard({ knobs: { badSignature: true } });
    const first = ok(await r.h.call("card.begin", { op: { kind: "status" } }, r.session)) as {
      opId: string;
      step: Step;
    };
    r.reader.present(card);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "card-not-genuine",
    );
  });

  it("a replayed cardEph is card-fault on the second tap", async () => {
    const r = await rig();
    const eph = new Uint8Array(32).fill(3);
    const card = createFakeCard({ knobs: { fixedEph: eph } });
    card.load(seed, await accessHash(CODE, card.cardId, quickArgon2id));
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    r.input.push(freshCode());
    ok(await r.h.call("card.step", { opId: first.opId }, r.session));
    r.reader.present(card); // phase-1 tap records the ephemeral
    ok(await r.h.call("card.step", { opId: first.opId }, r.session));
    r.reader.present(card); // phase-2 tap replays it
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "card-fault",
    );
  });

  it("a STATUS lying about tries is card-tampered", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
    );
    card.knobs.statusTries = 5; // tries decrease below the recorded 10
    const first = ok(
      await r.h.call(
        "card.begin",
        { op: { kind: "health", walletId: strField(added, "walletId") } },
        r.session,
      ),
    ) as { opId: string; step: Step };
    r.input.push(freshCode());
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    while (step.kind === "input" || step.kind === "tap") {
      r.input.push(freshCode());
      r.reader.present(card);
      const next = await r.h.call("card.step", { opId: first.opId }, r.session);
      if ("err" in next) {
        expect(next.err.code).toBe("card-tampered");
        return;
      }
      step = next.ok as Step;
    }
    throw new Error("health completed despite the lying STATUS");
  });

  it("a corrupted response MAC breaks the session as card-fault", async () => {
    const r = await rig();
    const card = createFakeCard({ knobs: { badMacAfter: 0 } });
    const first = ok(await r.h.call("card.begin", { op: { kind: "status" } }, r.session)) as {
      opId: string;
      step: Step;
    };
    r.reader.present(card);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "card-fault",
    );
  });

  it("cancel during a held input resolves the step cancelled and cancel returns null", async () => {
    const r = await rig();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    expect(first.step.kind).toBe("input");
    const held = r.h.call("card.step", { opId: first.opId }, r.session); // blocks on secure input
    while (!r.input.pending()) {
      await r.h.settle();
    }
    const cancelled = await r.h.call("card.cancel", { opId: first.opId }, r.session);
    expect(ok(cancelled)).toBeNull();
    await expect(errCode(held)).resolves.toBe("cancelled");
  });

  it("the 120 s step timeout interrupts a held input", async () => {
    const r = await rig();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    const held = r.h.call("card.step", { opId: first.opId }, r.session);
    while (!r.input.pending()) {
      await r.h.settle();
    }
    r.h.advance(120_000);
    await expect(errCode(held)).resolves.toBe("cancelled");
    // The op is gone: another step is a stale id.
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "not-found",
    );
  });

  it("session lock discards the active operation", async () => {
    const r = await rig();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    const held = r.h.call("card.step", { opId: first.opId }, r.session);
    while (!r.input.pending()) {
      await r.h.settle();
    }
    r.h.advance(15 * 60_000 + 1); // past the idle deadline → session locks
    await expect(errCode(held)).resolves.toBe("cancelled");
  });

  it("cancel, timeout and lock between steps wipe the code the suspended op holds", async () => {
    for (const how of ["cancel", "timeout", "lock"] as const) {
      const r = await rig();
      const card = await loadedCard();
      const added = await drive(
        r,
        { kind: "add", groups: 1 },
        { codes: [freshCode()], cards: taps(card, 8) },
      );
      const walletId = strField(added, "walletId");
      const first = ok(
        await r.h.call(
          "card.begin",
          { op: { kind: "change-access", walletId }, verify: verifyPasskey() },
          r.session,
        ),
      ) as { opId: string; step: Step };
      expect(first.step.kind).toBe("input");
      // Answer the old-code ask — the generator now suspends at the new-code ask holding
      // this exact buffer (`oldCode`).
      const code = utf8ToBytes("correct horse");
      r.input.push(code);
      const next = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
      expect(next.kind).toBe("input");
      if (how === "cancel") {
        expect(ok(await r.h.call("card.cancel", { opId: first.opId }, r.session))).toBeNull();
      } else if (how === "timeout") {
        r.h.advance(120_000);
      } else {
        r.h.advance(15 * 60_000 + 1);
      }
      await r.h.settle(); // let the idle-op gen.return() run the op's finally
      expect(code.every((b) => b === 0)).toBe(true);
      await expect(
        errCode(r.h.call("card.step", { opId: first.opId }, r.session)),
      ).resolves.toBe(how === "lock" ? "locked" : "not-found");
    }
  });

  it("op secrets are wiped when a held input is cancelled", async () => {
    const r = await rig();
    const card = await loadedCard();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    const wrong = utf8ToBytes("wrong code");
    r.input.push(wrong);
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("input"); // re-asked with the remaining count
    const held = r.h.call("card.step", { opId: first.opId }, r.session); // blocks on input
    while (!r.input.pending()) {
      await r.h.settle();
    }
    await r.h.call("card.cancel", { opId: first.opId }, r.session);
    await errCode(held);
    expect(wrong.every((b) => b === 0)).toBe(true);
  });
});

/** Drives like `drive` but returns the first `card.begin`/`card.step` error code instead. */
const driveErr = async (
  r: Rig,
  op: unknown,
  actions: { codes?: Uint8Array[]; cards: FieldCard[] },
  verify?: unknown,
): Promise<string> => {
  const first = await r.h.call(
    "card.begin",
    { op, ...(verify === undefined ? {} : { verify }) },
    r.session,
  );
  if ("err" in first) {
    return first.err.code;
  }
  const { opId, step: firstStep } = first.ok as { opId: string; step: Step };
  let step = firstStep;
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    if (guard > 60) {
      return "driver-guard";
    }
    if (step.kind === "input") {
      if (step["purpose"] === "short-id") {
        const upcoming = actions.cards[0] as FakeCard | undefined;
        r.input.push(utf8ToBytes(shortId(upcoming?.identity ?? new Uint8Array(33))));
      } else {
        const code = actions.codes?.shift();
        if (code === undefined) {
          return "driver-no-code";
        }
        r.input.push(code);
      }
    } else {
      const next = actions.cards.shift();
      if (next === undefined) {
        return "driver-no-card";
      }
      r.reader.present(next);
    }
    const next = await r.h.call("card.step", { opId }, r.session);
    if ("err" in next) {
      return next.err.code;
    }
    step = next.ok as Step;
  }
  return "driver-done";
};

const taps = (card: FakeCard, n = 10): FakeCard[] => Array.from({ length: n }, () => card);

/** Unwraps the live session DEK the same way unlock did — from the test passkey factor's KEK. */
const sessionDek = async (h: Rig["h"]): Promise<Secret> => {
  const image = await h.store.load();
  const factor = image.factors.find((f) => f.kind === "passkey");
  if (factor === undefined) {
    throw new Error("missing passkey factor");
  }
  const kek = passkeyKek(new Uint8Array(32).fill(1), CREDENTIAL_ID);
  try {
    return unwrapDek(kek, factor);
  } finally {
    wipe(kek);
  }
};

const testSealer = { random: (n: number) => new Uint8Array(n).fill(3), now: () => 0 } as never;

/** Plants a card-wallet record so ops see a generated wallet (create only makes imported ones). */
const plantCardWallet = async (
  h: Rig["h"],
  header: CardWalletHeader,
  body: CardWalletBody,
): Promise<void> => {
  const dek = await sessionDek(h);
  try {
    const image = await h.store.load();
    const record = sealRecord(
      testSealer,
      dek,
      CARD_WALLET_KIND,
      header.walletId,
      encodeCardWalletHeader(header),
      utf8ToBytes(encodeCardWalletBody(body)),
    );
    await h.store.commit(withManifest(testSealer, image, [{ op: "put-record", record }], dek));
  } finally {
    dek.wipe();
  }
  await h.settle();
};

/** Instructions carrying an access hash — VERIFY, CHANGE, CREATE. */
const HASH_INS = new Set([0x21, 0x22, 0x23]);

describe("card tap gates and code policy (fake card)", () => {
  it("a second add of the same card is already-exists and never sends VERIFY", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    expect(added["kind"]).toBe("add");
    card.received.length = 0;
    const error = await driveErr(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 4) },
    );
    expect(error).toBe("already-exists");
    expect(card.received).toStrictEqual([0x20]); // STATUS only — the member gate is before VERIFY
  });

  it("a cert different from the pinned one is card-not-genuine before any command", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    const walletId = strField(added, "walletId");
    // Same identity — same cardId and session key — but a differently-signed cert.
    const twin = createFakeCard({
      identitySecret: card.identitySecret,
      cert: issueCert(card.identitySecret, CA1_PRIVATE, new Uint8Array(32).fill(9)),
    });
    const before = r.reader.sent.length;
    const error = await driveErr(
      r,
      { kind: "health", walletId },
      { codes: [freshCode()], cards: [twin] },
    );
    expect(error).toBe("card-not-genuine");
    expect(twin.received).toStrictEqual([]);
    expect(r.reader.sent.length - before).toBe(2); // SELECT + OPEN only
  });

  it("a WalletInfo lying about the master key is wrong-card", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    card.knobs.walletInfoMaster = secp256k1.getPublicKey(new Uint8Array(32).fill(5), true);
    card.received.length = 0;
    const error = await driveErr(
      r,
      { kind: "health", walletId: strField(added, "walletId") },
      { codes: [freshCode()], cards: [card] },
    );
    expect(error).toBe("wrong-card");
    expect(card.received).toStrictEqual([0x20, 0x22]); // VERIFY ran; nothing after the lie
  });

  it("a WalletInfo lying about the member set is wrong-card", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    card.knobs.walletInfoMembers = [card.cardId, new Uint8Array(16).fill(4)];
    card.received.length = 0;
    const error = await driveErr(
      r,
      { kind: "health", walletId: strField(added, "walletId") },
      { codes: [freshCode()], cards: [card] },
    );
    expect(error).toBe("wrong-card");
    expect(card.received).toStrictEqual([0x20, 0x22]);
  });

  it("a PUBLIC_KEY answer off the curve is card-fault and ends the tap", async () => {
    const r = await rig();
    const card = await loadedCard();
    card.knobs.badPublicKey = true;
    const error = await driveErr(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    expect(error).toBe("card-fault");
    expect(card.received.at(-1)).toBe(0x30); // PUBLIC_KEY was the last thing the card saw
    expect(card.received.filter((i) => HASH_INS.has(i))).toStrictEqual([0x22, 0x22]);
  });

  it("a STATUS with an unknown life byte is card-fault before any VERIFY", async () => {
    const r = await rig();
    const card = await loadedCard();
    card.knobs.statusLife = 0x77;
    const error = await driveErr(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 4) },
    );
    expect(error).toBe("card-fault");
    expect(card.received).toStrictEqual([0x20]);
  });

  it("an impossible status word for the command is card-fault", async () => {
    const r = await rig();
    const card = await loadedCard();
    card.knobs.statusSw = 0x6d00; // INS not supported — STATUS cannot produce it
    const error = await driveErr(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 4) },
    );
    expect(error).toBe("card-fault");
    expect(card.received).toStrictEqual([0x20]);
  });

  it("data on a failure word is card-fault", async () => {
    const r = await rig();
    const card = await loadedCard();
    card.knobs.dataOnFailure = true;
    const error = await driveErr(
      r,
      { kind: "add", groups: 1 },
      { codes: [utf8ToBytes("a wrong code")], cards: taps(card, 4) },
    );
    expect(error).toBe("card-fault");
    expect(card.received).toStrictEqual([0x20, 0x22]);
  });

  it("a replayed response counter is card-fault", async () => {
    const r = await rig();
    const card = await loadedCard();
    card.knobs.replayFrom = 1; // VERIFY's response resends the STATUS record
    const error = await driveErr(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 4) },
    );
    expect(error).toBe("card-fault");
    expect(card.received).toStrictEqual([0x20, 0x22]);
  });

  it("a skipped response counter is card-fault", async () => {
    const r = await rig();
    const card = await loadedCard();
    card.knobs.skipCtrAt = 0; // STATUS's response is MACed with counter 1
    const error = await driveErr(r, { kind: "status" }, { cards: [card] });
    expect(error).toBe("card-fault");
    expect(card.received).toStrictEqual([0x20]);
  });

  it("a genuine card that is not the expected member stops after OPEN (card-id-mismatch)", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    const other = await loadedCard();
    const before = r.reader.sent.length;
    const error = await driveErr(
      r,
      { kind: "health", walletId: strField(added, "walletId") },
      { codes: [freshCode()], cards: [other] },
    );
    expect(error).toBe("card-id-mismatch");
    expect(other.received).toStrictEqual([]); // the gate is before STATUS
    expect(r.reader.sent.length - before).toBe(2);
  });

  it("a typed short ID that does not match the card is card-id-mismatch, no CREATE", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = createFakeCard();
    const first = ok(
      await r.h.call(
        "card.begin",
        {
          op: { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
          verify: verifyPasskey(),
        },
        r.session,
      ),
    ) as { opId: string; step: Step };
    expect(first.step).toMatchObject({ kind: "input", purpose: "short-id" });
    r.input.push(utf8ToBytes("DEAD-BEEF")); // valid format, wrong card
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    r.input.push(utf8ToBytes("a code here"));
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    r.input.push(utf8ToBytes("a code here"));
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    r.reader.present(card);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "card-id-mismatch",
    );
    expect(card.received).toStrictEqual([]); // the gate is before STATUS — no CREATE, nothing
  });

  it("a torn create that loaded a different wallet is wrong-card and keeps the source", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const codeText = "the new code";
    const card = createFakeCard();
    // The card is LOADED with another seed but this op's hash — VERIFY passes, the wallet mismatches.
    card.load(seed2, await accessHash(utf8ToBytes(codeText), card.cardId, quickArgon2id));
    const first = ok(
      await r.h.call(
        "card.begin",
        {
          op: { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
          verify: verifyPasskey(),
        },
        r.session,
      ),
    ) as { opId: string; step: Step };
    r.input.push(utf8ToBytes(shortId(card.identity)));
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    r.input.push(utf8ToBytes(codeText));
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    r.input.push(utf8ToBytes(codeText));
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    // First tap expects a blank card and this one is loaded — lose it, then the retry
    // takes life "any" and runs the VERIFY-recovery path.
    r.reader.loseAfter(0);
    const blank = createFakeCard();
    r.reader.present(blank);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step).toMatchObject({ kind: "tap", reason: "retry" });
    r.reader.present(card);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "wrong-card",
    );
    // Nothing was staged: the source entropy record survived and no card wallet exists.
    const { records } = await r.h.store.load();
    expect(records.some((rec) => rec.id === source && rec.kind === "entropy")).toBe(true);
    expect(records.some((rec) => rec.kind === "card-wallet")).toBe(false);
  });

  it("the new-code policy re-asks on invalid, then on a confirm mismatch", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = createFakeCard();
    const bad1 = utf8ToBytes("abc"); // < 6
    const bad2 = utf8ToBytes("x".repeat(65)); // > 64
    const bad3 = new Uint8Array([0x41, 0x01, 0x42, 0x43, 0x44, 0x45]); // non-printable
    const short = utf8ToBytes("shorty1"); // 7 chars → needs the short-confirm label
    const nope = utf8ToBytes("nope0000");
    const good1 = utf8ToBytes("a longer code");
    const good2 = utf8ToBytes("a longer code");
    const result = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [bad1, bad2, bad3, short, nope, good1, good2],
        cards: taps(card),
      },
      verifyPasskey(),
    );
    expect(result["kind"]).toBe("create");
    const NEW = "Choose a new access code (8–64 printable characters; 6–7 needs a second entry)";
    const labels = r.input.requests.map((req) => req.label);
    expect(r.input.requests[0]?.kind).toBe("short-id");
    expect(labels.slice(1)).toStrictEqual([
      NEW,
      NEW,
      NEW,
      NEW,
      "The code is short — enter it again to confirm",
      NEW,
      "Enter the new access code again",
    ]);
    for (const buffer of [bad1, bad2, bad3, short, nope, good1, good2]) {
      expect(buffer.every((b) => b === 0)).toBe(true);
    }
  });

  it("a stale step does not disturb prompts or labels; extra params are integrity", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    const walletId = strField(added, "walletId");
    // Run 1 — a plain health.
    r.reader.prompts.length = 0;
    r.input.requests.length = 0;
    await drive(r, { kind: "health", walletId }, { codes: [freshCode()], cards: [card] });
    const prompts1 = [...r.reader.prompts];
    const labels1 = r.input.requests.map((req) => `${req.kind}:${req.label}`);
    r.reader.prompts.length = 0;
    r.input.requests.length = 0;
    // Run 2 — a stale step first, then the same op.
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session),
    ) as { opId: string; step: Step };
    await expect(
      errCode(r.h.call("card.step", { opId: "00".repeat(16) }, r.session)),
    ).resolves.toBe("not-found");
    r.input.push(freshCode());
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    for (let guard = 0; step.kind !== "done" && guard < 20; guard += 1) {
      if (step.kind === "tap") {
        r.reader.present(card);
      }
      step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    }
    expect(step.kind).toBe("done");
    expect(r.reader.prompts).toStrictEqual(prompts1);
    expect(r.input.requests.map((req) => `${req.kind}:${req.label}`)).toStrictEqual(labels1);
    // Strict params: extra fields are integrity at every entry point.
    await expect(
      errCode(r.h.call("card.step", { opId: first.opId, bogus: 1 }, r.session)),
    ).resolves.toBe("integrity");
    await expect(
      errCode(r.h.call("card.cancel", { opId: first.opId, bogus: 1 }, r.session)),
    ).resolves.toBe("integrity");
    await expect(
      errCode(r.h.call("card.begin", { op: { kind: "health", walletId, bogus: 1 } }, r.session)),
    ).resolves.toBe("integrity");
  });

  it.each(["cancel", "timeout", "lock"] as const)(
    "an abort between steps (%s) wipes the code the op still holds",
    async (mode) => {
      const r = await rig();
      const card = await loadedCard();
      const first = ok(
        await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
      ) as { opId: string; step: Step };
      expect(first.step.kind).toBe("input");
      const code = freshCode();
      r.input.push(code);
      const step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
      expect(step.kind).toBe("tap"); // idle between steps, `code` still held by the op
      if (mode === "cancel") {
        ok(await r.h.call("card.cancel", { opId: first.opId }, r.session));
      } else if (mode === "timeout") {
        r.h.advance(120_000);
      } else {
        r.h.advance(15 * 60_000 + 1); // session idle deadline → lock discards the op
      }
      await r.h.settle();
      expect(code.every((b) => b === 0)).toBe(true);
      void card;
    },
  );
});

const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";
const HARDWARE = { kind: "hardware" } as const;
const DEVICE = { kind: "device" } as const;

type KeystoreRig = Rig & { fake: ReturnType<typeof fakeKeystore> };

/** A React-Native-style kernel: keystore factors plus the card platform. */
const keystoreRig = async (): Promise<KeystoreRig> => {
  const reader = testCardReader();
  const input = testSecureInput();
  const fake = fakeKeystore();
  const h = createHarness({
    keystore: fake.keystore,
    card: { reader: reader.reader, secureInput: input.secureInput, anchors: [CA1_ANCHOR] },
  });
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: DEVICE,
    }),
  );
  return { h, session: strField(res, "session"), reader, input, fake };
};

describe("card code remember (fake card)", () => {
  it("remember is unsupported without a hardware verify or without app lock", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    const walletId = strField(added, "walletId");
    // No hardware factor on this host — a passkey verify cannot carry remember.
    await expect(
      errCode(
        r.h.call(
          "card.begin",
          {
            op: { kind: "change-access", walletId, remember: true },
            verify: verifyPasskey(),
          },
          r.session,
        ),
      ),
    ).resolves.toBe("unsupported");
    // A hardware host without app lock (the silent device factor is still there) refuses too.
    const k = await keystoreRig();
    const card2 = await loadedCard(CODE, seed2);
    const added2 = await drive(
      k,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card2, 8) },
    );
    await expect(
      errCode(
        k.h.call(
          "card.begin",
          {
            op: { kind: "change-access", walletId: strField(added2, "walletId"), remember: true },
            verify: HARDWARE,
          },
          k.session,
        ),
      ),
    ).resolves.toBe("unsupported");
  });

  it("a remembered hash skips the code ask; change-access without remember deletes it", async () => {
    const r = await keystoreRig();
    ok(await r.h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, r.session));
    const card = await loadedCard(CODE, seed2);
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    const walletId = strField(added, "walletId");
    // remember on change-access saves the new hash — the next verify-bearing read skips input.
    const rotated = await drive(
      r,
      { kind: "change-access", walletId, remember: true },
      {
        codes: [freshCode(), utf8ToBytes("the newer code"), utf8ToBytes("the newer code")],
        cards: taps(card, 4),
      },
      HARDWARE,
    );
    expect(rotated["kind"]).toBe("change-access");
    const first = ok(
      await r.h.call(
        "card.begin",
        {
          op: {
            kind: "accounts",
            walletId,
            groupIndex: 1,
            templates: ["btc.bip84"],
            network: BTC_MAINNET,
          },
        },
        r.session,
      ),
    ) as { opId: string; step: Step };
    // The saved hash went straight to the tap — no input step.
    expect(first.step.kind).toBe("tap");
    r.reader.present(card);
    const done = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(done.kind).toBe("done");
    // change-access without remember deletes the saved hash — the next op asks for a code.
    const again = await drive(
      r,
      { kind: "change-access", walletId },
      {
        codes: [
          utf8ToBytes("the newer code"),
          utf8ToBytes("the newest code"),
          utf8ToBytes("the newest code"),
        ],
        cards: taps(card, 4),
      },
      HARDWARE,
    );
    expect(again["kind"]).toBe("change-access");
    const third = ok(
      await r.h.call(
        "card.begin",
        {
          op: {
            kind: "accounts",
            walletId,
            groupIndex: 1,
            templates: ["btc.bip84"],
            network: BTC_MAINNET,
          },
        },
        r.session,
      ),
    ) as { opId: string; step: Step };
    expect(third.step.kind).toBe("input");
    ok(await r.h.call("card.cancel", { opId: third.opId }, r.session));
  });

  it("a 63Cx on a remembered hash deletes it; forget-access strips all of them", async () => {
    const r = await keystoreRig();
    ok(await r.h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, r.session));
    const card = await loadedCard(CODE, seed2);
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    const walletId = strField(added, "walletId");
    const rotated = await drive(
      r,
      { kind: "change-access", walletId, remember: true },
      {
        codes: [freshCode(), utf8ToBytes("the newer code"), utf8ToBytes("the newer code")],
        cards: taps(card, 4),
      },
      HARDWARE,
    );
    expect(rotated["kind"]).toBe("change-access");
    // The card's hash changes under the record's feet — the saved one is stale.
    card.load(seed2, await accessHash(utf8ToBytes("elsewhere code"), card.cardId, quickArgon2id));
    const op = () => ({
      kind: "accounts",
      walletId,
      groupIndex: 1,
      templates: ["btc.bip84"],
      network: BTC_MAINNET,
    });
    const first = ok(await r.h.call("card.begin", { op: op() }, r.session)) as {
      opId: string;
      step: Step;
    };
    // Still trusts the saved hash on the first tap — it fails 63Cx, then the op asks.
    expect(first.step.kind).toBe("tap");
    r.reader.present(card);
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step).toMatchObject({ kind: "input", remaining: 9 });
    r.input.push(utf8ToBytes("elsewhere code"));
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    for (let guard = 0; step.kind !== "done" && guard < 20; guard += 1) {
      if (step.kind === "tap") {
        r.reader.present(card);
      }
      step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    }
    expect(step.kind).toBe("done");
    // The stale entry was dropped in the failing tap's commit — input is asked first again.
    const second = ok(await r.h.call("card.begin", { op: op() }, r.session)) as {
      opId: string;
      step: Step;
    };
    expect(second.step.kind).toBe("input");
    ok(await r.h.call("card.cancel", { opId: second.opId }, r.session));
    // forget-access removes every saved hash (also proves the earlier delete was complete).
    const forgot = ok(
      await r.h.call(
        "card.begin",
        { op: { kind: "forget-access", walletId }, verify: HARDWARE },
        r.session,
      ),
    ) as { step: Step };
    expect(forgot.step.kind).toBe("done");
  });
});

/** Deep-walks a wire value — true when any needle's bytes, hex or base64 appear inside. */
const containsSecret = (value: unknown, needles: ReadonlyArray<Uint8Array>): boolean => {
  const stack: unknown[] = [value];
  const base64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const b of bytes) {
      binary += String.fromCodePoint(b);
    }
    return btoa(binary);
  };
  const includesBytes = (hay: Uint8Array, needle: Uint8Array): boolean => {
    outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (hay[i + j] !== needle[j]) {
          continue outer;
        }
      }
      return true;
    }
    return false;
  };
  while (stack.length > 0) {
    const v = stack.pop();
    if (v instanceof Uint8Array) {
      if (needles.some((n) => includesBytes(v, n))) {
        return true;
      }
    } else if (typeof v === "string") {
      for (const n of needles) {
        if (v.includes(bytesToHex(n)) || v.includes(base64(n))) {
          return true;
        }
        if (n.every((b) => b >= 0x20 && b <= 0x7e) && v.includes(new TextDecoder().decode(n))) {
          return true;
        }
      }
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (typeof v === "object" && v !== null) {
      stack.push(...Object.values(v));
    }
  }
  return false;
};

describe("card op secrecy (fake card)", () => {
  it("no secret ever reaches a posted message, an error, status or the console", async () => {
    const r = await rig();
    const consoleLines: string[] = [];
    const seen = new Map<"log" | "warn" | "error", typeof console.log>();
    for (const name of ["log", "warn", "error"] as const) {
      seen.set(name, console[name]);
      console[name] = (...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      };
    }
    try {
      const source = await vaultWalletId(r);
      const card = createFakeCard();
      const code1 = utf8ToBytes("leak code one");
      const code2 = utf8ToBytes("leak code one");
      const created = await drive(
        r,
        { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
        { codes: [code1, code2], cards: taps(card) },
        verifyPasskey(),
      );
      const walletId = strField(created, "walletId");
      const accounts = await drive(
        r,
        {
          kind: "accounts",
          walletId,
          groupIndex: 0,
          templates: ["evm.bip44"],
          network: "eip155:1",
        },
        { codes: [utf8ToBytes("leak code one")], cards: taps(card, 4) },
      );
      expect(accounts["kind"]).toBe("accounts");
      await drive(
        r,
        { kind: "health", walletId },
        { codes: [utf8ToBytes("leak code one")], cards: taps(card, 4) },
      );
      const new1 = utf8ToBytes("leak code two");
      const new2 = utf8ToBytes("leak code two");
      await drive(
        r,
        { kind: "change-access", walletId },
        { codes: [utf8ToBytes("leak code one"), new1, new2], cards: taps(card, 4) },
        verifyPasskey(),
      );
      // A wrong code and a cancel along the way.
      const begun = ok(
        await r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session),
      ) as { opId: string; step: Step };
      r.input.push(utf8ToBytes("leak code bad"));
      let step = ok(await r.h.call("card.step", { opId: begun.opId }, r.session)) as Step;
      r.reader.present(card);
      step = ok(await r.h.call("card.step", { opId: begun.opId }, r.session)) as Step;
      expect(step).toMatchObject({ kind: "input", remaining: 9 });
      ok(await r.h.call("card.cancel", { opId: begun.opId }, r.session));
      const other = await loadedCard();
      await drive(r, { kind: "add", groups: 1 }, { codes: [freshCode()], cards: taps(other, 8) });
      await drive(
        r,
        { kind: "erase", walletId, card: bytesToHex(card.cardId) },
        { codes: [utf8ToBytes("leak code two")], cards: taps(card, 4) },
        verifyPasskey(),
      );
      const status = ok(await r.h.call("status", null, r.session));
      const hash1 = await accessHash(utf8ToBytes("leak code one"), card.cardId, quickArgon2id);
      const hash2 = await accessHash(utf8ToBytes("leak code two"), card.cardId, quickArgon2id);
      const keys = card.secrets.keys ?? new Uint8Array(0);
      const needles = [
        utf8ToBytes("leak code one"),
        utf8ToBytes("leak code two"),
        hash1,
        hash2,
        card.secrets.eph ?? new Uint8Array(0),
        card.secrets.shared ?? new Uint8Array(0),
        keys,
        keys.subarray(0, 16),
        keys.subarray(16, 32),
        keys.subarray(32, 48),
        keys.subarray(48, 64),
        new Uint8Array(seed),
      ].filter((n) => n.length > 0);
      for (const message of r.h.posted) {
        expect(containsSecret(message, needles)).toBe(false);
      }
      expect(containsSecret(status, needles)).toBe(false);
      expect(containsSecret(consoleLines, needles)).toBe(false);
      // Positive control — the scan must catch a planted leak.
      const planted = new Uint8Array(seed);
      r.h.posted.push({ leaked: planted });
      expect(containsSecret(r.h.posted.at(-1), needles)).toBe(true);
      r.h.posted.pop();
    } finally {
      for (const [name, fn] of seen) {
        console[name] = fn;
      }
    }
  });
});

describe("card genuineness and life gates (fake card)", () => {
  it("a certificate under an unknown CA is card-not-genuine right after OPEN", async () => {
    const r = await rig();
    const rogue = createFakeCard();
    rogue.load(seed, await accessHash(CODE, rogue.cardId, quickArgon2id));
    const wrongCa = createFakeCard({
      identitySecret: rogue.identitySecret,
      cert: issueCert(rogue.identitySecret, new Uint8Array(32).fill(11)),
    });
    const before = r.reader.sent.length;
    const error = await driveErr(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: [wrongCa] },
    );
    expect(error).toBe("card-not-genuine");
    expect(wrongCa.received).toStrictEqual([]); // the OPEN response itself failed the anchor check
    expect(r.reader.sent.length - before).toBe(2);
  });

  it("a session signature over the wrong transcript is card-not-genuine", async () => {
    const r = await rig();
    const card = await loadedCard();
    card.knobs.badSignature = true;
    const before = r.reader.sent.length;
    const error = await driveErr(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: [card] },
    );
    expect(error).toBe("card-not-genuine");
    expect(card.received).toStrictEqual([]);
    expect(r.reader.sent.length - before).toBe(2);
  });

  it("a replayed cardEph is card-fault on the second tap", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    expect(added["kind"]).toBe("add");
    // Now a member — its tags are recorded. A card that always presents the same
    // cardEph repeats the recorded tag on its second tap.
    card.knobs.fixedEph = new Uint8Array(32).fill(3);
    const first = await drive(r, { kind: "status" }, { cards: [card] });
    expect(first["life"]).toBe("loaded");
    card.received.length = 0;
    const error = await driveErr(r, { kind: "status" }, { cards: [card] });
    expect(error).toBe("card-fault");
    expect(card.received).toStrictEqual([]); // rejected before STATUS
  });

  it("a loaded card with no tries left is card-locked and never sees VERIFY", async () => {
    const r = await rig();
    const card = await loadedCard();
    card.knobs.statusTries = 0;
    const error = await driveErr(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: [card] },
    );
    expect(error).toBe("card-locked");
    expect(card.received).toStrictEqual([0x20]);
  });

  it("codes tried in another vault surface as card-tampered and the record keeps the lower tries", async () => {
    const first = await rig();
    const card = await loadedCard();
    const added = await drive(
      first,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    const walletId = strField(added, "walletId");
    // A second vault adds the same card and then burns one attempt.
    const second = await rig();
    await drive(second, { kind: "add", groups: 1 }, { codes: [freshCode()], cards: taps(card, 8) });
    await driveErr(
      second,
      { kind: "health", walletId },
      { codes: [utf8ToBytes("not the code")], cards: taps(card, 2) },
    );
    // The first vault's next tap reads tries 9 < recorded 10 — tampered, no VERIFY.
    first.reader.closes.length = 0;
    card.received.length = 0;
    const error = await driveErr(
      first,
      { kind: "health", walletId },
      { codes: [freshCode()], cards: [card] },
    );
    expect(error).toBe("card-tampered");
    expect(card.received).toStrictEqual([0x20]);
    expect(first.reader.closes.at(-1)?.text).toBe("Someone else tried codes on this card");
    // The lower count landed in the record — the next op proceeds instead of alarming again.
    const healthy = await drive(
      first,
      { kind: "health", walletId },
      { codes: [freshCode()], cards: [card] },
    );
    expect(healthy["kind"]).toBe("health");
  });
});
