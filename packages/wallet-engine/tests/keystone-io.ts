/**
 * A Keystone 3 Pro oracle for engine tests: decodes every sign request's UR with the independent
 * `@keystonehq/bc-ur-registry-*` classes — a wrong request shape fails the vendor decode, never the
 * wallet's own parser — checks the source fingerprint like firmware does, signs with the abandon
 * seed (BIP-32 for secp256k1, SLIP-10 for ed25519) and encodes the answer with the same vendor
 * classes. `compare` requests (verify-address) always match. The logic mirrors
 * packages/wallet-kernel/tests/signers-keystone-device.ts for the engine's `DeviceIo`.
 */
import { CryptoKeypath, CryptoPSBT, extend } from "@keystonehq/bc-ur-registry";
import type { DataItem } from "@keystonehq/bc-ur-registry";
import {
  DataType as EthDataType,
  EthSignRequest,
  ETHSignature,
} from "@keystonehq/bc-ur-registry-eth";
import { SignType, SolSignature, SolSignRequest } from "@keystonehq/bc-ur-registry-sol";
import {
  DataType as TronDataType,
  TronSignature,
  TronSignRequest,
} from "@keystonehq/bc-ur-registry-tron";
import { equalBytes } from "@noble/ciphers/utils.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { hashTypedData } from "viem";

import { tronMessageDigest } from "@qntx/wallet-chains/tron";
import type { DeviceIo, DeviceRequest, DeviceResponse } from "@qntx/wallet/hardware";

import { MNEMONIC } from "./apps-helpers.ts";

const SEED = mnemonicToSeedSync(MNEMONIC);
const HARDENED = 0x80000000;

/* The paired seed's master fingerprint — the check firmware runs on every request keypath. */
const FINGERPRINT = ((): Uint8Array => {
  const root = HDKey.fromMasterSeed(SEED);
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, root.fingerprint);
  return bytes;
})();

/* The shipped typings leave these getters `any` — read them once into typed locals. */
const ethRequestId = (request: EthSignRequest): Uint8Array | undefined => request.getRequestId();
const tronRequestId = (request: TronSignRequest): Uint8Array | undefined => request.getRequestId();
const solRequestId = (request: SolSignRequest): Uint8Array | undefined => request.getRequestId();

