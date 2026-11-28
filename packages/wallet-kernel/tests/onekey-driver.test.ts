/**
 * The OneKey Driver against a scripted DeviceLink: pairing publishes the six secp256k1 account
 * nodes plus the SLIP-10 solana leaf and cross-checks the leaf addresses, accounts re-proves the
 * fingerprint, verifyAddress shows the target, display classifies from the record's claimed
 * identity, and sign refuses wrong devices, display drift and every mapped device failure.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinAddressFromXpub } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type { ChainSignRequest, DeviceRequest, DeviceResponse } from "@qntx/wallet/protocol";

import { pathToString } from "../src/derive/pinned.ts";
import { KernelError } from "../src/errors.ts";
import type { ChainPlan } from "../src/modules/chains/run.ts";
import type { DeviceLink, HardwarePin, SignContext } from "../src/modules/signers/driver.ts";
import { ONEKEY_DRIVER } from "../src/modules/signers/onekey/driver.ts";
import { decodeMessage, encodeMessage } from "../src/modules/signers/onekey/protocol/frame.ts";
import {
  Address,
  EthereumAddressOneKey,
  EthereumMessageSignatureOneKey,
  Failure,
  Features,
  GetAddress,
  GetPublicKey,
  Initialize,
  PublicKey,
  SolanaAddress,
  SolanaGetAddress,
  TronAddress,
} from "../src/modules/signers/onekey/protocol/messages.ts";
import type { Decoded, Fields, MessageDef } from "../src/modules/signers/onekey/protocol/proto.ts";
import { decode, encode } from "../src/modules/signers/onekey/protocol/proto.ts";
import { edAt, masterFingerprint, nodeAt } from "./signers-fake.ts";

const H = 0x80_00_00_00;
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = mnemonicToSeedSync(MNEMONIC);
const OTHER_SEED = mnemonicToSeedSync(
  "test test test test test test test test test test test junk",
);
const MFP = masterFingerprint(SEED);

const EVM_ACCOUNT = [44 + H, 60 + H, H];
const TRON_ACCOUNT = [44 + H, 195 + H, H];
const BIP44_ACCOUNT = [44 + H, H, H];
const BIP49_ACCOUNT = [49 + H, H, H];
const BIP84_ACCOUNT = [84 + H, H, H];
const BIP86_ACCOUNT = [86 + H, H, H];
const SOLANA_LEAF = [44 + H, 501 + H, H, H];
const EVM_LEAF = [...EVM_ACCOUNT, 0, 0];
const TRON_LEAF = [...TRON_ACCOUNT, 0, 0];
const BTC_LEAF = [...BIP84_ACCOUNT, 0, 0];

const EVM_NETWORK = "eip155:1";
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";

const PIN: HardwarePin = {
  fingerprint: MFP,
  nodes: [
    EVM_ACCOUNT,
    TRON_ACCOUNT,
    BIP44_ACCOUNT,
    BIP49_ACCOUNT,
    BIP84_ACCOUNT,
    BIP86_ACCOUNT,
  ].map((path) => nodeAt(SEED, path)),
  ed25519: [edAt(SEED, SOLANA_LEAF)],
};

const reply = <F extends Fields>(def: MessageDef<F>, value: Decoded<F>): DeviceResponse => ({
  kind: "message",
  data: encodeMessage(def.typeId, encode(def, value)),
});

const features = (
  deviceType: number,
  firmware: string,
  capabilities: number[] = [],
): DeviceResponse =>
  reply(Features, {
    majorVersion: 2,
    minorVersion: 99,
    patchVersion: 99,
    initialized: true,
    capabilities,
    onekeyDeviceType: deviceType,
    onekeyFirmwareVersion: firmware,
  });

const PRO = features(5, "4.21.0");

const fingerprintNumber = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);

const nodeReply = (
  path: ReadonlyArray<number>,
  seed: Uint8Array = SEED,
  root: Uint8Array = masterFingerprint(seed),
): DeviceResponse => {
  const hd = HDKey.fromMasterSeed(seed).derive(pathToString(path));
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

const solanaReply = (path: ReadonlyArray<number>, seed: Uint8Array = SEED): DeviceResponse =>
  reply(SolanaAddress, {
    address: solanaAddressFromPublicKey(edAt(seed, path).publicKey),
  });

const failure = (code: number): DeviceResponse => reply(Failure, { code, message: "device text" });

const evmLeafAddress = evmAddressFromPublicKey(
  HDKey.fromMasterSeed(SEED).derive(pathToString(EVM_LEAF)).publicKey!,
);
const tronLeafAddress = tronAddressFromPublicKey(
  HDKey.fromMasterSeed(SEED).derive(pathToString(TRON_LEAF)).publicKey!,
);
const btcLeafAddress = bitcoinAddressFromXpub(
  HDKey.fromMasterSeed(SEED).derive(pathToString(BIP84_ACCOUNT)).publicExtendedKey,
  "btc.bip84",
  BTC_NETWORK,
  0,
  0,
);
const solanaLeafAddress = solanaAddressFromPublicKey(edAt(SEED, SOLANA_LEAF).publicKey);

/** A DeviceLink that serves queued responses and records every request. */
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

