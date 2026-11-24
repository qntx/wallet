/// <reference types="node" />
/**
 * Bare-Hermes entry for the engine's QR layer: every sign-request vector is emitted as UR frames
 * and read back by the bounded scanner, decoded by `readQrRequest` and inspected; a
 * crypto-multi-accounts export round-trips through `qrExport` → frames → `readQrExport`;
 * `qrSignRequest` writes requests the scanner and `readQrRequest` accept; and answers signed by
 * fixed keys verify through `readQrSignature`. Prints HERMES_QR_OK when every check passes — the
 * typed UR layer must decode AND encode under Hermes' global set.
 *
 * The minimal globals are installed first and every dependent module is imported dynamically so
 * shim ordering always precedes first use (dcbor touches TextDecoder at module load).
 */

import type { QrPayload } from "@qntx/wallet/hardware";
import type { ChainExportResult } from "@qntx/wallet/protocol";

import exportVectors from "../../../../vectors/qr/exports.json" with { type: "json" };
import requestVectors from "../../../../vectors/qr/requests.json" with { type: "json" };
import type { createQrScanner } from "../../src/qr/index.ts";

declare function print(s: string): void;
declare function quit(code: number): void;

const has = (name: string): boolean => Reflect.get(globalThis, name) !== undefined;
const install = (name: string, value: unknown): void => {
  if (!has(name)) {
    Reflect.set(globalThis, name, value);
  }
};

install("console", {
  log: print,
  info: print,
  debug: print,
  warn: print,
  error: print,
});

install("crypto", {});
{
  const cryptoHost: unknown = Reflect.get(globalThis, "crypto");
  if (
    typeof cryptoHost === "object" &&
    cryptoHost !== null &&
    typeof Reflect.get(cryptoHost, "getRandomValues") !== "function"
  ) {
    let state = 0x9e3779b9;
    Reflect.set(cryptoHost, "getRandomValues", (arr: Uint8Array): Uint8Array => {
      for (let i = 0; i < arr.length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        arr[i] = state >>> 0;
      }
      return arr;
    });
  }
}

install("queueMicrotask", (fn: () => void) => {
  // oxlint-disable-next-line promise/prefer-await-to-then -- a sync shim cannot await.
  void Promise.resolve().then(fn);
});

if (!has("TextEncoder")) {
  class HermesTextEncoder {
    readonly encoding = "utf8";
    encode(input = ""): Uint8Array {
      const out: number[] = [];
      for (let i = 0; i < input.length; i++) {
        const cp = input.codePointAt(i) ?? 0;
        if (cp > 0xffff) {
          i += 1;
        }
        if (cp < 0x80) {
          out.push(cp);
        } else if (cp < 0x800) {
          out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
          out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
          out.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f),
          );
        }
      }
      return Uint8Array.from(out);
    }
  }
  install("TextEncoder", HermesTextEncoder);
}

if (!has("TextDecoder")) {
  class HermesTextDecoder {
    readonly encoding = "utf8";
    decode(input?: ArrayBuffer | Uint8Array): string {
      if (input === undefined) {
        return "";
      }
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      let out = "";
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i];
        if (b0 === undefined) {
          break;
        }
        if (b0 < 0x80) {
          out += String.fromCodePoint(b0);
          i += 1;
          continue;
        }
        let len: number;
        if (b0 >= 0xc2 && b0 <= 0xdf) {
          len = 2;
        } else if (b0 >= 0xe0 && b0 <= 0xef) {
          len = 3;
        } else if (b0 >= 0xf0 && b0 <= 0xf4) {
          len = 4;
        } else {
          out += "�";
          i += 1;
          continue;
        }
        let cp = b0 & (0x7f >> len);
        let ok = true;
        for (let j = 1; j < len; j++) {
          const bj = bytes[i + j];
          if (bj === undefined || bj < 0x80 || bj > 0xbf) {
            ok = false;
            break;
          }
          cp = (cp << 6) | (bj & 0x3f);
        }
        if (!ok) {
          out += "�";
          i += 1;
          continue;
        }
        out += String.fromCodePoint(cp);
        i += len;
      }
      return out;
    }
  }
  install("TextDecoder", HermesTextDecoder);
}

const assert = (ok: boolean, what: string): void => {
  if (!ok) {
    throw new Error(`qr hermes check failed: ${what}`);
  }
};

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

const random = (n: number): Uint8Array => new Uint8Array(n).fill(7);

