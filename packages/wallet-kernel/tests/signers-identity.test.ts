/**
 * Signer key material binds to verification and per-entry on-device confirmation, end to end
 * through hardware.begin/step: pair and gap-filling `accounts` fetch need a verifying factor, every
 * merged or paired entry lands unconfirmed, `wallet.accounts` reports the flag, exporting an
 * unconfirmed node needs an explicit acknowledgement that adds a danger row to the prompt, and only
 * a matched `verify-address` seals the serving entry confirmed — for every group it serves,
 * persisted in the re-sealed record across a lock/unlock re-parse.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import type { KeyPath } from "@qntx/wallet-chains";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import type { DeviceRequest, DeviceResponse, ProtocolValue } from "@qntx/wallet/protocol";

import { pathToString } from "../src/derive/pinned.ts";
import { KernelError } from "../src/errors.ts";
import type { DeviceLink } from "../src/modules/signers/driver.ts";
import { KEYSTONE_DRIVER } from "../src/modules/signers/keystone/driver.ts";
import { LEDGER_DRIVER } from "../src/modules/signers/ledger/driver.ts";
import { LEDGER_APPS } from "../src/modules/signers/ledger/protocol/device.ts";
import { ONEKEY_DRIVER } from "../src/modules/signers/onekey/driver.ts";
import type { KeystorePrompt } from "../src/platform.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";
import { fakeDevice, masterFingerprint } from "./signers-fake.ts";
import {
  hex,
  ok as okHex,
  SEED,
  unhex,
  utf8Hex,
  vectorCase,
  xpubAt,
} from "./signers-ledger-fake.ts";

const H = 0x80_00_00_00;
const SEED_B = new Uint8Array(64).fill(0xb0);
const FINGERPRINT = unhex(vectorCase("bitcoin", "fingerprint").result as string);
const MFP = masterFingerprint(SEED);
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const EVM_NETWORK = "eip155:1";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const ACCOUNT_44: KeyPath = [H + 44, H, H];
const ACCOUNT_84: KeyPath = [H + 84, H, H];
const ACCOUNT_84_G1: KeyPath = [H + 84, H, H + 1];
const EVM_ACCOUNT: KeyPath = [H + 44, H + 60, H];
const EVM_LEAF_G0: KeyPath = [H + 44, H + 60, H, 0, 0];
const EVM_LEAF_G1: KeyPath = [H + 44, H + 60, H, 0, 1];

const pathText = (path: KeyPath): string => pathToString(path);
const hdAt = (seed: Uint8Array, path: KeyPath): HDKey =>
  HDKey.fromMasterSeed(seed).derive(pathText(path));
const xpubAtSeed = (seed: Uint8Array, path: KeyPath): string => hdAt(seed, path).publicExtendedKey;

/** The ethereum chain-code public-node reply: `LV(65 uncompressed) ‖ LV(40 ascii) ‖ chainCode`. */
const ethNodeReply = (seed: Uint8Array, path: KeyPath): { readonly response: string } => {
  const hd = hdAt(seed, path);
  if (hd.publicKey === null || hd.chainCode === null) {
    throw new Error("cannot derive node fixture");
  }
  const uncompressed = secp256k1.Point.fromBytes(hd.publicKey).toBytes(false);
  const address = evmAddressFromPublicKey(uncompressed).slice(2);
  return {
    response: okHex(`41${hex(uncompressed)}28${utf8Hex(address)}${hex(hd.chainCode)}`),
  };
};

/** The get-address reply (P1 confirm): `LV(65 uncompressed) ‖ LV(40 ascii)` — no chain code. */
const ethAddressReply = (seed: Uint8Array, path: KeyPath): { readonly response: string } => {
  const hd = hdAt(seed, path);
  if (hd.publicKey === null) {
    throw new Error("cannot derive node fixture");
  }
  const uncompressed = secp256k1.Point.fromBytes(hd.publicKey).toBytes(false);
  const address = evmAddressFromPublicKey(uncompressed).slice(2);
  return { response: okHex(`41${hex(uncompressed)}28${utf8Hex(address)}`) };
};

