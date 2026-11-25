/**
 * The sealed change-marks record and its lifecycle: the header codec round-trips the committed
 * vector byte-exactly and rejects every break of an invariant; `claimUnlocked` latches a wrong
 * marker byte as corrupt; `parseHeader` binds the record to its wallet id; and `chain.sign`
 * commits the mark raise after verification and before any signature exists — a failed commit
 * answers without one, an aborted signing still leaves the mark raised (it only widens the
 * wallet's own change scan), and `wallet.delete` removes the record.
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "@qntx/wallet-chains";
import { bitcoinNetwork, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { passkeyKek, unwrapDek } from "../src/vault/factors.ts";
import { withManifest } from "../src/vault/manifest.ts";
import {
  CHANGE_MARKS_KIND,
  encodeChangeMarksHeader,
  marksHooks,
  parseChangeMarksHeader,
} from "../src/modules/chains/marks.ts";
import type { ChangeMarksHeader } from "../src/modules/chains/marks.ts";
import { sealRecord } from "../src/vault/vault.ts";
import type { Secret } from "../src/secret/secret.ts";
import { wipe } from "../src/secret/secret.ts";
import type { StoredRecord } from "../src/vault/store.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { kernelError, loadVectors } from "./helpers.ts";

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
function errCode(response: KernelResponse): string | undefined {
  return "err" in response ? response.err.code : undefined;
}
function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}
function strField(value: ProtocolValue, key: string): string {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`field ${key}: not a string`);
  }
  return v;
}
function numField(value: ProtocolValue, key: string): number {
  const v = field(value, key);
  if (typeof v !== "number") {
    throw new TypeError(`field ${key}: not a number`);
  }
  return v;
}

const vectors = loadVectors("templates/chains.json") as {
  mnemonic: string;
  master: { fingerprint: string };
};

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = new Uint8Array(32).fill(1);
const PASSKEY = () => ({
  kind: "passkey",
  credentialId: new Uint8Array(CREDENTIAL_ID),
  prf: new Uint8Array(PRF_VAULT),
});
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const TESTNET = "bip122:00000000da84f2bafbbc53dee25a72ae";
const MASTER_FP = 0x73c5da0a;
const HARDENED = 0x80000000;

const seed = mnemonicToSeedSync(vectors.mnemonic);
const childOf = (purpose: number, change: number, index: number): HDKey =>
  HDKey.fromMasterSeed(seed).derive(`m/${purpose}'/0'/0'/${change}/${index}`);
const scriptFor = (purpose: number, pub: Uint8Array): Uint8Array =>
  purpose === 86
    ? p2tr(pub.slice(1)).script
    : purpose === 49
      ? p2sh(p2wpkh(pub)).script
      : purpose === 44
        ? p2pkh(pub).script
        : p2wpkh(pub).script;
const PURPOSE_T: Readonly<Record<string, number>> = {
  "btc.bip44": 44,
  "btc.bip49": 49,
  "btc.bip84": 84,
  "btc.bip86": 86,
};
const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
const PAYEE_SCRIPT = p2wpkh(
  HDKey.fromMasterSeed(new Uint8Array(64).fill(3)).derive("m/0/0").publicKey!,
  bitcoinNetwork(BTC_NETWORK).params,
).script;

/**
 * A PSBT spending one own key per input spec (each bound by its derivation entry) to a payee plus
 * each listed own output — the same shape the own-output suite in chains.test.ts builds.
 */
