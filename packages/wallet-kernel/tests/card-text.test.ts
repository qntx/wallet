// oxlint-disable eslint/no-await-in-loop, vitest/no-conditional-in-test -- the step driver is sequential and conditional by design
/**
 * Tap text purity: the reader `open` prompt and the secure-input labels are pure functions of (op,
 * record, locale) — nothing the main runtime sends outside the validated op reaches them (design
 * §10). Each op runs three times on fresh rigs whose cards share fixed identities, once plainly,
 * once with stray `not-found` step/cancel calls, once behind a `card.begin` that rebuilds the op in
 * a different key order and is cancelled — the captured text is byte-identical.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { utf8ToBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm, evmAddressFromPublicKey, normalizeEvm } from "@qntx/wallet-chains/evm";
import { normalizeSolana } from "@qntx/wallet-chains/solana";

import { accessHash } from "../src/modules/card/protocol/access.ts";
import { shortId } from "../src/modules/card/protocol/identity.ts";
import { signCardLine } from "../src/modules/card/text.ts";
import { chainPrompt } from "../src/modules/chains/prompt.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { createFakeCard } from "./card/fake-card.ts";
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
const CODE = "correct horse";
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const TRON_NETWORK = "tron:728126428";
const SOL_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SOL_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const MASTER_FP = 0x73c5da0a;
const HARDENED = 0x80000000;

const seed = await seedFromEntropy(entropyFromMnemonic(MNEMONIC), "", subtlePbkdf2);

/** A second seed — the keystore rig's imported wallet already owns `seed`'s walletId. */
const seed2 = await seedFromEntropy(
  entropyFromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
  ),
  "",
  subtlePbkdf2,
);

/** The signing-plan wire vectors — their mnemonic is the same `seed` the member cards hold. */
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/signing-plans.json"), "utf8"),
) as {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly key?: { readonly path: number[]; readonly publicKey: string };
    readonly request: Record<string, unknown> & { readonly kind: string };
  }>;
};

const vectorCase = (name: string): (typeof vectors.cases)[number] => {
  const found = vectors.cases.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`vector ${name} missing`);
  }
  return found;
};

/** Fixed identity secrets — every run of a case presents cards with the same printed short IDs. */
const ID_MEMBER = new Uint8Array(32).fill(0x31);
const ID_SOURCE = new Uint8Array(32).fill(0x32);
const ID_TARGET = new Uint8Array(32).fill(0x33);
const ID_BLANK = new Uint8Array(32).fill(0x34);

const ok = (res: KernelResponse): unknown => {
  if (!("ok" in res)) {
    throw new Error(`call failed: ${JSON.stringify(res.err)}`);
  }
  return res.ok;
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

const rig = async (keystore?: ReturnType<typeof fakeKeystore>): Promise<Rig> => {
  const reader = testCardReader();
  const input = testSecureInput();
  const h = createHarness({
    card: { reader: reader.reader, secureInput: input.secureInput, anchors: [CA1_ANCHOR] },
    ...(keystore === undefined ? {} : { keystore: keystore.keystore }),
  });
  const res = ok(
    await (keystore === undefined
      ? h.call("wallet.createWithPasskey", {
          ceremony: "host",
          credentialId: CREDENTIAL_ID,
          prfWallet: new Uint8Array(32).fill(2),
          synced: true,
          factor: verifyPasskey(),
        })
      : h.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(MNEMONIC),
          factor: { kind: "device" },
        })),
  );
  return { h, session: strField(res, "session"), reader, input };
};

const vaultWalletId = async (r: Rig): Promise<string> => {
  const status = ok(await r.h.call("status", null, r.session)) as {
    wallets: Array<{ custody: string; walletId: string }>;
  };
  const vault = status.wallets.find((w) => w.custody === "vault");
  if (vault === undefined) {
    throw new Error("no vault wallet");
  }
  return vault.walletId;
};

const blankCard = (identitySecret: Uint8Array): FakeCard => createFakeCard({ identitySecret });

const memberCard = async (
  identitySecret = ID_MEMBER,
  withSeed: Uint8Array = seed,
): Promise<FakeCard> => {
  const card = createFakeCard({ identitySecret });
  card.load(withSeed, await accessHash(utf8ToBytes(CODE), card.cardId, quickArgon2id));
  return card;
};

type Step = { kind: string; [k: string]: unknown };

