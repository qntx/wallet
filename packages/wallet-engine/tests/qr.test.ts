import { CryptoHDKey, CryptoMultiAccounts, CryptoPSBT } from "@keystonehq/bc-ur-registry";
import { ETHSignature, EthSignRequest, DataType } from "@keystonehq/bc-ur-registry-eth";
import { SolSignRequest, SignType } from "@keystonehq/bc-ur-registry-sol";
import { TronSignRequest } from "@keystonehq/bc-ur-registry-tron";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
/**
 * QR codec tests: vendor-built request payloads round through `readQrRequest`, signatures built
 * in-test round through `qrResponse` into vendor decoders, and `qrExport` output reads under the
 * Keystone registry classes exactly as a watch-only wallet would.
 */
import * as fc from "fast-check";
import { toHex, toRlp } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { qrParts } from "@qntx/wallet/hardware";
import type { QrPayload } from "@qntx/wallet/hardware";
import type { ChainExportResult } from "@qntx/wallet/protocol";

import vectors from "../../../vectors/chains/export-account.json" with { type: "json" };
import {
  QrError,
  createQrScanner,
  inspectQrRequest,
  qrExport,
  qrResponse,
  readQrRequest,
} from "../src/qr/index.ts";
import type { QrRequest } from "../src/qr/index.ts";

const [wallet] = vectors.wallets;
if (wallet === undefined) {
  throw new Error("export-account vector is empty");
}
const { fingerprint } = wallet;
const PATH = "m/44'/60'/0'/0/0";

const payload = (ur: { type: string; cbor: Uint8Array }): QrPayload => ({
  type: ur.type,
  cbor: new Uint8Array(ur.cbor),
});

const qrError = (run: () => unknown): string => {
  try {
    run();
    return "no-error";
  } catch (error) {
    expect(error).toBeInstanceOf(QrError);
    return (error as QrError).code;
  }
};

/** Property oracle: true for success or a QrError; a foreign exception returns false. */
const onlyQrError = (run: () => unknown): boolean => {
  try {
    run();
    return true;
  } catch (error) {
    return error instanceof QrError;
  }
};

const numRuns = Number(process.env["FUZZ_RUNS"] ?? "200");

/** The seed phrase's EVM leaf key — tests may sign; src never sees a private key. */
const leaf = HDKey.fromMasterSeed(mnemonicToSeedSync(wallet.mnemonic)).derive(PATH);
const leafPrivate = leaf.privateKey;
const leafPublic = leaf.publicKey;
if (leafPrivate === null || leafPublic === null) {
  throw new Error("vector derivation failed");
}
const leafAddress = `0x${bytesToHex(
  keccak_256(secp256k1.Point.fromBytes(leafPublic).toBytes(false).subarray(1)).subarray(12),
)}`;

const [firstKey] = wallet.keys;
if (firstKey?.chainCode === undefined) {
  throw new Error("vector evm.account has no chain code");
}
const evmAccountChainCode = firstKey.chainCode;

const otherLeaf = HDKey.fromMasterSeed(mnemonicToSeedSync(wallet.mnemonic)).derive(
  "m/44'/60'/0'/0/1",
);
const otherPrivate = otherLeaf.privateKey;
if (otherPrivate === null) {
  throw new Error("vector derivation failed");
}

const evmTxRequest = (
  request: QrRequest,
): Extract<QrRequest, { family: "evm"; kind: "transaction" }> => {
  if (request.family !== "evm" || request.kind !== "transaction") {
    throw new Error("expected an evm transaction request");
  }
  return request;
};

const evmPersonalRequest = (
  request: QrRequest,
): Extract<QrRequest, { family: "evm"; kind: "personal-message" }> => {
  if (request.family !== "evm" || request.kind !== "personal-message") {
    throw new Error("expected an evm personal-message request");
  }
  return request;
};

const solanaRequest = (request: QrRequest): Extract<QrRequest, { family: "solana" }> => {
  if (request.family !== "solana") {
    throw new Error("expected a solana request");
  }
  return request;
};

const tronRequest = (request: QrRequest): Extract<QrRequest, { family: "tron" }> => {
  if (request.family !== "tron") {
    throw new Error("expected a tron request");
  }
  return request;
};

const bitcoinRequest = (request: QrRequest): Extract<QrRequest, { family: "bitcoin" }> => {
  if (request.family !== "bitcoin") {
    throw new Error("expected a bitcoin request");
  }
  return request;
};

