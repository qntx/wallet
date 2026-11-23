/**
 * The hardware vault factor (React Native) against a fake platform keystore: establish, unlock,
 * every guarded command's prompt, cancellation and invalidation, the platform/kind gate, ceremony
 * serialization, reset, and the chain.sign rule that no seed outlives the prepare pass.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { NETWORK } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";
import { normalizeSolana } from "@qntx/wallet-chains/solana";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { chainPrompt } from "../src/modules/chains/prompt.ts";
import { sparkPrompt } from "../src/modules/spark/prompt.ts";
import type { KeystorePrompt, KernelPlatform, Pbkdf2 } from "../src/platform.ts";
import { serializeCeremonies } from "../src/platform.ts";
import { corePrompt } from "../src/prompts.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import type { RecordStore } from "../src/vault/store.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { subtlePbkdf2 } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SOL_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;

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

const str = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

async function importHardware(h: Harness): Promise<{ session: string; walletId: string }> {
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  return { session: str(res, "session"), walletId: str(field(res, "wallet"), "walletId") };
}

const prompts = (calls: ReadonlyArray<KeystoreCall>, op: "seal" | "open"): KeystorePrompt[] =>
  calls.flatMap((call) => (call.op === op && call.prompt !== undefined ? [call.prompt] : []));

describe("hardware factor: establish and unlock", () => {
  it("clears leftover keys, seals the KEK under the factor id, and unlocks after a restart", async () => {
    const fake = fakeKeystore();
    fake.keys.set("stale", new Uint8Array(32));
    const store = createMemoryStore();
    const h = createHarness({ keystore: fake.keystore, store });
    await importHardware(h);
    expect(fake.calls.map((call) => call.op)).toStrictEqual(["clear", "seal", "seal"]);
    expect(prompts(fake.calls, "seal")).toStrictEqual([corePrompt("en", "create")]);
    const aliases = [...fake.keys.keys()];
    expect(aliases).toHaveLength(2);
    const status = ok(await h.call("status"));
    const factors = field(status, "factors") as ReadonlyArray<Record<string, ProtocolValue>>;
    expect(factors.map((factor) => factor["kind"])).toStrictEqual(["device", "hardware"]);
    expect(factors.map((factor) => factor["id"])).toStrictEqual(aliases);

    const restarted = createHarness({ keystore: fake.keystore, store });
    await restarted.settle();
    ok(await restarted.call("vault.unlock", { factor: HARDWARE }));
    expect(prompts(fake.calls, "open")).toStrictEqual([corePrompt("en", "unlock")]);
  });

  it("renders Chinese for any zh locale and English otherwise", async () => {
    for (const [locale, expected] of [
      ["zh-TW", "en"],
      ["zh-Hans-CN", "zh-Hans"],
      ["fr-FR", "en"],
    ] as const) {
      const fake = fakeKeystore(locale);
      // oxlint-disable-next-line eslint/no-await-in-loop -- one kernel per locale, sequentially
      await importHardware(createHarness({ keystore: fake.keystore }));
      expect(prompts(fake.calls, "seal")).toStrictEqual([corePrompt(expected, "create")]);
    }
  });

  it("a mnemonic draft creates its key only at confirm; a discarded draft leaves none", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    const draft = ok(await h.call("wallet.createMnemonic", { words: 12, factor: DEVICE }));
    expect(fake.calls).toStrictEqual([]);
    ok(await h.call("wallet.discardMnemonic", { draft: str(draft, "draft") }));
    expect(fake.calls).toStrictEqual([]);

    const next = ok(await h.call("wallet.createMnemonic", { words: 12, factor: DEVICE }));
    const words = new TextDecoder().decode(field(next, "words") as Uint8Array).split(" ");
    const quiz = field(next, "quiz") as number[];
    ok(
      await h.call("wallet.confirmMnemonic", {
        draft: str(next, "draft"),
        answers: quiz.map((position) => utf8ToBytes(String(words[position]))),
      }),
    );
    expect(fake.calls.map((call) => call.op)).toStrictEqual(["clear", "seal", "seal"]);
  });

  it("clears the new key when the establish commit fails, surfacing the commit error", async () => {
    const fake = fakeKeystore();
    const inner = createMemoryStore();
    const failing: RecordStore = {
      load: async () => inner.load(),
      watch: (listener) => inner.watch(listener),
      commit: async () => {
        await Promise.resolve();
        throw new KernelError("conflict", "injected");
      },
    };
    const h = createHarness({ keystore: fake.keystore, store: failing });
    await h.settle();
    const res = await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: DEVICE,
    });
    expect(errCode(res)).toBe("conflict");
    expect(fake.calls.map((call) => call.op)).toStrictEqual(["clear", "seal", "seal", "clear"]);
    expect(fake.keys.size).toBe(0);
  });
});

describe("hardware factor: platform gate", () => {
  it("a keystore host refuses password and passkey factors", async () => {
    const h = createHarness({ keystore: fakeKeystore().keystore });
    await h.settle();
    const res = await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: { kind: "password", password: utf8ToBytes("correct horse battery") },
    });
    expect(errCode(res)).toBe("unsupported");
  });

  it("a host without a keystore refuses keystore factors", async () => {
    const h = createHarness();
    await h.settle();
    for (const factor of [HARDWARE, DEVICE]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential protocol calls
      const res = await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor,
      });
      expect(errCode(res)).toBe("unsupported");
    }
  });

  it("a keystore host refuses a hardware factor as the establishing factor", async () => {
    const h = createHarness({ keystore: fakeKeystore().keystore });
    await h.settle();
    const res = await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: HARDWARE,
    });
    expect(errCode(res)).toBe("unsupported");
  });

  it("factor management is unsupported on a keystore host, before any prompt", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session } = await importHardware(h);
    const res = await h.call("vault.addFactor", { verify: HARDWARE, factor: HARDWARE }, session);
    expect(errCode(res)).toBe("unsupported");
    expect(prompts(fake.calls, "open")).toStrictEqual([]);
  });
});

describe("hardware factor: guarded commands", () => {
  it("each guarded command prompts once with its own text", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const derived = ok(await h.call("nostr.deriveKey", { walletId, index: 0 }, session));
    const publicKey = str(derived, "publicKey");
    ok(await h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session));
    ok(
      await h.call(
        "nostr.exportKey",
        { publicKey, format: { kind: "nsec" }, verify: HARDWARE },
        session,
      ),
    );
    ok(await h.call("wallet.delete", { verify: HARDWARE, walletId }, session));
    expect(prompts(fake.calls, "open")).toStrictEqual([
      corePrompt("en", "export-mnemonic"),
      corePrompt("en", "export-private-key"),
      corePrompt("en", "delete-wallet"),
    ]);
  });

  it("cancel and invalidation surface as their codes and keep the session", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    fake.fail("cancelled");
    expect(
      errCode(await h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session)),
    ).toBe("cancelled");
    fake.fail("factor-invalidated");
    expect(
      errCode(await h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session)),
    ).toBe("verification-unavailable");
    fake.fail("verification-unavailable");
    expect(
      errCode(await h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session)),
    ).toBe("verification-unavailable");
  });

  it("a cancelled unlock leaves the vault locked", async () => {
    const fake = fakeKeystore();
    const store = createMemoryStore();
    await importHardware(createHarness({ keystore: fake.keystore, store }));
    const restarted = createHarness({ keystore: fake.keystore, store });
    await restarted.settle();
    fake.fail("cancelled");
    expect(errCode(await restarted.call("vault.unlock", { factor: HARDWARE }))).toBe("cancelled");
    expect(field(ok(await restarted.call("status")), "vault")).toBe("locked");
  });

  it("runs one ceremony at a time; a rejected one does not block the next", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const release = fake.hold();
    fake.fail("cancelled");
    const first = h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session);
    const second = h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session);
    await h.settle();
    expect(prompts(fake.calls, "open")).toHaveLength(1);
    release();
    expect(errCode(await first)).toBe("cancelled");
    ok(await second);
    expect(prompts(fake.calls, "open")).toHaveLength(2);
  });
});

describe("hardware factor: chain.sign", () => {
  const seeds: Uint8Array[] = [];
  const spyPbkdf2: Pbkdf2 = async (hash, password, salt, iterations, length) => {
    const out = await subtlePbkdf2(hash, password, salt, iterations, length);
    if (hash === "sha512") {
      seeds.push(out);
    }
    return out;
  };

  it("prompts with the kernel's decode after every seed of the prepare pass is wiped", async () => {
    seeds.length = 0;
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore, pbkdf2: spyPbkdf2 });
    const { session, walletId } = await importHardware(h);
    let wipedAtPrompt: boolean | undefined;
    fake.watchOpen(() => {
      wipedAtPrompt = seeds.every((seed) => seed.every((byte) => byte === 0));
    });
    const request = normalizeEvm({
      kind: "evm.transaction",
      network: "eip155:1",
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0xb1a2bc2ec50000",
        data: "0x",
        to: "0x00000000000000000000000000000000deadbeef",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    });
    ok(await h.call("chain.sign", { request, verify: HARDWARE }, session));
    expect(wipedAtPrompt).toBe(true);
    expect(prompts(fake.calls, "open")).toStrictEqual([
      chainPrompt("en", decodeEvm(request, SIGNER)),
    ]);
    expect(prompts(fake.calls, "open")[0]?.title).toBe("Confirm transfer");
  });

  it("binds own outputs across templates in the prompt; a forged derivation stays an outflow", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
    const MASTER_FP = 0x73c5da0a;
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    const pub84 = master.derive("m/84'/0'/0'/0/0").publicKey!;
    const xonly86 = master.derive("m/86'/0'/0'/0/0").publicKey!.slice(1);
    const ordScript = p2tr(xonly86).script;
    const ordAddress = p2tr(xonly86).address;
    const payeeScript = OutScript.encode(
      Address(NETWORK).decode("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"),
    );

    const psbt = (tapPath: number[]): Uint8Array => {
      const tx = new Transaction({ version: 2 });
      const prev = new Transaction({ version: 2 });
      prev.addInput({ txid: new Uint8Array(32).fill(7), index: 0, sequence: 0xffffffff });
      prev.addOutput({ script: p2wpkh(pub84).script, amount: 100000n });
      tx.addInput({
        txid: prev.id,
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script: p2wpkh(pub84).script, amount: 100000n },
        nonWitnessUtxo: prev.toBytes(true, false),
        bip32Derivation: [
          [pub84, { fingerprint: MASTER_FP, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] }],
        ],
      });
      tx.addOutput({ script: payeeScript, amount: 80000n });
      tx.addOutput({ script: ordScript, amount: 10000n });
      tx.updateOutput(1, {
        tapInternalKey: xonly86,
        tapBip32Derivation: [
          [xonly86, { hashes: [], der: { fingerprint: MASTER_FP, path: tapPath } }],
        ],
      });
      return tx.toPSBT(0);
    };
    const requestFor = (bytes: Uint8Array) =>
      normalizeBitcoin({
        kind: "bitcoin.psbt",
        network: BTC_NETWORK,
        account: { kind: "hd", walletId, groupIndex: 0 },
        psbt: bytes,
        sign: [{ index: 0, template: "btc.bip84" }],
      });

    // The correct tap derivation at the group's own index binds the ordinals output as ours.
    ok(
      await h.call(
        "chain.sign",
        {
          request: requestFor(psbt([0x80000056, 0x80000000, 0x80000000, 0, 0])),
          verify: HARDWARE,
        },
        session,
      ),
    );
    const bound = prompts(fake.calls, "open").at(-1);
    expect(bound?.description).not.toContain(ordAddress);
    expect(bound?.description).toContain("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");

    // A derivation naming another index cannot bind the output: it stays a prompt outflow.
    ok(
      await h.call(
        "chain.sign",
        {
          request: requestFor(psbt([0x80000056, 0x80000000, 0x80000000, 0, 5])),
          verify: HARDWARE,
        },
        session,
      ),
    );
    const forged = prompts(fake.calls, "open").at(-1);
    expect(forged?.description).toContain(ordAddress);
  });

  const evmRequest = (walletId: string) =>
    normalizeEvm({
      kind: "evm.transaction",
      network: "eip155:1",
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0x1",
        data: "0x",
        to: "0x00000000000000000000000000000000deadbeef",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    });

  it("a factor that does not open the vault produces no signature", async () => {
    seeds.length = 0;
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore, pbkdf2: spyPbkdf2 });
    const { session, walletId } = await importHardware(h);
    const before = seeds.length;
    // The keystore returns a KEK for some other vault: verification must fail, not sign.
    for (const alias of fake.keys.keys()) {
      fake.keys.set(alias, new Uint8Array(32).fill(9));
    }
    const response = await h.call(
      "chain.sign",
      { request: evmRequest(walletId), verify: HARDWARE },
      session,
    );
    expect(errCode(response)).toBe("integrity");
    expect("ok" in response).toBe(false);
    expect(seeds.length - before).toBe(1);
  });

  it("a session that ends during the prompt fails locked without signing", async () => {
    seeds.length = 0;
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore, pbkdf2: spyPbkdf2, maxSessionMs: 60_000 });
    const { session, walletId } = await importHardware(h);
    const before = seeds.length;
    const release = fake.hold();
    const prompted = new Promise<void>((resolve) => {
      fake.watchOpen(resolve);
    });
    const pending = h.call(
      "chain.sign",
      { request: evmRequest(walletId), verify: HARDWARE },
      session,
    );
    await prompted;
    h.advance(60_001);
    release();
    const response = await pending;
    expect(errCode(response)).toBe("locked");
    expect(seeds.length - before).toBe(1);
    expect(field(ok(await h.call("status")), "vault")).toBe("locked");
  });

  it("a cancelled prompt never reaches the sign pass", async () => {
    seeds.length = 0;
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore, pbkdf2: spyPbkdf2 });
    const { session, walletId } = await importHardware(h);
    const before = seeds.length;
    fake.fail("cancelled");
    const request = normalizeSolana(
      {
        kind: "solana.message",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
        message: utf8ToBytes("hello"),
        format: "raw",
      },
      SOL_ADDRESS,
    );
    expect(errCode(await h.call("chain.sign", { request, verify: HARDWARE }, session))).toBe(
      "cancelled",
    );
    expect(seeds.length - before).toBe(1);
    expect(prompts(fake.calls, "open")).toStrictEqual([
      { title: "Confirm signature", description: "Message:\n· hello" },
    ]);
  });
});

describe("blind signing policy", () => {
  /* Opaque bytes the decoder cannot show: blind "message-bytes". */
  const blindRequest = (walletId: string) =>
    normalizeEvm({
      kind: "evm.personal-message",
      network: "eip155:1",
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      message: new Uint8Array(32).fill(0xff),
    });
  const textRequest = (walletId: string) =>
    normalizeEvm({
      kind: "evm.personal-message",
      network: "eip155:1",
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      message: utf8ToBytes("hello"),
    });
  const blindSigning = async (h: Harness): Promise<ProtocolValue> =>
    field(ok(await h.call("status")), "blindSigning");
  const signResult = async (h: Harness, session: string, request: unknown): Promise<string> =>
    errCode(await h.call("chain.sign", { request, verify: HARDWARE }, session)) ?? "signed";

  it("is off on a new vault and refuses a blind request before any prompt", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    await expect(blindSigning(h)).resolves.toBe(false);
    const opened = prompts(fake.calls, "open").length;
    const response = await h.call(
      "chain.sign",
      { request: blindRequest(walletId), verify: HARDWARE },
      session,
    );
    expect(errCode(response)).toBe("blind-signing-disabled");
    expect(prompts(fake.calls, "open")).toHaveLength(opened);
  });

  it("signs content it can show while blind signing is off", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    await expect(signResult(h, session, textRequest(walletId))).resolves.toBe("signed");
  });

  it("turns on and off only after a verification, and survives a restart", async () => {
    const fake = fakeKeystore();
    const store = createMemoryStore();
    const h = createHarness({ keystore: fake.keystore, store });
    const { session, walletId } = await importHardware(h);
    const sign = async (on: Harness, at: string) =>
      on.call("chain.sign", { request: blindRequest(walletId), verify: HARDWARE }, at);

    fake.fail("cancelled");
    expect(
      errCode(await h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, session)),
    ).toBe("cancelled");
    await expect(blindSigning(h)).resolves.toBe(false);

    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, session));
    expect(prompts(fake.calls, "open").at(-1)).toStrictEqual(
      corePrompt("en", "enable-blind-signing"),
    );
    await expect(blindSigning(h)).resolves.toBe(true);
    ok(await sign(h, session));

    const before = prompts(fake.calls, "open").length;
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, session));
    expect(prompts(fake.calls, "open")).toHaveLength(before);

    const restarted = createHarness({ keystore: fake.keystore, store });
    await restarted.settle();
    const again = str(ok(await restarted.call("vault.unlock", { factor: DEVICE })), "session");
    await expect(blindSigning(restarted)).resolves.toBe(true);
    ok(await restarted.call("vault.setBlindSigning", { enabled: false, verify: HARDWARE }, again));
    expect(prompts(fake.calls, "open").at(-1)).toStrictEqual(
      corePrompt("en", "disable-blind-signing"),
    );
    await expect(blindSigning(restarted)).resolves.toBe(false);
    expect(errCode(await sign(restarted, again))).toBe("blind-signing-disabled");
  });

  it("a policy row that was not sealed by this vault is not consent", async () => {
    const fake = fakeKeystore();
    const store = createMemoryStore();
    const h = createHarness({ keystore: fake.keystore, store });
    const { session, walletId } = await importHardware(h);
    await store.commit([
      {
        op: "put-record",
        record: {
          kind: "policy",
          id: "blind-signing",
          header: JSON.stringify({ createdAt: 0 }),
          sealed: new Uint8Array(64),
        },
      },
    ]);
    const response = await h.call(
      "chain.sign",
      { request: blindRequest(walletId), verify: HARDWARE },
      session,
    );
    expect(errCode(response)).toBe("integrity");
    expect(prompts(fake.calls, "open").some((p) => p.title === "Confirm blind signing")).toBe(
      false,
    );
  });
});