/**
 * The card-transfer driver: `choices` answers unbound short-id asks in order; `deck` resolves a
 * step's `card` short ID to the card to present (a retry re-presents it).
 */
const drive = async (
  r: Rig,
  op: unknown,
  actions: {
    codes?: string[];
    choices?: FakeCard[];
    deck?: FakeCard[];
    /** After the first serviced step, one stray `not-found` step + cancel on an unknown op. */
    stray?: boolean;
  },
  verify?: unknown,
): Promise<Record<string, unknown>> => {
  const first = ok(
    await r.h.call("card.begin", { op, ...(verify === undefined ? {} : { verify }) }, r.session),
  ) as { opId: string; step: Step };
  const deck = actions.deck ?? actions.choices ?? [];
  const byShort = (sid: string): FakeCard | undefined =>
    deck.find((c) => shortId(c.identity) === sid);
  let pendingChoice: FakeCard | undefined;
  let strayed = actions.stray !== true;
  let { step } = first;
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    if (guard > 80) {
      throw new Error(`operation did not finish: ${JSON.stringify(step)}`);
    }
    if (step.kind === "input") {
      if (step["purpose"] === "short-id") {
        const bound = step["card"] as string | undefined;
        const chosen = bound === undefined ? actions.choices?.shift() : byShort(bound);
        pendingChoice = chosen;
        r.input.push(utf8ToBytes(chosen === undefined ? "0000-0000" : shortId(chosen.identity)));
      } else {
        const code = actions.codes?.shift();
        if (code === undefined) {
          throw new Error(`unexpected input step ${JSON.stringify(step)}`);
        }
        r.input.push(utf8ToBytes(code));
      }
    } else if (step.kind === "tap") {
      const bound = step["card"] as string | undefined;
      const next =
        (bound === undefined ? undefined : byShort(bound)) ??
        pendingChoice ??
        actions.choices?.shift();
      if (next === undefined) {
        throw new Error(`unexpected tap step ${JSON.stringify(step)}`);
      }
      r.reader.present(next);
    }
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
    if (!strayed) {
      strayed = true;
      // A step on an op the kernel does not know fails without touching this op's text; a stray
      // cancel answers idempotently.
      const stray = await r.h.call("card.step", { opId: "00".repeat(16) }, r.session);
      if (!("err" in stray) || stray.err.code !== "not-found") {
        throw new Error(`stray step answered ${JSON.stringify(stray)}`);
      }
      await r.h.call("card.cancel", { opId: "00".repeat(16) }, r.session);
    }
  }
  return field(step, "result") as Record<string, unknown>;
};

const addWallet = async (r: Rig, card: FakeCard): Promise<string> =>
  strField(
    await drive(r, { kind: "add", groups: 1 }, { codes: [CODE], choices: [card], deck: [card] }),
    "walletId",
  );

/** A k=2 create stopped right before the target's install tap — the member stays `pending`. */
const pendingMember = async (r: Rig, source: FakeCard, target: FakeCard): Promise<string> => {
  const wid = await vaultWalletId(r);
  const first = ok(
    await r.h.call(
      "card.begin",
      {
        op: { kind: "create", cards: 2, source: { kind: "wallet", walletId: wid } },
        verify: verifyPasskey(),
      },
      r.session,
    ),
  ) as { opId: string; step: Step };
  const codes = [CODE, CODE];
  const cards = [target, source];
  let targetTaps = 0;
  let s = first.step;
  for (let guard = 0; s.kind !== "done"; guard += 1) {
    if (guard > 40) {
      throw new Error("stuck");
    }
    if (s.kind === "input") {
      if (s["purpose"] === "short-id") {
        const typed =
          s["card"] === undefined
            ? shortId(cards[0]?.identity ?? new Uint8Array(33))
            : String(s["card"]);
        r.input.push(utf8ToBytes(typed));
      } else {
        r.input.push(utf8ToBytes(codes.shift() ?? CODE));
      }
    } else {
      if (s["reason"] === "target") {
        targetTaps += 1;
        if (targetTaps === 2) {
          break;
        }
      }
      r.reader.present(cards.shift() ?? source);
    }
    s = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
  }
  await r.h.call("card.cancel", { opId: first.opId }, r.session);
  return wid;
};

/** A complete 2-card create (source ready + target ready). */
const createSet = async (r: Rig, source: FakeCard, target: FakeCard): Promise<string> => {
  const wid = await vaultWalletId(r);
  await drive(
    r,
    { kind: "create", cards: 2, source: { kind: "wallet", walletId: wid } },
    { codes: [CODE, CODE], choices: [target, source], deck: [target, source] },
    verifyPasskey(),
  );
  return wid;
};

