import type { IRequestTransport } from "@nktkas/hyperliquid";
/**
 * Hyperliquid user-signed actions: EIP-712 documents the account owner signs itself (no agent key)
 * under the `HyperliquidSignTransaction` domain. The typed-data shape is exact — the kernel's
 * recognizer (`wallet-chains/evm/hyperliquid.ts`) describes each document only when the type field
 * list is verbatim, so the approval UI shows the real action instead of a blind payload.
 *
 * The EIP-712 field lists come from the SDK's own `…Types` constants — if the SDK's list changes,
 * the import resolves but the recognizer's `sameFields` check fails, surfacing as a blind payload
 * instead of a wrong signature.
 */
import {
  ApproveAgentTypes,
  ApproveBuilderFeeTypes,
  SpotSendTypes,
  UsdClassTransferTypes,
  UsdSendTypes,
  Withdraw3Types,
} from "@nktkas/hyperliquid/api/exchange";

import type { HyperliquidNetwork } from "@qntx/wallet/protocol";

import type { RequestController } from "../../requests/controller.ts";
import { RequestEndedError } from "../../requests/controller.ts";
import type { SignatureResult } from "../../transactions/route.ts";
import type { HyperliquidAccount } from "./account.ts";
import type { HyperliquidGroup } from "./agents.ts";
import type { HyperliquidClock } from "./clock.ts";
import { HyperliquidError } from "./errors.ts";
import type { HyperliquidActionOutcome } from "./exchange.ts";
import type { HyperliquidMarkets } from "./markets.ts";

/** The chain ids the user-signed domain commits to (design §2 — the signature chain). */
const CHAIN = {
  Mainnet: { id: 42161, caip: "eip155:42161", signatureChainId: "0xa4b1" },
  Testnet: { id: 421614, caip: "eip155:421614", signatureChainId: "0x66eee" },
} as const satisfies Record<
  HyperliquidNetwork,
  { id: number; caip: string; signatureChainId: `0x${string}` }
>;

const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type TypedFields = ReadonlyArray<{ readonly name: string; readonly type: string }>;

/** A user-signed action waiting on approval — the host presents `requestId`'s prompt. */
export type HyperliquidPendingAction = {
  /** The approval request the host shows; the prompt is the kernel-described typed data. */
  readonly requestId: string;
  /**
   * Resolves once the approval resolved and the signed action was posted: `ok`, or `unknown` when
   * the POST's outcome is unknowable (the action may have committed — refresh the account). Rejects
   * with `approval-rejected` when the request is refused/expired and `rejected` when Hyperliquid
   * answers `status: "err"`.
   */
  readonly outcome: Promise<HyperliquidActionOutcome>;
};

export type HyperliquidUserSigned = {
  /**
   * Register an agent key under `agentName` — the kernel binds validity by signing `"<name>
   * valid_until <ms>"` in the `agentName` field (docs §Approve an API wallet). `agentName` here is
   * that full signed string.
   */
  readonly approveAgent: (
    group: HyperliquidGroup,
    params: { readonly agentAddress: string; readonly agentName: string },
  ) => Promise<HyperliquidPendingAction>;
  /** Approve a builder's fee rate — `maxFeeRate` is the canonical percent string ("0.01%"). */
  readonly approveBuilderFee: (
    group: HyperliquidGroup,
    params: { readonly builder: string; readonly maxFeeRate: string },
  ) => Promise<HyperliquidPendingAction>;
  /** Move quote balance between the perp and spot accounts of the same owner. */
  readonly usdClassTransfer: (
    group: HyperliquidGroup,
    params: { readonly amount: string; readonly toPerp: boolean },
  ) => Promise<HyperliquidPendingAction>;
  /** Send perp-account USDC to another address (`destination` lowercased). */
  readonly usdSend: (
    group: HyperliquidGroup,
    params: { readonly destination: string; readonly amount: string },
  ) => Promise<HyperliquidPendingAction>;
  /** Send a spot balance — `token` is the `"NAME:0x<id>"` pair id (docs §Send Asset). */
  readonly spotSend: (
    group: HyperliquidGroup,
    params: { readonly destination: string; readonly token: string; readonly amount: string },
  ) => Promise<HyperliquidPendingAction>;
  /** Withdraw USDC to the owner's Arbitrum address — the 1 USDC fee applies at the bridge. */
  readonly withdraw: (
    group: HyperliquidGroup,
    params: { readonly destination: string; readonly amount: string },
  ) => Promise<HyperliquidPendingAction>;
};

export type HyperliquidUserSignedOptions = {
  readonly requests: Pick<RequestController, "prepare" | "outcome" | "reject">;
  readonly transport: IRequestTransport;
  readonly clock: HyperliquidClock;
  readonly markets: HyperliquidMarkets;
  readonly account: HyperliquidAccount;
  /** The owner's lowercase address — needed for the per-signer nonce counter. */
  readonly ownerOf: (group: HyperliquidGroup) => Promise<string>;
  readonly network: HyperliquidNetwork;
  readonly now: () => number;
};

const accountRef = (group: HyperliquidGroup) => ({
  kind: "hd" as const,
  walletId: group.walletId,
  groupIndex: group.groupIndex,
  template: "evm.bip44" as const,
});

/** The kernel's 65-byte r‖s‖v → Hyperliquid's `{r, s, v}` (v already 27/28). */
const signatureOf = (result: SignatureResult): { r: string; s: string; v: number } => {
  const bytes = result.signature;
  if (bytes.length !== 65) {
    throw new HyperliquidError("unavailable", "the kernel returned a malformed signature");
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v: bytes[64] ?? 27 };
};

