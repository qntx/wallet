/**
 * `chain.exportAccount` through the real protocol: vector-consistent public material for HD and
 * hardware wallets, the verify factor consumed like chain.sign consumes it, and every guard — node
 * validation, network rules, imported-key refusal, unpinned device paths.
 */
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { VaultAnchor } from "../src/platform.ts";
import { PROMPT_BOUNDS, promptFits } from "../src/prompts.ts";
import { decodeAnchor } from "../src/vault/anchor.ts";
import { createHarness, detachTransferables } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";

type VectorKey = {
  node: Record<string, unknown>;
  groupIndex: number;
  path: string;
  curve: string;
  publicKey: string;
  chainCode?: string;
  parentFingerprint?: string;
  xpub?: string;
};
const vectors = loadVectors("chains/export-account.json") as {
  wallets: ReadonlyArray<{ mnemonic: string; fingerprint: string; keys: VectorKey[] }>;
};
const syncVectors = loadVectors("keystone/sync.json") as { sync: { cbor: string } };
const SYNC = hexToBytes(syncVectors.sync.cbor);

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
const PASSKEY = () => ({ kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF) });
const MAINNET = "bip122:000000000019d6689c085ae165831e93";
const TESTNET = "bip122:00000000da84f2bafbbc53dee25a72ae";

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
const strField = (v: ProtocolValue, k: string): string => field(v, k) as string;

type Node = Record<string, unknown>;
const exportAccount = async (
  h: Harness,
  session: string,
  params: { walletId: string; groupIndex: number; nodes: ReadonlyArray<Node>; verify?: unknown },
) =>
  h.call(
    "chain.exportAccount",
    params.verify === undefined ? { ...params, verify: PASSKEY() } : params,
    session,
  );

const keysOf = (response: KernelResponse): ReadonlyArray<Record<string, unknown>> =>
  field(ok(response), "keys") as unknown as ReadonlyArray<Record<string, unknown>>;

const expectKey = (key: Record<string, unknown>, wanted: VectorKey): void => {
  expect(key["node"]).toStrictEqual(wanted.node);
  expect(key["path"]).toBe(wanted.path);
  expect(key["curve"]).toBe(wanted.curve);
  expect(bytesToHex(key["publicKey"] as Uint8Array)).toBe(wanted.publicKey);
  if (wanted.chainCode === undefined) {
    expect(Object.hasOwn(key, "chainCode")).toBe(false);
    expect(Object.hasOwn(key, "parentFingerprint")).toBe(false);
  } else {
    expect(bytesToHex(key["chainCode"] as Uint8Array)).toBe(wanted.chainCode);
    expect(key["parentFingerprint"]).toBe(wanted.parentFingerprint);
  }
};

/** An anchor view that holds the counter-clearing CAS until released — the post-verify window. */
const holdCounterClear = (): {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly wrap: (inner: VaultAnchor) => VaultAnchor;
} => {
  let notify: () => void = () => undefined;
  let open: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const clears = (next: Uint8Array, expected: Uint8Array | undefined): boolean =>
    expected !== undefined &&
    decodeAnchor(expected).failedAttempts !== 0 &&
    decodeAnchor(next).failedAttempts === 0;
  return {
    entered,
    release: () => open(),
    wrap: (inner) => ({
      ...inner,
      replace: async (next, expected) => {
        if (clears(next, expected)) {
          notify();
          await gate;
        }
        return inner.replace(next, expected);
      },
    }),
  };
};

