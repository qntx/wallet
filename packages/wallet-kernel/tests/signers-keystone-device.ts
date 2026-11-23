/**
 * A test-only Keystone 3 Pro: answers the kernel driver's QR exchanges the way firmware 3.2.2 does
 * — decodes each sign request with the independent `@keystonehq/bc-ur-registry-*` classes, refuses
 * a source fingerprint that is not the paired master fingerprint (read back through the root
 * registry's own `decodeToDataItem`), signs with its seed the way the firmware does, and encodes
 * the answer with the same classes. Nothing in `src/` is consulted, so a wrong request shape fails
 * the decode here, not in the kernel's own parser.
 */
import {
  CryptoHDKey,
  CryptoKeypath,
  CryptoMultiAccounts,
  Curve,
  extend,
  KeyDerivation,
  PathComponent,
  QRHardwareCall,
} from "@keystonehq/bc-ur-registry";
import type { DataItem } from "@keystonehq/bc-ur-registry";
import { BtcSignature, BtcSignRequest, CryptoPSBT } from "@keystonehq/bc-ur-registry-btc";
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
import { Transaction } from "@scure/btc-signer/transaction.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { hashTypedData } from "viem";

import { tronMessageDigest } from "@qntx/wallet-chains/tron";
import type { DeviceRequest, DeviceResponse } from "@qntx/wallet/protocol";

const HARDENED = 0x80000000;

/* The shipped typings leave these getters `any` — read them once into typed locals. */
const ethRequestId = (request: EthSignRequest): Uint8Array | undefined => request.getRequestId();
const tronRequestId = (request: TronSignRequest): Uint8Array | undefined => request.getRequestId();
const solRequestId = (request: SolSignRequest): Uint8Array | undefined => request.getRequestId();
const btcRequestId = (request: BtcSignRequest): Uint8Array | undefined => request.getRequestId();

/** Options that make the device hostile: one knob per test, all default to honest. */
export type DeviceMutant = {
  /** Sign with this seed instead of the paired one. */
  readonly seed?: Uint8Array;
  /** Answer with this request id instead of the one in the request. */
  readonly requestId?: Uint8Array;
  /** Mutate the produced CBOR before it goes back (e.g. flip a signature bit). */
  readonly cbor?: (bytes: Uint8Array, urType: string) => Uint8Array;
  /** Answer under a different UR type. */
  readonly urType?: string;
  /** Knobs for the `qr-hardware-call` answer only. */
  readonly accounts?: {
    /** Answer as a device with this master fingerprint instead of the paired one. */
    readonly fingerprint?: Uint8Array;
    /** Do not send the key for this path (`m/…` string). */
    readonly dropPath?: string;
    /** Send a key for this path too. */
    readonly extraPath?: string;
    /** Send the key for this path twice. */
    readonly duplicatePath?: string;
    /** Corrupt the public key bytes sent for this path. */
    readonly badKeyPath?: string;
  };
};

