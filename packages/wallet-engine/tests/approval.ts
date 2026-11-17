import type { ApproveOptions, PendingRequest } from "../src/index.ts";
import { requiredAcknowledgement } from "../src/index.ts";

/**
 * The options of an approval that confirms everything the request currently flags — what a host
 * does after showing each finding. Tests of the acknowledgement rule itself spell the options out.
 */
export const approval = (
  request: Pick<PendingRequest, "risk" | "checks"> | undefined,
  verify?: ApproveOptions["verify"],
): ApproveOptions => ({
  ...(verify === undefined ? {} : { verify }),
  ...(request === undefined ? {} : { acknowledged: requiredAcknowledgement(request) }),
});
