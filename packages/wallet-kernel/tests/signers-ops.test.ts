// oxlint-disable eslint/no-await-in-loop -- device ops step one exchange per call, sequentially
/**
 * The signers module through the real protocol against the fake device: pairing commits a
 * hardware-wallet record and status lists it, accounts fills exactly the missing hardened paths and
 * merges the answer, verify-address compares on the device with independently derived addresses,
 * and the executor's lifecycle — cancel, lock, a second begin, the 300 s no-progress timer, unknown
 * opIds, mismatched responses — discards exactly when the design says. The tail covers the refusals
 * every other module owes a hardware wallet and the record-id binding check.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, createBase58check } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { NETWORK } from "@scure/btc-signer/utils.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { publicKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { encodeBatchExecute, normalizeEvm } from "@qntx/wallet-chains/evm";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import type { Driver } from "../src/modules/signers/driver.ts";
import { ONEKEY_DRIVER } from "../src/modules/signers/onekey/driver.ts";
import { createOperationExecutor } from "../src/modules/signers/operation.ts";
import { hardwareWalletId } from "../src/modules/signers/record.ts";
import type { KernelPlatform } from "../src/platform.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import { loadTranscript, replayExchange, transcriptSession } from "./onekey-emulator/index.ts";
import { fakeSecureInput } from "./secure-input.ts";
import { ACCOUNT_NODES, fakeDevice, masterFingerprint, nodeAt } from "./signers-fake.ts";
import type { FakeDevice, FakeDeviceOptions } from "./signers-fake.ts";

const HARDENED = 0x80000000;
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = mnemonicToSeedSync(MNEMONIC);
const MFP = masterFingerprint(SEED);
const HW_ID = hardwareWalletId("keystone", MFP);

const EVM_NETWORK = "eip155:1";
const TRON_NETWORK = "tron:728126428";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF = new Uint8Array(32).fill(0x50);
// Fresh bytes every call — the kernel wipes factor secrets once consumed.
const FACTOR = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF),
});
const PASSKEY = (): unknown => ({
  kind: "passkey",
  credentialId: new Uint8Array(CREDENTIAL_ID),
  prf: new Uint8Array(PRF),
});

const PAIR_OP = { kind: "pair", device: "keystone" };
const QR_RESPONSE = { kind: "qr", ur: { type: "fake-accounts", cbor: new Uint8Array([7]) } };

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
const errCode = (response: KernelResponse): string | undefined =>
  "err" in response ? response.err.code : undefined;
function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error(`expected object, got ${String(value)}`);
  }
  const v = (value as Record<string, ProtocolValue>)[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}
const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};
const arrField = (value: ProtocolValue, key: string): ProtocolValue[] => {
  const v = field(value, key);
  if (!Array.isArray(v)) {
    throw new TypeError(`${key} is not an array`);
  }
  return v;
};
const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

type Boot = {
  readonly h: Harness;
  readonly device: FakeDevice;
  readonly session: string;
  readonly walletId: string;
};

const boot = async (
  deviceOpts?: FakeDeviceOptions,
  harnessOpts?: Parameters<typeof createHarness>[0],
): Promise<Boot> => {
  const device = fakeDevice(SEED, deviceOpts);
  const h = createHarness({
    drivers: { keystone: device.driver, ledger: device.driver, onekey: ONEKEY_DRIVER },
    ...harnessOpts,
  });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: FACTOR(),
    }),
  );
  return {
    h,
    device,
    session: strField(res, "session"),
    walletId: strField(field(res, "wallet"), "walletId"),
  };
};

/** Runs pair through begin/step and returns the hardware wallet id. */
const pairDevice = async (
  h: Harness,
  session: string,
  verify: unknown = PASSKEY(),
): Promise<string> => {
  const begin = ok(await h.call("hardware.begin", { op: PAIR_OP, verify }, session));
  const done = ok(
    await h.call(
      "hardware.step",
      { opId: strField(begin, "opId"), response: QR_RESPONSE },
      session,
    ),
  );
  const wallet = field(field(done, "result"), "wallet");
  expect(strField(wallet, "custody")).toBe("hardware");
  return strField(wallet, "walletId");
};

/** Runs onekey pair through begin/step, replaying the recorded driver transcript. */
const pairOneKey = async (h: Harness, session: string): Promise<string> => {
  const transcript = loadTranscript("pro", "driver");
  const device = replayExchange(transcriptSession(transcript, "driver-pair"));
  const begin = ok(
    await h.call(
      "hardware.begin",
      { op: { kind: "pair", device: "onekey" }, verify: PASSKEY() },
      session,
    ),
  );
  const opId = strField(begin, "opId");
  let step = field(begin, "step");
  for (let guard = 0; strField(step, "kind") === "exchange" && guard < 64; guard++) {
    const request = field(step, "request");
    // oxlint-disable-next-line no-await-in-loop -- the coroutine answers one turn per step
    const data = await device(bytesField(request, "data"));
    // oxlint-disable-next-line no-await-in-loop -- the coroutine advances one turn per step
    const next = await h.call(
      "hardware.step",
      { opId, response: { kind: "message", data } },
      session,
    );
    step = ok(next);
  }
  const wallet = field(field(step, "result"), "wallet");
  expect(strField(wallet, "custody")).toBe("hardware");
  return strField(wallet, "walletId");
};

