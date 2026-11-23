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

// firmware-pro/classic1s common/protob/messages-management.proto GetFeatures
export type GetFeaturesFields = Record<never, never>;
export const GetFeatures: MessageDef<GetFeaturesFields> = defineMessage(55, {});

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

// firmware-pro/classic1s common/protob/messages-common.proto Success
export type SuccessFields = { message: Field<"string", 1, "optional"> };
export const Success: MessageDef<SuccessFields> = defineMessage(2, {
  message: { no: 1, kind: "string", rule: "optional" },
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

// firmware-pro/classic1s common/protob/messages-common.proto PassphraseRequest — the client
// decodes existsAttachPinUser so a request it cannot satisfy is a device-fault, not a silent ack.
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

// firmware-pro/classic1s common/protob/messages-common.proto Cancel
export type CancelFields = Record<never, never>;
export const Cancel: MessageDef<CancelFields> = defineMessage(20, {});
