/**
 * The link adapter every Ledger operation uses: one APDU is one `message` request on the
 * `DeviceLink`, and the answer must be a `message` too — the raw `data ‖ SW` the host's byte pipe
 * returned. Any other response kind means the host lied about the exchange it ran: `integrity`. App
 * pinning is shared too: `requiredApp` reads `appAndVersion` and enforces the pinned name and
 * minimum version before any operation-specific exchange.
 */
import { KernelError } from "../../../errors.ts";
import type { Exchange } from "../../ledger/protocol/apdu.ts";
import { appAndVersion, requireApp } from "../../ledger/protocol/device.ts";
import type { AppInfo, LedgerApp } from "../../ledger/protocol/device.ts";
import type { DeviceLink } from "../driver.ts";
import { call } from "./errors.ts";

export const apduExchange = (link: DeviceLink): Exchange => {
  const exchange: Exchange = async (apdu) => {
    const response = await link.exchange({ kind: "message", data: apdu });
    if (response.kind !== "message") {
      throw new KernelError("integrity", "the device answered a message with another kind");
    }
    return response.data;
  };
  return exchange;
};

/** `appAndVersion` plus `requireApp`: wrong app or too-old version fails before any other APDU. */
export const requiredApp = async (exchange: Exchange, app: LedgerApp): Promise<AppInfo> =>
  call(async () => {
    const info = await appAndVersion(exchange);
    requireApp(info, app);
    return info;
  });