/** Begins an op and asserts the first turn is a device exchange. */
const beginOp = async (
  h: Harness,
  session: string,
  op: unknown,
  verify?: unknown,
): Promise<{ opId: string; request: ProtocolValue }> => {
  const res = ok(
    await h.call("hardware.begin", verify === undefined ? { op } : { op, verify }, session),
  );
  const step = field(res, "step");
  if (strField(step, "kind") !== "exchange") {
    throw new Error(`expected an exchange step, got ${JSON.stringify(step)}`);
  }
  return { opId: strField(res, "opId"), request: field(step, "request") };
};

/** The code the driver's exchange promise rejected with, or "resolved". */
const rejectionOf = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof KernelError ? error.code : "other"),
  );

describe("hardware.begin pair", () => {
  it("commits a hardware-wallet record and status lists it", async () => {
    const { h, session } = await boot({ model: "Keystone 3 Pro", firmware: "3.2.2" });
    const walletId = await pairDevice(h, session);
    expect(walletId).toBe(HW_ID);
    const status = ok(await h.call("status", undefined, session));
    const hw = arrField(status, "wallets").find((w) => field(w, "custody") === "hardware")!;
    expect(strField(hw, "walletId")).toBe(HW_ID);
    expect(strField(hw, "device")).toBe("keystone");
    expect(strField(hw, "fingerprint")).toBe(bytesToHex(MFP));
    expect(strField(hw, "model")).toBe("Keystone 3 Pro");
    expect(strField(hw, "firmware")).toBe("3.2.2");
    const image = await h.store.load();
    expect(image.records.filter((r) => r.kind === "hardware-wallet").map((r) => r.id)).toContain(
      HW_ID,
    );
  });

  it("re-pairing the same device answers already-exists", async () => {
    const { h, session } = await boot();
    await pairDevice(h, session);
    const { opId } = await beginOp(h, session, PAIR_OP, PASSKEY());
    const res = await h.call("hardware.step", { opId, response: QR_RESPONSE }, session);
    expect(errCode(res)).toBe("already-exists");
    // The failed op is discarded — its id no longer resolves.
    expect(errCode(await h.call("hardware.step", { opId, response: QR_RESPONSE }, session))).toBe(
      "not-found",
    );
  });

  it.each([3, 5])("a %s-byte fingerprint from pair is integrity, not a wallet", async (n) => {
    const { h, session } = await boot({ fingerprint: new Uint8Array(n).fill(1) });
    const { opId } = await beginOp(h, session, PAIR_OP, PASSKEY());
    expect(errCode(await h.call("hardware.step", { opId, response: QR_RESPONSE }, session))).toBe(
      "integrity",
    );
    const image = await h.store.load();
    expect(image.records.filter((r) => r.kind === "hardware-wallet")).toHaveLength(0);
  });

  it.each([
    ["a model with a control character", { model: "Keystone\u0007Pro" }],
    ["a model over 64 bytes", { model: "K".repeat(65) }],
    ["a non-ASCII firmware", { firmware: "3.2.2å" }],
  ])("a pair answering %s is integrity, not a wallet", async (_name, opts) => {
    const { h, session } = await boot(opts);
    const { opId } = await beginOp(h, session, PAIR_OP, PASSKEY());
    expect(errCode(await h.call("hardware.step", { opId, response: QR_RESPONSE }, session))).toBe(
      "integrity",
    );
    const image = await h.store.load();
    expect(image.records.filter((r) => r.kind === "hardware-wallet")).toHaveLength(0);
  });

  it("surfaces the driver's own KernelError from begin and step", async () => {
    const rejected = await boot({
      pairError: new KernelError("device-rejected", "the user refused pairing"),
    });
    expect(
      errCode(
        await rejected.h.call(
          "hardware.begin",
          { op: PAIR_OP, verify: PASSKEY() },
          rejected.session,
        ),
      ),
    ).toBe("device-rejected");

    const { h, device, session } = await boot({
      accountsError: new KernelError("device-app-closed", "the app is closed"),
      ed25519: [],
    });
    const walletId = await pairDevice(h, session);
    device.gaps.length = 0;
    const { opId } = await beginOp(
      h,
      session,
      {
        kind: "accounts",
        walletId,
        groupIndex: 0,
        templates: ["solana.bip44-change"],
        network: SOLANA_NETWORK,
      },
      PASSKEY(),
    );
    expect(
      errCode(
        await h.call(
          "hardware.step",
          { opId, response: { kind: "message", data: new Uint8Array([1]) } },
          session,
        ),
      ),
    ).toBe("device-app-closed");
  });
});

