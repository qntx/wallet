// oxlint-disable eslint/no-await-in-loop, vitest/no-conditional-in-test -- the step driver is sequential and conditional by design
/**
 * Layer-5 multi-card operations against the real qntx card applet in jcardsim (`QNTX_CARD_SIM`,
 * skipped without it): `create` with 2 and 3 cards on both sources, `transfer` to a pending member,
 * `reseal` of a LOADED member and of one erased to BLANK, the host.md §4 failure stories, and
 * `tear` power loss at every persistent write k of OFFER, CREATE, EXPORT and IMPORT — the post-tear
 * state is read straight off the card with a raw SELECT+OPEN+STATUS.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { Address } from "@scure/btc-signer";
import { p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { address, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { verifyBitcoinMessage, verifyBitcoinPsbtSignatures } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey, normalizeEvm, recoverEvmSigner } from "@qntx/wallet-chains/evm";
import { verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { planTron, tronAddressFromPublicKey, tronMessageDigest } from "@qntx/wallet-chains/tron";
import type { CardInfo, WalletInfo } from "@qntx/wallet/types";

import { cmd } from "../src/modules/card/protocol/commands.ts";
import { decode } from "../src/modules/card/protocol/decode.ts";
import { cardId, shortId } from "../src/modules/card/protocol/identity.ts";
import { openRequest, openResponse, SELECT_APDU } from "../src/modules/card/protocol/session.ts";
import { result } from "../src/modules/card/protocol/status.ts";
import { testSecureInput } from "./card/input.ts";
import { testCardReader } from "./card/reader.ts";
import { CA1_ANCHOR, SIM_LAUNCHER, startSimulator } from "./card/sim.ts";
import type { SimCard, Simulator } from "./card/sim.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const HARDENED = 0x80000000;
const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";
const CODE = "sim set code";
const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(32).fill(1),
});

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/signing-plans.json"), "utf8"),
) as {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly request: Record<string, unknown> & { readonly kind: string };
  }>;
};
const vectorCase = (name: string): (typeof vectors.cases)[number] => {
  const found = vectors.cases.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`no vector case ${name}`);
  }
  return found;
};

const ok = (res: KernelResponse): Record<string, unknown> => {
  if (!("ok" in res)) {
    throw new Error(`call failed: ${JSON.stringify(res.err)}`);
  }
  return res.ok as Record<string, unknown>;
};
const field = (res: Record<string, unknown>, key: string): unknown => {
  const value = res[key];
  if (value === undefined) {
    throw new Error(`missing ${key}`);
  }
  return value;
};
const strField = (res: Record<string, unknown>, key: string): string => String(field(res, key));

type Step = { kind: string; [k: string]: unknown };

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
  return { h, session: String(res["session"]), reader, input };
};

const vaultWalletId = async (r: Rig): Promise<string> => {
  const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
  const vault = status.wallets.find((w) => w.custody === "vault");
  if (vault === undefined) {
    throw new Error("no vault wallet");
  }
  return vault.walletId;
};

const cardWallet = async (
  r: Rig,
): Promise<{ walletId: string; cards: ReadonlyArray<CardInfo>; info: WalletInfo }> => {
  const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
  const wallet = status.wallets.find((w) => w.custody === "card");
  if (wallet === undefined || wallet.custody !== "card") {
    throw new Error("no card wallet");
  }
  return { walletId: wallet.walletId, cards: wallet.cards, info: wallet };
};

/**
 * Drives `card.begin` to `done` (or the first error). `choices` fills the driver's pick at every
 * unbound short-id ask (in ask order); `deck` resolves a step's `card` (its printed short ID) to
 * the physical card, and a retry re-presents the same card; `presents` overrides the presented card
 * outright. `beforePresent(card, n)` runs right before the n-th present of that card and
 * `stopBeforePresent` ends the drive there instead; `onRetry(card)` runs when a torn tap comes back
 * for its retry — the card's state is then inspectable off-channel.
 */