const main = async (): Promise<void> => {
  const qr = await import("../../src/qr/index.ts");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const { base58 } = await import("@scure/base");
  const { toUr } = await import("@qntx/ur/typed");
  const { ethSignatureCodec, solSignatureCodec } = await import("@qntx/ur/interop");

  /* Emit every payload as UR frames and read it back through the bounded scanner. */
  const scan = (kind: "request" | "export" | "response", payload: QrPayload): QrPayload => {
    const scanner: ReturnType<typeof createQrScanner> = qr.createQrScanner({
      kind,
      now: () => 0,
    });
    const next = qr.qrFrames(payload, { maxFragmentLength: 48 });
    for (let frame = 0; frame < 256; frame++) {
      const outcome = scanner.receive(next());
      if (outcome.status === "complete") {
        return outcome.payload;
      }
    }
    throw new Error("scanner never completed");
  };

  let decoded = 0;
  for (const row of requestVectors.requests) {
    const got = scan("request", { type: row.type, cbor: hexToBytes(row.cbor) });
    const request = qr.readQrRequest(got);
    assert(request.family === row.expect.family, `${row.name}: family`);
    assert(
      qr.inspectQrRequest(request).digests.length === row.digests.length,
      `${row.name}: digests`,
    );
    decoded += 1;
  }
  assert(decoded === requestVectors.requests.length, "request vectors decoded");

  /* Encode a multi-accounts export, scan it back, and read the links the watch wallet stores. */
  const multi = exportVectors.cases.find((row) => row.name === "multi-group0");
  assert(multi !== undefined, "multi-group0 vector present");
  if (multi === undefined) {
    return;
  }
  const keys = multi.result.keys.map((key) => {
    const out: Record<string, unknown> = { ...key, publicKey: hexToBytes(key.publicKey) };
    if (typeof key.chainCode === "string") {
      out["chainCode"] = hexToBytes(key.chainCode);
    }
    return out;
  });
  const result: ChainExportResult = {
    fingerprint: multi.result.fingerprint,
    keys: keys as unknown as ChainExportResult["keys"], // oxlint-disable-line no-unsafe-type-assertion -- vector JSON widens literal fields to string
  };
  const exported = qr.qrExport(result, "crypto-multi-accounts");
  const links = qr.readQrExport(scan("export", exported.payload));
  assert(links.length === 4, "export link count");
  for (const family of ["evm", "tron", "solana", "bitcoin"] as const) {
    assert(
      links.some((link) => link.family === family),
      `export carries ${family}`,
    );
  }

  /* Encode sign requests for the exported links and prove our own decoder accepts them. */
  const evmLink = links.find((link) => link.family === "evm");
  const tronLink = links.find((link) => link.family === "tron");
  const solanaLink = links.find((link) => link.family === "solana");
  if (evmLink === undefined || tronLink === undefined || solanaLink === undefined) {
    throw new Error("missing links");
  }
  const requests = [
    qr.qrSignRequest(
      evmLink,
      { family: "evm", kind: "personal-message", message: new TextEncoder().encode("hermes") },
      { random },
    ),
    qr.qrSignRequest(
      solanaLink,
      { family: "solana", kind: "message", data: new Uint8Array([1, 2, 3]) },
      { random },
    ),
    qr.qrSignRequest(
      tronLink,
      { family: "tron", kind: "message", data: new Uint8Array([4, 5, 6]) },
      { random },
    ),
  ];
  for (const sent of requests) {
    const got = qr.readQrRequest(scan("request", sent.payload));
    assert(got.family === sent.link.family, `request for ${sent.link.family}`);
    assert(
      got.family !== "bitcoin" && got.xfp === Number.parseInt(sent.link.fingerprint, 16),
      `xfp for ${sent.link.family}`,
    );
  }

  /* Answer the solana request with a fixed ed25519 key and verify the response end to end. */
  const secret = new Uint8Array(32).fill(9);
  const signer = {
    family: "solana" as const,
    fingerprint: "73c5da0a",
    path: "m/44'/501'/0'/0'",
    address: base58.encode(ed25519.getPublicKey(secret)),
  };
  const message = new TextEncoder().encode("sign in hermes");
  const sent = qr.qrSignRequest(
    signer,
    { family: "solana", kind: "message", data: message },
    { random },
  );
  const response = {
    type: "sol-signature",
    cbor: toUr(
      {
        ...(sent.requestId === undefined ? {} : { requestId: sent.requestId }),
        signature: ed25519.sign(message, secret),
      },
      solSignatureCodec,
    ).toCborData(),
  };
  const sol = qr.readQrSignature(sent, scan("response", response));
  if (sol.kind !== "solana.signature") {
    throw new Error("not a solana signature");
  }
  assert(sol.signature.length === 64, "solana signature bytes");

  /* The same round trip for an eth-signature: EIP-191 digest, secp256k1, sender recovery. */
  const priv = new Uint8Array(32).fill(8);
  const evmSigner = {
    family: "evm" as const,
    fingerprint: "73c5da0a",
    path: "m/44'/60'/0'/0/0",
    address: `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12))}`,
  };
  const evmMessage = new TextEncoder().encode("evm in hermes");
  const evmSent = qr.qrSignRequest(
    evmSigner,
    { family: "evm", kind: "personal-message", message: evmMessage },
    { random },
  );
  const digest = keccak_256(
    concatBytes(
      new TextEncoder().encode(`\u0019Ethereum Signed Message:\n${evmMessage.length}`),
      evmMessage,
    ),
  );
  const recovered = secp256k1.sign(digest, priv, {
    lowS: true,
    format: "recovered",
    prehash: false,
  });
  const wire = new Uint8Array(65);
  wire.set(recovered.subarray(1));
  wire[64] = 27 + (recovered[0] ?? 0);
  const ethResponse = {
    type: "eth-signature",
    cbor: toUr(
      {
        ...(evmSent.requestId === undefined ? {} : { requestId: evmSent.requestId }),
        signature: wire,
      },
      ethSignatureCodec,
    ).toCborData(),
  };
  const evm = qr.readQrSignature(evmSent, scan("response", ethResponse));
  if (evm.kind !== "evm.signature") {
    throw new Error("not an evm signature");
  }
  assert(evm.signature.length === 65, "evm signature bytes");

  print(`HERMES_QR_OK decoded=${decoded} links=${links.length} requests=${requests.length + 2}`);
};

// oxlint-disable-next-line unicorn/prefer-top-level-await -- top-level await cannot appear in the iife classic-script bundle Hermes runs
void (async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    print(
      `HERMES_QR_FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    quit(1);
  }
})();
