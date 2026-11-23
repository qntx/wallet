// oxlint-disable vitest/no-conditional-in-test -- plan/recorded fixtures narrow via guard throws
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as fc from "fast-check";
/**
 * Layer-3 EVM coverage: offline replay of the live emulator recordings with independent signature
 * verification (noble secp256k1 recovery + low-s, re-implemented — no kernel signing code), hostile
 * scripted exchanges for every malformed device answer, and a fast-check fuzz over arbitrary
 * EthereumTxRequestOneKey payloads. Digests come from vectors/chains/signing-plans.json for the
 * plan cases and are recomputed with viem for the extra sessions.
 */
import { hashTypedData, keccak256, serializeTransaction } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { EvmTransaction } from "@qntx/wallet-chains";

import { initialize } from "../src/modules/signers/onekey/protocol/device.ts";
import type { DeviceInfo } from "../src/modules/signers/onekey/protocol/device.ts";
import { OneKeyError } from "../src/modules/signers/onekey/protocol/errors.ts";
import { signTypedData, typedDataMode } from "../src/modules/signers/onekey/protocol/evm-typed-data.ts";
import {
  evmDisplay,
  signEvmPersonalMessage,
  signEvmTransaction,
} from "../src/modules/signers/onekey/protocol/evm.ts";
import { decodeMessage, encodeMessage } from "../src/modules/signers/onekey/protocol/frame.ts";
import {
  EthereumMessageSignatureOneKey,
  Failure,
  EthereumSignTypedHashOneKey,
  EthereumTypedDataSignatureOneKey,
  EthereumTypedDataStructRequestOneKey,
  EthereumTypedDataValueAckOneKey,
  EthereumTypedDataValueRequestOneKey,
  EthereumTxRequestOneKey,
} from "../src/modules/signers/onekey/protocol/messages.ts";
import { decode, encode } from "../src/modules/signers/onekey/protocol/proto.ts";
import type { Decoded, MessageDef } from "../src/modules/signers/onekey/protocol/proto.ts";
import type { Exchange } from "../src/modules/signers/onekey/protocol/session.ts";
import { loadVectors } from "./helpers.ts";
import {
  TEST_MNEMONIC,
  replayExchange,
  loadTranscript,
  transcriptSession,
} from "./onekey-emulator/index.ts";
import type { Transcript } from "./onekey-emulator/index.ts";

const H = 0x80_00_00_00;
const EVM_PATH = [H + 44, H + 60, H, 0, 0];
const hex = hexToBytes;
const hex0x = (value: `0x${string}`): Uint8Array => hexToBytes(value.slice(2));

const transcripts: Record<"classic1s" | "pro", Transcript> = {
  classic1s: loadTranscript("classic1s"),
  pro: loadTranscript("pro"),
};

type PlanCase = {
  name: string;
  key: { path: number[]; publicKey: string };
  request: { tx?: EvmTransaction; message?: string; typedData?: string };
  stages: ReadonlyArray<ReadonlyArray<{ publicKey: string; digest: string }>>;
};
const plans = (loadVectors("chains/signing-plans.json") as { cases: PlanCase[] }).cases;
const planCase = (name: string): PlanCase => {
  const found = plans.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`signing plan ${name} missing`);
  }
  return found;
};

const master = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC));
const evmDerived = master.derive("m/44'/60'/0'/0/0");
if (evmDerived.publicKey === null) {
  throw new Error("oracle derivation produced no public key");
}
const evmPublic: Uint8Array = evmDerived.publicKey;

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Independent ECDSA check — mirrors wallet-chains acceptEcdsa without importing it: normalize the
 * compact r‖s to low-s, recover the compressed key under both parities, compare to the task key.
 */
function verifies(digest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64) {
    return false;
  }
  let parsed;
  try {
    parsed = secp256k1.Signature.fromBytes(signature, "compact");
  } catch {
    return false;
  }
  const sig = parsed.hasHighS()
    ? new secp256k1.Signature(parsed.r, secp256k1.Point.Fn.neg(parsed.s))
    : parsed;
  for (const yParity of [0, 1] as const) {
    let recovered: Uint8Array | undefined;
    try {
      recovered = sig.addRecoveryBit(yParity).recoverPublicKey(digest).toBytes(true);
    } catch {
      recovered = undefined;
    }
    if (recovered !== undefined && equalBytes(recovered, publicKey)) {
      return true;
    }
  }
  return false;
}

async function thrown(fn: () => Promise<unknown>): Promise<OneKeyError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof OneKeyError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to throw");
}

