/**
 * Type-level contract: the wire shapes declared in src/protocol must stay structurally compatible
 * with the libraries the kernel and proxy speak — @qntx/nostr's Event/UnsignedEvent/Rumor and
 * @qntx/spark/signer's job/statement/request types — so values cross the channel without
 * conversion. The protocol files themselves never import either package.
 */
import { describe, expect, it } from "vite-plus/test";

import type { Event, UnsignedEvent } from "@qntx/nostr";
import type { Rumor as Nip59Rumor } from "@qntx/nostr/nips/nip59";
import type {
  FrostAggregateJob as SparkFrostAggregateJob,
  FrostSignJob as SparkFrostSignJob,
  HtlcTimeoutSignRequest as SparkHtlcTimeoutSignRequest,
  IdentityStatement as SparkIdentityStatement,
  OperatorCommitment as SparkOperatorCommitment,
  PrepareClaimRequest as SparkPrepareClaimRequest,
  PreparedClaim as SparkPreparedClaim,
  PreparedLightningReceive as SparkPreparedLightningReceive,
  PreparedTransfer as SparkPreparedTransfer,
  PreparedTransferLeaf as SparkPreparedTransferLeaf,
  PrepareTransferRequest as SparkPrepareTransferRequest,
  SigningCommitment as SparkSigningCommitment,
  SigningTarget as SparkSigningTarget,
  SparkKey,
  SparkLeafKey,
  SparkNetwork as SparkNet,
  StaticDepositClaimRequest as SparkStaticDepositClaimRequest,
} from "@qntx/spark/signer";

import type {
  FrostAggregateJob,
  FrostSignJob,
  HtlcTimeoutSignRequest,
  IdentityStatement,
  OperatorCommitment,
  PrepareClaimRequest,
  PreparedClaim,
  PreparedLightningReceive,
  PreparedTransfer,
  PreparedTransferLeaf,
  PrepareTransferRequest,
  Rumor,
  SignedEvent,
  SigningCommitment,
  SigningTarget,
  SparkAccountRef,
  SparkKey as WireSparkKey,
  SparkLeafKey as WireSparkLeafKey,
  SparkNetwork,
  StaticDepositClaimRequest,
  StaticDepositClaimStatement,
  UnsignedEventInput,
} from "../src/protocol/index.ts";

type Extends<A, B> = A extends B ? true : false;
type Assert<T extends true> = T;
/**
 * Exact structural equality — catches every field-level drift between the protocol's declared
 * wire shapes and the library types (a missing optional like `adaptorPublicKey` slips through
 * mutual assignability but not this).
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Same<A, B> = Assert<Equal<A, B>>;

// Mutually assignable: the protocol shapes are the nostr shapes, field for field.
export type SignedIsEvent = Assert<Extends<SignedEvent, Event>>;
export type EventIsSigned = Assert<Extends<Event, SignedEvent>>;
export type RumorIsNip59 = Assert<Extends<Rumor, Nip59Rumor>>;
export type Nip59IsRumor = Assert<Extends<Nip59Rumor, Rumor>>;
// One direction only: the kernel input may omit pubkey (it fills the signing key's own), so
// UnsignedEventInput is wider than @qntx/nostr's UnsignedEvent.
export type UnsignedIsInput = Assert<Extends<UnsignedEvent, UnsignedEventInput>>;

// The spark wire shapes are the @qntx/spark/signer shapes — exactly.
export type NetworkIsSpark = Same<SparkNetwork, SparkNet>;
export type LeafKeyIsSpark = Same<WireSparkLeafKey, SparkLeafKey>;
export type KeyIsSpark = Same<WireSparkKey, SparkKey>;
export type CommitmentIsSpark = Same<SigningCommitment, SparkSigningCommitment>;
export type OperatorCommitmentIsSpark = Same<OperatorCommitment, SparkOperatorCommitment>;
export type TargetIsSpark = Same<SigningTarget, SparkSigningTarget>;
export type SignJobIsSpark = Same<FrostSignJob, SparkFrostSignJob>;
export type AggregateJobIsSpark = Same<FrostAggregateJob, SparkFrostAggregateJob>;
export type StatementIsSpark = Same<IdentityStatement, SparkIdentityStatement>;
export type TransferRequestIsSpark = Same<PrepareTransferRequest, SparkPrepareTransferRequest>;
export type TransferLeafIsSpark = Same<PreparedTransferLeaf, SparkPreparedTransferLeaf>;
export type TransferIsSpark = Same<PreparedTransfer, SparkPreparedTransfer>;
export type ClaimRequestIsSpark = Same<PrepareClaimRequest, SparkPrepareClaimRequest>;
export type ClaimIsSpark = Same<PreparedClaim, SparkPreparedClaim>;
export type LightningReceiveIsSpark = Same<
  PreparedLightningReceive,
  SparkPreparedLightningReceive
>;
export type HtlcIsSpark = Same<HtlcTimeoutSignRequest, SparkHtlcTimeoutSignRequest>;
export type DepositClaimIsSpark = Same<StaticDepositClaimRequest, SparkStaticDepositClaimRequest>;
// The statement inside a claim request is the same variant in both worlds.
export type ClaimStatementIsSpark = Same<
  StaticDepositClaimStatement,
  Extract<SparkIdentityStatement, { readonly kind: "static-deposit-claim" }>
>;
// The account ref is a protocol-side shape: a plain object the host attaches to every call.
export type AccountRefShape = Assert<
  Extends<SparkAccountRef, { walletId: string; groupIndex: number; network: SparkNetwork }>
>;

describe("protocol event shapes", () => {
  it("match @qntx/nostr and @qntx/spark structurally (compile-time assertions above)", () => {
    expect(true).toBe(true);
  });
});