describe("hardware.begin accounts", () => {
  const accountsOp = (walletId: string, templates: string[], network: string) => ({
    kind: "accounts",
    walletId,
    groupIndex: 0,
    templates,
    network,
  });

  it("asks the device for exactly the missing paths and merges the answer", async () => {
    const TRON_ACCOUNT = [44 + HARDENED, 195 + HARDENED, HARDENED];
    const { h, device, session } = await boot({
      nodes: ACCOUNT_NODES.filter((p) => p[1] !== 195 + HARDENED),
    });
    const walletId = await pairDevice(h, session);
    device.gaps.length = 0;

    const { opId } = await beginOp(
      h,
      session,
      accountsOp(walletId, ["tron.bip44"], TRON_NETWORK),
      PASSKEY(),
    );
    const done = ok(
      await h.call(
        "hardware.step",
        { opId, response: { kind: "message", data: new Uint8Array([1]) } },
        session,
      ),
    );
    const accounts = arrField(field(done, "result"), "accounts");
    expect(accounts).toHaveLength(1);
    expect(device.gaps).toStrictEqual([{ secp256k1: [TRON_ACCOUNT], ed25519: [] }]);

    // The merged pin now serves tron — a second run asks the device nothing and finishes in begin.
    const again = ok(
      await h.call(
        "hardware.begin",
        { op: accountsOp(walletId, ["tron.bip44"], TRON_NETWORK) },
        session,
      ),
    );
    expect(strField(field(again, "step"), "kind")).toBe("done");
    expect(device.gaps).toHaveLength(1);
  });

  it("an accounts answer repeating a pinned path with a foreign key never shadows the pin", async () => {
    /* A hostile transport answering a Keystone sync can echo a pinned path under a different
       key. The merged pin keeps the pinned node — the fetched one is dropped, never served. */
    const SEED_B = new Uint8Array(64).fill(0xb0);
    const ACCOUNT_84 = [HARDENED + 84, HARDENED, HARDENED];
    const device = fakeDevice(SEED);
    const hostile: Driver = {
      ...device.driver,
      accounts: async (link, need, pin) => {
        const honest = await device.driver.accounts(link, need, pin);
        return { ...honest, nodes: [nodeAt(SEED_B, ACCOUNT_84), ...honest.nodes] };
      },
    };
    const h = createHarness({
      drivers: { keystone: hostile, ledger: device.driver, onekey: ONEKEY_DRIVER },
    });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: FACTOR(),
      }),
    );
    const session = strField(res, "session");
    const hwId = await pairDevice(h, session);

    const { opId } = await beginOp(
      h,
      session,
      {
        kind: "accounts",
        walletId: hwId,
        groupIndex: 1,
        templates: ["btc.bip84"],
        network: BTC_NETWORK,
      },
      PASSKEY(),
    );
    ok(
      await h.call(
        "hardware.step",
        { opId, response: { kind: "message", data: new Uint8Array([1]) } },
        session,
      ),
    );

    const served = ok(
      await h.call(
        "wallet.accounts",
        { walletId: hwId, groupIndex: 0, template: "btc.bip84", network: BTC_NETWORK },
        session,
      ),
    );
    const oracle = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'").publicExtendedKey;
    expect(HDKey.fromMasterSeed(SEED_B).derive("m/84'/0'/0'").publicExtendedKey).not.toBe(oracle);
    expect(strField(served, "xpub")).toBe(oracle);
  });

  it("a different fingerprint answering accounts is wrong-device and commits nothing", async () => {
    const TRON_ACCOUNT = [44 + HARDENED, 195 + HARDENED, HARDENED];
    const { h, device, session } = await boot({
      nodes: ACCOUNT_NODES.filter((p) => p[1] !== 195 + HARDENED),
      accountsFingerprint: new Uint8Array([1, 2, 3, 4]),
    });
    const walletId = await pairDevice(h, session);
    device.gaps.length = 0;

    const { opId } = await beginOp(
      h,
      session,
      accountsOp(walletId, ["tron.bip44"], TRON_NETWORK),
      PASSKEY(),
    );
    const res = await h.call(
      "hardware.step",
      { opId, response: { kind: "message", data: new Uint8Array([1]) } },
      session,
    );
    expect(errCode(res)).toBe("wrong-device");
    // Nothing was merged: the same op asks the device for the same gap again.
    const retry = await beginOp(
      h,
      session,
      accountsOp(walletId, ["tron.bip44"], TRON_NETWORK),
      PASSKEY(),
    );
    expect(device.gaps).toStrictEqual([
      { secp256k1: [TRON_ACCOUNT], ed25519: [] },
      { secp256k1: [TRON_ACCOUNT], ed25519: [] },
    ]);
    await h.call("hardware.cancel", { opId: retry.opId }, session);
  });
});