type OpBuild = (r: Rig) => Promise<{
  op: unknown;
  codes?: string[];
  cards: FakeCard[];
  /** A factory — the kernel wipes the verify factor's buffers, so each begin needs fresh bytes. */
  verify?: () => unknown;
  /** The op emits no reader prompt and no input (forget-access finishes inside `card.begin`). */
  empty?: true;
}>;

const signAccount = (walletId: string, template: string) => ({
  kind: "hd",
  walletId,
  groupIndex: 0,
  template,
});

const evmMsg = (walletId: string) =>
  normalizeEvm({
    kind: "evm.personal-message",
    network: "eip155:1",
    account: signAccount(walletId, "evm.bip44"),
    message: utf8ToBytes("hello card"),
  });

const evmTypedData = (walletId: string) =>
  normalizeEvm({
    kind: "evm.typed-data",
    network: "eip155:1",
    account: signAccount(walletId, "evm.bip44"),
    typedData: JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "m", type: "string" }],
      },
      domain: { name: "X" },
      primaryType: "Mail",
      message: { m: "hi" },
    }),
  });

const evmTx = (walletId: string) =>
  normalizeEvm({
    kind: "evm.transaction",
    network: "eip155:1",
    account: signAccount(walletId, "evm.bip44"),
    tx: {
      type: "legacy",
      chainId: 1,
      nonce: 0,
      gas: "0x5208",
      gasPrice: "0x59682f00",
      value: "0xde0b6b3a7640000",
      data: "0x",
      to: "0x00000000000000000000000000000000deadbeef",
    },
  });

const solMsg = (walletId: string) =>
  normalizeSolana(
    {
      kind: "solana.message",
      network: SOL_NETWORK,
      account: signAccount(walletId, "solana.bip44-change"),
      message: utf8ToBytes("hello solana"),
      format: "raw",
    },
    SOL_ADDRESS,
  );

const tronMsg = (walletId: string) => ({
  kind: "tron.message" as const,
  network: TRON_NETWORK,
  account: signAccount(walletId, "tron.bip44"),
  message: utf8ToBytes("hello tron"),
});

const btcLeaf = (purpose: number, index: number): HDKey =>
  HDKey.fromMasterSeed(seed).derive(`m/${purpose}'/0'/0'/0/${index}`);

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
      txid: hexToBytes(`${index === 0 ? "aa" : "bb"}${"11".repeat(31)}`),
      index: 0,
      sequence: 0xffffffff,
    });
    prev.addOutput({ script: spend.script, amount: 100000n });
    tx.addInput({
      txid: hexToBytes(prev.id),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: spend.script, amount: 100000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [pub, { fingerprint: MASTER_FP, path: [84 + HARDENED, HARDENED, HARDENED, 0, index] }],
      ],
    });
  }
  tx.addOutput({ script: p2wpkh(btcLeaf(84, 9).publicKey!).script, amount: 5000n });
  return tx.toPSBT(0);
};

const psbtReq = (walletId: string, templates: string[]) =>
  normalizeBitcoin({
    kind: "bitcoin.psbt",
    network: BTC_NETWORK,
    account: { kind: "hd", walletId, groupIndex: 0 },
    psbt: bip84Psbt(templates.length),
    sign: templates.map((template, index) => ({ index, template })),
  });

/**
 * The card wallet's m/86'/0'/0'/0/0 taproot address (bitcoin accounts carry an xpub, not an
 * address).
 */
const bip86Address = (): string => {
  const pub = btcLeaf(86, 0).publicKey;
  if (pub === null) {
    throw new Error("no public key");
  }
  const { address } = p2tr(pub.subarray(1));
  if (address === undefined) {
    throw new Error("no address");
  }
  return address;
};

const ANVIL_TRON = hexToBytes("41f39fd6e51aad88f6f4ce6ab8827279cfffb92266");

/**
 * The wire vector requests embed the anvil account as their embedded signer — re-point the embedded
 * signer at the card wallet's key (the same key the vectors declare, since the mnemonic is
 * shared).
 */
const tronWithSigner = (rawData: Uint8Array, owner20: Uint8Array): Uint8Array => {
  const out = new Uint8Array(rawData);
  const replacement = new Uint8Array([0x41, ...owner20]);
  for (let i = 0; i + 21 <= out.length; i += 1) {
    if (out.subarray(i, i + 21).every((b, j) => b === ANVIL_TRON[j])) {
      out.set(replacement, i);
    }
  }
  return out;
};

