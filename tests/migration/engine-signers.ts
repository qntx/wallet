/**
 * Engine signing through external signers: `EngineOptions.deviceIo` hands the engine the host's
 * per-device transport; `engine.signers` reports the one card/hardware operation that can run at a
 * time and offers `cancel`, `verifyAddress` and `fetchAccounts`; the account tree marks the
 * families only the signer can answer and the wallets still waiting on a member card.
 */
import { WalletError } from "@qntx/wallet";
import type {
  AccountGroup,
  AccountTreeState,
  EngineOptions,
  SignerActivity,
  SignerFamily,
  WalletEngine,
} from "@qntx/wallet-engine";
import { ledgerHidExchange, ledgerIo, oneKeyHidExchange, oneKeyIo } from "@qntx/wallet/hardware";
import type { DeviceIo, HardwareDevice, HidPort } from "@qntx/wallet/hardware";

/**
 * `EngineOptions.deviceIo` is the same `DeviceIo` a `hardware(wallet)` call takes, resolved per
 * paired device kind — the engine runs the device operations itself now, so a host wires its
 * transports once at `createWalletEngine` instead of passing `io` to every call. A Keystone's QR
 * channel is the host's own `DeviceIo` (§24's `keystoneQrIo`); Ledger and OneKey reuse the shipped
 * exchanges. Card wallets need no entry here: the kernel talks to the reader itself.
 */
export const withDeviceIo = (
  options: EngineOptions,
  transports: {
    readonly keystoneQr: () => DeviceIo;
    readonly ledgerHid: () => HidPort;
    readonly oneKeyHid: () => HidPort;
  },
): EngineOptions => ({
  ...options,
  // oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
  deviceIo: (device: HardwareDevice): DeviceIo => {
    switch (device) {
      case "keystone":
        return transports.keystoneQr();
      case "ledger":
        return ledgerIo(ledgerHidExchange(transports.ledgerHid(), 0x2a3f));
      case "onekey":
        return oneKeyIo(oneKeyHidExchange(transports.oneKeyHid()));
    }
  },
});

/**
 * At most one signer operation runs at a time, for every custody: `engine.signers.getState()` (or
 * `store.subscribe`) reports it as one `SignerActivity` — `starting`, then `card` steps (the card
 * task's own steps: mount `SecureInput` on `input`, hold the card on `tap`) or `device` exchanges —
 * and the activity clears when the operation ends. A second start while one runs fails `conflict`
 * and leaves the running operation alone; locking the vault cancels it.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export function describeSignerActivity(
  // oxlint-disable-next-line typescript/no-restricted-types -- spec shape: no activity → null
  activity: SignerActivity | null,
): string {
  if (activity === null) {
    return "idle";
  }
  const who = `${activity.custody} ${activity.walletId} (${activity.operation})`;
  switch (activity.step.kind) {
    case "starting":
      return `${who}: starting`;
    case "card":
      return `${who}: card ${activity.step.step.kind}`;
    case "device":
      return `${who}: device exchange`;
  }
}

/** Wire the activity feed into UI; the unsubscribe handle ends it. */
export function watchSigners(engine: WalletEngine, show: (text: string) => void): () => void {
  return engine.signers.store.subscribe((state) => {
    show(describeSignerActivity(state.active));
  });
}

/** The user cancelled the sheet, or a lock/leave ends the flow: cancel the running operation. */
export async function cancelSigner(engine: WalletEngine): Promise<void> {
  await engine.signers.cancel();
}

/**
 * A group on an external signer has no material for a family until the device exports it: the
 * family's `signer` map entry is `device-required` and discovery neither counts it used nor errored
 * — the group stops being provable once every chain family waits on the signer.
 * `engine.signers.fetchAccounts` runs the accounts operation (hardware: the family's app on the
 * device; card: a tap) and re-runs that family's check when the material lands.
 */
export async function fetchMissingFamily(
  engine: WalletEngine,
  group: AccountGroup,
  family: SignerFamily,
): Promise<void> {
  if (group.signer?.[family] !== "device-required") {
    return;
  }
  try {
    await engine.signers.fetchAccounts({
      walletId: group.walletId,
      groupIndex: group.index,
      family,
    });
  } catch (error) {
    // Two operations never overlap: queue the fetch behind whatever is running.
    if (error instanceof WalletError && error.code === "conflict") {
      return;
    }
    throw error;
  }
}

/**
 * `AccountTreeState.wallets` entries carry `custody` and `state`. A `card` wallet still waiting on
 * a member card is `incomplete`: it has no groups and no addresses (asks like
 * `transactions.nextReceiveAddress` throw) — show the pending-member UI instead of a receive
 * address until `ready`.
 */
export function walletRow(entry: AccountTreeState["wallets"][number]): {
  readonly key: string;
  readonly receiveReady: boolean;
} {
  return {
    key: `${entry.custody}:${entry.walletId}`,
    receiveReady: entry.state === "ready",
  };
}

/**
 * `verifyAddress` shows an address on the device screen — hardware only; a card has no screen and
 * answers `unsupported`.
 */
export async function checkAddressOnDevice(
  engine: WalletEngine,
  walletId: string,
  groupIndex: number,
): Promise<string> {
  const { address } = await engine.signers.verifyAddress({
    walletId,
    groupIndex,
    template: "evm.bip44",
    network: "eip155:1",
    index: 0,
  });
  return address;
}