describe("hardware.begin verify-address", () => {
  const evmOracle = (path: string): string => {
    const pub = HDKey.fromMasterSeed(SEED).derive(path).publicKey;
    if (pub === null) {
      throw new Error("no public key");
    }
    const uncompressed = `0x${bytesToHex(secp256k1.Point.fromBytes(pub).toBytes(false))}` as const;
    return publicKeyToAddress(uncompressed);
  };

  const tronOracle = (path: string): string => {
    const pub = HDKey.fromMasterSeed(SEED).derive(path).publicKey;
    if (pub === null) {
      throw new Error("no public key");
    }
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false).subarray(1);
    const payload = new Uint8Array(21);
    payload[0] = 0x41;
    payload.set(keccak_256(uncompressed).subarray(12), 1);
    return createBase58check(sha256).encode(payload);
  };

  const runCheck = async (
    b: Boot,
    op: Record<string, unknown>,
    oracle: string,
    oraclePath: string,
  ) => {
    const { opId, request } = await beginOp(b.h, b.session, op);
    expect(strField(request, "kind")).toBe("compare");
    expect(strField(request, "address")).toBe(oracle);
    expect(strField(request, "path")).toBe(oraclePath);
    const done = ok(
      await b.h.call(
        "hardware.step",
        { opId, response: { kind: "compare", matched: true } },
        b.session,
      ),
    );
    const result = field(done, "result");
    expect(strField(result, "address")).toBe(oracle);
    expect(strField(result, "method")).toBe("compare");
  };

  it("checks evm, tron, solana and bitcoin addresses against independent derivations", async () => {
    const b = await boot();
    const walletId = await pairDevice(b.h, b.session);
    await runCheck(
      b,
      {
        kind: "verify-address",
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: EVM_NETWORK,
      },
      evmOracle("m/44'/60'/0'/0/0"),
      "m/44'/60'/0'/0/0",
    );
    await runCheck(
      b,
      {
        kind: "verify-address",
        walletId,
        groupIndex: 0,
        template: "tron.bip44",
        network: TRON_NETWORK,
      },
      tronOracle("m/44'/195'/0'/0/0"),
      "m/44'/195'/0'/0/0",
    );
    await runCheck(
      b,
      {
        kind: "verify-address",
        walletId,
        groupIndex: 0,
        template: "solana.bip44-change",
        network: SOLANA_NETWORK,
      },
      // The independent solana oracle: the address is the base58 of the SLIP-10 public key.
      base58.encode(
        ed25519.getPublicKey(Slip10.fromMasterSeed(SEED).derive("m/44'/501'/0'/0'").privateKey),
      ),
      "m/44'/501'/0'/0'",
    );
    const xpub = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'");
    const child = xpub.derive("m/0/7");
    await runCheck(
      b,
      {
        kind: "verify-address",
        walletId,
        groupIndex: 0,
        template: "btc.bip84",
        network: BTC_NETWORK,
        index: 7,
      },
      p2wpkh(child.publicKey!, NETWORK).address,
      "m/84'/0'/0'/0/7",
    );
    const tapChild = HDKey.fromMasterSeed(SEED).derive("m/86'/0'/0'").derive("m/0/0");
    await runCheck(
      b,
      {
        kind: "verify-address",
        walletId,
        groupIndex: 0,
        template: "btc.bip86",
        network: BTC_NETWORK,
        index: 0,
      },
      p2tr(tapChild.publicKey!.subarray(1), undefined, NETWORK).address,
      "m/86'/0'/0'/0/0",
    );
    expect(b.device.targets).toHaveLength(5);
  });

  it("matched:false is wrong-device", async () => {
    const b = await boot();
    const walletId = await pairDevice(b.h, b.session);
    const { opId } = await beginOp(b.h, b.session, {
      kind: "verify-address",
      walletId,
      groupIndex: 0,
      template: "evm.bip44",
      network: EVM_NETWORK,
    });
    expect(
      errCode(
        await b.h.call(
          "hardware.step",
          { opId, response: { kind: "compare", matched: false } },
          b.session,
        ),
      ),
    ).toBe("wrong-device");
  });

  it("rejects malformed input synchronously — no opId, no exchange", async () => {
    const b = await boot();
    const walletId = await pairDevice(b.h, b.session);
    b.device.requests.length = 0;
    const begin = async (op: Record<string, unknown>) =>
      b.h.call("hardware.begin", { op }, b.session);
    expect(
      errCode(
        await begin({
          kind: "verify-address",
          walletId,
          groupIndex: 0,
          template: "evm.bip44",
          network: EVM_NETWORK,
          index: 3,
        }),
      ),
    ).toBe("invalid-input");
    expect(
      errCode(
        await begin({
          kind: "verify-address",
          walletId,
          groupIndex: 0,
          template: "btc.bip84",
          network: BTC_NETWORK,
        }),
      ),
    ).toBe("invalid-input");
    expect(
      errCode(
        await begin({
          kind: "verify-address",
          walletId,
          groupIndex: 0,
          template: "evm.bip44",
          network: BTC_NETWORK,
        }),
      ),
    ).toBe("invalid-input");
    expect(b.device.requests).toHaveLength(0);
  });
});

