import { ChainError } from "@qntx/wallet-chains";
import { isDiscoverableChange } from "@qntx/wallet-chains/bitcoin";
import type { BitcoinPathTail } from "@qntx/wallet-chains/bitcoin";
import type {
  HistoryControllerOptions,
  NotificationsControllerOptions,
  SignersController,
  SignersState,
} from "@qntx/wallet-engine";

/**
 * Change from the sealed mark and immediate confirmations (section 36): `requestChangeMark` is gone
 * — the hidden-change window is the sealed mark alone; a send whose change window is exhausted
 * refuses with `invalid-request`; `SignersState.confirmations` counts completed on-device checks,
 * and host-wired history and notifications controllers take the signers store. Compiled only.
 */

/**
 * Where requestChangeMark(stored, …) was called: the sealed mark is the bound, inputs never widen
 * it.
 */
export function hidesAsChange(
  output: BitcoinPathTail,
  signed: ReadonlyArray<BitcoinPathTail>,
  mark: number,
): boolean {
  return isDiscoverableChange(output, signed, mark);
}

/** The exhausted change window: no change index is left above the sealed mark inside the scan. */
export function changeWindowExhausted(error: unknown): boolean {
  return (
    error instanceof ChainError &&
    error.code === "invalid-request" &&
    error.message === "no unused change address inside the scan window"
  );
}

/** Re-render whatever shows "unconfirmed" when a device confirmation completes. */
export function onConfirmation(
  signers: Pick<SignersController, "store">,
  render: () => void,
): () => void {
  return signers.store.subscribe((next: SignersState, previous: SignersState) => {
    if (next.confirmations !== previous.confirmations) {
      render();
    }
  });
}

/** Host-wired controllers hand over the signers store next to the other stores they read. */
export function wiredSigners(
  signers: Pick<SignersController, "store">,
): Pick<HistoryControllerOptions, "signers"> & Pick<NotificationsControllerOptions, "signers"> {
  return { signers };
}