const ownPsbt = (
  inputs: ReadonlyArray<{
    readonly template: string;
    readonly change?: number;
    readonly index?: number;
  }>,
  outputs: ReadonlyArray<{
    readonly purpose: number;
    readonly change: number;
    readonly index: number;
  }>,
): Uint8Array => {
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  for (const [i, spec] of inputs.entries()) {
    const purpose = PURPOSE_T[spec.template] ?? 84;
    const change = spec.change ?? 0;
    const index = spec.index ?? 0;
    const pub = childOf(purpose, change, index).publicKey!;
    const script = scriptFor(purpose, pub);
    const path = [purpose + HARDENED, HARDENED, HARDENED, change, index];
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({
      txid: hex((i + 16).toString(16).padStart(4, "0").repeat(16)),
      index: 0,
      sequence: 0xffffffff,
    });
    prev.addOutput({ script, amount: 100_000n });
    if (purpose === 86) {
      tx.addInput({
        txid: prev.id,
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script, amount: 100_000n },
        tapInternalKey: pub.slice(1),
        tapBip32Derivation: [
          [pub.slice(1), { hashes: [], der: { fingerprint: MASTER_FP, path } }],
        ],
      });
    } else {
      const entry: Record<string, unknown> = {
        txid: prev.id,
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script, amount: 100_000n },
        nonWitnessUtxo: prev.toBytes(true, false),
        bip32Derivation: [[pub, { fingerprint: MASTER_FP, path }]],
      };
      if (purpose === 49) {
        entry["redeemScript"] = p2wpkh(pub).script;
      }
      if (purpose === 44) {
        delete entry["witnessUtxo"];
      }
      tx.addInput(entry);
    }
  }
  tx.addOutput({ script: PAYEE_SCRIPT, amount: 90_000n });
  for (const spec of outputs) {
    const pub = childOf(spec.purpose, spec.change, spec.index).publicKey!;
    const path = [spec.purpose + HARDENED, HARDENED, HARDENED, spec.change, spec.index];
    tx.addOutput({ script: scriptFor(spec.purpose, pub), amount: 1000n });
    tx.updateOutput(
      tx.outputsLength - 1,
      spec.purpose === 86
        ? {
            tapBip32Derivation: [
              [pub.slice(1), { hashes: [], der: { fingerprint: MASTER_FP, path } }],
            ],
          }
        : { bip32Derivation: [[pub, { fingerprint: MASTER_FP, path }]] },
    );
  }
  return tx.toPSBT(0);
};

const psbtRequest = (
  walletId: string,
  origin: "internal" | "external",
  inputs: Parameters<typeof ownPsbt>[0],
  outputs: Parameters<typeof ownPsbt>[1],
  groupIndex = 0,
): SignRequest =>
  normalizeBitcoin({
    kind: "bitcoin.psbt",
    origin,
    network: BTC_NETWORK,
    account: { kind: "hd", walletId, groupIndex },
    psbt: ownPsbt(inputs, outputs),
    sign: inputs.map((input, index) => ({ index, template: input.template })),
  });

const setup = async (opts?: Parameters<typeof createHarness>[0]) => {
  const h = createHarness(opts);
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(vectors.mnemonic),
      factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
    }),
  );
  const session = strField(res, "session");
  ok(await h.call("vault.setBlindSigning", { enabled: true, verify: PASSKEY() }, session));
  return { h, session, walletId: strField(field(res, "wallet"), "walletId") };
};

const sign = async (
  h: Harness,
  session: string,
  request: SignRequest,
): Promise<KernelResponse> => h.call("chain.sign", { request, verify: PASSKEY() }, session);

const accountMark = async (
  h: Harness,
  session: string,
  walletId: string,
  params?: { groupIndex?: number; template?: string; network?: string },
): Promise<number> =>
  numField(
    ok(
      await h.call(
        "wallet.accounts",
        {
          walletId,
          groupIndex: params?.groupIndex ?? 0,
          template: params?.template ?? "btc.bip84",
          network: params?.network ?? BTC_NETWORK,
        },
        session,
      ),
    ),
    "changeMark",
  );

const marksRecord = async (h: Harness, walletId: string): Promise<StoredRecord | undefined> =>
  (await h.store.load()).records.find(
    (record) => record.kind === CHANGE_MARKS_KIND && record.id === walletId,
  );

/* vectors/vault/change-marks.json (scripts/vectors/change-marks.ts): the canonical header parses
 * and re-encodes byte for byte, and every rejection case fails its invariant. */