/** A device that serves queued encoded-message responses and records what it was sent. */
function scripted(responses: Uint8Array[]): { exchange: Exchange; writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  const exchange = async (data: Uint8Array): Promise<Uint8Array> => {
    writes.push(new Uint8Array(data));
    const next = responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error("scripted device ran out of responses"));
    }
    return Promise.resolve(next);
  };
  return { exchange, writes };
}

const reply = <D extends MessageDef>(def: D, value: Decoded<D["fields"]>): Uint8Array =>
  encodeMessage(def.typeId, encode(def, value));

// The DeviceInfo the sign calls consult for feature gates — mirrors the classic1s emulator's own
// Features (capability 1000 = Capability_EthereumTypedData).
const INFO: DeviceInfo = {
  model: "classic1s",
  firmware: [3, 21, 0],
  deviceId: "0D8A8E040824F2BDC7F7DDE0",
  capabilities: [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000],
  bitcoinOnly: false,
  pinProtection: false,
  passphraseProtection: false,
  unlocked: true,
  sessionId: undefined,
};

// A classic-family model without Capability_EthereumTypedData — always hashes.
const MINI_INFO: DeviceInfo = {
  model: "mini",
  firmware: [3, 21, 0],
  deviceId: "",
  capabilities: [1, 2, 3],
  bitcoinOnly: false,
  pinProtection: false,
  passphraseProtection: false,
  unlocked: true,
  sessionId: undefined,
};

// mini with the typed-data capability — its bigger-data limit is 1024 (vs 1536).
const MINI_CAP_INFO: DeviceInfo = { ...MINI_INFO, capabilities: [1000] };

const PRO_43_INFO: DeviceInfo = {
  model: "pro",
  firmware: [4, 3, 0],
  deviceId: "",
  capabilities: [],
  bitcoinOnly: false,
  pinProtection: false,
  passphraseProtection: false,
  unlocked: true,
  sessionId: undefined,
};

const BIG_TX: EvmTransaction = {
  type: "legacy",
  chainId: 1,
  to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  value: "0x0",
  nonce: 10,
  gas: "0x40000",
  gasPrice: "0x3b9aca00",
  data: `0x${"ab".repeat(2100)}`,
};

const CREATE_TX: EvmTransaction = {
  type: "legacy",
  chainId: 1,
  value: "0x0",
  nonce: 11,
  gas: "0x100000",
  gasPrice: "0x3b9aca00",
  data: `0x${"6080604052".repeat(8)}`,
};