function okValue(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
const errCode = (response: KernelResponse): string | undefined =>
  "err" in response ? response.err.code : undefined;
function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
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
const boolField = (value: ProtocolValue, key: string): boolean => {
  const v = field(value, key);
  if (typeof v !== "boolean") {
    throw new TypeError(`${key} is not a boolean`);
  }
  return v;
};

/** Presence prompts the keystore saw — every verifyFactor on a device-factor vault opens with one. */
const presencePrompts = (calls: ReadonlyArray<KeystoreCall>): KeystorePrompt[] =>
  calls.flatMap((call) =>
    call.op === "open" && call.protection === "presence" && call.prompt !== undefined
      ? [call.prompt]
      : [],
  );

/** The prompt the last verifying `open` was shown. */
const lastPrompt = (fake: ReturnType<typeof fakeKeystore>): KeystorePrompt => {
  const last = presencePrompts(fake.calls).at(-1);
  if (last === undefined) {
    throw new Error("no verification prompt was recorded");
  }
  return last;
};

const lv = (text: string): string => {
  const data = utf8Hex(text);
  return `${(data.length / 2).toString(16).padStart(2, "0")}${data}`;
};
const appAndVersionStep = (app: keyof typeof LEDGER_APPS): string =>
  okHex(`01${lv(LEDGER_APPS[app].name)}${lv(LEDGER_APPS[app].minimum.join("."))}00`);

/** Answers a begin/step operation's `message` exchanges from the queued APDU responses. */
const runOp = async (
  h: Harness,
  session: string,
  begin: KernelResponse,
  responses: Array<{ readonly response: string } | string>,
): Promise<ProtocolValue> => {
  const queue = responses.map((r) => (typeof r === "string" ? r : r.response));
  const opId = strField(okValue(begin), "opId");
  let step = field(okValue(begin), "step");
  for (let guard = 0; strField(step, "kind") === "exchange" && guard < 64; guard++) {
    const request = field(step, "request");
    const kind = strField(request, "kind");
    let response: ProtocolValue;
    if (kind === "qr") {
      // The fake pair's canned sync — the script carries no entry for it.
      response = { kind: "qr", ur: { type: "fake-accounts", cbor: new Uint8Array([7]) } };
    } else {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`unscripted exchange ${JSON.stringify(request)}`);
      }
      response =
        kind === "compare"
          ? { kind: "compare", matched: next === "matched" }
          : { kind: "message", data: unhex(next) };
    }
    // oxlint-disable-next-line no-await-in-loop -- the coroutine advances one turn per step
    const res = await h.call("hardware.step", { opId, response }, session);
    if ("err" in res) {
      throw new Error(`hardware.step failed: ${JSON.stringify(res.err)}`);
    }
    step = res.ok;
  }
  expect(queue).toHaveLength(0);
  if (strField(step, "kind") !== "done") {
    throw new Error("the operation did not finish");
  }
  return field(step, "result");
};

const PAIR_SCRIPT = [
  appAndVersionStep("bitcoin"),
  okHex(hex(FINGERPRINT)),
  ...[ACCOUNT_44, [H + 49, H, H], ACCOUNT_84, [H + 86, H, H]].map((path) =>
    okHex(utf8Hex(xpubAt(path))),
  ),
];

const VERIFY = { kind: "hardware" } as const;

const accountsOp = (walletId: string) => ({
  kind: "accounts" as const,
  walletId,
  groupIndex: 1,
  templates: ["btc.bip84"],
  network: BTC_NETWORK,
});

const ledgerHarness = async () => {
  const fk = fakeKeystore();
  const h = createHarness({
    keystore: fk.keystore,
    drivers: { keystone: LEDGER_DRIVER, ledger: LEDGER_DRIVER, onekey: ONEKEY_DRIVER },
  });
  await h.settle();
  const res = okValue(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: { kind: "device" },
    }),
  );
  return { fk, h, session: strField(res, "session") };
};

const chainAccount = async (
  h: Harness,
  session: string,
  walletId: string,
  groupIndex: number,
  template: string,
  network: string,
): Promise<ProtocolValue> =>
  okValue(await h.call("wallet.accounts", { walletId, groupIndex, template, network }, session));

