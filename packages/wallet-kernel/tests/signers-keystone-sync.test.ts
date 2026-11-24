// oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test -- assertions live in the parse/integrity helpers and the per-variant loops
/**
 * The Keystone sync: the generator's `crypto-multi-accounts` — built by an independent encoder over
 * keys derived in `scripts/vectors/keystone.ts` — decodes to exactly the whitelisted pins, the
 * firmware's own test URs decode the way the Rust tests assert, and every malformed or hostile
 * variant (truncation, flipped tags, duplicate keys, non-shortest ints, a trailing byte, a foreign
 * origin fingerprint, private/master keys, bad key material, no usable key) is `integrity`. The
 * tail runs `pair` and `verifyAddress` through the real driver and pairs a kernel end to end
 * against the production driver.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CborMap, Tag, cbor, encodeCbor, taggedValue } from "@blockchaincommons/dcbor";
import type { Cbor, CborInput } from "@blockchaincommons/dcbor";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { publicKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { cryptoMultiAccountsCodec } from "@qntx/ur/interop";
import type { DeviceRequest, DeviceResponse, ProtocolValue } from "@qntx/wallet/protocol";

import { fingerprintBytes } from "../src/derive/pinned.ts";
import { KernelError } from "../src/errors.ts";
import type { DeviceLink } from "../src/modules/signers/driver.ts";
import { KEYSTONE_DRIVER } from "../src/modules/signers/keystone/driver.ts";
import { decodeRegistry } from "../src/modules/signers/keystone/registry.ts";
import { parseSync } from "../src/modules/signers/keystone/sync.ts";
import { hardwareWalletId } from "../src/modules/signers/record.ts";
import type { KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";

const HARDENED = 0x80000000;

type WantedNode = {
  path: string;
  publicKey: string;
  chainCode: string;
  parentFingerprint: string;
};
type WantedEd = { path: string; publicKey: string };
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/keystone/sync.json"), "utf8"),
) as {
  mnemonic: string;
  sync: {
    type: string;
    cbor: string;
    masterFingerprint: string;
    device: string;
    deviceVersion: string;
    deviceId: string;
    pinned: { nodes: WantedNode[]; ed25519: WantedEd[] };
  };
  firmware: Array<{
    name: string;
    source: string;
    ur: string;
    cbor: string;
    firstKey: { path: string; depth?: number; publicKey?: string; chainCode?: string };
  }>;
  registryEncode: {
    cbor: string;
    masterFingerprint: string;
    device: string;
    deviceVersion: string;
    deviceId: string;
  };
};

const SEED = mnemonicToSeedSync(vectors.mnemonic);
const SYNC = hexToBytes(vectors.sync.cbor);
const MFP = hexToBytes(vectors.sync.masterFingerprint);

const qrResponse = (cbor: Uint8Array, type = "crypto-multi-accounts"): DeviceResponse => ({
  kind: "qr",
  ur: { type, cbor },
});

const parse = (cbor: Uint8Array, type?: string): ReturnType<typeof parseSync> =>
  parseSync(qrResponse(cbor, type));

const code = (run: () => unknown): string => {
  try {
    run();
    return "no-error";
  } catch (error) {
    return error instanceof KernelError ? error.code : "not-a-kernel-error";
  }
};

const integrity = (cbor: Uint8Array, type?: string): void => {
  expect(code(() => parse(cbor, type))).toBe("integrity");
};

const pathNumbers = (path: string): number[] =>
  path
    .replace(/^m\//, "")
    .split("/")
    .map((segment) =>
      segment.endsWith("'") ? Number(segment.slice(0, -1)) + HARDENED : Number(segment),
    );

const origin = (path: string): Cbor => {
  const map = new CborMap();
  map.set(
    1,
    pathNumbers(path).flatMap((index): CborInput[] => [index % HARDENED, index >= HARDENED]),
  );
  map.set(2, new DataView(MFP.buffer).getUint32(0));
  return taggedValue(Tag.from(304, "crypto-keypath"), cbor(map));
};

const hdkey = (path: string, fields: ReadonlyArray<readonly [number, CborInput]>): Cbor => {
  const map = new CborMap();
  map.set(6, origin(path));
  for (const [n, value] of fields) {
    map.set(n, value);
  }
  return taggedValue(Tag.from(303, "crypto-hdkey"), cbor(map));
};

const syncWith = (keys: ReadonlyArray<CborInput>): Uint8Array =>
  encodeCbor(
    cbor(
      new CborMap(
        new Map<number, CborInput>([
          [1, new DataView(MFP.buffer).getUint32(0)],
          [2, [...keys]],
        ]),
      ),
    ),
  );

const accounts = (bytes: Uint8Array): ReturnType<typeof cryptoMultiAccountsCodec.decode> =>
  decodeRegistry(bytes, cryptoMultiAccountsCodec);

const derivedNode = (path: string): { key: Uint8Array; chainCode: Uint8Array } => {
  const node = HDKey.fromMasterSeed(SEED).derive(path);
  if (node.publicKey === null || node.chainCode === null) {
    throw new Error(`no node at ${path}`);
  }
  return { key: node.publicKey, chainCode: node.chainCode };
};

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
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

describe("the generated sync vector", () => {
  it("parses as crypto-multi-accounts with the device metadata", () => {
    const parsed = accounts(SYNC);
    expect(bytesToHex(fingerprintBytes(parsed.masterFingerprint))).toBe(
      vectors.sync.masterFingerprint,
    );
    expect(parsed.device).toBe(vectors.sync.device);
    expect(parsed.version).toBe(vectors.sync.deviceVersion);
    expect(parsed.deviceId).toBe(vectors.sync.deviceId);
    expect(parsed.keys).toHaveLength(17);
  });

  it("pins exactly the whitelisted nodes and ed25519 keys", () => {
    const result = parse(SYNC);
    expect(bytesToHex(result.fingerprint)).toBe(vectors.sync.masterFingerprint);
    expect(result.model).toBe(vectors.sync.device);
    expect(result.firmware).toBe(vectors.sync.deviceVersion);
    expect(result.nodes).toHaveLength(6);
    expect(result.ed25519).toHaveLength(2);
    for (const wanted of vectors.sync.pinned.nodes) {
      const node = result.nodes.find((n) => bytesToHex(n.publicKey) === wanted.publicKey);
      expect(node).toBeDefined();
      expect(node?.path).toStrictEqual(pathNumbers(wanted.path));
      expect(node?.chainCode).toStrictEqual(hexToBytes(wanted.chainCode));
      expect(node?.parent).toStrictEqual(hexToBytes(wanted.parentFingerprint));
    }
    for (const wanted of vectors.sync.pinned.ed25519) {
      const key = result.ed25519.find((e) => bytesToHex(e.publicKey) === wanted.publicKey);
      expect(key).toBeDefined();
      expect(key?.path).toStrictEqual(pathNumbers(wanted.path));
    }
  });
});

describe("the firmware's own test URs", () => {
  it("decodes the two-key capture the Rust test asserts", () => {
    const [vector] = vectors.firmware;
    if (vector === undefined) {
      throw new Error("missing firmware vector");
    }
    const parsed = accounts(hexToBytes(vector.cbor));
    const [first] = parsed.keys;
    if (first === undefined || first.key.origin === undefined) {
      throw new Error("first key has no origin");
    }
    const path = first.key.origin.components
      .map(
        (component) =>
          `${component.kind === "index" ? component.index : ""}${
            component.kind !== "pair" && component.hardened ? "'" : ""
          }`,
      )
      .join("/");
    expect(`m/${path}`).toBe(vector.firstKey.path);
    expect(bytesToHex(first.key.keyData)).toBe(vector.firstKey.publicKey);
    expect(first.key.chainCode === undefined ? "" : bytesToHex(first.key.chainCode)).toBe(
      vector.firstKey.chainCode,
    );
    // One secp256k1 node and one ed25519 leaf pin; the rest parses and is ignored.
    const result = parse(hexToBytes(vector.cbor));
    expect(result.nodes.map((n) => n.path)).toStrictEqual([pathNumbers("m/44'/60'/0'")]);
    expect(result.ed25519.map((e) => e.path)).toStrictEqual([pathNumbers("m/44'/501'/0'")]);
  });

  it("decodes the six-ed25519 capture and pins the whitelisted leaf", () => {
    const [, vector] = vectors.firmware;
    if (vector === undefined) {
      throw new Error("missing firmware vector");
    }
    const parsed = accounts(hexToBytes(vector.cbor));
    expect(parsed.keys).toHaveLength(6);
    const [first] = parsed.keys;
    if (first === undefined || first.key.origin === undefined) {
      throw new Error("first key has no origin");
    }
    const path = first.key.origin.components
      .map(
        (component) =>
          `${component.kind === "index" ? component.index : ""}${
            component.kind !== "pair" && component.hardened ? "'" : ""
          }`,
      )
      .join("/");
    expect(`m/${path}`).toBe(vector.firstKey.path);
    expect(first.key.origin.depth).toBe(vector.firstKey.depth);
    const result = parse(hexToBytes(vector.cbor));
    expect(result.nodes).toHaveLength(0);
    expect(result.ed25519.map((e) => e.path)).toStrictEqual([pathNumbers("m/44'/501'/0'/0'")]);
  });

  it("parses the crate's encode-test shape but refuses to pin it", () => {
    const encode = vectors.registryEncode;
    const parsed = accounts(hexToBytes(encode.cbor));
    expect(bytesToHex(fingerprintBytes(parsed.masterFingerprint))).toBe(encode.masterFingerprint);
    expect(parsed.device).toBe(encode.device);
    expect(parsed.version).toBe(encode.deviceVersion);
    expect(parsed.deviceId).toBe(encode.deviceId);
    // A 33-byte secp256k1 key on an ed25519 path is a structural lie — integrity.
    integrity(hexToBytes(encode.cbor));
  });
});

describe("malformed sync variants are integrity", () => {
  it("rejects every prefix of the sync payload", () => {
    for (let i = 0; i < SYNC.length; i++) {
      expect(code(() => parse(SYNC.subarray(0, i)))).toBe("integrity");
    }
  });

  it("rejects a trailing byte", () => {
    integrity(new Uint8Array([...SYNC, 0x00]));
  });

  it("rejects flipped registry tags", () => {
    // 303 → 304 on every crypto-hdkey item, then 304 → 320 on every crypto-keypath.
    for (const [pattern, swap] of [
      [hexToBytes("d9012f"), hexToBytes("d90130")],
      [hexToBytes("d90130"), hexToBytes("d90140")],
    ] as const) {
      for (let at = 0; at < SYNC.length - 2; at++) {
        if (SYNC[at] === pattern[0] && SYNC[at + 1] === pattern[1] && SYNC[at + 2] === pattern[2]) {
          const flipped = new Uint8Array(SYNC);
          flipped[at + 1] = swap[1]!;
          flipped[at + 2] = swap[2]!;
          integrity(flipped);
        }
      }
    }
  });

  it("rejects a non-shortest master fingerprint slot", () => {
    // `1a` ‖ mfp rewritten as `1b` ‖ 00000000 ‖ mfp — the same value in an eight-byte slot.
    const widened = new Uint8Array([...SYNC.subarray(0, 2), 0x1b, 0, 0, 0, 0, ...SYNC.subarray(3)]);
    integrity(widened);
  });

  it("rejects a foreign origin fingerprint", () => {
    // `02 1a <mfp>` inside a keypath map is the origin's source fingerprint; pointing it at
    // another master makes the key unattributable.
    const foreign = new Uint8Array(SYNC);
    let patched = 0;
    for (let at = 0; at < foreign.length - 5; at++) {
      if (foreign[at] === 0x02 && foreign[at + 1] === 0x1a) {
        foreign.set([0xde, 0xad, 0xbe, 0xef], at + 2);
        patched++;
      }
    }
    expect(patched).toBeGreaterThan(0);
    integrity(foreign);
  });

  it("rejects duplicate map keys in a hand-built sync", () => {
    integrity(hexToBytes("a2011a01020304011a05060708"));
  });

  it("rejects two pinnable keys claiming the same path", () => {
    const first = derivedNode("m/44'/60'/0'");
    const second = derivedNode("m/44'/0'/0'");
    const both = [
      [3, first.key],
      [4, first.chainCode],
    ] as const;
    // Different material on the same claimed path is still an ambiguity, not a skip.
    integrity(
      syncWith([
        hdkey("m/44'/60'/0'", [...both]),
        hdkey("m/44'/60'/0'", [
          [3, second.key],
          [4, second.chainCode],
        ]),
      ]),
    );
  });

  it("rejects a sync whose only whitelisted keys are private or master", () => {
    const { key, chainCode } = derivedNode("m/44'/0'/0'");
    const asPrivate = hdkey("m/44'/0'/0'", [
      [2, true],
      [3, key],
      [4, chainCode],
    ]);
    const asMaster = hdkey("m/44'/0'/0'", [
      [1, true],
      [3, key],
      [4, chainCode],
    ]);
    integrity(syncWith([asPrivate]));
    integrity(syncWith([asMaster]));
  });

  it("rejects malformed key material on a whitelisted path", () => {
    const { key, chainCode } = derivedNode("m/44'/0'/0'");
    const key32 = key.subarray(0, 32);
    const wrongKeyLength = hdkey("m/44'/0'/0'", [
      [3, key32],
      [4, chainCode],
    ]);
    const wrongChainCode = hdkey("m/44'/0'/0'", [
      [3, key],
      [4, chainCode.subarray(0, 31)],
    ]);
    const missingChainCode = hdkey("m/44'/0'/0'", [[3, key]]);
    const offCurve = new Uint8Array(key);
    offCurve[0] = 0x04; // an uncompressed prefix in a compressed slot is not a point
    const badPoint = hdkey("m/44'/0'/0'", [
      [3, offCurve],
      [4, chainCode],
    ]);
    // A 65-byte uncompressed encoding is a valid point but not the wire form a node pins.
    const uncompressed = hdkey("m/44'/0'/0'", [
      [3, secp256k1.Point.fromBytes(key).toBytes(false)],
      [4, chainCode],
    ]);
    integrity(syncWith([wrongKeyLength]));
    integrity(syncWith([wrongChainCode]));
    integrity(syncWith([missingChainCode]));
    integrity(syncWith([badPoint]));
    integrity(syncWith([uncompressed]));
    const [ed] = vectors.sync.pinned.ed25519;
    if (ed === undefined) {
      throw new Error("missing ed25519 pin");
    }
    const wrongEdLength = hdkey(ed.path, [[3, hexToBytes(ed.publicKey).subarray(0, 31)]]);
    integrity(syncWith([wrongEdLength]));
  });

  it("rejects a sync with no usable key", () => {
    const { key, chainCode } = derivedNode("m/44'/3'/0'");
    integrity(
      syncWith([
        hdkey("m/44'/3'/0'", [
          [3, key],
          [4, chainCode],
        ]),
      ]),
    );
    integrity(syncWith([]));
  });

  it("rejects a wrong response kind and a wrong UR type", () => {
    expect(code(() => parseSync({ kind: "message", data: utf8ToBytes("x") }))).toBe("integrity");
    expect(code(() => parse(SYNC, "crypto-psbt"))).toBe("integrity");
  });

  it("rejects the payload wrapped in the crypto-multi-accounts tag", () => {
    // The UR's type carries the tag — the payload is exactly the bare map.
    const { key, chainCode } = derivedNode("m/44'/0'/0'");
    const shallow = syncWith([
      hdkey("m/44'/0'/0'", [
        [3, key],
        [4, chainCode],
      ]),
    ]);
    integrity(new Uint8Array([0xd9, 0x04, 0x4f, ...shallow]));
  });
});

describe("the keystone driver", () => {
  /** A one-response link that records the request it was handed. */
  const stubLink = (response: DeviceResponse): { link: DeviceLink; requests: DeviceRequest[] } => {
    const requests: DeviceRequest[] = [];
    return {
      requests,
      link: {
        exchange: async (request) => {
          requests.push(request);
          return Promise.resolve(response);
        },
      },
    };
  };

  it("pair scans crypto-multi-accounts and pins the decoded material", async () => {
    const { link, requests } = stubLink(qrResponse(SYNC));
    const result = await KEYSTONE_DRIVER.pair(link);
    expect(requests).toStrictEqual([{ kind: "qr", scan: ["crypto-multi-accounts"] }]);
    expect(bytesToHex(result.fingerprint)).toBe(vectors.sync.masterFingerprint);
    expect(result.model).toBe(vectors.sync.device);
    expect(result.firmware).toBe(vectors.sync.deviceVersion);
    expect(result.nodes).toHaveLength(6);
    expect(result.ed25519).toHaveLength(2);
  });

  it("verifyAddress posts a compare request and relays the verdict", async () => {
    const { link, requests } = stubLink({ kind: "compare", matched: true });
    const verdict = await KEYSTONE_DRIVER.verifyAddress(
      link,
      {
        path: [44 + HARDENED, 60 + HARDENED, HARDENED, 0, 0],
        address: "0x0000000000000000000000000000000000000001",
        template: "evm.bip44",
        network: "eip155:1",
      },
      { fingerprint: MFP, nodes: [], ed25519: [] },
    );
    expect(requests).toStrictEqual([
      {
        kind: "compare",
        address: "0x0000000000000000000000000000000000000001",
        path: "m/44'/60'/0'/0/0",
      },
    ]);
    expect(verdict).toStrictEqual({ method: "compare", matched: true });
  });

  it("verifyAddress refuses a non-compare answer", async () => {
    const { link } = stubLink({ kind: "message", data: utf8ToBytes("yes") });
    await expect(
      KEYSTONE_DRIVER.verifyAddress(
        link,
        {
          path: [0],
          address: "a",
          template: "evm.bip44",
          network: "eip155:1",
        },
        { fingerprint: MFP, nodes: [], ed25519: [] },
      ),
    ).rejects.toThrow(KernelError);
  });
});