describe("change-marks record vectors", () => {
  const vector = loadVectors("vault/change-marks.json") as {
    walletId: string;
    header: { input: ChangeMarksHeader; text: string };
    rejects: Array<{ name: string; text: string }>;
  };

  it("parses the canonical header and re-encodes it byte-exactly", () => {
    expect(parseChangeMarksHeader(vector.header.text)).toStrictEqual(vector.header.input);
    expect(encodeChangeMarksHeader(vector.header.input)).toBe(vector.header.text);
    expect(vector.header.input.walletId).toBe(vector.walletId);
  });

  it.each(vector.rejects.map((entry) => [entry.name, entry] as const))(
    "rejects %s",
    (_name, entry) => {
      expect(kernelError(() => parseChangeMarksHeader(entry.text))).toBe("integrity");
    },
  );
});

describe("change-marks record hooks", () => {
  it("claimUnlocked accepts the marker byte, claims the record and wipes the plaintext", () => {
    const plaintext = new Uint8Array([0x01]);
    const claimed = marksHooks.claimUnlocked([
      { kind: CHANGE_MARKS_KIND, id: "w", header: "{}", plaintext },
      { kind: "entropy", id: "e", header: "{}", plaintext: new Uint8Array([0xaa]) },
    ]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.kind).toBe("entropy");
    expect([...plaintext]).toStrictEqual([0]);
  });

  it("claimUnlocked latches a wrong marker byte as corrupt and wipes", () => {
    const plaintext = new Uint8Array([0x02]);
    expect(
      kernelError(() =>
        marksHooks.claimUnlocked([
          { kind: CHANGE_MARKS_KIND, id: "w", header: "{}", plaintext },
        ]),
      ),
    ).toBe("integrity");
    expect([...plaintext]).toStrictEqual([0]);
  });

  it("parseHeader binds the record to the wallet id its header names", () => {
    const header = encodeChangeMarksHeader({ walletId: "6e0d11a50c03aa4f", marks: [] });
    expect(
      kernelError(() =>
        marksHooks.parseHeader({
          kind: CHANGE_MARKS_KIND,
          id: "0000000000000000",
          header,
          sealed: new Uint8Array(16),
        }),
      ),
    ).toBe("integrity");
    expect(
      kernelError(() =>
        marksHooks.parseHeader({
          kind: CHANGE_MARKS_KIND,
          id: "6e0d11a50c03aa4f",
          header,
          sealed: new Uint8Array(16),
        }),
      ),
    ).toBeUndefined();
  });
});