describe("hardware.begin — verification-gated fetches and unconfirmed merges", () => {
  it("pair and gap-filling fetches need a factor; foreign keys merge unconfirmed", async () => {
    const { fk, h, session } = await ledgerHarness();

    // Pair with no factor refuses before the executor starts.
    expect(
      errCode(await h.call("hardware.begin", { op: { kind: "pair", device: "ledger" } }, session)),
    ).toBe("invalid-input");

    const promptsBeforePair = presencePrompts(fk.calls).length;
    const paired = await runOp(
      h,
      session,
      await h.call(
        "hardware.begin",
        { op: { kind: "pair", device: "ledger" }, verify: VERIFY },
        session,
      ),
      PAIR_SCRIPT,
    );
    expect(presencePrompts(fk.calls)).toHaveLength(promptsBeforePair + 1);
    const hwId = strField(field(paired, "wallet"), "walletId");

    // Group 1 is unpinned: the account resolves only through the device.
    expect(
      errCode(
        await h.call(
          "wallet.accounts",
          { walletId: hwId, groupIndex: 1, template: "btc.bip84", network: BTC_NETWORK },
          session,
        ),
      ),
    ).toBe("device-required");

    /* The accounts op that adds keys needs approval, not just input validity — without a factor
       nothing begins, so no exchange ever leaves the host. */
    expect(errCode(await h.call("hardware.begin", { op: accountsOp(hwId) }, session))).toBe(
      "approval-required",
    );
    expect(
      errCode(
        await h.call(
          "wallet.accounts",
          { walletId: hwId, groupIndex: 1, template: "btc.bip84", network: BTC_NETWORK },
          session,
        ),
      ),
    ).toBe("device-required");

    /* With a factor: one verification prompt, then the transport's answers — a replayed public
       fingerprint plus a foreign seed's xpub — merge into the pin. The merge lands unconfirmed. */
    const promptsBeforeAccounts = presencePrompts(fk.calls).length;
    const done = await runOp(
      h,
      session,
      await h.call("hardware.begin", { op: accountsOp(hwId), verify: VERIFY }, session),
      [
        appAndVersionStep("bitcoin"),
        okHex(hex(FINGERPRINT)), // the public fingerprint, replayed — not the foreign seed's
        okHex(utf8Hex(xpubAtSeed(SEED_B, ACCOUNT_84_G1))),
      ],
    );
    expect(presencePrompts(fk.calls)).toHaveLength(promptsBeforeAccounts + 1);
    const foreignXpub = xpubAtSeed(SEED_B, ACCOUNT_84_G1);
    const served = await chainAccount(h, session, hwId, 1, "btc.bip84", BTC_NETWORK);
    expect(strField(served, "xpub")).toBe(foreignXpub);
    expect(foreignXpub).not.toBe(xpubAt(ACCOUNT_84_G1));
    expect(strField(served, "fingerprint")).toBe(hex(MFP));
    expect(boolField(served, "confirmed")).toBe(false);
    expect(arrField(done, "accounts")).toHaveLength(1);

    // A fetch whose material is already pinned adds nothing: no factor, no prompt, no exchange.
    const promptsBeforeRepeat = presencePrompts(fk.calls).length;
    const again = okValue(await h.call("hardware.begin", { op: accountsOp(hwId) }, session));
    expect(strField(field(again, "step"), "kind")).toBe("done");
    expect(presencePrompts(fk.calls)).toHaveLength(promptsBeforeRepeat);

    // A presented factor is consumed even when nothing is missing.
    const promptsBeforePresented = presencePrompts(fk.calls).length;
    const presented = okValue(
      await h.call("hardware.begin", { op: accountsOp(hwId), verify: VERIFY }, session),
    );
    expect(strField(field(presented, "step"), "kind")).toBe("done");
    expect(presencePrompts(fk.calls)).toHaveLength(promptsBeforePresented + 1);
  });

  it("exporting an unconfirmed node needs the acknowledgement and shows a danger row", async () => {
    const { fk, h, session } = await ledgerHarness();
    const paired = await runOp(
      h,
      session,
      await h.call(
        "hardware.begin",
        { op: { kind: "pair", device: "ledger" }, verify: VERIFY },
        session,
      ),
      PAIR_SCRIPT,
    );
    const hwId = strField(field(paired, "wallet"), "walletId");
    await runOp(
      h,
      session,
      await h.call("hardware.begin", { op: accountsOp(hwId), verify: VERIFY }, session),
      [
        appAndVersionStep("bitcoin"),
        okHex(hex(FINGERPRINT)),
        okHex(utf8Hex(xpubAtSeed(SEED_B, ACCOUNT_84_G1))),
      ],
    );

    const exportBase = {
      walletId: hwId,
      groupIndex: 1,
      nodes: [{ kind: "btc.account", template: "btc.bip84", network: BTC_NETWORK }],
      verify: VERIFY,
    };
    const promptsBefore = presencePrompts(fk.calls).length;
    expect(errCode(await h.call("chain.exportAccount", exportBase, session))).toBe(
      "approval-required",
    );
    // Refused before any prompt or verification.
    expect(presencePrompts(fk.calls)).toHaveLength(promptsBefore);

    const exported = okValue(
      await h.call("chain.exportAccount", { ...exportBase, acknowledgeUnconfirmed: true }, session),
    );
    expect(arrField(exported, "keys")).toHaveLength(1);
    const { description } = lastPrompt(fk);
    expect(description).toContain(
      "⚠ Not confirmed on the device — check an address of this account on the device first: m/84'/0'/1'",
    );
    // The danger row precedes the node row.
    const lines = description.split("\n");
    expect(lines[1]).toContain("Not confirmed on the device");
    expect(lines[2]).toContain("Bitcoin Native SegWit");
  });

  it("verify-address takes no factor and a wrong-device verdict commits nothing", async () => {
    const { h, session } = await ledgerHarness();
    const paired = await runOp(
      h,
      session,
      await h.call(
        "hardware.begin",
        { op: { kind: "pair", device: "ledger" }, verify: VERIFY },
        session,
      ),
      PAIR_SCRIPT,
    );
    const hwId = strField(field(paired, "wallet"), "walletId");

    // Merge a foreign evm node (no pinned evm entry — trust-on-first-use answers straight).
    const evmOp = {
      kind: "accounts" as const,
      walletId: hwId,
      groupIndex: 0,
      templates: ["evm.bip44"],
      network: EVM_NETWORK,
    };
    await runOp(
      h,
      session,
      await h.call("hardware.begin", { op: evmOp, verify: VERIFY }, session),
      [appAndVersionStep("ethereum"), ethNodeReply(SEED_B, EVM_ACCOUNT)],
    );
    expect(
      boolField(await chainAccount(h, session, hwId, 0, "evm.bip44", EVM_NETWORK), "confirmed"),
    ).toBe(false);

    const verifyOp = {
      kind: "verify-address" as const,
      walletId: hwId,
      groupIndex: 0,
      template: "evm.bip44",
      network: EVM_NETWORK,
    };
    expect(errCode(await h.call("hardware.begin", { op: verifyOp, verify: VERIFY }, session))).toBe(
      "invalid-input",
    );

    /* The genuine device shows its own address for the leaf — not the foreign entry's. The
       compare misses, the op is wrong-device, and the pin keeps the entry unconfirmed. */
    const begin = okValue(await h.call("hardware.begin", { op: verifyOp }, session));
    const opId = strField(begin, "opId");
    // requiredApp first, then the get-address display request.
    let res = await h.call(
      "hardware.step",
      { opId, response: { kind: "message", data: unhex(appAndVersionStep("ethereum")) } },
      session,
    );
    res = await h.call(
      "hardware.step",
      {
        opId,
        response: {
          kind: "message",
          data: unhex(ethAddressReply(SEED, EVM_LEAF_G0).response),
        },
      },
      session,
    );
    expect(errCode(res)).toBe("wrong-device");
    expect(
      boolField(await chainAccount(h, session, hwId, 0, "evm.bip44", EVM_NETWORK), "confirmed"),
    ).toBe(false);
  });
});

