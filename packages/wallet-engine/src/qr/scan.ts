/**
 * The bounded incremental QR scanner: `@qntx/ur`'s fountain decoder under the engine's own caps — a
 * UR payload is public, untrusted bytes, so every frame counts toward a frame budget and the
 * deadline runs from the first frame. Rejected and duplicate frames still consume the budget.
 */
import { UrDecoder, isUrType } from "@qntx/ur";
import type { DecoderLimits, UrType } from "@qntx/ur";
import type { QrPayload } from "@qntx/wallet/hardware";

import { QrError } from "./errors.ts";

export type QrScanLimits = {
  readonly maxMessageBytes: number;
  readonly maxFragments: number;
  readonly maxFragmentBytes: number;
  readonly maxUriBytes: number;
  readonly maxFrames: number;
  readonly timeoutMs: number;
};

export const QR_SCAN_LIMITS: QrScanLimits = {
  maxMessageBytes: 65_536,
  maxFragments: 512,
  maxFragmentBytes: 2048,
  maxUriBytes: 4096,
  maxFrames: 4096,
  timeoutMs: 120_000,
};

const ACCEPT: Readonly<Record<"request" | "export" | "response", ReadonlyArray<string>>> = {
  request: ["eth-sign-request", "sol-sign-request", "tron-sign-request", "crypto-psbt", "psbt"],
  export: ["crypto-hdkey", "crypto-account", "crypto-multi-accounts"],
  response: ["eth-signature", "sol-signature", "tron-signature", "crypto-psbt", "psbt"],
};

export type QrScanOutcome =
  | { readonly status: "progress"; readonly ratio: number }
  | { readonly status: "complete"; readonly payload: QrPayload };

export type QrScanner = {
  readonly receive: (text: string) => QrScanOutcome;
};

export const createQrScanner = (options: {
  readonly kind: "request" | "export" | "response";
  readonly now: () => number;
  readonly limits?: Partial<QrScanLimits>;
}): QrScanner => {
  const merged = { ...QR_SCAN_LIMITS, ...options.limits };
  const keys = [
    "maxMessageBytes",
    "maxFragments",
    "maxFragmentBytes",
    "maxUriBytes",
    "maxFrames",
    "timeoutMs",
  ] as const;
  for (const key of keys) {
    if (merged[key] > QR_SCAN_LIMITS[key]) {
      throw new QrError("unsupported", `${key} above the default bound`);
    }
  }
  const limits: Partial<DecoderLimits> = {
    maxMessageLength: merged.maxMessageBytes,
    maxFragmentCount: merged.maxFragments,
    maxFragmentLength: merged.maxFragmentBytes,
    maxUriLength: merged.maxUriBytes,
  };
  const accept: UrType[] = ACCEPT[options.kind].map((type) => {
    if (!isUrType(type)) {
      throw new QrError("unsupported", `bad UR type ${type}`);
    }
    return type;
  });
  const decoder = new UrDecoder({ accept, limits });
  let frames = 0;
  let deadline: number | undefined;
  let done: QrScanOutcome | undefined;
  return {
    receive: (text) => {
      if (done !== undefined) {
        return done;
      }
      frames += 1;
      if (frames > merged.maxFrames) {
        throw new QrError("scan-exhausted", "frame budget exceeded");
      }
      if (deadline === undefined) {
        deadline = options.now() + merged.timeoutMs;
      } else if (options.now() > deadline) {
        throw new QrError("scan-timeout", "scan deadline exceeded");
      }
      const outcome = decoder.receive(text);
      if (outcome.status === "fatal") {
        throw new QrError("scan-failed", outcome.error.message);
      }
      const { state } = decoder;
      /* A foreign-type frame is tolerated while nothing has been collected (the camera still
         hunts) but fails the scan once a real payload is in flight — a mid-scan type mix can only
         come from showing the wrong QR. */
      if (
        outcome.status === "rejected" &&
        outcome.error.code === "UnexpectedType" &&
        state.phase === "collecting"
      ) {
        throw new QrError("scan-failed", "UR type changed mid-scan");
      }
      if (state.phase === "complete") {
        done = {
          status: "complete",
          payload: { type: state.value.type, cbor: state.value.message },
        };
        return done;
      }
      return { status: "progress", ratio: decoder.progress.ratio };
    },
  };
};
