// oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect -- the FIAT24_FORK_URL gate and the response narrowing are inherently conditional
/**
 * Reads-only fork check: an anvil fork of Arbitrum One at the block the SDK pins
 * (FIAT24_FORK_URL=http://127.0.0.1:8545, `anvil --fork-url <arb1> --fork-block-number 526365924`)
 * serves the corroborated client; `account()` resolves the owner of #469709 live. Skipped when the
 * URL is unset — the suite prints the reason like the SDK's own fork harness.
 */
import { createPublicClient, http } from "viem";
import type { Address } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { loadAccount } from "@qntx/fiat24/flows";

const URL_ = process.env["FIAT24_FORK_URL"];
const OWNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as Address;

describe("fiat24 fork", () => {
  it("reads the live account of #469709's owner at the pinned block", async () => {
    if (URL_ === undefined) {
      process.stdout.write("fiat24 fork suite skipped: FIAT24_FORK_URL is not set\n");
      return;
    }
    const client = createPublicClient({ transport: http(URL_) });
    const view = await loadAccount({ client }, { owner: OWNER });
    expect(view.step).not.toBe("no-account");
    if (view.step !== "no-account") {
      expect(view.account.tokenId).toBe(469709n);
      expect(view.account.ownsToken).toBe(true);
    }
  }, 60_000);
});
