/**
 * OS-level commands every app answers (GET_APP_AND_VERSION) plus the two dashboard commands
 * (OPEN_APP/QUIT_APP). Sources: DMK api/command/os/GetAppAndVersionCommand.js (format `01 ‖
 * LV(name) ‖ LV(version) ‖ [LV(flags)]`), OpenAppCommand.js (`E0 D8`, ASCII name), and
 * CloseAppCommand.js (`B0 A7`); the app-side reply layout is mirrored by app-bitcoin-new
 * bitcoin_client_js/src/lib/appClient.ts getAppAndVersion.
 */
import type { Exchange } from "./apdu.ts";
import { transmit } from "./apdu.ts";
import { Reader } from "./bytes.ts";
import { LedgerError } from "./errors.ts";
import type { LedgerApp } from "./status.ts";

export type { LedgerApp } from "./status.ts";

export type AppInfo = {
  readonly name: string;
  readonly version: string;
  readonly flags: Uint8Array;
};

const PRINTABLE = (b: number): boolean => b >= 0x20 && b <= 0x7e;

const ascii = (bytes: Uint8Array): string => {
  if (!bytes.every(PRINTABLE)) {
    throw new LedgerError("invalid-response", "a response string is not printable ASCII");
  }
  return new TextDecoder().decode(bytes);
};

/** `B0 01 00 00` — `01 ‖ LV(name) ‖ LV(version) ‖ [LV(flags)]`, nothing after. */
export async function appAndVersion(exchange: Exchange): Promise<AppInfo> {
  const data = await transmit(exchange, "dashboard", {
    cla: 0xb0,
    ins: 0x01,
    p1: 0x00,
    p2: 0x00,
    data: new Uint8Array(0),
  });
  const reader = new Reader(data);
  const format = reader.u8();
  if (format !== 0x01) {
    throw new LedgerError("invalid-response", "GET_APP_AND_VERSION format is not 0x01");
  }
  const name = ascii(reader.lv());
  const version = ascii(reader.lv());
  const flags = reader.remaining > 0 ? reader.lv() : new Uint8Array(0);
  reader.end();
  return { name, version, flags };
}

/** `E0 D8 00 00` with the ASCII app name — dashboard only. */
export async function openApp(exchange: Exchange, app: LedgerApp): Promise<void> {
  await transmit(exchange, "dashboard", {
    cla: 0xe0,
    ins: 0xd8,
    p1: 0x00,
    p2: 0x00,
    data: new TextEncoder().encode(LEDGER_APPS[app].name),
  });
}

/** `B0 A7 00 00` — returns to the dashboard. */
export async function quitApp(exchange: Exchange): Promise<void> {
  await transmit(exchange, "dashboard", {
    cla: 0xb0,
    ins: 0xa7,
    p1: 0x00,
    p2: 0x00,
    data: new Uint8Array(0),
  });
}

/**
 * Names and minimum versions pinned in scripts/ledger/apps.json — device-release tags
 * `nanos+_1.6.1_2.5.1_sdk_v26.6.2`, `nanos+_1.7.0_1.24.0_sdk_v27.1.7`,
 * `nanos+_1.6.1_1.16.0_sdk_v26.4.0`, `nanos+_1.7.0_0.8.2_sdk_v27.1.5`. A unit test keeps this table
 * equal to apps.json.
 */
export const LEDGER_APPS: Readonly<
  Record<LedgerApp, { readonly name: string; readonly minimum: readonly [number, number, number] }>
> = {
  bitcoin: { name: "Bitcoin", minimum: [2, 5, 1] },
  ethereum: { name: "Ethereum", minimum: [1, 24, 0] },
  solana: { name: "Solana", minimum: [1, 16, 0] },
  tron: { name: "Tron", minimum: [0, 8, 2] },
};

/** Wrong app in the foreground → app-not-open; malformed or too-old version → unsupported. */
export function requireApp(info: AppInfo, app: LedgerApp): void {
  if (info.name !== LEDGER_APPS[app].name) {
    throw new LedgerError("app-not-open", "the app is not open on the device");
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(info.version);
  if (match === null) {
    throw new LedgerError("unsupported", "the app version is not x.y.z");
  }
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const { minimum } = LEDGER_APPS[app];
  for (const i of [0, 1, 2] as const) {
    if (actual[i] !== minimum[i]) {
      if (actual[i] < minimum[i]) {
        throw new LedgerError("unsupported", "the app version is below the pinned minimum");
      }
      return;
    }
  }
}
