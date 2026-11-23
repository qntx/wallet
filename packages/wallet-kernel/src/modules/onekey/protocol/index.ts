/**
 * OneKey protocol V1 client (Classic, Classic 1S/Pure, Mini, Touch, Pro). Self-contained: nothing
 * from the rest of the kernel, no ambient I/O or crypto — every byte crosses the injected
 * `Exchange`. The wire facts are OneKey's published `.proto` schemas and
 * `common/protob/protocol.md`, cited per descriptor; no OneKey code is a dependency.
 */
export { initialize } from "./device.ts";
export type { DeviceInfo, OneKeyModel } from "./device.ts";
export { OneKeyError } from "./errors.ts";
export type { OneKeyErrorCode } from "./errors.ts";
export { decodeMessage, encodeMessage, MAX_MESSAGE, REPORT_SIZE } from "./frame.ts";
export type { Message } from "./frame.ts";
export {
  BixinPinInputOnDevice,
  ButtonAck,
  ButtonRequest,
  Cancel,
  Failure,
  Features,
  GetFeatures,
  Initialize,
  PassphraseAck,
  PassphraseRequest,
  PinMatrixRequest,
  Success,
} from "./messages.ts";
export { decode, defineMessage, encode } from "./proto.ts";
export type { Decoded, FieldSpec, Fields, MessageDef } from "./proto.ts";
export { call } from "./session.ts";
export type { Exchange, Request } from "./session.ts";
