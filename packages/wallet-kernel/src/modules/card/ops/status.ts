import type { CardOpResult } from "@qntx/wallet/protocol";

// oxlint-disable typescript/require-await -- op bodies are async generators whose own code
// only `yield*`s; the awaits live in the `run` callbacks.
import { KernelError } from "../../../errors.ts";
import type { CardOp } from "../tap.ts";
import { tapPrompt } from "../text.ts";
import type { OpEnv, RunOutcome } from "./shared.ts";
import { tapRetry } from "./shared.ts";

/** `status` — one tap, life any; no VERIFY, no record write. */
export async function* statusOp(env: OpEnv): CardOp {
  let life: "blank" | "loaded" | undefined;
  let tries: number | undefined;
  let memberOf: string | undefined;
  yield* tapRetry((retry) => ({
    reason: retry ? "retry" : "any",
    prompt: tapPrompt(env.locale, "status", retry ? "retry" : "any", undefined),
    expect: { life: "any" },
    run: async (tap) => {
      ({ life, tries } = tap.status);
      ({ memberOf } = tap);
      return { status: "done" } satisfies RunOutcome;
    },
  }));
  if (life === undefined || tries === undefined) {
    throw new KernelError("integrity", "the status tap did not report");
  }
  return {
    kind: "status",
    life,
    tries,
    ...(memberOf === undefined ? {} : { walletId: memberOf }),
  } satisfies CardOpResult;
}