const ethPersonalRequest = (): QrPayload =>
  payload(
    EthSignRequest.constructETHRequest(
      Buffer.from(new TextEncoder().encode("hello qr")),
      DataType.personalMessage,
      PATH,
      fingerprint,
      undefined,
      undefined,
      leafAddress,
    ).toUR(),
  );

const LEGACY_SD = hexToBytes(
  toRlp([
    "0x",
    toHex(20_000_000_000n),
    toHex(21_000n),
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    toHex(10n ** 15n),
    "0x",
    toHex(1),
    "0x",
    "0x",
  ]).slice(2),
);

const eip191 = (message: string): Uint8Array =>
  keccak_256(
    hexToBytes(
      bytesToHex(new TextEncoder().encode(`\u0019Ethereum Signed Message:\n${message.length}`)) +
        bytesToHex(new TextEncoder().encode(message)),
    ),
  );

const sign65 = (digest: Uint8Array, key: Uint8Array): Uint8Array => {
  const raw = secp256k1.sign(digest, key, { lowS: true, format: "recovered", prehash: false });
  const [recid] = raw;
  if (raw.length !== 65 || recid === undefined) {
    throw new Error("bad recovered signature");
  }
  const out = new Uint8Array(65);
  out.set(raw.subarray(1), 0);
  out[64] = recid + 27;
  return out;
};

describe("qr scanner", () => {
  it("completes a single-part payload and stays complete", () => {
    const req = payload(
      EthSignRequest.constructETHRequest(
        Buffer.from(LEGACY_SD),
        DataType.transaction,
        PATH,
        fingerprint,
        undefined,
        1,
      ).toUR(),
    );
    const frames = qrParts(req);
    const scanner = createQrScanner({ kind: "request", now: () => 0 });
    const out = scanner.receive(frames());
    expect(out.status).toBe("complete");
    expect(scanner.receive("UR:BYTES/TYAAAD")).toStrictEqual(out);
  });

  it("rejects limits above the defaults with unsupported", () => {
    expect(
      qrError(() =>
        createQrScanner({ kind: "request", now: () => 0, limits: { maxFrames: 5000 } }),
      ),
    ).toBe("unsupported");
  });

  it("exhausts the frame budget and the deadline", () => {
    const over = createQrScanner({ kind: "request", now: () => 0, limits: { maxFrames: 2 } });
    over.receive("UR:BYTES/AOEA");
    over.receive("UR:BYTES/AOEA");
    expect(qrError(() => over.receive("UR:BYTES/AOEA"))).toBe("scan-exhausted");
    let t = 0;
    const late = createQrScanner({
      kind: "request",
      now: () => t,
      limits: { timeoutMs: 1500 },
    });
    late.receive("UR:BYTES/AOEA");
    t = 2000;
    expect(qrError(() => late.receive("UR:BYTES/AOEA"))).toBe("scan-timeout");
  });

  it("maps a fatal frame to scan-failed and a malformed frame to progress", () => {
    // A frame whose fragment count violates the admitted limit is fatal.
    const big = payload(
      EthSignRequest.constructETHRequest(
        Buffer.from(new Uint8Array(400).fill(7)),
        DataType.personalMessage,
        PATH,
        fingerprint,
        undefined,
        undefined,
        leafAddress,
      ).toUR(),
    );
    const frames = qrParts(big, { maxFragmentLength: 100 });
    const first = frames();
    const scanner = createQrScanner({ kind: "request", now: () => 0, limits: { maxFragments: 1 } });
    expect(qrError(() => scanner.receive(first))).toBe("scan-failed");
    // A non-UR string is merely rejected: progress continues.
    const open = createQrScanner({ kind: "request", now: () => 0 });
    expect(open.receive("not-a-ur").status).toBe("progress");
  });
});