/** Re-points a solana message's first (only) required signer at `key`. */
const solanaWithSigner = (message: Uint8Array, key: Uint8Array): Uint8Array => {
  const out = new Uint8Array(message);
  // v1 (0x81): version ‖ header(3) ‖ configMask(4) ‖ lifetime(32) ‖ counts(2) ‖ accounts.
  // v0 (0x80) and legacy: (version) ‖ header(3) ‖ count ‖ accounts.
  const accountsAt = message[0] === 0x81 ? 41 : ((message[0] ?? 0) >= 0x80 ? 1 : 0) + 3;
  out.set(key, accountsAt + 1);
  return out;
};

/** A vector case re-aimed at the card wallet — only the cases needing an embedded-signer rewrite. */
const vectorRequest = (name: string, walletId: string): Record<string, unknown> => {
  const c = vectorCase(name);
  const request: Record<string, unknown> = { ...c.request };
  const key = c.key?.publicKey;
  if (request["kind"] === "tron.transaction" && key !== undefined) {
    request["rawData"] = tronWithSigner(
      hexToBytes(request["rawData"] as string),
      hexToBytes(evmAddressFromPublicKey(hexToBytes(key)).slice(2)),
    );
    request["account"] = { kind: "hd", walletId, groupIndex: 0, template: "tron.bip44" };
  }
  if (request["kind"] === "solana.transaction" && key !== undefined) {
    request["message"] = solanaWithSigner(
      hexToBytes(request["message"] as string),
      hexToBytes(key),
    );
    request["account"] = {
      kind: "hd",
      walletId,
      groupIndex: 0,
      template: "solana.bip44-change",
    };
  }
  if (request["kind"] === "tron.typed-data") {
    request["account"] = { kind: "hd", walletId, groupIndex: 0, template: "tron.bip44" };
  }
  return request;
};

const btcMsg = (walletId: string) =>
  normalizeBitcoin({
    kind: "bitcoin.message",
    network: BTC_NETWORK,
    account: signAccount(walletId, "btc.bip86"),
    address: bip86Address(),
    message: "hello bitcoin",
    format: "bip322-simple",
    change: 0,
    index: 0,
  });

const signCase = (
  name: string,
  request: (r: Rig, walletId: string) => unknown,
): { name: string; build: OpBuild } => ({
  name: `sign ${name}`,
  build: async (r) => {
    const card = await memberCard();
    const walletId = await addWallet(r, card);
    return {
      op: { kind: "sign", request: await request(r, walletId) },
      codes: [CODE],
      cards: Array.from({ length: 6 }, () => card),
      verify: verifyPasskey,
    };
  },
});

