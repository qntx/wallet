import { describe, expect, it } from "vite-plus/test";

import { nextStage } from "../src/requests/stage.ts";
import type { RequestEvent, RequestStage } from "../src/requests/stage.ts";

const STAGES: ReadonlyArray<RequestStage> = [
  "awaiting-approval",
  "signing",
  "signed",
  "submitted",
  "rejected",
  "failed",
  "expired",
  "invalidated",
];

const EVENTS: ReadonlyArray<RequestEvent> = [
  "approve",
  "review",
  "commit",
  "complete",
  "reject",
  "fail",
  "expire",
  "invalidate",
];

const TERMINAL: ReadonlyArray<RequestStage> = [
  "submitted",
  "rejected",
  "failed",
  "expired",
  "invalidated",
];

/** The lifecycle, written out once more — any disagreement with `nextStage` fails here. */
const EXPECTED: Record<RequestStage, Partial<Record<RequestEvent, RequestStage>>> = {
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
  signed: {
    commit: "signed",
    complete: "submitted",
    fail: "failed",
  },
  submitted: {},
  rejected: {},
  failed: {},
  expired: {},
  invalidated: {},
};

describe("nextStage", () => {
  it("matches the transition table for every stage and event", () => {
    for (const stage of STAGES) {
      for (const event of EVENTS) {
        expect(nextStage(stage, event), `${stage} + ${event}`).toBe(EXPECTED[stage][event]);
      }
    }
  });

  it("no event leaves a terminal stage", () => {
    for (const stage of TERMINAL) {
      for (const event of EVENTS) {
        expect(nextStage(stage, event), `${stage} + ${event}`).toBeUndefined();
      }
    }
  });

  it("invalidate never applies to signed", () => {
    expect(nextStage("signed", "invalidate")).toBeUndefined();
  });
});