describe("readQrRequest", () => {
  it("decodes a vendor legacy transaction request", () => {
    const out = readQrRequest(
      payload(
        EthSignRequest.constructETHRequest(
          Buffer.from(LEGACY_SD),
          DataType.transaction,
          PATH,
          fingerprint,
          undefined,
          1,
        ).toUR(),
      ),
    );
    const tx = evmTxRequest(out);
    expect(tx.xfp).toBe(0x73c5da0a);
    expect(tx.path).toStrictEqual([2147483692, 2147483708, 2147483648, 0, 0]);
    expect(tx.tx.chainId).toBe(1);
    expect(bytesToHex(tx.data)).toBe(bytesToHex(LEGACY_SD));
  });

  it("decodes a vendor personal message with address and no chainId", () => {
    const message = evmPersonalRequest(readQrRequest(ethPersonalRequest()));
    expect(message.address).toBe(leafAddress);
    expect(message.chainId).toBeUndefined();
    expect(new Uint8Array(message.message)).toStrictEqual(new TextEncoder().encode("hello qr"));
  });

  it.each([
    [sha256(new TextEncoder().encode("tx")), SignType.Transaction, "transaction"],
    [new TextEncoder().encode("hi"), SignType.Message, "message"],
  ] as const)("decodes a vendor solana %s request", (data, signType, kind) => {
    const out = solanaRequest(
      readQrRequest(
        payload(
          SolSignRequest.constructSOLRequest(
            Buffer.from(data),
            "m/44'/501'/0'/0'",
            fingerprint,
            signType,
          ).toUR(),
        ),
      ),
    );
    expect(out.kind).toBe(kind);
  });

  it("decodes a vendor tron transaction request", () => {
    const out = readQrRequest(
      payload(
        TronSignRequest.constructTronRequest(
          Buffer.from(sha256(new TextEncoder().encode("trx"))),
          1,
          "m/44'/195'/0'/0/0",
          fingerprint,
        ).toUR(),
      ),
    );
    expect(tronRequest(out).kind).toBe("transaction");
  });

  it("decodes a crypto-psbt payload preserving bytes", () => {
    const psbt = hexToBytes(
      "70736274ff01007102000000011f0e4b9c1a6c2f0c0c5b8a0b7f9e8d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e50000000000ffffffff0200e1f5050000000016001411a3b0c8b7f0f5f9b1d7f0a1b2c3d4e5f6a7b8c910e1f5050000000016001411a3b0c8b7f0f5f9b1d7f0a1b2c3d4e5f6a7b8c900000000",
    );
    const out = bitcoinRequest(readQrRequest(payload(new CryptoPSBT(Buffer.from(psbt)).toUR())));
    expect(out.urType).toBe("crypto-psbt");
    expect(bytesToHex(out.psbt)).toBe(bytesToHex(psbt));
  });

  it("rejects a foreign type, RLP trailing bytes and a 0x04 envelope", () => {
    expect(qrError(() => readQrRequest({ type: "bytes", cbor: new Uint8Array([1]) }))).toBe(
      "unsupported",
    );
    const trailing = new Uint8Array([...LEGACY_SD, 0x00]);
    expect(
      qrError(() =>
        readQrRequest(
          payload(
            EthSignRequest.constructETHRequest(
              Buffer.from(trailing),
              DataType.transaction,
              PATH,
              fingerprint,
              undefined,
              1,
            ).toUR(),
          ),
        ),
      ),
    ).toBe("malformed");
    expect(
      qrError(() =>
        readQrRequest(
          payload(
            EthSignRequest.constructETHRequest(
              Buffer.from(new Uint8Array([0x04, 1])),
              DataType.typedTransaction,
              PATH,
              fingerprint,
              undefined,
              1,
            ).toUR(),
          ),
        ),
      ),
    ).toBe("unsupported");
  });
});

describe("qrResponse", () => {
  it("encodes an eth-signature a vendor decodes", () => {
    const request = readQrRequest(ethPersonalRequest()) as Extract<QrRequest, { family: "evm" }>;
    const signature = sign65(eip191("hello qr"), leafPrivate);
    const answer = qrResponse(
      request,
      { kind: "evm.personal-message", signature },
      { address: leafAddress },
    );
    const decoded = ETHSignature.fromCBOR(Buffer.from(answer.cbor));
    expect(decoded.getSignature()[64]).toBe(signature[64]);
  });

  it("refuses a signature that does not recover to the signer", () => {
    const request = readQrRequest(ethPersonalRequest());
    const signature = sign65(eip191("hello qr"), otherPrivate);
    expect(
      qrError(() =>
        qrResponse(request, { kind: "evm.personal-message", signature }, { address: leafAddress }),
      ),
    ).toBe("result-mismatch");
  });
});

