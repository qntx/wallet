import { sha256 } from "@noble/hashes/sha2.js";
/**
 * Keys.ts against scripted exchanges: every response-validation guard (path echo, node fields, xpub
 * self-consistency, key material on-curve, address format) must reject crafted device answers, and
 * caller-side mistakes must fail as invalid-input before anything is sent.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58, createBase58check } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { OneKeyError } from "../src/modules/signers/onekey/protocol/errors.ts";
import { decodeMessage, encodeMessage } from "../src/modules/signers/onekey/protocol/frame.ts";
import {
  address,
  evmPublicNode,
  publicNode,
  solanaPublicKey,
} from "../src/modules/signers/onekey/protocol/keys.ts";
import {
  Address,
  EthereumAddressOneKey,
  EthereumGetPublicKeyOneKey,
  EthereumPublicKeyOneKey,
  Failure,
  PublicKey,
  SolanaAddress,
  TronAddress,
} from "../src/modules/signers/onekey/protocol/messages.ts";
import type { Decoded, Fields, MessageDef } from "../src/modules/signers/onekey/protocol/proto.ts";
import { decode, encode } from "../src/modules/signers/onekey/protocol/proto.ts";
import type { Exchange } from "../src/modules/signers/onekey/protocol/session.ts";
import { loadTranscript, transcriptSession } from "./onekey-emulator/index.ts";

const hex = hexToBytes;
const base58check = createBase58check(sha256);

const H = 0x80_00_00_00;
const PATH = [H + 84, H, H];

const transcript = loadTranscript("classic1s");

/** The recorded node-bip84 exchange: request bytes oracle and response decode fixture. */
const NODE_BIP84 = (() => {
  const [recorded] = transcriptSession(transcript, "node-bip84").exchanges;
  if (recorded === undefined) {
    throw new Error("transcript is missing node-bip84");
  }
  return recorded;
})();

/** The real m/84'/0'/0' PublicKey the emulator answered, as the decode fixture. */
const DEVICE_PK = (() => {
  const message = decodeMessage(hex(NODE_BIP84.response));
  return decode(PublicKey, message.payload);
})();

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

function written(writes: Uint8Array[], index: number): Uint8Array {
  const bytes = writes[index];
  if (bytes === undefined) {
    throw new Error(`expected write ${index}`);
  }
  return bytes;
}

function reply<F extends Fields>(def: MessageDef<F>, value: Decoded<F>): Uint8Array {
  return encodeMessage(def.typeId, encode(def, value));
}

