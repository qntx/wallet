/**
 * Review PoC: hardware-signer "device identity" proofs replay public values only. Ledger
 * `accounts` proves identity by comparing the device-reported master fingerprint (bitcoin) or by
 * re-fetching one pinned public key (ethereum, tron, solana) — all values a foreign device or the
 * main runtime, which owns the transport, observed at pairing and can echo verbatim. OneKey
 * `accounts` trusts the device-reported `root_fingerprint` the same way. A foreign device B that
 * echoes the pinned public identity and then answers with its own keys for not-yet-pinned paths
 * has those keys merged into the pin: the wallet subsequently serves B's material under the
 * paired wallet id. These tests assert today's faulty behaviour so they pass on the current tree
 * and fail once identity is bound to fresh key proof.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import type { KeyPath } from "@qntx/wallet-chains";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import type { DeviceRequest, DeviceResponse, ProtocolValue } from "@qntx/wallet/protocol";

import { pathToString } from "../../src/derive/pinned.ts";
import type { DeviceLink, HardwarePin } from "../../src/modules/signers/driver.ts";
import { LEDGER_DRIVER } from "../../src/modules/signers/ledger/driver.ts";
import { LEDGER_APPS } from "../../src/modules/signers/ledger/protocol/device.ts";
import { ONEKEY_DRIVER } from "../../src/modules/signers/onekey/driver.ts";
import { encodeMessage } from "../../src/modules/signers/onekey/protocol/frame.ts";
import { Features, PublicKey } from "../../src/modules/signers/onekey/protocol/messages.ts";
import { encode } from "../../src/modules/signers/onekey/protocol/proto.ts";
import type { Decoded, Fields, MessageDef } from "../../src/modules/signers/onekey/protocol/proto.ts";
import type { KeystorePrompt } from "../../src/platform.ts";
import { createHarness } from "../harness.ts";
import type { Harness, KernelResponse } from "../harness.ts";
import { fakeKeystore } from "../keystore.ts";
import type { KeystoreCall } from "../keystore.ts";
import { edAt, masterFingerprint, nodeAt } from "../signers-fake.ts";
import {
  hex,
  ok as okHex,
  scriptedLedger,
  SEED,
  unhex,
  utf8Hex,
  vectorCase,
  xpubAt,
} from "../signers-ledger-fake.ts";

const H = 0x80_00_00_00;
const SEED_B = new Uint8Array(64).fill(0xb0);
const FINGERPRINT = unhex(vectorCase("bitcoin", "fingerprint").result as string);
const MFP = masterFingerprint(SEED);
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const ACCOUNT_44: KeyPath = [H + 44, H, H];
const ACCOUNT_84: KeyPath = [H + 84, H, H];
const ACCOUNT_84_G1: KeyPath = [H + 84, H, H + 1];
const SOL_PATH: KeyPath = [H + 44, H + 501, H, H];
const SOL_PATH_G1: KeyPath = [H + 44, H + 501, H + 1, H];
const ETH_PINNED: KeyPath = [H + 44, H + 60, H + 1];
const ETH_NEW: KeyPath = [H + 44, H + 60, H + 2];

/** The paired device: the fingerprint plus the group-0 bitcoin nodes `pair` pins. */
const pin: HardwarePin = {
  fingerprint: FINGERPRINT,
  nodes: [nodeAt(SEED, ACCOUNT_84), nodeAt(SEED, ACCOUNT_44)],
  ed25519: [],
};

const fingerprintStep = (bytes: Uint8Array = FINGERPRINT) => ({ response: okHex(hex(bytes)) });

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

