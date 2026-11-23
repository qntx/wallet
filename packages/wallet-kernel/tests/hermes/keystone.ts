/**
 * Bare-Hermes smoke for the Keystone UR decode edge: bundled to a single classic script and run on
 * the `hermes` CLI. No global shims at all — `print`/`quit` are the only host functions — so this
 * proves the `@qntx/ur` typed layer (its module-load `TextDecoder` included) and dcbor run under
 * the enclave global allow-list. The sync answer is the recorded firmware capture, decoded through
 * `parseSync` exactly as the pairing exchange does.
 */
import { hexToBytes } from "@noble/hashes/utils.js";

import { ethSignatureCodec } from "@qntx/ur/interop";

import syncVectors from "../../../../vectors/keystone/sync.json" with { type: "json" };
import { KernelError } from "../../src/errors.ts";
import { parseSync } from "../../src/modules/signers/keystone/sync.ts";
import { decodeUr, encodeUr } from "../../src/modules/signers/keystone/ur.ts";

declare function print(s: string): void;
declare function quit(code: number): void;

let checks = 0;
const check = (ok: boolean, name: string): void => {
  if (!ok) {
    throw new Error(name);
  }
  checks += 1;
};

// oxlint-disable-next-line unicorn/prefer-top-level-await -- top-level await cannot appear in the iife classic-script bundle Hermes runs
void (async (): Promise<void> => {
  try {
    const sync = parseSync({
      kind: "qr",
      ur: { type: "crypto-multi-accounts", cbor: hexToBytes(syncVectors.sync.cbor) },
    });
    check(sync.nodes.length === 6, "sync pins six secp256k1 nodes");
    check(sync.ed25519.length === 2, "sync pins two ed25519 leaves");

    // The signature decode edge sign.ts runs: an eth-signature round-trips through the codec.
    const requestId = new Uint8Array(16).fill(7);
    const signature = new Uint8Array(65).fill(3);
    const cbor = encodeUr({ requestId, signature }, ethSignatureCodec);
    const answer = decodeUr("eth-signature", cbor, ethSignatureCodec);
    check(answer.signature.length === 65, "eth-signature round-trips");

    // A hostile answer ends in the typed KernelError, never an untyped throw.
    let hostile: unknown;
    try {
      decodeUr("eth-signature", hexToBytes("a101"), ethSignatureCodec);
    } catch (error) {
      hostile = error;
    }
    check(
      hostile instanceof KernelError && hostile.code === "integrity",
      "malformed answer is integrity",
    );
    await Promise.resolve();
    print(`HERMES_KEYSTONE_OK (${checks} checks)`);
  } catch (error) {
    print(
      `HERMES_KEYSTONE_FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    quit(1);
  }
})();