describe("hardware factor: spark.approve", () => {
  const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
  const address = p2wpkh(new Uint8Array(33).fill(2), REGTEST).address ?? "";

  it("decodes before prompting: a malformed intent never reaches the keystore", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const res = await h.call(
      "spark.approve",
      {
        account: { walletId, groupIndex: 0, network: "regtest" },
        intent: { kind: "onchain", address: "not-an-address", maxFeeSats: 500 },
        verify: HARDWARE,
      },
      session,
    );
    expect(errCode(res)).toBe("invalid-input");
    expect(prompts(fake.calls, "open")).toStrictEqual([]);
  });

  it("prompts with the decoded summary", async () => {
    const fake = fakeKeystore("zh-CN");
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    ok(
      await h.call(
        "spark.approve",
        {
          account: { walletId, groupIndex: 0, network: "regtest" },
          intent: { kind: "onchain", address, maxFeeSats: 500 },
          verify: HARDWARE,
        },
        session,
      ),
    );
    expect(prompts(fake.calls, "open")).toStrictEqual([
      sparkPrompt("zh-Hans", { kind: "onchain", address, maxFeeSats: 500 }),
    ]);
  });
});

describe("hardware factor: reset", () => {
  it("authenticates the device owner, clears the store, then the keys", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session } = await importHardware(h);
    fake.calls.length = 0;
    ok(await h.call("vault.reset", null, session));
    expect(fake.calls).toStrictEqual([
      { op: "authenticate", prompt: corePrompt("en", "reset") },
      { op: "clear" },
    ]);
    expect(field(ok(await h.call("status")), "vault")).toBe("uninitialized");
  });

  it("a cancelled owner check leaves the vault untouched", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session } = await importHardware(h);
    fake.fail("cancelled");
    expect(errCode(await h.call("vault.reset", null, session))).toBe("cancelled");
    expect(field(ok(await h.call("status")), "vault")).toBe("unlocked");
    expect(fake.keys.size).toBe(2);
  });
});

