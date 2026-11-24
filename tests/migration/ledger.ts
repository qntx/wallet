import type { HardwareWalletInfo, VerifyFactor, Wallet, WalletErrorCode } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import { hardware, ledgerBleExchange, ledgerHidExchange, ledgerIo } from "@qntx/wallet/hardware";
import type { DeviceIo, BlePort, HidPort } from "@qntx/wallet/hardware";
import type { ChainSignRequest } from "@qntx/wallet/protocol";

/**
 * A Ledger device talks raw APDUs: the kernel produces `{ kind: "message", data }` exchanges, the
 * host frames them on HID or BLE and hands answers back through `ledgerIo`. The kernel driver owns
 * app pinning (every operation opens with appAndVersion and fails `device-app-closed` when the
 * wrong app is up), the settings pre-checks (`blind-signing-disabled`) and signature verification.
 */

/* Minimal WebHID/Web Bluetooth shapes — neither is in the migration tsconfig's `dom` lib. */
type LedgerHidDevice = EventTarget & {
  readonly sendReport: (reportId: number, data: Uint8Array) => Promise<void>;
};
type HidApi = {
  readonly requestDevice: (options: {
    readonly filters: ReadonlyArray<{ vendorId: number }>;
  }) => Promise<ReadonlyArray<LedgerHidDevice>>;
};
type GattCharacteristic = EventTarget & {
  readonly value?: DataView;
  readonly writeValue: (value: Uint8Array) => Promise<void>;
  readonly startNotifications: () => Promise<void>;
};
type GattService = {
  readonly getCharacteristic: (uuid: string) => Promise<GattCharacteristic>;
};
type LedgerBleDevice = {
  readonly gatt?: {
    readonly connect: () => Promise<{
      readonly getPrimaryService: (uuid: string) => Promise<GattService>;
    }>;
  };
};
type BluetoothApi = {
  readonly requestDevice: (options: {
    readonly filters: ReadonlyArray<{ services: string[] }>;
  }) => Promise<LedgerBleDevice>;
};

/**
 * WebHID: Ledger's USB vendor id is `0x2c97` (research.md "Transport framing"). `write` posts one
 * 64-byte report (`sendReport(0, report)`), `read` resolves the next `inputreport`'s data. The
 * channel `0x0101` is the value Ledger's docs recommend and the DMK echoes (same source).
 */
export async function pairLedgerHid(wallet: Wallet, hid: HidApi): Promise<HardwareWalletInfo> {
  const [device] = await hid.requestDevice({ filters: [{ vendorId: 0x2c97 }] });
  if (device === undefined) {
    throw new WalletError("device-required", "no Ledger selected");
  }
  const port: HidPort = {
    write: async (report) => device.sendReport(0, report),
    read: async () =>
      new Promise<Uint8Array>((resolve) => {
        device.addEventListener(
          "inputreport",
          (event) => {
            if (!("data" in event) || !(event.data instanceof DataView)) {
              return;
            }
            const { data } = event;
            resolve(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + 64)));
          },
          { once: true },
        );
      }),
  };
  const io = ledgerIo(ledgerHidExchange(port, 0x0101));
  const result = await hardware(wallet).start({ kind: "pair", device: "ledger" }, { io }).result;
  if (result.kind !== "pair" || result.wallet.custody !== "hardware") {
    throw new WalletError("integrity", "pair did not return a hardware wallet");
  }
  return result.wallet;
}

/**
 * Web Bluetooth service/characteristic UUIDs per model — notify is the `…0001` characteristic,
 * write `…0002` (ledgerjs-npm `devices/src/index.ts` `bluetoothSpec`, cited in research.md).
 */
export const LEDGER_BLE_MODELS = {
  nanoX: "13d63400-2c97-0004",
  stax: "13d63400-2c97-6004",
  flex: "13d63400-2c97-3004",
} as const;
export type LedgerBleModel = keyof typeof LEDGER_BLE_MODELS;

const bleUuid = (model: LedgerBleModel, characteristic: "0000" | "0001" | "0002"): string =>
  `${LEDGER_BLE_MODELS[model]}-${characteristic}-4c6564676572`;

/** One BLE port: notifications queue up reads; writes go to the `…0002` characteristic. */
export async function ledgerBlePort(
  device: LedgerBleDevice,
  model: LedgerBleModel,
): Promise<BlePort> {
  const server = await device.gatt?.connect();
  if (server === undefined) {
    throw new WalletError("device-required", "the Ledger exposes no GATT server");
  }
  const service = await server.getPrimaryService(bleUuid(model, "0000"));
  const notify = await service.getCharacteristic(bleUuid(model, "0001"));
  const write = await service.getCharacteristic(bleUuid(model, "0002"));
  await notify.startNotifications();
  const queued: Uint8Array[] = [];
  const waiters: Array<(frame: Uint8Array) => void> = [];
  notify.addEventListener("characteristicvaluechanged", () => {
    const { value } = notify;
    if (value === undefined) {
      return;
    }
    const frame = new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
    const waiter = waiters.shift();
    if (waiter === undefined) {
      queued.push(frame);
    } else {
      waiter(frame);
    }
  });
  return {
    write: async (frame) => write.writeValue(frame),
    read: async () =>
      new Promise<Uint8Array>((resolve) => {
        const frame = queued.shift();
        if (frame === undefined) {
          waiters.push(resolve);
        } else {
          resolve(frame);
        }
      }),
  };
}

/** Web Bluetooth: request the model's service, negotiate the MTU in `ledgerBleExchange`, pair. */
export async function pairLedgerBle(
  wallet: Wallet,
  bluetooth: BluetoothApi,
  model: LedgerBleModel,
): Promise<HardwareWalletInfo> {
  const device = await bluetooth.requestDevice({
    filters: [{ services: [bleUuid(model, "0000")] }],
  });
  const io = ledgerIo(await ledgerBleExchange(await ledgerBlePort(device, model)));
  const result = await hardware(wallet).start({ kind: "pair", device: "ledger" }, { io }).result;
  if (result.kind !== "pair" || result.wallet.custody !== "hardware") {
    throw new WalletError("integrity", "pair did not return a hardware wallet");
  }
  return result.wallet;
}

/** Accounts, signing and address checks ride the same `DeviceIo` once the link is up. */
export async function ledgerOps(
  wallet: Wallet,
  hardwareWalletId: string,
  request: ChainSignRequest,
  verify: VerifyFactor,
  io: DeviceIo,
): Promise<void> {
  const api = hardware(wallet);
  await api.start(
    {
      kind: "accounts",
      walletId: hardwareWalletId,
      groupIndex: 0,
      templates: ["evm.bip44"],
      network: "eip155:1",
    },
    { io },
  ).result;
  await api.start(
    {
      kind: "verify-address",
      walletId: hardwareWalletId,
      groupIndex: 0,
      template: "btc.bip84",
      network: "bip122:000000000019d6689c085ae165831e93",
      index: 0,
    },
    { io },
  ).result;
  await api.start({ kind: "sign", request }, { io, verify }).result;
}

/**
 * Ledger-specific errors to surface next to the generic device hints (see
 * `tests/migration/hardware-wallets.ts` `deviceErrorHint`): the app's settings gate blind payloads
 * and the open app is the only way the device knows which protocol it speaks.
 */
export function ledgerErrorHint(code: WalletErrorCode): string | undefined {
  switch (code) {
    case "blind-signing-disabled":
      return "enable Blind signing in the Ledger app settings";
    case "device-app-closed":
      return "open the <chain> app";
    default:
      return undefined;
  }
}