// The array-of-structs + fixed-array document, same literal the recorder serialized.
const ARRAYS_DOC = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    Item: [
      { name: "id", type: "uint256" },
      { name: "owner", type: "address" },
    ],
    Batch: [
      { name: "items", type: "Item[]" },
      { name: "flags", type: "uint256[3]" },
      { name: "note", type: "string" },
    ],
  },
  primaryType: "Batch",
  domain: { name: "BatchTest", chainId: 1 },
  message: {
    items: [
      { id: "7", owner: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
      { id: "8", owner: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    ],
    flags: ["1", "2", "3"],
    note: "two items",
  },
};

// Nested arrays force hash mode on both emulators.
const NESTED_DOC = {
  types: {
    EIP712Domain: [{ name: "name", type: "string" }],
    Grid: [{ name: "cells", type: "uint256[][]" }],
  },
  primaryType: "Grid",
  domain: { name: "GridTest" },
  message: { cells: [["1", "2"], ["3"]] },
};

/** Viem hashTypedData wants `types` without the EIP712Domain key. */
const viemTypedDigest = (doc: {
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}): Uint8Array => {
  const types = { ...doc.types };
  delete types["EIP712Domain"];
  return hex0x(
    hashTypedData({
      domain: doc.domain,
      types,
      primaryType: doc.primaryType,
      message: doc.message,
    }),
  );
};

const bigDigest = hex0x(
  keccak256(
    serializeTransaction({
      type: "legacy",
      chainId: 1,
      nonce: 10,
      gasPrice: 1_000_000_000n,
      gas: 262_144n,
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: 0n,
      data: BIG_TX.data as `0x${string}`,
    }),
  ),
);
const createDigest = hex0x(
  keccak256(
    serializeTransaction({
      type: "legacy",
      chainId: 1,
      nonce: 11,
      gasPrice: 1_000_000_000n,
      gas: 1_048_576n,
      value: 0n,
      data: CREATE_TX.data as `0x${string}`,
    }),
  ),
);
const arraysDigest = viemTypedDigest(ARRAYS_DOC);
const nestedDigest = viemTypedDigest(NESTED_DOC);

const planTx = (name: string): EvmTransaction => {
  const { tx } = planCase(name).request;
  if (tx === undefined) {
    throw new Error(`plan case ${name} carries no transaction`);
  }
  return tx;
};
const planPublic = (name: string): Uint8Array => hex(planCase(name).key.publicKey);
const planDigest = (name: string, stage: number): Uint8Array => {
  const digest = planCase(name).stages[stage]?.[0]?.digest;
  if (digest === undefined) {
    throw new Error(`plan case ${name} has no stage ${stage}`);
  }
  return hex(digest);
};

function evmReplay(label: "classic1s" | "pro"): void {
  const transcript = transcripts[label];
  const session = (name: string): Exchange => replayExchange(transcriptSession(transcript, name));
  const exchanges = (name: string) => transcriptSession(transcript, name).exchanges;
  let info: DeviceInfo | undefined;
  const deviceInfo = async (): Promise<DeviceInfo> => {
    info ??= await initialize(session("evm-init"));
    return info;
  };

  describe(`${label} EVM replay`, () => {
    it.each(["evm-legacy", "evm-eip1559", "evm-eip1559-data"] as const)(
      "%s returns a signature that verifies against the plan digest",
      async (name) => {
        const result = await signEvmTransaction(
          session(name),
          await deviceInfo(),
          planCase(name).key.path,
          planTx(name),
        );
        expect(verifies(planDigest(name, 0), result.signature, planPublic(name))).toBe(true);
      },
    );

    it("evm-eip2930 is unsupported before any exchange", async () => {
      expect(exchanges("evm-eip2930")).toHaveLength(0);
      const error = await thrown(async () =>
        signEvmTransaction(
          replayExchange({ name: "empty", exchanges: [] }),
          await deviceInfo(),
          EVM_PATH,
          planTx("evm-eip2930"),
        ),
      );
      expect(error.code).toBe("unsupported");
    });

    it("evm-legacy-bigdata walks the multi-chunk TxAck rounds and verifies", async () => {
      const result = await signEvmTransaction(
        session("evm-legacy-bigdata"),
        await deviceInfo(),
        EVM_PATH,
        BIG_TX,
      );
      expect(verifies(bigDigest, result.signature, evmPublic)).toBe(true);
    });

    it("evm-create signs contract creation", async () => {
      const result = await signEvmTransaction(
        session("evm-create"),
        await deviceInfo(),
        EVM_PATH,
        CREATE_TX,
      );
      expect(verifies(createDigest, result.signature, evmPublic)).toBe(true);
    });

    it.each(["evm-eip7702-upgrade", "evm-eip7702-revoke"] as const)(
      "%s stage 1 signs the authorization digest and stage 2 echoes it into the envelope",
      async (name) => {
        const tx = planTx(name);
        const publicKey = planPublic(name);
        // Stage digests: 0 = authorization (keccak(0x05‖rlp(chain,addr,nonce+1))), 1 = envelope.
        const stage1 = await signEvmTransaction(
          session(`${name}-stage1`),
          await deviceInfo(),
          planCase(name).key.path,
          tx,
        );
        expect(stage1.authorization).toBeDefined();
        const { authorization } = stage1;
        if (authorization === undefined) {
          throw new Error("stage 1 returned no authorization signature");
        }
        expect(
          verifies(
            planDigest(name, 0),
            new Uint8Array([...authorization.r, ...authorization.s]),
            publicKey,
          ),
        ).toBe(true);
        // The stage-1 envelope already carries the freshly signed authorization.
        expect(verifies(planDigest(name, 1), stage1.signature, publicKey)).toBe(true);

        const stage2 = await signEvmTransaction(
          session(`${name}-stage2`),
          await deviceInfo(),
          planCase(name).key.path,
          tx,
          { authorization },
        );
        expect(verifies(planDigest(name, 1), stage2.signature, publicKey)).toBe(true);
        // The device echoes the supplied signature rather than re-signing.
        const echoed = stage2.authorization;
        expect(echoed?.yParity).toBe(authorization.yParity);
        expect(echoed?.r).toStrictEqual(authorization.r);
        expect(echoed?.s).toStrictEqual(authorization.s);
      },
    );

    it("evm-eip7702-unregistered records the warning round and the DataError refusal", async () => {
      const [request, refusal] = exchanges("evm-eip7702-unregistered");
      expect(request).toBeDefined();
      expect(refusal).toBeDefined();
      if (request === undefined || refusal === undefined) {
        throw new Error("unregistered session is incomplete");
      }
      // The device showed the whitelist warning (ButtonRequest) then failed with DataError.
      expect(decodeMessage(hex(request.response)).type).toBe(26);
      const failureMessage = decodeMessage(hex(refusal.response));
      expect(failureMessage.type).toBe(3);
      expect(decode(Failure, failureMessage.payload).code).toBe(3);
      const upgrade = planTx("evm-eip7702-upgrade");
      if (upgrade.type !== "eip7702") {
        throw new Error("evm-eip7702-upgrade is not an eip7702 transaction");
      }
      const error = await thrown(async () =>
        signEvmTransaction(session("evm-eip7702-unregistered"), await deviceInfo(), EVM_PATH, {
          ...upgrade,
          authorization: { address: "0x00000000000000000000000000000000dEaDbEEF" },
        }),
      );
      expect(error.code).toBe("unsupported");
    });

    it("evm-personal-message verifies against the plan digest", async () => {
      const { message } = planCase("evm-personal-message").request;
      if (message === undefined) {
        throw new Error("plan carries no message");
      }
      const sig = await signEvmPersonalMessage(
        session("evm-personal-message"),
        EVM_PATH,
        hex(message),
      );
      expect(
        verifies(planDigest("evm-personal-message", 0), sig, planPublic("evm-personal-message")),
      ).toBe(true);
    });

    it("evm-typed-data-mail replays the stream exchange and verifies", async () => {
      const { typedData } = planCase("evm-typed-data-mail").request;
      if (typedData === undefined) {
        throw new Error("plan carries no typed data");
      }
      const sig = await signTypedData(
        session("evm-typed-data-mail"),
        await deviceInfo(),
        EVM_PATH,
        typedData,
      );
      expect(
        verifies(planDigest("evm-typed-data-mail", 0), sig, planPublic("evm-typed-data-mail")),
      ).toBe(true);
    });

    it("evm-typed-data-arrays replays arrays of structs and fixed arrays", async () => {
      const sig = await signTypedData(
        session("evm-typed-data-arrays"),
        await deviceInfo(),
        EVM_PATH,
        JSON.stringify(ARRAYS_DOC),
      );
      expect(verifies(arraysDigest, sig, evmPublic)).toBe(true);
    });

    it("evm-typed-data-nested uses hash mode and verifies", async () => {
      const json = JSON.stringify(NESTED_DOC);
      expect(typedDataMode(await deviceInfo(), json)).toBe("hash");
      const sig = await signTypedData(
        session("evm-typed-data-nested"),
        await deviceInfo(),
        EVM_PATH,
        json,
      );
      expect(verifies(nestedDigest, sig, evmPublic)).toBe(true);
    });
  });
}

evmReplay("classic1s");
evmReplay("pro");

describe("evm display classification", () => {
  it("classifies personal messages clear and calldata blind except recognized approvals", () => {
    expect(evmDisplay(INFO, { kind: "evm.personal-message" })).toBe("clear");
    const base = planTx("evm-legacy");
    expect(evmDisplay(INFO, { kind: "evm.transaction", tx: base })).toBe("clear");
    const approve: EvmTransaction = {
      ...base,
      data: `0x095ea7b3${"00".repeat(12)}cd2a3d9f938e13cd947ec05abc7fe734df8dd826${"00".repeat(32)}`,
    };
    expect(evmDisplay(INFO, { kind: "evm.transaction", tx: approve })).toBe("clear");
    const padded: EvmTransaction = { ...approve, data: `${approve.data}00` };
    expect(evmDisplay(INFO, { kind: "evm.transaction", tx: padded })).toBe("blind");
    const transfer: EvmTransaction = { ...base, data: `0xa9059cbb${"00".repeat(64)}` };
    expect(evmDisplay(INFO, { kind: "evm.transaction", tx: transfer })).toBe("blind");
    expect(evmDisplay(INFO, { kind: "evm.transaction", tx: BIG_TX })).toBe("blind");
  });

  it("classifies eip7702 clear — the device names or refuses the delegator itself", () => {
    expect(evmDisplay(INFO, { kind: "evm.transaction", tx: planTx("evm-eip7702-upgrade") })).toBe(
      "clear",
    );
    const upgrade = planTx("evm-eip7702-upgrade");
    if (upgrade.type !== "eip7702") {
      throw new Error("evm-eip7702-upgrade is not an eip7702 transaction");
    }
    // An unregistered target is still "clear" from the wallet's side: the device shows a
    // whitelist warning and refuses with Failure_DataError before signing.
    expect(
      evmDisplay(INFO, {
        kind: "evm.transaction",
        tx: {
          ...upgrade,
          authorization: { address: "0x00000000000000000000000000000000dEaDbEEF" },
        },
      }),
    ).toBe("clear");
  });

  it("returns unsupported exactly where signing refuses before the exchange", async () => {
    expect(evmDisplay(INFO, { kind: "evm.transaction", tx: planTx("evm-eip2930") })).toBe(
      "unsupported",
    );
    expect(
      evmDisplay(MINI_CAP_INFO, {
        kind: "evm.transaction",
        tx: planTx("evm-eip7702-upgrade"),
      }),
    ).toBe("unsupported");
    const { exchange, writes } = scripted([]);
    const e1 = await thrown(async () =>
      signEvmTransaction(exchange, INFO, EVM_PATH, planTx("evm-eip2930")),
    );
    const e2 = await thrown(async () =>
      signEvmTransaction(exchange, MINI_CAP_INFO, EVM_PATH, planTx("evm-eip7702-upgrade")),
    );
    expect(e1.code).toBe("unsupported");
    expect(e2.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("classifies typed data by mode", () => {
    const { typedData } = planCase("evm-typed-data-mail").request;
    if (typedData === undefined) {
      throw new Error("plan carries no typed data");
    }
    expect(evmDisplay(INFO, { kind: "evm.typed-data", typedData })).toBe("clear");
    expect(
      evmDisplay(INFO, { kind: "evm.typed-data", typedData: JSON.stringify(NESTED_DOC) }),
    ).toBe("blind");
  });
});

describe("hostile transaction responses", () => {
  const legacy = planTx("evm-legacy");
  const sigRequest = (extra: Record<string, unknown> = {}): Uint8Array =>
    reply(EthereumTxRequestOneKey, {
      signatureV: 27,
      signatureR: new Uint8Array(32),
      signatureS: new Uint8Array(32),
      ...extra,
    });

  it("device asking for more bytes than remain is a device-fault", async () => {
    const { exchange } = scripted([reply(EthereumTxRequestOneKey, { dataLength: 2000 })]);
    const error = await thrown(async () => signEvmTransaction(exchange, INFO, EVM_PATH, BIG_TX));
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("more payload than remains");
  });

  it("device asking over the 1024-byte chunk cap is a device-fault", async () => {
    const { exchange } = scripted([reply(EthereumTxRequestOneKey, { dataLength: 1025 })]);
    const error = await thrown(async () => signEvmTransaction(exchange, INFO, EVM_PATH, BIG_TX));
    expect(error.code).toBe("device-fault");
  });

  it("zero dataLength with payload still unsent is a device-fault", async () => {
    const { exchange } = scripted([sigRequest({ dataLength: 0 })]);
    const error = await thrown(async () => signEvmTransaction(exchange, INFO, EVM_PATH, BIG_TX));
    expect(error.code).toBe("device-fault");
  });

  it("signature fields missing when the payload is consumed is a device-fault", async () => {
    const { exchange } = scripted([reply(EthereumTxRequestOneKey, { dataLength: 0 })]);
    const error = await thrown(async () => signEvmTransaction(exchange, INFO, EVM_PATH, legacy));
    expect(error.code).toBe("device-fault");
  });

  it.each([
    ["31-byte r", { signatureR: new Uint8Array(31) }],
    ["33-byte r", { signatureR: new Uint8Array(33) }],
    ["31-byte s", { signatureS: new Uint8Array(31) }],
    ["33-byte s", { signatureS: new Uint8Array(33) }],
  ] as const)("%s is a device-fault", async (_name, extra) => {
    const { exchange } = scripted([sigRequest(extra)]);
    const error = await thrown(async () => signEvmTransaction(exchange, INFO, EVM_PATH, legacy));
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("32 bytes");
  });

  it("a signature arriving on a non-7702 transaction with authorization signatures is a device-fault", async () => {
    const { exchange } = scripted([
      sigRequest({
        authorizationSignatures: [{ yParity: 0, r: new Uint8Array(32), s: new Uint8Array(32) }],
      }),
    ]);
    const error = await thrown(async () => signEvmTransaction(exchange, INFO, EVM_PATH, legacy));
    expect(error.code).toBe("device-fault");
  });

  it("two authorization signatures on an eip7702 transaction are a device-fault", async () => {
    const { exchange } = scripted([
      sigRequest({
        authorizationSignatures: [
          { yParity: 0, r: new Uint8Array(32), s: new Uint8Array(32) },
          { yParity: 1, r: new Uint8Array(32), s: new Uint8Array(32) },
        ],
      }),
    ]);
    const error = await thrown(async () =>
      signEvmTransaction(exchange, INFO, EVM_PATH, planTx("evm-eip7702-revoke")),
    );
    expect(error.code).toBe("device-fault");
  });

  it("a missing signatureV is a device-fault", async () => {
    const { exchange } = scripted([sigRequest({ signatureV: undefined })]);
    const error = await thrown(async () => signEvmTransaction(exchange, INFO, EVM_PATH, legacy));
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("missing");
  });

  it("an authorization yParity outside 0/1 is a device-fault", async () => {
    const { exchange } = scripted([
      sigRequest({
        authorizationSignatures: [{ yParity: 2, r: new Uint8Array(32), s: new Uint8Array(32) }],
      }),
    ]);
    const error = await thrown(async () =>
      signEvmTransaction(exchange, INFO, EVM_PATH, planTx("evm-eip7702-revoke")),
    );
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("yParity");
  });

  it.each([
    ["empty", []],
    ["out-of-range element", [0x1_00_00_00_00]],
  ] as const)("a %s derivation path is invalid-input before any exchange", async (_name, path) => {
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () => signEvmTransaction(exchange, INFO, path, legacy));
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });

  it.each([
    ["odd-length", "0xabc"],
    ["non-hex", "0xzz"],
  ] as const)("tx data with %s hex is invalid-input before any exchange", async (_n, data) => {
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signEvmTransaction(exchange, INFO, EVM_PATH, { ...legacy, data }),
    );
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });

  it("a malformed supplied stage-2 authorization is invalid-input before any exchange", async () => {
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signEvmTransaction(exchange, INFO, EVM_PATH, planTx("evm-eip7702-revoke"), {
        authorization: { yParity: 0, r: new Uint8Array(31), s: new Uint8Array(32) },
      }),
    );
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });

  it("a replayed TxRequest passes through and fails independent verification", async () => {
    // The recorded evm-legacy answer signs the plan digest; replayed under a different
    // transaction it still satisfies every wire guard — only the verifier can reject it.
    const [, recorded] = transcriptSession(transcripts.classic1s, "evm-legacy").exchanges;
    if (recorded === undefined) {
      throw new Error("evm-legacy session is incomplete");
    }
    const { exchange } = scripted([hex(recorded.response)]);
    const other: EvmTransaction = { ...legacy, nonce: legacy.nonce + 1 };
    const result = await signEvmTransaction(exchange, INFO, EVM_PATH, other);
    // The client passed the replayed signature straight through — the wire guards cannot tell it
    // was issued for another transaction; only the independent verifier can.
    const recordedSig = decode(
      EthereumTxRequestOneKey,
      decodeMessage(hex(recorded.response)).payload,
    );
    const { signatureR, signatureS } = recordedSig;
    if (signatureR === undefined || signatureS === undefined) {
      throw new Error("recorded request carries no signature");
    }
    expect(result.signature).toStrictEqual(new Uint8Array([...signatureR, ...signatureS]));
    // The returned signature is the recorded one — it verifies against the ORIGINAL digest…
    expect(verifies(planDigest("evm-legacy", 0), result.signature, planPublic("evm-legacy"))).toBe(
      true,
    );
    // …but never against the transaction it was replayed into.
    const differentDigest = hex0x(
      keccak256(
        serializeTransaction({
          type: "legacy",
          chainId: 1,
          nonce: legacy.nonce + 1,
          gasPrice: 1_000_000_000n,
          gas: 21_000n,
          to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          value: 0n,
          data: "0x",
        }),
      ),
    );
    expect(verifies(differentDigest, result.signature, planPublic("evm-legacy"))).toBe(false);
  });
});

describe("hostile message and typed-data responses", () => {
  it("a 64-byte personal signature is a device-fault", async () => {
    const { exchange } = scripted([
      reply(EthereumMessageSignatureOneKey, {
        signature: new Uint8Array(64),
        address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
      }),
    ]);
    const error = await thrown(async () =>
      signEvmPersonalMessage(exchange, EVM_PATH, new Uint8Array([1, 2, 3])),
    );
    expect(error.code).toBe("device-fault");
  });

  const { typedData } = planCase("evm-typed-data-mail").request;
  if (typedData === undefined) {
    throw new Error("plan carries no typed data");
  }
  const mailJson = typedData;

  it("a struct request for an unknown name is a device-fault", async () => {
    const { exchange } = scripted([
      reply(EthereumTypedDataStructRequestOneKey, { name: "NotAType" }),
    ]);
    const error = await thrown(async () => signTypedData(exchange, INFO, EVM_PATH, mailJson));
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("unknown struct");
  });

  it("a value request with an out-of-range member path is a device-fault", async () => {
    const { exchange } = scripted([
      reply(EthereumTypedDataValueRequestOneKey, { memberPath: [1, 999] }),
    ]);
    const error = await thrown(async () => signTypedData(exchange, INFO, EVM_PATH, mailJson));
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("out of range");
  });

  it("a value request with a bad root is a device-fault", async () => {
    const { exchange } = scripted([
      reply(EthereumTypedDataValueRequestOneKey, { memberPath: [7] }),
    ]);
    const error = await thrown(async () => signTypedData(exchange, INFO, EVM_PATH, mailJson));
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("bad root");
  });

  it("a member path walking into an atomic value is a device-fault", async () => {
    const { exchange } = scripted([
      reply(EthereumTypedDataValueRequestOneKey, { memberPath: [0, 0, 0] }),
    ]);
    const error = await thrown(async () => signTypedData(exchange, INFO, EVM_PATH, mailJson));
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("atomic");
  });

  it("an array member index at the boundary is a device-fault", async () => {
    const { exchange } = scripted([
      reply(EthereumTypedDataValueRequestOneKey, { memberPath: [1, 0, 2] }),
    ]);
    const error = await thrown(async () =>
      signTypedData(exchange, INFO, EVM_PATH, JSON.stringify(ARRAYS_DOC)),
    );
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("out of range");
  });

  it("a 64-byte typed-data signature is a device-fault", async () => {
    const { exchange } = scripted([
      reply(EthereumTypedDataSignatureOneKey, { signature: new Uint8Array(64), address: "" }),
    ]);
    const error = await thrown(async () => signTypedData(exchange, INFO, EVM_PATH, mailJson));
    expect(error.code).toBe("device-fault");
  });

  it("a document without its primary type is invalid-input before any exchange", async () => {
    const { exchange, writes } = scripted([]);
    const doc = JSON.stringify({
      types: { EIP712Domain: [{ name: "name", type: "string" }] },
      primaryType: "Nope",
      domain: { name: "x" },
      message: {},
    });
    const error = await thrown(async () => signTypedData(exchange, PRO_43_INFO, EVM_PATH, doc));
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });

  it("the typed-data exchange is bounded at 4096 rounds", async () => {
    // A device that keeps asking for the same member forever.
    const round = reply(EthereumTypedDataValueRequestOneKey, { memberPath: [0, 0] });
    const exchange: Exchange = async (data) => {
      void data;
      return Promise.resolve(round);
    };
    const error = await thrown(async () => signTypedData(exchange, INFO, EVM_PATH, mailJson));
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("round bound");
  }, 120_000);
});

describe("typed-data mode boundaries", () => {
  const dataDoc = (bytes: number): string =>
    JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        D: [{ name: "data", type: "bytes" }],
      },
      primaryType: "D",
      domain: { name: "x" },
      message: { data: `0x${"00".repeat(bytes)}` },
    });

  it("keeps a 1200-byte data field in stream mode on classic1s and hashes it on mini/pro <4.4", () => {
    expect(typedDataMode(INFO, dataDoc(1200))).toBe("stream");
    expect(typedDataMode(MINI_CAP_INFO, dataDoc(1200))).toBe("hash");
    expect(typedDataMode(PRO_43_INFO, dataDoc(1200))).toBe("hash");
  });

  it("hashes a 1700-byte data field on every model and hashes without the capability", () => {
    expect(typedDataMode(INFO, dataDoc(1700))).toBe("hash");
    expect(typedDataMode(MINI_INFO, dataDoc(1200))).toBe("hash");
  });

  it("grants the 1536-byte limit to pro 4.4 and later", () => {
    const pro44: DeviceInfo = { ...PRO_43_INFO, firmware: [4, 4, 0] };
    expect(typedDataMode(pro44, dataDoc(1200))).toBe("stream");
    expect(typedDataMode(PRO_43_INFO, dataDoc(1200))).toBe("hash");
  });
});

