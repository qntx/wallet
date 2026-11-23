import { WalletError } from "@qntx/wallet";
import type { HardwareWalletInfo, Wallet, WalletErrorCode, WalletInfo } from "@qntx/wallet";
import { hardware, oneKeyAnswerLength, qrParts, qrReader } from "@qntx/wallet/hardware";
import type { DeviceIo } from "@qntx/wallet/hardware";
import type { ChainSignRequest, ChainSignResult } from "@qntx/wallet/protocol";

/**
 * `WalletInfo` is now a `custody` union. The shape a 0.13.0 host knew — `{ walletId, origin, words,
 * backup, passphrase, createdAt }` — is `VaultWalletInfo`; a paired hardware wallet is
 * `HardwareWalletInfo` and carries no `origin`/`words`/`backup`/`passphrase` at all. Any read of a
 * vault-only field must narrow on `custody` first; the compiler flags every site that did not.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export function walletBadge(info: WalletInfo): string {
  switch (info.custody) {
    case "vault":
      // `origin`, `words`, `backup` and `passphrase` exist only on this arm.
      return info.backup === "mnemonic"
        ? `mnemonic wallet ${info.walletId}`
        : `passkey wallet ${info.walletId}`;
    case "hardware":
      return `${info.device} ${info.model ?? "device"} (${info.fingerprint})`;
  }
}

/** The vault-only fields a hardware wallet does not have, for callers that need them. */
export function requiresSeed(info: WalletInfo): info is Extract<WalletInfo, { words: number }> {
  return info.custody === "vault";
}

/**
 * Five new codes a device operation can raise — handle them alongside the existing ones (the
 * exhaustive map in `tests/migration/error-codes.ts` fails to compile if the list drifts):
 */
export function deviceErrorHint(code: WalletErrorCode): string | undefined {
  switch (code) {
    case "device-required":
      // The kernel has no public material for this path yet — run hardware().accounts first.
      return "connect the device to export this account";
    case "device-locked":
      return "unlock the device and retry";
    case "device-app-closed":
      return "open the matching chain app on the device";
    case "device-rejected":
      return "the user refused on the device";
    case "wrong-device":
      return "a different device answered — check the fingerprint";
    default:
      return undefined;
  }
}

/**
 * A Keystone 3 Pro talks UR over QR. `exchange` gets the kernel's request: `show` is what the
 * wallet displays (animate `qrParts(request.show)` on a timer), `scan` is the list of UR types the
 * kernel accepts back — feed scanned frames into `qrReader(request.scan)` until `payload` appears.
 * `compare` asks the user to confirm the address on the device screen itself.
 */
export function keystoneQrIo(ui: {
  /** Shows an animated QR from the cyclic part generator until `stop` settles. */
  readonly animateQr: (next: () => string) => { readonly stop: () => void };
  /** Resolves with the next frame the camera reads, or rejects when the user cancels. */
  readonly scanFrame: () => Promise<string>;
  /** Asks the user to compare an address with the device screen. */
  readonly confirmAddress: (address: string, path: string) => Promise<boolean>;
}): DeviceIo {
  return {
    // oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
    exchange: async (request) => {
      switch (request.kind) {
        case "qr": {
          const animation =
            request.show === undefined ? undefined : ui.animateQr(qrParts(request.show));
          try {
            const reader = qrReader(request.scan);
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- frames arrive one camera read at a time
              const { payload } = reader.receive(await ui.scanFrame());
              if (payload !== undefined) {
                return { kind: "qr", ur: payload };
              }
            }
          } finally {
            animation?.stop();
          }
        }
        case "compare":
          return {
            kind: "compare",
            matched: await ui.confirmAddress(request.address, request.path),
          };
        case "message":
          throw new WalletError("unsupported", "keystone has no byte transport");
      }
    },
  };
}

/** Pair the device: scans its sync QR, resolves with the new `HardwareWalletInfo`. */
export async function pairKeystone(wallet: Wallet, io: DeviceIo): Promise<HardwareWalletInfo> {
  const info = await hardware(wallet).pair("keystone", io);
  if (info.custody !== "hardware") {
    throw new WalletError("integrity", "pair did not return a hardware wallet");
  }
  return info;
}

/**
 * Sign on the device: the same `verify` factor and the same result checks as `chains().sign`. The
 * wallet shows the request QR, the device signs and shows the signature QR back.
 */
export async function signOnDevice(
  wallet: Wallet,
  request: ChainSignRequest,
  verify: Parameters<ReturnType<typeof hardware>["sign"]>[0]["verify"],
  io: DeviceIo,
): Promise<ChainSignResult> {
  return hardware(wallet).sign({ request, verify }, io);
}

/**
 * `"onekey"` is the second device literal. A OneKey speaks Protocol-V1 frames, so its `exchange`
 * sees `message` requests only: `request.data` is one framed command, written verbatim — 64-byte
 * HID reports over USB, or GATT writes split at or below the negotiated MTU to characteristic
 * `00000002-0000-1000-8000-00805f9b34fb` of service `00000001-0000-1000-8000-00805f9b34fb` — and
 * the answer is collected until `oneKeyAnswerLength(firstChunk, transport)` bytes have arrived
 * (whole 64-byte USB reports; concatenated BLE notifications on
 * `00000003-0000-1000-8000-00805f9b34fb`). `qr` and `compare` requests never occur.
 */
export function oneKeyIo(transport: {
  readonly kind: "usb" | "ble";
  /** Writes one framed command, already report/MTU-split by the caller's transport layer. */
  readonly write: (data: Uint8Array) => Promise<void>;
  /** Resolves with the next chunk of the device's answer — one USB report or one BLE notify. */
  readonly read: () => Promise<Uint8Array>;
}): DeviceIo {
  return {
    exchange: async (request) => {
      if (request.kind !== "message") {
        throw new WalletError("unsupported", "onekey answers message requests only");
      }
      await transport.write(request.data);
      const chunks: Uint8Array[] = [await transport.read()];
      const [first] = chunks;
      if (first === undefined) {
        throw new WalletError("integrity", "the device answer is empty");
      }
      const total = oneKeyAnswerLength(first, transport.kind);
      let collected = first.length;
      while (collected < total) {
        // oxlint-disable-next-line no-await-in-loop -- one chunk per transport read
        const next = await transport.read();
        chunks.push(next);
        collected += next.length;
      }
      const data = new Uint8Array(collected);
      let at = 0;
      for (const chunk of chunks) {
        data.set(chunk, at);
        at += chunk.length;
      }
      return { kind: "message", data };
    },
  };
}

/** Pair a OneKey — resolves with the new `HardwareWalletInfo`, like `pairKeystone`. */
export async function pairOneKey(wallet: Wallet, io: DeviceIo): Promise<HardwareWalletInfo> {
  const info = await hardware(wallet).pair("onekey", io);
  if (info.custody !== "hardware") {
    throw new WalletError("integrity", "pair did not return a hardware wallet");
  }
  return info;
}
