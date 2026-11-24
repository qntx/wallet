import { secp256k1 } from "@noble/curves/secp256k1.js";
// oxlint-disable eslint/no-await-in-loop, vitest/no-conditional-in-test, vitest/no-conditional-expect -- the step driver is sequential and conditional by design
/**
 * The layer-3 operation engine end to end against the configurable fake card: every single-card op
 * (`status`, `add`, `accounts`, `health`, `change-access`, `erase`, `create`, `forget-access`), the
 * tap gates (ephemeral replay, cert trust, status lies, wrong codes, tag loss), and the operation
 * lifecycle (cancel, timeout, lock, secret wiping).
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { normalizeBitcoin, verifyBitcoinPsbtSignatures } from "@qntx/wallet-chains/bitcoin";
import {
  encodeBatchExecute,
  evmAddressFromPublicKey,
  normalizeEvm,
  recoverEvmSigner,
} from "@qntx/wallet-chains/evm";
import { normalizeSolana, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import type { ChainTemplate } from "@qntx/wallet/protocol";
import type { WalletInfo } from "@qntx/wallet/types";

import { walletIdOf } from "../src/derive/wallet-id.ts";
import { DEFAULT_GROUPS, registrationPaths } from "../src/modules/card/ops/shared.ts";
import { accessHash } from "../src/modules/card/protocol/access.ts";
import { shortId } from "../src/modules/card/protocol/identity.ts";
import { encodeCardWalletBody, encodeCardWalletHeader } from "../src/modules/card/record.ts";
import type { CardWalletBody, CardWalletHeader } from "../src/modules/card/record.ts";
import type { Argon2id } from "../src/platform.ts";
import { wipe } from "../src/secret/secret.ts";
import type { Secret } from "../src/secret/secret.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { passkeyKek, unwrapDek } from "../src/vault/factors.ts";
import { encodeHeader } from "../src/vault/headers.ts";
import { withManifest } from "../src/vault/manifest.ts";
import { CARD_WALLET_KIND } from "../src/vault/store.ts";
import type { RecordStore } from "../src/vault/store.ts";
import { sealRecord } from "../src/vault/vault.ts";
import { CA1_PRIVATE, createFakeCard, issueCert } from "./card/fake-card.ts";
import type { FakeCard } from "./card/fake-card.ts";
import { testSecureInput } from "./card/input.ts";
import { testCardReader } from "./card/reader.ts";
import { CA1_ANCHOR } from "./card/sim.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness, detachTransferables } from "./harness.ts";
import { quickArgon2id, subtlePbkdf2 } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";
import { LOOKUP_RECIPIENT, lookupTransferRequest } from "./solana-lookup-fixture.ts";

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

const rig = async (
  planMs?: number,
  extra?: {
    idleMs?: number;
    argon2id?: Argon2id;
    wrapStore?: (store: RecordStore) => RecordStore;
  },
): Promise<Rig> => {
  const reader = testCardReader();
  const input = testSecureInput();
  const h = createHarness({
    card: {
      reader: reader.reader,
      anchors: [CA1_ANCHOR],
      ...(planMs === undefined ? {} : { planMs }),
    },
    secureInput: input.secureInput,
    ...extra,
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

  it("create registers every public key in one member tap", async () => {
    // Regression: under Hermes a per-iteration `tap.update` closure captured the last path, so
    // only one node landed per tap — a real phone tapped once per registration path.
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
    // One CREATE tap, then a single member tap that registers all registrationPaths keys.
    expect(r.reader.prompts).toHaveLength(2);
    expect(r.reader.sessionLengths).toStrictEqual([
      4,
      4 + registrationPaths(DEFAULT_GROUPS).length,
    ]);
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

  it("unknown op kinds are rejected", async () => {
    const r = await rig();
    await expect(
      errCode(
        r.h.call("card.begin", { op: { kind: "not-an-op", walletId: "ab".repeat(8) } }, r.session),
      ),
    ).resolves.toBe("integrity");
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

  it("an uninitialised card is card-not-genuine and the wallet never initialises it", async () => {
    const r = await rig();
    // §4.3: a factory-state card answers every command but SELECT/GET_IDENTITY with 6283.
    const card = createFakeCard({ knobs: { uninitialised: true } });
    const first = ok(await r.h.call("card.begin", { op: { kind: "status" } }, r.session)) as {
      opId: string;
      step: Step;
    };
    r.reader.present(card);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "card-not-genuine",
    );
    // The wallet never drives the 7-step init: no GET_IDENTITY (0xe0) APDU was transmitted.
    expect(r.reader.sent.every((apdu) => apdu[1] !== 0xe0)).toBe(true);
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

  it("a torn VERIFY is forgiven once — the retry accepts recorded − 1", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
    );
    const walletId = strField(added, "walletId");
    // VERIFY's second write commits the bumped counter, then the card dies mid-response:
    // fails is now 1 (tries 9) and the kernel never saw the answer. The retry's STATUS reads
    // recorded − 1 — forgiven once, the op finishes, and VERIFY's reset lands 10 again.
    card.tearAt(2);
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session),
    ) as { opId: string; step: Step };
    r.input.push(freshCode());
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step).toMatchObject({ kind: "tap", reason: "retry" });
    card.reset(); // power cycle — a torn card answers nothing until it is
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("done");
    expect(card.state.fails).toBe(0);
  });

  it("tries recorded − 2 is still card-tampered after a torn VERIFY", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
    );
    const walletId = strField(added, "walletId");
    card.tearAt(2); // torn VERIFY — one unaccounted attempt (fails = 1)
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session),
    ) as { opId: string; step: Step };
    r.input.push(freshCode());
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step).toMatchObject({ kind: "tap", reason: "retry" });
    // Another failure this kernel did not make — the read-back is recorded − 2, which the
    // single-attempt allowance must not forgive.
    card.state.fails += 1;
    card.reset();
    r.reader.present(card);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "card-tampered",
    );
  });

  it("a tag loss before the VERIFY transmit arms no allowance", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
    );
    const walletId = strField(added, "walletId");
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session),
    ) as { opId: string; step: Step };
    r.input.push(freshCode());
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    r.reader.loseAfter(2); // SELECT and OPEN answer — STATUS is lost, VERIFY never sent
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step).toMatchObject({ kind: "tap", reason: "retry" });
    // A foreign attempt meanwhile: recorded − 1 with no armed allowance is tampering.
    card.state.fails = 1;
    r.reader.present(card);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "card-tampered",
    );
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

  it("a held secure input answers cancelled and a queued vault.reset follows it", async () => {
    const r = await rig();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    expect(first.step.kind).toBe("input");
    const held = r.h.call("card.step", { opId: first.opId }, r.session); // blocks on secure input
    while (!r.input.pending()) {
      await r.h.settle();
    }
    // Requests are serial — the reset runs once the held input is dismissed.
    const reset = r.h.call("vault.reset", null, r.session);
    r.input.secureInput.cancel();
    await expect(errCode(held)).resolves.toBe("cancelled");
    expect(ok(await reset)).toBeNull();
    // The session died with the vault — the op id resolves nothing.
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "locked",
    );
  });

  it("vault.reset discards a suspended op — the code it holds is wiped", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: Array.from({ length: 8 }, () => card) },
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
    // Answer the old-code ask — the generator suspends at the new-code ask holding this buffer.
    const code = utf8ToBytes("correct horse");
    r.input.push(code);
    const next = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(next.kind).toBe("input");
    ok(await r.h.call("vault.reset", null, r.session));
    await r.h.settle(); // let the discarded op's finally wipe the code it was holding
    expect(code.every((b) => b === 0)).toBe(true);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "locked",
    );
    // A freshly established vault lists no card wallets.
    const res = ok(
      await r.h.call("wallet.createWithPasskey", {
        ceremony: "host",
        credentialId: CREDENTIAL_ID,
        prfWallet: new Uint8Array(32).fill(2),
        synced: true,
        factor: verifyPasskey(),
      }),
    );
    const session2 = strField(res, "session");
    const status = ok(await r.h.call("status", null, session2)) as { wallets: WalletInfo[] };
    expect(status.wallets.some((w) => w.custody === "card")).toBe(false);
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
      await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
        how === "lock" ? "locked" : "not-found",
      );
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

  it("a WalletInfo lying about the master key is wrong-device", async () => {
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
    expect(error).toBe("wrong-device");
    expect(card.received).toStrictEqual([0x20, 0x22]); // VERIFY ran; nothing after the lie
  });

  it("a WalletInfo lying about the member set is wrong-device", async () => {
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
    expect(error).toBe("wrong-device");
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

  it("a torn create that loaded a different wallet is wrong-device and keeps the source", async () => {
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
      "wrong-device",
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
    const bad4 = new Uint8Array([0x41, 0x80, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]); // > 0x7e
    const short = utf8ToBytes("shorty1"); // 7 chars → needs the short-confirm label
    const nope = utf8ToBytes("nope0000");
    const good1 = utf8ToBytes("a longer code");
    const good2 = utf8ToBytes("a longer code");
    const result = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [bad1, bad2, bad3, bad4, short, nope, good1, good2],
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
      NEW,
      "The code is short — enter it again to confirm",
      NEW,
      "Enter the new access code again",
    ]);
    for (const buffer of [bad1, bad2, bad3, bad4, short, nope, good1, good2]) {
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

  it.each(["accounts", "health", "erase", "create", "sign"] as const)(
    "an abort between steps wipes the code a %s op still holds",
    async (kind) => {
      const r = await rig();
      const card = await loadedCard();
      const source = await vaultWalletId(r);
      const walletId =
        kind === "create"
          ? source
          : strField(
              await drive(
                r,
                { kind: "add", groups: 1 },
                { codes: [freshCode()], cards: taps(card) },
              ),
              "walletId",
            );
      const op =
        kind === "accounts"
          ? { kind, walletId, groupIndex: 1, templates: ["btc.bip84"], network: BTC_MAINNET }
          : kind === "create"
            ? { kind, cards: 1, source: { kind: "wallet", walletId: source } }
            : kind === "sign"
              ? {
                  kind,
                  request: normalizeEvm({
                    kind: "evm.personal-message",
                    network: "eip155:1",
                    account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
                    message: utf8ToBytes("wipe check"),
                  }),
                }
              : {
                  kind,
                  walletId,
                  ...(kind === "erase" ? { card: bytesToHex(card.cardId) } : {}),
                };
      const first = ok(
        await r.h.call(
          "card.begin",
          {
            op,
            ...(kind === "create" || kind === "erase" || kind === "sign"
              ? { verify: verifyPasskey() }
              : {}),
          },
          r.session,
        ),
      ) as { opId: string; step: Step };
      // Walk past any short-id asks to the first code ask; create types it for the card.
      let { step } = first;
      for (
        let guard = 0;
        step.kind === "input" && step["purpose"] === "short-id" && guard < 5;
        guard += 1
      ) {
        r.input.push(utf8ToBytes(shortId(card.identity)));
        step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
      }
      expect(step.kind).toBe("input");
      const code = freshCode();
      r.input.push(code);
      step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
      if (step.kind === "input") {
        // create's confirm ask — answer it so the op carries `code` into the tap.
        r.input.push(code);
        step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
      }
      // Suspended at the next tap — `code` is held by the op.
      expect(step.kind).toBe("tap");
      ok(await r.h.call("card.cancel", { opId: first.opId }, r.session));
      await r.h.settle();
      expect(code.every((b) => b === 0)).toBe(true);
    },
  );

  it("a lock during a held input interrupts the step — cancelled", async () => {
    const r = await rig();
    const card = await loadedCard();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    expect(first.step.kind).toBe("input");
    const pending = r.h.call("card.step", { opId: first.opId }, r.session);
    await new Promise((resolve) => setTimeout(resolve)); // the input request is now pending
    r.h.advance(15 * 60_000 + 1); // session idle deadline → lock interrupts the request
    await expect(errCode(pending)).resolves.toBe("cancelled");
    void card;
  });

  it("a second card.begin discards the first op and wipes the code it held", async () => {
    const r = await rig();
    const card = await loadedCard();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    const code = freshCode();
    r.input.push(code);
    const step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap"); // idle between steps, `code` still held
    const second = ok(await r.h.call("card.begin", { op: { kind: "status" } }, r.session)) as {
      opId: string;
      step: Step;
    };
    expect(second.step.kind).toBe("tap");
    await r.h.settle();
    expect(code.every((b) => b === 0)).toBe(true);
    ok(await r.h.call("card.cancel", { opId: second.opId }, r.session));
    void card;
  });

  it("cancel interrupts an in-flight tap — the held step resolves cancelled", async () => {
    const r = await rig();
    const card = await loadedCard();
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card) },
    );
    const walletId = strField(added, "walletId");
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session),
    ) as { opId: string; step: Step };
    r.input.push(freshCode());
    const step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    const slow: FieldCard = {
      transmit: async (apdu) =>
        new Promise((resolve) => setTimeout(() => resolve(card.transmit(apdu)), 30)),
    };
    r.reader.present(slow);
    const pending = r.h.call("card.step", { opId: first.opId }, r.session);
    await new Promise((resolve) => setTimeout(resolve)); // let the step go in-flight
    r.h.advance(15 * 60_000 + 1); // lock mid-tap — the held step aborts
    const res = await pending;
    // Any failure wins here — what matters is the step does not resume the op.
    expect("err" in res).toBe(true);
  });

  it("a cancelled op frees the slot — the next begin works", async () => {
    const r = await rig();
    const card = await loadedCard();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    ok(await r.h.call("card.cancel", { opId: first.opId }, r.session));
    const second = ok(await r.h.call("card.begin", { op: { kind: "status" } }, r.session)) as {
      step: Step;
    };
    expect(second.step.kind).toBe("tap");
    void card;
  });

  it("the 120 s clock re-arms on every step — slow steps do not age the op out", async () => {
    const r = await rig();
    const card = await loadedCard();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    r.h.advance(100_000); // 100 s passes before the code arrives
    r.input.push(freshCode());
    const step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    r.h.advance(100_000); // another 100 s before the card lands — over 120 total
    r.reader.present(card);
    const next = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(next.kind === "tap" || next.kind === "done" || next.kind === "input").toBe(true);
    ok(await r.h.call("card.cancel", { opId: first.opId }, r.session));
  });
});

const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";
const HARDWARE = { kind: "hardware" } as const;
const DEVICE = { kind: "device" } as const;

type KeystoreRig = Rig & { fake: ReturnType<typeof fakeKeystore> };

/** A React-Native-style kernel: keystore factors plus the card platform. */
const keystoreRig = async (platform: "ios" | "android" = "ios"): Promise<KeystoreRig> => {
  const reader = testCardReader();
  const input = testSecureInput();
  const fake = fakeKeystore("en-US", platform);
  const h = createHarness({
    keystore: fake.keystore,
    card: { reader: reader.reader, anchors: [CA1_ANCHOR] },
    secureInput: input.secureInput,
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
    // Stripped for real — the next op asks for the code instead of reusing a saved hash.
    const third = ok(await r.h.call("card.begin", { op: op() }, r.session)) as {
      opId: string;
      step: Step;
    };
    expect(third.step.kind).toBe("input");
    ok(await r.h.call("card.cancel", { opId: third.opId }, r.session));
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
        {
          codes: [utf8ToBytes("leak code one"), utf8ToBytes("leak code one")],
          cards: taps(card, 4),
        },
      );
      expect(accounts["kind"]).toBe("accounts");
      await drive(
        r,
        { kind: "health", walletId },
        {
          codes: [utf8ToBytes("leak code one"), utf8ToBytes("leak code one")],
          cards: taps(card, 4),
        },
      );
      const signed = await drive(
        r,
        {
          kind: "sign",
          request: normalizeEvm({
            kind: "evm.personal-message",
            network: "eip155:1",
            account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
            message: utf8ToBytes("leak check"),
          }),
        },
        {
          codes: [utf8ToBytes("leak code one"), utf8ToBytes("leak code one")],
          cards: taps(card, 4),
        },
        verifyPasskey(),
      );
      expect(signed["kind"]).toBe("sign");
      const new1 = utf8ToBytes("leak code two");
      const new2 = utf8ToBytes("leak code two");
      await drive(
        r,
        { kind: "change-access", walletId },
        { codes: [utf8ToBytes("leak code one"), new1, new2, new2], cards: taps(card, 4) },
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
      await drive(
        r,
        { kind: "add", groups: 1 },
        { codes: [freshCode(), freshCode()], cards: taps(other, 8) },
      );
      await drive(
        r,
        { kind: "erase", walletId, card: bytesToHex(card.cardId) },
        {
          codes: [utf8ToBytes("leak code two"), utf8ToBytes("leak code two")],
          cards: taps(card, 4),
        },
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
      // The persisted store image outside the sealed ciphertext — record kinds, ids, headers.
      const image = await r.h.store.load();
      for (const record of image.records) {
        expect(
          containsSecret({ kind: record.kind, id: record.id, header: record.header }, needles),
        ).toBe(false);
      }
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

describe("card module mutation coverage (fake card)", () => {
  it("a card that does not answer SELECT with 9000 is card-not-genuine", async () => {
    const r = await rig();
    const real = createFakeCard();
    const impostor: FieldCard = {
      transmit: async (apdu) =>
        apdu[1] === 0xa4 ? Promise.resolve(new Uint8Array([0x6a, 0x82])) : real.transmit(apdu),
    };
    const error = await driveErr(r, { kind: "status" }, { cards: [impostor] });
    expect(error).toBe("card-not-genuine");
  });

  it("a stray verify on an op that takes none is invalid-input", async () => {
    const r = await rig();
    await expect(
      errCode(
        r.h.call("card.begin", { op: { kind: "status" }, verify: verifyPasskey() }, r.session),
      ),
    ).resolves.toBe("invalid-input");
  });

  it("add marks a claimed-but-unverified member unknown, not ready", async () => {
    const r = await rig();
    const card = await loadedCard();
    const stranger = createFakeCard();
    // The card claims a second member this kernel never tapped.
    card.load(seed, await accessHash(CODE, card.cardId, quickArgon2id), [stranger.cardId]);
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card) },
    );
    const walletId = strField(added, "walletId");
    const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
    const entry = status.wallets.find((w) => w.walletId === walletId);
    const states = (entry?.custody === "card" ? entry.cards : []).map((c) => c.state);
    expect(states).toStrictEqual(["ready", "unknown"]);
  });

  it("a torn create whose verify names foreign members is wrong-device", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const codeText = "the new code";
    const card = createFakeCard();
    const stranger = createFakeCard();
    // LOADED with the source wallet and this op's hash — VERIFY passes the master check,
    // but its member list names a card the op never selected.
    card.load(seed, await accessHash(utf8ToBytes(codeText), card.cardId, quickArgon2id), [
      stranger.cardId,
    ]);
    const target = createFakeCard();
    const first = ok(
      await r.h.call(
        "card.begin",
        {
          op: { kind: "create", cards: 2, source: { kind: "wallet", walletId: source } },
          verify: verifyPasskey(),
        },
        r.session,
      ),
    ) as { opId: string; step: Step };
    let { step } = first;
    let typed = 0;
    let lost = false;
    let presented = false;
    for (let guard = 0; guard < 30; guard += 1) {
      if (step.kind === "input") {
        if (step["purpose"] === "short-id") {
          typed += 1;
          r.input.push(utf8ToBytes(shortId((typed === 1 ? target : card).identity)));
        } else {
          r.input.push(utf8ToBytes(codeText));
        }
      } else if (step["reason"] === "target") {
        r.reader.present(target);
      } else if (lost) {
        r.reader.present(card); // same master, foreign member list → wrong-device
        presented = true;
      } else {
        // The source tap expects BLANK — lose it so the retry admits the loaded liar.
        lost = true;
        r.reader.loseAfter(0);
        r.reader.present(createFakeCard());
      }
      const next = await r.h.call("card.step", { opId: first.opId }, r.session);
      if ("err" in next) {
        expect(next.err.code).toBe("wrong-device");
        expect(presented).toBe(true);
        return;
      }
      step = next.ok as Step;
    }
    throw new Error("the lying card was accepted");
  });

  it("an abort mid-commit resolves the held step cancelled, not done", async () => {
    // The commit gate parks the tap's record commit; the interrupt lands while the run is
    // suspended inside it — without the aborted check before gen.next the op would emit done.
    let gate: Promise<void> | undefined;
    let release = (): void => {};
    let entered = 0;
    const r = await rig(undefined, {
      wrapStore: (store) => ({
        load: store.load,
        watch: store.watch,
        commit: async (ops) => {
          const armed = gate;
          gate = undefined;
          if (armed !== undefined) {
            entered += 1;
            await armed;
          }
          return store.commit(ops);
        },
      }),
    });
    const card = await loadedCard();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    r.input.push(freshCode());
    const step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.reader.present(card);
    const pending = r.h.call("card.step", { opId: first.opId }, r.session);
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `entered` counts inside the wrapped store
    for (let guard = 0; entered === 0 && guard < 200; guard += 1) {
      await r.h.settle();
    }
    expect(entered).toBe(1);
    r.h.advance(120_000); // the op's own timer interrupts the suspended run
    release();
    await expect(errCode(pending)).resolves.toBe("cancelled");
  });

  it("an abort while the op hashes a re-asked code resolves the step cancelled", async () => {
    // The argon2 gate parks gen.next itself: after the interrupt lands, the resumed generator
    // yields a tap — without the aborted check after gen.next the op would run it.
    let gate: Promise<void> | undefined;
    let release = (): void => {};
    let entered = 0;
    const argon2id: Argon2id = async (password, salt, cost, length) => {
      const armed = gate;
      gate = undefined;
      if (armed !== undefined) {
        entered += 1;
        await armed;
      }
      return quickArgon2id(password, salt, cost, length);
    };
    const r = await rig(undefined, { argon2id });
    const card = await loadedCard();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    r.input.push(freshCode());
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap"); // phase 2
    // The card now expects a different hash: phase 2 VERIFYs fail and the op re-asks.
    card.load(seed, await accessHash(utf8ToBytes("other code!"), card.cardId, quickArgon2id));
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("input"); // wrong-code re-ask
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.input.push(freshCode());
    const pending = r.h.call("card.step", { opId: first.opId }, r.session);
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `entered` counts inside the wrapped store
    for (let guard = 0; entered === 0 && guard < 200; guard += 1) {
      await r.h.settle();
    }
    expect(entered).toBe(1); // hashAll inside the resumed generator is parked
    r.h.advance(120_000);
    release();
    await expect(errCode(pending)).resolves.toBe("cancelled");
  });

  it("a lock between steps discards the op and wipes the code it held", async () => {
    const r = await rig(undefined, { idleMs: 5000 });
    const card = await loadedCard();
    const first = ok(
      await r.h.call("card.begin", { op: { kind: "add", groups: 1 } }, r.session),
    ) as { opId: string; step: Step };
    const code = freshCode();
    r.input.push(code);
    const step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap"); // idle — the op still holds the code
    r.h.advance(5001); // session idle lock, long before the op's own 120 s timer
    await r.h.settle();
    expect(code.every((byte) => byte === 0)).toBe(true);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "locked",
    );
    void card;
  });

  it("a foreign-kind record with the wallet's id is not the card wallet", async () => {
    // Plant a data-key record under the walletId: `walletOf` filters on kind, so ops report
    // not-found — with the kind check gone the foreign header fails the card-wallet parse.
    const r = await rig();
    const masterKey = HDKey.fromMasterSeed(seed);
    try {
      const walletId = walletIdOf(masterKey.publicKey!);
      const dek = await sessionDek(r.h);
      try {
        const image = await r.h.store.load();
        const record = sealRecord(
          testSealer,
          dek,
          "data-key",
          walletId,
          encodeHeader({ purpose: "planted", createdAt: 0 }),
          utf8ToBytes("{}"),
        );
        await r.h.store.commit(
          withManifest(testSealer, image, [{ op: "put-record", record }], dek),
        );
      } finally {
        dek.wipe();
      }
      await r.h.settle();
      await expect(
        errCode(r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session)),
      ).resolves.toBe("not-found");
    } finally {
      masterKey.wipePrivateData();
    }
  });

  it("the access-code ask carries the lowest recorded tries of the member set", async () => {
    const r = await rig();
    const a = await loadedCard();
    const b = await loadedCard();
    a.load(seed, await accessHash(CODE, a.cardId, quickArgon2id), [b.cardId]);
    b.load(seed, await accessHash(CODE, b.cardId, quickArgon2id), [a.cardId]);
    const masterKey = HDKey.fromMasterSeed(seed);
    try {
      const walletId = walletIdOf(masterKey.publicKey!);
      await plantCardWallet(
        r.h,
        {
          v: 1,
          walletId,
          origin: "generated",
          createdAt: 0,
          members: [bytesToHex(a.cardId), bytesToHex(b.cardId)],
          cards: [
            { cardId: bytesToHex(a.cardId), state: "ready", cert: bytesToHex(a.cert), tries: 1 },
            { cardId: bytesToHex(b.cardId), state: "ready", cert: bytesToHex(b.cert), tries: 3 },
          ],
        },
        { master: bytesToHex(masterKey.publicKey!), nodes: {}, ed25519: {}, ephemerals: {} },
      );
      const first = ok(
        await r.h.call(
          "card.begin",
          {
            op: {
              kind: "accounts",
              walletId,
              groupIndex: 0,
              templates: ["evm.bip44"],
              network: "eip155:1",
            },
          },
          r.session,
        ),
      ) as { opId: string; step: Step };
      expect(first.step).toMatchObject({ kind: "input", remaining: 1 });
      ok(await r.h.call("card.cancel", { opId: first.opId }, r.session));
    } finally {
      masterKey.wipePrivateData();
    }
  });

  it("cancelling a create at the source tap wipes the new code it held", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = createFakeCard();
    const code = freshCode();
    const confirm = freshCode();
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
    r.input.push(code);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    r.input.push(confirm);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap"); // newCode held, not yet hashed
    ok(await r.h.call("card.cancel", { opId: first.opId }, r.session));
    await r.h.settle();
    expect(code.every((byte) => byte === 0)).toBe(true);
    expect(confirm.every((byte) => byte === 0)).toBe(true);
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

describe("card sign (fake card)", () => {
  const EVM_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
  const SOL_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
  const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
  /** Master fingerprint of `seed` — the vector mnemonic's, checked by the psbt host parser. */
  const MASTER_FP = 0x73c5da0a;
  const HARDENED = 0x80000000;

  const signAccount = (walletId: string, template: ChainTemplate) => ({
    kind: "hd" as const,
    walletId,
    groupIndex: 0,
    template,
  });

  const addWallet = async (r: Rig, card: FakeCard): Promise<string> =>
    strField(
      await drive(r, { kind: "add", groups: 1 }, { codes: [freshCode()], cards: taps(card) }),
      "walletId",
    );

  const evmMsg = (walletId: string) =>
    normalizeEvm({
      kind: "evm.personal-message",
      network: "eip155:1",
      account: signAccount(walletId, "evm.bip44"),
      message: utf8ToBytes("hello card"),
    });

  const solMsg = (walletId: string, message: Uint8Array) =>
    normalizeSolana(
      {
        kind: "solana.message",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        account: signAccount(walletId, "solana.bip44-change"),
        message,
        format: "raw",
      },
      SOL_ADDRESS,
    );

  const btcLeaf = (purpose: number, index: number): HDKey =>
    HDKey.fromMasterSeed(seed).derive(`m/${purpose}'/0'/0'/0/${index}`);

  const hex = (s: string): Uint8Array => hexToBytes(s);

  /** An `inputs`-count P2WPKH psbt spending the wallet's bip84 receive leaves 0..inputs-1. */
  const bip84Psbt = (inputs: number): Uint8Array => {
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    for (let index = 0; index < inputs; index += 1) {
      const child = btcLeaf(84, index);
      const pub = child.publicKey;
      if (pub === null) {
        throw new Error("no public key");
      }
      const spend = p2wpkh(pub);
      const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
      prev.addInput({
        txid: hex(`${index === 0 ? "aa" : "bb"}${"11".repeat(31)}`),
        index: 0,
        sequence: 0xffffffff,
      });
      prev.addOutput({ script: spend.script, amount: 100000n });
      tx.addInput({
        txid: hex(prev.id),
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script: spend.script, amount: 100000n },
        nonWitnessUtxo: prev.toBytes(true, false),
        bip32Derivation: [
          [
            pub,
            {
              fingerprint: MASTER_FP,
              path: [84 + HARDENED, HARDENED, HARDENED, 0, index],
            },
          ],
        ],
      });
    }
    tx.addOutput({ script: p2wpkh(btcLeaf(84, 9).publicKey!).script, amount: 5000n });
    return tx.toPSBT(0);
  };

  /** A one-input P2TR psbt spending the wallet's bip86 receive leaf 0 — the bip340 task. */
  const bip86Psbt = (): Uint8Array => {
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    const pub = btcLeaf(86, 0).publicKey;
    if (pub === null) {
      throw new Error("no public key");
    }
    const xonly = pub.slice(1);
    tx.addInput({
      txid: hex("0909".repeat(16)),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2tr(xonly).script, amount: 100000n },
      tapInternalKey: xonly,
      tapBip32Derivation: [
        [
          xonly,
          {
            hashes: [],
            der: { fingerprint: MASTER_FP, path: [86 + HARDENED, HARDENED, HARDENED, 0, 0] },
          },
        ],
      ],
    });
    tx.addOutput({ script: p2wpkh(btcLeaf(84, 9).publicKey!).script, amount: 90000n });
    return tx.toPSBT(0);
  };

  const psbtReq = (walletId: string, psbt: Uint8Array, templates: string[]) =>
    normalizeBitcoin({
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: { kind: "hd", walletId, groupIndex: 0 },
      psbt,
      sign: templates.map((template, index) => ({ index, template })),
    });

  const signResult = (result: Record<string, unknown>): Record<string, unknown> => {
    expect(field(result, "kind")).toBe("sign");
    return field(result, "result") as Record<string, unknown>;
  };

  it("an over-long prompt refuses as blind before any input, tap or keystore call", async () => {
    /* android shows the limits inside the presence dialog itself — no separate approval field,
       so the refusal reaches findSeedWallet without a secure-input round-trip. */
    const r = await keystoreRig("android");
    const card = await loadedCard(CODE, seed2);
    const walletId = await addWallet(r, card);
    /* A 12-call batch renders well over the platform bound — the same oversize→blind rule
       chain.sign gets, before the reader session or the secure input ever opens. */
    const calls = Array.from({ length: 12 }, (_, i) => ({
      to: `0x00000000000000000000000000000000000000${10 + i}` as `0x${string}`,
      value: 1n,
      data: "0x" as `0x${string}`,
    }));
    /* The batch renders only as a self-call to the account's own address. */
    const own = evmAddressFromPublicKey(
      HDKey.fromMasterSeed(seed2).derive("m/44'/60'/0'/0/0").publicKey ?? new Uint8Array(),
    );
    const request = normalizeEvm({
      kind: "evm.transaction",
      network: "eip155:1",
      account: signAccount(walletId, "evm.bip44"),
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0x0",
        data: encodeBatchExecute(calls),
        to: own,
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    });
    const before = r.fake.calls.length;
    const asks = r.input.requests.length;
    await expect(
      errCode(
        r.h.call("card.begin", { op: { kind: "sign", request }, verify: HARDWARE }, r.session),
      ),
    ).resolves.toBe("blind-signing-disabled");
    expect(r.fake.calls.slice(before)).toStrictEqual([]);
    expect(r.input.requests).toHaveLength(asks);
  });

  it("a lookup-table sign is refused before any input or tap while blind signing is off", async () => {
    /* android shows the limits inside the presence dialog itself — no separate approval field,
       so the refusal reaches findSeedWallet without a secure-input round-trip. */
    const r = await keystoreRig("android");
    const card = await loadedCard(CODE, seed2);
    const walletId = await addWallet(r, card);
    const own = strField(
      ok(
        await r.h.call(
          "wallet.accounts",
          {
            walletId,
            groupIndex: 0,
            template: "solana.bip44-change",
            network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          },
          r.session,
        ),
      ),
      "address",
    );
    const request = lookupTransferRequest(
      signAccount(walletId, "solana.bip44-change"),
      own,
      LOOKUP_RECIPIENT,
    );
    const before = r.fake.calls.length;
    const asks = r.input.requests.length;
    const opens = r.reader.prompts.length;
    await expect(
      errCode(
        r.h.call("card.begin", { op: { kind: "sign", request }, verify: HARDWARE }, r.session),
      ),
    ).resolves.toBe("blind-signing-disabled");
    // The refusal precedes the presence ceremony, the code ask and the first tap alike.
    expect(r.fake.calls.slice(before)).toStrictEqual([]);
    expect(r.input.requests).toHaveLength(asks);
    expect(r.reader.prompts).toHaveLength(opens);

    /* Policy on: the verify prompt is the blind prompt and the tap text says it cannot show
       the request — the table-resolved recipient is never named. */
    ok(await r.h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, r.session));
    const opensAt = r.fake.calls.length;
    const result = signResult(
      await drive(
        r,
        { kind: "sign", request },
        { codes: [freshCode()], cards: taps(card) },
        HARDWARE,
      ),
    );
    const verifyText = r.fake.calls
      .slice(opensAt)
      .flatMap((call) =>
        call.op === "open" && call.prompt !== undefined
          ? [`${call.prompt.title}\n${call.prompt.description}`]
          : [],
      )
      .join("\n");
    expect(verifyText).toContain("Confirm blind signing");
    expect(verifyText).toContain("address lookup table");
    const tapText = r.reader.prompts.join("\n");
    expect(tapText).toContain("Confirm blind signing");
    expect(tapText).toContain("address lookup table");
    expect(tapText).not.toContain(LOOKUP_RECIPIENT);
    expect(field(result, "signature")).toBeDefined();
  });

  it("sign requires a verify factor and a card wallet account", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    await expect(
      errCode(
        r.h.call("card.begin", { op: { kind: "sign", request: evmMsg(walletId) } }, r.session),
      ),
    ).resolves.toBe("invalid-input");
    const vault = await vaultWalletId(r);
    await expect(
      errCode(
        r.h.call(
          "card.begin",
          { op: { kind: "sign", request: evmMsg(vault) }, verify: verifyPasskey() },
          r.session,
        ),
      ),
    ).resolves.toBe("invalid-input");
    const unknown = normalizeEvm({
      kind: "evm.personal-message",
      network: "eip155:1",
      account: signAccount("12".repeat(8), "evm.bip44"),
      message: utf8ToBytes("x"),
    });
    await expect(
      errCode(
        r.h.call(
          "card.begin",
          { op: { kind: "sign", request: unknown }, verify: verifyPasskey() },
          r.session,
        ),
      ),
    ).resolves.toBe("not-found");
    const imported = normalizeEvm({
      kind: "evm.personal-message",
      network: "eip155:1",
      account: { kind: "imported", keyId: "0123456789abcdef", family: "evm" },
      message: utf8ToBytes("x"),
    });
    await expect(
      errCode(
        r.h.call(
          "card.begin",
          { op: { kind: "sign", request: imported }, verify: verifyPasskey() },
          r.session,
        ),
      ),
    ).resolves.toBe("invalid-input");
  });

  it("signs an evm personal message end to end on the member card", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    card.received.length = 0;
    const request = evmMsg(walletId);
    const result = signResult(
      await drive(
        r,
        { kind: "sign", request },
        { codes: [freshCode()], cards: taps(card) },
        verifyPasskey(),
      ),
    );
    const signature = field(result, "signature") as Uint8Array;
    expect(recoverEvmSigner(request, { signature })).toBe(EVM_ADDRESS.toLowerCase());
    // Byte-exact against an independent secp256k1 signature of the personal-message digest.
    const leaf = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
    const digest = keccak_256(
      new Uint8Array([0x19, ...utf8ToBytes("Ethereum Signed Message:\n10hello card")]),
    );
    const expected = secp256k1.sign(digest, new Uint8Array(leaf.privateKey!), {
      prehash: false,
    });
    expect(signature.subarray(0, 64)).toStrictEqual(expected);
    expect(card.received).toStrictEqual([0x20, 0x22, 0x31]);
  });

  it("the tap text is the chain prompt plus the card line", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    r.reader.prompts.length = 0;
    await drive(
      r,
      { kind: "sign", request: evmMsg(walletId) },
      { codes: [freshCode()], cards: taps(card) },
      verifyPasskey(),
    );
    const [text] = r.reader.prompts;
    expect(text?.endsWith(`\nTap card ${shortId(card.identity)} to sign`)).toBe(true);
    // Title, description and the card line are separate lines and there is content ahead of them.
    expect((text ?? "").split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("signs a solana message through the ed25519 command stream", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    card.received.length = 0;
    const message = utf8ToBytes("hello solana card");
    const result = signResult(
      await drive(
        r,
        { kind: "sign", request: solMsg(walletId, message) },
        { codes: [freshCode()], cards: taps(card) },
        verifyPasskey(),
      ),
    );
    expect(
      verifySolanaSignature(message, field(result, "signature") as Uint8Array, SOL_ADDRESS),
    ).toBe(true);
    // 0x33 begin + finish for a short message (64-byte prefix + short M fits one finish chunk).
    expect(card.received).toStrictEqual([0x20, 0x22, 0x33, 0x33]);
  });

  it("packs two psbt inputs into one tap and verifies against the account xpub", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    card.received.length = 0;
    const psbt = bip84Psbt(2);
    const result = signResult(
      await drive(
        r,
        { kind: "sign", request: psbtReq(walletId, psbt, ["btc.bip84", "btc.bip84"]) },
        { codes: [freshCode()], cards: taps(card) },
        verifyPasskey(),
      ),
    );
    const xpub = HDKey.fromMasterSeed(seed).derive("m/84'/0'/0'").publicExtendedKey;
    expect(
      verifyBitcoinPsbtSignatures(
        field(result, "signedPsbt") as Uint8Array,
        [0, 1],
        xpub,
        "btc.bip84",
        BTC_NETWORK,
      ),
    ).toBe(true);
    expect(card.received).toStrictEqual([0x20, 0x22, 0x31, 0x31]);
  });

  it("signs a taproot input through the bip340 command", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    card.received.length = 0;
    const psbt = bip86Psbt();
    const result = signResult(
      await drive(
        r,
        { kind: "sign", request: psbtReq(walletId, psbt, ["btc.bip86"]) },
        { codes: [freshCode()], cards: taps(card) },
        verifyPasskey(),
      ),
    );
    const xpub = HDKey.fromMasterSeed(seed).derive("m/86'/0'/0'").publicExtendedKey;
    expect(
      verifyBitcoinPsbtSignatures(
        field(result, "signedPsbt") as Uint8Array,
        [0],
        xpub,
        "btc.bip86",
        BTC_NETWORK,
      ),
    ).toBe(true);
    expect(card.received).toStrictEqual([0x20, 0x22, 0x32]);
  });

  it("a small per-tap budget spreads tasks over taps and a lost tag resends only pending work", async () => {
    // OPEN(300) + VERIFY(400) + margin(1000) leaves 550 ms — one ECDSA task (451) per tap.
    const r = await rig(2250);
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    card.received.length = 0;
    const psbt = bip84Psbt(2);
    card.received.length = 0;
    r.reader.sessionLengths.length = 0;
    // Lose the answer to tap 2's SIGN (global transmit 10) after the card did the work.
    r.reader.loseGlobal(10);
    const result = await drive(
      r,
      { kind: "sign", request: psbtReq(walletId, psbt, ["btc.bip84", "btc.bip84"]) },
      { codes: [freshCode()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(signResult(result)["signedPsbt"]).toBeInstanceOf(Uint8Array);
    expect(r.reader.sessionLengths).toStrictEqual([5, 5, 5]);
    // Task 1's signature survived the lost tap — the card saw it exactly once.
    expect(card.received.filter((i) => i === 0x31)).toStrictEqual([0x31, 0x31, 0x31]);
  });

  it("rejects a non-member genuine card before any SIGN is sent", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    const other = await loadedCard(CODE, seed2);
    card.received.length = 0;
    const error = await driveErr(
      r,
      { kind: "sign", request: evmMsg(walletId) },
      { codes: [freshCode()], cards: [other] },
      verifyPasskey(),
    );
    expect(error).toBe("card-id-mismatch");
    expect(card.received).toStrictEqual([]);
    expect(other.received).toStrictEqual([]);
  });

  it("a wrong code re-asks and the right code then signs", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    card.received.length = 0;
    const result = signResult(
      await drive(
        r,
        { kind: "sign", request: evmMsg(walletId) },
        { codes: [utf8ToBytes("wrong code"), freshCode()], cards: taps(card, 3) },
        verifyPasskey(),
      ),
    );
    expect(field(result, "signature")).toBeInstanceOf(Uint8Array);
    expect(card.received).toStrictEqual([0x20, 0x22, 0x20, 0x22, 0x31]);
  });

  it("deviations are card-fault: bad ecdsa work, wrong bip340 tweak, bad ed25519 output", async () => {
    const cases: Array<{
      readonly name: string;
      readonly arm: (card: FakeCard) => void;
      readonly request: (walletId: string) => unknown;
      // The sign commands (INS 0x31/0x32/0x33) that reach the card before the fault ends the op.
      readonly commands: ReadonlyArray<number>;
    }> = [
      {
        name: "ecdsaMutateDigest",
        arm: (c) => {
          c.knobs.ecdsaMutateDigest = true;
        },
        request: evmMsg,
        commands: [0x31],
      },
      {
        name: "ecdsaWrongKey",
        arm: (c) => {
          c.knobs.ecdsaWrongKey = true;
        },
        request: evmMsg,
        commands: [0x31],
      },
      {
        name: "bip340WrongTweak",
        arm: (c) => {
          c.knobs.bip340WrongTweak = true;
        },
        request: (walletId) => psbtReq(walletId, bip86Psbt(), ["btc.bip86"]),
        commands: [0x32],
      },
      {
        name: "ed25519BadS",
        arm: (c) => {
          c.knobs.ed25519BadS = true;
        },
        request: (walletId) => solMsg(walletId, utf8ToBytes("hello")),
        commands: [0x33, 0x33],
      },
      {
        name: "ed25519WrongR",
        arm: (c) => {
          c.knobs.ed25519WrongR = true;
        },
        request: (walletId) => solMsg(walletId, utf8ToBytes("hello")),
        commands: [0x33, 0x33],
      },
      {
        name: "ed25519BadWei",
        arm: (c) => {
          c.knobs.ed25519BadWei = true;
        },
        request: (walletId) => solMsg(walletId, utf8ToBytes("hello")),
        commands: [0x33],
      },
    ];
    for (const kase of cases) {
      const r = await rig();
      const card = await loadedCard();
      const walletId = await addWallet(r, card);
      kase.arm(card);
      card.received.length = 0;
      const error = await driveErr(
        r,
        { kind: "sign", request: kase.request(walletId) },
        { codes: [freshCode()], cards: taps(card) },
        verifyPasskey(),
      );
      expect(error).toBe("card-fault");
      // The op ended at the deviation — nothing further was sent.
      expect(
        card.received.filter((ins) => ins === 0x31 || ins === 0x32 || ins === 0x33),
      ).toStrictEqual([...kase.commands]);
    }
  });

  it("a 63Cx on a remembered hash drops it for sign too", async () => {
    const r = await keystoreRig();
    ok(await r.h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, r.session));
    const card = await loadedCard(CODE, seed2);
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    const walletId = strField(added, "walletId");
    const result = signResult(
      await drive(
        r,
        { kind: "sign", request: evmMsg(walletId), remember: true },
        { codes: [freshCode()], cards: taps(card) },
        HARDWARE,
      ),
    );
    expect(field(result, "signature")).toBeInstanceOf(Uint8Array);
    // The card's hash changes under the record — the saved one is now stale.
    card.load(seed2, await accessHash(utf8ToBytes("elsewhere code"), card.cardId, quickArgon2id));
    const signed = signResult(
      await drive(
        r,
        { kind: "sign", request: evmMsg(walletId) },
        { codes: [utf8ToBytes("elsewhere code")], cards: taps(card) },
        HARDWARE,
      ),
    );
    expect(field(signed, "signature")).toBeInstanceOf(Uint8Array);
    // The stale entry was dropped in the failing tap's commit — accounts asks the code again.
    const again = ok(
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
    expect(again.step.kind).toBe("input");
    ok(await r.h.call("card.cancel", { opId: again.opId }, r.session));
  });

  it("the torn-VERIFY allowance is spent once per op — a second tear is card-tampered", async () => {
    // Two ECDSA tasks over two taps (see the budget test) — VERIFY runs on both.
    const r = await rig(2250);
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    const psbt = bip84Psbt(2);
    const first = ok(
      await r.h.call(
        "card.begin",
        {
          op: { kind: "sign", request: psbtReq(walletId, psbt, ["btc.bip84", "btc.bip84"]) },
          verify: verifyPasskey(),
        },
        r.session,
      ),
    ) as { opId: string; step: Step };
    r.input.push(freshCode());
    let step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap");
    // Tap 1's VERIFY dies after committing the counter — recorded − 1, forgiven once.
    card.tearAt(2);
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step).toMatchObject({ kind: "tap", reason: "retry" });
    card.reset();
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(step.kind).toBe("tap"); // tap 2
    // A foreign attempt before tap 2 drops the count to recorded − 1 again — the allowance
    // is spent, so the read-back now reports tampering instead of forgiving it.
    card.state.fails += 1;
    r.reader.present(card);
    await expect(errCode(r.h.call("card.step", { opId: first.opId }, r.session))).resolves.toBe(
      "card-tampered",
    );
  });

  it("a solana message over 16 KiB is card-unsupported before any tap", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    const before = r.reader.sent.length;
    const error = await driveErr(
      r,
      { kind: "sign", request: solMsg(walletId, new Uint8Array(16_385)) },
      { codes: [freshCode()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(error).toBe("card-unsupported");
    expect(r.reader.sent).toHaveLength(before);
  });

  it("a psbt input under an uncached account answers device-required before any tap", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    // m/84'/0'/3'/0/0: the group-3 account is not in this card's cached registration set, so the
    // ownership probe reaches a hardened cache miss — `device-required`, never "not ours".
    const child = HDKey.fromMasterSeed(seed).derive("m/84'/0'/3'/0/0");
    const pub = child.publicKey;
    if (pub === null) {
      throw new Error("no public key");
    }
    const spend = p2wpkh(pub);
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({ txid: hex(`dd${"22".repeat(31)}`), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: spend.script, amount: 100000n });
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    tx.addInput({
      txid: hex(prev.id),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: spend.script, amount: 100000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [pub, { fingerprint: MASTER_FP, path: [84 + HARDENED, HARDENED, 3 + HARDENED, 0, 0] }],
      ],
    });
    tx.addOutput({ script: p2wpkh(btcLeaf(84, 9).publicKey!).script, amount: 5000n });
    const request = normalizeBitcoin({
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: { kind: "hd", walletId, groupIndex: 3 },
      psbt: tx.toPSBT(0),
      sign: [{ index: 0, template: "btc.bip84" }],
    });
    const before = r.reader.sent.length;
    const error = await driveErr(
      r,
      { kind: "sign", request },
      { codes: [freshCode()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(error).toBe("device-required");
    expect(r.reader.sent).toHaveLength(before);
  });

  it("a card replaying the same ECDSA nonce over two inputs is card-fault", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    card.knobs.ecdsaNonce = new Uint8Array(32).fill(7);
    card.received.length = 0;
    const error = await driveErr(
      r,
      { kind: "sign", request: psbtReq(walletId, bip84Psbt(2), ["btc.bip84", "btc.bip84"]) },
      { codes: [freshCode()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(error).toBe("card-fault");
    // The first signature was signed and recorded; the second r matched it.
    expect(card.received.filter((i) => i === 0x31)).toStrictEqual([0x31, 0x31]);
  });

  it("over-budget plans and tasks that never fit are card-unsupported before any tap", async () => {
    // No room for even the session commands plus one task under 1700 ms.
    const tight = await rig(1500);
    const card = await loadedCard();
    const walletId = await addWallet(tight, card);
    await expect(
      errCode(
        tight.h.call(
          "card.begin",
          { op: { kind: "sign", request: evmMsg(walletId) }, verify: verifyPasskey() },
          tight.session,
        ),
      ),
    ).resolves.toBe("card-unsupported");
    // Three inputs at one-task-per-tap would need three taps — over the two-tap limit.
    const small = await rig(2250);
    const smallCard = await loadedCard();
    const smallWallet = await addWallet(small, smallCard);
    await expect(
      errCode(
        small.h.call(
          "card.begin",
          {
            op: {
              kind: "sign",
              request: psbtReq(smallWallet, bip84Psbt(3), ["btc.bip84", "btc.bip84", "btc.bip84"]),
            },
            verify: verifyPasskey(),
          },
          small.session,
        ),
      ),
    ).resolves.toBe("card-unsupported");
    // A solana message too large for one ed25519 stream is refused up front.
    const wide = await rig();
    const wideCard = await loadedCard();
    const wideWallet = await addWallet(wide, wideCard);
    await expect(
      errCode(
        wide.h.call(
          "card.begin",
          {
            op: {
              kind: "sign",
              request: solMsg(wideWallet, new Uint8Array(16385).fill(0x78)),
            },
            verify: verifyPasskey(),
          },
          wide.session,
        ),
      ),
    ).resolves.toBe("card-unsupported");
  });

  it("remembered access hashes sign without a code input", async () => {
    const r = await keystoreRig();
    ok(await r.h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, r.session));
    const card = await loadedCard(CODE, seed2);
    const added = await drive(
      r,
      { kind: "add", groups: 1 },
      { codes: [freshCode()], cards: taps(card, 8) },
    );
    const walletId = strField(added, "walletId");
    card.received.length = 0;
    const result = signResult(
      await drive(
        r,
        { kind: "sign", request: evmMsg(walletId), remember: true },
        { codes: [freshCode()], cards: taps(card) },
        HARDWARE,
      ),
    );
    expect(field(result, "signature")).toBeInstanceOf(Uint8Array);
    // The second sign consumes the remembered hash: no input step at all.
    const first = ok(
      await r.h.call(
        "card.begin",
        { op: { kind: "sign", request: evmMsg(walletId) }, verify: HARDWARE },
        r.session,
      ),
    ) as { opId: string; step: Step };
    expect(first.step.kind).toBe("tap");
    r.reader.present(card);
    const second = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    expect(second.kind).toBe("done");
    expect(card.received.filter((i) => i === 0x31)).toStrictEqual([0x31, 0x31]);
  });

  it("forget-access strips the remembered hash — the next accounts op asks for the code", async () => {
    const r = await keystoreRig();
    ok(await r.h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, r.session));
    const card = await loadedCard(CODE, seed2);
    const walletId = await addWallet(r, card);
    signResult(
      await drive(
        r,
        { kind: "sign", request: evmMsg(walletId), remember: true },
        { codes: [freshCode()], cards: taps(card) },
        HARDWARE,
      ),
    );
    const accounts = {
      kind: "accounts",
      walletId,
      groupIndex: 1, // uncached — the op must tap and VERIFY
      templates: ["btc.bip84"],
      network: BTC_NETWORK,
    };
    const remembered = ok(await r.h.call("card.begin", { op: accounts }, r.session)) as {
      opId: string;
      step: Step;
    };
    expect(remembered.step.kind).toBe("tap"); // no code ask while the hash is remembered
    ok(await r.h.call("card.cancel", { opId: remembered.opId }, r.session));
    const forgot = ok(
      await r.h.call(
        "card.begin",
        { op: { kind: "forget-access", walletId }, verify: HARDWARE },
        r.session,
      ),
    ) as { step: Step };
    expect(forgot.step.kind).toBe("done");
    const again = ok(await r.h.call("card.begin", { op: accounts }, r.session)) as {
      opId: string;
      step: Step;
    };
    expect(again.step.kind).toBe("input"); // the saved hash is gone — the code is asked again
    ok(await r.h.call("card.cancel", { opId: again.opId }, r.session));
  });

  it("the app lock off suspends the remembered hash; relocking re-arms it", async () => {
    const r = await keystoreRig();
    ok(await r.h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, r.session));
    const card = await loadedCard(CODE, seed2);
    const walletId = await addWallet(r, card);
    signResult(
      await drive(
        r,
        { kind: "sign", request: evmMsg(walletId), remember: true },
        { codes: [freshCode()], cards: taps(card) },
        HARDWARE,
      ),
    );
    const accounts = {
      kind: "accounts",
      walletId,
      groupIndex: 1, // uncached — the op must tap and VERIFY
      templates: ["btc.bip84"],
      network: BTC_NETWORK,
    };
    const remembered = ok(await r.h.call("card.begin", { op: accounts }, r.session)) as {
      opId: string;
      step: Step;
    };
    expect(remembered.step.kind).toBe("tap"); // no code ask while the hash is remembered
    ok(await r.h.call("card.cancel", { opId: remembered.opId }, r.session));
    /* The lock off restores the silent device factor — a saved hash would VERIFY with no
       presence at all, so the op asks for the code instead. */
    ok(await r.h.call("vault.setAppLock", { enabled: false, verify: HARDWARE }, r.session));
    const unlocked = ok(await r.h.call("card.begin", { op: accounts }, r.session)) as {
      opId: string;
      step: Step;
    };
    expect(unlocked.step.kind).toBe("input");
    ok(await r.h.call("card.cancel", { opId: unlocked.opId }, r.session));
    // Turning the lock back on — itself a presence ceremony — re-arms the saved hash.
    ok(await r.h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, r.session));
    const relocked = ok(await r.h.call("card.begin", { op: accounts }, r.session)) as {
      opId: string;
      step: Step;
    };
    expect(relocked.step.kind).toBe("tap");
    ok(await r.h.call("card.cancel", { opId: relocked.opId }, r.session));
  });

  it("the app lock off still gates sign on presence, and a session scheme refuses a card wallet", async () => {
    /* keystoreRig's vault carries the silent device factor (app lock off) plus the hardware
       verifying row: presence is still required for signing, but the device factor itself can
       never stand in for it. */
    const r = await keystoreRig();
    const card = await loadedCard(CODE, seed2);
    const walletId = await addWallet(r, card);
    // A device factor never verifies: the wire `verifier` validator rejects it, and the decode
    // failure surfaces as `integrity` before the op even begins.
    await expect(
      errCode(
        r.h.call(
          "card.begin",
          { op: { kind: "sign", request: evmMsg(walletId) }, verify: DEVICE },
          r.session,
        ),
      ),
    ).resolves.toBe("integrity");
    const begun = ok(
      await r.h.call(
        "card.begin",
        { op: { kind: "sign", request: evmMsg(walletId) }, verify: HARDWARE },
        r.session,
      ),
    ) as { opId: string; step: Step };
    expect(begun.step.kind).toBe("input");
    ok(await r.h.call("card.cancel", { opId: begun.opId }, r.session));

    /* External custody is refused as `unsupported` at the top of sessions.create — on either
       platform, with the app lock off and on, with no session-approval input and no keystore
       prompt ever shown: enabling the lock cannot help a wallet the scheme cannot sign for. */
    for (const platform of ["ios", "android"] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one platform rig at a time
      const pr = await keystoreRig(platform);
      const pcard = await loadedCard(CODE, seed2);
      const pwalletId = await addWallet(pr, pcard);
      const create = async () =>
        pr.h.call(
          "sessions.create",
          {
            scheme: "hyperliquid-l1-agent",
            owner: { walletId: pwalletId, groupIndex: 0 },
            scope: "Mainnet",
            name: "bot-1",
            validUntil: pr.h.wallNow() + 86_400_000,
            limits: {
              notional: "1000000000",
              maxLeverage: 100,
              assets: [0, 1, 2, 3, 4, 5, 10107].map((asset) => ({ asset, size: "1000" })),
            },
            verify: HARDWARE,
          },
          pr.session,
        );
      const asks = pr.input.requests.length;
      let calls = pr.fake.calls.length;
      await expect(errCode(create())).resolves.toBe("unsupported");
      expect(pr.fake.calls).toHaveLength(calls);
      expect(pr.input.requests).toHaveLength(asks);
      ok(await pr.h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, pr.session));
      calls = pr.fake.calls.length;
      await expect(errCode(create())).resolves.toBe("unsupported");
      expect(pr.fake.calls).toHaveLength(calls);
      expect(pr.input.requests).toHaveLength(asks);
    }
  });

  it("a sign prompt over the reader text cap is card-unsupported before any tap", async () => {
    const r = await rig();
    const card = await loadedCard();
    const walletId = await addWallet(r, card);
    ok(
      await r.h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: verifyPasskey() },
        r.session,
      ),
    );
    // A typed-data message whose kernel-built prompt rows exceed the 1024-byte tap-text cap:
    // sixteen showable leaves, one quoted line each.
    const fields = Array.from({ length: 16 }, (_, i) => `field${i}`);
    const request = {
      kind: "evm.typed-data",
      network: "eip155:1",
      account: signAccount(walletId, "evm.bip44"),
      typedData: JSON.stringify({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          Mail: fields.map((name) => ({ name, type: "string" })),
        },
        domain: {
          name: "D",
          chainId: 1,
          verifyingContract: "0x0000000000000000000000000000000000000001",
        },
        primaryType: "Mail",
        message: Object.fromEntries(fields.map((name) => [name, "x".repeat(60)])),
      }),
    };
    const before = r.reader.sent.length;
    const error = await driveErr(
      r,
      { kind: "sign", request },
      { codes: [freshCode()], cards: taps(card) },
      verifyPasskey(),
    );
    expect(error).toBe("card-unsupported");
    expect(r.reader.sent).toHaveLength(before); // never truncated, never tapped
  });

  it("the first VERIFY binds a sign to that card — the other member is card-id-mismatch", async () => {
    // Two ECDSA tasks over two taps; after tap 1 the op is bound to that card, so the
    // second member presented for tap 2 is refused before any command goes out.
    const r = await rig(2250);
    const a = createFakeCard();
    const b = createFakeCard();
    a.load(seed, await accessHash(CODE, a.cardId, quickArgon2id), [b.cardId]);
    b.load(seed, await accessHash(CODE, b.cardId, quickArgon2id), [a.cardId]);
    const masterKey = HDKey.fromMasterSeed(seed);
    const account = masterKey.derive("m/84'/0'/0'");
    try {
      const walletId = walletIdOf(masterKey.publicKey!);
      await plantCardWallet(
        r.h,
        {
          v: 1,
          walletId,
          origin: "generated",
          createdAt: 0,
          members: [bytesToHex(a.cardId), bytesToHex(b.cardId)],
          cards: [
            { cardId: bytesToHex(a.cardId), state: "ready", cert: bytesToHex(a.cert), tries: 10 },
            { cardId: bytesToHex(b.cardId), state: "ready", cert: bytesToHex(b.cert), tries: 10 },
          ],
        },
        {
          master: bytesToHex(masterKey.publicKey!),
          nodes: {
            "m/84'/0'/0'": {
              key: bytesToHex(account.publicKey!),
              chainCode: bytesToHex(account.chainCode!),
            },
          },
          ed25519: {},
          ephemerals: {},
        },
      );
      const first = ok(
        await r.h.call(
          "card.begin",
          {
            op: {
              kind: "sign",
              request: psbtReq(walletId, bip84Psbt(2), ["btc.bip84", "btc.bip84"]),
            },
            verify: verifyPasskey(),
          },
          r.session,
        ),
      ) as { opId: string; step: Step };
      let { step } = first;
      for (let guard = 0; step.kind !== "done" && guard < 20; guard += 1) {
        if (step.kind === "input") {
          r.input.push(freshCode());
          const next = await r.h.call("card.step", { opId: first.opId }, r.session);
          if ("err" in next) {
            throw new Error(`unexpected ${next.err.code}`);
          }
          step = next.ok as Step;
          continue;
        }
        // Until the approval binds, `a` is the member on the reader; once the step names the
        // bound card, present the other member — it must be refused before SELECT.
        const named = step["card"] as string | undefined;
        r.reader.present(named === undefined ? a : b);
        const next = await r.h.call("card.step", { opId: first.opId }, r.session);
        if ("err" in next) {
          expect(named).toBe(shortId(a.identity));
          expect(next.err.code).toBe("card-id-mismatch");
          return;
        }
        step = next.ok as Step;
      }
      throw new Error("the foreign member was accepted for the second tap");
    } finally {
      masterKey.wipePrivateData();
    }
  });

  it("signing leaks nothing per family — ecdsa, bip340 and ed25519", async () => {
    const consoleLines: string[] = [];
    const seen = new Map<"log" | "warn" | "error", typeof console.log>();
    for (const name of ["log", "warn", "error"] as const) {
      seen.set(name, console[name]);
      console[name] = (...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      };
    }
    try {
      const r = await rig();
      const card = await loadedCard();
      const walletId = await addWallet(r, card);
      for (const request of [
        evmMsg(walletId),
        psbtReq(walletId, bip84Psbt(1), ["btc.bip84"]),
        psbtReq(walletId, bip86Psbt(), ["btc.bip86"]),
        solMsg(walletId, utf8ToBytes("leak solana")),
      ]) {
        const result = await drive(
          r,
          { kind: "sign", request },
          { codes: [freshCode(), freshCode()], cards: taps(card, 4) },
          verifyPasskey(),
        );
        expect(result["kind"]).toBe("sign");
      }
      const keys = card.secrets.keys ?? new Uint8Array(0);
      const needles = [
        utf8ToBytes(CODE_TEXT),
        await accessHash(CODE, card.cardId, quickArgon2id),
        card.secrets.eph ?? new Uint8Array(0),
        card.secrets.shared ?? new Uint8Array(0),
        keys,
        keys.subarray(0, 16),
        keys.subarray(16, 32),
        new Uint8Array(seed),
      ].filter((n) => n.length > 0);
      for (const message of r.h.posted) {
        expect(containsSecret(message, needles)).toBe(false);
      }
      const image = await r.h.store.load();
      for (const record of image.records) {
        expect(
          containsSecret({ kind: record.kind, id: record.id, header: record.header }, needles),
        ).toBe(false);
      }
      expect(containsSecret(consoleLines, needles)).toBe(false);
      r.h.posted.push({ planted: keys });
      expect(containsSecret(r.h.posted.at(-1), needles)).toBe(true);
      r.h.posted.pop();
    } finally {
      for (const [name, fn] of seen) {
        console[name] = fn;
      }
    }
  });

  it("serves repeated exports and account reads from an intact pin", async () => {
    const r = await keystoreRig();
    const card = await loadedCard(CODE, seed2);
    const walletId = await addWallet(r, card);
    const nodes = [
      { kind: "leaf", template: "evm.bip44" },
      { kind: "leaf", template: "solana.bip44-change" },
    ];
    const exportOnce = async () =>
      ok(
        await r.h.call(
          "chain.exportAccount",
          { walletId, groupIndex: 0, nodes, verify: HARDWARE },
          r.session,
        ),
      );
    const pubHexes = (res: unknown): ReadonlyArray<string> =>
      (field(res, "keys") as unknown[]).map((k) => bytesToHex(field(k, "publicKey") as Uint8Array));
    const first = await exportOnce();
    const firstHexes = pubHexes(first);
    /* A real port detaches every exact-view buffer the reply carries — the pin must keep its
       own arrays or the next read sees zeroed keys. */
    detachTransferables(first);
    const second = await exportOnce();
    expect(pubHexes(second)).toStrictEqual(firstHexes);
    const leafKey = new Uint8Array(
      field((field(second, "keys") as unknown[])[0], "publicKey") as Uint8Array,
    );
    detachTransferables(second);
    const accounts = ok(
      await r.h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
        r.session,
      ),
    );
    expect(strField(accounts, "address")).toBe(evmAddressFromPublicKey(leafKey));
    const bitcoin = ok(
      await r.h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "btc.bip84", network: BTC_NETWORK },
        r.session,
      ),
    );
    expect(strField(bitcoin, "fingerprint")).toBe(
      HDKey.fromMasterSeed(seed2).fingerprint.toString(16).padStart(8, "0"),
    );
  });
});