describe("chain.exportAccount", () => {
  const setup = async (mnemonic: string) => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(mnemonic),
        factor: PASSKEY(),
      }),
    );
    return {
      h,
      session: strField(res, "session"),
      walletId: strField(field(res, "wallet"), "walletId"),
    };
  };

  it("exports every node kind matching the independent vectors", async () => {
    for (const wallet of vectors.wallets) {
      // oxlint-disable-next-line no-await-in-loop -- each wallet is imported into its own harness
      const { h, session, walletId } = await setup(wallet.mnemonic);
      const wanted = (g: number) => wallet.keys.filter((k) => k.groupIndex === g);
      for (const groupIndex of [0, 1]) {
        const rows = wanted(groupIndex);
        // 1..4 nodes per call: split the account and leaf sets into verified calls.
        for (const slice of [rows.slice(0, 4), rows.slice(4)].filter((s) => s.length > 0)) {
          // oxlint-disable-next-line no-await-in-loop -- one verified call per slice, in order
          const res = await exportAccount(h, session, {
            walletId,
            groupIndex,
            nodes: slice.map((r) => r.node),
          });
          expect(strField(ok(res), "fingerprint")).toBe(wallet.fingerprint);
          const keys = keysOf(res);
          expect(keys).toHaveLength(slice.length);
          for (const [i, row] of slice.entries()) {
            expectKey(keys[i]!, row);
          }
        }
      }
    }
  });

  it("answers keys in request order", async () => {
    const { h, session, walletId } = await setup(vectors.wallets[0]!.mnemonic);
    const nodes = [
      { kind: "leaf", template: "solana.bip44-change" },
      { kind: "leaf", template: "evm.bip44" },
      { kind: "leaf", template: "tron.bip44" },
    ];
    const keys = keysOf(await exportAccount(h, session, { walletId, groupIndex: 0, nodes }));
    for (const [i, node] of nodes.entries()) {
      expect(keys[i]!["node"]).toStrictEqual(node);
    }
    expect(keys[0]!["curve"]).toBe("ed25519");
    expect(keys[1]!["path"]).toBe("m/44'/60'/0'/0/0");
    expect(keys[2]!["path"]).toBe("m/44'/195'/0'/0/0");
  });

  it("derives the well-known Hardhat address from the exported leaf", async () => {
    const { h, session, walletId } = await setup(vectors.wallets[1]!.mnemonic);
    const keys = keysOf(
      await exportAccount(h, session, {
        walletId,
        groupIndex: 0,
        nodes: [{ kind: "leaf", template: "evm.bip44" }],
      }),
    );
    // https://hardhat.org/hardhat-network/docs/reference#initial-state — test…junk m/44'/60'/0'/0/0.
    expect(evmAddressFromPublicKey(keys[0]!["publicKey"] as Uint8Array)).toBe(
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    );
  });

  it("requires the verify factor and returns nothing on a wrong factor", async () => {
    const { h, session, walletId } = await setup(vectors.wallets[0]!.mnemonic);
    const nodes = [{ kind: "leaf", template: "evm.bip44" }];
    const base = { walletId, groupIndex: 0, nodes };
    const missing = await h.call("chain.exportAccount", base, session);
    expect("err" in missing).toBe(true);
    const wrong = await exportAccount(h, session, {
      ...base,
      verify: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(32).fill(9) },
    });
    expect(errCode(wrong)).toBe("wrong-passkey");
    expect("ok" in wrong).toBe(false);
    const device = await exportAccount(h, session, {
      ...base,
      verify: { kind: "device" },
    });
    expect("err" in device).toBe(true);
  });

  it("a session that ends during the prompt fails locked without exporting", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore, maxSessionMs: 60_000 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.wallets[0]!.mnemonic),
        factor: { kind: "device" },
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    const release = fake.hold();
    const prompted = new Promise<void>((resolve) => {
      fake.watchOpen(resolve);
    });
    const pending = h.call(
      "chain.exportAccount",
      {
        walletId,
        groupIndex: 0,
        nodes: [{ kind: "leaf", template: "evm.bip44" }],
        verify: { kind: "hardware" },
      },
      session,
    );
    await prompted;
    h.advance(60_001);
    release();
    const response = await pending;
    expect(errCode(response)).toBe("locked");
    expect("ok" in response).toBe(false);
  });

  it("a session that ends during the post-verification write fails locked", async () => {
    /* For a password factor verifyFactor clears a nonzero failure count with an anchor CAS
       AFTER its wiped-DEK check: holding that write leaves a real await window in which the
       session can end. Without the post-verification `session.require`, the export pass would
       then open a wiped DEK and fail "integrity". */
    const gate = holdCounterClear();
    const h = createHarness({ maxSessionMs: 60_000, wrapAnchor: gate.wrap });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.wallets[0]!.mnemonic),
        factor: { kind: "password", password: utf8ToBytes("correct horse battery staple") },
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    const exportParams = (password: string) => ({
      walletId,
      groupIndex: 0,
      nodes: [{ kind: "leaf", template: "evm.bip44" }],
      verify: { kind: "password", password: utf8ToBytes(password) },
    });
    const wrong = await h.call("chain.exportAccount", exportParams("a wrong password"), session);
    expect(errCode(wrong)).toBe("wrong-password");
    const pending = h.call(
      "chain.exportAccount",
      exportParams("correct horse battery staple"),
      session,
    );
    await gate.entered;
    h.advance(60_001);
    gate.release();
    const response = await pending;
    expect(errCode(response)).toBe("locked");
    expect("ok" in response).toBe(false);
  });

  it("refuses duplicate, empty and oversized node lists", async () => {
    const { h, session, walletId } = await setup(vectors.wallets[0]!.mnemonic);
    const leaf = { kind: "leaf", template: "evm.bip44" };
    // Empty and oversized lists never reach the handler: the params validator rejects them.
    for (const nodes of [[], [leaf, leaf, leaf, leaf, leaf]]) {
      // oxlint-disable-next-line no-await-in-loop -- cases run sequentially
      const res = await exportAccount(h, session, { walletId, groupIndex: 0, nodes });
      expect(errCode(res)).toBe("integrity");
    }
    const res = await exportAccount(h, session, {
      walletId,
      groupIndex: 0,
      nodes: [leaf, { kind: "leaf", template: "evm.bip44" }],
    });
    expect(errCode(res)).toBe("invalid-input");
  });

  it("refuses a malformed network", async () => {
    const { h, session, walletId } = await setup(vectors.wallets[0]!.mnemonic);
    const node = (network: string) => ({
      kind: "btc.account",
      template: "btc.bip84",
      network,
    });
    for (const network of [
      "eip155:1",
      "bip122:unknown",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- cases run sequentially
      const res = await exportAccount(h, session, {
        walletId,
        groupIndex: 0,
        nodes: [node(network)],
      });
      expect(errCode(res)).toBe("invalid-input");
    }
    const res = await exportAccount(h, session, {
      walletId,
      groupIndex: 0,
      nodes: [node(TESTNET)],
    });
    expect("ok" in res).toBe(true);
  });

  it("refuses an imported-key record", async () => {
    const { h, session } = await setup(vectors.wallets[0]!.mnemonic);
    const imported = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(32).fill(3) }, session),
    );
    const keyId = strField(imported, "keyId");
    const res = await exportAccount(h, session, {
      walletId: keyId,
      groupIndex: 0,
      nodes: [{ kind: "leaf", template: "evm.bip44" }],
    });
    expect(errCode(res)).toBe("invalid-input");
  });

  it("refuses an unknown wallet", async () => {
    const { h, session } = await setup(vectors.wallets[0]!.mnemonic);
    const res = await exportAccount(h, session, {
      walletId: "ff".repeat(8),
      groupIndex: 0,
      nodes: [{ kind: "leaf", template: "evm.bip44" }],
    });
    expect(errCode(res)).toBe("not-found");
  });

  it("serves a hardware wallet's pinned material without a device exchange", async () => {
    const { h, session } = await setup(vectors.wallets[0]!.mnemonic);
    const begin = ok(
      await h.call("hardware.begin", { op: { kind: "pair", device: "keystone" } }, session),
    );
    const done = ok(
      await h.call(
        "hardware.step",
        {
          opId: strField(begin, "opId"),
          response: { kind: "qr", ur: { type: "crypto-multi-accounts", cbor: SYNC } },
        },
        session,
      ),
    );
    const walletId = strField(field(field(done, "result"), "wallet"), "walletId");
    const wallet = vectors.wallets[0]!;
    // The Keystone pin is the same abandon…about seed: pinned keys answer with the vector values.
    const nodes = [
      { kind: "evm.account" },
      { kind: "leaf", template: "evm.bip44" },
      { kind: "leaf", template: "tron.bip44" },
      { kind: "leaf", template: "solana.bip44-change" },
    ];
    const res = await exportAccount(h, session, { walletId, groupIndex: 0, nodes });
    expect(strField(ok(res), "fingerprint")).toBe("73c5da0a");
    const keys = keysOf(res);
    const byPath = new Map(wallet.keys.map((k) => [k.path, k]));
    for (const key of keys) {
      expectKey(key, byPath.get(key["path"] as string)!);
    }
    const btc = await exportAccount(h, session, {
      walletId,
      groupIndex: 0,
      nodes: [{ kind: "btc.account", template: "btc.bip84", network: MAINNET }],
    });
    expectKey(keysOf(btc)[0]!, byPath.get("m/84'/0'/0'")!);
    // Anything the pin cannot serve surfaces as device-required — never a device exchange.
    const unpinned = await exportAccount(h, session, {
      walletId,
      groupIndex: 1,
      nodes: [{ kind: "btc.account", template: "btc.bip84", network: MAINNET }],
    });
    expect(errCode(unpinned)).toBe("device-required");
    const solana = await exportAccount(h, session, {
      walletId,
      groupIndex: 1,
      nodes: [{ kind: "leaf", template: "solana.bip44-change" }],
    });
    expect(errCode(solana)).toBe("device-required");
  });

  it("serves repeated exports and account reads from an intact pin", async () => {
    const { h, session } = await setup(vectors.wallets[0]!.mnemonic);
    const begin = ok(
      await h.call("hardware.begin", { op: { kind: "pair", device: "keystone" } }, session),
    );
    const done = ok(
      await h.call(
        "hardware.step",
        {
          opId: strField(begin, "opId"),
          response: { kind: "qr", ur: { type: "crypto-multi-accounts", cbor: SYNC } },
        },
        session,
      ),
    );
    const walletId = strField(field(field(done, "result"), "wallet"), "walletId");
    const wallet = vectors.wallets[0]!;
    const nodes = [
      { kind: "evm.account" },
      { kind: "leaf", template: "evm.bip44" },
      { kind: "leaf", template: "solana.bip44-change" },
    ];
    const first = await exportAccount(h, session, { walletId, groupIndex: 0, nodes });
    /* A real port detaches every exact-view buffer the reply carries — the pin must keep its
       own arrays or the next read sees zeroed keys. */
    detachTransferables(first);
    const second = keysOf(
      await exportAccount(h, session, { walletId, groupIndex: 0, nodes }),
    );
    const byPath = new Map(wallet.keys.map((k) => [k.path, k]));
    for (const key of second) {
      expectKey(key, byPath.get(key["path"] as string)!);
    }
    detachTransferables(second);
    const accounts = ok(
      await h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "btc.bip84", network: MAINNET },
        session,
      ),
    );
    expect(strField(accounts, "fingerprint")).toBe("73c5da0a");
    expect(strField(accounts, "path")).toBe("m/84'/0'/0'");
  });
});

