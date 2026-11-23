import { decodeCbor, encodeCbor } from "@blockchaincommons/dcbor";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hashTypedData } from "viem";

import { ethSignRequestCodec, ethSignatureCodec } from "@qntx/ur/interop";
import type { DeviceIo, DeviceRequest, DeviceResponse } from "@qntx/wallet/hardware";

import { MNEMONIC } from "./apps-helpers.ts";

const SEED = mnemonicToSeedSync(MNEMONIC);
const HARDENED = 0x80000000;

const toDigest = (value: `0x${string}` | Uint8Array): Uint8Array =>
  typeof value === "string" ? hexToBytes(value.slice(2)) : value;

const personalDigest = (message: Uint8Array): Uint8Array =>
  keccak_256(concatBytes(utf8ToBytes(`Ethereum Signed Message:\n${message.length}`), message));

/** SignData for `eth.typed-data` is the EIP-712 JSON the kernel built from the request. */
const parseTypedData = (raw: Uint8Array): Parameters<typeof hashTypedData>[0] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- kernel-produced EIP-712 JSON
  JSON.parse(new TextDecoder().decode(raw)) as Parameters<typeof hashTypedData>[0];

/**
 * A minimal Keystone: decodes `eth-sign-request` frames with the public `@qntx/ur` codec, derives
 * the key the request's keypath names from the abandon seed, signs the digest the firmware would,
 * and answers `eth-signature`. `compare` requests (verify-address) always match.
 */
export const keystoneIo = (hang?: () => Promise<never>): DeviceIo => {
  const root = HDKey.fromMasterSeed(SEED);
  return {
    exchange: async (request: DeviceRequest): Promise<DeviceResponse> => {
      if (request.kind === "compare") {
        return { kind: "compare", matched: true };
      }
      if (request.kind !== "qr" || request.show === undefined) {
        throw new Error("unexpected device request");
      }
      if (hang !== undefined) {
        return hang();
      }
      const decoded = ethSignRequestCodec.decode(decodeCbor(request.show.cbor));
      let node = root;
      for (const component of decoded.derivationPath.components) {
        if (component.kind !== "index") {
          throw new Error("non-index keypath component");
        }
        node = node.deriveChild(component.index + (component.hardened ? HARDENED : 0));
      }
      if (node.privateKey === null) {
        throw new Error("no private key");
      }
      const digest =
        decoded.dataType === "transaction" || decoded.dataType === "typedTransaction"
          ? keccak_256(decoded.signData)
          : decoded.dataType === "personalMessage"
            ? personalDigest(decoded.signData)
            : toDigest(hashTypedData(parseTypedData(decoded.signData)));
      // `recovered` is recovery‖r‖s: the recovery byte comes first.
      const raw = secp256k1.sign(digest, node.privateKey, {
        prehash: false,
        format: "recovered",
      });
      const [recovery] = raw;
      if (recovery === undefined) {
        throw new Error("device: signature without recovery");
      }
      const signature = concatBytes(raw.subarray(1), Uint8Array.of(recovery + 27));
      const cbor = encodeCbor(
        ethSignatureCodec.encode({
          ...(decoded.requestId === undefined ? {} : { requestId: decoded.requestId }),
          signature,
        }),
      );
      return { kind: "qr", ur: { type: "eth-signature", cbor } };
    },
  };
};
