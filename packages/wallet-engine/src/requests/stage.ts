/** `signed` is the point of no return: the signature exists and is being returned or broadcast, so invalidation no longer applies. */
export type RequestStage =
  | "awaiting-approval"
  | "signing"
  | "signed"
  | "submitted"
  | "rejected"
  | "failed"
  | "expired"
  | "invalidated";

export type RequestEvent =
  | "approve"
  | "review"
  | "commit"
  | "complete"
  | "reject"
  | "fail"
  | "expire"
  | "invalidate";

const TABLE: {
  readonly [S in RequestStage]: Partial<Record<RequestEvent, RequestStage>>;
} = {
  "awaiting-approval": {
    approve: "signing",
    reject: "rejected",
    fail: "failed",
    expire: "expired",
    invalidate: "invalidated",
  },
  signing: {
    review: "awaiting-approval",
    commit: "signed",
    reject: "rejected",
    fail: "failed",
    invalidate: "invalidated",
  },
  signed: { commit: "signed", complete: "submitted", fail: "failed" },
  submitted: {},
  rejected: {},
  failed: {},
  expired: {},
  invalidated: {},
};

/** The next stage, or `undefined` when `event` cannot happen in `stage` (the request is left as it is). */
export function nextStage(stage: RequestStage, event: RequestEvent): RequestStage | undefined {
  return TABLE[stage][event];
}