describe("qrExport", () => {
  const exportResult = (): ChainExportResult => ({
    fingerprint,
    keys: wallet.keys
      .filter((key) => key.groupIndex === 0)
      .map((key) => ({
        node: key.node,
        path: key.path,
        curve: key.curve,
        publicKey: hexToBytes(key.publicKey),
        ...(key.chainCode === undefined ? {} : { chainCode: hexToBytes(key.chainCode) }),
        ...(key.parentFingerprint === undefined
          ? {}
          : { parentFingerprint: key.parentFingerprint }),
      })) as ChainExportResult["keys"],
  });

  it("produces a crypto-hdkey the vendor decodes with the expected fields", () => {
    const result = {
      fingerprint,
      keys: exportResult().keys.filter((key) => key.node.kind === "evm.account"),
    };
    const out = qrExport(result, "crypto-hdkey");
    expect(out.discloses).toBe("evm-all-addresses");
    const hd = CryptoHDKey.fromCBOR(Buffer.from(out.payload.cbor));
    expect(hd.getNote()).toBe("account.standard");
    expect(hd.getChainCode()).toStrictEqual(Buffer.from(hexToBytes(evmAccountChainCode)));
  });

  it("refuses the wrong key set for a form", () => {
    expect(qrError(() => qrExport(exportResult(), "crypto-hdkey"))).toBe("unsupported");
  });

  it("encodes crypto-multi-accounts with the constant device field", () => {
    const filtered = {
      fingerprint,
      keys: exportResult().keys.filter((key) => key.node.kind !== "evm.account"),
    };
    const out = qrExport(filtered, "crypto-multi-accounts");
    const decoded = CryptoMultiAccounts.fromCBOR(Buffer.from(out.payload.cbor));
    expect(decoded.getDevice()).toBe("qntx");
    expect(out.discloses).toBe("account-addresses");
  });
});

describe("inspectQrRequest", () => {
  it("reports the vendor-independent solana message hash", () => {
    const data = new TextEncoder().encode("hello solana");
    const request: QrRequest = {
      family: "solana",
      kind: "message",
      path: [2147483692, 2147484149, 2147483648, 2147483648],
      xfp: 1,
      data,
    };
    const out = inspectQrRequest(request);
    expect(out.digests[0]?.kind).toBe("solana-message-hash");
    expect(out.digests[0]?.value).toBe(base58.encode(sha256(data)));
  });
});

const feedScanner = (frames: ReadonlyArray<string>): void => {
  const scanner = createQrScanner({ kind: "request", now: () => 0 });
  for (const frame of frames) {
    if (scanner.receive(frame).status === "complete") {
      return;
    }
  }
};

describe("qr fuzz", () => {
  /* Each property runs comfortably under ~1 s uninstrumented; the 30 s explicit timeout is far
     past the 4x bound the fuzz policy requires. */
  it("scanner and request reader only ever throw QrError", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const scanner = createQrScanner({ kind: "request", now: () => 0 });
        expect(onlyQrError(() => scanner.receive(text))).toBe(true);
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(fc.string(), fc.uint8Array(), (type, cbor) => {
        expect(onlyQrError(() => readQrRequest({ type, cbor }))).toBe(true);
      }),
      { numRuns },
    );
  });

  it("accepted types with random cbor only ever throw QrError", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "eth-sign-request",
          "sol-sign-request",
          "tron-sign-request",
          "crypto-psbt",
          "psbt",
        ),
        fc.uint8Array({ maxLength: 256 }),
        (type, cbor) => {
          expect(onlyQrError(() => readQrRequest({ type, cbor }))).toBe(true);
        },
      ),
      { numRuns },
    );
  });

  it("mutated UR frames only ever throw QrError", { timeout: 30_000 }, () => {
    const valid = qrParts(ethPersonalRequest(), { maxFragmentLength: 40 });
    const parts: [string, string, string] = [valid(), valid(), valid()];
    fc.assert(
      fc.property(
        fc.constantFrom(...parts),
        fc.string({ maxLength: 8 }),
        fc.nat({ max: 2 }),
        (part, splice, at) => {
          const position = (at * 7) % (part.length + 1);
          const mutated = part.slice(0, position) + splice + part.slice(position + splice.length);
          expect(onlyQrError(() => feedScanner([parts[0], mutated, parts[1]]))).toBe(true);
        },
      ),
      { numRuns },
    );
  });
});