/** Keystore harness + the seed-backed fake device as every slot's driver. */
const bootFake = async () => {
  const fk = fakeKeystore();
  const device = fakeDevice(SEED);
  const h = createHarness({
    keystore: fk.keystore,
    drivers: { keystone: device.driver, ledger: device.driver, onekey: ONEKEY_DRIVER },
    idleMs: 60_000,
  });
  await h.settle();
  const res = okValue(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: { kind: "device" },
    }),
  );
  return { fk, device, h, session: strField(res, "session") };
};

describe("a matched verify-address seals the serving entry confirmed", () => {
  it("confirms the entry every group shares, persisted across lock/unlock", async () => {
    const { device, h, session } = await bootFake();

    // Pair pins the account nodes unconfirmed — every account reports the flag honestly.
    const paired = await runOp(
      h,
      session,
      await h.call(
        "hardware.begin",
        { op: { kind: "pair", device: "keystone" }, verify: VERIFY },
        session,
      ),
      [],
    );
    const hwId = strField(field(paired, "wallet"), "walletId");
    expect(
      boolField(await chainAccount(h, session, hwId, 0, "evm.bip44", EVM_NETWORK), "confirmed"),
    ).toBe(false);
    expect(
      boolField(await chainAccount(h, session, hwId, 0, "btc.bip84", BTC_NETWORK), "confirmed"),
    ).toBe(false);

    /* The fake device answers the host compare on the group-1 leaf. Its serving entry is the
       shared m/44'/60'/0' account node — confirming it confirms every group's EVM account. */
    const verified = await runOp(
      h,
      session,
      await h.call(
        "hardware.begin",
        {
          op: {
            kind: "verify-address",
            walletId: hwId,
            groupIndex: 1,
            template: "evm.bip44",
            network: EVM_NETWORK,
          },
        },
        session,
      ),
      ["matched"],
    );
    expect(strField(verified, "address")).toBe(
      evmAddressFromPublicKey(
        secp256k1.Point.fromBytes(hdAt(SEED, EVM_LEAF_G1).publicKey!).toBytes(false),
      ),
    );
    expect(device.targets.at(-1)?.path).toBe("m/44'/60'/0'/0/1");
    expect(
      boolField(await chainAccount(h, session, hwId, 0, "evm.bip44", EVM_NETWORK), "confirmed"),
    ).toBe(true);
    // The flag survives a lock/unlock — it is committed in the re-sealed record body.
    h.advance(60_001);
    expect(strField(okValue(await h.call("status")), "vault")).toBe("locked");
    const unlocked = okValue(await h.call("vault.unlock", { factor: { kind: "device" } }));
    const session2 = strField(unlocked, "session");
    expect(
      boolField(await chainAccount(h, session2, hwId, 0, "evm.bip44", EVM_NETWORK), "confirmed"),
    ).toBe(true);
    // An entry never verified — the paired btc node — stays unconfirmed.
    expect(
      boolField(await chainAccount(h, session2, hwId, 0, "btc.bip84", BTC_NETWORK), "confirmed"),
    ).toBe(false);
  });
});