/** Decodes the nth written message request against its schema. */
const writtenMessage = <F extends Fields>(
  requests: DeviceRequest[],
  index: number,
  def: MessageDef<F>,
): Decoded<F> => {
  const request = requests[index];
  if (request === undefined || request.kind !== "message") {
    throw new Error(`request ${index} is not a message`);
  }
  return decode(def, decodeMessage(request.data).payload);
};

async function kernelErrorOf(run: () => Promise<unknown>): Promise<KernelError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof KernelError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a KernelError");
}

const signContext = (
  request: ChainSignRequest,
  stage: ChainPlan,
  display: "clear" | "blind",
): SignContext => ({ request, stage, pin: PIN, display, random: (n) => new Uint8Array(n) });

describe("pair", () => {
  const pairScript = (): DeviceResponse[] => [
    PRO,
    nodeReply(BIP44_ACCOUNT),
    nodeReply(BIP49_ACCOUNT),
    nodeReply(BIP84_ACCOUNT),
    nodeReply(BIP86_ACCOUNT),
    nodeReply(EVM_ACCOUNT),
    nodeReply(TRON_ACCOUNT),
    solanaReply(SOLANA_LEAF),
    reply(EthereumAddressOneKey, { address: evmLeafAddress }),
    reply(TronAddress, { address: tronLeafAddress }),
    reply(Address, { address: btcLeafAddress }),
  ];

  it("publishes the six account nodes, the solana leaf and the device identity", async () => {
    const { link, requests } = scripted(pairScript());
    const result = await ONEKEY_DRIVER.pair(link);
    expect(requests).toHaveLength(11);
    expect(writtenMessage(requests, 0, Initialize).sessionId).toBeUndefined();
    expect(writtenMessage(requests, 1, GetPublicKey).scriptType).toBe(0);
    expect(writtenMessage(requests, 3, GetPublicKey).scriptType).toBe(3);
    expect(writtenMessage(requests, 7, SolanaGetAddress).showDisplay).toBe(false);
    expect(result.fingerprint).toStrictEqual(MFP);
    expect(result.model).toBe("pro");
    expect(result.firmware).toBe("4.21.0");
    expect(result.nodes).toHaveLength(6);
    expect(result.nodes[0]?.path).toStrictEqual(BIP44_ACCOUNT);
    expect(result.ed25519).toStrictEqual([
      { path: SOLANA_LEAF, publicKey: edAt(SEED, SOLANA_LEAF).publicKey },
    ]);
  });

  it("rejects a non-message answer as integrity", async () => {
    const { link } = scripted([{ kind: "compare", matched: true }]);
    const error = await kernelErrorOf(async () => ONEKEY_DRIVER.pair(link));
    expect(error.code).toBe("integrity");
  });

  it("rejects a malformed frame as integrity", async () => {
    const { link } = scripted([{ kind: "message", data: new Uint8Array([0, 1, 2]) }]);
    const error = await kernelErrorOf(async () => ONEKEY_DRIVER.pair(link));
    expect(error.code).toBe("integrity");
  });

  it("rejects a node without a master fingerprint", async () => {
    const script = pairScript();
    const hd = HDKey.fromMasterSeed(SEED).derive(pathToString(BIP44_ACCOUNT));
    script[1] = reply(PublicKey, {
      node: {
        depth: hd.depth,
        fingerprint: hd.parentFingerprint,
        childNum: hd.index,
        chainCode: hd.chainCode!,
        publicKey: hd.publicKey!,
      },
      xpub: hd.publicExtendedKey,
    });
    const { link } = scripted(script);
    const error = await kernelErrorOf(async () => ONEKEY_DRIVER.pair(link));
    expect(error.code).toBe("integrity");
  });

  it("rejects inconsistent master fingerprints across nodes", async () => {
    const script = pairScript();
    script[2] = nodeReply(BIP49_ACCOUNT, OTHER_SEED);
    const { link } = scripted(script);
    const error = await kernelErrorOf(async () => ONEKEY_DRIVER.pair(link));
    expect(error.code).toBe("integrity");
  });

  it("rejects an evm leaf address that does not match the pinned node", async () => {
    const script = pairScript();
    script[8] = reply(EthereumAddressOneKey, {
      address: "0x00000000000000000000000000000000deadbeef",
    });
    const { link } = scripted(script);
    const error = await kernelErrorOf(async () => ONEKEY_DRIVER.pair(link));
    expect(error.code).toBe("integrity");
  });

  it("rejects a tron leaf address that does not match the pinned node", async () => {
    const script = pairScript();
    script[9] = reply(TronAddress, { address: "TDPpJHp6vXcXf7T7oL4fN4gDZ9b8h5p7f1" });
    const { link } = scripted(script);
    const error = await kernelErrorOf(async () => ONEKEY_DRIVER.pair(link));
    expect(error.code).toBe("integrity");
  });

  it("rejects a bitcoin leaf address that does not match the pinned node", async () => {
    const script = pairScript();
    script[10] = reply(Address, {
      address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    });
    const { link } = scripted(script);
    const error = await kernelErrorOf(async () => ONEKEY_DRIVER.pair(link));
    expect(error.code).toBe("integrity");
  });

  it("maps an initialize failure without device text", async () => {
    const { link } = scripted([failure(5)]);
    const error = await kernelErrorOf(async () => ONEKEY_DRIVER.pair(link));
    expect(error.code).toBe("device-locked");
    expect(error.message).not.toContain("device text");
  });
});

