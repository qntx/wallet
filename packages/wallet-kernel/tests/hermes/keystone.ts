/**
 * Bare-Hermes smoke for the Keystone registry lane: encodes an eth-sign-request through `@qntx/ur`
 * and decodes a vendor `crypto-multi-accounts` answer from the vectors — no globals beyond ES
 * builtins, so this proves dcbor + the interop codecs run in the enclave runtime.
 */

import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";

import signVectors from "../../../../vectors/keystone/sign.json" with { type: "json" };
import syncVectors from "../../../../vectors/keystone/sync.json" with { type: "json" };
import { ethSignRequest, multiAccounts } from "../../src/modules/signers/keystone/registry.ts";

declare function print(msg: string): void;
declare function quit(code: number): never;

const HARDENED = 0x80000000;
const path = (rendered: string): number[] =>
  rendered
    .replace(/^m\//, "")
    .split("/")
    .map((segment) => Number(segment.replace(/'$/, "")) + (segment.endsWith("'") ? HARDENED : 0));

const ethCase = signVectors.cases.find((caze) => caze.name === "eth-legacy-transaction");
if (ethCase === undefined || ethCase.path === undefined || ethCase.chainId === undefined) {
  print("no eth case in vectors");
  quit(1);
}
const cbor = ethSignRequest({
  requestId: hexToBytes(signVectors.requestId),
  signData: hexToBytes(signVectors.signData),
  dataType: 1,
  chainId: ethCase.chainId,
  path: path(ethCase.path),
  fingerprint: hexToBytes(signVectors.fingerprint),
  origin: "qntx",
});
if (bytesToHex(cbor) !== ethCase.cbor) {
  print("eth-sign-request bytes differ");
  quit(1);
}

const accounts = multiAccounts(hexToBytes(syncVectors.sync.cbor));
const [first] = accounts.keys;
if (
  accounts.masterFingerprint !== Number(`0x${syncVectors.sync.masterFingerprint}`) ||
  first === undefined ||
  first.curve !== "secp256k1" ||
  first.key.keyData.length !== 33
) {
  print("crypto-multi-accounts decode failed");
  quit(1);
}

print("HERMES_KEYSTONE_OK");