describe("hardware sign deadline", () => {
  it("a fiat24-session sign whose deadline lapses during verification never reaches the device", async () => {
    const { fk, device, h, session } = await bootFake();
    const paired = await runOp(
      h,
      session,
      await h.call(
        "hardware.begin",
        { op: { kind: "pair", device: "keystone" }, verify: VERIFY },
        session,
      ),
      [],
    );
    const hwId = strField(field(paired, "wallet"), "walletId");
    okValue(await h.call("vault.setBlindSigning", { enabled: true, verify: VERIFY }, session));

    /* The deadline is inside the window at prepare and lapses while the user is on the
       verification prompt — the post-verify re-check refuses before the executor starts. */
    const deadline = Math.floor(h.wallNow() / 1000) + 600;
    fk.watchOpen(() => h.advanceWall(2_000_000));
    const exchanges = device.requests.length;
    const begin = await h.call(
      "hardware.begin",
      {
        op: {
          kind: "sign",
          request: {
            kind: "evm.fiat24-session",
            network: "eip155:42161",
            account: { kind: "hd", walletId: hwId, groupIndex: 0, template: "evm.bip44" },
            tokenId: "123456",
            deadline,
          },
        },
        verify: VERIFY,
      },
      session,
    );
    expect(errCode(begin)).toBe("invalid-input");
    expect(device.requests).toHaveLength(exchanges);
  });
});

