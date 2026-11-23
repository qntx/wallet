/**
 * The message descriptors the client uses — message type ids and field numbers only, each cited to
 * the firmware `.proto` file they were read from. Both schemas agree on every field listed here
 * (firmware-pro v4.21.0 and firmware-classic1s v3.21.0, `common/protob/`); fields where they
 * disagree are omitted, except the classic1s-only BixinPinInputOnDevice noted inline.
 */
import { defineMessage } from "./proto.ts";
import type { MessageDef } from "./proto.ts";

type Field<K extends string, N extends number, R extends string> = {
  readonly no: N;
  readonly kind: K;
  readonly rule: R;
};

// firmware-pro/classic1s common/protob/messages-management.proto Initialize
export type InitializeFields = { sessionId: Field<"bytes", 1, "optional"> };
export const Initialize: MessageDef<InitializeFields> = defineMessage(0, {
  sessionId: { no: 1, kind: "bytes", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-management.proto Features — only the fields
// both schemas number identically and the client reads.
export type FeaturesFields = {
  vendor: Field<"string", 1, "optional">;
  majorVersion: Field<"uint32", 2, "required">;
  minorVersion: Field<"uint32", 3, "required">;
  patchVersion: Field<"uint32", 4, "required">;
  bootloaderMode: Field<"bool", 5, "optional">;
  deviceId: Field<"string", 6, "optional">;
  pinProtection: Field<"bool", 7, "optional">;
  passphraseProtection: Field<"bool", 8, "optional">;
  label: Field<"string", 10, "optional">;
  initialized: Field<"bool", 12, "optional">;
  unlocked: Field<"bool", 16, "optional">;
  model: Field<"string", 21, "optional">;
  capabilities: Field<"enum", 30, "repeated">;
  sessionId: Field<"bytes", 35, "optional">;
  onekeyVersion: Field<"string", 508, "optional">;
  onekeyDeviceType: Field<"enum", 600, "optional">;
  onekeyFirmwareVersion: Field<"string", 609, "optional">;
  onekeySerialNo: Field<"string", 612, "optional">;
};
export const Features: MessageDef<FeaturesFields> = defineMessage(17, {
  vendor: { no: 1, kind: "string", rule: "optional" },
  majorVersion: { no: 2, kind: "uint32", rule: "required" },
  minorVersion: { no: 3, kind: "uint32", rule: "required" },
  patchVersion: { no: 4, kind: "uint32", rule: "required" },
  bootloaderMode: { no: 5, kind: "bool", rule: "optional" },
  deviceId: { no: 6, kind: "string", rule: "optional" },
  pinProtection: { no: 7, kind: "bool", rule: "optional" },
  passphraseProtection: { no: 8, kind: "bool", rule: "optional" },
  label: { no: 10, kind: "string", rule: "optional" },
  initialized: { no: 12, kind: "bool", rule: "optional" },
  unlocked: { no: 16, kind: "bool", rule: "optional" },
  model: { no: 21, kind: "string", rule: "optional" },
  capabilities: { no: 30, kind: "enum", rule: "repeated" },
  sessionId: { no: 35, kind: "bytes", rule: "optional" },
  onekeyVersion: { no: 508, kind: "string", rule: "optional" },
  onekeyDeviceType: { no: 600, kind: "enum", rule: "optional" },
  onekeyFirmwareVersion: { no: 609, kind: "string", rule: "optional" },
  onekeySerialNo: { no: 612, kind: "string", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-common.proto Failure
export type FailureFields = {
  code: Field<"enum", 1, "optional">;
  message: Field<"string", 2, "optional">;
};
export const Failure: MessageDef<FailureFields> = defineMessage(3, {
  code: { no: 1, kind: "enum", rule: "optional" },
  message: { no: 2, kind: "string", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-common.proto ButtonRequest
export type ButtonRequestFields = {
  code: Field<"enum", 1, "optional">;
  pages: Field<"uint32", 2, "optional">;
};
export const ButtonRequest: MessageDef<ButtonRequestFields> = defineMessage(26, {
  code: { no: 1, kind: "enum", rule: "optional" },
  pages: { no: 2, kind: "uint32", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-common.proto ButtonAck
export type ButtonAckFields = Record<never, never>;
export const ButtonAck: MessageDef<ButtonAckFields> = defineMessage(27, {});

// firmware-pro/classic1s common/protob/messages-common.proto PinMatrixRequest
export type PinMatrixRequestFields = { type: Field<"enum", 1, "optional"> };
export const PinMatrixRequest: MessageDef<PinMatrixRequestFields> = defineMessage(18, {
  type: { no: 1, kind: "enum", rule: "optional" },
});

// firmware-classic1s common/protob/messages-common.proto BixinPinInputOnDevice — exists only in
// the classic1s schema (messages.proto:438); core devices never see it because they enter the
// PIN on the device without a PinMatrixRequest.
export type BixinPinInputOnDeviceFields = Record<never, never>;
export const BixinPinInputOnDevice: MessageDef<BixinPinInputOnDeviceFields> = defineMessage(
  10_000,
  {},
);

// firmware-pro/classic1s common/protob/messages-common.proto PassphraseRequest — decoded (not
// skipped) so a structurally malformed request is still a device-fault; attach-pin requests get
// the same on-device ack as any other.
export type PassphraseRequestFields = {
  existsAttachPinUser: Field<"bool", 8000, "optional">;
};
export const PassphraseRequest: MessageDef<PassphraseRequestFields> = defineMessage(41, {
  existsAttachPinUser: { no: 8000, kind: "bool", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-common.proto PassphraseAck — only on_device is
// ever sent; the client never transmits passphrase text or the attach-pin variant.
export type PassphraseAckFields = { onDevice: Field<"bool", 3, "optional"> };
export const PassphraseAck: MessageDef<PassphraseAckFields> = defineMessage(42, {
  onDevice: { no: 3, kind: "bool", rule: "optional" },
});

type MsgField<N extends number, R extends string, M extends MessageDef> = {
  readonly no: N;
  readonly kind: "message";
  readonly rule: R;
  readonly message: M;
};

// firmware-pro/classic1s common/protob/messages-common.proto HDNodeType — a nested BIP-32 node,
// not a wire message; the -1 type id is a sentinel that is never serialized.
export type HDNodeFields = {
  depth: Field<"uint32", 1, "required">;
  fingerprint: Field<"uint32", 2, "required">;
  childNum: Field<"uint32", 3, "required">;
  chainCode: Field<"bytes", 4, "required">;
  privateKey: Field<"bytes", 5, "optional">;
  publicKey: Field<"bytes", 6, "required">;
};
export const HDNodeType: MessageDef<HDNodeFields> = {
  typeId: -1,
  fields: {
    depth: { no: 1, kind: "uint32", rule: "required" },
    fingerprint: { no: 2, kind: "uint32", rule: "required" },
    childNum: { no: 3, kind: "uint32", rule: "required" },
    chainCode: { no: 4, kind: "bytes", rule: "required" },
    privateKey: { no: 5, kind: "bytes", rule: "optional" },
    publicKey: { no: 6, kind: "bytes", rule: "required" },
  },
};

// firmware-pro/classic1s common/protob/messages-bitcoin.proto GetPublicKey
export type GetPublicKeyFields = {
  addressN: Field<"uint32", 1, "repeated">;
  showDisplay: Field<"bool", 3, "optional">;
  coinName: Field<"string", 4, "optional">;
  scriptType: Field<"enum", 5, "optional">;
};
export const GetPublicKey: MessageDef<GetPublicKeyFields> = defineMessage(11, {
  addressN: { no: 1, kind: "uint32", rule: "repeated" },
  showDisplay: { no: 3, kind: "bool", rule: "optional" },
  coinName: { no: 4, kind: "string", rule: "optional" },
  scriptType: { no: 5, kind: "enum", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-bitcoin.proto PublicKey
export type PublicKeyFields = {
  node: MsgField<1, "required", typeof HDNodeType>;
  xpub: Field<"string", 2, "required">;
  rootFingerprint: Field<"uint32", 3, "optional">;
};
export const PublicKey: MessageDef<PublicKeyFields> = defineMessage(12, {
  node: { no: 1, kind: "message", rule: "required", message: HDNodeType },
  xpub: { no: 2, kind: "string", rule: "required" },
  rootFingerprint: { no: 3, kind: "uint32", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-bitcoin.proto GetAddress
export type GetAddressFields = {
  addressN: Field<"uint32", 1, "repeated">;
  coinName: Field<"string", 2, "optional">;
  showDisplay: Field<"bool", 3, "optional">;
  scriptType: Field<"enum", 5, "optional">;
};
export const GetAddress: MessageDef<GetAddressFields> = defineMessage(29, {
  addressN: { no: 1, kind: "uint32", rule: "repeated" },
  coinName: { no: 2, kind: "string", rule: "optional" },
  showDisplay: { no: 3, kind: "bool", rule: "optional" },
  scriptType: { no: 5, kind: "enum", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-bitcoin.proto Address
export type AddressFields = { address: Field<"string", 1, "required"> };
export const Address: MessageDef<AddressFields> = defineMessage(30, {
  address: { no: 1, kind: "string", rule: "required" },
});

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto EthereumGetPublicKeyOneKey
export type EthereumGetPublicKeyOneKeyFields = {
  addressN: Field<"uint32", 1, "repeated">;
  showDisplay: Field<"bool", 2, "optional">;
  chainId: Field<"uint64", 3, "optional">;
};
export const EthereumGetPublicKeyOneKey: MessageDef<EthereumGetPublicKeyOneKeyFields> =
  defineMessage(20_100, {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    showDisplay: { no: 2, kind: "bool", rule: "optional" },
    chainId: { no: 3, kind: "uint64", rule: "optional" },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto EthereumPublicKeyOneKey
export type EthereumPublicKeyOneKeyFields = {
  node: MsgField<1, "required", typeof HDNodeType>;
  xpub: Field<"string", 2, "required">;
};
export const EthereumPublicKeyOneKey: MessageDef<EthereumPublicKeyOneKeyFields> = defineMessage(
  20_101,
  {
    node: { no: 1, kind: "message", rule: "required", message: HDNodeType },
    xpub: { no: 2, kind: "string", rule: "required" },
  },
);

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto EthereumGetAddressOneKey
export type EthereumGetAddressOneKeyFields = {
  addressN: Field<"uint32", 1, "repeated">;
  showDisplay: Field<"bool", 2, "optional">;
  chainId: Field<"uint64", 3, "optional">;
};
export const EthereumGetAddressOneKey: MessageDef<EthereumGetAddressOneKeyFields> = defineMessage(
  20_102,
  {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    showDisplay: { no: 2, kind: "bool", rule: "optional" },
    chainId: { no: 3, kind: "uint64", rule: "optional" },
  },
);

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto EthereumAddressOneKey
export type EthereumAddressOneKeyFields = { address: Field<"string", 2, "optional"> };
export const EthereumAddressOneKey: MessageDef<EthereumAddressOneKeyFields> = defineMessage(
  20_103,
  {
    address: { no: 2, kind: "string", rule: "optional" },
  },
);

// firmware-pro/classic1s common/protob/messages-solana.proto SolanaGetAddress
export type SolanaGetAddressFields = {
  addressN: Field<"uint32", 1, "repeated">;
  showDisplay: Field<"bool", 2, "optional">;
};
export const SolanaGetAddress: MessageDef<SolanaGetAddressFields> = defineMessage(10_100, {
  addressN: { no: 1, kind: "uint32", rule: "repeated" },
  showDisplay: { no: 2, kind: "bool", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-solana.proto SolanaAddress
export type SolanaAddressFields = { address: Field<"string", 1, "required"> };
export const SolanaAddress: MessageDef<SolanaAddressFields> = defineMessage(10_101, {
  address: { no: 1, kind: "string", rule: "required" },
});

// firmware-pro/classic1s common/protob/messages-tron.proto TronGetAddress
export type TronGetAddressFields = {
  addressN: Field<"uint32", 1, "repeated">;
  showDisplay: Field<"bool", 2, "optional">;
};
export const TronGetAddress: MessageDef<TronGetAddressFields> = defineMessage(10_501, {
  addressN: { no: 1, kind: "uint32", rule: "repeated" },
  showDisplay: { no: 2, kind: "bool", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-tron.proto TronAddress — optional in the schema,
// so a missing field surfaces as a device-fault in keys.ts rather than a decode failure.
export type TronAddressFields = { address: Field<"string", 1, "optional"> };
export const TronAddress: MessageDef<TronAddressFields> = defineMessage(10_502, {
  address: { no: 1, kind: "string", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto EthereumAccessListOneKey —
// a nested record, not a wire message.
export type EthereumAccessListFields = {
  address: Field<"string", 1, "required">;
  storageKeys: Field<"bytes", 2, "repeated">;
};
export const EthereumAccessListOneKey: MessageDef<EthereumAccessListFields> = {
  typeId: -1,
  fields: {
    address: { no: 1, kind: "string", rule: "required" },
    storageKeys: { no: 2, kind: "bytes", rule: "repeated" },
  },
};

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto
// EthereumAuthorizationSignature — a nested record, not a wire message.
export type EthereumAuthorizationSignatureFields = {
  yParity: Field<"uint32", 1, "required">;
  r: Field<"bytes", 2, "required">;
  s: Field<"bytes", 3, "required">;
};
export const EthereumAuthorizationSignature: MessageDef<EthereumAuthorizationSignatureFields> = {
  typeId: -1,
  fields: {
    yParity: { no: 1, kind: "uint32", rule: "required" },
    r: { no: 2, kind: "bytes", rule: "required" },
    s: { no: 3, kind: "bytes", rule: "required" },
  },
};

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto
// EthereumAuthorizationOneKey — nested inside EthereumSignTxEIP7702OneKey.
export type EthereumAuthorizationFields = {
  addressN: Field<"uint32", 1, "repeated">;
  chainId: Field<"uint64", 2, "required">;
  address: Field<"string", 3, "required">;
  nonce: Field<"bytes", 4, "required">;
  signature: MsgField<5, "optional", typeof EthereumAuthorizationSignature>;
};
export const EthereumAuthorizationOneKey: MessageDef<EthereumAuthorizationFields> = {
  typeId: -1,
  fields: {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    chainId: { no: 2, kind: "uint64", rule: "required" },
    address: { no: 3, kind: "string", rule: "required" },
    nonce: { no: 4, kind: "bytes", rule: "required" },
    signature: {
      no: 5,
      kind: "message",
      rule: "optional",
      message: EthereumAuthorizationSignature,
    },
  },
};

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto EthereumSignTxOneKey
export type EthereumSignTxOneKeyFields = {
  addressN: Field<"uint32", 1, "repeated">;
  nonce: Field<"bytes", 2, "optional">;
  gasPrice: Field<"bytes", 3, "required">;
  gasLimit: Field<"bytes", 4, "required">;
  to: Field<"string", 11, "optional">;
  value: Field<"bytes", 6, "optional">;
  dataInitialChunk: Field<"bytes", 7, "optional">;
  dataLength: Field<"uint32", 8, "optional">;
  chainId: Field<"uint64", 9, "required">;
  txType: Field<"uint32", 10, "optional">;
};
export const EthereumSignTxOneKey: MessageDef<EthereumSignTxOneKeyFields> = defineMessage(20_104, {
  addressN: { no: 1, kind: "uint32", rule: "repeated" },
  nonce: { no: 2, kind: "bytes", rule: "optional" },
  gasPrice: { no: 3, kind: "bytes", rule: "required" },
  gasLimit: { no: 4, kind: "bytes", rule: "required" },
  to: { no: 11, kind: "string", rule: "optional" },
  value: { no: 6, kind: "bytes", rule: "optional" },
  dataInitialChunk: { no: 7, kind: "bytes", rule: "optional" },
  dataLength: { no: 8, kind: "uint32", rule: "optional" },
  chainId: { no: 9, kind: "uint64", rule: "required" },
  txType: { no: 10, kind: "uint32", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto
// EthereumSignTxEIP1559OneKey
export type EthereumSignTxEIP1559OneKeyFields = {
  addressN: Field<"uint32", 1, "repeated">;
  nonce: Field<"bytes", 2, "required">;
  maxGasFee: Field<"bytes", 3, "required">;
  maxPriorityFee: Field<"bytes", 4, "required">;
  gasLimit: Field<"bytes", 5, "required">;
  to: Field<"string", 6, "optional">;
  value: Field<"bytes", 7, "required">;
  dataInitialChunk: Field<"bytes", 8, "optional">;
  dataLength: Field<"uint32", 9, "required">;
  chainId: Field<"uint64", 10, "required">;
  accessList: MsgField<11, "repeated", typeof EthereumAccessListOneKey>;
};
export const EthereumSignTxEIP1559OneKey: MessageDef<EthereumSignTxEIP1559OneKeyFields> =
  defineMessage(20_105, {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    nonce: { no: 2, kind: "bytes", rule: "required" },
    maxGasFee: { no: 3, kind: "bytes", rule: "required" },
    maxPriorityFee: { no: 4, kind: "bytes", rule: "required" },
    gasLimit: { no: 5, kind: "bytes", rule: "required" },
    to: { no: 6, kind: "string", rule: "optional" },
    value: { no: 7, kind: "bytes", rule: "required" },
    dataInitialChunk: { no: 8, kind: "bytes", rule: "optional" },
    dataLength: { no: 9, kind: "uint32", rule: "required" },
    chainId: { no: 10, kind: "uint64", rule: "required" },
    accessList: {
      no: 11,
      kind: "message",
      rule: "repeated",
      message: EthereumAccessListOneKey,
    },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto
// EthereumSignTxEIP7702OneKey
export type EthereumSignTxEIP7702OneKeyFields = {
  addressN: Field<"uint32", 1, "repeated">;
  nonce: Field<"bytes", 2, "required">;
  maxGasFee: Field<"bytes", 3, "required">;
  maxPriorityFee: Field<"bytes", 4, "required">;
  gasLimit: Field<"bytes", 5, "required">;
  to: Field<"string", 6, "required">;
  value: Field<"bytes", 7, "required">;
  dataInitialChunk: Field<"bytes", 8, "optional">;
  dataLength: Field<"uint32", 9, "required">;
  chainId: Field<"uint64", 10, "required">;
  accessList: MsgField<11, "repeated", typeof EthereumAccessListOneKey>;
  authorizationList: MsgField<12, "repeated", typeof EthereumAuthorizationOneKey>;
};
export const EthereumSignTxEIP7702OneKey: MessageDef<EthereumSignTxEIP7702OneKeyFields> =
  defineMessage(20_120, {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    nonce: { no: 2, kind: "bytes", rule: "required" },
    maxGasFee: { no: 3, kind: "bytes", rule: "required" },
    maxPriorityFee: { no: 4, kind: "bytes", rule: "required" },
    gasLimit: { no: 5, kind: "bytes", rule: "required" },
    to: { no: 6, kind: "string", rule: "required" },
    value: { no: 7, kind: "bytes", rule: "required" },
    dataInitialChunk: { no: 8, kind: "bytes", rule: "optional" },
    dataLength: { no: 9, kind: "uint32", rule: "required" },
    chainId: { no: 10, kind: "uint64", rule: "required" },
    accessList: {
      no: 11,
      kind: "message",
      rule: "repeated",
      message: EthereumAccessListOneKey,
    },
    authorizationList: {
      no: 12,
      kind: "message",
      rule: "repeated",
      message: EthereumAuthorizationOneKey,
    },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto EthereumTxRequestOneKey
export type EthereumTxRequestOneKeyFields = {
  dataLength: Field<"uint32", 1, "optional">;
  signatureV: Field<"uint32", 2, "optional">;
  signatureR: Field<"bytes", 3, "optional">;
  signatureS: Field<"bytes", 4, "optional">;
  authorizationSignatures: MsgField<10, "repeated", typeof EthereumAuthorizationSignature>;
};
export const EthereumTxRequestOneKey: MessageDef<EthereumTxRequestOneKeyFields> = defineMessage(
  20_106,
  {
    dataLength: { no: 1, kind: "uint32", rule: "optional" },
    signatureV: { no: 2, kind: "uint32", rule: "optional" },
    signatureR: { no: 3, kind: "bytes", rule: "optional" },
    signatureS: { no: 4, kind: "bytes", rule: "optional" },
    authorizationSignatures: {
      no: 10,
      kind: "message",
      rule: "repeated",
      message: EthereumAuthorizationSignature,
    },
  },
);

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto EthereumTxAckOneKey
export type EthereumTxAckOneKeyFields = { dataChunk: Field<"bytes", 1, "required"> };
export const EthereumTxAckOneKey: MessageDef<EthereumTxAckOneKeyFields> = defineMessage(20_107, {
  dataChunk: { no: 1, kind: "bytes", rule: "required" },
});

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto
// EthereumSignMessageOneKey
export type EthereumSignMessageOneKeyFields = {
  addressN: Field<"uint32", 1, "repeated">;
  message: Field<"bytes", 2, "required">;
  chainId: Field<"uint64", 3, "optional">;
};
export const EthereumSignMessageOneKey: MessageDef<EthereumSignMessageOneKeyFields> = defineMessage(
  20_108,
  {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    message: { no: 2, kind: "bytes", rule: "required" },
    chainId: { no: 3, kind: "uint64", rule: "optional" },
  },
);

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto
// EthereumMessageSignatureOneKey — signature is the 65-byte r‖s‖v (see sign_message.py
// `signature[1:] + signature[0:1]`).
export type EthereumMessageSignatureOneKeyFields = {
  signature: Field<"bytes", 2, "required">;
  address: Field<"string", 3, "required">;
};
export const EthereumMessageSignatureOneKey: MessageDef<EthereumMessageSignatureOneKeyFields> =
  defineMessage(20_110, {
    signature: { no: 2, kind: "bytes", rule: "required" },
    address: { no: 3, kind: "string", rule: "required" },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-eip712-onekey.proto
// EthereumFieldTypeOneKey — a nested record; entryType is self-referential for nested arrays.
export type EthereumFieldTypeOneKeyFields = {
  dataType: Field<"enum", 1, "required">;
  size: Field<"uint32", 2, "optional">;
  entryType: MsgField<3, "optional", MessageDef>;
  structName: Field<"string", 4, "optional">;
};
export const EthereumFieldTypeOneKey: MessageDef<EthereumFieldTypeOneKeyFields> = {
  typeId: -1,
  fields: {
    dataType: { no: 1, kind: "enum", rule: "required" },
    size: { no: 2, kind: "uint32", rule: "optional" },
    // Self-referential (arrays of arrays): the getter resolves the descriptor lazily so the
    // definition can stay a literal.
    entryType: {
      no: 3,
      kind: "message",
      rule: "optional",
      get message() {
        return EthereumFieldTypeOneKey;
      },
    },
    structName: { no: 4, kind: "string", rule: "optional" },
  },
};

// firmware-pro/classic1s common/protob/messages-ethereum-eip712-onekey.proto
// EthereumStructMemberOneKey — a nested record.
export type EthereumStructMemberOneKeyFields = {
  type: MsgField<1, "required", typeof EthereumFieldTypeOneKey>;
  name: Field<"string", 2, "required">;
};
export const EthereumStructMemberOneKey: MessageDef<EthereumStructMemberOneKeyFields> = {
  typeId: -1,
  fields: {
    type: { no: 1, kind: "message", rule: "required", message: EthereumFieldTypeOneKey },
    name: { no: 2, kind: "string", rule: "required" },
  },
};

// firmware-pro/classic1s common/protob/messages-ethereum-eip712-onekey.proto
// EthereumSignTypedDataOneKey
export type EthereumSignTypedDataOneKeyFields = {
  addressN: Field<"uint32", 1, "repeated">;
  primaryType: Field<"string", 2, "required">;
  metamaskV4Compat: Field<"bool", 3, "optional">;
  chainId: Field<"uint64", 4, "optional">;
};
export const EthereumSignTypedDataOneKey: MessageDef<EthereumSignTypedDataOneKeyFields> =
  defineMessage(20_111, {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    primaryType: { no: 2, kind: "string", rule: "required" },
    metamaskV4Compat: { no: 3, kind: "bool", rule: "optional" },
    chainId: { no: 4, kind: "uint64", rule: "optional" },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-eip712-onekey.proto
// EthereumTypedDataStructRequestOneKey
export type EthereumTypedDataStructRequestOneKeyFields = {
  name: Field<"string", 1, "required">;
};
export const EthereumTypedDataStructRequestOneKey: MessageDef<EthereumTypedDataStructRequestOneKeyFields> =
  defineMessage(20_112, {
    name: { no: 1, kind: "string", rule: "required" },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-eip712-onekey.proto
// EthereumTypedDataStructAckOneKey
export type EthereumTypedDataStructAckOneKeyFields = {
  members: MsgField<1, "repeated", typeof EthereumStructMemberOneKey>;
};
export const EthereumTypedDataStructAckOneKey: MessageDef<EthereumTypedDataStructAckOneKeyFields> =
  defineMessage(20_113, {
    members: {
      no: 1,
      kind: "message",
      rule: "repeated",
      message: EthereumStructMemberOneKey,
    },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-eip712-onekey.proto
// EthereumTypedDataValueRequestOneKey
export type EthereumTypedDataValueRequestOneKeyFields = {
  memberPath: Field<"uint32", 1, "repeated">;
};
export const EthereumTypedDataValueRequestOneKey: MessageDef<EthereumTypedDataValueRequestOneKeyFields> =
  defineMessage(20_114, {
    memberPath: { no: 1, kind: "uint32", rule: "repeated" },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-eip712-onekey.proto
// EthereumTypedDataValueAckOneKey
export type EthereumTypedDataValueAckOneKeyFields = {
  value: Field<"bytes", 1, "required">;
};
export const EthereumTypedDataValueAckOneKey: MessageDef<EthereumTypedDataValueAckOneKeyFields> =
  defineMessage(20_115, {
    value: { no: 1, kind: "bytes", rule: "required" },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-eip712-onekey.proto
// EthereumTypedDataSignatureOneKey — also the answer to EthereumSignTypedHashOneKey.
export type EthereumTypedDataSignatureOneKeyFields = {
  signature: Field<"bytes", 1, "required">;
  address: Field<"string", 2, "required">;
};
export const EthereumTypedDataSignatureOneKey: MessageDef<EthereumTypedDataSignatureOneKeyFields> =
  defineMessage(20_116, {
    signature: { no: 1, kind: "bytes", rule: "required" },
    address: { no: 2, kind: "string", rule: "required" },
  });

// firmware-pro/classic1s common/protob/messages-ethereum-onekey.proto
// EthereumSignTypedHashOneKey
export type EthereumSignTypedHashOneKeyFields = {
  addressN: Field<"uint32", 1, "repeated">;
  domainSeparatorHash: Field<"bytes", 2, "required">;
  messageHash: Field<"bytes", 3, "optional">;
  chainId: Field<"uint64", 4, "optional">;
};
export const EthereumSignTypedHashOneKey: MessageDef<EthereumSignTypedHashOneKeyFields> =
  defineMessage(20_117, {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    domainSeparatorHash: { no: 2, kind: "bytes", rule: "required" },
    messageHash: { no: 3, kind: "bytes", rule: "optional" },
    chainId: { no: 4, kind: "uint64", rule: "optional" },
  });

// firmware-pro/classic1s common/protob/messages-solana.proto SolanaSignTx — the pro-only
// extra_info field 3 is omitted (the host never sends ATA details).
export type SolanaSignTxFields = {
  addressN: Field<"uint32", 1, "repeated">;
  rawTx: Field<"bytes", 2, "required">;
};
export const SolanaSignTx: MessageDef<SolanaSignTxFields> = defineMessage(10_102, {
  addressN: { no: 1, kind: "uint32", rule: "repeated" },
  rawTx: { no: 2, kind: "bytes", rule: "required" },
});

// firmware-pro/classic1s common/protob/messages-solana.proto SolanaSignedTx
export type SolanaSignedTxFields = { signature: Field<"bytes", 1, "required"> };
export const SolanaSignedTx: MessageDef<SolanaSignedTxFields> = defineMessage(10_103, {
  signature: { no: 1, kind: "bytes", rule: "required" },
});

// firmware-pro/classic1s common/protob/messages-solana.proto SolanaMessageSignature — also the
// answer to SolanaSignOffChainMessage, which this client does not send.
export type SolanaMessageSignatureFields = {
  signature: Field<"bytes", 1, "required">;
  publicKey: Field<"bytes", 2, "optional">;
};
export const SolanaMessageSignature: MessageDef<SolanaMessageSignatureFields> = defineMessage(
  10_105,
  {
    signature: { no: 1, kind: "bytes", rule: "required" },
    publicKey: { no: 2, kind: "bytes", rule: "optional" },
  },
);

// firmware-pro/classic1s common/protob/messages-solana.proto SolanaSignUnsafeMessage
export type SolanaSignUnsafeMessageFields = {
  addressN: Field<"uint32", 1, "repeated">;
  message: Field<"bytes", 2, "required">;
};
export const SolanaSignUnsafeMessage: MessageDef<SolanaSignUnsafeMessageFields> = defineMessage(
  10_106,
  {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    message: { no: 2, kind: "bytes", rule: "required" },
  },
);

// firmware-pro/classic1s common/protob/messages-tron.proto — the TronContract oneof members.
// Every nested contract is a record, not a wire message.
export type TronTransferContractFields = {
  toAddress: Field<"string", 2, "optional">;
  amount: Field<"uint64", 3, "optional">;
};
export const TronTransferContract: MessageDef<TronTransferContractFields> = {
  typeId: -1,
  fields: {
    toAddress: { no: 2, kind: "string", rule: "optional" },
    amount: { no: 3, kind: "uint64", rule: "optional" },
  },
};

export type TronVoteFields = {
  voteAddress: Field<"string", 1, "required">;
  voteCount: Field<"uint32", 2, "required">;
};
export const TronVote: MessageDef<TronVoteFields> = {
  typeId: -1,
  fields: {
    voteAddress: { no: 1, kind: "string", rule: "required" },
    voteCount: { no: 2, kind: "uint32", rule: "required" },
  },
};

export type TronVoteWitnessContractFields = {
  votes: MsgField<2, "repeated", typeof TronVote>;
  support: Field<"bool", 3, "optional">;
};
export const TronVoteWitnessContract: MessageDef<TronVoteWitnessContractFields> = {
  typeId: -1,
  fields: {
    votes: { no: 2, kind: "message", rule: "repeated", message: TronVote },
    support: { no: 3, kind: "bool", rule: "optional" },
  },
};

export type TronFreezeBalanceContractFields = {
  frozenBalance: Field<"uint64", 1, "optional">;
  frozenDuration: Field<"uint64", 2, "optional">;
  resource: Field<"enum", 3, "optional">;
  receiverAddress: Field<"string", 4, "optional">;
};
export const TronFreezeBalanceContract: MessageDef<TronFreezeBalanceContractFields> = {
  typeId: -1,
  fields: {
    frozenBalance: { no: 1, kind: "uint64", rule: "optional" },
    frozenDuration: { no: 2, kind: "uint64", rule: "optional" },
    resource: { no: 3, kind: "enum", rule: "optional" },
    receiverAddress: { no: 4, kind: "string", rule: "optional" },
  },
};

export type TronUnfreezeBalanceContractFields = {
  resource: Field<"enum", 1, "optional">;
  receiverAddress: Field<"string", 2, "optional">;
};
export const TronUnfreezeBalanceContract: MessageDef<TronUnfreezeBalanceContractFields> = {
  typeId: -1,
  fields: {
    resource: { no: 1, kind: "enum", rule: "optional" },
    receiverAddress: { no: 2, kind: "string", rule: "optional" },
  },
};

export type TronWithdrawBalanceContractFields = {
  ownerAddress: Field<"bytes", 1, "optional">;
};
export const TronWithdrawBalanceContract: MessageDef<TronWithdrawBalanceContractFields> = {
  typeId: -1,
  fields: {
    ownerAddress: { no: 1, kind: "bytes", rule: "optional" },
  },
};

export type TronTriggerSmartContractFields = {
  contractAddress: Field<"string", 2, "optional">;
  callValue: Field<"uint64", 3, "optional">;
  data: Field<"bytes", 4, "optional">;
  callTokenValue: Field<"uint64", 5, "optional">;
  assetId: Field<"uint64", 6, "optional">;
};
export const TronTriggerSmartContract: MessageDef<TronTriggerSmartContractFields> = {
  typeId: -1,
  fields: {
    contractAddress: { no: 2, kind: "string", rule: "optional" },
    callValue: { no: 3, kind: "uint64", rule: "optional" },
    data: { no: 4, kind: "bytes", rule: "optional" },
    callTokenValue: { no: 5, kind: "uint64", rule: "optional" },
    assetId: { no: 6, kind: "uint64", rule: "optional" },
  },
};

export type TronFreezeBalanceV2ContractFields = {
  frozenBalance: Field<"uint64", 2, "optional">;
  resource: Field<"enum", 3, "optional">;
};
export const TronFreezeBalanceV2Contract: MessageDef<TronFreezeBalanceV2ContractFields> = {
  typeId: -1,
  fields: {
    frozenBalance: { no: 2, kind: "uint64", rule: "optional" },
    resource: { no: 3, kind: "enum", rule: "optional" },
  },
};

export type TronUnfreezeBalanceV2ContractFields = {
  unfreezeBalance: Field<"uint64", 2, "optional">;
  resource: Field<"enum", 3, "optional">;
};
export const TronUnfreezeBalanceV2Contract: MessageDef<TronUnfreezeBalanceV2ContractFields> = {
  typeId: -1,
  fields: {
    unfreezeBalance: { no: 2, kind: "uint64", rule: "optional" },
    resource: { no: 3, kind: "enum", rule: "optional" },
  },
};

export type TronWithdrawExpireUnfreezeContractFields = Record<never, never>;
export const TronWithdrawExpireUnfreezeContract: MessageDef<TronWithdrawExpireUnfreezeContractFields> =
  {
    typeId: -1,
    fields: {},
  };

export type TronDelegateResourceContractFields = {
  resource: Field<"enum", 2, "optional">;
  balance: Field<"uint64", 3, "optional">;
  receiverAddress: Field<"string", 4, "optional">;
  lock: Field<"bool", 5, "optional">;
  lockPeriod: Field<"uint64", 6, "optional">;
};
export const TronDelegateResourceContract: MessageDef<TronDelegateResourceContractFields> = {
  typeId: -1,
  fields: {
    resource: { no: 2, kind: "enum", rule: "optional" },
    balance: { no: 3, kind: "uint64", rule: "optional" },
    receiverAddress: { no: 4, kind: "string", rule: "optional" },
    lock: { no: 5, kind: "bool", rule: "optional" },
    lockPeriod: { no: 6, kind: "uint64", rule: "optional" },
  },
};

export type TronUnDelegateResourceContractFields = {
  resource: Field<"enum", 2, "optional">;
  balance: Field<"uint64", 3, "optional">;
  receiverAddress: Field<"string", 4, "optional">;
};
export const TronUnDelegateResourceContract: MessageDef<TronUnDelegateResourceContractFields> = {
  typeId: -1,
  fields: {
    resource: { no: 2, kind: "enum", rule: "optional" },
    balance: { no: 3, kind: "uint64", rule: "optional" },
    receiverAddress: { no: 4, kind: "string", rule: "optional" },
  },
};

export type TronCancelAllUnfreezeV2ContractFields = Record<never, never>;
export const TronCancelAllUnfreezeV2Contract: MessageDef<TronCancelAllUnfreezeV2ContractFields> = {
  typeId: -1,
  fields: {},
};

// TronContract — the oneof. provider is field 3 and contract_name field 5 on the wire even though
// the chain encoding puts ContractName at field 4 and Permission_id at field 5 (the firmware
// remaps them; core/src/apps/tron/serialize.py pack_contract, legacy/firmware/tron.c
// pack_contract).
export type TronContractFields = {
  transferContract: MsgField<2, "optional", typeof TronTransferContract>;
  provider: Field<"bytes", 3, "optional">;
  voteWitnessContract: MsgField<4, "optional", typeof TronVoteWitnessContract>;
  contractName: Field<"bytes", 5, "optional">;
  permissionId: Field<"uint32", 6, "optional">;
  freezeBalanceContract: MsgField<11, "optional", typeof TronFreezeBalanceContract>;
  unfreezeBalanceContract: MsgField<12, "optional", typeof TronUnfreezeBalanceContract>;
  withdrawBalanceContract: MsgField<13, "optional", typeof TronWithdrawBalanceContract>;
  triggerSmartContract: MsgField<31, "optional", typeof TronTriggerSmartContract>;
  freezeBalanceV2Contract: MsgField<54, "optional", typeof TronFreezeBalanceV2Contract>;
  unfreezeBalanceV2Contract: MsgField<55, "optional", typeof TronUnfreezeBalanceV2Contract>;
  withdrawExpireUnfreezeContract: MsgField<
    56,
    "optional",
    typeof TronWithdrawExpireUnfreezeContract
  >;
  delegateResourceContract: MsgField<57, "optional", typeof TronDelegateResourceContract>;
  undelegateResourceContract: MsgField<58, "optional", typeof TronUnDelegateResourceContract>;
  cancelAllUnfreezeV2Contract: MsgField<59, "optional", typeof TronCancelAllUnfreezeV2Contract>;
};
export const TronContract: MessageDef<TronContractFields> = {
  typeId: -1,
  fields: {
    transferContract: {
      no: 2,
      kind: "message",
      rule: "optional",
      message: TronTransferContract,
    },
    provider: { no: 3, kind: "bytes", rule: "optional" },
    voteWitnessContract: {
      no: 4,
      kind: "message",
      rule: "optional",
      message: TronVoteWitnessContract,
    },
    contractName: { no: 5, kind: "bytes", rule: "optional" },
    permissionId: { no: 6, kind: "uint32", rule: "optional" },
    freezeBalanceContract: {
      no: 11,
      kind: "message",
      rule: "optional",
      message: TronFreezeBalanceContract,
    },
    unfreezeBalanceContract: {
      no: 12,
      kind: "message",
      rule: "optional",
      message: TronUnfreezeBalanceContract,
    },
    withdrawBalanceContract: {
      no: 13,
      kind: "message",
      rule: "optional",
      message: TronWithdrawBalanceContract,
    },
    triggerSmartContract: {
      no: 31,
      kind: "message",
      rule: "optional",
      message: TronTriggerSmartContract,
    },
    freezeBalanceV2Contract: {
      no: 54,
      kind: "message",
      rule: "optional",
      message: TronFreezeBalanceV2Contract,
    },
    unfreezeBalanceV2Contract: {
      no: 55,
      kind: "message",
      rule: "optional",
      message: TronUnfreezeBalanceV2Contract,
    },
    withdrawExpireUnfreezeContract: {
      no: 56,
      kind: "message",
      rule: "optional",
      message: TronWithdrawExpireUnfreezeContract,
    },
    delegateResourceContract: {
      no: 57,
      kind: "message",
      rule: "optional",
      message: TronDelegateResourceContract,
    },
    undelegateResourceContract: {
      no: 58,
      kind: "message",
      rule: "optional",
      message: TronUnDelegateResourceContract,
    },
    cancelAllUnfreezeV2Contract: {
      no: 59,
      kind: "message",
      rule: "optional",
      message: TronCancelAllUnfreezeV2Contract,
    },
  },
};

// firmware-pro/classic1s common/protob/messages-tron.proto TronSignTx
export type TronSignTxFields = {
  addressN: Field<"uint32", 1, "repeated">;
  refBlockBytes: Field<"bytes", 2, "required">;
  refBlockHash: Field<"bytes", 3, "required">;
  expiration: Field<"uint64", 4, "required">;
  data: Field<"bytes", 5, "optional">;
  contract: MsgField<6, "required", typeof TronContract>;
  timestamp: Field<"uint64", 7, "required">;
  feeLimit: Field<"uint64", 8, "optional">;
};
export const TronSignTx: MessageDef<TronSignTxFields> = defineMessage(10_503, {
  addressN: { no: 1, kind: "uint32", rule: "repeated" },
  refBlockBytes: { no: 2, kind: "bytes", rule: "required" },
  refBlockHash: { no: 3, kind: "bytes", rule: "required" },
  expiration: { no: 4, kind: "uint64", rule: "required" },
  data: { no: 5, kind: "bytes", rule: "optional" },
  contract: { no: 6, kind: "message", rule: "required", message: TronContract },
  timestamp: { no: 7, kind: "uint64", rule: "required" },
  feeLimit: { no: 8, kind: "uint64", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-tron.proto TronSignedTx
export type TronSignedTxFields = {
  signature: Field<"bytes", 1, "required">;
  serializedTx: Field<"bytes", 2, "optional">;
};
export const TronSignedTx: MessageDef<TronSignedTxFields> = defineMessage(10_504, {
  signature: { no: 1, kind: "bytes", rule: "required" },
  serializedTx: { no: 2, kind: "bytes", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-tron.proto TronSignMessage
export type TronSignMessageFields = {
  addressN: Field<"uint32", 1, "repeated">;
  message: Field<"bytes", 2, "required">;
  messageType: Field<"enum", 3, "optional">;
};
export const TronSignMessage: MessageDef<TronSignMessageFields> = defineMessage(10_505, {
  addressN: { no: 1, kind: "uint32", rule: "repeated" },
  message: { no: 2, kind: "bytes", rule: "required" },
  messageType: { no: 3, kind: "enum", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-tron.proto TronMessageSignature
export type TronMessageSignatureFields = {
  address: Field<"bytes", 1, "required">;
  signature: Field<"bytes", 2, "required">;
};
export const TronMessageSignature: MessageDef<TronMessageSignatureFields> = defineMessage(10_506, {
  address: { no: 1, kind: "bytes", rule: "required" },
  signature: { no: 2, kind: "bytes", rule: "required" },
});

// firmware-pro/classic1s common/protob/messages-bitcoin.proto — the streaming SignTx protocol.
// Identical field numbering in both schemas.

export type BtcSignTxFields = {
  outputsCount: Field<"uint32", 1, "required">;
  inputsCount: Field<"uint32", 2, "required">;
  coinName: Field<"string", 3, "optional">;
  version: Field<"uint32", 4, "optional">;
  lockTime: Field<"uint32", 5, "optional">;
};
export const BtcSignTx: MessageDef<BtcSignTxFields> = defineMessage(15, {
  outputsCount: { no: 1, kind: "uint32", rule: "required" },
  inputsCount: { no: 2, kind: "uint32", rule: "required" },
  coinName: { no: 3, kind: "string", rule: "optional" },
  version: { no: 4, kind: "uint32", rule: "optional" },
  lockTime: { no: 5, kind: "uint32", rule: "optional" },
});

export type BtcTxRequestDetailsFields = {
  requestIndex: Field<"uint32", 1, "optional">;
  txHash: Field<"bytes", 2, "optional">;
  extraDataLen: Field<"uint32", 3, "optional">;
  extraDataOffset: Field<"uint32", 4, "optional">;
};
const BtcTxRequestDetails: MessageDef<BtcTxRequestDetailsFields> = {
  typeId: -1,
  fields: {
    requestIndex: { no: 1, kind: "uint32", rule: "optional" },
    txHash: { no: 2, kind: "bytes", rule: "optional" },
    extraDataLen: { no: 3, kind: "uint32", rule: "optional" },
    extraDataOffset: { no: 4, kind: "uint32", rule: "optional" },
  },
};

export type BtcTxRequestSerializedFields = {
  signatureIndex: Field<"uint32", 1, "optional">;
  signature: Field<"bytes", 2, "optional">;
  serializedTx: Field<"bytes", 3, "optional">;
};
const BtcTxRequestSerialized: MessageDef<BtcTxRequestSerializedFields> = {
  typeId: -1,
  fields: {
    signatureIndex: { no: 1, kind: "uint32", rule: "optional" },
    signature: { no: 2, kind: "bytes", rule: "optional" },
    serializedTx: { no: 3, kind: "bytes", rule: "optional" },
  },
};

export type BtcTxRequestFields = {
  requestType: Field<"enum", 1, "optional">;
  details: MsgField<2, "optional", typeof BtcTxRequestDetails>;
  serialized: MsgField<3, "optional", typeof BtcTxRequestSerialized>;
};
export const BtcTxRequest: MessageDef<BtcTxRequestFields> = defineMessage(21, {
  requestType: { no: 1, kind: "enum", rule: "optional" },
  details: { no: 2, kind: "message", rule: "optional", message: BtcTxRequestDetails },
  serialized: { no: 3, kind: "message", rule: "optional", message: BtcTxRequestSerialized },
});

// TxInput — the input of the transaction being signed.
export type BtcTxInputFields = {
  addressN: Field<"uint32", 1, "repeated">;
  prevHash: Field<"bytes", 2, "required">;
  prevIndex: Field<"uint32", 3, "required">;
  scriptSig: Field<"bytes", 4, "optional">;
  sequence: Field<"uint32", 5, "optional">;
  scriptType: Field<"enum", 6, "optional">;
  amount: Field<"uint64", 8, "required">;
  scriptPubkey: Field<"bytes", 19, "optional">;
};
export const BtcTxInput: MessageDef<BtcTxInputFields> = {
  typeId: -1,
  fields: {
    addressN: { no: 1, kind: "uint32", rule: "repeated" },
    prevHash: { no: 2, kind: "bytes", rule: "required" },
    prevIndex: { no: 3, kind: "uint32", rule: "required" },
    scriptSig: { no: 4, kind: "bytes", rule: "optional" },
    sequence: { no: 5, kind: "uint32", rule: "optional" },
    scriptType: { no: 6, kind: "enum", rule: "optional" },
    amount: { no: 8, kind: "uint64", rule: "required" },
    scriptPubkey: { no: 19, kind: "bytes", rule: "optional" },
  },
};

// TxOutput — the output of the transaction being signed.
export type BtcTxOutputFields = {
  address: Field<"string", 1, "optional">;
  addressN: Field<"uint32", 2, "repeated">;
  amount: Field<"uint64", 3, "required">;
  scriptType: Field<"enum", 4, "optional">;
  opReturnData: Field<"bytes", 6, "optional">;
};
export const BtcTxOutput: MessageDef<BtcTxOutputFields> = {
  typeId: -1,
  fields: {
    address: { no: 1, kind: "string", rule: "optional" },
    addressN: { no: 2, kind: "uint32", rule: "repeated" },
    amount: { no: 3, kind: "uint64", rule: "required" },
    scriptType: { no: 4, kind: "enum", rule: "optional" },
    opReturnData: { no: 6, kind: "bytes", rule: "optional" },
  },
};

// PrevTx / PrevInput / PrevOutput — pieces of a previous transaction the device asks for.
export type BtcPrevTxFields = {
  version: Field<"uint32", 1, "required">;
  lockTime: Field<"uint32", 4, "required">;
  inputsCount: Field<"uint32", 6, "required">;
  outputsCount: Field<"uint32", 7, "required">;
  extraDataLen: Field<"uint32", 9, "optional">;
};
const BtcPrevTx: MessageDef<BtcPrevTxFields> = {
  typeId: -1,
  fields: {
    version: { no: 1, kind: "uint32", rule: "required" },
    lockTime: { no: 4, kind: "uint32", rule: "required" },
    inputsCount: { no: 6, kind: "uint32", rule: "required" },
    outputsCount: { no: 7, kind: "uint32", rule: "required" },
    extraDataLen: { no: 9, kind: "uint32", rule: "optional" },
  },
};

export type BtcPrevInputFields = {
  prevHash: Field<"bytes", 2, "required">;
  prevIndex: Field<"uint32", 3, "required">;
  scriptSig: Field<"bytes", 4, "required">;
  sequence: Field<"uint32", 5, "required">;
};
const BtcPrevInput: MessageDef<BtcPrevInputFields> = {
  typeId: -1,
  fields: {
    prevHash: { no: 2, kind: "bytes", rule: "required" },
    prevIndex: { no: 3, kind: "uint32", rule: "required" },
    scriptSig: { no: 4, kind: "bytes", rule: "required" },
    sequence: { no: 5, kind: "uint32", rule: "required" },
  },
};

export type BtcPrevOutputFields = {
  amount: Field<"uint64", 1, "required">;
  scriptPubkey: Field<"bytes", 2, "required">;
};
const BtcPrevOutput: MessageDef<BtcPrevOutputFields> = {
  typeId: -1,
  fields: {
    amount: { no: 1, kind: "uint64", rule: "required" },
    scriptPubkey: { no: 2, kind: "bytes", rule: "required" },
  },
};

// The TxAck subtypes all carry MessageType 22 on the wire ((wire_type)=22); only their field-1
// payload differs.
export type BtcTxAckInputWrapperFields = {
  input: MsgField<2, "required", typeof BtcTxInput>;
};
const BtcTxAckInputWrapper: MessageDef<BtcTxAckInputWrapperFields> = {
  typeId: -1,
  fields: {
    input: { no: 2, kind: "message", rule: "required", message: BtcTxInput },
  },
};
export type BtcTxAckInputFields = { tx: MsgField<1, "required", typeof BtcTxAckInputWrapper> };
export const BtcTxAckInput: MessageDef<BtcTxAckInputFields> = defineMessage(22, {
  tx: { no: 1, kind: "message", rule: "required", message: BtcTxAckInputWrapper },
});

export type BtcTxAckOutputWrapperFields = {
  output: MsgField<5, "required", typeof BtcTxOutput>;
};
const BtcTxAckOutputWrapper: MessageDef<BtcTxAckOutputWrapperFields> = {
  typeId: -1,
  fields: {
    output: { no: 5, kind: "message", rule: "required", message: BtcTxOutput },
  },
};
export type BtcTxAckOutputFields = { tx: MsgField<1, "required", typeof BtcTxAckOutputWrapper> };
export const BtcTxAckOutput: MessageDef<BtcTxAckOutputFields> = defineMessage(22, {
  tx: { no: 1, kind: "message", rule: "required", message: BtcTxAckOutputWrapper },
});

export type BtcTxAckPrevMetaFields = { tx: MsgField<1, "required", typeof BtcPrevTx> };
export const BtcTxAckPrevMeta: MessageDef<BtcTxAckPrevMetaFields> = defineMessage(22, {
  tx: { no: 1, kind: "message", rule: "required", message: BtcPrevTx },
});

export type BtcTxAckPrevInputWrapperFields = {
  input: MsgField<2, "required", typeof BtcPrevInput>;
};
const BtcTxAckPrevInputWrapper: MessageDef<BtcTxAckPrevInputWrapperFields> = {
  typeId: -1,
  fields: { input: { no: 2, kind: "message", rule: "required", message: BtcPrevInput } },
};
export type BtcTxAckPrevInputFields = {
  tx: MsgField<1, "required", typeof BtcTxAckPrevInputWrapper>;
};
export const BtcTxAckPrevInput: MessageDef<BtcTxAckPrevInputFields> = defineMessage(22, {
  tx: { no: 1, kind: "message", rule: "required", message: BtcTxAckPrevInputWrapper },
});

export type BtcTxAckPrevOutputWrapperFields = {
  output: MsgField<3, "required", typeof BtcPrevOutput>;
};
const BtcTxAckPrevOutputWrapper: MessageDef<BtcTxAckPrevOutputWrapperFields> = {
  typeId: -1,
  fields: { output: { no: 3, kind: "message", rule: "required", message: BtcPrevOutput } },
};
export type BtcTxAckPrevOutputFields = {
  tx: MsgField<1, "required", typeof BtcTxAckPrevOutputWrapper>;
};
export const BtcTxAckPrevOutput: MessageDef<BtcTxAckPrevOutputFields> = defineMessage(22, {
  tx: { no: 1, kind: "message", rule: "required", message: BtcTxAckPrevOutputWrapper },
});

export type BtcSignMessageFields = {
  addressN: Field<"uint32", 1, "repeated">;
  message: Field<"bytes", 2, "required">;
  coinName: Field<"string", 3, "optional">;
  scriptType: Field<"enum", 4, "optional">;
  noScriptType: Field<"bool", 5, "optional">;
  isBip322Simple: Field<"bool", 10, "optional">;
};
export const BtcSignMessage: MessageDef<BtcSignMessageFields> = defineMessage(38, {
  addressN: { no: 1, kind: "uint32", rule: "repeated" },
  message: { no: 2, kind: "bytes", rule: "required" },
  coinName: { no: 3, kind: "string", rule: "optional" },
  scriptType: { no: 4, kind: "enum", rule: "optional" },
  noScriptType: { no: 5, kind: "bool", rule: "optional" },
  isBip322Simple: { no: 10, kind: "bool", rule: "optional" },
});

export type BtcMessageSignatureFields = {
  address: Field<"string", 1, "required">;
  signature: Field<"bytes", 2, "required">;
};
export const BtcMessageSignature: MessageDef<BtcMessageSignatureFields> = defineMessage(40, {
  address: { no: 1, kind: "string", rule: "required" },
  signature: { no: 2, kind: "bytes", rule: "required" },
});