const drive = async (
  r: Rig,
  op: unknown,
  actions: {
    codes?: Uint8Array[];
    choices?: SimCard[];
    deck?: SimCard[];
    presents?: SimCard[];
    beforePresent?: (card: SimCard, nth: number) => Promise<void>;
    onRetry?: (card: SimCard | undefined) => Promise<void>;
    stopBeforePresent?: { card: SimCard; nth: number };
    shortIds?: string[];
  },
  verify?: unknown,
): Promise<{ result?: Record<string, unknown>; error?: string; opId?: string; taps: number }> => {
  const first = await r.h.call(
    "card.begin",
    { op, ...(verify === undefined ? {} : { verify }) },
    r.session,
  );
  if ("err" in first) {
    return { error: first.err.code, taps: 0 };
  }
  const { opId, step: firstStep } = first.ok as { opId: string; step: Step };
  const deck = actions.deck ?? actions.choices ?? [];
  const byShort = (sid: string): SimCard | undefined =>
    deck.find((c) => shortId(c.identity) === sid);
  let pendingChoice: SimCard | undefined;
  let lastPresented: SimCard | undefined;
  const presentsSeen = new Map<SimCard, number>();
  let step = firstStep;
  let taps = 0;
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    if (guard > 100) {
      return { error: "driver-guard", opId, taps };
    }
    if (step.kind === "input") {
      if (step["purpose"] === "short-id") {
        const bound = step["card"] as string | undefined;
        const override = actions.shortIds?.shift();
        const chosen =
          bound === undefined
            ? override === undefined
              ? actions.choices?.shift()
              : undefined
            : byShort(bound);
        pendingChoice = chosen;
        r.input.push(
          utf8ToBytes(override ?? (chosen === undefined ? "0000-0000" : shortId(chosen.identity))),
        );
      } else {
        const code = actions.codes?.shift();
        if (code === undefined) {
          return { error: "driver-no-code", opId, taps };
        }
        r.input.push(code);
      }
    } else {
      taps += 1;
      const bound = step["card"] as string | undefined;
      const next =
        actions.presents?.shift() ??
        (bound === undefined ? undefined : byShort(bound)) ??
        pendingChoice ??
        actions.choices?.shift();
      if (step["reason"] === "retry") {
        await actions.onRetry?.(lastPresented);
      }
      if (next === undefined) {
        return { error: "driver-no-card", opId, taps };
      }
      const nth = (presentsSeen.get(next) ?? 0) + 1;
      presentsSeen.set(next, nth);
      if (
        actions.stopBeforePresent !== undefined &&
        actions.stopBeforePresent.card === next &&
        actions.stopBeforePresent.nth === nth
      ) {
        return { result: { stopped: true }, opId, taps };
      }
      await actions.beforePresent?.(next, nth);
      r.reader.present(next);
      lastPresented = next;
    }
    const next = await r.h.call("card.step", { opId }, r.session);
    if ("err" in next) {
      return { error: next.err.code, opId, taps };
    }
    step = next.ok as Step;
  }
  return { result: step["result"] as Record<string, unknown>, opId, taps };
};

/** SELECT + OPEN + STATUS straight on the card — the off-channel post-state read. */
const rawStatus = async (card: SimCard): Promise<{ life: string; tries: number }> => {
  await card.reset();
  const selected = await card.transmit(SELECT_APDU);
  if (selected === "torn" || bytesToHex(selected) !== "9000") {
    throw new Error("SELECT failed");
  }
  const { apdu: request, secret } = openRequest((n) => new Uint8Array(randomBytes(n)));
  const response = await card.transmit(request);
  if (response === "torn") {
    throw new Error("OPEN torn");
  }
  const session = openResponse(secret, request, response, [CA1_ANCHOR], []);
  const rapdu = await card.transmit(session.wrap(cmd.status()));
  if (rapdu === "torn") {
    throw new Error("STATUS torn");
  }
  return decode.status(result(cmd.status(), session.unwrap(rapdu)));
};

const CODE_B = (): Uint8Array[] => [utf8ToBytes(CODE), utf8ToBytes(CODE)];

/** `create` a k-card set; `cards[0]` is the source, the rest the targets. */
const createSet = async (
  r: Rig,
  cards: SimCard[],
  opts?: { generate?: boolean; code?: string; groups?: number },
): Promise<Record<string, unknown>> => {
  const code = opts?.code ?? CODE;
  const source =
    opts?.generate === true
      ? { kind: "generate" }
      : { kind: "wallet", walletId: await vaultWalletId(r) };
  const [, ...targets] = cards;
  const out = await drive(
    r,
    {
      kind: "create",
      cards: cards.length,
      source,
      ...(opts?.groups === undefined ? {} : { groups: opts.groups }),
    },
    {
      codes: [utf8ToBytes(code), utf8ToBytes(code)],
      choices: [...targets, cards[0]!],
      deck: cards,
    },
    verifyPasskey(),
  );
  if (out.result === undefined) {
    throw new Error(`create failed: ${out.error}`);
  }
  return out.result;
};

const account = async (
  r: Rig,
  walletId: string,
  template: string,
  network: string,
  groupIndex = 0,
): Promise<Record<string, unknown>> =>
  ok(await r.h.call("wallet.accounts", { walletId, groupIndex, template, network }, r.session));