describe("serializeCeremonies", () => {
  it("emits ceremony true then false around a keystore prompt, in order, also when it rejects", async () => {
    const events: boolean[] = [];
    const fake = fakeKeystore();
    const release = fake.hold();
    const platform = serializeCeremonies(
      // Only keystore/passkey are read — the rest of the platform is unused here.
      { keystore: fake.keystore, passkey: undefined } as KernelPlatform,
      (active) => events.push(active),
    );
    const prompt = { title: "t", description: "d" };
    const presence = { protection: "presence", prompt } as const;
    // Sealed through the raw keystore so no ceremony fires before the assertions start.
    const sealed = await fake.keystore.seal("id", new Uint8Array(8), presence);
    const open = platform.keystore!.open("id", sealed, presence);
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(events).toStrictEqual([true]);
    release();
    await expect(open).resolves.toBeInstanceOf(Uint8Array);
    expect(events).toStrictEqual([true, false]);

    fake.fail("cancelled");
    await expect(platform.keystore!.open("id", sealed, presence)).rejects.toThrow(KernelError);
    expect(events).toStrictEqual([true, false, true, false]);
  });

  it("serializes ceremonies queued behind a held prompt", async () => {
    const events: boolean[] = [];
    const fake = fakeKeystore();
    const release = fake.hold();
    const platform = serializeCeremonies(
      { keystore: fake.keystore, passkey: undefined } as KernelPlatform,
      (active) => events.push(active),
    );
    const prompt = { title: "t", description: "d" };
    const presence = { protection: "presence", prompt } as const;
    const sealed = await fake.keystore.seal("a", new Uint8Array(8), presence);
    const first = platform.keystore!.open("a", sealed, presence);
    const second = platform.keystore!.authenticate(prompt);
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    // The second ceremony waits in the queue — only the first has announced itself.
    expect(events).toStrictEqual([true]);
    release();
    await expect(first).resolves.toBeInstanceOf(Uint8Array);
    await expect(second).resolves.toBeUndefined();
    expect(events).toStrictEqual([true, false, true, false]);
  });
});
