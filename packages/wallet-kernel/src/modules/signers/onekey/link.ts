/**
 * The link adapter every OneKey operation uses: one framed Protocol-V1 command is one `message`
 * request on the `DeviceLink`, and the answer must be a `message` too — any other response kind
 * means the host lied about the exchange it ran: `integrity`.
 */
import { KernelError } from "../../../errors.ts";
import type { DeviceLink } from "../driver.ts";
import type { Exchange } from "./protocol/index.ts";

/** The Protocol-V1 exchange over the generic message transport: `message` answers only. */
export const exchangeOf = (link: DeviceLink): Exchange => {
  return async (data: Uint8Array): Promise<Uint8Array> => {
    const response = await link.exchange({ kind: "message", data });
    if (response.kind !== "message") {
      throw new KernelError("integrity", "the device answer is not a message");
    }
    return response.data;
  };
};
