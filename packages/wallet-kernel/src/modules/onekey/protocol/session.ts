/**
 * The request driver. One `Exchange` moves one logical message each way — the host transport splits
 * the bytes into V1 reports or GATT writes; this layer only sees whole messages (`hw-signers`
 * driver.ts `DeviceLink.exchange({kind:"message"})`). A call is the initial request plus at most
 * 256 interaction rounds: ButtonRequest → ButtonAck, a Current/absent PinMatrixRequest →
 * BixinPinInputOnDevice (the device then takes the PIN on its own buttons — the client never sends
 * PinMatrixAck), PassphraseRequest → PassphraseAck{on_device:true} (never passphrase text), Failure
 * → the typed error table, and the expected type ends the call. Anything else from the device is
 * `device-fault`.
 */
import { OneKeyError } from "./errors.ts";
import type { OneKeyErrorCode } from "./errors.ts";
import { decodeMessage, encodeMessage } from "./frame.ts";
import {
  ButtonAck,
  ButtonRequest,
  BixinPinInputOnDevice,
  Failure,
  PassphraseAck,
  PassphraseRequest,
  PinMatrixRequest,
} from "./messages.ts";
import { decode, encode } from "./proto.ts";
import type { Decoded, Fields, MessageDef } from "./proto.ts";

/**
 * One logical message in each direction: `data` out is the encoded V1 report sequence, the answer
 * is the device's complete response message in either transport's byte form.
 */
export type Exchange = (data: Uint8Array) => Promise<Uint8Array>;

export type Request<F extends Fields = Fields> = {
  readonly def: MessageDef<F>;
  readonly value: Decoded<F>;
};

const MAX_ROUNDS = 256;

const fault = (message: string): OneKeyError => new OneKeyError("device-fault", message);

// FailureType codes from common/protob/messages-common.proto (identical in both schemas).
const FAILURE_CODE: Readonly<Record<number, OneKeyErrorCode>> = {
  4: "user-rejected", // Failure_ActionCancelled
  6: "user-rejected", // Failure_PinCancelled
  7: "pin-invalid", // Failure_PinInvalid
  11: "not-initialized", // Failure_NotInitialized
  5: "device-locked", // Failure_PinExpected — the device wants its PIN first
};

function failureError(decoded: Decoded<typeof Failure.fields>): OneKeyError {
  const code = FAILURE_CODE[decoded.code ?? -1] ?? "device-error";
  return new OneKeyError(code, "device reported failure", decoded.code);
}

async function exchangeMessage<F extends Fields>(
  exchange: Exchange,
  def: MessageDef<F>,
  value: Decoded<F>,
): Promise<{ type: number; payload: Uint8Array }> {
  return decodeMessage(await exchange(encodeMessage(def.typeId, encode(def, value))));
}

export function call<F extends Fields, R extends Fields>(
  exchange: Exchange,
  request: Request<F>,
  expected: MessageDef<R>,
): Promise<Decoded<R>>;
export function call<F extends Fields>(
  exchange: Exchange,
  request: Request<F>,
  expected: ReadonlyArray<MessageDef>,
): Promise<Decoded<Fields>>;
export async function call<F extends Fields, R extends Fields>(
  exchange: Exchange,
  request: Request<F>,
  expected: MessageDef<R> | ReadonlyArray<MessageDef<R>>,
): Promise<Decoded<R>> {
  const accepted: ReadonlyArray<MessageDef<R>> = Array.isArray(expected) ? expected : [expected];
  const first = await exchangeMessage(exchange, request.def, request.value);
  return resolveRound(exchange, accepted, first, 0);
}

/** The interaction for one device message that is not the expected answer. */
function interact(message: { readonly type: number; readonly payload: Uint8Array }): Request {
  switch (message.type) {
    case ButtonRequest.typeId:
      decode(ButtonRequest, message.payload);
      return { def: ButtonAck, value: {} };
    case PinMatrixRequest.typeId: {
      const pin = decode(PinMatrixRequest, message.payload);
      if (pin.type !== undefined && pin.type !== 1) {
        throw fault("device requested a PIN change or wipe code");
      }
      return { def: BixinPinInputOnDevice, value: {} };
    }
    case PassphraseRequest.typeId: {
      const request = decode(PassphraseRequest, message.payload);
      if (request.existsAttachPinUser === true) {
        throw fault("device requested an attach-pin passphrase flow");
      }
      return { def: PassphraseAck, value: { onDevice: true } };
    }
    case Failure.typeId:
      throw failureError(decode(Failure, message.payload));
    default:
      throw fault(`unexpected message type ${message.type}`);
  }
}

async function resolveRound<R extends Fields>(
  exchange: Exchange,
  accepted: ReadonlyArray<MessageDef<R>>,
  message: { readonly type: number; readonly payload: Uint8Array },
  round: number,
): Promise<Decoded<R>> {
  const answer = accepted.find((def) => def.typeId === message.type);
  if (answer !== undefined) {
    return decode(answer, message.payload);
  }
  const reply = interact(message);
  if (round >= MAX_ROUNDS) {
    throw fault("too many interaction rounds");
  }
  const next = await exchangeMessage(exchange, reply.def, reply.value);
  return resolveRound(exchange, accepted, next, round + 1);
}
