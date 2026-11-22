import type {
  ApproveOptions,
  PendingRequest,
  RequestInput,
  WalletEngine,
} from "@qntx/wallet-engine";

/** The exact failure of an approve whose L1 data-fee bound lapsed since the quote was shown. */
export const L1_FEE_ROSE = "the L1 data fee rose — start over";

/**
 * On OP Stack and Scroll networks the displayed `l1Data` maximum covers the oracle read plus three
 * L1 price updates of ×9/8. Approval re-reads the oracle, and broadcast re-reads it when the
 * signature took longer than one 12 s L1 slot; a price that outgrew the shown maximum ends the
 * request rather than broadcasting bytes the user was not shown a bound for. The host must not
 * retry the approval on the ended request — re-prepare the same input, show the new bound, and let
 * the user approve again.
 */
export const isL1FeeRose = (error: unknown): boolean =>
  error instanceof Error && error.message === L1_FEE_ROSE;

/**
 * Approve a send request; when its L1 fee bound lapsed, return a fresh request of the same input
 * for a second review+approve instead of an outcome. Other errors keep throwing.
 */
export async function approveSendOrReprepare(
  engine: WalletEngine,
  request: PendingRequest,
  input: Extract<RequestInput, { readonly method: "send" }>,
  options: ApproveOptions,
): Promise<PendingRequest | undefined> {
  try {
    await engine.requests.approve(request.id, "send", options);
    return undefined;
  } catch (error) {
    if (isL1FeeRose(error)) {
      return engine.requests.prepare(input);
    }
    throw error;
  }
}