describe("ledger accounts accepts a foreign device echoing the pin", () => {
  it("bitcoin: the echoed fingerprint passes and B's xpub is served for the new path", async () => {
    const fake = scriptedLedger("bitcoin", [
      fingerprintStep(), // the pin's fingerprint is a public value — B replays it
      { response: okHex(utf8Hex(xpubAtSeed(SEED_B, ACCOUNT_84_G1))) },
    ]);
    const result = await LEDGER_DRIVER.accounts(
      fake.link,
      { secp256k1: [ACCOUNT_84_G1], ed25519: [] },
      pin,
    );
    expect(result.nodes).toHaveLength(1);
    expect(hex(result.nodes[0]!.publicKey)).toBe(hex(hdAt(SEED_B, ACCOUNT_84_G1).publicKey!));
    expect(hex(result.nodes[0]!.publicKey)).not.toBe(hex(hdAt(SEED, ACCOUNT_84_G1).publicKey!));
    fake.done();
  });

  it("solana: the echoed pinned leaf passes and B's ed25519 key is served", async () => {
    const pinnedSol: HardwarePin = { ...pin, ed25519: [edAt(SEED, SOL_PATH)] };
    const fake = scriptedLedger("solana", [
      { response: okHex(hex(edAt(SEED, SOL_PATH).publicKey)) }, // echo of the pinned public key
      { response: okHex(hex(edAt(SEED_B, SOL_PATH_G1).publicKey)) },
    ]);
    const result = await LEDGER_DRIVER.accounts(
      fake.link,
      { secp256k1: [], ed25519: [SOL_PATH_G1] },
      pinnedSol,
    );
    expect(result.ed25519).toHaveLength(1);
    expect(hex(result.ed25519[0]!.publicKey)).toBe(hex(edAt(SEED_B, SOL_PATH_G1).publicKey));
    expect(hex(result.ed25519[0]!.publicKey)).not.toBe(hex(edAt(SEED, SOL_PATH_G1).publicKey));
    fake.done();
  });

  it("ethereum: the echoed pinned node passes and B's node is served", async () => {
    const pinnedEth: HardwarePin = {
      ...pin,
      nodes: [...pin.nodes, nodeAt(SEED, ETH_PINNED)],
    };
    const fake = scriptedLedger("ethereum", [
      ethNodeReply(SEED, ETH_PINNED), // echo of the pinned public node
      ethNodeReply(SEED_B, ETH_NEW),
    ]);
    const result = await LEDGER_DRIVER.accounts(
      fake.link,
      { secp256k1: [ETH_NEW], ed25519: [] },
      pinnedEth,
    );
    const foreign = hdAt(SEED_B, ETH_NEW);
    expect(result.nodes).toStrictEqual([
      { path: ETH_NEW, publicKey: foreign.publicKey, chainCode: foreign.chainCode },
    ]);
    expect(hex(result.nodes[0]!.publicKey)).not.toBe(hex(hdAt(SEED, ETH_NEW).publicKey!));
    fake.done();
  });
});

/* OneKey scripted DeviceLink — the same queue-responder the driver tests use. */
const reply = <F extends Fields>(def: MessageDef<F>, value: Decoded<F>): DeviceResponse => ({
  kind: "message",
  data: encodeMessage(def.typeId, encode(def, value)),
});

const PRO = reply(Features, {
  majorVersion: 2,
  minorVersion: 99,
  patchVersion: 99,
  initialized: true,
  capabilities: [],
  onekeyDeviceType: 5,
  onekeyFirmwareVersion: "4.21.0",
});

const fingerprintNumber = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);

const onekeyNodeReply = (
  path: ReadonlyArray<number>,
  seed: Uint8Array,
  root: Uint8Array,
): DeviceResponse => {
  const hd = HDKey.fromMasterSeed(seed).derive(pathText([...path]));
  if (hd.publicKey === null || hd.chainCode === null) {
    throw new Error("cannot derive node fixture");
  }
  return reply(PublicKey, {
    node: {
      depth: hd.depth,
      fingerprint: hd.parentFingerprint,
      childNum: hd.index,
      chainCode: hd.chainCode,
      publicKey: hd.publicKey,
    },
    xpub: hd.publicExtendedKey,
    rootFingerprint: fingerprintNumber(root),
  });
};

const scripted = (responses: DeviceResponse[]): { link: DeviceLink; requests: DeviceRequest[] } => {
  const requests: DeviceRequest[] = [];
  const link: DeviceLink = {
    exchange: async (request: DeviceRequest): Promise<DeviceResponse> => {
      requests.push(request);
      const next = responses.shift();
      if (next === undefined) {
        return Promise.reject(new Error("scripted device ran out of responses"));
      }
      return Promise.resolve(next);
    },
  };
  return { link, requests };
};

describe("onekey accounts trusts the device-reported root fingerprint", () => {
  it("a foreign device claiming the pin fingerprint merges B's node for a new path", async () => {
    const TRON_G1: KeyPath = [H + 44, H + 195, H + 1];
    const onekeyPin: HardwarePin = {
      fingerprint: MFP,
      nodes: [ACCOUNT_44, ACCOUNT_84].map((path) => nodeAt(SEED, path)),
      ed25519: [edAt(SEED, SOL_PATH)],
    };
    const { link } = scripted([PRO, onekeyNodeReply(TRON_G1, SEED_B, MFP)]);
    const result = await ONEKEY_DRIVER.accounts(link, { secp256k1: [TRON_G1], ed25519: [] }, onekeyPin);
    expect(result.nodes).toHaveLength(1);
    expect(hex(result.nodes[0]!.publicKey)).toBe(hex(hdAt(SEED_B, TRON_G1).publicKey!));
    expect(hex(result.nodes[0]!.publicKey)).not.toBe(hex(hdAt(SEED, TRON_G1).publicKey!));
    expect(result.fingerprint).toStrictEqual(MFP);
  });
});