/** The `/exchange` envelope's `status`/`response` fields without asserting the body. */
const fieldOf = (body: unknown, field: "status" | "response"): unknown => {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  return field === "status"
    ? "status" in body
      ? body.status
      : undefined
    : "response" in body
      ? body.response
      : undefined;
};

export function createHyperliquidUserSigned(
  options: HyperliquidUserSignedOptions,
): HyperliquidUserSigned {
  const chain = CHAIN[options.network];

  const assertClock = async (): Promise<void> => {
    if (options.clock.skew() === undefined) {
      await options.markets.mids();
    }
    options.clock.assertSkew();
  };

  /**
   * Build the document, open the request, and return `{requestId, outcome}` — the outcome waits for
   * the approval, posts the action, and maps the answer. A lost POST is `unknown`: user-signed
   * actions have no cloid to reconcile by and are never re-posted.
   */
  const send = async (
    group: HyperliquidGroup,
    doc: {
      readonly type: string;
      readonly types: TypedFields;
      readonly primaryType: string;
      readonly fields: Record<string, unknown>;
      readonly nonceField: "nonce" | "time";
    },
  ): Promise<HyperliquidPendingAction> => {
    await assertClock();
    const owner = await options.ownerOf(group);
    const nonce = options.clock.nextNonce(owner);
    const message = {
      hyperliquidChain: options.network,
      ...doc.fields,
      [doc.nonceField]: nonce,
    };
    const typedData = JSON.stringify({
      types: { EIP712Domain: EIP712_DOMAIN, [doc.primaryType]: doc.types },
      primaryType: doc.primaryType,
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: chain.id,
        verifyingContract: ZERO_ADDRESS,
      },
      message,
    });
    const pending = await options.requests.prepare({
      method: "evm-sign",
      account: accountRef(group),
      network: chain.caip,
      request: {
        kind: "evm.typed-data",
        network: chain.caip,
        account: accountRef(group),
        typedData,
      },
    });
    const action = {
      type: doc.type,
      signatureChainId: chain.signatureChainId,
      hyperliquidChain: options.network,
      ...doc.fields,
      [doc.nonceField]: nonce,
    };
    const outcome = (async (): Promise<HyperliquidActionOutcome> => {
      try {
        const result = await options.requests.outcome(pending.id);
        if (
          !("kind" in result) ||
          (result.kind !== "evm.typed-data" && result.kind !== "evm.personal-message")
        ) {
          throw new HyperliquidError("unavailable", "the request resolved without a signature");
        }
        const signature = signatureOf(result);
        // The envelope nonce equals the action's nonce/time — the docs require they match.
        const body = await options.transport.request("exchange", { action, nonce, signature });
        if (fieldOf(body, "status") === "ok") {
          return { kind: "ok" };
        }
        const response = fieldOf(body, "response");
        throw new HyperliquidError(
          "rejected",
          typeof response === "string" ? response : "Hyperliquid rejected the action",
        );
      } catch (error) {
        if (error instanceof RequestEndedError) {
          throw new HyperliquidError("approval-rejected", `the request was ${error.stage}`, error);
        }
        if (error instanceof HyperliquidError) {
          if (error.category === "network" || error.category === "timeout") {
            return { kind: "unknown" };
          }
          throw error;
        }
        /* A transport throw is classified inside transport.request; a non-HyperliquidError here is
           a post throw too — the action may have committed. */
        return { kind: "unknown" };
      }
    })();
    return { requestId: pending.id, outcome };
  };

  return {
    approveAgent: async (group, { agentAddress, agentName }) =>
      send(group, {
        type: "approveAgent",
        types: ApproveAgentTypes["HyperliquidTransaction:ApproveAgent"],
        primaryType: "HyperliquidTransaction:ApproveAgent",
        fields: { agentAddress: agentAddress.toLowerCase(), agentName },
        nonceField: "nonce",
      }),
    approveBuilderFee: async (group, { builder, maxFeeRate }) =>
      send(group, {
        type: "approveBuilderFee",
        types: ApproveBuilderFeeTypes["HyperliquidTransaction:ApproveBuilderFee"],
        primaryType: "HyperliquidTransaction:ApproveBuilderFee",
        fields: { maxFeeRate, builder: builder.toLowerCase() },
        nonceField: "nonce",
      }),
    usdClassTransfer: async (group, { amount, toPerp }) =>
      send(group, {
        type: "usdClassTransfer",
        types: UsdClassTransferTypes["HyperliquidTransaction:UsdClassTransfer"],
        primaryType: "HyperliquidTransaction:UsdClassTransfer",
        fields: { amount, toPerp },
        nonceField: "nonce",
      }),
    usdSend: async (group, { destination, amount }) =>
      send(group, {
        type: "usdSend",
        types: UsdSendTypes["HyperliquidTransaction:UsdSend"],
        primaryType: "HyperliquidTransaction:UsdSend",
        fields: { destination: destination.toLowerCase(), amount },
        nonceField: "time",
      }),
    spotSend: async (group, { destination, token, amount }) =>
      send(group, {
        type: "spotSend",
        types: SpotSendTypes["HyperliquidTransaction:SpotSend"],
        primaryType: "HyperliquidTransaction:SpotSend",
        fields: { destination: destination.toLowerCase(), token, amount },
        nonceField: "time",
      }),
    withdraw: async (group, { destination, amount }) =>
      send(group, {
        type: "withdraw3",
        types: Withdraw3Types["HyperliquidTransaction:Withdraw"],
        primaryType: "HyperliquidTransaction:Withdraw",
        fields: { destination: destination.toLowerCase(), amount },
        nonceField: "time",
      }),
  };
}