describe("operation lifecycle", () => {
  it("cancel rejects the pending exchange and forgets the op", async () => {
    const { h, device, session } = await boot();
    const { opId } = await beginOp(h, session, PAIR_OP, PASSKEY());
    const rejection = rejectionOf(device.exchanges[0]!);
    ok(await h.call("hardware.cancel", { opId }, session));
    await expect(rejection).resolves.toBe("cancelled");
    expect(errCode(await h.call("hardware.step", { opId, response: QR_RESPONSE }, session))).toBe(
      "not-found",
    );
    expect(errCode(await h.call("hardware.cancel", { opId }, session))).toBe("not-found");
  });

  it("an idle lock aborts the operation; the next step is not-found", async () => {
    const { h, device, session } = await boot(undefined, { idleMs: 60_000 });
    const { opId } = await beginOp(h, session, PAIR_OP, PASSKEY());
    const rejection = rejectionOf(device.exchanges[0]!);
    h.advance(60_001);
    expect(field(ok(await h.call("status")), "vault")).toBe("locked");
    await expect(rejection).resolves.toBe("cancelled");
    const unlocked = ok(await h.call("vault.unlock", { factor: FACTOR() }));
    const session2 = strField(unlocked, "session");
    expect(errCode(await h.call("hardware.step", { opId, response: QR_RESPONSE }, session2))).toBe(
      "not-found",
    );
  });

  it("vault.reset aborts a parked exchange and the fresh vault has no hardware wallets", async () => {
    const { h, device, session } = await boot();
    const walletId = await pairDevice(h, session);
    const { opId } = await beginOp(
      h,
      session,
      {
        kind: "accounts",
        walletId,
        groupIndex: 1, // group-1 solana is unpinned — the op asks the device
        templates: ["solana.bip44-change"],
        network: SOLANA_NETWORK,
      },
      PASSKEY(),
    );
    const rejection = rejectionOf(device.exchanges.at(-1)!);
    ok(await h.call("vault.reset", null, session));
    // The parked exchange rejects and the session died with the vault — the op resolves nothing.
    await expect(rejection).resolves.toBe("cancelled");
    expect(errCode(await h.call("hardware.step", { opId, response: QR_RESPONSE }, session))).toBe(
      "locked",
    );
    // A freshly established vault lists no hardware wallets.
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: FACTOR(),
      }),
    );
    const session2 = strField(res, "session");
    const status = ok(await h.call("status", undefined, session2));
    expect(arrField(status, "wallets").some((w) => field(w, "custody") === "hardware")).toBe(false);
  });

  it("a second begin discards the first operation", async () => {
    const { h, device, session } = await boot();
    const first = await beginOp(h, session, PAIR_OP, PASSKEY());
    const rejection = rejectionOf(device.exchanges[0]!);
    const second = await beginOp(h, session, PAIR_OP, PASSKEY());
    await expect(rejection).resolves.toBe("cancelled");
    expect(
      errCode(await h.call("hardware.step", { opId: first.opId, response: QR_RESPONSE }, session)),
    ).toBe("not-found");
    const done = ok(
      await h.call("hardware.step", { opId: second.opId, response: QR_RESPONSE }, session),
    );
    expect(strField(field(done, "result"), "kind")).toBe("pair");
  });

  it("the 300 s no-progress timer discards the operation", async () => {
    const { h, device, session } = await boot();
    const { opId } = await beginOp(h, session, PAIR_OP, PASSKEY());
    h.advance(299_999);
    // Still alive just before the deadline — the step re-arms the timer.
    const next = ok(await h.call("hardware.step", { opId, response: QR_RESPONSE }, session));
    expect(strField(field(next, "result"), "kind")).toBe("pair");

    const second = await beginOp(h, session, PAIR_OP, PASSKEY());
    const rejection = rejectionOf(device.exchanges[1]!);
    h.advance(300_001);
    await expect(rejection).resolves.toBe("cancelled");
    expect(
      errCode(await h.call("hardware.step", { opId: second.opId, response: QR_RESPONSE }, session)),
    ).toBe("not-found");
  });

  it("an unknown opId is not-found for step and cancel", async () => {
    const { h, session } = await boot();
    expect(
      errCode(
        await h.call("hardware.step", { opId: "aa".repeat(16), response: QR_RESPONSE }, session),
      ),
    ).toBe("not-found");
    expect(errCode(await h.call("hardware.cancel", { opId: "aa".repeat(16) }, session))).toBe(
      "not-found",
    );
  });

  it("a response of the wrong kind is invalid-input and discards the op", async () => {
    const { h, device, session } = await boot();
    const { opId } = await beginOp(h, session, PAIR_OP, PASSKEY());
    const rejection = rejectionOf(device.exchanges[0]!);
    expect(
      errCode(
        await h.call(
          "hardware.step",
          { opId, response: { kind: "compare", matched: true } },
          session,
        ),
      ),
    ).toBe("invalid-input");
    await expect(rejection).resolves.toBe("cancelled");
    expect(errCode(await h.call("hardware.step", { opId, response: QR_RESPONSE }, session))).toBe(
      "not-found",
    );
  });
});

