/**
 * The hardware vault factor (React Native) against a fake platform keystore: establish, unlock,
 * every guarded command's prompt, cancellation and invalidation, the platform/kind gate, ceremony
 * serialization, reset, and the chain.sign rule that no seed outlives the prepare pass.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";
import { normalizeSolana } from "@qntx/wallet-chains/solana";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { chainPrompt } from "../src/modules/chains/prompt.ts";
import { sparkPrompt } from "../src/modules/spark/prompt.ts";
import type { Keystore, KeystorePrompt, Pbkdf2 } from "../src/platform.ts";
import { corePrompt } from "../src/prompts.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import type { RecordStore } from "../src/vault/store.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { subtlePbkdf2 } from "./helpers.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SOL_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const HARDWARE = { kind: "hardware" } as const;

type Call =
  | { readonly op: "seal" | "open"; readonly id: string; readonly prompt: KeystorePrompt }
  | { readonly op: "authenticate"; readonly prompt: KeystorePrompt }
  | { readonly op: "clear" };

type Outcome = "cancelled" | "factor-invalidated";

/**
 * An in-memory keystore: `seal` keeps the secret under its id and returns SHA-256(id) as the opaque
 * ciphertext; `open` checks both. `fail` scripts the next prompting call's rejection and `gate`
 * holds the next `open` until released.
 */
function fakeKeystore(locale = "en-US") {
  const keys = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  const failures: Outcome[] = [];
  let gate: Promise<void> | undefined;
  let onOpen: (() => void) | undefined;
  const reject = (): void => {
    const outcome = failures.shift();
    if (outcome !== undefined) {
      throw new KernelError(outcome, "scripted keystore failure");
    }
  };
  const keystore: Keystore = {
    locale,
    seal: async (id, secret, prompt) => {
      calls.push({ op: "seal", id, prompt });
      await Promise.resolve();
      reject();
      if (keys.has(id)) {
        throw new Error("duplicate key alias");
      }
      keys.set(id, new Uint8Array(secret));
      return sha256(utf8ToBytes(id));
    },
    open: async (id, sealed, prompt) => {
      calls.push({ op: "open", id, prompt });
      onOpen?.();
      const held = gate;
      gate = undefined;
      await (held ?? Promise.resolve());
      reject();
      const secret = keys.get(id);
      if (secret === undefined || !equalBytes(sealed, sha256(utf8ToBytes(id)))) {
        throw new KernelError("factor-invalidated", "no such key");
      }
      return new Uint8Array(secret);
    },
    authenticate: async (prompt) => {
      calls.push({ op: "authenticate", prompt });
      await Promise.resolve();
      reject();
    },
    clear: async () => {
      calls.push({ op: "clear" });
      await Promise.resolve();
      keys.clear();
    },
  };
  return {
    keystore,
    calls,
    keys,
    fail: (outcome: Outcome) => failures.push(outcome),
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    watchOpen: (fn: () => void) => {
      onOpen = fn;
    },
  };
}

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
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: HARDWARE }),
  );
  return { session: str(res, "session"), walletId: str(field(res, "wallet"), "walletId") };
}

const prompts = (calls: ReadonlyArray<Call>, op: Call["op"]): KeystorePrompt[] =>
  calls.flatMap((call) => (call.op === op && "prompt" in call ? [call.prompt] : []));

describe("hardware factor: establish and unlock", () => {
  it("clears leftover keys, seals the KEK under the factor id, and unlocks after a restart", async () => {
    const fake = fakeKeystore();
    fake.keys.set("stale", new Uint8Array(32));
    const store = createMemoryStore();
    const h = createHarness({ keystore: fake.keystore, store });
    await importHardware(h);
    expect(fake.calls.map((call) => call.op)).toStrictEqual(["clear", "seal"]);
    expect(prompts(fake.calls, "seal")).toStrictEqual([corePrompt("en", "create")]);
    const aliases = [...fake.keys.keys()];
    expect(aliases).toHaveLength(1);
    const status = ok(await h.call("status"));
    const factors = field(status, "factors") as ReadonlyArray<Record<string, ProtocolValue>>;
    expect(factors).toHaveLength(1);
    expect(factors[0]?.["kind"]).toBe("hardware");
    expect(factors[0]?.["id"]).toBe(aliases[0]);

    const restarted = createHarness({ keystore: fake.keystore, store });
    await restarted.settle();
    ok(await restarted.call("vault.unlock", { factor: HARDWARE }));
    expect(prompts(fake.calls, "open")).toStrictEqual([corePrompt("en", "unlock")]);
  });

  it("renders Chinese for any zh locale and English otherwise", async () => {
    for (const [locale, expected] of [
      ["zh-TW", "zh-Hans"],
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
    const draft = ok(await h.call("wallet.createMnemonic", { words: 12, factor: HARDWARE }));
    expect(fake.calls).toStrictEqual([]);
    ok(await h.call("wallet.discardMnemonic", { draft: str(draft, "draft") }));
    expect(fake.calls).toStrictEqual([]);

    const next = ok(await h.call("wallet.createMnemonic", { words: 12, factor: HARDWARE }));
    const words = new TextDecoder().decode(field(next, "words") as Uint8Array).split(" ");
    const quiz = field(next, "quiz") as number[];
    ok(
      await h.call("wallet.confirmMnemonic", {
        draft: str(next, "draft"),
        answers: quiz.map((position) => utf8ToBytes(String(words[position]))),
      }),
    );
    expect(fake.calls.map((call) => call.op)).toStrictEqual(["clear", "seal"]);
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
      factor: HARDWARE,
    });
    expect(errCode(res)).toBe("conflict");
    expect(fake.calls.map((call) => call.op)).toStrictEqual(["clear", "seal", "clear"]);
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
    expect(errCode(res)).toBe("factor-unavailable");
  });

  it("a host without a keystore refuses the hardware factor", async () => {
    const h = createHarness();
    await h.settle();
    const res = await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: HARDWARE,
    });
    expect(errCode(res)).toBe("factor-unavailable");
  });

  it("a second hardware factor is already-exists, before any prompt", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session } = await importHardware(h);
    const res = await h.call("vault.addFactor", { verify: HARDWARE, factor: HARDWARE }, session);
    expect(errCode(res)).toBe("already-exists");
    expect(prompts(fake.calls, "open")).toStrictEqual([]);
  });
});

describe("hardware factor: guarded commands", () => {
  it("each guarded command prompts once with its own text", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const derived = ok(await h.call("nostr.deriveKey", { walletId, groupIndex: 0 }, session));
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
      corePrompt("en", "export-key"),
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
    ).toBe("factor-invalidated");
    ok(await h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session));
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
    expect(prompts(fake.calls, "open")).toStrictEqual([chainPrompt("en", decodeEvm(request))]);
    expect(prompts(fake.calls, "open")[0]?.title).toBe("Confirm transfer");
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
      { title: "Confirm signature", description: "Sign a request from an app" },
    ]);
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
    expect(fake.keys.size).toBe(1);
  });
});