describe("hash-mode request shape", () => {
  const domainOnly = JSON.stringify({
    types: { EIP712Domain: [{ name: "name", type: "string" }] },
    primaryType: "EIP712Domain",
    domain: { name: "D" },
    message: {},
  });

  it("omits messageHash when the primary type is the domain itself", async () => {
    const { exchange, writes } = scripted([
      reply(EthereumTypedDataSignatureOneKey, { signature: new Uint8Array(65), address: "" }),
    ]);
    const result = await signTypedData(exchange, MINI_INFO, EVM_PATH, domainOnly);
    expect(result).toHaveLength(64);
    expect(writes).toHaveLength(1);
    const [written] = writes;
    if (written === undefined) {
      throw new Error("no write captured");
    }
    const message = decodeMessage(written);
    expect(message.type).toBe(EthereumSignTypedHashOneKey.typeId);
    const request = decode(EthereumSignTypedHashOneKey, message.payload);
    expect(request.domainSeparatorHash).toHaveLength(32);
    expect(request.messageHash).toBeUndefined();
  });
});

describe("stream-mode value answers", () => {
  const boolDoc = JSON.stringify({
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Flag: [{ name: "ok", type: "bool" }],
    },
    primaryType: "Flag",
    domain: { name: "BoolTest" },
    message: { ok: true },
  });

  it("answers a negative int member two's-complemented", async () => {
    const intDoc = JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Num: [{ name: "n", type: "int16" }],
      },
      primaryType: "Num",
      domain: { name: "IntTest" },
      message: { n: -1 },
    });
    const { exchange, writes } = scripted([
      reply(EthereumTypedDataStructRequestOneKey, { name: "EIP712Domain" }),
      reply(EthereumTypedDataStructRequestOneKey, { name: "Num" }),
      reply(EthereumTypedDataValueRequestOneKey, { memberPath: [0, 0] }),
      reply(EthereumTypedDataValueRequestOneKey, { memberPath: [1, 0] }),
      reply(EthereumTypedDataSignatureOneKey, { signature: new Uint8Array(65), address: "" }),
    ]);
    const result = await signTypedData(exchange, INFO, EVM_PATH, intDoc);
    expect(result).toHaveLength(64);
    const lastAck = writes.at(-1);
    if (lastAck === undefined) {
      throw new Error("no value ack captured");
    }
    const decoded = decode(EthereumTypedDataValueAckOneKey, decodeMessage(lastAck).payload);
    expect(decoded.value).toStrictEqual(new Uint8Array([0xff, 0xff]));
  });

  it("answers a bool member with a single 0x01 byte", async () => {
    const { exchange, writes } = scripted([
      reply(EthereumTypedDataStructRequestOneKey, { name: "EIP712Domain" }),
      reply(EthereumTypedDataStructRequestOneKey, { name: "Flag" }),
      reply(EthereumTypedDataValueRequestOneKey, { memberPath: [0, 0] }),
      reply(EthereumTypedDataValueRequestOneKey, { memberPath: [1, 0] }),
      reply(EthereumTypedDataSignatureOneKey, { signature: new Uint8Array(65), address: "" }),
    ]);
    const result = await signTypedData(exchange, INFO, EVM_PATH, boolDoc);
    expect(result).toHaveLength(64);
    const lastAck = writes.at(-1);
    if (lastAck === undefined) {
      throw new Error("no value ack captured");
    }
    const ack = decodeMessage(lastAck);
    expect(ack.type).toBe(EthereumTypedDataValueAckOneKey.typeId);
    const decoded = decode(EthereumTypedDataValueAckOneKey, ack.payload);
    expect(decoded.value).toStrictEqual(new Uint8Array([1]));
  });
});

describe("EthereumTxRequestOneKey fuzz", () => {
  const legacy = planTx("evm-legacy");

  it("arbitrary payloads yield a value or a OneKeyError, never another failure", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 256 }), async (payload) => {
        const exchange: Exchange = async (data) => {
          void data;
          return Promise.resolve(encodeMessage(EthereumTxRequestOneKey.typeId, payload));
        };
        let outcome: unknown;
        try {
          outcome = await signEvmTransaction(exchange, INFO, EVM_PATH, legacy);
        } catch (error) {
          outcome = error;
          if (!(error instanceof OneKeyError)) {
            throw new TypeError(`non-OneKeyError thrown: ${String(error)}`, { cause: error });
          }
        }
        expect(outcome).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });
});