describe.skipIf(SIM_LAUNCHER === undefined)("multi-card operations (simulator)", () => {
  let simulator: Simulator;

  it("starts the pinned simulator", async () => {
    simulator = await startSimulator(SIM_LAUNCHER ?? "");
    expect(simulator).toBeDefined();
  }, 120_000);

  it("create k=2 imported: both members ready, accounts equal the software wallet's, both cards sign", async () => {
    const r = await rig();
    const sourceId = await vaultWalletId(r);
    // The software wallet's answers, captured before the import.
    const before = {
      evm: await account(r, sourceId, "evm.bip44", "eip155:1"),
      btc: await account(r, sourceId, "btc.bip84", BTC_MAINNET),
      tron: await account(r, sourceId, "tron.bip44", "tron:728126428"),
      solana: await account(
        r,
        sourceId,
        "solana.bip44-change",
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      ),
    };
    const source = await simulator.newCard();
    const target = await simulator.newCard();
    const created = await createSet(r, [source, target]);
    expect(created["kind"]).toBe("create");
    const { walletId, cards } = await cardWallet(r);
    expect(walletId).toBe(sourceId);
    expect(cards.map((c) => c.cardId)).toStrictEqual([
      bytesToHex(cardId(source.identity)),
      bytesToHex(cardId(target.identity)),
    ]);
    expect(cards.every((c) => c.state === "ready")).toBe(true);
    // accounts come from the record and equal the software wallet's
    for (const [template, network, key] of [
      ["evm.bip44", "eip155:1", "evm"],
      ["btc.bip84", BTC_MAINNET, "btc"],
      ["tron.bip44", "tron:728126428", "tron"],
      ["solana.bip44-change", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "solana"],
    ] as const) {
      await expect(account(r, walletId, template, network)).resolves.toStrictEqual(before[key]);
    }
    // health verifies every member under the same set code
    const health = await drive(
      r,
      { kind: "health", walletId },
      { codes: [utf8ToBytes(CODE)], choices: [source, target], deck: [source, target] },
    );
    expect(health.error).toBeUndefined();
    // Each member signs an EVM personal message recovering to the wallet's address, and one
    // bitcoin message each — every card holds the seed.
    const evmRequest = {
      kind: "evm.personal-message",
      network: "eip155:1",
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      message: utf8ToBytes("two-card set"),
    };
    for (const card of [source, target]) {
      const out = await drive(
        r,
        { kind: "sign", request: evmRequest },
        { codes: [utf8ToBytes(CODE)], choices: [card], deck: [card] },
        verifyPasskey(),
      );
      expect(out.error).toBeUndefined();
      const signature = field(
        field(out.result ?? {}, "result") as Record<string, unknown>,
        "signature",
      ) as Uint8Array;
      expect(recoverEvmSigner(normalizeEvm(evmRequest), { signature })).toBe(
        strField(before.evm, "address").toLowerCase(),
      );
    }
  }, 600_000);

  it("create k=3 imported: three members ready and each verifies", async () => {
    const r = await rig();
    const cards = [await simulator.newCard(), await simulator.newCard(), await simulator.newCard()];
    const created = await createSet(r, cards);
    expect(created["kind"]).toBe("create");
    const { walletId, cards: entries } = await cardWallet(r);
    void walletId;
    expect(entries).toHaveLength(3);
    expect(entries.every((c) => c.state === "ready")).toBe(true);
    const health = await drive(
      r,
      { kind: "health", walletId },
      { codes: [utf8ToBytes(CODE)], choices: cards, deck: cards },
    );
    expect(health.error).toBeUndefined();
  }, 600_000);

  it("create k=2 generated: addresses for all families, one request per signing-plans kind verifies", async () => {
    const r = await rig();
    const source = await simulator.newCard();
    const target = await simulator.newCard();
    const created = await createSet(r, [source, target], { generate: true });
    expect(created["kind"]).toBe("create");
    const { walletId } = await cardWallet(r);
    // The generated wallet has no seed oracle: every address family comes from the record and
    // is proven by recovering the signature each member card produces.
    const evm = await account(r, walletId, "evm.bip44", "eip155:1");
    const tron = await account(r, walletId, "tron.bip44", "tron:728126428");
    const solana = await account(
      r,
      walletId,
      "solana.bip44-change",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    );
    const btc84 = await account(r, walletId, "btc.bip84", BTC_MAINNET);
    const btc86 = await account(r, walletId, "btc.bip86", BTC_MAINNET);
    const btc44 = await account(r, walletId, "btc.bip44", BTC_MAINNET);
    const xpubLeaf = (xpub: string, index: number): HDKey =>
      HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(index); // change 0 / index
    const solanaKey = new Uint8Array(
      getAddressEncoder().encode(address(strField(solana, "address"))),
    );

    const sign = async (
      request: Record<string, unknown>,
      card: SimCard,
    ): Promise<Record<string, unknown>> => {
      const out = await drive(
        r,
        { kind: "sign", request },
        { codes: [utf8ToBytes(CODE)], choices: [card], deck: [card] },
        verifyPasskey(),
      );
      if (out.result === undefined) {
        throw new Error(`sign ${request["kind"] as string} failed: ${out.error}`);
      }
      return field(out.result, "result") as Record<string, unknown>;
    };

    // evm.transaction (legacy vector), personal-message, typed-data — all recover to the evm address.
    for (const name of ["evm-legacy", "evm-personal-message", "evm-typed-data-mail"]) {
      const c = vectorCase(name);
      const request: Record<string, unknown> = {
        ...c.request,
        account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      };
      if (typeof request["message"] === "string") {
        request["message"] = hexToBytes(request["message"]);
      }
      const result = await sign(request, source);
      expect(recoverEvmSigner(normalizeEvm(request), result)).toBe(
        strField(evm, "address").toLowerCase(),
      );
    }

    // tron.message first — the recovered key gives the owner bytes the tron.transaction embeds.
    const tronMsg: Record<string, unknown> = {
      ...vectorCase("tron-message").request,
      account: { kind: "hd", walletId, groupIndex: 0, template: "tron.bip44" },
      message: utf8ToBytes("hello tron"),
    };
    const tronMsgResult = await sign(tronMsg, target);
    const tronSig = field(tronMsgResult, "signature") as Uint8Array;
    const tronDigest = tronMessageDigest(utf8ToBytes("hello tron"));
    const tronPub = new secp256k1.Signature(
      bytesToNumberBE(tronSig.subarray(0, 32)),
      bytesToNumberBE(tronSig.subarray(32, 64)),
      (tronSig[64] ?? 0) >= 27 ? (tronSig[64] ?? 0) - 27 : (tronSig[64] ?? 0),
    ).recoverPublicKey(tronDigest);
    expect(tronAddressFromPublicKey(tronPub.toBytes(false))).toBe(strField(tron, "address"));

    const tronReq: Record<string, unknown> = {
      ...vectorCase("tron-transaction-trx-transfer").request,
      account: { kind: "hd", walletId, groupIndex: 0, template: "tron.bip44" },
    };
    const raw = hexToBytes(tronReq["rawData"] as string);
    const owner = hexToBytes(evmAddressFromPublicKey(tronPub.toBytes(true)).slice(2));
    const anvil = hexToBytes("41f39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    for (let i = 0; i + 21 <= raw.length; i += 1) {
      if (raw.subarray(i, i + 21).every((b, j) => b === anvil[j])) {
        raw.set([0x41, ...owner], i);
      }
    }
    tronReq["rawData"] = raw;
    const tronTx = await sign(tronReq, target);
    const txSig = field(tronTx, "signature") as Uint8Array;
    const txRecovered = new secp256k1.Signature(
      bytesToNumberBE(txSig.subarray(0, 32)),
      bytesToNumberBE(txSig.subarray(32, 64)),
      (txSig[64] ?? 0) >= 27 ? (txSig[64] ?? 0) - 27 : (txSig[64] ?? 0),
    ).recoverPublicKey(sha256(raw));
    expect(tronAddressFromPublicKey(txRecovered.toBytes(false))).toBe(strField(tron, "address"));

    const tronTd: Record<string, unknown> = {
      ...vectorCase("tron-typed-data-permit2-single").request,
      account: { kind: "hd", walletId, groupIndex: 0, template: "tron.bip44" },
    };
    const tronTdResult = await sign(tronTd, target);
    const tdSig = field(tronTdResult, "signature") as Uint8Array;
    const tdTask = planTron({ ...tronTd, account: undefined } as never, {
      path: [44 + HARDENED, 195 + HARDENED, HARDENED, 0, 0],
      publicKey: tronPub.toBytes(true),
    }).tasks[0] as { digest: Uint8Array };
    const tdRecovered = new secp256k1.Signature(
      bytesToNumberBE(tdSig.subarray(0, 32)),
      bytesToNumberBE(tdSig.subarray(32, 64)),
      (tdSig[64] ?? 0) >= 27 ? (tdSig[64] ?? 0) - 27 : (tdSig[64] ?? 0),
    ).recoverPublicKey(tdTask.digest);
    expect(tronAddressFromPublicKey(tdRecovered.toBytes(false))).toBe(strField(tron, "address"));

    // solana.message (raw) verifies against the account address; the transaction's first
    // required signer is re-pointed at the generated key.
    const solMsg: Record<string, unknown> = {
      ...vectorCase("solana-message-raw").request,
      account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
      message: utf8ToBytes("hello solana"),
    };
    const solMsgResult = await sign(solMsg, source);
    expect(
      verifySolanaSignature(
        utf8ToBytes("hello solana"),
        field(solMsgResult, "signature") as Uint8Array,
        strField(solana, "address"),
      ),
    ).toBe(true);
    const solTx: Record<string, unknown> = {
      ...vectorCase("solana-transaction-legacy-single-signer").request,
      account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
    };
    const solBytes = hexToBytes(solTx["message"] as string);
    solBytes.set(solanaKey, 0 + 3 + 1); // legacy header(3) then the first account
    solTx["message"] = solBytes;
    const solTxResult = await sign(solTx, source);
    expect(
      verifySolanaSignature(
        solBytes,
        field(solTxResult, "signature") as Uint8Array,
        strField(solana, "address"),
      ),
    ).toBe(true);

    // bitcoin.message on bip84 — the request's address must be the leaf the kernel derives.
    const leaf84 = xpubLeaf(strField(btc84, "xpub"), 0);
    const addr84 = Address().encode(p2wpkh(leaf84.publicKey ?? new Uint8Array(33)));
    const btcMsg: Record<string, unknown> = {
      ...vectorCase("bitcoin-message-bip322-p2wpkh").request,
      account: { kind: "hd", walletId, groupIndex: 0, template: "btc.bip84" },
      change: 0,
      index: 0,
      address: addr84,
    };
    const btcMsgResult = await sign(btcMsg, source);
    const rawSig = field(btcMsgResult, "signature");
    const sig64 =
      rawSig instanceof Uint8Array ? Buffer.from(rawSig).toString("base64") : String(rawSig);
    expect(verifyBitcoinMessage(addr84, "Hello World", sig64, BTC_MAINNET)).toBe(true);

    // bitcoin.psbt over one bip84 and one bip86 input built for the generated keys.
    const leaf86 = xpubLeaf(strField(btc86, "xpub"), 0);
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    const inputs: Array<{ purpose: number; pub: Uint8Array; xpub: string }> = [
      { purpose: 84, pub: leaf84.publicKey ?? new Uint8Array(33), xpub: strField(btc84, "xpub") },
      { purpose: 86, pub: leaf86.publicKey ?? new Uint8Array(33), xpub: strField(btc86, "xpub") },
    ];
    for (const [i, input] of inputs.entries()) {
      const script =
        input.purpose === 86 ? p2tr(input.pub.slice(1)).script : p2wpkh(input.pub).script;
      const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
      prev.addInput({
        txid: hexToBytes(`${(i + 0x20).toString(16)}${"dd".repeat(31)}`),
        index: 0,
        sequence: 0xffffffff,
      });
      prev.addOutput({ script, amount: 100000n });
      const path = [input.purpose + HARDENED, HARDENED, HARDENED, 0, 0];
      const fp = Number.parseInt(strField(input.purpose === 86 ? btc86 : btc84, "fingerprint"), 16);
      if (input.purpose === 86) {
        const xonly = input.pub.slice(1);
        tx.addInput({
          txid: hexToBytes(prev.id),
          index: 0,
          sequence: 0xfffffffd,
          witnessUtxo: { script, amount: 100000n },
          nonWitnessUtxo: prev.toBytes(true, false),
          tapInternalKey: xonly,
          tapBip32Derivation: [[xonly, { hashes: [], der: { fingerprint: fp, path } }]],
        });
      } else {
        tx.addInput({
          txid: hexToBytes(prev.id),
          index: 0,
          sequence: 0xfffffffd,
          witnessUtxo: { script, amount: 100000n },
          nonWitnessUtxo: prev.toBytes(true, false),
          bip32Derivation: [[input.pub, { fingerprint: fp, path }]],
        });
      }
    }
    tx.addOutput({ script: p2wpkh(leaf84.publicKey ?? new Uint8Array(33)).script, amount: 5000n });
    const psbtResult = await sign(
      {
        kind: "bitcoin.psbt",
        network: BTC_MAINNET,
        account: { kind: "hd", walletId, groupIndex: 0 },
        psbt: tx.toPSBT(0),
        sign: inputs.map((input, index) => ({
          index,
          template: input.purpose === 86 ? "btc.bip86" : "btc.bip84",
        })),
      },
      target,
    );
    const signedPsbt = field(psbtResult, "signedPsbt") as Uint8Array;
    expect(
      verifyBitcoinPsbtSignatures(
        signedPsbt,
        [0],
        strField(btc84, "xpub"),
        "btc.bip84",
        BTC_MAINNET,
      ),
    ).toBe(true);
    expect(
      verifyBitcoinPsbtSignatures(
        signedPsbt,
        [1],
        strField(btc86, "xpub"),
        "btc.bip86",
        BTC_MAINNET,
      ),
    ).toBe(true);
    void btc44;
  }, 900_000);

  it("create stopped after the source tap leaves a pending member; transfer finishes it", async () => {
    const r = await rig();
    const source = await simulator.newCard();
    const target = await simulator.newCard();
    const begun = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: CODE_B(),
        choices: [target, source],
        deck: [target, source],
        stopBeforePresent: { card: target, nth: 2 },
      },
      verifyPasskey(),
    );
    expect(begun.result?.["stopped"]).toBe(true);
    ok(await r.h.call("card.cancel", { opId: begun.opId }, r.session));
    const { walletId, cards } = await cardWallet(r);
    expect(cards[0]?.state).toBe("ready");
    expect(cards[1]?.state).toBe("pending");
    expect(cards[1]?.shortId).toBe(shortId(target.identity));

    const out = await drive(
      r,
      { kind: "transfer", walletId },
      {
        codes: [utf8ToBytes(CODE), utf8ToBytes("target code"), utf8ToBytes("target code")],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBeUndefined();
    const after = await cardWallet(r);
    expect(after.cards.every((c) => c.state === "ready")).toBe(true);
    // The target verifies under its new code.
    const health = await drive(
      r,
      { kind: "health", walletId },
      {
        codes: [utf8ToBytes(CODE), utf8ToBytes("target code")],
        choices: [source, target],
        deck: [source, target],
      },
    );
    expect(health.error).toBeUndefined();
  }, 600_000);

  it("reseal of a LOADED member: the new code works, the old one is refused", async () => {
    const r = await rig();
    const source = await simulator.newCard();
    const target = await simulator.newCard();
    await createSet(r, [source, target]);
    const { walletId, cards } = await cardWallet(r);
    const out = await drive(
      r,
      { kind: "reseal", walletId, card: cards[1]?.cardId ?? "" },
      {
        codes: [utf8ToBytes(CODE), utf8ToBytes("reseal sim"), utf8ToBytes("reseal sim")],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.["kind"]).toBe("reseal");
    // health: source under the old code; target under the NEW code after the old is refused.
    const health = await drive(
      r,
      { kind: "health", walletId },
      {
        codes: [utf8ToBytes(CODE), utf8ToBytes(CODE), utf8ToBytes("reseal sim")],
        choices: [source, target],
        deck: [source, target],
      },
    );
    expect(health.error).toBeUndefined();
  }, 600_000);

  it("reseal of a member the failure limit erased to BLANK", async () => {
    const r = await rig();
    const source = await simulator.newCard();
    const target = await simulator.newCard();
    await createSet(r, [source, target]);
    const { walletId, cards } = await cardWallet(r);
    // Burn the target's ten tries on the real applet.
    const begin = ok(
      await r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session),
    ) as { opId: string; step: Step };
    let { step } = begin;
    let failure: string | undefined;
    for (let guard = 0; failure === undefined && guard < 80; guard += 1) {
      if (step.kind === "input") {
        r.input.push(utf8ToBytes("wrong sim code"));
      } else {
        r.reader.present(target); // burn the target's tries; the gate accepts any undone member
      }
      const next = await r.h.call("card.step", { opId: begin.opId }, r.session);
      if ("err" in next) {
        failure = next.err.code;
      } else {
        step = next.ok as Step;
      }
    }
    expect(failure).toBe("card-erased");
    const erasedPost = await rawStatus(target);
    expect(erasedPost.life).toBe("blank");
    const after = await cardWallet(r);
    expect(after.cards[1]?.state).toBe("unknown");

    const out = await drive(
      r,
      { kind: "reseal", walletId, card: cards[1]?.cardId ?? "" },
      {
        codes: [utf8ToBytes(CODE), utf8ToBytes("reseal blk"), utf8ToBytes("reseal blk")],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBeUndefined();
    const done = await cardWallet(r);
    expect(done.cards[1]?.state).toBe("ready");
    const installPost = await rawStatus(target);
    expect(installPost.life).toBe("loaded");
  }, 600_000);

  it("a different blank card presented for the target import is card-id-mismatch, nothing after STATUS", async () => {
    const r = await rig();
    const source = await simulator.newCard();
    const target = await simulator.newCard();
    const stranger = await simulator.newCard();
    const out = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: CODE_B(),
        choices: [target, source],
        deck: [target, source, stranger],
        presents: [target, source, stranger], // the install tap must see the wrong card
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-id-mismatch");
    // The stranger's tap ended at the card-ID gate — SELECT+OPEN then refusal, no STATUS.
    expect(r.reader.sessionLengths.at(-1)).toBe(2);
  }, 600_000);

  it("a mistyped short ID stops the op before the card sees a command", async () => {
    const r = await rig();
    const target = await simulator.newCard();
    const out = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: CODE_B(),
        choices: [target],
        shortIds: ["0000-0000"],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-id-mismatch");
  }, 300_000);

  it("the same physical card as two targets is refused by the exclusion gate", async () => {
    const r = await rig();
    const twin = await simulator.newCard();
    const source = await simulator.newCard();
    const out = await drive(
      r,
      { kind: "create", cards: 3, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: CODE_B(),
        choices: [twin, twin, source],
        deck: [twin, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-id-mismatch");
  }, 300_000);

  it("tag loss at every transmit index of a two-card create still completes", async () => {
    // Clean layout first.
    const base = await rig();
    const baseCards = [await simulator.newCard(), await simulator.newCard()];
    const sent = base.reader.sent.length;
    await createSet(base, baseCards);
    const total = base.reader.sent.length - sent;
    expect(total).toBeGreaterThan(5);
    for (let i = 1; i <= total; i += 1) {
      const r = await rig();
      const source = await simulator.newCard();
      const target = await simulator.newCard();
      r.reader.loseGlobal(i);
      const out = await drive(
        r,
        { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
        { codes: CODE_B(), choices: [target, source], deck: [target, source] },
        verifyPasskey(),
      );
      if (out.result === undefined) {
        throw new Error(`loss at transmit ${i}/${total} failed: ${out.error}`);
      }
      const { cards } = await cardWallet(r);
      expect(cards.every((c) => c.state === "ready")).toBe(true);
    }
  }, 1_200_000);

  it("power loss at every persistent write of OFFER, CREATE, EXPORT and IMPORT leaves a resumable set", async () => {
    /**
     * `card.tear(k)` arms the tear on the k-th persistent write of a later command. Arm points: tap
     * 1 = target OFFER (STATUS+OFFER = 4 transmits); tap 2 = source CREATE + nodes + EXPORT P1=0 +
     * P1=1; tap 3 = target IMPORT P1=0 + P1=1 (5 transmits). The write counter resets per command,
     * so k walks each writing command in the armed tap in order; the torn session's length names
     * the dead command, and a raw STATUS right after reads the post-state.
     */
    type Run = {
      k: number;
      torn: boolean;
      error?: string | undefined;
      tornSession?: number | undefined;
      tornLength?: number | undefined;
      post?: string | undefined;
      sessions: number[];
    };
    const probe = async (
      arm: { card: "target" | "source"; nth: number },
      k: number,
    ): Promise<Run> => {
      const r = await rig();
      const source = await simulator.newCard();
      const target = await simulator.newCard();
      const sessionsAt = r.reader.sessionLengths.length;
      const victim = arm.card === "target" ? target : source;
      let torn: { session: number; length: number; post: string } | undefined;
      const out = await drive(
        r,
        { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
        {
          codes: CODE_B(),
          choices: [target, source],
          deck: [target, source],
          beforePresent: async (presented, nth) => {
            if (presented === victim && nth === arm.nth) {
              await victim.tear(k);
            }
          },
          onRetry: async (presented) => {
            const session = r.reader.sessionLengths.length - 1;
            const length = r.reader.sessionLengths.at(-1) ?? 0;
            const post = await rawStatus(presented === target ? target : source);
            torn = { session, length, post: post.life };
          },
        },
        verifyPasskey(),
      );
      if (out.result === undefined) {
        throw new Error(`arm ${arm.card}#${arm.nth} k=${k} failed: ${out.error}`);
      }
      return {
        k,
        torn: torn !== undefined,
        tornSession: torn?.session,
        tornLength: torn?.length,
        post: torn?.post,
        sessions: r.reader.sessionLengths.slice(sessionsAt),
      };
    };

    // The clean layout names each transmit: [OFFER tap, source tap, IMPORT tap].
    const clean = await rig();
    const cleanCards = [await simulator.newCard(), await simulator.newCard()];
    const cleanSessionsAt = clean.reader.sessionLengths.length;
    await createSet(clean, cleanCards);
    const cleanSessions = clean.reader.sessionLengths.slice(cleanSessionsAt);
    expect(cleanSessions).toHaveLength(3);

    /**
     * EXPORT is unreachable by the create sweep — CREATE's eleven writes always burn the lower k
     * first. `transfer`'s source tap is VERIFY + EXPORT P1=0 + P1=1 only (sessions [offer, source,
     * install]), so arming on the source's present isolates it — and reveals VERIFY's own write
     * count (the failure-counter reset commit).
     */
    /**
     * `at` = the 1-based transmit index in the source session to arm before: 4 arms the whole tap
     * (VERIFY's writes), 5 and 6 arm mid-tap — a transmit wrapper calls `tear` right before EXPORT
     * P1=0 / P1=1 go out, isolating each command's own write count from VERIFY's.
     */
    const probeTransfer = async (at: 4 | 5 | 6, k: number): Promise<Run> => {
      const r = await rig();
      const source = await simulator.newCard();
      const target = await simulator.newCard();
      // A pending member: cancel the create before the install tap.
      const staged = await drive(
        r,
        { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
        {
          codes: CODE_B(),
          choices: [target, source],
          deck: [target, source],
          stopBeforePresent: { card: target, nth: 2 },
        },
        verifyPasskey(),
      );
      expect(staged.result?.["stopped"]).toBe(true);
      ok(await r.h.call("card.cancel", { opId: staged.opId }, r.session));
      const { walletId } = await cardWallet(r);
      const sessionsAt = r.reader.sessionLengths.length;
      let torn: { session: number; length: number; post: string } | undefined;
      let armed = false;
      let tx = 0;
      const armedSource: SimCard =
        at === 4
          ? source
          : {
              ...source,
              transmit: async (apdu: Uint8Array) => {
                tx += 1;
                if (tx === at && !armed) {
                  armed = true;
                  await source.tear(k);
                }
                return source.transmit(apdu);
              },
            };
      const out = await drive(
        r,
        { kind: "transfer", walletId },
        {
          codes: [utf8ToBytes(CODE), utf8ToBytes("t code"), utf8ToBytes("t code")],
          choices: [target, armedSource],
          deck: [target, armedSource],
          beforePresent: async (presented, nth) => {
            if (at === 4 && presented === armedSource && nth === 1) {
              await source.tear(k);
            }
          },
          onRetry: async () => {
            const session = r.reader.sessionLengths.length - 1;
            const length = r.reader.sessionLengths.at(-1) ?? 0;
            const post = await rawStatus(source);
            torn = { session, length, post: post.life };
          },
        },
        verifyPasskey(),
      );
      let { error } = out;
      if (error !== undefined) {
        // A torn mid-commit VERIFY leaves the committed counter below the record's — the next
        // session flags `card-tampered`, commits the lower tries, and a clean re-run finishes.
        // Whatever the failure was, an untorn transfer must still complete the member.
        const clean = await drive(
          r,
          { kind: "transfer", walletId },
          {
            codes: [utf8ToBytes(CODE), utf8ToBytes("t code"), utf8ToBytes("t code")],
            choices: [target, source],
            deck: [target, source],
          },
          verifyPasskey(),
        );
        if (clean.result === undefined) {
          error = `${error} → resumption failed: ${clean.error ?? "?"}`;
        } else {
          const { cards } = await cardWallet(r);
          error = cards.every((c) => c.state === "ready")
            ? `${error} → resumed`
            : `${error} → resumption left members not-ready`;
        }
      }
      return {
        k,
        torn: torn !== undefined,
        tornSession: torn === undefined ? undefined : torn.session - sessionsAt,
        tornLength: torn?.length,
        post: torn?.post,
        error,
        sessions: r.reader.sessionLengths.slice(sessionsAt),
      };
    };
    const runs: Array<{ arm: string; index: number } & Run> = [];
    for (const spec of [
      { name: "OFFER", arm: { card: "target" as const, nth: 1 }, index: 0 },
      { name: "CREATE", arm: { card: "source" as const, nth: 1 }, index: 1 },
      { name: "IMPORT", arm: { card: "target" as const, nth: 2 }, index: -1 },
    ]) {
      for (let k = 1; k <= 24; k += 1) {
        const run = await probe(spec.arm, k);
        runs.push({ arm: spec.name, index: spec.index, ...run });
        // Stop when the armed tap survived: either nothing tore, or the tear leaked past the
        // armed card's command into a later session on the same card.
        const tornInArmedTap =
          run.torn &&
          (spec.index === -1
            ? run.tornSession === run.sessions.length - 2 // the torn install's retry follows it
            : run.tornSession === spec.index);
        if (!tornInArmedTap) {
          break;
        }
      }
    }
    for (const [name, at] of [
      ["VERIFY", 4],
      ["EXPORT", 5],
      ["EXPORT P1=1", 6],
    ] as const) {
      for (let k = 1; k <= 24; k += 1) {
        const run = await probeTransfer(at, k);
        runs.push({ arm: name, index: 1, ...run });
        if (!run.torn || run.tornSession !== 1) {
          break;
        }
      }
    }
    // Control for the mid-tap arm: wrapping the target so `tear(1)` is sent right before its
    // 9th global transmit (4 offer + IMPORT P1=1) must tear that very command — proving the
    // "untorn" EXPORT rows mean EXPORT has zero persistent writes, not that arming failed.
    {
      const r = await rig();
      const source = await simulator.newCard();
      const target = await simulator.newCard();
      let tx = 0;
      let fired = false;
      const wrapped: SimCard = {
        ...target,
        transmit: async (apdu: Uint8Array) => {
          tx += 1;
          if (tx === 4 + 5 && !fired) {
            fired = true;
            await target.tear(1);
          }
          return target.transmit(apdu);
        },
      };
      let tornAt: number | undefined;
      const out = await drive(
        r,
        { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
        {
          codes: CODE_B(),
          choices: [wrapped, source],
          deck: [wrapped, source],
          onRetry: async () => {
            tornAt = r.reader.sessionLengths.at(-1);
            await Promise.resolve();
          },
        },
        verifyPasskey(),
      );
      expect(out.error).toBeUndefined();
      expect(tornAt).toBe(5); // IMPORT P1=1 died on its first write; the resend completed
    }
    // The probe table: which k tore which command (the torn session's length names it — the
    // clean layout above gives the transmit index of each command) and the post-state.
    const table: string[] = [];
    for (const run of runs) {
      table.push(
        `${run.arm} k=${run.k}: ${run.torn ? `torn in session ${String(run.tornSession)} at transmit ${String(run.tornLength)} → ${String(run.post)}` : "untorn"}${run.error === undefined ? "" : ` (${run.error})`}`,
      );
    }
    console.log(table.join("\n"));
    expect(runs.some((r) => r.torn)).toBe(true);
    expect(
      runs
        .filter((r) => r.error !== undefined && !r.error.endsWith("→ resumed"))
        .map((r) => `${r.arm} k=${r.k}: ${r.error}`),
    ).toStrictEqual([]);
  }, 1_800_000);

  it("lost IMPORT P1=1 response: LOADED branch confirms by VERIFY; BLANK branch resends", async () => {
    // The clean run's very last transmit is IMPORT P1=1 of the install tap.
    const layout = await rig();
    const layoutCards = [await simulator.newCard(), await simulator.newCard()];
    const sentAt = layout.reader.sent.length;
    await createSet(layout, layoutCards);
    const lastIndex = layout.reader.sent.length - sentAt;
    expect(layout.reader.sessionLengths.at(-1)).toBe(5); // SELECT,OPEN,STATUS,IMPORT0,IMPORT1

    // BLANK branch: loseAfter drops the whole transmit — the card never ran IMPORT P1=1.
    {
      const r = await rig();
      const source = await simulator.newCard();
      const target = await simulator.newCard();
      const out = await drive(
        r,
        { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
        {
          codes: CODE_B(),
          choices: [target, source],
          deck: [target, source],
          beforePresent: async (presented, nth) => {
            if (presented === target && nth === 2) {
              r.reader.loseAfter(4); // transmit 5 = IMPORT P1=1 never reaches the card
            }
            await Promise.resolve();
          },
        },
        verifyPasskey(),
      );
      expect(out.error).toBeUndefined();
      const { cards } = await cardWallet(r);
      expect(cards.every((c) => c.state === "ready")).toBe(true);
    }

    // LOADED branch: loseGlobal runs the command but loses the answer — the install committed.
    {
      const r = await rig();
      const source = await simulator.newCard();
      const target = await simulator.newCard();
      r.reader.loseGlobal(lastIndex);
      const out = await drive(
        r,
        { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
        { codes: CODE_B(), choices: [target, source], deck: [target, source] },
        verifyPasskey(),
      );
      expect(out.error).toBeUndefined();
      const { cards } = await cardWallet(r);
      expect(cards.every((c) => c.state === "ready")).toBe(true);
      // The retry session is SELECT+OPEN+STATUS+IMPORT0(6985)+VERIFY = 5 transmits — the
      // committed install was confirmed by VERIFY, not re-sent.
      const sessions = r.reader.sessionLengths;
      expect(sessions.at(-1)).toBe(5);
    }
  }, 900_000);
});