const OP_CASES: ReadonlyArray<{ name: string; build: OpBuild }> = [
  {
    name: "status",
    build: async () => ({ op: { kind: "status" }, cards: [await memberCard()] }),
  },
  {
    name: "add",
    build: async () => ({
      op: { kind: "add", groups: 1 },
      codes: [CODE],
      cards: [await memberCard()],
    }),
  },
  {
    name: "accounts",
    build: async (r) => {
      const card = await memberCard();
      const walletId = await addWallet(r, card);
      return {
        op: {
          kind: "accounts",
          walletId,
          groupIndex: 0,
          templates: ["evm.bip44"],
          network: "eip155:1",
        },
        codes: [CODE],
        cards: Array.from({ length: 6 }, () => card),
      };
    },
  },
  {
    name: "health",
    build: async (r) => {
      const card = await memberCard();
      const walletId = await addWallet(r, card);
      return { op: { kind: "health", walletId }, codes: [CODE], cards: [card] };
    },
  },
  {
    name: "change-access",
    build: async (r) => {
      const card = await memberCard();
      const walletId = await addWallet(r, card);
      return {
        op: { kind: "change-access", walletId },
        codes: [CODE, "new code 1", "new code 1"],
        cards: Array.from({ length: 4 }, () => card),
        verify: verifyPasskey,
      };
    },
  },
  {
    name: "erase",
    build: async (r) => {
      const card = await memberCard();
      const walletId = await addWallet(r, card);
      return {
        op: { kind: "erase", walletId, card: bytesToHex(card.cardId) },
        codes: [CODE],
        cards: [card],
        verify: verifyPasskey,
      };
    },
  },
  {
    name: "forget-access",
    build: async (r) => {
      const card = await memberCard();
      const walletId = await addWallet(r, card);
      return {
        op: { kind: "forget-access", walletId },
        cards: [],
        verify: verifyPasskey,
        empty: true,
      };
    },
  },
  {
    name: "create",
    build: async (r) => ({
      op: {
        kind: "create",
        cards: 1,
        source: { kind: "wallet", walletId: await vaultWalletId(r) },
      },
      codes: ["new code 1", "new code 1"],
      cards: Array.from({ length: 10 }, () => blankCard(ID_BLANK)),
      verify: verifyPasskey,
    }),
  },
  {
    name: "transfer",
    build: async (r) => {
      const source = blankCard(ID_SOURCE);
      const target = blankCard(ID_TARGET);
      const walletId = await pendingMember(r, source, target);
      return {
        op: { kind: "transfer", walletId },
        codes: [CODE, "new code t", "new code t"],
        cards: [target, source, target, source],
        verify: verifyPasskey,
      };
    },
  },
  {
    name: "reseal",
    build: async (r) => {
      const source = blankCard(ID_SOURCE);
      const target = blankCard(ID_TARGET);
      const walletId = await createSet(r, source, target);
      return {
        op: { kind: "reseal", walletId, card: bytesToHex(target.cardId) },
        codes: [CODE, "new seal 1", "new seal 1"],
        cards: [target, source, target, source],
        verify: verifyPasskey,
      };
    },
  },
  signCase("evm.personal-message", (_r, walletId) => evmMsg(walletId)),
  signCase("evm.typed-data", (_r, walletId) => evmTypedData(walletId)),
  signCase("evm.transaction", (_r, walletId) => evmTx(walletId)),
  // The Fiat24 window is twenty minutes of kernel wall clock; the harness clock is pinned at
  // 1_700_000_000_000 ms, so the deadline is a fixed instant ten minutes after it.
  signCase("evm.fiat24-session", (_r, walletId) => ({
    kind: "evm.fiat24-session",
    network: "eip155:42161",
    account: signAccount(walletId, "evm.bip44"),
    tokenId: "123456",
    deadline: 1_700_000_600,
  })),
  signCase("solana.transaction", (_r, walletId) =>
    vectorRequest("solana-transaction-legacy-single-signer", walletId),
  ),
  signCase("solana.message", (_r, walletId) => solMsg(walletId)),
  signCase("tron.transaction", (_r, walletId) =>
    vectorRequest("tron-transaction-trx-transfer", walletId),
  ),
  signCase("tron.message", (_r, walletId) => tronMsg(walletId)),
  signCase("tron.typed-data", (_r, walletId) =>
    vectorRequest("tron-typed-data-permit2-single", walletId),
  ),
  signCase("bitcoin.message", (_r, walletId) => btcMsg(walletId)),
  signCase("bitcoin.psbt", (_r, walletId) => psbtReq(walletId, ["btc.bip84", "btc.bip84"])),
];

/**
 * One run of a case on a fresh rig: "plain" drives the op, "stray" interleaves not-found
 * step/cancel calls on an unknown op id, "reorder" first begins and cancels the same op rebuilt
 * with its keys in reverse order.
 */
const capture = async (
  build: OpBuild,
  variant: "plain" | "stray" | "reorder",
): Promise<{ prompts: string[]; labels: string[]; empty: boolean }> => {
  const r = await rig();
  const built = await build(r);
  if (variant === "stray") {
    const stray = await r.h.call("card.step", { opId: "00".repeat(16) }, r.session);
    if (!("err" in stray) || stray.err.code !== "not-found") {
      throw new Error(`stray step answered ${JSON.stringify(stray)}`);
    }
  }
  if (variant === "reorder") {
    const reordered = Object.fromEntries(
      Object.entries(built.op as Record<string, unknown>).toReversed(),
    );
    const begun = ok(
      await r.h.call(
        "card.begin",
        { op: reordered, ...(built.verify === undefined ? {} : { verify: built.verify() }) },
        r.session,
      ),
    ) as { opId: string };
    await r.h.call("card.cancel", { opId: begun.opId }, r.session);
  }
  const p0 = r.reader.prompts.length;
  const l0 = r.input.requests.length;
  await drive(
    r,
    built.op,
    {
      ...(built.codes === undefined ? {} : { codes: [...built.codes] }),
      choices: [...built.cards],
      deck: built.cards,
      stray: variant === "stray",
    },
    built.verify?.(),
  );
  return {
    prompts: r.reader.prompts.slice(p0),
    labels: r.input.requests.slice(l0).map((request) => request.label),
    empty: built.empty === true,
  };
};