/* ---- end to end through hardware.begin/step with the real LEDGER_DRIVER ---- */

function okValue(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
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
const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

const presencePrompts = (calls: ReadonlyArray<KeystoreCall>): KeystorePrompt[] =>
  calls.flatMap((call) =>
    call.op === "open" && call.protection === "presence" && call.prompt !== undefined
      ? [call.prompt]
      : [],
  );

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
  responses: string[],
): Promise<ProtocolValue> => {
  const queue = [...responses];
  const opId = strField(okValue(begin), "opId");
  let step = field(okValue(begin), "step");
  for (let guard = 0; strField(step, "kind") === "exchange" && guard < 64; guard++) {
    const request = field(step, "request");
    if (strField(request, "kind") !== "message") {
      throw new Error(`expected a message request, got ${JSON.stringify(request)}`);
    }
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unscripted exchange ${hex(bytesField(request, "data"))}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- the coroutine advances one turn per step
    const res = await h.call(
      "hardware.step",
      { opId, response: { kind: "message", data: unhex(next) } },
      session,
    );
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
  fingerprintStep().response,
  ...[ACCOUNT_44, [H + 49, H, H], ACCOUNT_84, [H + 86, H, H]].map(
    (path) => okHex(utf8Hex(xpubAt(path))),
  ),
];

const ACCOUNTS_OP = (walletId: string) => ({
  kind: "accounts",
  walletId,
  groupIndex: 1,
  templates: ["btc.bip84"],
  network: BTC_NETWORK,
});

describe("hardware.begin accounts end to end — foreign device merges into the pin", () => {
  it("a paired ledger serves B's group-1 account after B echoes the fingerprint", async () => {
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
    const session = strField(res, "session");

    /* Pair the genuine device — the fingerprint and the four group-0 xpubs are all plaintext on
       the transport, so the main runtime (or a foreign device) knows the pin's whole identity. */
    const paired = await runOp(
      h,
      session,
      await h.call("hardware.begin", { op: { kind: "pair", device: "ledger" } }, session),
      PAIR_SCRIPT,
    );
    const hwId = strField(field(paired, "wallet"), "walletId");

    const before = fk.calls.length;
    const done = await runOp(
      h,
      session,
      await h.call("hardware.begin", { op: ACCOUNTS_OP(hwId) }, session),
      [
        appAndVersionStep("bitcoin"),
        fingerprintStep().response, // echo — not B's fingerprint
        okHex(utf8Hex(xpubAtSeed(SEED_B, ACCOUNT_84_G1))),
      ],
    );
    /* No verifying factor was asked for at any point in the accounts op. */
    expect(presencePrompts(fk.calls.slice(before))).toHaveLength(0);

    const accounts = arrField(done, "accounts");
    expect(accounts).toHaveLength(1);
    const foreignXpub = xpubAtSeed(SEED_B, ACCOUNT_84_G1);
    expect(strField(accounts[0]!, "xpub")).toBe(foreignXpub);
    /* The account still wears the paired fingerprint — the record claims the original device. */
    expect(strField(accounts[0]!, "fingerprint")).toBe(hex(MFP));
    expect(foreignXpub).not.toBe(xpubAt(ACCOUNT_84_G1));

    /* The merged pin now serves B's node with no device exchange at all. */
    const again = okValue(
      await h.call("hardware.begin", { op: ACCOUNTS_OP(hwId) }, session),
    );
    expect(strField(field(again, "step"), "kind")).toBe("done");
    const againAccounts = arrField(field(field(again, "step"), "result"), "accounts");
    expect(strField(againAccounts[0]!, "xpub")).toBe(foreignXpub);

    /* wallet.accounts resolves the same foreign material under the paired wallet id. */
    const served = okValue(
      await h.call(
        "wallet.accounts",
        { walletId: hwId, groupIndex: 1, template: "btc.bip84", network: BTC_NETWORK },
        session,
      ),
    );
    expect(strField(served, "xpub")).toBe(foreignXpub);
  });
});