const pathNumbers = (rendered: string): number[] =>
  [...rendered.matchAll(/(\d+)('?)/g)].map((m) => Number(m[1]) + (m[2] === "'" ? HARDENED : 0));

const renderPath = (numbers: ReadonlyArray<number>): string =>
  `m/${numbers.map((n) => (n >= HARDENED ? `${n - HARDENED}'` : `${n}`)).join("/")}`;

const personalDigest = (message: Uint8Array): Uint8Array =>
  keccak_256(
    concatBytes(utf8ToBytes(`\u0019Ethereum Signed Message:\n${message.length}`), message),
  );

// `toCBOR()` is declared `() => any` on the vendor base class; calling it through this typed
// slot keeps the any out of the answer path.
const vendorBytes = (item: { toCBOR: () => Buffer }): Buffer => item.toCBOR();

/** The PSBT derivation metadata's path, read as the number list the fixture writes. */
const numberPath = (value: unknown): number[] => {
  if (!Array.isArray(value) || !value.every((n): n is number => typeof n === "number")) {
    throw new Error("device: derivation path is not numbers");
  }
  return value;
};

const secp256k1Key = (root: HDKey, rendered: string): Uint8Array => {
  const key = root.derive(renderPath(pathNumbers(rendered))).privateKey;
  if (key === null) {
    throw new Error("device: no private key");
  }
  return key;
};

const ecdsa65 = (
  digestBytes: Uint8Array,
  privateKey: Uint8Array,
  v: (recovery: number) => number,
): Uint8Array => {
  // `recovered` is recovery‖r‖s: the recovery byte comes first.
  const signature = secp256k1.sign(digestBytes, privateKey, {
    prehash: false,
    format: "recovered",
  });
  const [recovery] = signature;
  if (recovery === undefined) {
    throw new Error("device: signature without recovery");
  }
  return concatBytes(signature.subarray(1), new Uint8Array([v(recovery)]));
};

/**
 * The source fingerprints the request's derivation keypaths carry, read through the vendor decoder
 * — the check the firmware runs before it will sign for a paired device.
 */
const itemField = (map: unknown, field: number): unknown => {
  if (typeof map !== "object" || map === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(map, field)?.value;
};

/* The decoder materializes keypath items with the DataItem prototype of its own dependency copy,
   so `instanceof` cannot identify them — a `getData` function is the structural check. */
const isDataItem = (value: unknown): value is DataItem =>
  typeof value === "object" && value !== null && "getData" in value;

const sourceFingerprints = (cbor: Buffer, field: number): Uint8Array[] => {
  const map: unknown = extend.decodeToDataItem(cbor).getData();
  const entry = itemField(map, field);
  if (entry === undefined) {
    return [];
  }
  // A map field holding an array is materialized as a plain array of data items.
  const data: unknown = isDataItem(entry) ? entry.getData() : entry;
  // A keypath field decodes to its contents; an array field to an array of data items.
  const candidates: unknown[] = Array.isArray(data) ? data : [entry];
  const items: DataItem[] = [];
  for (const candidate of candidates) {
    if (!isDataItem(candidate)) {
      throw new Error("device: keypath field is not a data item");
    }
    items.push(candidate);
  }
  return items.map((item) => {
    const fingerprint = CryptoKeypath.fromDataItem(item).getSourceFingerprint();
    return fingerprint === undefined ? new Uint8Array(0) : new Uint8Array(fingerprint);
  });
};

/**
 * A minimal Keystone: `hang` holds the exchange open the way a tap-and-cancel test needs; `compare`
 * always matches. Everything else decodes, checks and signs like firmware.
 */
const requestId = (sent: Uint8Array | undefined): Buffer | undefined =>
  sent === undefined ? undefined : Buffer.from(sent);

const answer = (cbor: Uint8Array, urType: string): DeviceResponse => ({
  kind: "qr",
  ur: { type: urType, cbor: cbor instanceof Buffer ? new Uint8Array(cbor) : cbor },
});

const fingerprintCheck = (cbor: Buffer, field: number): void => {
  for (const source of sourceFingerprints(cbor, field)) {
    if (!equalBytes(source, FINGERPRINT)) {
      throw new Error("device: master fingerprint mismatch");
    }
  }
};

export const keystoneIo = (hang?: () => Promise<unknown>): DeviceIo => {
  const root = HDKey.fromMasterSeed(SEED);
  const slip = Slip10.fromMasterSeed(SEED);

  const evm = (cbor: Buffer): DeviceResponse => {
    fingerprintCheck(cbor, 5);
    const request = EthSignRequest.fromCBOR(cbor);
    const signData = request.getSignData();
    const key = secp256k1Key(root, request.getDerivationPath());
    const type = request.getDataType();
    let signature: Uint8Array;
    if (type === EthDataType.transaction) {
      // Legacy: EIP-155 v; firmware signs keccak256 of the sign-data preimage.
      signature = ecdsa65(keccak_256(signData), key, (rec) => rec + 35 + request.getChainId() * 2);
    } else if (type === EthDataType.typedTransaction) {
      signature = ecdsa65(keccak_256(signData), key, (rec) => rec);
    } else if (type === EthDataType.personalMessage) {
      signature = ecdsa65(personalDigest(signData), key, (rec) => 27 + rec);
    } else {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the device parses arbitrary request JSON like firmware does
      const json = JSON.parse(Buffer.from(signData).toString("utf8")) as Parameters<
        typeof hashTypedData
      >[0];
      signature = ecdsa65(hexToBytes(hashTypedData(json).slice(2)), key, (rec) => 27 + rec);
    }
    return answer(
      vendorBytes(new ETHSignature(Buffer.from(signature), requestId(ethRequestId(request)))),
      "eth-signature",
    );
  };

  const tron = (cbor: Buffer): DeviceResponse => {
    fingerprintCheck(cbor, 4);
    const request = TronSignRequest.fromCBOR(cbor);
    const key = secp256k1Key(root, request.getDerivationPath());
    const signData = request.getSignData();
    const digestBytes =
      request.getDataType() === TronDataType.transaction
        ? sha256(signData)
        : tronMessageDigest(signData);
    return answer(
      vendorBytes(
        new TronSignature(
          Buffer.from(ecdsa65(digestBytes, key, (rec) => 27 + rec)),
          requestId(tronRequestId(request)),
        ),
      ),
      "tron-signature",
    );
  };

  const solana = (cbor: Buffer): DeviceResponse => {
    fingerprintCheck(cbor, 3);
    const request = SolSignRequest.fromCBOR(cbor);
    const signType = request.getSignType();
    if (signType !== SignType.Transaction && signType !== SignType.Message) {
      throw new Error("device: unknown solana sign type");
    }
    const solPath: string = request.getDerivationPath();
    const solData: Uint8Array = request.getSignData();
    const node = slip.derive(renderPath(pathNumbers(solPath)));
    return answer(
      vendorBytes(
        new SolSignature(
          Buffer.from(ed25519.sign(solData, node.privateKey)),
          requestId(solRequestId(request)),
        ),
      ),
      "sol-signature",
    );
  };

  const psbt = (cbor: Buffer): DeviceResponse => {
    const tx = Transaction.fromPSBT(new Uint8Array(CryptoPSBT.fromCBOR(cbor).getPSBT()));
    const mfp = new DataView(FINGERPRINT.buffer, FINGERPRINT.byteOffset, 4).getUint32(0);
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      const metas = [
        ...(input.bip32Derivation ?? []).map((d) => d[1]),
        ...(input.tapBip32Derivation ?? []).map((d) => d[1].der),
      ];
      for (const meta of metas) {
        if (meta.fingerprint === mfp) {
          const key = root.derive(renderPath(numberPath(meta.path)));
          if (key.privateKey !== null) {
            tx.sign(key.privateKey);
          }
        }
      }
    }
    return answer(vendorBytes(new CryptoPSBT(Buffer.from(tx.toPSBT(0)))), "crypto-psbt");
  };

  return {
    exchange: async (request: DeviceRequest): Promise<DeviceResponse> => {
      if (request.kind === "compare") {
        return { kind: "compare", matched: true };
      }
      if (request.kind !== "qr" || request.show === undefined) {
        throw new Error("unexpected device request");
      }
      if (hang !== undefined) {
        // Held exchanges still complete (or fail) the way firmware would once the user acts.
        await hang();
      }
      const cbor = Buffer.from(request.show.cbor);
      switch (request.show.type) {
        case "eth-sign-request":
          return evm(cbor);
        case "tron-sign-request":
          return tron(cbor);
        case "sol-sign-request":
          return solana(cbor);
        case "crypto-psbt":
          return psbt(cbor);
        default:
          throw new Error(`device: unknown UR type ${request.show.type}`);
      }
    },
  };
};