describe("the export prompt names every node it shares", () => {
  const keystoreSetup = async (platform: "ios" | "android", locale: string) => {
    const fake = fakeKeystore(locale, platform);
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.wallets[0]!.mnemonic),
        factor: { kind: "device" },
      }),
    );
    return {
      fake,
      h,
      session: strField(res, "session"),
      walletId: strField(field(res, "wallet"), "walletId"),
    };
  };

  /** The prompt the verifying `open` was shown — the last presence call carries it. */
  const shownPrompt = (
    fake: ReturnType<typeof fakeKeystore>,
  ): { title: string; description: string } => {
    const calls = fake.calls.filter((c) => c.op === "open" && c.prompt !== undefined);
    const last = calls.at(-1);
    if (last === undefined || last.op !== "open" || last.prompt === undefined) {
      throw new Error("no presence prompt was recorded");
    }
    return last.prompt;
  };

  it("renders one row per node kind in en", async () => {
    const { fake, h, session, walletId } = await keystoreSetup("ios", "en-US");
    const res = await exportAccount(h, session, {
      walletId,
      groupIndex: 2,
      nodes: [
        { kind: "evm.account" },
        { kind: "leaf", template: "evm.bip44" },
        { kind: "leaf", template: "tron.bip44" },
        { kind: "leaf", template: "solana.bip44-change" },
      ],
      verify: { kind: "hardware" },
    });
    expect("ok" in res).toBe(true);
    expect(shownPrompt(fake).description.split("\n")).toStrictEqual([
      "Share public keys of account 2 — never a private key",
      "EVM: the addresses of every account of this wallet (m/44'/60'/0')",
      "EVM address of account 2 (m/44'/60'/0'/0/2)",
      "TRON address of account 2 (m/44'/195'/0'/0/2)",
      "Solana address of account 2 (m/44'/501'/2'/0')",
    ]);
  });

  it("names the template and network of every btc.account row", async () => {
    const { fake, h, session, walletId } = await keystoreSetup("ios", "en-US");
    const res = await exportAccount(h, session, {
      walletId,
      groupIndex: 1,
      nodes: [
        { kind: "btc.account", template: "btc.bip44", network: MAINNET },
        { kind: "btc.account", template: "btc.bip84", network: TESTNET },
      ],
      verify: { kind: "hardware" },
    });
    expect("ok" in res).toBe(true);
    expect(shownPrompt(fake).description.split("\n")).toStrictEqual([
      "Share public keys of account 1 — never a private key",
      "Bitcoin Legacy (BIP-44) on Bitcoin: every address of account 1 (m/44'/0'/1')",
      "Bitcoin Native SegWit (BIP-84) on Bitcoin Testnet4: every address of account 1 (m/84'/1'/1')",
    ]);
  });

  it("renders the same rows in zh-Hans", async () => {
    const { fake, h, session, walletId } = await keystoreSetup("ios", "zh-CN");
    const res = await exportAccount(h, session, {
      walletId,
      groupIndex: 0,
      nodes: [
        { kind: "evm.account" },
        { kind: "btc.account", template: "btc.bip86", network: MAINNET },
      ],
      verify: { kind: "hardware" },
    });
    expect("ok" in res).toBe(true);
    expect(shownPrompt(fake).description.split("\n")).toStrictEqual([
      "共享账户 0 的公开密钥——绝不包含私钥",
      "EVM：本钱包所有账户的地址（m/44'/60'/0'）",
      "Bitcoin Taproot（BIP-86）：账户 0 的全部地址（m/86'/0'/0'）",
    ]);
  });

  /* The protocol caps nodes at 4: the widest prompt — share row + evm.account + two btc.account
     rows + a leaf — must fit both platform dialogs in both locales, or the check before
     verification would refuse a legal request. */
  it.each([
    ["ios", "en-US"],
    ["ios", "zh-CN"],
    ["android", "en-US"],
    ["android", "zh-CN"],
  ] as const)("the worst-case export fits %s in %s", async (platform, locale) => {
    const { fake, h, session, walletId } = await keystoreSetup(platform, locale);
    const res = await exportAccount(h, session, {
      walletId,
      groupIndex: 0,
      nodes: [
        { kind: "evm.account" },
        { kind: "btc.account", template: "btc.bip84", network: TESTNET },
        { kind: "btc.account", template: "btc.bip86", network: MAINNET },
        { kind: "leaf", template: "solana.bip44-change" },
      ],
      verify: { kind: "hardware" },
    });
    expect("ok" in res).toBe(true);
    expect(promptFits(shownPrompt(fake), PROMPT_BOUNDS[platform])).toBe(true);
  });
});