describe("card text purity", () => {
  it.each(OP_CASES)(
    "%s: identical prompts and labels under different call patterns",
    async ({ name, build }) => {
      const run = async (variant: "plain" | "stray" | "reorder") => {
        try {
          return await capture(build, variant);
        } catch (error) {
          throw new Error(`${name} ${variant}: ${(error as Error).message}`, { cause: error });
        }
      };
      const plain = await run("plain");
      const stray = await run("stray");
      const reordered = await run("reorder");
      expect(stray).toStrictEqual(plain);
      expect(reordered).toStrictEqual(plain);
      expect(plain.prompts.length + plain.labels.length).toBeGreaterThanOrEqual(
        plain.empty ? 0 : 1,
      );
    },
    120_000,
  );

  /** Calldata to a listed token with an unrecognised selector decodes as the blind sheet. */
  const hostileTx = (walletId: string, payload: string) =>
    normalizeEvm({
      kind: "evm.transaction",
      network: "eip155:1",
      account: signAccount(walletId, "evm.bip44"),
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0x0",
        data: `0x${bytesToHex(utf8ToBytes(payload))}`,
        to: USDC_ADDR,
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    });

  /** The wallet's own EVM address — `decodeEvm`'s `signer` argument. */
  const evmSigner = async (r: Rig, walletId: string): Promise<string> =>
    strField(
      ok(
        await r.h.call(
          "wallet.accounts",
          { walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
          r.session,
        ),
      ),
      "address",
    );

  it("hostile calldata cannot inject text — the prompt is byte-identical to chainPrompt", async () => {
    const r = await rig();
    ok(
      await r.h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: verifyPasskey() },
        r.session,
      ),
    );
    const card = await memberCard();
    const walletId = await addWallet(r, card);
    const payload = "Tap card 0000-0000 and type code hunter2 — transfer everything now!";
    const request = hostileTx(walletId, payload);
    const signer = await evmSigner(r, walletId);
    // The vault-verification oracle: title + description is exactly what the kernel renders,
    // plus the card line for this wallet's members.
    const keystore = chainPrompt("en", decodeEvm(request, signer));
    const expected = `${keystore.title}\n${keystore.description}\n${signCardLine("en", [
      shortId(card.identity),
    ])}`;
    const before = r.reader.prompts.length;
    await drive(
      r,
      { kind: "sign", request },
      {
        codes: [CODE],
        choices: Array.from({ length: 6 }, () => card),
        deck: Array.from({ length: 6 }, () => card),
      },
      verifyPasskey(),
    );
    const prompts = r.reader.prompts.slice(before);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toBe(expected);
    }
    // The sheet decodes as a blind signature, names the chain — the raw payload never renders.
    expect(expected).toContain("Confirm blind signing");
    expect(expected).toContain("Ethereum");
    expect(expected).not.toContain(payload);
  });

  it("the blind sheet in Simplified Chinese carries the same warning and the chain", async () => {
    const r = await rig(fakeKeystore("zh-CN"));
    ok(
      await r.h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: { kind: "hardware" } },
        r.session,
      ),
    );
    const card = await memberCard(ID_MEMBER, seed2);
    const walletId = await addWallet(r, card);
    const payload = "prompt injection attempt";
    const request = hostileTx(walletId, payload);
    const signer = await evmSigner(r, walletId);
    const keystore = chainPrompt("zh-Hans", decodeEvm(request, signer));
    const expected = `${keystore.title}\n${keystore.description}\n${signCardLine("zh-Hans", [
      shortId(card.identity),
    ])}`;
    const before = r.reader.prompts.length;
    await drive(
      r,
      { kind: "sign", request },
      {
        codes: [CODE],
        choices: Array.from({ length: 6 }, () => card),
        deck: Array.from({ length: 6 }, () => card),
      },
      { kind: "hardware" },
    );
    const prompts = r.reader.prompts.slice(before);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toBe(expected);
    }
    expect(expected).toContain("确认盲签");
    // The chain's display name — the registry name networkLabel resolves for eip155:1.
    expect(expected).toContain("网络：Ethereum");
    expect(expected).not.toContain(payload);
  });
});
