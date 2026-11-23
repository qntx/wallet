/**
 * `evm-revoke`: encoding, read-before-build and the decode guard for removing standing approvals.
 * Every target is re-read on both endpoints (a disagreeing successful read refuses, a failed
 * corroborator degrades to `reads-unverified`), several targets run as one delegated self-call only
 * when the account already delegates to the wallet's delegator — a revocation never upgrades the
 * account — and the built call must decode back to exactly the requested revocations: no outflows,
 * no authorization, nothing else.
 */
import { encodeFunctionData, erc721Abi, getAddress, isAddress } from "viem";
import { readContract } from "viem/actions";

import { ChainError } from "@qntx/wallet-chains";
import type { ApprovalChange, SignRequest } from "@qntx/wallet-chains";
import {
  checksumEvmAddress,
  decodeEvm,
  encodeBatchExecute,
  networkChainId,
  PERMIT2_ADDRESS,
} from "@qntx/wallet-chains/evm";

import { ERC20_ABI } from "../chains/evm.ts";
import type { EvmChainAdapter } from "../chains/evm.ts";
import { EVM_BATCH_LIMIT } from "./route.ts";
import type { ChainRequestInput } from "./route.ts";

type ViemClient = Parameters<typeof readContract>[0];
type BuildIntent = Parameters<EvmChainAdapter["build"]>[3];
type RevokeInput = Extract<ChainRequestInput, { method: "evm-revoke" }>;
type Target = RevokeInput["targets"][number];
type DelegationState = Awaited<ReturnType<EvmChainAdapter["delegation"]>>;

const ZERO = "0x0000000000000000000000000000000000000000";

/** The helpers evm.ts shares across internal builders, bound for one request. */
export type RevokeDeps = {
  /**
   * `nftRead`'s rule: a disagreeing successful read refuses, a failed one pushes
   * `reads-unverified`.
   */
  readonly crossRead: <T>(read: (client: ViemClient) => Promise<T>) => Promise<T>;
  /** `delegationState` — only asked when a batch is needed. */
  readonly delegationState: () => Promise<DelegationState>;
};

/** Permit2 `allowance(owner, token, spender)` → (amount, expiration, nonce). */
const PERMIT2_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

/** Permit2 `lockdown((token, spender)[])`. */
const PERMIT2_LOCKDOWN_ABI = [
  {
    type: "function",
    name: "lockdown",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "approvals",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "spender", type: "address" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const targetKey = (t: Target): string =>
  t.kind === "nft"
    ? `nft:${t.contract.toLowerCase()}:${t.tokenId.toString(10)}`
    : t.kind === "operator"
      ? `operator:${t.contract.toLowerCase()}:${t.operator.toLowerCase()}`
      : `${t.kind}:${t.token.toLowerCase()}:${t.spender.toLowerCase()}`;

const targetLabel = (t: Target): string =>
  t.kind === "nft"
    ? `nft ${t.contract}#${t.tokenId.toString(10)}`
    : t.kind === "operator"
      ? `operator ${t.operator} on ${t.contract}`
      : `${t.kind} ${t.token} to ${t.spender}`;

const addressFields = (t: Target): ReadonlyArray<string> =>
  t.kind === "nft"
    ? [t.contract]
    : t.kind === "operator"
      ? [t.contract, t.operator]
      : [t.token, t.spender];

const encodeTarget = (t: Target): { to: string; value: bigint; data: string } => {
  if (t.kind === "erc20") {
    return {
      to: getAddress(t.token),
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [getAddress(t.spender), 0n],
      }),
    };
  }
  if (t.kind === "permit2") {
    return {
      to: PERMIT2_ADDRESS,
      value: 0n,
      data: encodeFunctionData({
        abi: PERMIT2_LOCKDOWN_ABI,
        functionName: "lockdown",
        args: [[{ token: getAddress(t.token), spender: getAddress(t.spender) }]],
      }),
    };
  }
  if (t.kind === "operator") {
    return {
      to: getAddress(t.contract),
      value: 0n,
      data: encodeFunctionData({
        abi: erc721Abi,
        functionName: "setApprovalForAll",
        args: [getAddress(t.operator), false],
      }),
    };
  }
  return {
    to: getAddress(t.contract),
    value: 0n,
    data: encodeFunctionData({
      abi: erc721Abi,
      functionName: "approve",
      args: [ZERO, t.tokenId],
    }),
  };
};

/* The chain answer a revocation needs: true means there is something live to remove. */
const stillLive = async (t: Target, from: string, deps: RevokeDeps): Promise<boolean> => {
  if (t.kind === "erc20") {
    const allowance = await deps.crossRead(async (client) =>
      readContract(client, {
        address: getAddress(t.token),
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [getAddress(from), getAddress(t.spender)],
      }),
    );
    return allowance > 0n;
  }
  if (t.kind === "permit2") {
    /* Lockdown zeroes the tuple — an expired-but-nonzero allowance still revokes. */
    const amount = await deps.crossRead(async (client) => {
      const [value] = await readContract(client, {
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [getAddress(from), getAddress(t.token), getAddress(t.spender)],
      });
      return value;
    });
    return amount > 0n;
  }
  if (t.kind === "operator") {
    return deps.crossRead(async (client) =>
      readContract(client, {
        address: getAddress(t.contract),
        abi: erc721Abi,
        functionName: "isApprovedForAll",
        args: [getAddress(from), getAddress(t.operator)],
      }),
    );
  }
  const approved = await deps.crossRead(async (client) =>
    readContract(client, {
      address: getAddress(t.contract),
      abi: erc721Abi,
      functionName: "getApproved",
      args: [t.tokenId],
    }),
  );
  const holder = await deps.crossRead(async (client) =>
    readContract(client, {
      address: getAddress(t.contract),
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [t.tokenId],
    }),
  );
  return (
    approved.toLowerCase() !== ZERO.toLowerCase() && holder.toLowerCase() === from.toLowerCase()
  );
};