describe("keystone verifyAddress allow-list", () => {
  const stubLink = (response: DeviceResponse): { link: DeviceLink; requests: DeviceRequest[] } => {
    const requests: DeviceRequest[] = [];
    const link: DeviceLink = {
      exchange: async (request: DeviceRequest): Promise<DeviceResponse> => {
        requests.push(request);
        await Promise.resolve();
        return response;
      },
    };
    return { link, requests };
  };
  const pin = { fingerprint: MFP, nodes: [], ed25519: [] };

  it.each([
    ["evm", [H + 44, H + 60, H, 0, 0], "evm.bip44", "eip155:1"],
    ["evm group 99", [H + 44, H + 60, H, 0, 99], "evm.bip44", "eip155:1"],
    ["tron", [H + 44, H + 195, H, 0, 2], "tron.bip44", "tron:mainnet"],
    [
      "solana",
      [H + 44, H + 501, H, H],
      "solana.bip44-change",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ],
    [
      "solana group 5",
      [H + 44, H + 501, H + 5, H],
      "solana.bip44-change",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ],
    [
      "solana group 49",
      [H + 44, H + 501, H + 49, H],
      "solana.bip44-change",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ],
    ["btc bip84", [H + 84, H, H, 0, 3], "btc.bip84", BTC_NETWORK],
    ["btc bip86", [H + 86, H, H, 0, 0], "btc.bip86", BTC_NETWORK],
  ] as const)("%s reaches the compare exchange", async (_name, path, template, network) => {
    const { link, requests } = stubLink({ kind: "compare", matched: true });
    const verdict = await KEYSTONE_DRIVER.verifyAddress(
      link,
      { path: [...path], address: "a", template, network },
      pin,
    );
    expect(requests).toHaveLength(1);
    expect(verdict).toStrictEqual({ method: "compare", matched: true });
  });

  it.each([
    [
      "btc testnet coin 1",
      [H + 84, H + 1, H, 0, 0],
      "btc.bip84",
      "bip122:000000000933ea01ad0ee984209779ba",
    ],
    ["btc group 1", [H + 84, H, H + 1, 0, 0], "btc.bip84", BTC_NETWORK],
    ["btc change chain", [H + 84, H, H, 1, 0], "btc.bip84", BTC_NETWORK],
    ["evm nonzero account", [H + 44, H + 60, H + 1, 0, 0], "evm.bip44", "eip155:1"],
    ["evm hardened leaf", [H + 44, H + 60, H, 0, H], "evm.bip44", "eip155:1"],
    ["index past the firmware max", [H + 44, H + 60, H, 0, 999_999_999], "evm.bip44", "eip155:1"],
    [
      "solana group past the menu",
      [H + 44, H + 501, H + 50, H],
      "solana.bip44-change",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ],
    [
      "solana group past the max",
      [H + 44, H + 501, H + 1_000_000_000, H],
      "solana.bip44-change",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ],
    [
      "solana non-hardened tail",
      [H + 44, H + 501, H, 0],
      "solana.bip44-change",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ],
    ["depth-1 path", [0], "evm.bip44", "eip155:1"],
  ] as const)("%s is unsupported with zero exchanges", async (_name, path, template, network) => {
    const { link, requests } = stubLink({ kind: "compare", matched: true });
    await expect(
      KEYSTONE_DRIVER.verifyAddress(
        link,
        { path: [...path], address: "a", template, network },
        pin,
      ),
    ).rejects.toThrow(KernelError);
    expect(requests).toHaveLength(0);
  });

  it("the solana sub-account bound is the firmware's 49, not the index input max", async () => {
    /* The Web3 menu pre-derives only XPUB_TYPE_SOL_BIP44_CHANGE_0..49: a group past it renders on
       no screen the user could compare, so the driver refuses before any exchange. */
    for (const group of [50, 999_999_998]) {
      const { link, requests } = stubLink({ kind: "compare", matched: true });
      const rejected = KEYSTONE_DRIVER.verifyAddress(
        link,
        {
          path: [H + 44, H + 501, H + group, H],
          address: "a",
          template: "solana.bip44-change",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        },
        pin,
      );
      // oxlint-disable-next-line no-await-in-loop -- each bound case is checked in turn
      await expect(rejected).rejects.toThrow(KernelError);
      // oxlint-disable-next-line no-await-in-loop -- same rejection, asserted for its code
      await expect(rejected).rejects.toMatchObject({ code: "unsupported" });
      expect(requests).toHaveLength(0);
    }
    // Group 49 is the last the menu can show — the compare exchange still goes out.
    const { link, requests } = stubLink({ kind: "compare", matched: true });
    const verdict = await KEYSTONE_DRIVER.verifyAddress(
      link,
      {
        path: [H + 44, H + 501, H + 49, H],
        address: "a",
        template: "solana.bip44-change",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      },
      pin,
    );
    expect(requests).toStrictEqual([
      { kind: "compare", address: "a", path: "m/44'/501'/49'/0'" },
    ]);
    expect(verdict).toStrictEqual({ method: "compare", matched: true });
  });

  it("relays a matched:false compare verdict verbatim", async () => {
    const { link, requests } = stubLink({ kind: "compare", matched: false });
    const verdict = await KEYSTONE_DRIVER.verifyAddress(
      link,
      { path: [H + 44, H + 60, H, 0, 0], address: "a", template: "evm.bip44", network: "eip155:1" },
      pin,
    );
    expect(requests).toHaveLength(1);
    expect(verdict).toStrictEqual({ method: "compare", matched: false });
  });
});