async function errorOf(fn: () => Promise<unknown>): Promise<OneKeyError> {
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

function publicNodeOf(overrides: Partial<(typeof DEVICE_PK)["node"]> = {}): typeof DEVICE_PK {
  return {
    node: { ...DEVICE_PK.node, ...overrides },
    xpub: DEVICE_PK.xpub,
    ...(DEVICE_PK.rootFingerprint === undefined
      ? {}
      : { rootFingerprint: DEVICE_PK.rootFingerprint }),
  };
}

/** The recorded xpub payload with `at` (offset into the 78-byte payload) replaced. */
function tamperedXpub(at: number, ...bytes: number[]): string {
  const payload = base58check.decode(DEVICE_PK.xpub);
  for (const [i, byte] of bytes.entries()) {
    payload[at + i] = byte;
  }
  return base58check.encode(payload);
}

describe("publicNode request", () => {
  it("writes the byte-exact recorded GetPublicKey", async () => {
    const { exchange, writes } = scripted([hex(NODE_BIP84.response)]);
    await publicNode(exchange, PATH, { scriptType: 3 });
    expect(bytesToHex(written(writes, 0))).toBe(NODE_BIP84.request);
  });

  it("rejects an empty path before sending", async () => {
    const { exchange, writes } = scripted([]);
    const error = await errorOf(async () => publicNode(exchange, []));
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });

  it("rejects an out-of-range path element", async () => {
    const { exchange, writes } = scripted([]);
    const error = await errorOf(async () => publicNode(exchange, [H, -1, H]));
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });

  it("rejects an out-of-range script type", async () => {
    const { exchange, writes } = scripted([]);
    const error = await errorOf(async () => publicNode(exchange, PATH, { scriptType: 6 }));
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });
});

describe("publicNode response checks", () => {
  const serve = (value: Decoded<typeof PublicKey.fields>): Exchange =>
    scripted([reply(PublicKey, value)]).exchange;

  // The xpub must lie consistently with the node — a lone node-field lie is already caught by
  // the xpub cross-check, so these tamper both to prove the path-echo guards are load-bearing.
  it("rejects a node at the wrong depth", async () => {
    const error = await errorOf(async () =>
      publicNode(
        serve({
          ...DEVICE_PK,
          node: { ...DEVICE_PK.node, depth: 4 },
          xpub: tamperedXpub(4, 4),
        }),
        PATH,
      ),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects a node at the wrong child number", async () => {
    const error = await errorOf(async () =>
      publicNode(
        serve({
          ...DEVICE_PK,
          node: { ...DEVICE_PK.node, childNum: H + 1 },
          xpub: tamperedXpub(9, 0x80, 0, 0, 1),
        }),
        PATH,
      ),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects a node carrying private key material", async () => {
    const error = await errorOf(async () =>
      publicNode(serve(publicNodeOf({ privateKey: new Uint8Array(32) })), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it.each([31, 33])("rejects a %d-byte chain code", async (length) => {
    const error = await errorOf(async () =>
      publicNode(serve(publicNodeOf({ chainCode: new Uint8Array(length) })), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects a 32-byte public key", async () => {
    const error = await errorOf(async () =>
      publicNode(serve(publicNodeOf({ publicKey: DEVICE_PK.node.publicKey.slice(1) })), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects an uncompressed-prefix public key", async () => {
    const bad = new Uint8Array(DEVICE_PK.node.publicKey);
    bad[0] = 4;
    const error = await errorOf(async () =>
      publicNode(serve(publicNodeOf({ publicKey: bad })), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects a compressed key whose x is out of the field", async () => {
    const bad = new Uint8Array(33).fill(0xff);
    bad[0] = 2;
    const error = await errorOf(async () =>
      publicNode(serve(publicNodeOf({ publicKey: bad })), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  // An off-curve key carried consistently in both the node and the xpub is only caught by the
  // on-curve check — the byte-equality guard cannot see it.
  it("rejects an off-curve key echoed in node and xpub", async () => {
    const bad = new Uint8Array(33).fill(0xff);
    bad[0] = 2;
    const error = await errorOf(async () =>
      publicNode(
        serve({
          ...DEVICE_PK,
          node: { ...DEVICE_PK.node, publicKey: bad },
          xpub: tamperedXpub(45, ...bad),
        }),
        PATH,
      ),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects an xpub that is not base58check", async () => {
    const error = await errorOf(async () =>
      publicNode(serve({ ...DEVICE_PK, xpub: "not!base58" }), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects an xpub with a truncated payload", async () => {
    const payload = base58check.decode(DEVICE_PK.xpub).subarray(0, 77);
    const error = await errorOf(async () =>
      publicNode(serve({ ...DEVICE_PK, xpub: base58check.encode(payload) }), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects an xpub with a trailing byte", async () => {
    const payload = base58check.decode(DEVICE_PK.xpub);
    const error = await errorOf(async () =>
      publicNode(
        serve({ ...DEVICE_PK, xpub: base58check.encode(new Uint8Array([...payload, 0])) }),
        PATH,
      ),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects an xpub whose parent fingerprint differs", async () => {
    const error = await errorOf(async () =>
      publicNode(serve({ ...DEVICE_PK, xpub: tamperedXpub(5, 0xff) }), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects a node fingerprint that disagrees with the xpub", async () => {
    const error = await errorOf(async () =>
      publicNode(serve(publicNodeOf({ fingerprint: 0 })), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects an xpub whose depth differs", async () => {
    const error = await errorOf(async () =>
      publicNode(serve({ ...DEVICE_PK, xpub: tamperedXpub(4, 2) }), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects an xpub whose child number differs", async () => {
    const error = await errorOf(async () =>
      publicNode(serve({ ...DEVICE_PK, xpub: tamperedXpub(9, 0, 0, 0, 0) }), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects an xpub whose chain code differs", async () => {
    const error = await errorOf(async () =>
      publicNode(serve({ ...DEVICE_PK, xpub: tamperedXpub(13, 0) }), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects an xpub whose public key differs", async () => {
    const error = await errorOf(async () =>
      publicNode(serve({ ...DEVICE_PK, xpub: tamperedXpub(77, 1) }), PATH),
    );
    expect(error.code).toBe("device-fault");
  });

  // A same-depth, same-last-element response for a different middle element cannot be
  // distinguished — only depth and child number are echoed back in the node and xpub.
  it("rejects a PublicKey recorded for another path", async () => {
    const { exchange } = scripted([hex(NODE_BIP84.response)]);
    const error = await errorOf(async () => publicNode(exchange, [H + 84, H, H, 0]));
    expect(error.code).toBe("device-fault");
  });

  it("rejects an unexpected response type", async () => {
    const { exchange } = scripted([reply(Address, { address: "bc1qxyz" })]);
    const error = await errorOf(async () => publicNode(exchange, PATH));
    expect(error.code).toBe("device-fault");
  });

  it("maps a device Failure to a typed error", async () => {
    const { exchange } = scripted([reply(Failure, { code: 4 })]);
    const error = await errorOf(async () => publicNode(exchange, PATH));
    expect(error.code).toBe("user-rejected");
    expect(error.failure).toBe(4);
  });

  it("returns the verified node and root fingerprint", async () => {
    const { exchange } = scripted([reply(PublicKey, DEVICE_PK)]);
    const node = await publicNode(exchange, PATH, { scriptType: 3 });
    expect(node.publicKey).toStrictEqual(DEVICE_PK.node.publicKey);
    expect(node.chainCode).toStrictEqual(DEVICE_PK.node.chainCode);
    expect(node.rootFingerprint).toStrictEqual(hex("73c5da0a"));
  });
});

describe("evmPublicNode", () => {
  const EVM_PATH = [H + 44, H + 60, H];
  const [recorded] = transcriptSession(transcript, "node-evm").exchanges;
  if (recorded === undefined) {
    throw new Error("transcript is missing node-evm");
  }

  it("writes the byte-exact recorded EthereumGetPublicKeyOneKey", async () => {
    const { exchange, writes } = scripted([hex(recorded.response)]);
    await evmPublicNode(exchange, EVM_PATH);
    expect(bytesToHex(written(writes, 0))).toBe(recorded.request);
  });

  it("sends chainId when given", async () => {
    const { exchange, writes } = scripted([hex(recorded.response)]);
    await evmPublicNode(exchange, EVM_PATH, 1n);
    const sent = decodeMessage(written(writes, 0));
    const value = decode(EthereumGetPublicKeyOneKey, sent.payload);
    expect(value.chainId).toBe(1n);
  });

  it("applies the same node checks", async () => {
    const evm = decode(EthereumPublicKeyOneKey, decodeMessage(hex(recorded.response)).payload);
    const { exchange } = scripted([
      reply(EthereumPublicKeyOneKey, {
        node: { ...evm.node, depth: 1 },
        xpub: evm.xpub,
      }),
    ]);
    const error = await errorOf(async () => evmPublicNode(exchange, EVM_PATH));
    expect(error.code).toBe("device-fault");
  });
});

describe("address", () => {
  it("returns a valid bitcoin address", async () => {
    const { exchange } = scripted([
      reply(Address, { address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" }),
    ]);
    await expect(
      address(exchange, "bitcoin", PATH, { showDisplay: false, scriptType: 3 }),
    ).resolves.toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it("returns a valid evm address from field 2", async () => {
    const { exchange } = scripted([
      reply(EthereumAddressOneKey, { address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" }),
    ]);
    await expect(
      address(exchange, "evm", [H + 44, H + 60, H, 0, 0], { showDisplay: false, chainId: 1n }),
    ).resolves.toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });

  it("faults on an absent evm address", async () => {
    const { exchange } = scripted([reply(EthereumAddressOneKey, {})]);
    const error = await errorOf(async () =>
      address(exchange, "evm", [H + 44, H + 60, H, 0, 0], { showDisplay: false }),
    );
    expect(error.code).toBe("device-fault");
  });

  it("faults on an oversized address", async () => {
    const { exchange } = scripted([reply(TronAddress, { address: "T".repeat(129) })]);
    const error = await errorOf(async () =>
      address(exchange, "tron", [H + 44, H + 195, H, 0, 0], { showDisplay: false }),
    );
    expect(error.code).toBe("device-fault");
  });

  it("faults on a non-ASCII address", async () => {
    const { exchange } = scripted([reply(Address, { address: "bc1quñ0" })]);
    const error = await errorOf(async () =>
      address(exchange, "bitcoin", PATH, { showDisplay: false }),
    );
    expect(error.code).toBe("device-fault");
  });

  it("faults on a space or control character in the address", async () => {
    const space = await errorOf(async () =>
      address(scripted([reply(Address, { address: "bc1q cr8te4k" })]).exchange, "bitcoin", PATH, {
        showDisplay: false,
      }),
    );
    expect(space.code).toBe("device-fault");
    const control = await errorOf(async () =>
      address(scripted([reply(Address, { address: "bc1q\tcr8te4k" })]).exchange, "bitcoin", PATH, {
        showDisplay: false,
      }),
    );
    expect(control.code).toBe("device-fault");
  });

  it("returns a valid solana address string", async () => {
    const { exchange } = scripted([
      reply(SolanaAddress, { address: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk" }),
    ]);
    await expect(
      address(exchange, "solana", [H + 44, H + 501, H, H], { showDisplay: false }),
    ).resolves.toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
  });
});

describe("solanaPublicKey", () => {
  const SOL_PATH = [H + 44, H + 501, H, H];

  it("decodes the base58 address into the 32-byte key", async () => {
    const { exchange } = scripted([
      reply(SolanaAddress, { address: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk" }),
    ]);
    const key = await solanaPublicKey(exchange, SOL_PATH, false);
    expect(key).toStrictEqual(base58.decode("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"));
  });

  it("rejects a non-hardened path element before sending", async () => {
    const { exchange, writes } = scripted([]);
    const error = await errorOf(async () =>
      solanaPublicKey(exchange, [H + 44, H + 501, H, 0], false),
    );
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });

  it("faults on a non-base58 address", async () => {
    const { exchange } = scripted([reply(SolanaAddress, { address: "0OIl!" })]);
    const error = await errorOf(async () => solanaPublicKey(exchange, SOL_PATH, false));
    expect(error.code).toBe("device-fault");
  });

  it.each([31, 33])("faults on a %d-byte decoded key", async (length) => {
    const { exchange } = scripted([
      reply(SolanaAddress, { address: base58.encode(new Uint8Array(length)) }),
    ]);
    const error = await errorOf(async () => solanaPublicKey(exchange, SOL_PATH, false));
    expect(error.code).toBe("device-fault");
  });

  it("faults on a decoded key that is not an ed25519 point", async () => {
    const { exchange } = scripted([
      reply(SolanaAddress, { address: base58.encode(new Uint8Array(32).fill(0xff)) }),
    ]);
    const error = await errorOf(async () => solanaPublicKey(exchange, SOL_PATH, false));
    expect(error.code).toBe("device-fault");
  });
});
