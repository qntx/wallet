/**
 * The message descriptors layer 1 uses — message type ids and field numbers only, each cited to the
 * firmware `.proto` file they were read from. Both schemas agree on every field listed here
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