describe("change marks lifecycle", () => {
  it("a fresh wallet reports mark 0; an internal sign commits the hidden index", async () => {
    const { h, session, walletId } = await setup();
    expect(await accountMark(h, session, walletId)).toBe(0);
    // Hides the change output at /1/20 — exactly the mark-0 bound — then stores 20.
    const first = await sign(
      h,
      session,
      psbtRequest(walletId, "internal", [{ template: "btc.bip84" }], [
        { purpose: 84, change: 1, index: 20 },
      ]),
    );
    expect("err" in first).toBe(false);
    expect(await accountMark(h, session, walletId)).toBe(20);
    // With the mark at 20 an output at /1/40 is hidden too — and the mark follows to 40.
    const second = await sign(
      h,
      session,
      psbtRequest(walletId, "internal", [{ template: "btc.bip84", index: 1 }], [
        { purpose: 84, change: 1, index: 40 },
      ]),
    );
    expect("err" in second).toBe(false);
    expect(await accountMark(h, session, walletId)).toBe(40);
  });

  it("an internal change input raises the mark; an external input never does", async () => {
    const { h, session, walletId } = await setup();
    // External origin: the dusted /1/30 input cannot raise the bound — /1/50 stays shown.
    const external = await sign(
      h,
      session,
      psbtRequest(
        walletId,
        "external",
        [{ template: "btc.bip84" }, { template: "btc.bip84", change: 1, index: 30 }],
        [{ purpose: 84, change: 1, index: 50 }],
      ),
    );
    expect("err" in external).toBe(false);
    expect(await accountMark(h, session, walletId)).toBe(0);
    // Internal origin: the same input raises the bound past 30, /1/50 is hidden, mark lands at 50.
    const internal = await sign(
      h,
      session,
      psbtRequest(
        walletId,
        "internal",
        [{ template: "btc.bip84" }, { template: "btc.bip84", change: 1, index: 30 }],
        [{ purpose: 84, change: 1, index: 50 }],
      ),
    );
    expect("err" in internal).toBe(false);
    expect(await accountMark(h, session, walletId)).toBe(50);
  });

  it("the mark is per group index, purpose and network", async () => {
    const { h, session, walletId } = await setup();
    const signed = await sign(
      h,
      session,
      psbtRequest(walletId, "internal", [{ template: "btc.bip84" }], [
        { purpose: 84, change: 1, index: 20 },
      ]),
    );
    expect("err" in signed).toBe(false);
    expect(await accountMark(h, session, walletId)).toBe(20);
    expect(await accountMark(h, session, walletId, { groupIndex: 1 })).toBe(0);
    expect(await accountMark(h, session, walletId, { template: "btc.bip44" })).toBe(0);
    expect(await accountMark(h, session, walletId, { network: TESTNET })).toBe(0);
  });

  it("the mark survives a lock — it is sealed in the vault, not the session", async () => {
    const { h, session, walletId } = await setup();
    const signed = await sign(
      h,
      session,
      psbtRequest(walletId, "internal", [{ template: "btc.bip84" }], [
        { purpose: 84, change: 1, index: 20 },
      ]),
    );
    expect("err" in signed).toBe(false);
    h.advance(15 * 60_000 + 1);
    const unlocked = ok(await h.call("vault.unlock", { factor: PASSKEY() }));
    const next = strField(unlocked, "session");
    expect(await accountMark(h, next, walletId)).toBe(20);
  });

  it("a failed mark commit aborts the request before any signature exists", async () => {
    let fail = true;
    const { h, session, walletId } = await setup({
      wrapStore: (store) => ({
        load: () => store.load(),
        commit: async (ops) => {
          if (
            fail &&
            ops.some(
              (op) => op.op === "put-record" && op.record.kind === CHANGE_MARKS_KIND,
            )
          ) {
            throw new Error("store down");
          }
          return store.commit(ops);
        },
        watch: (listener) => store.watch(listener),
      }),
    });
    const refused = await sign(
      h,
      session,
      psbtRequest(walletId, "internal", [{ template: "btc.bip84" }], [
        { purpose: 84, change: 1, index: 20 },
      ]),
    );
    expect(errCode(refused)).toBe("unavailable");
    expect(await accountMark(h, session, walletId)).toBe(0);
    // The store heals — the same request then commits the mark and signs.
    fail = false;
    const retried = await sign(
      h,
      session,
      psbtRequest(walletId, "internal", [{ template: "btc.bip84" }], [
        { purpose: 84, change: 1, index: 20 },
      ]),
    );
    expect("err" in retried).toBe(false);
    expect(await accountMark(h, session, walletId)).toBe(20);
  });

  it("a signing aborted after the commit leaves the mark raised", async () => {
    /* The mark is raised the moment the user's intent is proven — before any signature exists.
       An abort later in the sign pass (here: the session expires while the commit is in flight,
       so the re-derived key material decrypts nothing) cannot un-raise it. That is safe: the
       mark only widens which own change outputs the wallet scans for, never what a request can
       hide — a signed transaction spending from a far change index is proof the wallet uses it. */
    let gate: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { h, session, walletId } = await setup({
      maxSessionMs: 60_000,
      wrapStore: (store) => ({
        load: () => store.load(),
        commit: async (ops) => {
          if (ops.some((op) => op.op === "put-record" && op.record.kind === CHANGE_MARKS_KIND)) {
            gate?.();
            await held;
          }
          return store.commit(ops);
        },
        watch: (listener) => store.watch(listener),
      }),
    });
    const pending = sign(
      h,
      session,
      psbtRequest(walletId, "internal", [{ template: "btc.bip84" }], [
        { purpose: 84, change: 1, index: 20 },
      ]),
    );
    await entered;
    h.advance(60_001);
    release?.();
    const response = await pending;
    expect("err" in response).toBe(true);
    const unlocked = ok(await h.call("vault.unlock", { factor: PASSKEY() }));
    const next = strField(unlocked, "session");
    expect(await accountMark(h, next, walletId)).toBe(20);
  });

  it("wallet.delete removes the marks record", async () => {
    const { h, session, walletId } = await setup();
    const signed = await sign(
      h,
      session,
      psbtRequest(walletId, "internal", [{ template: "btc.bip84" }], [
        { purpose: 84, change: 1, index: 20 },
      ]),
    );
    expect("err" in signed).toBe(false);
    expect(await marksRecord(h, walletId)).toBeDefined();
    ok(await h.call("wallet.delete", { walletId, verify: PASSKEY() }, session));
    expect(await marksRecord(h, walletId)).toBeUndefined();
  });

  const sessionDek = async (h: Harness): Promise<Secret> => {
    const image = await h.store.load();
    const factor = image.factors.find((f) => f.kind === "passkey");
    if (factor === undefined) {
      throw new Error("missing passkey factor");
    }
    const kek = passkeyKek(PRF_VAULT, CREDENTIAL_ID);
    try {
      return unwrapDek(kek, factor);
    } finally {
      wipe(kek);
    }
  };
  const sealer = { random: (n: number) => new Uint8Array(n).fill(3), now: () => 0 } as never;

  const forge = async (h: Harness, walletId: string, header: string): Promise<void> => {
    const dek = await sessionDek(h);
    try {
      const image = await h.store.load();
      const record = sealRecord(
        sealer,
        dek,
        CHANGE_MARKS_KIND,
        walletId,
        header,
        new Uint8Array([0x01]),
      );
      await h.store.commit(
        withManifest(sealer, image, [{ op: "put-record", record }], dek),
      );
    } finally {
      dek.wipe();
    }
    await h.settle();
  };

  it("a marks header naming another wallet latches the vault corrupted", async () => {
    const { h, session, walletId } = await setup();
    await forge(
      h,
      walletId,
      encodeChangeMarksHeader({
        walletId: "0000000000000000",
        marks: [{ groupIndex: 0, purpose: 84, network: BTC_NETWORK, index: 5 }],
      }),
    );
    const status = ok(await h.call("status", null, session)) as Record<string, ProtocolValue>;
    expect(status["vault"]).toBe("corrupted");
  });

  it("a tampered marks header — out of the canonical order — latches corrupted", async () => {
    const { h, session, walletId } = await setup();
    await forge(
      h,
      walletId,
      encodeChangeMarksHeader({
        walletId,
        marks: [
          { groupIndex: 1, purpose: 84, network: BTC_NETWORK, index: 5 },
          { groupIndex: 0, purpose: 84, network: BTC_NETWORK, index: 9 },
        ],
      }),
    );
    const status = ok(await h.call("status", null, session)) as Record<string, ProtocolValue>;
    expect(status["vault"]).toBe("corrupted");
  });

  it("mark lookups are monotone — a lower raise writes nothing", async () => {
    const commits: string[] = [];
    const { h, session, walletId } = await setup({
      wrapStore: (store) => ({
        load: () => store.load(),
        commit: async (ops) => {
          for (const op of ops) {
            if (op.op === "put-record" && op.record.kind === CHANGE_MARKS_KIND) {
              commits.push(op.record.header);
            }
          }
          return store.commit(ops);
        },
        watch: (listener) => store.watch(listener),
      }),
    });
    const first = await sign(
      h,
      session,
      psbtRequest(walletId, "internal", [{ template: "btc.bip84" }], [
        { purpose: 84, change: 1, index: 20 },
      ]),
    );
    expect("err" in first).toBe(false);
    expect(commits).toHaveLength(1);
    // A /1/5 change input under a mark of 20 proves nothing new — no record write, mark stays 20.
    const lower = await sign(
      h,
      session,
      psbtRequest(
        walletId,
        "internal",
        [{ template: "btc.bip84", index: 1 }, { template: "btc.bip84", change: 1, index: 5 }],
        [{ purpose: 84, change: 1, index: 10 }],
      ),
    );
    expect("err" in lower).toBe(false);
    expect(commits).toHaveLength(1);
    expect(await accountMark(h, session, walletId)).toBe(20);
  });
});
