import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";

/** The candidates one response may carry. */
export const APPROVAL_CANDIDATES_MAX = 500;

const evmAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** A non-negative integer in decimal — no leading zeros, floats, signs or hex. */
const decimal = z.string().check(z.regex(DECIMAL));

export const approvalsRequest = z.strictObject({
  // The address is in the body, never the URL: address-bearing routes are POST.
  address: evmAddress,
});

/**
 * One approval-shaped event the discovery scan surfaced — keys only: which token, whose approval,
 * at which block. Never the current state (an amount, a live flag): the engine confirms every
 * candidate on chain itself.
 */
export const approvalCandidate = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("erc20"),
    /** The contract that emitted the Approval. */
    token: evmAddress,
    spender: evmAddress,
    block: decimal,
  }),
  z.strictObject({
    kind: z.literal("erc721"),
    token: evmAddress,
    spender: evmAddress,
    tokenId: decimal,
    block: decimal,
  }),
  z.strictObject({
    kind: z.literal("operator"),
    token: evmAddress,
    operator: evmAddress,
    block: decimal,
  }),
  z.strictObject({
    kind: z.literal("permit2"),
    /** The token the Permit2 allowance names (an indexed topic, not the emitting contract). */
    token: evmAddress,
    spender: evmAddress,
    block: decimal,
  }),
]);

export const approvalsResponse = z.strictObject({
  /** The head the logs were read up to. */
  toBlock: decimal,
  candidates: z.array(approvalCandidate).check(z.maxLength(APPROVAL_CANDIDATES_MAX)),
  /** True when the scan found more candidates than one response carries. */
  truncated: z.boolean(),
});

export const approvals = endpoint(
  "POST",
  "/v1/approvals/:caip2",
  approvalsRequest,
  approvalsResponse,
);

/** The approvals path for one network. */
export const approvalsPath = (caip2: string): string => approvals.path.replace(":caip2", caip2);

export type ApprovalsRequest = z.infer<typeof approvalsRequest>;
export type ApprovalsResponse = z.infer<typeof approvalsResponse>;
export type ApprovalCandidate = z.infer<typeof approvalCandidate>;