const pathNumbers = (rendered: string): number[] =>
  [...rendered.matchAll(/(\d+)('?)/g)].map((m) => Number(m[1]) + (m[2] === "'" ? HARDENED : 0));

const renderPath = (numbers: ReadonlyArray<number>): string =>
  `m/${numbers.map((n) => (n >= HARDENED ? `${n - HARDENED}'` : `${n}`)).join("/")}`;

const personalDigest = (message: Uint8Array): Uint8Array =>
  keccak_256(
    concatBytes(utf8ToBytes(`\u0019Ethereum Signed Message:\n${message.length}`), message),
  );

// `toCBOR()` is declared `() => any` on the vendor base class; calling it through this typed
// slot keeps the any out of `answer`'s parameters.
const vendorBytes = (item: { toCBOR: () => Buffer }): Buffer => item.toCBOR();

/** The PSBT derivation metadata's path, read as the number list the fixture writes. */
const numberPath = (value: unknown): number[] => {
  if (!Array.isArray(value) || !value.every((n): n is number => typeof n === "number")) {
    throw new Error("device: derivation path is not numbers");
  }
  return value;
};

const compactSize = (n: number): Uint8Array => {
  if (n < 0xfd) {
    return new Uint8Array([n]);
  }
  const out = new Uint8Array(3);
  out[0] = 0xfd;
  new DataView(out.buffer).setUint16(1, n, true);
  return out;
};

/** The Bitcoin legacy message digest — kept local so the device borrows no kernel code. */
const btcMessageHash = (message: string): Uint8Array => {
  const prefix = utf8ToBytes("\u0018Bitcoin Signed Message:\n");
  const body = utf8ToBytes(message);
  return sha256(sha256(concatBytes(prefix, compactSize(body.length), body)));
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
 * The device: `fingerprint` is the master fingerprint the paired seed advertises; `mutant` turns
 * single knobs hostile. `respond` throws on anything the real device could not parse or refuses.
 */
export const keystoneDevice = (
  seed: Uint8Array,
  fingerprint: Uint8Array,
  mutant: DeviceMutant = {},
): { readonly respond: (request: DeviceRequest) => DeviceResponse } => {
  const root = HDKey.fromMasterSeed(mutant.seed ?? seed);
  const slip = Slip10.fromMasterSeed(mutant.seed ?? seed);

  const requestId = (sent: Uint8Array | undefined): Buffer | undefined => {
    const id = mutant.requestId ?? sent;
    return id === undefined ? undefined : Buffer.from(id);
  };

  const answer = (cbor: Uint8Array, urType: string): DeviceResponse => {
    // Vendor encoders hand back Node Buffers; the wire carries plain Uint8Array.
    const bytes = (mutant.cbor ?? ((b) => b))(cbor, urType);
    return {
      kind: "qr",
      ur: {
        type: mutant.urType ?? urType,
        cbor: bytes instanceof Buffer ? new Uint8Array(bytes) : bytes,
      },
    };
  };

  const fingerprintCheck = (cbor: Buffer, field: number): void => {
    for (const source of sourceFingerprints(cbor, field)) {
      if (!equalBytes(source, fingerprint)) {
        throw new Error("device: master fingerprint mismatch");
      }
    }
  };

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

  const bitcoinMessage = (cbor: Buffer): DeviceResponse => {
    fingerprintCheck(cbor, 4);
    const request = BtcSignRequest.fromCBOR(cbor);
    const [path] = request.getDerivationPaths();
    if (path === undefined) {
      throw new Error("device: no derivation path");
    }
    const key = secp256k1Key(root, path);
    // Firmware signs the legacy "\x18Bitcoin Signed Message:\n" digest and returns a 65-byte
    // compact signature — header 27 + rec + 4 for the compressed key — plus the pubkey.
    const message = Buffer.from(request.getSignData()).toString("utf8");
    const signature = secp256k1.sign(btcMessageHash(message), key, {
      prehash: false,
      format: "recovered",
    });
    const compact = concatBytes(
      new Uint8Array([27 + (signature[0] ?? 0) + 4]),
      signature.subarray(1),
    );
    return answer(
      vendorBytes(
        new BtcSignature(
          Buffer.from(compact),
          requestId(btcRequestId(request)) ?? Buffer.alloc(16),
          Buffer.from(secp256k1.getPublicKey(key, true)),
        ),
      ),
      "btc-signature",
    );
  };

  const psbt = (cbor: Buffer): DeviceResponse => {
    const tx = Transaction.fromPSBT(new Uint8Array(CryptoPSBT.fromCBOR(cbor).getPSBT()));
    const mfp = new DataView(fingerprint.buffer, fingerprint.byteOffset, 4).getUint32(0);
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

  /**
   * The key-derivation call: firmware derives each requested path and answers a
   * `crypto-multi-accounts` whose hdkeys carry an origin keypath without a source fingerprint.
   */
  const hardwareCall = (cbor: Buffer): DeviceResponse => {
    const call = QRHardwareCall.fromCBOR(cbor);
    const params = call.getParams();
    if (!(params instanceof KeyDerivation)) {
      throw new TypeError("device: hardware call is not a key derivation");
    }
    const schemas = params.getSchemas();
    const knobs = mutant.accounts ?? {};
    const mfp = knobs.fingerprint ?? fingerprint;

    const keyFor = (rendered: string, edOnly: boolean): CryptoHDKey => {
      const components = pathNumbers(rendered).map(
        (n) => new PathComponent({ index: n % HARDENED, hardened: n >= HARDENED }),
      );
      const origin = new CryptoKeypath(components);
      if (edOnly) {
        // micro-key-producer prefixes the ed25519 public key with 0x00 for its extended form;
        // the wire format carries the bare 32 bytes.
        const publicKey = slip.derive(rendered).publicKey.subarray(1);
        return new CryptoHDKey({
          isMaster: false,
          key: Buffer.from(knobs.badKeyPath === rendered ? publicKey.subarray(0, -1) : publicKey),
          origin,
        });
      }
      const node = root.derive(rendered);
      if (node.publicKey === null || node.chainCode === null) {
        throw new Error(`device: no public key at ${rendered}`);
      }
      const parent = Buffer.alloc(4);
      parent.writeUInt32BE(node.parentFingerprint);
      const corrupt = knobs.badKeyPath === rendered;
      const publicKey = corrupt
        ? Buffer.concat([Buffer.from([0x00]), node.publicKey.subarray(1)])
        : Buffer.from(node.publicKey);
      return new CryptoHDKey({
        isMaster: false,
        key: publicKey,
        chainCode: Buffer.from(node.chainCode),
        origin,
        parentFingerprint: parent,
      });
    };

    const keys: CryptoHDKey[] = [];
    for (const schema of schemas) {
      const rendered = renderPath(pathNumbers(schema.getKeypath().getPath() ?? ""));
      if (knobs.dropPath === rendered) {
        continue;
      }
      keys.push(keyFor(rendered, schema.getCurve() === Curve.ed25519));
      if (knobs.duplicatePath === rendered) {
        keys.push(keyFor(rendered, schema.getCurve() === Curve.ed25519));
      }
    }
    if (knobs.extraPath !== undefined) {
      keys.push(keyFor(knobs.extraPath, false));
    }
    return answer(
      vendorBytes(
        new CryptoMultiAccounts(Buffer.from(mfp), keys, "Keystone 3 Pro", undefined, "3.2.2"),
      ),
      "crypto-multi-accounts",
    );
  };

  return {
    respond: (request: DeviceRequest): DeviceResponse => {
      if (request.kind !== "qr" || request.show === undefined) {
        throw new Error(`device: unexpected request ${JSON.stringify(request.kind)}`);
      }
      const cbor = Buffer.from(request.show.cbor);
      switch (request.show.type) {
        case "eth-sign-request":
          return evm(cbor);
        case "tron-sign-request":
          return tron(cbor);
        case "sol-sign-request":
          return solana(cbor);
        case "btc-sign-request":
          return bitcoinMessage(cbor);
        case "crypto-psbt":
          return psbt(cbor);
        case "qr-hardware-call":
          return hardwareCall(cbor);
        default:
          throw new Error(`device: unknown UR type ${request.show.type}`);
      }
    },
  };
};