describe("executor (unit)", () => {
  // The kernel's serial queue makes "step while the body is working" unreachable through the
  // wire — the executor is tested directly for it.
  const stubPlatform = (): KernelPlatform => {
    const platform = {
      random: (n: number) => new Uint8Array(n).fill(1),
      setTimer: () => () => undefined,
    } as unknown as KernelPlatform;
    return platform;
  };

  it("step while the body runs between exchanges is invalid-input", async () => {
    const exec = createOperationExecutor(stubPlatform());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { opId } = await exec.begin("keystone", undefined, async (link) => {
      await link.exchange({ kind: "message", data: new Uint8Array([1]) });
      await gate;
      return { kind: "accounts", accounts: [] };
    });
    const first = exec.step(opId, { kind: "message", data: new Uint8Array([2]) });
    await expect(
      exec.step(opId, { kind: "message", data: new Uint8Array([3]) }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    release();
    const step = await first;
    expect(step.kind).toBe("done");
  });
});

describe("hardware wallet refusals", () => {
  /** The seed-bound calls every hardware record must refuse. */
  const seedBoundCalls = (
    h: Harness,
    session: string,
    hwId: string,
  ): ReadonlyArray<Promise<KernelResponse>> => [
    h.call("nostr.deriveKey", { walletId: hwId, index: 0 }, session),
    h.call(
      "sessions.create",
      {
        scheme: "hyperliquid-l1-agent",
        owner: { walletId: hwId, groupIndex: 0 },
        scope: "Mainnet",
        name: "bot-1",
        validUntil: h.wallNow() + 86_400_000,
        limits: {
          notional: "1000000000",
          maxLeverage: 100,
          assets: [0, 1].map((asset) => ({ asset, size: "1000" })),
        },
        /* Its own copy — the kernel wipes the verify bytes it consumes. */
        verify: PASSKEY(),
      },
      session,
    ),
    h.call("wallet.exportMnemonic", { walletId: hwId, verify: PASSKEY() }, session),
    h.call(
      "spark.identityPublicKey",
      { account: { walletId: hwId, groupIndex: 0, network: "mainnet" } },
      session,
    ),
  ];

  it("seed-only commands refuse the hardware record", async () => {
    const { h, session } = await boot();
    const hwId = await pairDevice(h, session);
    const results = await Promise.all(seedBoundCalls(h, session, hwId));
    for (const res of results) {
      expect(errCode(res)).toBe("unsupported");
    }
  });

  it("seed-only commands refuse the onekey record too", async () => {
    const { h, session } = await boot();
    const hwId = await pairOneKey(h, session);
    const results = await Promise.all(seedBoundCalls(h, session, hwId));
    for (const res of results) {
      expect(errCode(res)).toBe("unsupported");
    }
  });

  it("an over-long prompt refuses a hardware sign as blind before any device exchange", async () => {
    /* The same oversize→blind rule chain.sign gets: prepareApproval measures the rendered
       prompt against the platform bound and refuses while blind signing is off — before the
       presence ceremony and before the first device exchange. */
    const fake = fakeKeystore();
    const device = fakeDevice(SEED);
    const h = createHarness({
      keystore: fake.keystore,
      drivers: { keystone: device.driver, ledger: device.driver, onekey: ONEKEY_DRIVER },
    });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const session = strField(res, "session");
    const hwId = await pairDevice(h, session, { kind: "hardware" });
    /* The batch renders only as a self-call to the account's own address. */
    const ownPub = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'/0/0").publicKey!;
    const own = publicKeyToAddress(
      `0x${bytesToHex(secp256k1.Point.fromBytes(ownPub).toBytes(false))}`,
    );
    const calls = Array.from({ length: 12 }, (_, i) => ({
      to: `0x00000000000000000000000000000000000000${10 + i}` as `0x${string}`,
      value: 1n,
      data: "0x" as `0x${string}`,
    }));
    const request = normalizeEvm({
      kind: "evm.transaction",
      network: EVM_NETWORK,
      account: { kind: "hd", walletId: hwId, groupIndex: 0, template: "evm.bip44" },
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
    const keystoreCalls = fake.calls.length;
    const begin = await h.call(
      "hardware.begin",
      { op: { kind: "sign", request }, verify: { kind: "hardware" } },
      session,
    );
    expect(errCode(begin)).toBe("blind-signing-disabled");
    expect(fake.calls).toHaveLength(keystoreCalls);
  });

  it("the app lock off still gates sign on presence, and a session scheme refuses a hardware wallet", async () => {
    /* A keystore vault starts with the silent device factor (app lock off) plus the hardware
       verifying row: signing still needs presence, and the device factor can never supply it. */
    const fake = fakeKeystore();
    const device = fakeDevice(SEED);
    const h = createHarness({
      keystore: fake.keystore,
      drivers: { keystone: device.driver, ledger: device.driver, onekey: ONEKEY_DRIVER },
    });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const session = strField(res, "session");
    const hwId = await pairDevice(h, session, { kind: "hardware" });
    const request = normalizeEvm({
      kind: "evm.personal-message",
      network: EVM_NETWORK,
      account: { kind: "hd", walletId: hwId, groupIndex: 0, template: "evm.bip44" },
      message: utf8ToBytes("hello"),
    });
    // A device factor never verifies: the wire `verifier` validator rejects it, and the decode
    // failure surfaces as `integrity` before the op even begins.
    expect(
      errCode(
        await h.call(
          "hardware.begin",
          { op: { kind: "sign", request }, verify: { kind: "device" } },
          session,
        ),
      ),
    ).toBe("integrity");
    const begun = ok(
      await h.call(
        "hardware.begin",
        { op: { kind: "sign", request }, verify: { kind: "hardware" } },
        session,
      ),
    );
    expect(strField(field(begun, "step"), "kind")).toBe("exchange");
    ok(await h.call("hardware.cancel", { opId: strField(begun, "opId") }, session));
    const create = async () =>
      h.call(
        "sessions.create",
        {
          scheme: "hyperliquid-l1-agent",
          owner: { walletId: hwId, groupIndex: 0 },
          scope: "Mainnet",
          name: "bot-1",
          validUntil: h.wallNow() + 86_400_000,
          limits: {
            notional: "1000000000",
            maxLeverage: 100,
            assets: [0, 1, 2, 3, 4, 5, 10107].map((asset) => ({ asset, size: "1000" })),
          },
          verify: { kind: "hardware" },
        },
        session,
      );
    expect(errCode(await create())).toBe("unsupported");
    /* External custody is refused as `unsupported` at the top of sessions.create — on either
       platform, with the app lock off and on, with no session-approval input and no keystore
       prompt ever shown: enabling the lock cannot help a wallet the scheme cannot sign for. */
    for (const platform of ["ios", "android"] as const) {
      const pf = fakeKeystore("en-US", platform);
      const input = fakeSecureInput();
      const pd = fakeDevice(SEED);
      const ph = createHarness({
        keystore: pf.keystore,
        secureInput: input.secureInput,
        drivers: { keystone: pd.driver, ledger: pd.driver, onekey: ONEKEY_DRIVER },
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- one platform rig at a time
      await ph.settle();
      const pres = ok(
        await ph.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(MNEMONIC),
          factor: { kind: "device" },
        }),
      );
      const psession = strField(pres, "session");
      const phwId = await pairDevice(ph, psession, { kind: "hardware" });
      const pcreate = async () =>
        ph.call(
          "sessions.create",
          {
            scheme: "hyperliquid-l1-agent",
            owner: { walletId: phwId, groupIndex: 0 },
            scope: "Mainnet",
            name: "bot-1",
            validUntil: ph.wallNow() + 86_400_000,
            limits: {
              notional: "1000000000",
              maxLeverage: 100,
              assets: [0, 1, 2, 3, 4, 5, 10107].map((asset) => ({ asset, size: "1000" })),
            },
            verify: { kind: "hardware" },
          },
          psession,
        );
      const callsOff = pf.calls.length;
      expect(errCode(await pcreate())).toBe("unsupported");
      expect(pf.calls).toHaveLength(callsOff);
      expect(input.requests).toHaveLength(0);
      ok(
        await ph.call(
          "vault.setAppLock",
          { enabled: true, verify: { kind: "hardware" } },
          psession,
        ),
      );
      const callsOn = pf.calls.length;
      expect(errCode(await pcreate())).toBe("unsupported");
      expect(pf.calls).toHaveLength(callsOn);
      expect(input.requests).toHaveLength(0);
    }
  });

  it("chain.sign refuses a hardware account with device-required", async () => {
    const { h, session } = await boot();
    const hwId = await pairDevice(h, session);
    const res = await h.call(
      "chain.sign",
      {
        request: {
          kind: "evm.personal-message",
          network: EVM_NETWORK,
          account: { kind: "hd", walletId: hwId, groupIndex: 0, template: "evm.bip44" },
          message: utf8ToBytes("hello"),
        },
        verify: PASSKEY(),
      },
      session,
    );
    expect(errCode(res)).toBe("device-required");
  });

  it("sign and pair need a factor and verify-address refuses one", async () => {
    const { h, session } = await boot();
    const hwId = await pairDevice(h, session);
    expect(errCode(await h.call("hardware.begin", { op: PAIR_OP }, session))).toBe("invalid-input");
    expect(
      errCode(
        await h.call(
          "hardware.begin",
          {
            op: {
              kind: "verify-address",
              walletId: hwId,
              groupIndex: 0,
              template: "evm.bip44",
              network: EVM_NETWORK,
            },
            verify: PASSKEY(),
          },
          session,
        ),
      ),
    ).toBe("invalid-input");
    const request = {
      kind: "evm.personal-message",
      network: EVM_NETWORK,
      account: { kind: "hd", walletId: hwId, groupIndex: 0, template: "evm.bip44" },
      message: utf8ToBytes("hello"),
    };
    expect(
      errCode(await h.call("hardware.begin", { op: { kind: "sign", request } }, session)),
    ).toBe("invalid-input");
  });

  it("wallet.accounts serves a pinned path and misses are device-required", async () => {
    const { h, session } = await boot();
    const hwId = await pairDevice(h, session);
    const res = ok(
      await h.call(
        "wallet.accounts",
        { walletId: hwId, groupIndex: 0, template: "evm.bip44", network: EVM_NETWORK },
        session,
      ),
    );
    const pub = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'/0/0").publicKey!;
    const oracle = publicKeyToAddress(
      `0x${bytesToHex(secp256k1.Point.fromBytes(pub).toBytes(false))}`,
    );
    expect(strField(res, "address")).toBe(oracle);
    // The sibling hardened leaf is a miss — SLIP-10 has no public derivation.
    const miss = await h.call(
      "wallet.accounts",
      {
        walletId: hwId,
        groupIndex: 1,
        template: "solana.bip44-change",
        network: SOLANA_NETWORK,
      },
      session,
    );
    expect(errCode(miss)).toBe("device-required");
  });

  it("wallet.delete removes the hardware record", async () => {
    const { h, session } = await boot();
    const hwId = await pairDevice(h, session);
    ok(await h.call("wallet.delete", { walletId: hwId, verify: PASSKEY() }, session));
    const image = await h.store.load();
    expect(image.records.some((r) => r.id === hwId)).toBe(false);
    const status = ok(await h.call("status", undefined, session));
    expect(arrField(status, "wallets").some((w) => field(w, "custody") === "hardware")).toBe(false);
    expect(
      errCode(
        await h.call(
          "hardware.begin",
          {
            op: {
              kind: "accounts",
              walletId: hwId,
              groupIndex: 0,
              templates: ["evm.bip44"],
              network: EVM_NETWORK,
            },
          },
          session,
        ),
      ),
    ).toBe("not-found");
  });

  it("the cloud backup envelope carries no hardware wallet", async () => {
    const { h, session } = await boot();
    const hwId = await pairDevice(h, session);
    await h.call(
      "backup.enable",
      {
        verify: PASSKEY(),
        factors: [{ kind: "password", password: utf8ToBytes("correct horse battery") }],
      },
      session,
    );
    const update = ok(await h.call("backup.update", null, session));
    const envelope = strField(update, "envelope");

    const restored = createHarness();
    await restored.settle();
    const res = ok(
      await restored.call("backup.restore", {
        envelope,
        backupFactor: { kind: "password", password: utf8ToBytes("correct horse battery") },
        factor: { kind: "password", password: utf8ToBytes("new vault password") },
      }),
    );
    const wallets = arrField(res, "wallets");
    expect(wallets).toHaveLength(1);
    const [first] = wallets;
    expect(strField(first!, "custody")).toBe("vault");
    expect(strField(first!, "walletId")).not.toBe(hwId);
  });
});

describe("record id binding", () => {
  it("a record whose id does not match its header latches the vault corrupted", async () => {
    const { h, session } = await boot();
    const header = JSON.stringify({
      device: "keystone",
      fingerprint: "a1b2c3d4",
      createdAt: 1_700_000_000_000,
    });
    // A valid-format header under an id the formula would never produce.
    await h.store.commit([
      {
        op: "put-record",
        record: {
          kind: "hardware-wallet",
          id: "deadbeefdeadbeef",
          header,
          sealed: new Uint8Array(48),
        },
      },
    ]);
    await h.settle();
    const status = ok(await h.call("status", undefined, session));
    expect(field(status, "vault")).toBe("corrupted");
  });
});

describe("keys.import against hardware wallets", () => {
  it("refuses a private key that is a paired hardware wallet's own account", async () => {
    const { h, session } = await boot();
    await pairDevice(h, session);
    // The pin's evm node is m/44'/60'/0'; the group-0 leaf key is the device's account.
    const master = HDKey.fromMasterSeed(SEED);
    const leaf = master.derive("m/44'/60'/0'/0/0");
    const secret = new Uint8Array(leaf.privateKey!);
    try {
      expect(errCode(await h.call("keys.import", { family: "evm", secret }, session))).toBe(
        "conflict",
      );
    } finally {
      leaf.wipePrivateData();
      master.wipePrivateData();
    }
    // A key that is none of the wallet's accounts still imports.
    const res = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(32).fill(3) }, session),
    );
    expect(strField(res, "family")).toBe("evm");
  });
});

describe("vault lifecycle", () => {
  it("a paired hardware wallet survives lock/unlock next to the seed wallet", async () => {
    const { h, session, walletId } = await boot(undefined, { idleMs: 60_000 });
    const hwId = await pairDevice(h, session);
    h.advance(60_001);
    expect(field(ok(await h.call("status")), "vault")).toBe("locked");
    const unlocked = ok(await h.call("vault.unlock", { factor: FACTOR() }));
    const session2 = strField(unlocked, "session");
    const status = ok(await h.call("status", undefined, session2));
    const walletIds = arrField(status, "wallets").map((w) => strField(w, "walletId"));
    expect(walletIds).toStrictEqual([walletId, hwId]);
    const image = await h.store.load();
    expect(image.records.map((r) => r.kind)).toStrictEqual(
      expect.arrayContaining(["entropy", "hardware-wallet"]),
    );
  });
});
