import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { PaymentError } from "../src/payments/errors.ts";
import { parsePayment } from "../src/payments/parse.ts";

/** Run count for property tests; the weekly job raises it via FUZZ_RUNS. */
const numRuns = Number(process.env["FUZZ_RUNS"] ?? "200");

const OPTIONS = { network: "regtest" as const, now: 1_800_000_000_000 };

/** Every failure is a structured result or a PaymentError — foreign exceptions fail. */
const onlyPaymentError = (input: string): boolean => {
  try {
    parsePayment(input, OPTIONS);
    return true;
  } catch (error) {
    return error instanceof PaymentError;
  }
};

describe("payment request parser fuzz", () => {
  it("parsePayment on arbitrary strings throws nothing but PaymentError", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(onlyPaymentError(input)).toBe(true);
      }),
      { numRuns },
    );
  });
});