describe("accounts", () => {
  it("fetches the requested nodes and keys and returns the pin fingerprint", async () => {
    const { link } = scripted([PRO, nodeReply(BIP44_ACCOUNT), solanaReply(SOLANA_LEAF)]);
    const result = await ONEKEY_DRIVER.accounts(
      link,
      { secp256k1: [BIP44_ACCOUNT], ed25519: [SOLANA_LEAF] },
      PIN,
    );
    expect(result.fingerprint).toStrictEqual(MFP);
    expect(result.nodes[0]?.publicKey).toStrictEqual(PIN.nodes[2]?.publicKey);
    expect(result.ed25519[0]?.path).toStrictEqual(SOLANA_LEAF);
  });

  it("rejects a node reporting a foreign master fingerprint", async () => {
    const { link } = scripted([PRO, nodeReply(BIP44_ACCOUNT, OTHER_SEED)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.accounts(link, { secp256k1: [BIP44_ACCOUNT], ed25519: [] }, PIN),
    );
    expect(error.code).toBe("wrong-device");
  });

  it("probes a pinned secp node on an ed25519-only fetch", async () => {
    const { link, requests } = scripted([
      PRO,
      solanaReply(SOLANA_LEAF),
      nodeReply(PIN.nodes[0]!.path),
    ]);
    const result = await ONEKEY_DRIVER.accounts(
      link,
      { secp256k1: [], ed25519: [SOLANA_LEAF] },
      PIN,
    );
    expect(requests).toHaveLength(3);
    expect(writtenMessage(requests, 2, GetPublicKey).addressN).toStrictEqual([...EVM_ACCOUNT]);
    expect(result.nodes).toHaveLength(0);
    expect(result.ed25519).toHaveLength(1);
  });

  it("rejects an ed25519-only fetch when the probe answers different keys", async () => {
    const { link } = scripted([PRO, solanaReply(SOLANA_LEAF), nodeReply(EVM_ACCOUNT, OTHER_SEED)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.accounts(link, { secp256k1: [], ed25519: [SOLANA_LEAF] }, PIN),
    );
    expect(error.code).toBe("wrong-device");
  });
});

describe("verifyAddress", () => {
  const evmTarget = {
    path: EVM_LEAF,
    address: evmLeafAddress,
    template: "evm.bip44" as const,
    network: EVM_NETWORK,
  };

  it("shows the address on device and reports the match", async () => {
    const { link, requests } = scripted([
      PRO,
      nodeReply(EVM_ACCOUNT),
      reply(EthereumAddressOneKey, { address: evmLeafAddress }),
    ]);
    const verdict = await ONEKEY_DRIVER.verifyAddress(link, evmTarget, PIN);
    expect(verdict).toStrictEqual({ method: "device", matched: true });
    expect(requests).toHaveLength(3);
  });

  it("reports a mismatching shown address as unmatched, not an error", async () => {
    const { link } = scripted([
      PRO,
      nodeReply(EVM_ACCOUNT),
      reply(EthereumAddressOneKey, {
        address: "0x00000000000000000000000000000000deadbeef",
      }),
    ]);
    const verdict = await ONEKEY_DRIVER.verifyAddress(link, evmTarget, PIN);
    expect(verdict).toStrictEqual({ method: "device", matched: false });
  });

  it("refuses a user rejection on the device as device-rejected", async () => {
    const { link } = scripted([PRO, nodeReply(EVM_ACCOUNT), failure(4)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.verifyAddress(link, evmTarget, PIN),
    );
    expect(error.code).toBe("device-rejected");
  });

  it("rejects a device whose account node differs from the pin", async () => {
    const { link } = scripted([PRO, nodeReply(EVM_ACCOUNT, OTHER_SEED)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.verifyAddress(link, evmTarget, PIN),
    );
    expect(error.code).toBe("wrong-device");
  });

  it("shows a solana address and proves the pinned key in one exchange", async () => {
    const { link, requests } = scripted([PRO, solanaReply(SOLANA_LEAF)]);
    const verdict = await ONEKEY_DRIVER.verifyAddress(
      link,
      {
        path: SOLANA_LEAF,
        address: solanaLeafAddress,
        template: "solana.bip44-change",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      },
      PIN,
    );
    expect(verdict).toStrictEqual({ method: "device", matched: true });
    expect(writtenMessage(requests, 1, SolanaGetAddress).showDisplay).toBe(true);
  });

  it("rejects a solana key that is not the pinned one", async () => {
    const { link } = scripted([PRO, solanaReply(SOLANA_LEAF, OTHER_SEED)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.verifyAddress(
        link,
        {
          path: SOLANA_LEAF,
          address: solanaLeafAddress,
          template: "solana.bip44-change",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        },
        PIN,
      ),
    );
    expect(error.code).toBe("wrong-device");
  });

  it("passes the bitcoin script type and coin name to GetAddress", async () => {
    const { link, requests } = scripted([
      PRO,
      nodeReply(BIP84_ACCOUNT),
      reply(Address, { address: btcLeafAddress }),
    ]);
    const verdict = await ONEKEY_DRIVER.verifyAddress(
      link,
      { path: BTC_LEAF, address: btcLeafAddress, template: "btc.bip84", network: BTC_NETWORK },
      PIN,
    );
    expect(verdict).toStrictEqual({ method: "device", matched: true });
    const getAddress = writtenMessage(requests, 2, GetAddress);
    expect(getAddress.scriptType).toBe(3);
    expect(getAddress.coinName).toBe("Bitcoin");
    expect(getAddress.showDisplay).toBe(true);
    expect(getAddress.addressN).toStrictEqual([...BTC_LEAF]);
  });
});

describe("display", () => {
  const identity = (model: string, firmware: string) => ({
    fingerprint: MFP,
    model,
    firmware,
  });
  const PRO_ID = identity("pro", "4.21.0");
  const CLASSIC_ID = identity("classic1s", "3.21.0");

  const evmTxRequest = (type: string, extra: Record<string, unknown> = {}): ChainSignRequest =>
    ({
      kind: "evm.transaction",
      network: EVM_NETWORK,
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
      tx: {
        type,
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0x1",
        to: "0x00000000000000000000000000000000deadbeef",
        data: "0x",
        ...extra,
      },
    }) as ChainSignRequest;

  const evmPlan = (kind: "evm.transaction" | "evm.personal-message", extra = {}): ChainPlan =>
    ({
      kind,
      ...(kind === "evm.transaction" ? { tx: {} } : {}),
      tasks: [
        {
          scheme: "ecdsa-secp256k1",
          path: EVM_LEAF,
          publicKey: HDKey.fromMasterSeed(SEED).derive(pathToString(EVM_LEAF)).publicKey!,
          digest: new Uint8Array(32),
        },
      ],
      ...extra,
    }) as ChainPlan;

  it("refuses when the record carries no usable model or firmware", () => {
    const request = {
      kind: "evm.personal-message",
      network: EVM_NETWORK,
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
      message: utf8ToBytes("hi"),
    } as ChainSignRequest;
    const stage = evmPlan("evm.personal-message");
    expect(ONEKEY_DRIVER.display(request, stage, { fingerprint: MFP }, undefined)).toBe(
      "unsupported",
    );
    expect(ONEKEY_DRIVER.display(request, stage, identity("ledger", "1.0.0"), undefined)).toBe(
      "unsupported",
    );
    expect(
      ONEKEY_DRIVER.display(request, stage, identity("pro", "four.twentyone"), undefined),
    ).toBe("unsupported");
  });

  it("classifies evm transactions from the claimed identity", () => {
    expect(
      ONEKEY_DRIVER.display(evmTxRequest("legacy"), evmPlan("evm.transaction"), PRO_ID, undefined),
    ).toBe("clear");
    expect(
      ONEKEY_DRIVER.display(
        evmTxRequest("eip1559", { maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1" }),
        evmPlan("evm.transaction"),
        PRO_ID,
        undefined,
      ),
    ).toBe("clear");
    expect(
      ONEKEY_DRIVER.display(
        evmTxRequest("eip2930", { gasPrice: "0x1", accessList: [] }),
        evmPlan("evm.transaction"),
        PRO_ID,
        undefined,
      ),
    ).toBe("unsupported");
    expect(
      ONEKEY_DRIVER.display(
        evmTxRequest("eip7702", {
          maxFeePerGas: "0x1",
          maxPriorityFeePerGas: "0x1",
          authorization: { address: "0x00000000000000000000000000000000deadbeef" },
        }),
        evmPlan("evm.transaction"),
        PRO_ID,
        undefined,
      ),
    ).toBe("clear");
  });

  it("gates eip7702 on the classic1s firmware floor", () => {
    const request = evmTxRequest("eip7702", {
      maxFeePerGas: "0x1",
      maxPriorityFeePerGas: "0x1",
      authorization: { address: "0x00000000000000000000000000000000deadbeef" },
    });
    const stage = evmPlan("evm.transaction");
    expect(ONEKEY_DRIVER.display(request, stage, CLASSIC_ID, undefined)).toBe("clear");
    expect(ONEKEY_DRIVER.display(request, stage, identity("classic1s", "3.12.0"), undefined)).toBe(
      "unsupported",
    );
    expect(ONEKEY_DRIVER.display(request, stage, identity("mini", "3.21.0"), undefined)).toBe(
      "unsupported",
    );
  });

  it("synthesizes the typed-data-stream capability from classic1s firmware", () => {
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "m", type: "string" }],
      },
      domain: { name: "X" },
      primaryType: "Mail",
      message: { m: "hi" },
    });
    const request = {
      kind: "evm.typed-data",
      network: EVM_NETWORK,
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
      typedData,
    } as ChainSignRequest;
    const stage = { kind: "evm.typed-data", tasks: [] } as unknown as ChainPlan;
    expect(ONEKEY_DRIVER.display(request, stage, PRO_ID, undefined)).toBe("clear");
    expect(ONEKEY_DRIVER.display(request, stage, CLASSIC_ID, undefined)).toBe("clear");
    expect(ONEKEY_DRIVER.display(request, stage, identity("classic1s", "3.13.0"), undefined)).toBe(
      "blind",
    );
    expect(ONEKEY_DRIVER.display(request, stage, identity("classic", "3.21.0"), undefined)).toBe(
      "blind",
    );
  });

  it("refuses a request/stage kind disagreement", () => {
    const request = evmTxRequest("legacy");
    const stage = evmPlan("evm.personal-message");
    expect(() => ONEKEY_DRIVER.display(request, stage, PRO_ID, undefined)).toThrow(KernelError);
  });
});

describe("sign", () => {
  const taskKey = HDKey.fromMasterSeed(SEED).derive(pathToString(EVM_LEAF)).publicKey!;
  const personalRequest = {
    kind: "evm.personal-message",
    network: EVM_NETWORK,
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
    message: utf8ToBytes("hello"),
  } as ChainSignRequest;
  const personalStage = {
    kind: "evm.personal-message",
    tasks: [
      {
        scheme: "ecdsa-secp256k1",
        path: EVM_LEAF,
        publicKey: taskKey,
        digest: new Uint8Array(32),
      },
    ],
  } as unknown as ChainPlan;

  const signature = (): Uint8Array => {
    const sig = new Uint8Array(65);
    sig.fill(7, 0, 64);
    sig[64] = 27;
    return sig;
  };

  it("signs a personal message and returns the 64-byte r‖s", async () => {
    const { link, requests } = scripted([
      PRO,
      nodeReply(EVM_ACCOUNT),
      reply(EthereumMessageSignatureOneKey, { signature: signature(), address: evmLeafAddress }),
    ]);
    const signatures = await ONEKEY_DRIVER.sign(
      link,
      signContext(personalRequest, personalStage, "clear"),
    );
    expect(requests).toHaveLength(3);
    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toHaveLength(64);
    expect(signatures[0]?.[0]).toBe(7);
  });

  it("rejects a device that answers different account keys", async () => {
    const { link } = scripted([PRO, nodeReply(EVM_ACCOUNT, OTHER_SEED)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.sign(link, signContext(personalRequest, personalStage, "clear")),
    );
    expect(error.code).toBe("wrong-device");
  });

  it("rejects when the live device can no longer show the confirmed request", async () => {
    const request = {
      kind: "evm.transaction",
      network: EVM_NETWORK,
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
      tx: {
        type: "eip2930",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        gasPrice: "0x1",
        value: "0x1",
        to: "0x00000000000000000000000000000000deadbeef",
        data: "0x",
        accessList: [],
      },
    } as ChainSignRequest;
    const stage = {
      kind: "evm.transaction",
      tx: {},
      tasks: [
        {
          scheme: "ecdsa-secp256k1",
          path: EVM_LEAF,
          publicKey: taskKey,
          digest: new Uint8Array(32),
        },
      ],
    } as unknown as ChainPlan;
    const { link } = scripted([PRO, nodeReply(EVM_ACCOUNT)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.sign(link, signContext(request, stage, "clear")),
    );
    expect(error.code).toBe("unsupported");
  });

  it("rejects a display drift from clear to blind", async () => {
    const request = {
      kind: "evm.transaction",
      network: EVM_NETWORK,
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        maxFeePerGas: "0x1",
        maxPriorityFeePerGas: "0x1",
        value: "0x1",
        to: "0x00000000000000000000000000000000deadbeef",
        // Calldata the device cannot decode shows a hash — blind, not the promised clear.
        data: "0xdeadbeefcafebabe",
      },
    } as ChainSignRequest;
    const stage = {
      kind: "evm.transaction",
      tx: {},
      tasks: [
        {
          scheme: "ecdsa-secp256k1",
          path: EVM_LEAF,
          publicKey: taskKey,
          digest: new Uint8Array(32),
        },
      ],
    } as unknown as ChainPlan;
    const { link } = scripted([PRO, nodeReply(EVM_ACCOUNT)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.sign(link, signContext(request, stage, "clear")),
    );
    expect(error.code).toBe("unsupported");
  });

  it("rejects an ed25519 task on a device answering a different solana key", async () => {
    const request = {
      kind: "solana.message",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
      message: utf8ToBytes("hello solana"),
      format: "raw",
    } as ChainSignRequest;
    const stage = {
      kind: "solana.message",
      tasks: [
        {
          scheme: "ed25519",
          path: SOLANA_LEAF,
          publicKey: edAt(SEED, SOLANA_LEAF).publicKey,
          message: utf8ToBytes("hello solana"),
        },
      ],
    } as unknown as ChainPlan;
    const { link } = scripted([PRO, solanaReply(SOLANA_LEAF, OTHER_SEED)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.sign(link, signContext(request, stage, "clear")),
    );
    expect(error.code).toBe("wrong-device");
  });

  it("refuses a stage carrying no task as a kernel inconsistency", async () => {
    const stage = { kind: "evm.personal-message", tasks: [] } as unknown as ChainPlan;
    const { link } = scripted([PRO]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.sign(link, signContext(personalRequest, stage, "clear")),
    );
    expect(error.code).toBe("integrity");
  });

  it("refuses a request/stage kind disagreement", async () => {
    const txStage = {
      kind: "evm.transaction",
      tx: {},
      tasks: [
        {
          scheme: "ecdsa-secp256k1",
          path: EVM_LEAF,
          publicKey: taskKey,
          digest: new Uint8Array(32),
        },
      ],
    } as unknown as ChainPlan;
    const { link } = scripted([PRO, nodeReply(EVM_ACCOUNT)]);
    const error = await kernelErrorOf(async () =>
      ONEKEY_DRIVER.sign(link, signContext(personalRequest, txStage, "clear")),
    );
    expect(error.code).toBe("integrity");
  });

  it("maps every device failure code to a kernel error without device text", async () => {
    const table: Array<[number, string]> = [
      [4, "device-rejected"],
      [6, "device-rejected"],
      [7, "device-locked"],
      [5, "device-locked"],
      [11, "unsupported"],
      [99, "integrity"],
    ];
    for (const [code, kernel] of table) {
      const { link } = scripted([failure(code)]);
      // oxlint-disable-next-line no-await-in-loop -- one scripted device at a time
      const error = await kernelErrorOf(async () =>
        ONEKEY_DRIVER.sign(link, signContext(personalRequest, personalStage, "clear")),
      );
      expect(error.code).toBe(kernel);
      expect(error.message).not.toContain("device text");
    }
  });
});
