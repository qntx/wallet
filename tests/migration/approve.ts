import type { VerifyFactor } from "@qntx/wallet";
import type { PendingRequest, RequestAcknowledgement, WalletEngine } from "@qntx/wallet-engine";
import {
  AcknowledgementRequiredError,
  SimulationChangedError,
  requiredAcknowledgement,
} from "@qntx/wallet-engine";

/** 0.13.0 passed the factor positionally; it now travels in the options object. */
export async function approveSendBefore(
  engine: WalletEngine,
  id: string,
  verify: VerifyFactor,
): Promise<void> {
  // @ts-expect-error -- `verify` is no longer the third positional argument
  await engine.requests.approve(id, "send", verify);
}

/**
 * The approval screen shows the request's `danger` findings and its checks; the host passes back
 * exactly the codes it showed. A finding that appears later (a re-simulation at approval) throws
 * `AcknowledgementRequiredError` with the new set, and the request stays approvable.
 */
export async function approveSend(
  engine: WalletEngine,
  request: PendingRequest,
  verify: VerifyFactor,
  confirm: (shown: RequestAcknowledgement) => Promise<boolean>,
): Promise<string | undefined> {
  let shown = requiredAcknowledgement(request);
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one confirmation per changed finding set
    if (!(await confirm(shown))) {
      engine.requests.reject(request.id);
      return undefined;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- retried only after a new confirmation
      const tx = await engine.requests.approve(request.id, "send", { verify, acknowledged: shown });
      return tx.id;
    } catch (error) {
      if (error instanceof AcknowledgementRequiredError) {
        shown = error.required;
        continue;
      }
      const current = engine.requests.getState().requests[request.id];
      if (error instanceof SimulationChangedError && current !== undefined) {
        shown = requiredAcknowledgement(current);
        continue;
      }
      throw error;
    }
  }
}