const expectedApproval = (t: Target): ApprovalChange =>
  t.kind === "nft"
    ? {
        kind: "approval-cleared",
        asset: checksumEvmAddress(t.contract),
        value: t.tokenId.toString(10),
        verified: false,
      }
    : t.kind === "operator"
      ? {
          kind: "operator",
          asset: checksumEvmAddress(t.contract),
          spender: checksumEvmAddress(t.operator),
          approved: false,
          verified: false,
        }
      : {
          kind: "allowance",
          spender: checksumEvmAddress(t.spender),
          amount: { asset: checksumEvmAddress(t.token), amount: "0" },
          change: "set",
          unlimited: false,
          verified: false,
          ...(t.kind === "permit2" ? { via: "permit2" as const } : {}),
        };

const sameApproval = (a: ApprovalChange, b: ApprovalChange): boolean => {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "allowance" && b.kind === "allowance") {
    return (
      a.change === b.change &&
      a.amount.amount === b.amount.amount &&
      a.amount.asset.toLowerCase() === b.amount.asset.toLowerCase() &&
      a.spender.toLowerCase() === b.spender.toLowerCase() &&
      a.via === b.via
    );
  }
  if (a.kind === "operator" && b.kind === "operator") {
    return (
      a.approved === b.approved &&
      a.asset.toLowerCase() === b.asset.toLowerCase() &&
      a.spender.toLowerCase() === b.spender.toLowerCase()
    );
  }
  if (a.kind === "approval-cleared" && b.kind === "approval-cleared") {
    return a.asset.toLowerCase() === b.asset.toLowerCase() && a.value === b.value;
  }
  return false;
};

/* `decodeEvm` is the independent reader: the built intent must name exactly the requested
   revocations — no outflows, no authorization, nothing else. */
export const guardRevocation = (
  input: RevokeInput,
  from: string,
  intent: Extract<BuildIntent, { kind: "call" }>,
): void => {
  const request: SignRequest = {
    kind: "evm.transaction",
    network: input.network,
    account: input.account,
    tx: {
      type: "eip1559",
      chainId: networkChainId(input.network),
      to: intent.to,
      value: `0x${intent.value.toString(16)}`,
      nonce: 0,
      gas: "0x0",
      data: intent.data,
      accessList: [],
      maxFeePerGas: "0x0",
      maxPriorityFeePerGas: "0x0",
    },
  };
  const decoded = decodeEvm(request, from);
  const expected = input.targets.map(expectedApproval);
  const approvals = decoded.approvals ?? [];
  const calls = decoded.calls ?? [];
  const shapes =
    input.targets.length === 1
      ? decoded.summary === "approve"
      : decoded.summary === "batch" &&
        calls.length === input.targets.length &&
        calls.every((call) => call.summary === "approve");
  if (
    !shapes ||
    decoded.outflows.length > 0 ||
    decoded.delegation !== undefined ||
    approvals.length !== expected.length ||
    !expected.every((e, i) => {
      const actual = approvals[i];
      return actual !== undefined && sameApproval(actual, e);
    })
  ) {
    throw new ChainError(
      "invalid-request",
      `the built revocation does not decode to ${input.targets.map(targetLabel).join(", ")}`,
    );
  }
};

/**
 * Read-before-build → encode → guard. One target is a direct call; 2..EVM_BATCH_LIMIT need the
 * account already delegated to the wallet's delegator and run as a self-call batch with no
 * authorization — a revocation never upgrades the account.
 */
export const prepareRevokeIntent = async (
  input: RevokeInput,
  from: string,
  deps: RevokeDeps,
): Promise<BuildIntent> => {
  if (input.targets.length === 0 || input.targets.length > EVM_BATCH_LIMIT) {
    throw new ChainError(
      "invalid-request",
      `a revocation takes 1..${EVM_BATCH_LIMIT.toString(10)} targets`,
    );
  }
  const keys = new Set<string>();
  for (const target of input.targets) {
    if (addressFields(target).some((a) => !isAddress(a))) {
      throw new ChainError("invalid-request", `${targetLabel(target)} names a malformed address`);
    }
    const key = targetKey(target);
    if (keys.has(key)) {
      throw new ChainError("invalid-request", `duplicate revoke target: ${targetLabel(target)}`);
    }
    keys.add(key);
  }
  const live = await Promise.all(input.targets.map(async (t) => stillLive(t, from, deps)));
  const dead = input.targets.findIndex((_, i) => live[i] !== true);
  if (dead !== -1) {
    const target = input.targets[dead];
    if (target === undefined) {
      throw new ChainError("invalid-request", "a revocation takes at least one target");
    }
    throw new ChainError("invalid-request", `nothing to revoke: ${targetLabel(target)}`);
  }
  const calls = input.targets.map(encodeTarget);
  let intent: Extract<BuildIntent, { kind: "call" }>;
  if (calls.length === 1) {
    const [call] = calls;
    if (call === undefined) {
      throw new ChainError("invalid-request", "a revocation takes at least one target");
    }
    intent = { kind: "call", to: call.to, value: call.value, data: call.data };
  } else {
    const state = await deps.delegationState();
    if (state.kind !== "ours") {
      throw new ChainError(
        "invalid-request",
        "revoking several approvals in one transaction needs the account delegated to the " +
          "wallet's delegator — revoke them one by one",
      );
    }
    intent = {
      kind: "call",
      to: from,
      value: 0n,
      data: encodeBatchExecute(calls),
    };
  }
  guardRevocation(input, from, intent);
  return intent;
};