describe("pairing a kernel end to end", () => {
  it("commits a hardware-wallet record that serves the pinned accounts", async () => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: {
          kind: "passkey",
          credentialId: utf8ToBytes("credential-1"),
          prf: new Uint8Array(32).fill(0x50),
        },
      }),
    );
    const session = strField(res, "session");
    const begin = ok(
      await h.call("hardware.begin", { op: { kind: "pair", device: "keystone" } }, session),
    );
    expect(field(field(begin, "step"), "request")).toStrictEqual({
      kind: "qr",
      scan: ["crypto-multi-accounts"],
    });
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
    const wallet = field(field(done, "result"), "wallet");
    expect(strField(wallet, "custody")).toBe("hardware");
    const walletId = strField(wallet, "walletId");
    expect(walletId).toBe(hardwareWalletId("keystone", MFP));
    expect(strField(wallet, "model")).toBe(vectors.sync.device);
    expect(strField(wallet, "firmware")).toBe(vectors.sync.deviceVersion);

    // The pinned m/44'/60'/0' node publicly derives the first ethereum account.
    const accounts = ok(
      await h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
        session,
      ),
    );
    const pub = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'/0/0").publicKey;
    if (pub === null) {
      throw new Error("no leaf key");
    }
    const oracle = publicKeyToAddress(
      `0x${bytesToHex(secp256k1.Point.fromBytes(pub).toBytes(false))}`,
    );
    expect(strField(accounts, "address")).toBe(oracle);
  });
});
